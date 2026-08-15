import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKSPACE_MOUNT, normalizePolicy, resolveSecretValues, SandboxPolicyError } from "./policy.mjs";

const base = { provider: "gondolin", allowedHosts: ["api.github.com"] };

describe("normalizePolicy", () => {
  test("an unknown provider is refused, not passed through", () => {
    expect(() => normalizePolicy({ provider: "docker" })).toThrow(/unknown sandbox provider "docker"/);
    expect(() => normalizePolicy({})).toThrow(/unknown sandbox provider null/);
    expect(() => normalizePolicy(null)).toThrow(SandboxPolicyError);
  });

  test("an omitted allowlist denies all egress rather than allowing it", () => {
    // The SDK's own default is allow-all on omission; this inversion is the
    // single most security-relevant line in the module.
    expect(normalizePolicy({ provider: "gondolin" }).allowedHosts).toEqual([]);
  });

  test("host patterns must be bare hosts, not URLs", () => {
    expect(() => normalizePolicy({ ...base, allowedHosts: ["https://api.github.com/x"] })).toThrow(/bare host pattern/);
    expect(() => normalizePolicy({ ...base, allowedHosts: [""] })).toThrow(/non-empty host pattern/);
    expect(() => normalizePolicy({ ...base, allowedHosts: "api.github.com" })).toThrow(/must be an array/);
  });

  test("a secret scoped outside the allowlist is a config error", () => {
    expect(() =>
      normalizePolicy({ ...base, secrets: { LINEAR_API_KEY: { hosts: ["api.linear.app"] } } }),
    ).toThrow(/scoped to api.linear.app, which sandbox.allowedHosts does not permit/);
  });

  test("a literal secret value in a definition is refused", () => {
    expect(() =>
      normalizePolicy({ ...base, secrets: { GITHUB_TOKEN: { hosts: ["api.github.com"], value: "ghp_real" } } }),
    ).toThrow(/must not carry a literal value/);
  });

  test("secrets resolve to an env var name, defaulting to the guest var name", () => {
    const policy = normalizePolicy({
      ...base,
      secrets: {
        GITHUB_TOKEN: { hosts: ["api.github.com"] },
        GH_ALT: { hosts: ["api.github.com"], env: "GITHUB_TOKEN_ALT" },
      },
    });
    expect(policy.secrets).toEqual([
      { name: "GITHUB_TOKEN", envVar: "GITHUB_TOKEN", hosts: ["api.github.com"] },
      { name: "GH_ALT", envVar: "GITHUB_TOKEN_ALT", hosts: ["api.github.com"] },
    ]);
  });

  test("secrets must declare at least one host", () => {
    expect(() => normalizePolicy({ ...base, secrets: { X: { hosts: [] } } })).toThrow(/non-empty array/);
    expect(() => normalizePolicy({ ...base, secrets: { X: {} } })).toThrow(/non-empty array/);
  });

  test("the workspace dir becomes a read-write mount at the workspace mount point", () => {
    const policy = normalizePolicy(base, { workspaceDir: "/host/work/WM-185" });
    expect(policy.workspaceMount).toBe(DEFAULT_WORKSPACE_MOUNT);
    expect(policy.mounts).toEqual([{ guestPath: "/workspace", hostPath: "/host/work/WM-185", readonly: false }]);
  });

  test("extra mounts accept a bare path or a readonly spec", () => {
    const policy = normalizePolicy({ ...base, mounts: { "/ref": "/host/ref", "/ro": { path: "/host/ro", readonly: true } } });
    expect(policy.mounts).toEqual([
      { guestPath: "/ref", hostPath: "/host/ref", readonly: false },
      { guestPath: "/ro", hostPath: "/host/ro", readonly: true },
    ]);
  });

  test("mount paths that could re-expose the guest root or collide are refused", () => {
    expect(() => normalizePolicy({ ...base, mounts: { "/workspace/../etc": "/host/x" } })).toThrow(/".." segments/);
    expect(() => normalizePolicy({ ...base, mounts: { relative: "/host/x" } })).toThrow(/absolute guest path/);
    expect(() => normalizePolicy({ ...base, mounts: { "/ref": "host/relative" } })).toThrow(/absolute host path/);
    expect(() => normalizePolicy({ ...base, mounts: { "/workspace": "/host/other" } }, { workspaceDir: "/host/work" })).toThrow(
      /collides with an existing mount/,
    );
  });

  test("resource limits are validated as qemu accepts them", () => {
    expect(normalizePolicy({ ...base, memory: "2G", cpus: 4 })).toMatchObject({ memory: "2G", cpus: 4 });
    expect(() => normalizePolicy({ ...base, memory: "lots" })).toThrow(/qemu size string/);
    expect(() => normalizePolicy({ ...base, cpus: 0 })).toThrow(/positive integer/);
    expect(() => normalizePolicy({ ...base, cpus: 1.5 })).toThrow(/positive integer/);
  });
});

describe("resolveSecretValues", () => {
  test("reads declared host env vars at execution time", () => {
    const policy = normalizePolicy({ ...base, secrets: { GITHUB_TOKEN: { hosts: ["api.github.com"], env: "GH_SRC" } } });
    expect(resolveSecretValues(policy, { GH_SRC: "ghp_real" })).toEqual({
      GITHUB_TOKEN: { hosts: ["api.github.com"], value: "ghp_real" },
    });
  });

  test("a missing or empty env var fails closed instead of authenticating as nobody", () => {
    const policy = normalizePolicy({ ...base, secrets: { GITHUB_TOKEN: { hosts: ["api.github.com"] } } });
    expect(() => resolveSecretValues(policy, {})).toThrow(/reads host env var GITHUB_TOKEN, which is unset or empty/);
    expect(() => resolveSecretValues(policy, { GITHUB_TOKEN: "" })).toThrow(/unset or empty/);
  });
});

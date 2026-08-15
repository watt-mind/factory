import { describe, expect, test } from "bun:test";
import {
  MIN_NODE_MAJOR,
  nodeVersionSatisfies,
  parseEvents,
  parseNodeVersion,
  preflight,
  qemuBinaryFor,
  runInSandbox,
  SandboxUnavailableError,
} from "./gondolin.mjs";

/** Preflight dependencies, all satisfied — override one field per test to break it. */
const healthy = {
  env: {},
  which: (name) => `/usr/bin/${name}`,
  runNode: () => "v24.18.0\n",
  sdkExists: () => true,
};

describe("preflight", () => {
  test("reports available when qemu, node, and the sdk are all present", () => {
    const report = preflight(healthy);
    expect(report).toMatchObject({ available: true, reason: null, sdk: true, nodeVersion: "24.18" });
  });

  test("missing qemu is a named reason, not a crash", () => {
    const report = preflight({ ...healthy, which: (n) => (n.startsWith("qemu") ? null : `/usr/bin/${n}`) });
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/is not on PATH — install QEMU/);
  });

  test("a Node older than the SDK's floor is refused rather than left to fail at import", () => {
    const report = preflight({ ...healthy, runNode: () => "v22.14.0" });
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/need >= 23\.6/);
  });

  test("FACTORY_SANDBOX_NODE overrides PATH, since the worker runs under Bun", () => {
    const report = preflight({ ...healthy, env: { FACTORY_SANDBOX_NODE: "/opt/node23/bin/node" } });
    expect(report.node).toBe("/opt/node23/bin/node");
  });

  test("a missing SDK is reported as installable, not as a hypervisor problem", () => {
    const report = preflight({ ...healthy, sdkExists: () => false });
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/bun install/);
  });

  test("the qemu binary follows the host architecture", () => {
    expect(qemuBinaryFor("arm64")).toBe("qemu-system-aarch64");
    expect(qemuBinaryFor("x64")).toBe("qemu-system-x86_64");
  });
});

describe("node version parsing", () => {
  test("accepts the shapes `node --version` actually prints", () => {
    expect(parseNodeVersion("v24.18.0\n")).toEqual({ major: 24, minor: 18 });
    expect(parseNodeVersion("23.6.1")).toEqual({ major: 23, minor: 6 });
    expect(parseNodeVersion("garbage")).toBeNull();
    expect(parseNodeVersion(null)).toBeNull();
  });

  test("the floor is inclusive at the SDK's declared minimum", () => {
    expect(nodeVersionSatisfies({ major: MIN_NODE_MAJOR, minor: 6 })).toBe(true);
    expect(nodeVersionSatisfies({ major: MIN_NODE_MAJOR, minor: 5 })).toBe(false);
    expect(nodeVersionSatisfies({ major: MIN_NODE_MAJOR + 1, minor: 0 })).toBe(true);
    expect(nodeVersionSatisfies(null)).toBe(false);
  });
});

describe("NDJSON protocol", () => {
  test("parses whole lines and keeps the partial remainder for the next chunk", () => {
    const first = parseEvents('{"type":"ready","bootMs":62}\n{"type":"stdout","data":"hel');
    expect(first.events).toEqual([{ type: "ready", bootMs: 62 }]);
    expect(first.rest).toBe('{"type":"stdout","data":"hel');

    const second = parseEvents(`${first.rest}lo"}\n{"type":"exit","exitCode":0}\n`);
    expect(second.events).toEqual([
      { type: "stdout", data: "hello" },
      { type: "exit", exitCode: 0 },
    ]);
    expect(second.rest).toBe("");
  });

  test("a malformed line is skipped rather than killing the run", () => {
    const { events } = parseEvents('not json\n{"type":"exit","exitCode":3}\n');
    expect(events).toEqual([{ type: "exit", exitCode: 3 }]);
  });
});

describe("runInSandbox refusals", () => {
  // FACTORY_SANDBOX_NODE points at a path that cannot exist, so preflight
  // fails on any machine, with or without QEMU installed.
  const unavailableHost = { FACTORY_SANDBOX_NODE: "/nonexistent/node", PATH: "" };

  test("an unavailable host refuses with a typed error before spawning anything", async () => {
    await expect(
      runInSandbox({
        policy: { provider: "gondolin" },
        command: ["/bin/true"],
        timeoutMs: 1000,
        hostEnv: unavailableHost,
      }),
    ).rejects.toThrow(SandboxUnavailableError);
  });

  test("an invalid policy is reported as invalid even on a host that could not run it anyway", async () => {
    // Regression: policy validation used to run after preflight, so a typo'd
    // provider surfaced as "qemu is not on PATH" on any machine without a
    // hypervisor — a diagnostic that sends the reader after the wrong bug.
    // This passed locally (QEMU present) and failed in CI (QEMU absent), which
    // is exactly the asymmetry this test exists to prevent.
    await expect(
      runInSandbox({
        policy: { provider: "firecracker" },
        command: ["/bin/true"],
        timeoutMs: 1000,
        hostEnv: unavailableHost,
      }),
    ).rejects.toThrow(/unknown sandbox provider/);
  });
});

import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-sandboxed-test-mjs";
/**
 * The sandbox decision seam (WM-313) — and the conformance sweep that makes
 * "no adapter ignores def.sandbox" a property of the suite rather than a
 * promise in a comment.
 *
 * Nothing here needs a hypervisor: the VM boundary is stubbed at `runSandbox`
 * exactly where lib/sandbox/gondolin.test.mjs stubs preflight. Real-VM
 * behaviour is proven in pi.test.mjs behind `preflight()`.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { preflight, SandboxExecutionError } from "../sandbox/gondolin.mjs";
import { builtinAdapters } from "./index.mjs";
import {
  GUEST_BINARIES,
  GUEST_HOME,
  GUEST_PATH,
  GUEST_XDG_ROOT,
  FILESYSTEM_CONFINEMENT_REASON,
  filesystemConfinementRefusal,
  guestBinary,
  guestEnvironment,
  refuseSandbox,
  runSandboxed,
  SANDBOX_CONSOLE_FILE,
  normalizeWorkspaceOnlyFallback,
  sandboxUnavailableDetail,
  sandboxRequested,
  SandboxUnsupportedError,
  workspaceOnlyHostFallback,
  withStdinFile,
} from "./sandboxed.mjs";

const ws = () => tmpDir("evrt-sandboxed-");
const sandboxDef = (extra = {}) => ({
  ref: "sandboxed@1",
  sandbox: { provider: "gondolin", allowedHosts: [] },
  ...extra,
});

const confinedDef = (extra = {}) => ({
  ref: "confined@1",
  mutating: false,
  capabilities: { filesystem: "workspace-only", services: [] },
  ...extra,
});

describe("sandboxRequested / refuseSandbox", () => {
  test("absent or null means no sandbox; anything else is a request", () => {
    expect(sandboxRequested({})).toBe(false);
    expect(sandboxRequested({ sandbox: null })).toBe(false);
    expect(sandboxRequested({ sandbox: undefined })).toBe(false);
    expect(sandboxRequested(sandboxDef())).toBe(true);
    // A malformed block is still a request — it is refused by policy
    // normalization later, never treated as "off".
    expect(sandboxRequested({ sandbox: false })).toBe(true);
    expect(sandboxRequested({ sandbox: "gondolin" })).toBe(true);
  });

  test("refuseSandbox is a no-op for ordinary definitions and a typed, adapter-naming error for sandboxed ones", () => {
    expect(() => refuseSandbox("claude", { ref: "x@1" }, "why")).not.toThrow();
    let caught;
    try {
      refuseSandbox("claude", sandboxDef(), "because reasons");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnsupportedError);
    expect(caught.code).toBe("sandbox_unsupported");
    expect(caught.adapter).toBe("claude");
    expect(caught.message).toContain(
      'adapter "claude" cannot honour a sandbox policy',
    );
    expect(caught.message).toContain(
      "refused rather than executed on the host",
    );
    expect(caught.message).toContain("because reasons");
  });
});

describe("workspace-only model admission (#962)", () => {
  const NO_QEMU = {
    available: false,
    qemu: null,
    node: "/usr/bin/node",
    nodeVersion: "v22.6.0",
    sdk: true,
    reason: "qemu-system-x86_64 is not on PATH",
  };
  const allowList = (...agents) => ({
    workspaceOnlyFallback: { mode: "host", agents },
    sandboxAvailability: NO_QEMU,
  });

  test("the host fallback admits only agents the policy names (#1250)", () => {
    const listed = confinedDef({ id: "work-scan", ref: "work-scan@1" });
    const runtime = allowList("work-scan", "triage-scan");

    expect(workspaceOnlyHostFallback(listed, runtime)).toBe(true);
    for (const adapter of ["agy", "claude", "cursor", "hermes", "pi"]) {
      expect(filesystemConfinementRefusal(adapter, listed, runtime)).toBeNull();
    }

    // An agent the operator did not name is refused exactly as before, and the
    // reason names the missing HOST capability rather than the policy shape.
    const unlisted = confinedDef({ id: "ci-doctor", ref: "ci-doctor@2" });
    expect(workspaceOnlyHostFallback(unlisted, runtime)).toBe(false);
    for (const adapter of ["agy", "claude", "cursor", "hermes", "pi"]) {
      expect(
        filesystemConfinementRefusal(adapter, unlisted, runtime),
      ).toMatchObject({
        code: FILESYSTEM_CONFINEMENT_REASON,
        detail: expect.stringContaining("sandbox_unavailable:qemu"),
      });
    }
  });

  test("mutating agents never reach the confinement gate (#1250)", () => {
    const mutating = confinedDef({
      id: "label-guard",
      ref: "label-guard@1",
      mutating: true,
    });
    const runtime = allowList("label-guard");
    expect(workspaceOnlyHostFallback(mutating, runtime)).toBe(false);
    for (const adapter of ["agy", "claude", "pi"]) {
      expect(
        filesystemConfinementRefusal(adapter, mutating, runtime),
      ).toBeNull();
    }
  });

  test("a definition-authored sandbox policy always outranks the allow-list (#1250)", () => {
    const explicitlySandboxed = confinedDef({
      id: "work-scan",
      ref: "work-scan@1",
      sandbox: { provider: "gondolin" },
    });
    const runtime = allowList("work-scan");
    expect(workspaceOnlyHostFallback(explicitlySandboxed, runtime)).toBe(false);
    expect(
      filesystemConfinementRefusal("pi", explicitlySandboxed, runtime),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("sandbox_unavailable:qemu"),
    });
  });

  test("a host that can sandbox never falls back (#1250)", () => {
    const listed = confinedDef({ id: "work-scan", ref: "work-scan@1" });
    const runtime = {
      workspaceOnlyFallback: { mode: "host", agents: ["work-scan"] },
      sandboxAvailability: { available: true, reason: null },
    };
    expect(
      filesystemConfinementRefusal("claude", listed, runtime),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("no enforced workspace-only guest path"),
    });
  });

  test("normalizeWorkspaceOnlyFallback fails closed on everything but an explicit grant (#1250)", () => {
    const warn = () => {};
    for (const value of [
      undefined,
      null,
      "",
      "HOST",
      "yes",
      true,
      ["work-scan"],
      { mode: "guest", agents: ["work-scan"] },
      { mode: "host" },
      { mode: "host", agents: [] },
      { mode: "host", agents: [null, ""] },
    ]) {
      expect(normalizeWorkspaceOnlyFallback(value, { warn })).toBeNull();
    }
    expect(
      normalizeWorkspaceOnlyFallback(
        { mode: "host", agents: ["work-scan", 7] },
        { warn },
      ),
    ).toEqual({ mode: "host", agents: ["work-scan"] });
  });

  test("the legacy blanket string still works but warns loudly (#1250)", () => {
    const warnings = [];
    const blanket = normalizeWorkspaceOnlyFallback("host", {
      warn: (message) => warnings.push(message),
    });
    expect(blanket).toEqual({ mode: "host", agents: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("EVERY");

    const runtime = {
      workspaceOnlyFallback: blanket,
      sandboxAvailability: NO_QEMU,
    };
    for (const id of ["work-scan", "some-other-scan"]) {
      expect(
        workspaceOnlyHostFallback(confinedDef({ id, ref: `${id}@1` }), runtime),
      ).toBe(true);
    }
  });

  test("host preflight failures name the missing capability before policy shape (#1250)", () => {
    const runtime = {
      sandboxAvailability: {
        available: false,
        qemu: null,
        node: null,
        nodeVersion: null,
        sdk: false,
        reason: "qemu-system-x86_64 is not on PATH",
      },
    };
    expect(sandboxUnavailableDetail(runtime.sandboxAvailability)).toBe(
      "sandbox_unavailable:qemu — qemu-system-x86_64 is not on PATH",
    );
    expect(
      filesystemConfinementRefusal("pi", confinedDef(), runtime),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("sandbox_unavailable:qemu"),
    });
  });

  test("unsupported model adapters fail closed with one typed reason", () => {
    for (const adapter of ["agy", "claude", "cursor", "hermes"]) {
      expect(filesystemConfinementRefusal(adapter, confinedDef())).toEqual({
        code: FILESYSTEM_CONFINEMENT_REASON,
        detail: expect.stringContaining(
          `adapter "${adapter}" has no enforced workspace-only guest path`,
        ),
      });
    }
  });

  test("pi is admitted only with a valid Gondolin policy and read-only runtime mounts", () => {
    const runtimeAssets = ws();
    expect(filesystemConfinementRefusal("pi", confinedDef())).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("requires an explicit sandbox policy"),
    });
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({ sandbox: { provider: "invalid" } }),
      ),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("sandbox policy is not enforceable"),
    });
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({
          sandbox: {
            provider: "gondolin",
            mounts: { "/opt/tools": { path: runtimeAssets } },
          },
        }),
      ),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("must be read-only"),
    });
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({
          sandbox: {
            provider: "gondolin",
            mounts: {
              "/opt/tools": { path: runtimeAssets, readonly: true },
            },
          },
        }),
      ),
    ).toBeNull();
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({ sandbox: { provider: "gondolin" } }),
        { sandboxSupport: "unsupported" },
      ),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining('SANDBOX_SUPPORT="unsupported"'),
    });
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({
          sandbox: {
            provider: "gondolin",
            mounts: {
              "/opt/auth": {
                path: "/home/operator/.config/gh",
                readonly: true,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("raw credential store"),
    });
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({
          sandbox: {
            provider: "gondolin",
            mounts: {
              "/opt/home": {
                path: "/home/operator",
                readonly: true,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("broad host user home"),
    });

    const aliasRoot = ws();
    const homeAlias = path.join(aliasRoot, "runtime-assets");
    symlinkSync(homedir(), homeAlias);
    expect(
      filesystemConfinementRefusal(
        "pi",
        confinedDef({
          sandbox: {
            provider: "gondolin",
            mounts: {
              "/opt/tools": { path: homeAlias, readonly: true },
            },
          },
        }),
      ),
    ).toMatchObject({
      code: FILESYSTEM_CONFINEMENT_REASON,
      detail: expect.stringContaining("resolves to"),
    });
  });

  test("runtime mounts deny operator-home data except the workspace allow-list", () => {
    const home = ws();
    const program = String.raw`
      import { mkdirSync, symlinkSync } from "node:fs";
      import path from "node:path";
      import { filesystemConfinementRefusal } from "./sandboxed.mjs";

      const mountRefusal = (hostPath) =>
        filesystemConfinementRefusal("pi", {
          ref: "confined@1",
          mutating: false,
          capabilities: { filesystem: "workspace-only", services: [] },
          sandbox: {
            provider: "gondolin",
            mounts: { "/opt/tools": { path: hostPath, readonly: true } },
          },
        });
      const home = process.env.HOME;
      const configPath = path.join(home, ".config", "sometool");
      const localPath = path.join(home, ".local", "share", "x");
      const workspacePath = path.join(process.env.FACTORY_EVENT_HOME, "workspaces", "run-x");
      const rawCredentialPath = path.join(home, ".config", "gh");
      mkdirSync(configPath, { recursive: true });
      mkdirSync(localPath, { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(rawCredentialPath, { recursive: true });
      const requireReason = (hostPath, reason) => {
        if (!mountRefusal(hostPath)?.detail.includes(reason)) throw new Error(hostPath + " did not report " + reason);
      };
      requireReason(configPath, "lies inside the operator home");
      requireReason(localPath, "lies inside the operator home");
      if (mountRefusal(path.dirname(workspacePath)) !== null) throw new Error("workspace root was refused");
      if (mountRefusal(workspacePath) !== null) throw new Error("workspace descendant was refused");
      requireReason(rawCredentialPath, "raw credential store");
      const alias = path.join(process.env.ALIAS_ROOT, "config-alias");
      symlinkSync(configPath, alias);
      requireReason(alias, "resolves to");
      requireReason(alias, "lies inside the operator home");
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", program],
      cwd: import.meta.dir,
      env: {
        ...process.env,
        HOME: home,
        FACTORY_EVENT_HOME: home,
        ALIAS_ROOT: ws(),
      },
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
  });

  test("workspace allowlist follows relocated FACTORY_EVENT_HOME", () => {
    const operatorHome = ws();
    const runtimeHome = ws();
    const program = String.raw`
      import { mkdirSync } from "node:fs";
      import path from "node:path";
      import { filesystemConfinementRefusal } from "./sandboxed.mjs";

      const mountRefusal = (hostPath) =>
        filesystemConfinementRefusal("pi", {
          ref: "confined@1",
          mutating: false,
          capabilities: { filesystem: "workspace-only", services: [] },
          sandbox: {
            provider: "gondolin",
            mounts: { "/opt/tools": { path: hostPath, readonly: true } },
          },
        });
      const configuredWorkspace = path.join(
        process.env.FACTORY_EVENT_HOME,
        "workspaces",
        "run-x",
      );
      const legacyWorkspace = path.join(
        process.env.HOME,
        ".factory",
        "event-runtime",
        "workspaces",
        "run-x",
      );
      mkdirSync(configuredWorkspace, { recursive: true });
      mkdirSync(legacyWorkspace, { recursive: true });
      if (mountRefusal(configuredWorkspace) !== null) {
        throw new Error("relocated workspace was refused");
      }
      if (!mountRefusal(legacyWorkspace)?.detail.includes("lies inside the operator home")) {
        throw new Error("legacy workspace was not refused");
      }
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", program],
      cwd: import.meta.dir,
      env: {
        ...process.env,
        HOME: operatorHome,
        FACTORY_EVENT_HOME: runtimeHome,
      },
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
  });

  test("mount guard refuses instead of throwing when FACTORY_EVENT_HOME is unset under NODE_ENV=test", () => {
    const operatorHome = ws();
    const program = String.raw`
      import { mkdirSync } from "node:fs";
      import path from "node:path";
      import { filesystemConfinementRefusal, HOME_MOUNT_ALLOWLIST } from "./sandboxed.mjs";

      const mountRefusal = (hostPath) =>
        filesystemConfinementRefusal("pi", {
          ref: "confined@1",
          mutating: false,
          capabilities: { filesystem: "workspace-only", services: [] },
          sandbox: {
            provider: "gondolin",
            mounts: { "/opt/tools": { path: hostPath, readonly: true } },
          },
        });
      const home = process.env.HOME;
      const allow = HOME_MOUNT_ALLOWLIST(home);
      if (allow.length !== 1 || allow[0] !== path.join(".factory", "event-runtime", "workspaces")) {
        throw new Error("allowlist did not fall back to the default subtree: " + JSON.stringify(allow));
      }
      const configPath = path.join(home, ".config", "sometool");
      mkdirSync(configPath, { recursive: true });
      const refusal = mountRefusal(configPath);
      if (!refusal?.detail.includes("lies inside the operator home")) {
        throw new Error("home-data mount was not refused: " + JSON.stringify(refusal));
      }
      const defaultWorkspace = path.join(home, ".factory", "event-runtime", "workspaces", "run-x");
      mkdirSync(defaultWorkspace, { recursive: true });
      if (mountRefusal(defaultWorkspace) !== null) {
        throw new Error("default workspace subtree was refused");
      }
    `;
    const env = { ...process.env, HOME: operatorHome, NODE_ENV: "test" };
    delete env.FACTORY_EVENT_HOME;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", program],
      cwd: import.meta.dir,
      env,
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  });

  test("non-model adapters and mutating definitions retain their existing semantics", () => {
    expect(filesystemConfinementRefusal("fake", confinedDef())).toBeNull();
    expect(
      filesystemConfinementRefusal("claude", confinedDef({ mutating: true })),
    ).toBeNull();
  });
});

describe("guest environment and binaries", () => {
  test("guestEnvironment is built from constants plus locale — the caller's env is not a source", () => {
    const env = guestEnvironment(
      { PI_OFFLINE: "1" },
      {
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "sk-fake-not-real",
        GITHUB_TOKEN: "ghp-fake",
        HOME: "/Users/someone",
        PATH: "/opt/homebrew/bin",
      },
    );
    expect(env).toEqual({
      HOME: GUEST_HOME,
      PATH: GUEST_PATH,
      TERM: "dumb",
      XDG_CONFIG_HOME: `${GUEST_XDG_ROOT}/config`,
      XDG_CACHE_HOME: `${GUEST_XDG_ROOT}/cache`,
      XDG_DATA_HOME: `${GUEST_XDG_ROOT}/data`,
      XDG_RUNTIME_DIR: `${GUEST_XDG_ROOT}/run`,
      LANG: "en_US.UTF-8",
      PI_OFFLINE: "1",
    });
    expect(GUEST_PATH.split(":")).toContain("/usr/local/bin");
  });

  test("adapter additions cannot override disposable HOME/XDG or guest command paths", () => {
    const env = guestEnvironment({
      HOME: "/home/operator",
      PATH: "/host/bin",
      XDG_CONFIG_HOME: "/home/operator/.config",
      XDG_CACHE_HOME: "/home/operator/.cache",
      XDG_DATA_HOME: "/home/operator/.local/share",
      XDG_RUNTIME_DIR: "/run/user/1000",
      TERM: "xterm-host",
      PI_OFFLINE: "1",
    });
    expect(env).toMatchObject({
      HOME: GUEST_HOME,
      PATH: GUEST_PATH,
      TERM: "dumb",
      XDG_CONFIG_HOME: `${GUEST_XDG_ROOT}/config`,
      XDG_CACHE_HOME: `${GUEST_XDG_ROOT}/cache`,
      XDG_DATA_HOME: `${GUEST_XDG_ROOT}/data`,
      XDG_RUNTIME_DIR: `${GUEST_XDG_ROOT}/run`,
      PI_OFFLINE: "1",
    });
  });

  test("guestBinary defaults to the image contract path and honours an absolute per-definition override", () => {
    expect(guestBinary(sandboxDef(), "pi")).toBe(GUEST_BINARIES.pi);
    expect(
      guestBinary(
        sandboxDef({
          sandbox: {
            provider: "gondolin",
            guestBinaries: { pi: "/opt/tools/pi" },
          },
        }),
        "pi",
      ),
    ).toBe("/opt/tools/pi");
    expect(() =>
      guestBinary(
        sandboxDef({
          sandbox: { provider: "gondolin", guestBinaries: { pi: "pi" } },
        }),
        "pi",
      ),
    ).toThrow(/absolute guest path/);
  });

  test("withStdinFile keeps the binary and args as positional parameters and refuses anything but a bare filename", () => {
    expect(
      withStdinFile(
        ["/usr/local/bin/pi", "-p", "--mode", "json"],
        ".prompt.md",
      ),
    ).toEqual([
      "/bin/sh",
      "-c",
      'exec "$0" "$@" < ./.prompt.md',
      "/usr/local/bin/pi",
      "-p",
      "--mode",
      "json",
    ]);
    expect(() => withStdinFile(["/bin/true"], "../escape")).toThrow(
      /bare workspace filename/,
    );
    expect(() => withStdinFile(["/bin/true"], "/workspace/x")).toThrow(
      /bare workspace filename/,
    );
    expect(() => withStdinFile(["/bin/true"], "a b")).toThrow(
      /bare workspace filename/,
    );
  });
});

describe("runSandboxed", () => {
  test("refuses a relative guest binary before the VM boundary is touched", async () => {
    let called = false;
    await expect(
      runSandboxed({
        adapter: "t",
        def: sandboxDef(),
        workspaceDir: ws(),
        argv: ["pi"],
        timeoutMs: 1000,
        runSandbox: async () => {
          called = true;
        },
      }),
    ).rejects.toThrow(/absolute guest path/);
    expect(called).toBe(false);
  });

  test("passes the policy, workspace, timeout, env and (wrapped) argv through, and captures the console", async () => {
    const workspaceDir = ws();
    let seen;
    const trace = [];
    const outcome = await runSandboxed({
      adapter: "pi",
      def: sandboxDef(),
      workspaceDir,
      argv: ["/usr/local/bin/pi", "-p"],
      stdinFile: ".prompt.md",
      env: { PI_OFFLINE: "1" },
      timeoutMs: 4321,
      onTrace: (kind, payload) => trace.push({ kind, payload }),
      onStdout: () => {},
      runSandbox: async (request) => {
        seen = request;
        request.onStderr("guest said something on stderr\n");
        return { exitCode: 0, timedOut: false, bootMs: 77 };
      },
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, bootMs: 77 });
    expect(seen.policy).toEqual(sandboxDef().sandbox);
    expect(seen.workspaceDir).toBe(workspaceDir);
    expect(seen.timeoutMs).toBe(4321);
    expect(seen.env).toEqual({ PI_OFFLINE: "1" });
    expect(seen.command).toEqual([
      "/bin/sh",
      "-c",
      'exec "$0" "$@" < ./.prompt.md',
      "/usr/local/bin/pi",
      "-p",
    ]);

    const console_ = readFileSync(
      path.join(workspaceDir, SANDBOX_CONSOLE_FILE),
      "utf8",
    );
    expect(console_).toContain(
      "[sandbox] adapter=pi definition=sandboxed@1 provider=gondolin",
    );
    expect(console_).toContain("guest said something on stderr");
    expect(console_).toContain("boot=77ms exit=0 timedOut=false");
    const lifecycle = trace.find(
      (t) => t.kind === "lifecycle" && t.payload.note === "sandbox_console",
    );
    expect(lifecycle.payload).toMatchObject({
      adapter: "pi",
      bootMs: 77,
      exitCode: 0,
      timedOut: false,
    });
    expect(lifecycle.payload.text).toContain("guest said something on stderr");
  });

  test("a guest timeout is reported exactly like a host timeout: null exit, timedOut true", async () => {
    const workspaceDir = ws();
    const outcome = await runSandboxed({
      adapter: "t",
      def: sandboxDef(),
      workspaceDir,
      argv: ["/bin/sleep", "999"],
      timeoutMs: 10,
      runSandbox: async () => ({ exitCode: null, timedOut: true, bootMs: 5 }),
    });
    expect(outcome).toEqual({ exitCode: null, timedOut: true, bootMs: 5 });
    expect(
      readFileSync(path.join(workspaceDir, SANDBOX_CONSOLE_FILE), "utf8"),
    ).toContain("timedOut=true");
  });

  test("a cooperative cancel resolves like a SIGTERMed host child, not as a runner crash", async () => {
    // The real runner is torn down by SIGTERM on abort and therefore never
    // reports a guest exit code, which gondolin.mjs surfaces as
    // sandbox_runner_crashed. When WE aborted, that is the expected shape.
    const ac = new AbortController();
    const workspaceDir = ws();
    const pending = runSandboxed({
      adapter: "t",
      def: sandboxDef(),
      workspaceDir,
      argv: ["/bin/sleep", "999"],
      timeoutMs: 60_000,
      abortSignal: ac.signal,
      runSandbox: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () =>
            reject(
              new SandboxExecutionError(
                "sandbox_runner_crashed",
                "runner exited (null) without reporting a guest exit code",
              ),
            ),
          );
        }),
    });
    setTimeout(() => ac.abort(), 5);
    const outcome = await pending;
    expect(outcome).toEqual({ exitCode: null, timedOut: false, bootMs: null });
    expect(
      readFileSync(path.join(workspaceDir, SANDBOX_CONSOLE_FILE), "utf8"),
    ).toContain("cancelled=true");
  });

  test("the same crash WITHOUT an abort is a failure, rethrown typed and written to the console", async () => {
    const workspaceDir = ws();
    const trace = [];
    await expect(
      runSandboxed({
        adapter: "t",
        def: sandboxDef(),
        workspaceDir,
        argv: ["/bin/true"],
        timeoutMs: 1000,
        onTrace: (kind, payload) => trace.push({ kind, payload }),
        runSandbox: async () => {
          throw new SandboxExecutionError(
            "sandbox_runner_crashed",
            "runner exited (1)",
          );
        },
      }),
    ).rejects.toMatchObject({ code: "sandbox_runner_crashed" });
    expect(
      readFileSync(path.join(workspaceDir, SANDBOX_CONSOLE_FILE), "utf8"),
    ).toContain("failed after");
    expect(
      trace.find((t) => t.payload?.note === "sandbox_console").payload.error,
    ).toContain("sandbox_runner_crashed");
  });
});

describe("real guest filesystem confinement (#962)", () => {
  const report = preflight();
  const itVM = report.available ? test : test.skip;
  if (!report.available) {
    console.warn(
      `[GH-962] skipping real-VM absolute-path confinement test — ${report.reason}`,
    );
  }

  itVM(
    "sandboxed pi cannot read or write host absolute paths outside its workspace",
    async () => {
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const hostSecret = `/tmp/factory-host-secret-${nonce}`;
      const hostEscape = `/tmp/factory-host-escape-${nonce}`;
      const workspaceDir = ws();
      writeFileSync(hostSecret, "raw-host-credential\n", { mode: 0o600 });
      rmSync(hostEscape, { force: true });

      try {
        const outcome = await runSandboxed({
          adapter: "pi",
          def: confinedDef({
            sandbox: { provider: "gondolin", allowedHosts: [] },
          }),
          workspaceDir,
          argv: [
            "/bin/sh",
            "-c",
            [
              'if cat "$0" >/dev/null 2>&1; then read_result=ESCAPED; else read_result=blocked; fi',
              'if printf guest-write > "$1" 2>/dev/null; then write_result=guest-only; else write_result=blocked; fi',
              'printf \'%s %s\\n\' "$read_result" "$write_result" > ./absolute-path-results',
            ].join("\n"),
            hostSecret,
            hostEscape,
          ],
          env: guestEnvironment(
            {},
            {
              HOME: "/home/operator",
              GITHUB_TOKEN: "ghp-host-only",
              CURSOR_API_KEY: "cursor-host-only",
              SSH_AUTH_SOCK: "/tmp/host-agent.sock",
            },
          ),
          timeoutMs: 120_000,
        });

        expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
        expect(
          readFileSync(
            path.join(workspaceDir, "absolute-path-results"),
            "utf8",
          ),
        ).toMatch(/^blocked (guest-only|blocked)\n$/);
        expect(readFileSync(hostSecret, "utf8")).toBe("raw-host-credential\n");
        expect(existsSync(hostEscape)).toBe(false);
      } finally {
        rmSync(hostSecret, { force: true });
        rmSync(hostEscape, { force: true });
      }
    },
    180_000,
  );
});

/**
 * The conformance sweep. Every adapter module in this directory is loaded and
 * handed a sandboxed definition; the only acceptable outcomes are (a) it
 * called the sandbox boundary, or (b) it threw SandboxUnsupportedError naming
 * itself. Anything else — a host spawn, a quiet success, a different error —
 * means the adapter ignored the block, which is the WM-313 defect.
 */
describe("every adapter decides about def.sandbox (WM-313 conformance)", () => {
  // These are the built-ins cli/work.mjs and cli/serve.mjs obtain through
  // createAdapterRegistry(). Keep the list explicit: helper modules added
  // beside adapters must not silently become executable conformance targets
  // merely because of their filename.
  const modules = [
    "actions",
    "agy",
    "claude",
    "command",
    "cursor",
    "fake",
    "hermes",
    "pi",
  ];

  test("the explicit sweep list matches the built-in set both worker entry points register (lib/adapters/index.mjs)", () => {
    expect(Object.keys(builtinAdapters()).sort()).toEqual(modules);
  });

  for (const name of modules) {
    test(`${name}: honours the sandbox or refuses typed — never runs on the host`, async () => {
      const mod = await import(`./${name}.mjs`);
      expect(["gondolin", "unsupported"]).toContain(mod.SANDBOX_SUPPORT);

      const workspaceDir = ws();
      const promptPath = path.join(workspaceDir, "prompt.md");
      writeFileSync(promptPath, "conformance prompt", "utf8");
      writeFileSync(path.join(workspaceDir, "input.json"), "{}\n", "utf8");
      let boundaryHit = false;
      const runSandbox = async ({ workspaceDir: dirSeen }) => {
        boundaryHit = true;
        writeFileSync(
          path.join(dirSeen, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
          }),
        );
        return { exitCode: 0, timedOut: false, bootMs: 1 };
      };
      const def = {
        ref: `${name}-sandboxed@1`,
        promptPath,
        promptText: "conformance prompt",
        mutating: false,
        // command adapter shape; ignored by the others
        command: ["/bin/true"],
        sandbox: { provider: "gondolin", allowedHosts: [] },
      };
      let caught = null;
      try {
        await mod.execute({
          spec: { agent: def.ref, input: { repos: ["ok"] } },
          def,
          workspaceDir,
          timeoutMs: 2000,
          // A PATH with nothing on it: an adapter that ignores the block and
          // goes looking for its host CLI fails loudly instead of running it.
          env: { PATH: workspaceDir },
          runSandbox,
        });
      } catch (err) {
        caught = err;
      }

      if (mod.SANDBOX_SUPPORT === "gondolin") {
        expect(caught).toBeNull();
        expect(boundaryHit).toBe(true);
      } else {
        expect(boundaryHit).toBe(false);
        expect(caught).toBeInstanceOf(SandboxUnsupportedError);
        expect(caught.adapter).toBe(name);
        expect(caught.code).toBe("sandbox_unsupported");
        // Refusal happens before anything touches the workspace.
        expect(existsSync(path.join(workspaceDir, ".transcript.json"))).toBe(
          false,
        );
        expect(existsSync(path.join(workspaceDir, "result.json"))).toBe(false);
      }
    });
  }
});

describe("pi sandbox prompt staging", () => {
  test("invalid guest binary configuration leaves no prompt file", async () => {
    const { execute, SANDBOX_PROMPT_FILE } = await import("./pi.mjs");
    const workspaceDir = ws();
    const promptPath = path.join(workspaceDir, "source-prompt.md");
    writeFileSync(promptPath, "prompt", "utf8");

    await expect(
      execute({
        spec: { agent: "pi-invalid-binary@1" },
        def: {
          ...sandboxDef({
            ref: "pi-invalid-binary@1",
            promptPath,
            promptText: "prompt",
          }),
          sandbox: {
            provider: "gondolin",
            allowedHosts: [],
            guestBinaries: { pi: "pi" },
          },
        },
        workspaceDir,
        timeoutMs: 1000,
        runSandbox: async () => {
          throw new Error("VM boundary must not be reached");
        },
      }),
    ).rejects.toThrow(/absolute guest path/);
    expect(existsSync(path.join(workspaceDir, SANDBOX_PROMPT_FILE))).toBe(
      false,
    );
  });

  test("invalid sandbox policy leaves no prompt file", async () => {
    const { execute, SANDBOX_PROMPT_FILE } = await import("./pi.mjs");
    const workspaceDir = ws();
    const promptPath = path.join(workspaceDir, "source-prompt.md");
    writeFileSync(promptPath, "prompt", "utf8");

    await expect(
      execute({
        spec: { agent: "pi-invalid-policy@1" },
        def: {
          ...sandboxDef({
            ref: "pi-invalid-policy@1",
            promptPath,
            promptText: "prompt",
          }),
          sandbox: { provider: "invalid", allowedHosts: [] },
        },
        workspaceDir,
        timeoutMs: 1000,
        runSandbox: async () => {
          throw new Error("VM boundary must not be reached");
        },
      }),
    ).rejects.toThrow(/unknown sandbox provider/);
    expect(existsSync(path.join(workspaceDir, SANDBOX_PROMPT_FILE))).toBe(
      false,
    );
  });
});

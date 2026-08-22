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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SandboxExecutionError } from "../sandbox/gondolin.mjs";
import { builtinAdapters } from "./index.mjs";
import {
  GUEST_BINARIES,
  GUEST_HOME,
  GUEST_PATH,
  guestBinary,
  guestEnvironment,
  refuseSandbox,
  runSandboxed,
  SANDBOX_CONSOLE_FILE,
  sandboxRequested,
  SandboxUnsupportedError,
  withStdinFile,
} from "./sandboxed.mjs";

const ws = () => tmpDir("evrt-sandboxed-");
const sandboxDef = (extra = {}) => ({
  ref: "sandboxed@1",
  sandbox: { provider: "gondolin", allowedHosts: [] },
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
      LANG: "en_US.UTF-8",
      PI_OFFLINE: "1",
    });
    expect(GUEST_PATH.split(":")).toContain("/usr/local/bin");
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
          ...sandboxDef({ ref: "pi-invalid-binary@1", promptPath }),
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
          ...sandboxDef({ ref: "pi-invalid-policy@1", promptPath }),
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

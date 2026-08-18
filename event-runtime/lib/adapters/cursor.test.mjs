import { describe, expect, test, afterAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FACTORY_ROOT } from "../config.mjs";
import { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV as CLAUDE_PUSH_CREDENTIAL_ENV } from "./claude.mjs";
import {
  buildCursorArgv,
  CliNotFoundError,
  describeToolCall,
  execute,
  extractUsage,
  isHarnessDenial,
  KILL_GRACE_MS,
  mapStreamEvent,
  PUSH_CREDENTIAL_ENV,
  resolveCursorCommand,
  safeChildEnvironment,
  toolNameFromKey,
} from "./cursor.mjs";
import { processOwnerWatchdogSource, trackProcessGroupForPid } from "../test-helpers-process.mjs";

describe("isHarnessDenial (WM-127, no confirmed Cursor refusal shapes yet)", () => {
  test("nothing matches — empty until a Cursor-authored shape is observed", () => {
    expect(isHarnessDenial("Permission to use Shell has been denied.")).toBe(false);
    expect(isHarnessDenial("Cursor requested permissions to use write, but you haven't granted it yet.")).toBe(false);
    expect(isHarnessDenial("EACCES: permission denied, open '/var/log/system.log'")).toBe(false);
    expect(isHarnessDenial(null)).toBe(false);
  });
});

describe("mapStreamEvent (Cursor stream-json shapes from output-format.md)", () => {
  test("assistant text → assistant_text", () => {
    const events = mapStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "I'll read the file." }] },
      session_id: "s-1",
    });
    expect(events).toEqual([{ kind: "assistant_text", payload: { text: "I'll read the file." } }]);
  });

  test("assistant events with timestamp_ms are skipped (stream-partial deltas)", () => {
    expect(mapStreamEvent({
      type: "assistant",
      timestamp_ms: 1,
      message: { content: [{ type: "text", text: "delta" }] },
    })).toEqual([]);
  });

  test("tool_call started readToolCall → tool_use", () => {
    expect(mapStreamEvent({
      type: "tool_call",
      subtype: "started",
      call_id: "toolu_1",
      tool_call: { readToolCall: { args: { path: "README.md" } } },
    })).toEqual([
      { kind: "tool_use", payload: { id: "toolu_1", name: "read", input: { path: "README.md" } } },
    ]);
  });

  test("tool_call completed readToolCall → tool_result", () => {
    expect(mapStreamEvent({
      type: "tool_call",
      subtype: "completed",
      call_id: "toolu_1",
      tool_call: {
        readToolCall: {
          args: { path: "README.md" },
          result: { success: { content: "# Project\n", totalLines: 1 } },
        },
      },
    })).toEqual([
      { kind: "tool_result", payload: { content: "# Project\n", toolUseId: "toolu_1" } },
    ]);
  });

  test("tool_call completed with result.error → tool_result isError", () => {
    expect(mapStreamEvent({
      type: "tool_call",
      subtype: "completed",
      call_id: "toolu_2",
      tool_call: { writeToolCall: { result: { error: "write failed" } } },
    })).toEqual([
      { kind: "tool_result", payload: { content: "write failed", toolUseId: "toolu_2", isError: true } },
    ]);
  });

  test("function-shaped tool_call is mapped", () => {
    expect(mapStreamEvent({
      type: "tool_call",
      subtype: "started",
      call_id: "fn_1",
      tool_call: { function: { name: "shell", arguments: "{\"command\":\"ls\"}" } },
    })).toEqual([
      { kind: "tool_use", payload: { id: "fn_1", name: "shell", input: { command: "ls" } } },
    ]);
  });

  test("unrecognized events are ignored silently", () => {
    expect(mapStreamEvent({ type: "user", message: { content: [] } })).toEqual([]);
    expect(mapStreamEvent({ type: "system", subtype: "init" })).toEqual([]);
    expect(mapStreamEvent(null)).toEqual([]);
    expect(mapStreamEvent("not an object")).toEqual([]);
  });

  test("very long assistant text is clipped", () => {
    const [event] = mapStreamEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "y".repeat(10_000) }] },
    });
    expect(event.kind).toBe("assistant_text");
    expect(event.payload.text.length).toBeLessThan(4100);
    expect(event.payload.text.endsWith("…[truncated]")).toBe(true);
  });
});

describe("describeToolCall / toolNameFromKey", () => {
  test("strips ToolCall suffix", () => {
    expect(toolNameFromKey("readToolCall")).toBe("read");
    expect(toolNameFromKey("writeToolCall")).toBe("write");
    expect(toolNameFromKey("")).toBe("tool");
  });

  test("empty or missing tool_call is a generic tool", () => {
    expect(describeToolCall(null)).toEqual({ name: "tool", input: {} });
    expect(describeToolCall({})).toEqual({ name: "tool", input: {} });
  });
});

describe("extractUsage", () => {
  test("reads duration from the terminal result; tokens stay empty (not fabricated)", () => {
    expect(extractUsage({
      type: "result",
      subtype: "success",
      duration_ms: 5234,
      is_error: false,
      result: "done",
    })).toEqual({ usage: {}, costUSD: null, durationMs: 5234, isError: false });
  });

  test("returns null when the message is not a result", () => {
    expect(extractUsage({ type: "assistant" })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });
});

describe("buildCursorArgv", () => {
  test("print + stream-json + trust + force; prompt is positional after --", () => {
    const argv = buildCursorArgv({ prompt: "Do the smoke" });
    expect(argv).toEqual(["-p", "--output-format", "stream-json", "--trust", "--force", "--", "Do the smoke"]);
    expect(argv).not.toContain("--mode");
    expect(argv).not.toContain("--stream-partial-output");
    expect(argv).not.toContain("--worktree");
  });

  test("planner-pinned model → --model; default/empty/null → no flag", () => {
    const withModel = buildCursorArgv({ prompt: "x", model: "composer-2.5" });
    expect(withModel).toContain("--model");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("composer-2.5");

    const unpinned = buildCursorArgv({ prompt: "x" });
    expect(buildCursorArgv({ prompt: "x", model: "default" })).toEqual(unpinned);
    expect(buildCursorArgv({ prompt: "x", model: null })).toEqual(unpinned);
    expect(buildCursorArgv({ prompt: "x", model: "" })).toEqual(unpinned);
    expect(unpinned).not.toContain("--model");
  });
});

describe("resolveCursorCommand", () => {
  test("agent on PATH wins; cursor-agent is the fallback; cursor editor is ignored", () => {
    expect(resolveCursorCommand({ which: (n) => (n === "agent" ? "/usr/local/bin/agent" : null) }))
      .toEqual({ command: "agent", args: [] });
    expect(resolveCursorCommand({ which: (n) => (n === "cursor-agent" ? "/usr/local/bin/cursor-agent" : null) }))
      .toEqual({ command: "cursor-agent", args: [] });
    expect(resolveCursorCommand({ which: (n) => (n === "cursor" ? "/usr/local/bin/cursor" : null) })).toBeNull();
    expect(resolveCursorCommand({ which: () => null })).toBeNull();
  });
});

describe("safeChildEnvironment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("keeps CURSOR_API_KEY, strips provider keys and CURSOR_API_ENDPOINT (WM-443)", () => {
    const env = safeChildEnvironment({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      CURSOR_API_KEY: "cursor-secret",
      CURSOR_API_ENDPOINT: "https://evil.example",
      CUSTOM_VAR: "kept",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBe("cursor-secret");
    expect(env.CURSOR_API_ENDPOINT).toBeUndefined();
    expect(env.CUSTOM_VAR).toBe("kept");
  });

  test("inherits CURSOR_API_KEY from process.env when caller env omits it (WM-443)", () => {
    process.env.CURSOR_API_KEY = "from-process";
    const env = safeChildEnvironment({ CUSTOM_VAR: "kept" });
    expect(env.CURSOR_API_KEY).toBe("from-process");
    expect(env.CUSTOM_VAR).toBe("kept");
  });

  test("strips push credentials for non-mutating runs and still keeps CURSOR_API_KEY", () => {
    const childEnv = safeChildEnvironment({
      SSH_AUTH_SOCK: "/tmp/test.sock",
      GITHUB_TOKEN: "ghp_secret",
      CURSOR_API_KEY: "sk",
    }, { mutating: false });
    for (const key of PUSH_CREDENTIAL_ENV) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(childEnv.CURSOR_API_KEY).toBe("sk");
  });

  test("preserves push credentials for mutating runs and keeps CURSOR_API_KEY", () => {
    const childEnv = safeChildEnvironment({
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GITHUB_TOKEN: "ghp_mutating",
      CURSOR_API_KEY: "sk",
    }, { mutating: true });
    expect(childEnv.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(childEnv.GITHUB_TOKEN).toBe("ghp_mutating");
    expect(childEnv.CURSOR_API_KEY).toBe("sk");
  });

  test("defaults to stripping when mutating is omitted", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/inherited.sock";
    expect(safeChildEnvironment({}).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, {}).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, false).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, true).SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  test("injects FACTORY_ROOT and refuses caller overrides", () => {
    expect(safeChildEnvironment({}).FACTORY_ROOT).toBe(FACTORY_ROOT);
    expect(safeChildEnvironment({ FACTORY_ROOT: "/tmp/untrusted" }).FACTORY_ROOT).toBe(FACTORY_ROOT);
  });

  test("shares one push-credential list with the claude adapter", () => {
    expect(PUSH_CREDENTIAL_ENV).toBe(CLAUDE_PUSH_CREDENTIAL_ENV);
  });
});

describe("execute conformance (WM-440, docs/event-runtime.md §6)", () => {
  const tmpBase = realpathSync(mkdtempSync(path.join(tmpdir(), "evrt-cursor-test-")));
  const stubBinDir = path.join(tmpBase, "bin");
  mkdirSync(stubBinDir, { recursive: true });
  const emptyBinDir = path.join(tmpBase, "empty-bin");
  mkdirSync(emptyBinDir, { recursive: true });

  const stubAgentPath = path.join(stubBinDir, "agent");
  const stubScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

${processOwnerWatchdogSource()}

if (process.env.FACTORY_TEST_RECORD_FILE) {
  writeFileSync(
    process.env.FACTORY_TEST_RECORD_FILE,
    JSON.stringify({ cwd: process.cwd(), env: process.env, argv: process.argv }),
    "utf8",
  );
}

const behavior = process.env.FACTORY_TEST_BEHAVIOR || "normal";

if (behavior === "normal") {
  process.stdout.write(JSON.stringify({
    type: "system", subtype: "init", model: "Composer 2.5",
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Working..." }] },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", duration_ms: 1200, is_error: false, result: "Working...",
  }) + "\\n");
  process.exit(0);
}

if (behavior === "exit_code") {
  process.exit(parseInt(process.env.FACTORY_TEST_EXIT_CODE || "1", 10));
}

if (behavior === "stderr_then_exit") {
  process.stderr.write(process.env.FACTORY_TEST_STDERR || "Error: Authentication required.\\n");
  process.exit(parseInt(process.env.FACTORY_TEST_EXIT_CODE || "1", 10));
}

if (behavior === "sleep_sigterm") {
  setInterval(() => {}, 10_000);
}

if (behavior === "ignore_sigterm") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 10_000);
}

if (behavior === "spawn_long_lived_grandchild") {
  const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 10_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  writeFileSync(process.env.FACTORY_TEST_GRANDCHILD_PID_FILE, String(grandchild.pid), "utf8");
  setInterval(() => {}, 10_000);
}

if (behavior === "emit_tool_then_success") {
  process.stdout.write(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "toolu_1",
    tool_call: { readToolCall: { args: { path: "a.txt" } } },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "toolu_1",
    tool_call: { readToolCall: { result: { success: { content: "hello world" } } } },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Done." }] },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", duration_ms: 800, is_error: false, result: "Done.",
  }) + "\\n");
  process.exit(0);
}

if (behavior === "emit_error_tool_result") {
  process.stdout.write(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "toolu_err",
    tool_call: { writeToolCall: { args: { path: "/etc/nope" } } },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "toolu_err",
    tool_call: { writeToolCall: { result: { error: "Permission to use write has been denied." } } },
  }) + "\\n");
  process.exit(1);
}
`;
  writeFileSync(stubAgentPath, stubScript, { mode: 0o755 });

  const promptFile = path.join(tmpBase, "prompt.md");
  writeFileSync(promptFile, "You are a test agent.", "utf8");

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const ws = () => realpathSync(mkdtempSync(path.join(tmpBase, "ws-")));
  const defaultDef = { ref: "test-cursor-agent@1", promptPath: promptFile, mutating: false };
  const defaultSpec = { agent: "test-cursor-agent@1", input: { message: "hi" } };
  const testProcessGroup = process.platform === "win32" ? test.skip : test;

  async function waitForGrandchildPid(pidFile) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        trackProcessGroupForPid(pid);
        return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("stub did not report its grandchild PID");
  }

  function processExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  async function expectProcessExit(pid) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (!processExists(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(processExists(pid)).toBe(false);
  }

  function killIfRunning(pid) {
    if (!pid || !processExists(pid)) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // exited between check and cleanup
    }
  }

  test("executes stub binary in workspaceDir, passes CURSOR_API_KEY, prompt on argv, captures transcript + trace", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const traceEvents = [];

    const outcome = await execute({
      spec: { ...defaultSpec, model: "composer-2.5" },
      def: defaultDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        CURSOR_API_KEY: "sk-must-be-passed",
        CUSTOM_VAR: "custom_value",
        FACTORY_TEST_BEHAVIOR: "normal",
        FACTORY_TEST_RECORD_FILE: recordFile,
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });

    expect(outcome).toEqual({ exitCode: 0, timedOut: false, policyDenials: [] });
    expect(existsSync(recordFile)).toBe(true);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.cwd).toBe(workspaceDir);
    expect(record.env.CURSOR_API_KEY).toBe("sk-must-be-passed");
    expect(record.env.CUSTOM_VAR).toBe("custom_value");
    expect(record.argv).toContain("-p");
    expect(record.argv).toContain("--output-format");
    expect(record.argv).toContain("stream-json");
    expect(record.argv).toContain("--trust");
    expect(record.argv).toContain("--force");
    expect(record.argv).toContain("--model");
    expect(record.argv[record.argv.indexOf("--model") + 1]).toBe("composer-2.5");
    expect(record.argv.at(-2)).toBe("--");
    expect(record.argv.at(-1)).toBe(`You are a test agent.${PROMPT_SUFFIX}`);

    const transcriptPath = path.join(workspaceDir, ".transcript.json");
    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, "utf8")).toContain('"type":"assistant"');

    expect(traceEvents.some((e) => e.kind === "assistant_text" && e.payload.text === "Working...")).toBe(true);
    const usageEvent = traceEvents.find((e) => e.kind === "usage");
    expect(usageEvent.payload.durationMs).toBe(1200);
    expect(usageEvent.payload.costUSD).toBeNull();
    expect(usageEvent.payload.usage).toEqual({});
  });

  test("nonzero exit code propagates and timedOut is false", async () => {
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "exit_code",
        FACTORY_TEST_EXIT_CODE: "42",
      },
    });
    expect(outcome.exitCode).toBe(42);
    expect(outcome.timedOut).toBe(false);
  });

  test("nonzero exit writes .stderr.txt and emits adapter_stderr lifecycle (WM-443)", async () => {
    const workspaceDir = ws();
    const traceEvents = [];
    const stderr = "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n";
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "stderr_then_exit",
        FACTORY_TEST_STDERR: stderr,
        FACTORY_TEST_EXIT_CODE: "1",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(path.join(workspaceDir, ".stderr.txt"), "utf8")).toBe(stderr);
    expect(traceEvents.some((e) => (
      e.kind === "lifecycle"
      && e.payload?.note === "adapter_stderr"
      && String(e.payload?.text ?? "").includes("Authentication required")
    ))).toBe(true);
  });

  testProcessGroup("timeout kills a real long-lived grandchild (WM-263)", async () => {
    const workspaceDir = ws();
    const pidFile = path.join(workspaceDir, "grandchild.pid");
    const ac = new AbortController();
    const runPromise = execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 6_000,
      killGraceMs: 5000,
      abortSignal: ac.signal,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "spawn_long_lived_grandchild",
        FACTORY_TEST_GRANDCHILD_PID_FILE: pidFile,
      },
    });
    let grandchildPid;
    try {
      grandchildPid = await waitForGrandchildPid(pidFile);
      expect(processExists(grandchildPid)).toBe(true);
      const outcome = await runPromise;
      expect(outcome.timedOut).toBe(true);
      await expectProcessExit(grandchildPid);
    } finally {
      ac.abort();
      await runPromise;
      killIfRunning(grandchildPid);
    }
  }, { timeout: 12_000 });

  test("timeout escalates to SIGKILL when child ignores SIGTERM", async () => {
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 100,
      killGraceMs: 100,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "ignore_sigterm",
      },
    });
    expect(outcome.timedOut).toBe(true);
  });

  testProcessGroup("abort kills a real long-lived grandchild (WM-263)", async () => {
    const workspaceDir = ws();
    const pidFile = path.join(workspaceDir, "grandchild.pid");
    const ac = new AbortController();
    const runPromise = execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 10_000,
      killGraceMs: 500,
      abortSignal: ac.signal,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "spawn_long_lived_grandchild",
        FACTORY_TEST_GRANDCHILD_PID_FILE: pidFile,
      },
    });
    let grandchildPid;
    try {
      grandchildPid = await waitForGrandchildPid(pidFile);
      expect(processExists(grandchildPid)).toBe(true);
      ac.abort();
      const outcome = await runPromise;
      expect(outcome.timedOut).toBe(false);
      await expectProcessExit(grandchildPid);
    } finally {
      ac.abort();
      await runPromise;
      killIfRunning(grandchildPid);
    }
  });

  test("tool_call stream maps to tool_use / tool_result and a usage event", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_tool_then_success",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, policyDenials: [] });
    expect(traceEvents.some((e) => e.kind === "tool_use" && e.payload.name === "read")).toBe(true);
    expect(traceEvents.some((e) => e.kind === "tool_result" && e.payload.content === "hello world")).toBe(true);
    expect(traceEvents.find((e) => e.kind === "usage")?.payload.durationMs).toBe(800);
  });

  test("a tool error that reads like a permission denial is never policy_denied (WM-127)", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_error_tool_result",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.policyDenials).toEqual([]);
    expect(traceEvents.some((e) => e.kind === "lifecycle" && e.payload.note === "policy_denial")).toBe(false);
  });

  test("run with no output reports usage as explicit n/a, not a fabricated zero", async () => {
    const traceEvents = [];
    await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "exit_code",
        FACTORY_TEST_EXIT_CODE: "0",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(traceEvents.find((e) => e.kind === "usage")?.payload).toEqual({
      durationMs: null, numTurns: null, costUSD: null, usage: {},
    });
  });

  test("missing agent and cursor-agent on PATH is a typed CliNotFoundError", async () => {
    await expect(
      execute({
        spec: defaultSpec,
        def: defaultDef,
        workspaceDir: ws(),
        timeoutMs: 1000,
        env: { PATH: emptyBinDir },
      }),
    ).rejects.toMatchObject({ name: "CliNotFoundError", code: "cli_not_found" });
    expect(CliNotFoundError).toBeDefined();
    expect(KILL_GRACE_MS).toBe(30_000);
  });
});

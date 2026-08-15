import { describe, expect, test, afterAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV as CLAUDE_PUSH_CREDENTIAL_ENV } from "./claude.mjs";
import {
  buildPiArgv,
  CliNotFoundError,
  execute,
  extractUsage,
  isHarnessDenial,
  KILL_GRACE_MS,
  mapStreamEvent,
  PUSH_CREDENTIAL_ENV,
  READ_ONLY_TOOLS,
  resolvePiCommand,
  safeChildEnvironment,
} from "./pi.mjs";

describe("isHarnessDenial (WM-127, no confirmed pi refusal shapes yet)", () => {
  test("nothing matches — pi enforces read-only by tool non-exposure, not runtime denial", () => {
    // These look exactly like the strings that WOULD match claude's patterns,
    // and like plausible OS/tool errors. None are a confirmed pi-authored
    // refusal shape, so all must stay unclassified.
    expect(isHarnessDenial("Permission to use bash has been denied.")).toBe(false);
    expect(isHarnessDenial("pi requested permission to use write, but you haven't granted it yet.")).toBe(false);
    expect(isHarnessDenial("EACCES: permission denied, open '/var/log/system.log'")).toBe(false);
    expect(isHarnessDenial("bash: /etc/hosts: Permission denied")).toBe(false);
    expect(isHarnessDenial(null)).toBe(false);
    expect(isHarnessDenial(undefined)).toBe(false);
  });
});

describe("mapStreamEvent (real `pi --mode json` shapes, investigated live)", () => {
  test("assistant message_end text block → assistant_text", () => {
    const events = mapStreamEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Files: `a.txt`." }] },
    });
    expect(events).toEqual([{ kind: "assistant_text", payload: { text: "Files: `a.txt`." } }]);
  });

  test("assistant message_end toolCall block → tool_use; mixed blocks map in order", () => {
    const events = mapStreamEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "tool_use", payload: { id: "call_1|fc_1", name: "read", input: { path: "a.txt" } } },
    ]);
  });

  test("tool_execution_end → tool_result, text content flattened, isError", () => {
    const ok = mapStreamEvent({
      type: "tool_execution_end",
      toolCallId: "call_1|fc_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "hello world\n" }] },
      isError: false,
    });
    expect(ok).toEqual([{ kind: "tool_result", payload: { content: "hello world\n", toolUseId: "call_1|fc_1" } }]);

    const err = mapStreamEvent({
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] },
      isError: true,
    });
    expect(err).toEqual([{ kind: "tool_result", payload: { content: "line 1\nline 2", toolUseId: "call_2", isError: true } }]);
  });

  test("unrecognized message types are ignored silently", () => {
    expect(mapStreamEvent({ type: "session", version: 3 })).toEqual([]);
    expect(mapStreamEvent({ type: "agent_start" })).toEqual([]);
    expect(mapStreamEvent({ type: "turn_start" })).toEqual([]);
    expect(mapStreamEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } })).toEqual([]);
    expect(mapStreamEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } })).toEqual([]);
    expect(mapStreamEvent({ type: "turn_end", message: {} })).toEqual([]);
    expect(mapStreamEvent({ type: "agent_end", messages: [] })).toEqual([]);
    expect(mapStreamEvent({ type: "agent_settled" })).toEqual([]);
    expect(mapStreamEvent({ type: "message_end" })).toEqual([]); // no message body
    expect(mapStreamEvent(null)).toEqual([]);
    expect(mapStreamEvent("not an object")).toEqual([]);
  });

  test("very long assistant text is clipped, not passed through whole", () => {
    const [event] = mapStreamEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "y".repeat(10_000) }] },
    });
    expect(event.kind).toBe("assistant_text");
    expect(event.payload.text.length).toBeLessThan(5_000);
    expect(event.payload.text.endsWith("…[truncated]")).toBe(true);
  });
});

describe("extractUsage", () => {
  test("assistant message_end with usage → token fields + cost", () => {
    const usage = extractUsage({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 983, output: 16, cacheRead: 2560, cacheWrite: 0, reasoning: 0, totalTokens: 3559, cost: { total: 0.000267 } },
      },
    });
    expect(usage).toEqual({
      usage: { input: 983, output: 16, cacheRead: 2560, cacheWrite: 0, reasoning: 0, totalTokens: 3559 },
      costUSD: 0.000267,
    });
  });

  test("non-assistant, missing usage, or non-message_end → null", () => {
    expect(extractUsage({ type: "message_end", message: { role: "user", usage: { input: 1 } } })).toBeNull();
    expect(extractUsage({ type: "message_end", message: { role: "assistant" } })).toBeNull();
    expect(extractUsage({ type: "message_update" })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });
});

describe("buildPiArgv", () => {
  test("prompt travels on stdin, not argv — base argv is -p --mode json", () => {
    expect(buildPiArgv({ def: { mutating: true }, model: null })).toEqual(["-p", "--mode", "json"]);
  });

  test("mutating: false → --tools read,grep,find,ls,write (pi's own read-only pattern, not -r)", () => {
    const argv = buildPiArgv({ def: { mutating: false }, model: null });
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe(READ_ONLY_TOOLS.join(","));
    expect(argv).toEqual(["-p", "--mode", "json", "--tools", "read,grep,find,ls,write"]);
  });

  test("mutating: true → no --tools restriction", () => {
    expect(buildPiArgv({ def: { mutating: true }, model: null })).not.toContain("--tools");
  });

  test("planner-pinned model → --model verbatim; default sentinel, null, or absent → no flag (WM-135)", () => {
    const withModel = buildPiArgv({ def: { mutating: false }, model: "openai-codex/gpt-5.6-terra" });
    const i = withModel.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(withModel[i + 1]).toBe("openai-codex/gpt-5.6-terra");

    const unpinned = buildPiArgv({ def: { mutating: false }, model: undefined });
    expect(buildPiArgv({ def: { mutating: false }, model: "default" })).toEqual(unpinned);
    expect(buildPiArgv({ def: { mutating: false }, model: null })).toEqual(unpinned);
    expect(buildPiArgv({ def: { mutating: false }, model: "" })).toEqual(unpinned);
  });
});

describe("resolvePiCommand", () => {
  test("pi on PATH → run it directly", () => {
    const which = (name) => (name === "pi" ? "/usr/local/bin/pi" : null);
    expect(resolvePiCommand({ which })).toEqual({ command: "pi", args: [] });
  });

  test("pi missing, npx present → npx pi fallback", () => {
    const which = (name) => (name === "npx" ? "/usr/local/bin/npx" : null);
    expect(resolvePiCommand({ which })).toEqual({ command: "npx", args: ["pi"] });
  });

  test("neither on PATH → null", () => {
    expect(resolvePiCommand({ which: () => null })).toBeNull();
  });
});

describe("safeChildEnvironment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("strips every provider API key pi recognizes, keeps declared env", () => {
    const env = safeChildEnvironment({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      GEMINI_API_KEY: "c",
      GOOGLE_API_KEY: "d",
      GOOGLE_GENAI_API_KEY: "e",
      MISTRAL_API_KEY: "f",
      DEEPSEEK_API_KEY: "g",
      GROQ_API_KEY: "h",
      CUSTOM_VAR: "kept",
    });
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY"]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.CUSTOM_VAR).toBe("kept");
  });

  // Mirrors claude.test.mjs's "safeChildEnvironment (WM-128)" block: the pi
  // adapter had no mutating/non-mutating distinction at all until WM-223, so a
  // pi-routed dispatch run reached the push step with no credentials.
  test("strips push credentials for non-mutating runs (WM-128 parity, WM-223)", () => {
    const childEnv = safeChildEnvironment({
      SSH_AUTH_SOCK: "/tmp/test.sock",
      SSH_AGENT_PID: "12345",
      GITHUB_TOKEN: "ghp_secret_token",
      GH_TOKEN: "ghp_other_token",
      OPENAI_API_KEY: "sk-secret",
      CUSTOM_INSPECT_VAR: "allowed",
    }, { mutating: false });

    expect(childEnv.CUSTOM_INSPECT_VAR).toBe("allowed");
    for (const key of PUSH_CREDENTIAL_ENV) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
  });

  test("preserves push credentials while stripping provider keys for mutating runs (WM-128 parity, WM-223)", () => {
    const childEnv = safeChildEnvironment({
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SSH_AGENT_PID: "54321",
      GITHUB_TOKEN: "ghp_mutating_token",
      GH_TOKEN: "ghp_gh_token",
      OPENAI_API_KEY: "sk-secret",
      CUSTOM_MUTATING_VAR: "allowed",
    }, { mutating: true });

    expect(childEnv.CUSTOM_MUTATING_VAR).toBe("allowed");
    expect(childEnv.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(childEnv.SSH_AGENT_PID).toBe("54321");
    expect(childEnv.GITHUB_TOKEN).toBe("ghp_mutating_token");
    expect(childEnv.GH_TOKEN).toBe("ghp_gh_token");
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
  });

  test("inherits push credentials from process.env only when mutating", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/inherited.sock";
    process.env.GITHUB_TOKEN = "ghp_inherited_token";

    const mutatingEnv = safeChildEnvironment({}, { mutating: true });
    expect(mutatingEnv.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
    expect(mutatingEnv.GITHUB_TOKEN).toBe("ghp_inherited_token");

    const readOnlyEnv = safeChildEnvironment({}, { mutating: false });
    expect(readOnlyEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(readOnlyEnv.GITHUB_TOKEN).toBeUndefined();
  });

  // The real call site passes the agent definition itself (execute() → def), so
  // an omitted `mutating` must land on the stripping side, not the inheriting one.
  test("defaults to stripping when no definition, an empty one, or a boolean is passed", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/inherited.sock";

    expect(safeChildEnvironment({}).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, {}).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, { mutating: undefined }).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, false).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, true).SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  test("shares one push-credential list with the claude adapter (no drift)", () => {
    expect(PUSH_CREDENTIAL_ENV).toBe(CLAUDE_PUSH_CREDENTIAL_ENV);
  });
});

describe("execute conformance (OPS-296, docs/event-runtime.md §6)", () => {
  const tmpBase = realpathSync(mkdtempSync(path.join(tmpdir(), "evrt-pi-test-")));
  const stubBinDir = path.join(tmpBase, "bin");
  mkdirSync(stubBinDir, { recursive: true });
  const emptyBinDir = path.join(tmpBase, "empty-bin");
  mkdirSync(emptyBinDir, { recursive: true });

  const stubPiPath = path.join(stubBinDir, "pi");
  const stubScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (process.env.FACTORY_TEST_RECORD_FILE) {
    writeFileSync(
      process.env.FACTORY_TEST_RECORD_FILE,
      JSON.stringify({ cwd: process.cwd(), env: process.env, argv: process.argv, stdin }),
      "utf8",
    );
  }

  const behavior = process.env.FACTORY_TEST_BEHAVIOR || "normal";

  if (behavior === "normal") {
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Working..." }],
        usage: { input: 15, output: 25, cost: { total: 0.001 } },
      },
    }) + "\\n");
    process.exit(0);
  }

  if (behavior === "exit_code") {
    const code = parseInt(process.env.FACTORY_TEST_EXIT_CODE || "1", 10);
    process.exit(code);
  }

  if (behavior === "sleep_sigterm") {
    setInterval(() => {}, 10_000);
  }

  if (behavior === "ignore_sigterm") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 10_000);
  }

  if (behavior === "emit_tool_then_success") {
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }],
        usage: { input: 100, output: 10, cost: { total: 0.0005 } },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "hello world" }] },
      isError: false,
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        usage: { input: 50, output: 5, cost: { total: 0.0002 } },
      },
    }) + "\\n");
    process.exit(0);
  }

  if (behavior === "emit_error_tool_result") {
    // Looks exactly like a permission-denied message, but is not a confirmed
    // pi-authored refusal shape (WM-127 lesson) — must never become policy_denied.
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "touch /etc/nope" } }],
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Permission to use bash has been denied." }] },
      isError: true,
    }) + "\\n");
    process.exit(1);
  }
});
`;
  writeFileSync(stubPiPath, stubScript, { mode: 0o755 });

  const promptFile = path.join(tmpBase, "prompt.md");
  writeFileSync(promptFile, "You are a test agent.", "utf8");

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const ws = () => realpathSync(mkdtempSync(path.join(tmpBase, "ws-")));
  const defaultDef = {
    ref: "test-pi-agent@1",
    promptPath: promptFile,
    mutating: false,
  };
  const defaultSpec = {
    agent: "test-pi-agent@1",
    input: { repos: ["bj29"] },
  };

  test("executes stub binary in workspaceDir, strips API keys, pipes prompt on stdin, captures transcript + trace", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const traceEvents = [];

    const outcome = await execute({
      spec: { ...defaultSpec, model: "openai-codex/gpt-5.6-terra" },
      def: defaultDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        OPENAI_API_KEY: "sk-secret-key-must-be-stripped",
        CUSTOM_VAR: "custom_value",
        FACTORY_TEST_BEHAVIOR: "normal",
        FACTORY_TEST_RECORD_FILE: recordFile,
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });

    expect(outcome).toEqual({ exitCode: 0, timedOut: false, policyDenials: [] });

    // 1. Workspace confinement: cwd is workspaceDir
    expect(existsSync(recordFile)).toBe(true);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.cwd).toBe(workspaceDir);

    // 2. Env security
    expect(record.env.OPENAI_API_KEY).toBeUndefined();
    expect(record.env.CUSTOM_VAR).toBe("custom_value");

    // 3. Prompt on stdin, not argv; argv shape
    expect(record.stdin).toBe(`You are a test agent.${PROMPT_SUFFIX}`);
    expect(record.argv).not.toContain(`You are a test agent.${PROMPT_SUFFIX}`);
    expect(record.argv).toContain("-p");
    expect(record.argv).toContain("--mode");
    expect(record.argv).toContain("json");
    expect(record.argv).toContain("--model");
    expect(record.argv[record.argv.indexOf("--model") + 1]).toBe("openai-codex/gpt-5.6-terra");
    expect(record.argv).toContain("--tools");
    expect(record.argv[record.argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls,write");

    // 4. .transcript.json artifact capture
    const transcriptPath = path.join(workspaceDir, ".transcript.json");
    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, "utf8")).toContain('"type":"message_end"');

    // 5. Live trace mapping: assistant text, then one combined usage event
    expect(traceEvents.some((e) => e.kind === "assistant_text" && e.payload.text === "Working...")).toBe(true);
    const usageEvent = traceEvents.find((e) => e.kind === "usage");
    expect(usageEvent).toBeDefined();
    expect(usageEvent.payload.numTurns).toBe(1);
    expect(usageEvent.payload.costUSD).toBeCloseTo(0.001, 6);
    expect(usageEvent.payload.usage.input).toBe(15);
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

  test("timeout sends SIGTERM and returns timedOut: true", async () => {
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 150,
      killGraceMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "sleep_sigterm",
      },
    });
    expect(outcome.timedOut).toBe(true);
  });

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

  test("abortSignal terminates child process promptly with timedOut: false", async () => {
    const ac = new AbortController();
    const runPromise = execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 10_000,
      killGraceMs: 500,
      abortSignal: ac.signal,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "sleep_sigterm",
      },
    });
    setTimeout(() => ac.abort(), 100);
    const outcome = await runPromise;
    expect(outcome.timedOut).toBe(false);
  });

  test("multiple assistant turns accumulate into one combined usage trace event", async () => {
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

    const usageEvent = traceEvents.find((e) => e.kind === "usage");
    expect(usageEvent.payload.numTurns).toBe(2);
    expect(usageEvent.payload.costUSD).toBeCloseTo(0.0007, 6);
    expect(usageEvent.payload.usage.input).toBe(150);
  });

  test("a tool_execution_end error that reads exactly like a permission denial is never classified as policy_denied (WM-127)", async () => {
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

  test("run with no output at all reports usage as explicit n/a, not a fabricated zero", async () => {
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
    const usageEvent = traceEvents.find((e) => e.kind === "usage");
    expect(usageEvent.payload).toEqual({ durationMs: null, numTurns: null, costUSD: null, usage: {} });
  });

  test("missing pi and npx on PATH is a typed CliNotFoundError, not a spawn crash (OPS-296 AC)", async () => {
    await expect(
      execute({
        spec: defaultSpec,
        def: defaultDef,
        workspaceDir: ws(),
        timeoutMs: 1000,
        env: { PATH: emptyBinDir },
      }),
    ).rejects.toThrow(CliNotFoundError);

    await expect(
      execute({
        spec: defaultSpec,
        def: defaultDef,
        workspaceDir: ws(),
        timeoutMs: 1000,
        env: { PATH: emptyBinDir },
      }),
    ).rejects.toMatchObject({ code: "cli_not_found" });
  });
});

import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-agy-test-mjs";
import { describe, expect, test, afterAll, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "../config.mjs";
import {
  PROMPT_SUFFIX,
  PUSH_CREDENTIAL_ENV as CLAUDE_PUSH_CREDENTIAL_ENV,
} from "./claude.mjs";
import {
  adapterExecuteTimeoutMs,
  DYNAMIC_DEADLINE_ADAPTERS,
  LEASE_GRACE_SECONDS,
} from "../worker.mjs";
import {
  buildAgyArgv,
  CliNotFoundError,
  execute,
  extractUsage,
  KILL_GRACE_MS,
  mapStreamEvent,
  PUSH_CREDENTIAL_ENV,
  resolveAgyCommand,
  safeChildEnvironment,
} from "./agy.mjs";

/**
 * Verbatim `--output-format stream-json` lines captured from agy 1.1.13 while
 * it ran a real tool-using prompt (WM-435). These are the shapes the CLI
 * actually emits; the fixtures they replaced were invented and asserted fields
 * (`step_id`, `agent_response.text`, `tool.output`, `tool.status`) that agy
 * has never produced, which is how the mapper shipped broken.
 */
const CAPTURED = {
  toolActive: {
    conversation_id: "ce4e067d-e0bb-44ad-8958-658194691858",
    step_index: 3,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "list_dir",
    tool_info: { name: "list_dir", parameters: { DirectoryPath: "/tmp/ws" } },
  },
  toolDone: {
    conversation_id: "ce4e067d-e0bb-44ad-8958-658194691858",
    step_index: 3,
    state: "DONE",
    step_type: "tool",
    tool_name: "list_dir",
    duration_seconds: 0.099239,
    tool_info: { name: "list_dir", parameters: { DirectoryPath: "/tmp/ws" } },
  },
  toolError: {
    conversation_id: "ce4e067d-e0bb-44ad-8958-658194691858",
    step_index: 6,
    state: "ERROR",
    step_type: "tool",
    tool_name: "list_dir",
    duration_seconds: 0.057997,
    tool_info: {
      name: "list_dir",
      parameters: { DirectoryPath: "/Users/hdkiller/.gemini/antigravity-cli" },
      error: {
        type: "TOOL_ERROR",
        message:
          "Permission denied for read_file(/Users/hdkiller/.gemini/antigravity-cli). Matches hardcoded system protection boundary rule.",
      },
    },
  },
  agentResponse: {
    conversation_id: "ce4e067d-e0bb-44ad-8958-658194691858",
    step_index: 2,
    state: "DONE",
    step_type: "agent_response",
    duration_seconds: 2.0848,
    usage: {
      input_tokens: 18496,
      output_tokens: 325,
      thinking_tokens: 273,
      cache_read_tokens: 0,
      total_tokens: 18821,
    },
  },
  errorMessage: {
    conversation_id: "ce4e067d-e0bb-44ad-8958-658194691858",
    step_index: 8,
    state: "DONE",
    step_type: "error_message",
  },
  resultError: {
    conversation_id: "ce4e067d-e0bb-44ad-8958-658194691858",
    status: "ERROR",
    response: "",
    error: "timeout waiting for response",
    duration_seconds: 79.744557,
    num_turns: 1,
    usage: {
      input_tokens: 118982,
      output_tokens: 3219,
      thinking_tokens: 2055,
      cache_read_tokens: 488163,
      total_tokens: 122201,
    },
  },
  resultSuccess: {
    conversation_id: "aa11bb22-cc33-dd44-ee55-ff6677889900",
    status: "SUCCESS",
    response: "/tmp/ws\ninput.json\n",
    error: null,
    duration_seconds: 5.5,
    num_turns: 1,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      thinking_tokens: 5,
      cache_read_tokens: 0,
      total_tokens: 120,
    },
  },
};

const step = (stepUpdate) => ({
  event: "step_update",
  step_update: stepUpdate,
});

describe("mapStreamEvent (real agy stream-json shapes)", () => {
  test("tool ACTIVE → tool_use keyed by step_index", () => {
    expect(mapStreamEvent(step(CAPTURED.toolActive))).toEqual([
      {
        kind: "tool_use",
        payload: {
          id: "3",
          name: "list_dir",
          input: { DirectoryPath: "/tmp/ws" },
        },
      },
    ]);
  });

  test("tool DONE → tool_result correlated to its tool_use", () => {
    const [event] = mapStreamEvent(step(CAPTURED.toolDone));
    expect(event.kind).toBe("tool_result");
    // Same step_index as the ACTIVE event above: this is what makes pairing work.
    expect(event.payload.toolUseId).toBe("3");
    expect(event.payload.isError).toBe(false);
    expect(event.payload.durationMs).toBe(99);
    // agy streams no tool output, so content names what it does provide.
    expect(event.payload.content).toContain("list_dir");
  });

  test("tool ERROR → tool_result carrying the error message (WM-435)", () => {
    const [event] = mapStreamEvent(step(CAPTURED.toolError));
    expect(event.kind).toBe("tool_result");
    expect(event.payload.toolUseId).toBe("6");
    expect(event.payload.isError).toBe(true);
    expect(event.payload.content).toContain("Permission denied for read_file");
    expect(event.payload.durationMs).toBe(58);
  });

  test("agent_response carries usage and no text, so it maps to usage", () => {
    const [event] = mapStreamEvent(step(CAPTURED.agentResponse));
    expect(event.kind).toBe("usage");
    expect(event.payload.usage).toEqual({
      input: 18496,
      output: 325,
      thinking: 273,
      cacheRead: 0,
      total: 18821,
    });
    expect(event.payload.durationMs).toBe(2085);
  });

  test("error_message steps surface instead of vanishing", () => {
    expect(mapStreamEvent(step(CAPTURED.errorMessage))).toEqual([
      { kind: "lifecycle", payload: { note: "error_message", stepIndex: "8" } },
    ]);
  });

  test("terminal result reaches the trace with status, error and tokens", () => {
    const events = mapStreamEvent({
      event: "result",
      result: CAPTURED.resultError,
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("usage");
    expect(kinds).toContain("lifecycle");

    const failure = events.find((e) => e.kind === "lifecycle");
    expect(failure.payload).toEqual({
      note: "agent_error",
      status: "ERROR",
      error: "timeout waiting for response",
    });

    const usage = events.find((e) => e.kind === "usage");
    expect(usage.payload.numTurns).toBe(1);
    expect(usage.payload.durationMs).toBe(79745);
    expect(usage.payload.usage.input).toBe(118982);
    expect(usage.payload.usage.cacheRead).toBe(488163);

    // The failed run whose blank trace prompted WM-435 must not be blank now.
    expect(events.length).toBeGreaterThan(0);
  });

  test("successful result emits the final answer as assistant_text", () => {
    const events = mapStreamEvent({
      event: "result",
      result: CAPTURED.resultSuccess,
    });
    const text = events.find((e) => e.kind === "assistant_text");
    expect(text.payload.text).toBe("/tmp/ws\ninput.json");
    // A clean run has nothing to report as a failure.
    expect(events.some((e) => e.kind === "lifecycle")).toBe(false);
  });

  test("unrecognized events are ignored silently", () => {
    expect(mapStreamEvent({ event: "init", conversation_id: "abc" })).toEqual(
      [],
    );
    expect(mapStreamEvent(null)).toEqual([]);
    expect(mapStreamEvent("not an object")).toEqual([]);
    expect(
      mapStreamEvent(
        step({ step_type: "checkpoint", state: "ACTIVE", step_index: 1 }),
      ),
    ).toEqual([]);
  });

  test("very long assistant text is clipped", () => {
    const events = mapStreamEvent({
      event: "result",
      result: { ...CAPTURED.resultSuccess, response: "y".repeat(10_000) },
    });
    const [event] = events;
    expect(event.kind).toBe("assistant_text");
    expect(event.payload.text.length).toBeLessThan(4100);
    expect(event.payload.text.endsWith("…[truncated]")).toBe(true);
  });
});

describe("extractUsage", () => {
  test("extracts tokens, turns, and duration from result event", () => {
    const res = extractUsage({
      event: "result",
      result: {
        status: "SUCCESS",
        duration_seconds: 12.5,
        num_turns: 4,
        usage: {
          input_tokens: 1500,
          output_tokens: 300,
          cache_read_tokens: 500,
        },
      },
    });
    expect(res).toEqual({
      usage: {
        input: 1500,
        output: 300,
        cacheRead: 500,
        turns: 4,
      },
      costUSD: null,
      durationMs: 12500,
      status: "SUCCESS",
      error: null,
    });
  });

  test("returns null when message is not a result event", () => {
    expect(extractUsage({ event: "init" })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });
});

describe("buildAgyArgv", () => {
  test("basic flags and argv prompt format", () => {
    const argv = buildAgyArgv({
      def: { prompt: "agents/agy-smoke.md" },
      prompt: "Execute smoke test",
      workspaceDir: "/tmp/ws",
      timeoutMs: 300000,
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("Execute smoke test");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--add-dir");
    expect(argv).toContain("/tmp/ws");
    expect(argv).toContain("--print-timeout");
    expect(argv[argv.indexOf("--print-timeout") + 1]).toBe("295s");
  });

  test("print-timeout tracks the run budget instead of flooring short runs (WM-439)", () => {
    // agy-smoke's 120s budget used to round down to the 1m floor, so the CLI
    // gave up at 60s while the worker was still waiting — the ~64s failures.
    const argv = buildAgyArgv({
      def: { prompt: "agents/agy-smoke.md" },
      prompt: "Execute smoke test",
      workspaceDir: "/tmp/ws",
      timeoutMs: 120_000,
    });
    const bound = argv[argv.indexOf("--print-timeout") + 1];
    expect(bound).not.toBe("1m");
    expect(bound).toBe("115s");
  });

  test("print-timeout stays positive for a timeout smaller than the grace", () => {
    const argv = buildAgyArgv({
      def: { prompt: "agents/agy-smoke.md" },
      prompt: "Execute smoke test",
      workspaceDir: "/tmp/ws",
      timeoutMs: 2_000,
    });
    expect(argv[argv.indexOf("--print-timeout") + 1]).toBe("1s");
  });

  test("print-timeout under a dynamic-deadline run is bounded by policy, not ~2×10⁶ s (WM-692)", () => {
    // agy is a dynamic-deadline adapter, so the worker's `timeoutMs` — the
    // value that becomes `--print-timeout` out of process — must stay a real
    // backstop for a wedged child rather than a 24.8-day sentinel.
    expect(DYNAMIC_DEADLINE_ADAPTERS.has("agy")).toBe(true);
    const maxRunMinutes = 90;
    const timeoutMs = adapterExecuteTimeoutMs({
      adapterKey: "agy",
      spec: { timeoutSeconds: 1_800 },
      maxRunMinutes,
    });
    const argv = buildAgyArgv({
      prompt: "x",
      def: {},
      model: "default",
      workspaceDir: "/w",
      timeoutMs,
    });
    const printSeconds = Number.parseInt(
      argv[argv.indexOf("--print-timeout") + 1],
      10,
    );
    expect(Number.isFinite(printSeconds)).toBe(true);
    expect(printSeconds).toBeGreaterThanOrEqual(1_800);
    expect(printSeconds).toBeLessThanOrEqual(
      maxRunMinutes * 60 + LEASE_GRACE_SECONDS,
    );
    expect(printSeconds).toBeLessThan(1_000_000);
  });

  test("model and effort parameters", () => {
    const argv = buildAgyArgv({
      def: { prompt: "agents/agy-smoke.md", effort: "high" },
      model: "gemini-3.7-flash",
      workspaceDir: "/tmp/ws",
    });
    expect(argv).toContain("--model");
    expect(argv).toContain("gemini-3.7-flash");
    expect(argv).toContain("--effort");
    expect(argv).toContain("high");
  });

  test("defaults effort to low for light tier and high for strong tier (WM-428)", () => {
    const lightArgv = buildAgyArgv({
      def: { prompt: "agents/agy-smoke.md", model_tier: "light" },
      model: "gemini-3.7-flash",
      workspaceDir: "/tmp/ws",
    });
    expect(lightArgv).toContain("--effort");
    expect(lightArgv[lightArgv.indexOf("--effort") + 1]).toBe("low");

    const strongArgv = buildAgyArgv({
      def: { prompt: "agents/agy-smoke.md", model_tier: "strong" },
      model: "gemini-3.7-flash",
      workspaceDir: "/tmp/ws",
    });
    expect(strongArgv).toContain("--effort");
    expect(strongArgv[strongArgv.indexOf("--effort") + 1]).toBe("high");
  });
});

describe("safeChildEnvironment", () => {
  test("strips API keys and preserves push credentials when mutating", () => {
    const prev = { ...process.env };
    process.env.GEMINI_API_KEY = "secret-gemini";
    process.env.GOOGLE_API_KEY = "secret-google";
    process.env.ANTIGRAVITY_AGENT = "1";
    process.env.ANTIGRAVITY_LS_ADDRESS = "localhost:1234";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-sock";
    process.env.GITHUB_TOKEN = "gh-secret";

    const env = safeChildEnvironment({}, { mutating: true });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.ANTIGRAVITY_AGENT).toBeUndefined();
    expect(env.ANTIGRAVITY_LS_ADDRESS).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-sock");
    expect(env.GITHUB_TOKEN).toBe("gh-secret");

    const readOnlyEnv = safeChildEnvironment({}, { mutating: false });
    expect(readOnlyEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(readOnlyEnv.GITHUB_TOKEN).toBeUndefined();

    process.env = prev;
  });
});

describe("resolveAgyCommand", () => {
  test("resolves agy on PATH", () => {
    const found = resolveAgyCommand({
      which: (cmd) => (cmd === "agy" ? "/usr/local/bin/agy" : null),
    });
    expect(found).toEqual({ command: "agy", args: [] });

    const missing = resolveAgyCommand({ which: () => null });
    expect(missing).toBeNull();
  });
});

describe("execute with fake binary", () => {
  let tmp;
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  /** Fake agy emitting the line shapes captured from the real CLI (WM-435). */
  function writeFakeAgy(binDir, lines) {
    const fakeAgy = path.join(binDir, "agy");
    const body = lines
      .map((l) => `echo ${JSON.stringify(JSON.stringify(l))}`)
      .join("\n");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash\nif [[ -n "\${FACTORY_TEST_ARGV_FILE:-}" ]]; then printf '%s\\n' "$@" > "$FACTORY_TEST_ARGV_FILE"; fi\n${body}\n`,
      { mode: 0o755 },
    );
    return fakeAgy;
  }

  test("refuses a definition without verified promptText before launching agy", async () => {
    tmp = tmpDir("agy-test-");
    const binDir = path.join(tmp, "bin");
    const recordFile = path.join(tmp, "argv.txt");
    mkdirSync(binDir, { recursive: true });
    writeFakeAgy(binDir, []);
    const promptFile = path.join(tmp, "prompt.md");
    writeFileSync(promptFile, "mutable replacement");

    await expect(
      execute({
        spec: {},
        def: { ref: "test-agy@1", promptPath: promptFile },
        workspaceDir: tmp,
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          FACTORY_TEST_ARGV_FILE: recordFile,
        },
      }),
    ).rejects.toThrow(
      "agy: definition test-agy@1 has no verified promptText (registry-loaded definitions only)",
    );
    expect(existsSync(recordFile)).toBe(false);
  });

  test("spawns agy, pipes transcript, records a trace of the real event shapes", async () => {
    tmp = tmpDir("agy-test-");
    const binDir = path.join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeAgy(binDir, [
      { event: "init", conversation_id: "c1" },
      { event: "step_update", step_update: CAPTURED.toolActive },
      { event: "step_update", step_update: CAPTURED.toolDone },
      {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Listed the workspace.",
          duration_seconds: 1,
          num_turns: 2,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
    ]);

    const promptFile = path.join(tmp, "prompt.md");
    writeFileSync(promptFile, "mutable replacement");
    const argvFile = path.join(tmp, "argv.txt");

    const traces = [];
    const res = await execute({
      spec: { model: "gemini-3.7-flash" },
      def: { promptPath: promptFile, promptText: "Do task" },
      workspaceDir: tmp,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        FACTORY_TEST_ARGV_FILE: argvFile,
      },
      onTrace: (kind, payload) => traces.push({ kind, payload }),
    });

    expect(res.exitCode).toBe(0);
    expect(traces.map((t) => t.kind)).toEqual([
      "tool_use",
      "tool_result",
      "assistant_text",
      "usage",
    ]);
    // The tool call and its result correlate by step_index.
    expect(traces[0].payload.id).toBe("3");
    expect(traces[1].payload.toolUseId).toBe("3");
    expect(traces[2].payload.text).toBe("Listed the workspace.");
    expect(res.usage).toEqual({ input: 10, output: 20, turns: 2 });
    expect(readFileSync(argvFile, "utf8")).toContain(`Do task${PROMPT_SUFFIX}`);
    expect(readFileSync(argvFile, "utf8")).not.toContain("mutable replacement");
    expect(existsSync(path.join(tmp, ".transcript.json"))).toBe(true);
  });

  test("a failed run still produces a trace carrying the error (WM-435)", async () => {
    tmp = tmpDir("agy-test-");
    const binDir = path.join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    // The exact shape of the 2026-08-16 agy-smoke failures: init, then a
    // terminal error result. It used to yield zero trace rows.
    writeFakeAgy(binDir, [
      { event: "init", conversation_id: "c1" },
      {
        event: "result",
        result: {
          status: "ERROR",
          response: "",
          error: "timeout waiting for response",
          duration_seconds: 0,
          num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]);

    const promptFile = path.join(tmp, "prompt.md");
    writeFileSync(promptFile, "Do task");

    const traces = [];
    await execute({
      spec: {},
      def: { promptPath: promptFile, promptText: "Do task" },
      workspaceDir: tmp,
      env: { PATH: `${binDir}:${process.env.PATH}` },
      onTrace: (kind, payload) => traces.push({ kind, payload }),
    });

    expect(traces.length).toBeGreaterThan(0);
    const failure = traces.find((t) => t.payload?.note === "agent_error");
    expect(failure.payload.error).toBe("timeout waiting for response");
  });

  test("a throwing onTrace observer cannot strand execution (cf. WM-305)", async () => {
    tmp = tmpDir("agy-test-");
    const binDir = path.join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeAgy(binDir, [
      { event: "step_update", step_update: CAPTURED.toolActive },
      {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done",
          duration_seconds: 1,
          num_turns: 1,
          usage: {},
        },
      },
    ]);

    const promptFile = path.join(tmp, "prompt.md");
    writeFileSync(promptFile, "Do task");

    const attempted = [];
    const res = await execute({
      spec: {},
      def: { promptPath: promptFile, promptText: "Do task" },
      workspaceDir: tmp,
      env: { PATH: `${binDir}:${process.env.PATH}` },
      onTrace: (kind) => {
        attempted.push(kind);
        throw new Error("observer exploded");
      },
    });

    expect(res.exitCode).toBe(0);
    // Each event is guarded on its own: throwing on the tool_use must not
    // swallow the terminal result's events too.
    expect(attempted).toEqual(["tool_use", "assistant_text", "usage"]);
  });
});

describe("FACTORY_ROOT injection (WM-433 parity with pi)", () => {
  test("injects the stable Factory runtime path and refuses caller overrides", () => {
    expect(safeChildEnvironment({}).FACTORY_ROOT).toBe(FACTORY_ROOT);
    expect(
      safeChildEnvironment({ FACTORY_ROOT: "/tmp/untrusted-target" })
        .FACTORY_ROOT,
    ).toBe(FACTORY_ROOT);
  });
});

import { describe, expect, test, afterAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV as CLAUDE_PUSH_CREDENTIAL_ENV } from "./claude.mjs";
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

describe("mapStreamEvent (agy stream-json shapes)", () => {
  test("agent_response step_update → assistant_text", () => {
    const events = mapStreamEvent({
      event: "step_update",
      step_update: { step_type: "agent_response", state: "ACTIVE", text: "Checking the PR now." },
    });
    expect(events).toEqual([{ kind: "assistant_text", payload: { text: "Checking the PR now." } }]);
  });

  test("tool ACTIVE step_update → tool_use", () => {
    const events = mapStreamEvent({
      event: "step_update",
      step_update: {
        step_id: "step_123",
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "bun test" } },
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_use",
        payload: { id: "step_123", name: "run_command", input: { CommandLine: "bun test" } },
      },
    ]);
  });

  test("tool DONE step_update → tool_result", () => {
    const ok = mapStreamEvent({
      event: "step_update",
      step_update: {
        step_id: "step_123",
        step_type: "tool",
        state: "DONE",
        tool_name: "run_command",
        output: "Tests passed\n",
        status: "SUCCESS",
      },
    });
    expect(ok).toEqual([
      {
        kind: "tool_result",
        payload: { toolUseId: "step_123", content: "Tests passed\n", isError: false },
      },
    ]);

    const err = mapStreamEvent({
      event: "step_update",
      step_update: {
        step_id: "step_456",
        step_type: "tool",
        state: "DONE",
        tool_name: "run_command",
        output: "Failed to run\n",
        status: "ERROR",
      },
    });
    expect(err).toEqual([
      {
        kind: "tool_result",
        payload: { toolUseId: "step_456", content: "Failed to run\n", isError: true },
      },
    ]);
  });

  test("unrecognized events are ignored silently", () => {
    expect(mapStreamEvent({ event: "init", conversation_id: "abc" })).toEqual([]);
    expect(mapStreamEvent(null)).toEqual([]);
    expect(mapStreamEvent("not an object")).toEqual([]);
  });

  test("very long assistant text is clipped", () => {
    const [event] = mapStreamEvent({
      event: "step_update",
      step_update: { step_type: "agent_response", state: "ACTIVE", text: "y".repeat(10_000) },
    });
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
  test("basic flags and stdin prompt format", () => {
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
    expect(argv).toContain("3m");
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
    const found = resolveAgyCommand({ which: (cmd) => (cmd === "agy" ? "/usr/local/bin/agy" : null) });
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

  test("spawns agy, feeds stdin prompt, pipes transcript, records trace", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "agy-test-"));
    const binDir = path.join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgy = path.join(binDir, "agy");
    const script = `#!/usr/bin/env bash
echo '{"event":"init","conversation_id":"c1"}'
echo '{"event":"step_update","step_update":{"step_id":"s1","step_type":"agent_response","text":"Hello world"}}'
echo '{"event":"result","result":{"status":"SUCCESS","duration_seconds":1,"usage":{"input_tokens":10,"output_tokens":20}}}'
`;
    writeFileSync(fakeAgy, script, { mode: 0o755 });

    const promptFile = path.join(tmp, "prompt.md");
    writeFileSync(promptFile, "Do task");

    const traces = [];
    const res = await execute({
      spec: { model: "gemini-3.7-flash" },
      def: { promptPath: promptFile },
      workspaceDir: tmp,
      env: { PATH: `${binDir}:${process.env.PATH}` },
      onTrace: (kind, payload) => traces.push({ kind, payload }),
    });

    expect(res.exitCode).toBe(0);
    expect(traces).toEqual([
      { kind: "assistant_text", payload: { text: "Hello world" } },
    ]);
    expect(res.usage).toEqual({ input: 10, output: 20 });
    expect(existsSync(path.join(tmp, ".transcript.json"))).toBe(true);
  });
});

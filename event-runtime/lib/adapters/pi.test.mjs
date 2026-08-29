import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-pi-test-mjs";
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
  buildPiArgv,
  CliNotFoundError,
  execute,
  extractUsage,
  isHarnessDenial,
  KILL_GRACE_MS,
  mapStreamEvent,
  PUSH_CREDENTIAL_ENV,
  MUTATING_TOOLS,
  piExtensions,
  piTools,
  READ_ONLY_TOOLS,
  resolvePiCommand,
  safeChildEnvironment,
  SANDBOX_PROMPT_FILE,
} from "./pi.mjs";
import { preflight, SandboxUnavailableError } from "../sandbox/gondolin.mjs";
import { SANDBOX_CONSOLE_FILE } from "./sandboxed.mjs";
import {
  processOwnerWatchdogSource,
  registerTestProcessCleanup,
  trackProcessGroupForPid,
} from "../test-helpers-process.mjs";

registerTestProcessCleanup(import.meta.url);

describe("isHarnessDenial (WM-127, no confirmed pi refusal shapes yet)", () => {
  test("nothing matches — pi enforces read-only by tool non-exposure, not runtime denial", () => {
    // These look exactly like the strings that WOULD match claude's patterns,
    // and like plausible OS/tool errors. None are a confirmed pi-authored
    // refusal shape, so all must stay unclassified.
    expect(isHarnessDenial("Permission to use bash has been denied.")).toBe(
      false,
    );
    expect(
      isHarnessDenial(
        "pi requested permission to use write, but you haven't granted it yet.",
      ),
    ).toBe(false);
    expect(
      isHarnessDenial("EACCES: permission denied, open '/var/log/system.log'"),
    ).toBe(false);
    expect(isHarnessDenial("bash: /etc/hosts: Permission denied")).toBe(false);
    expect(isHarnessDenial(null)).toBe(false);
    expect(isHarnessDenial(undefined)).toBe(false);
  });
});

describe("mapStreamEvent (real `pi --mode json` shapes, investigated live)", () => {
  test("assistant message_end text block → assistant_text", () => {
    const events = mapStreamEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Files: `a.txt`." }],
      },
    });
    expect(events).toEqual([
      { kind: "assistant_text", payload: { text: "Files: `a.txt`." } },
    ]);
  });

  test("assistant message_end toolCall block → tool_use; mixed blocks map in order", () => {
    const events = mapStreamEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          {
            type: "toolCall",
            id: "call_1|fc_1",
            name: "read",
            arguments: { path: "a.txt" },
          },
        ],
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_use",
        payload: { id: "call_1|fc_1", name: "read", input: { path: "a.txt" } },
      },
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
    expect(ok).toEqual([
      {
        kind: "tool_result",
        payload: { content: "hello world\n", toolUseId: "call_1|fc_1" },
      },
    ]);

    const err = mapStreamEvent({
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "bash",
      result: {
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
      isError: true,
    });
    expect(err).toEqual([
      {
        kind: "tool_result",
        payload: {
          content: "line 1\nline 2",
          toolUseId: "call_2",
          isError: true,
        },
      },
    ]);
  });

  test("unrecognized message types are ignored silently", () => {
    expect(mapStreamEvent({ type: "session", version: 3 })).toEqual([]);
    expect(mapStreamEvent({ type: "agent_start" })).toEqual([]);
    expect(mapStreamEvent({ type: "turn_start" })).toEqual([]);
    expect(
      mapStreamEvent({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([]);
    expect(
      mapStreamEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      }),
    ).toEqual([]);
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(10_000) }],
      },
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
        usage: {
          input: 983,
          output: 16,
          cacheRead: 2560,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 3559,
          cost: { total: 0.000267 },
        },
      },
    });
    expect(usage).toEqual({
      usage: {
        input: 983,
        output: 16,
        cacheRead: 2560,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 3559,
      },
      costUSD: 0.000267,
    });
  });

  test("non-assistant, missing usage, or non-message_end → null", () => {
    expect(
      extractUsage({
        type: "message_end",
        message: { role: "user", usage: { input: 1 } },
      }),
    ).toBeNull();
    expect(
      extractUsage({ type: "message_end", message: { role: "assistant" } }),
    ).toBeNull();
    expect(extractUsage({ type: "message_update" })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });
});

describe("buildPiArgv", () => {
  test("prompt travels on stdin, not argv — base argv is -p --mode json plus the allowlist", () => {
    expect(buildPiArgv({ def: { mutating: true }, model: null })).toEqual([
      "-p",
      "--mode",
      "json",
      "--tools",
      MUTATING_TOOLS.join(","),
    ]);
  });

  test("mutating: false → pi's own read-only pattern plus the codex names, not -r", () => {
    const argv = buildPiArgv({ def: { mutating: false }, model: null });
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe(READ_ONLY_TOOLS.join(","));
    expect(argv).toEqual([
      "-p",
      "--mode",
      "json",
      "--tools",
      "read,grep,find,ls,write,bash,exec_command,apply_patch",
    ]);
  });

  test("mutating: true → an explicit allowlist, never pi's implicit defaults (WM-336)", () => {
    // The regression this guards: omitting --tools handed mutating agents every
    // tool pi ships, so the surface widened whenever pi did. dispatch@1 — which
    // also holds push credentials — was the least constrained agent in the fleet.
    const argv = buildPiArgv({ def: { mutating: true }, model: null });
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe(
      "read,grep,find,ls,write,bash,edit,subagent,exec_command,apply_patch",
    );
  });

  // WM-665: tool names are per PROVIDER, not per pi version. On openai-codex
  // models — what every pi.* tier in config/policy.yaml resolves to — there is
  // no read/write/bash; the shell is exec_command and file writing is
  // apply_patch. pi drops an unrecognized name silently, so an allowlist
  // carrying only the other family left agents with grep/find/ls and no way to
  // write ./result.json, failing contract_violation: missing_result after
  // exit 0. Both mutability classes must carry a shell and a writer.
  test("both mutability classes expose a shell and a file writer on codex models (WM-665)", () => {
    for (const mutating of [false, true]) {
      const tools = piTools({ mutating });
      expect(tools).toContain("exec_command");
      expect(tools).toContain("apply_patch");
    }
  });

  test("mutating: true keeps edit and subagent — the tools that make it a dispatch agent", () => {
    const tools = piTools({ mutating: true });
    expect(tools).toContain("edit");
    // dispatch delegates focused work, notably the UX critique (WM-335).
    expect(tools).toContain("subagent");
  });

  test("undeclared tools are never passed, however plausible", () => {
    const tools = piTools({ mutating: true });
    for (const absent of [
      "web_search",
      "fetch_content",
      "interactive_shell",
      "chrome_devtools_load",
    ]) {
      expect(tools).not.toContain(absent);
    }
  });

  test("a definition may declare extra tools; they are additive and deduplicated", () => {
    const tools = piTools({
      mutating: false,
      tools: ["chrome_devtools_load", "read"],
    });
    expect(tools).toContain("chrome_devtools_load");
    for (const base of READ_ONLY_TOOLS) expect(tools).toContain(base);
    // "read" was already in the base set — declaring it again must not duplicate
    // it, or the argv (and the transcript) stops being deterministic.
    expect(tools.filter((t) => t === "read")).toHaveLength(1);
  });

  test("a missing or malformed tools field falls back to the base set rather than throwing", () => {
    expect(piTools({ mutating: false })).toEqual(READ_ONLY_TOOLS);
    expect(piTools({ mutating: false, tools: "read" })).toEqual(
      READ_ONLY_TOOLS,
    );
    expect(piTools(undefined)).toEqual(MUTATING_TOOLS);
  });

  test("declared extensions are loaded per run with repeatable -e flags (WM-335)", () => {
    const argv = buildPiArgv({
      def: {
        mutating: false,
        extensions: [
          "npm:@narumitw/pi-chrome-devtools",
          "./local-extension.ts",
        ],
      },
      model: null,
    });
    expect(argv).toEqual([
      "-p",
      "--mode",
      "json",
      "-e",
      "npm:@narumitw/pi-chrome-devtools",
      "-e",
      "./local-extension.ts",
      "--tools",
      READ_ONLY_TOOLS.join(","),
    ]);
  });

  test("extensions are scoped to definitions that declare them and deduplicated", () => {
    expect(piExtensions(undefined)).toEqual([]);
    expect(piExtensions({})).toEqual([]);
    expect(
      piExtensions({ extensions: "npm:@narumitw/pi-chrome-devtools" }),
    ).toEqual([]);
    expect(
      piExtensions({ extensions: ["", "  ", "npm:a", "npm:a", "npm:b"] }),
    ).toEqual(["npm:a", "npm:b"]);
    expect(
      buildPiArgv({ def: { mutating: false }, model: null }),
    ).not.toContain("-e");
  });

  test("planner-pinned model → --model verbatim; default sentinel, null, or absent → no flag (WM-135)", () => {
    const withModel = buildPiArgv({
      def: { mutating: false },
      model: "openai-codex/gpt-5.6-terra",
    });
    const i = withModel.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(withModel[i + 1]).toBe("openai-codex/gpt-5.6-terra");

    const unpinned = buildPiArgv({
      def: { mutating: false },
      model: undefined,
    });
    expect(buildPiArgv({ def: { mutating: false }, model: "default" })).toEqual(
      unpinned,
    );
    expect(buildPiArgv({ def: { mutating: false }, model: null })).toEqual(
      unpinned,
    );
    expect(buildPiArgv({ def: { mutating: false }, model: "" })).toEqual(
      unpinned,
    );
  });
});

describe("resolvePiCommand", () => {
  test("pi on PATH → run it directly", () => {
    const which = (name) => (name === "pi" ? "/usr/local/bin/pi" : null);
    expect(resolvePiCommand({ which })).toEqual({ command: "pi", args: [] });
  });

  test("pi missing, npx present → npx pi fallback", () => {
    const which = (name) => (name === "npx" ? "/usr/local/bin/npx" : null);
    expect(resolvePiCommand({ which })).toEqual({
      command: "npx",
      args: ["pi"],
    });
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
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_API_KEY",
      "MISTRAL_API_KEY",
      "DEEPSEEK_API_KEY",
      "GROQ_API_KEY",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.CUSTOM_VAR).toBe("kept");
  });

  // Mirrors claude.test.mjs's "safeChildEnvironment (WM-128)" block: the pi
  // adapter had no mutating/non-mutating distinction at all until WM-223, so a
  // pi-routed dispatch run reached the push step with no credentials.
  test("strips push credentials for non-mutating runs (WM-128 parity, WM-223)", () => {
    const childEnv = safeChildEnvironment(
      {
        SSH_AUTH_SOCK: "/tmp/test.sock",
        SSH_AGENT_PID: "12345",
        GITHUB_TOKEN: "ghp_secret_token",
        GH_TOKEN: "ghp_other_token",
        OPENAI_API_KEY: "sk-secret",
        CUSTOM_INSPECT_VAR: "allowed",
      },
      { mutating: false },
    );

    expect(childEnv.CUSTOM_INSPECT_VAR).toBe("allowed");
    for (const key of PUSH_CREDENTIAL_ENV) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
  });

  test("preserves push credentials while stripping provider keys for mutating runs (WM-128 parity, WM-223)", () => {
    const childEnv = safeChildEnvironment(
      {
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        SSH_AGENT_PID: "54321",
        GITHUB_TOKEN: "ghp_mutating_token",
        GH_TOKEN: "ghp_gh_token",
        OPENAI_API_KEY: "sk-secret",
        CUSTOM_MUTATING_VAR: "allowed",
      },
      { mutating: true },
    );

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
    expect(
      safeChildEnvironment({}, { mutating: undefined }).SSH_AUTH_SOCK,
    ).toBeUndefined();
    expect(safeChildEnvironment({}, false).SSH_AUTH_SOCK).toBeUndefined();
    expect(safeChildEnvironment({}, true).SSH_AUTH_SOCK).toBe(
      "/tmp/inherited.sock",
    );
  });

  test("injects the stable Factory runtime path and refuses caller overrides (WM-433)", () => {
    expect(safeChildEnvironment({}).FACTORY_ROOT).toBe(FACTORY_ROOT);
    expect(
      safeChildEnvironment({ FACTORY_ROOT: "/tmp/untrusted-target" })
        .FACTORY_ROOT,
    ).toBe(FACTORY_ROOT);
  });

  test("shares one push-credential list with the claude adapter (no drift)", () => {
    expect(PUSH_CREDENTIAL_ENV).toBe(CLAUDE_PUSH_CREDENTIAL_ENV);
  });
});

describe("execute conformance (OPS-296, docs/event-runtime.md §6)", () => {
  const tmpBase = realpathSync(tmpDir("evrt-pi-test-"));
  const stubBinDir = path.join(tmpBase, "bin");
  mkdirSync(stubBinDir, { recursive: true });
  const emptyBinDir = path.join(tmpBase, "empty-bin");
  mkdirSync(emptyBinDir, { recursive: true });

  const stubPiPath = path.join(stubBinDir, "pi");
  const stubScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

${processOwnerWatchdogSource()}

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

  const ws = () => realpathSync(tmpDir("ws-", tmpBase));
  const defaultDef = {
    ref: "test-pi-agent@1",
    promptPath: promptFile,
    promptText: "You are a test agent.",
    mutating: false,
  };
  const defaultSpec = {
    agent: "test-pi-agent@1",
    input: { repos: ["bj29"] },
  };
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
      // The process exited between the existence check and cleanup.
    }
  }

  test("refuses a definition without verified promptText before launching pi", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const { promptText, ...unverifiedDef } = defaultDef;

    await expect(
      execute({
        spec: defaultSpec,
        def: unverifiedDef,
        workspaceDir,
        timeoutMs: 5000,
        env: {
          PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
          FACTORY_TEST_BEHAVIOR: "normal",
          FACTORY_TEST_RECORD_FILE: recordFile,
        },
      }),
    ).rejects.toThrow(
      "pi: definition test-pi-agent@1 has no verified promptText (registry-loaded definitions only)",
    );
    expect(existsSync(recordFile)).toBe(false);
  });

  test("executes the verified prompt snapshot after its path changes, strips API keys, and captures trace", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const replacedPrompt = path.join(workspaceDir, "replaced-prompt.md");
    writeFileSync(replacedPrompt, "mutable replacement", "utf8");
    const traceEvents = [];

    const outcome = await execute({
      spec: { ...defaultSpec, model: "openai-codex/gpt-5.6-terra" },
      def: { ...defaultDef, promptPath: replacedPrompt },
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

    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
      usage: {
        model: "openai-codex/gpt-5.6-terra",
        inputTokens: 15,
        outputTokens: 25,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUSD: 0.001,
      },
    });

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
    expect(record.argv[record.argv.indexOf("--model") + 1]).toBe(
      "openai-codex/gpt-5.6-terra",
    );
    expect(record.argv).toContain("--tools");
    expect(record.argv[record.argv.indexOf("--tools") + 1]).toBe(
      "read,grep,find,ls,write,bash,exec_command,apply_patch",
    );

    // 4. .transcript.json artifact capture
    const transcriptPath = path.join(workspaceDir, ".transcript.json");
    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, "utf8")).toContain(
      '"type":"message_end"',
    );

    // 5. Live trace mapping: assistant text, then one combined usage event
    expect(
      traceEvents.some(
        (e) => e.kind === "assistant_text" && e.payload.text === "Working...",
      ),
    ).toBe(true);
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

  testProcessGroup(
    "timeout kills a real long-lived grandchild (WM-263)",
    async () => {
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
    },
    { timeout: 12_000 },
  );

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

  testProcessGroup(
    "abort kills a real long-lived grandchild (WM-263)",
    async () => {
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
    },
  );

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
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.policyDenials).toEqual([]);
    expect(
      traceEvents.some(
        (e) => e.kind === "tool_use" && e.payload.name === "read",
      ),
    ).toBe(true);
    expect(
      traceEvents.some(
        (e) => e.kind === "tool_result" && e.payload.content === "hello world",
      ),
    ).toBe(true);

    const usageEvent = traceEvents.find((e) => e.kind === "usage");
    expect(usageEvent.payload.numTurns).toBe(2);
    expect(usageEvent.payload.costUSD).toBeCloseTo(0.0007, 6);
    expect(usageEvent.payload.usage.input).toBe(150);
  });

  test("delivers normalized usage to onUsage callback and returns usage in outcome (WM-260)", async () => {
    let receivedUsage = null;
    const outcome = await execute({
      spec: { ...defaultSpec, model: "openai-codex/gpt-5.6-terra" },
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_tool_then_success",
      },
      onUsage: (usage) => {
        receivedUsage = usage;
      },
    });

    const expectedUsage = {
      model: "openai-codex/gpt-5.6-terra",
      inputTokens: 150,
      outputTokens: 15,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUSD: 0.0007,
    };

    expect(receivedUsage).toEqual(expectedUsage);
    expect(outcome.usage).toEqual(expectedUsage);
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
    expect(
      traceEvents.some(
        (e) => e.kind === "lifecycle" && e.payload.note === "policy_denial",
      ),
    ).toBe(false);
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
    expect(usageEvent.payload).toEqual({
      durationMs: null,
      numTurns: null,
      costUSD: null,
      usage: {},
    });
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

/**
 * Sandboxed execution (WM-313). The VM boundary is stubbed at `runSandbox`
 * for the contract tests — the same seam lib/adapters/sandboxed.test.mjs
 * exercises — and a gated real-VM block at the end proves the mechanism with
 * an actual guest, skipping (not failing) where `preflight()` says no.
 */
describe("sandboxed execution (WM-313)", () => {
  const tmpBase = realpathSync(tmpDir("evrt-pi-sandbox-"));
  afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));
  const ws = () => realpathSync(tmpDir("ws-", tmpBase));
  const promptFile = path.join(tmpBase, "prompt.md");
  writeFileSync(promptFile, "You are a sandboxed test agent.", "utf8");

  const sandboxDef = (extra = {}) => ({
    ref: "sandboxed-pi@1",
    promptPath: promptFile,
    promptText: "You are a sandboxed test agent.",
    mutating: false,
    sandbox: {
      provider: "gondolin",
      allowedHosts: ["api.openai.com"],
      secrets: {
        OPENAI_API_KEY: {
          hosts: ["api.openai.com"],
          env: "FACTORY_TEST_FAKE_OPENAI_KEY",
        },
      },
    },
    ...extra,
  });
  const spec = {
    agent: "sandboxed-pi@1",
    input: { repos: ["bj29"] },
    model: "openai/gpt-5.6-terra",
  };

  /** A stand-in for the VM: records the request, "runs" a scripted guest. */
  function fakeVm({
    stdoutLines = [],
    exitCode = 0,
    timedOut = false,
    writeResult = true,
    bootMs = 42,
  } = {}) {
    const calls = [];
    const runSandbox = async (request) => {
      calls.push(request);
      for (const line of stdoutLines)
        request.onStdout(`${JSON.stringify(line)}\n`);
      request.onStderr?.("guest stderr line\n");
      if (writeResult) {
        // The guest writes ./result.json under its cwd, which is the host
        // workspace through the mount — the stub writes to the same place.
        writeFileSync(
          path.join(request.workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {},
            evidence: {},
          }),
        );
      }
      return { exitCode, timedOut, bootMs };
    };
    return { calls, runSandbox };
  }

  test("runs pi inside the VM: guest binary, prompt via workspace file, built guest env, no host CLI needed", async () => {
    const workspaceDir = ws();
    const vm = fakeVm({
      stdoutLines: [
        { type: "session", id: "sess-1", cwd: "/workspace" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            model: "gpt-5.6-terra",
            content: [{ type: "text", text: "Working in the VM..." }],
            usage: { input: 15, output: 25, cost: { total: 0.001 } },
          },
        },
      ],
    });
    const traceEvents = [];

    const outcome = await execute({
      spec,
      def: sandboxDef(),
      workspaceDir,
      timeoutMs: 5000,
      // Everything a served worker would hand over — none of it may reach the guest.
      env: {
        PATH: "/nonexistent",
        OPENAI_API_KEY: "sk-fake-host-key-must-not-cross",
        GITHUB_TOKEN: "ghp-fake",
        CUSTOM_VAR: "host-only",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
      runSandbox: vm.runSandbox,
    });

    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
      usage: {
        model: "gpt-5.6-terra",
        inputTokens: 15,
        outputTokens: 25,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUSD: 0.001,
      },
    });

    expect(vm.calls).toHaveLength(1);
    const req = vm.calls[0];
    // 1. The policy is the definition's, verbatim — placeholders are the runner's job.
    expect(req.policy).toEqual(sandboxDef().sandbox);
    expect(req.workspaceDir).toBe(workspaceDir);
    expect(req.timeoutMs).toBe(5000);

    // 2. argv: guest binary (not a host lookup), stdin redirected from the workspace prompt file.
    expect(req.command.slice(0, 3)).toEqual([
      "/bin/sh",
      "-c",
      `exec "$0" "$@" < ./${SANDBOX_PROMPT_FILE}`,
    ]);
    expect(req.command[3]).toBe("/usr/local/bin/pi");
    const piArgs = req.command.slice(4);
    expect(piArgs.slice(0, 3)).toEqual(["-p", "--mode", "json"]);
    expect(piArgs[piArgs.indexOf("--model") + 1]).toBe("openai/gpt-5.6-terra");
    expect(piArgs[piArgs.indexOf("--tools") + 1]).toBe(
      "read,grep,find,ls,write,bash,exec_command,apply_patch",
    );
    expect(
      readFileSync(path.join(workspaceDir, SANDBOX_PROMPT_FILE), "utf8"),
    ).toBe(`You are a sandboxed test agent.${PROMPT_SUFFIX}`);

    // 3. Guest env is built, not inherited: no host key, no push token, no
    //    caller var, no host HOME/PATH; PI_OFFLINE keeps update traffic off
    //    the deny-all proxy.
    expect(req.env.OPENAI_API_KEY).toBeUndefined();
    expect(req.env.GITHUB_TOKEN).toBeUndefined();
    expect(req.env.CUSTOM_VAR).toBeUndefined();
    expect(req.env.HOME).toBe("/root");
    expect(req.env.PATH).toContain("/usr/local/bin");
    expect(req.env.PI_OFFLINE).toBe("1");
    expect(JSON.stringify(req)).not.toContain(
      "sk-fake-host-key-must-not-cross",
    );

    // 4. Same downstream contract as the host path: transcript, trace, usage, result.json where the verifier looks.
    expect(
      readFileSync(path.join(workspaceDir, ".transcript.json"), "utf8"),
    ).toContain('"type":"message_end"');
    expect(
      traceEvents.some(
        (e) =>
          e.kind === "assistant_text" &&
          e.payload.text === "Working in the VM...",
      ),
    ).toBe(true);
    expect(traceEvents.find((e) => e.kind === "usage").payload.numTurns).toBe(
      1,
    );
    expect(
      JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"))
        .terminalState,
    ).toBe("completed");

    // 5. Guest console is an artifact and a trace event.
    expect(
      readFileSync(path.join(workspaceDir, SANDBOX_CONSOLE_FILE), "utf8"),
    ).toContain("guest stderr line");
    expect(
      traceEvents.find(
        (e) => e.kind === "lifecycle" && e.payload.note === "sandbox_console",
      ).payload,
    ).toMatchObject({ adapter: "pi", exitCode: 0, bootMs: 42 });
  });

  test("a per-definition guest binary override is honoured; a relative one is refused before the VM", async () => {
    const vm = fakeVm();
    await execute({
      spec,
      def: sandboxDef({
        sandbox: {
          ...sandboxDef().sandbox,
          guestBinaries: { pi: "/opt/tools/pi" },
        },
      }),
      workspaceDir: ws(),
      timeoutMs: 1000,
      runSandbox: vm.runSandbox,
    });
    expect(vm.calls[0].command[3]).toBe("/opt/tools/pi");

    const vm2 = fakeVm();
    await expect(
      execute({
        spec,
        def: sandboxDef({
          sandbox: { ...sandboxDef().sandbox, guestBinaries: { pi: "pi" } },
        }),
        workspaceDir: ws(),
        timeoutMs: 1000,
        runSandbox: vm2.runSandbox,
      }),
    ).rejects.toThrow(/absolute guest path/);
    expect(vm2.calls).toHaveLength(0);
  });

  test("a sandboxed definition never resolves or spawns a host pi, even when none is on PATH", async () => {
    // Host path with this env throws CliNotFoundError; the sandboxed path must not even look.
    const vm = fakeVm();
    const outcome = await execute({
      spec,
      def: sandboxDef(),
      workspaceDir: ws(),
      timeoutMs: 1000,
      env: { PATH: tmpBase },
      runSandbox: vm.runSandbox,
    });
    expect(outcome.exitCode).toBe(0);
    expect(vm.calls).toHaveLength(1);
  });

  test("a prior native session is not forked into the guest (sessions are per-VM); the run notes it", async () => {
    const vm = fakeVm();
    const trace = [];
    await execute({
      spec,
      def: sandboxDef(),
      workspaceDir: ws(),
      timeoutMs: 1000,
      resume: { sessionId: "sess-prior" },
      runSandbox: vm.runSandbox,
      onTrace: (k, p) => trace.push({ k, p }),
    });
    expect(vm.calls[0].command).not.toContain("--fork");
    expect(
      trace.some(
        (t) => t.k === "lifecycle" && t.p.note === "sandbox_resume_unavailable",
      ),
    ).toBe(true);
  });

  test("nonzero guest exit propagates like a host exit; denials are surfaced only then", async () => {
    const vm = fakeVm({ exitCode: 3, writeResult: false });
    const outcome = await execute({
      spec,
      def: sandboxDef(),
      workspaceDir: ws(),
      timeoutMs: 1000,
      runSandbox: vm.runSandbox,
    });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.timedOut).toBe(false);
  });

  test("timeout: identical outcome shape to the host path, and a result.json the guest managed to write survives", async () => {
    // Host reference: the stub ignores SIGTERM and gets killed → { exitCode: null, timedOut: true }.
    const vm = fakeVm({ exitCode: null, timedOut: true, writeResult: true });
    const workspaceDir = ws();
    const outcome = await execute({
      spec,
      def: sandboxDef(),
      workspaceDir,
      timeoutMs: 100,
      runSandbox: vm.runSandbox,
    });
    expect(outcome.exitCode).toBeNull();
    expect(outcome.timedOut).toBe(true);
    // The worker's late-completion preflight (verifyResult on TIMED_OUT) reads
    // this file from the same workspace — the file the guest wrote.
    expect(existsSync(path.join(workspaceDir, "result.json"))).toBe(true);
    expect(existsSync(path.join(workspaceDir, ".transcript.json"))).toBe(true);
  });

  test("cancel: identical outcome shape to the host path — null exit, timedOut false", async () => {
    const ac = new AbortController();
    const runSandbox = ({ abortSignal }) =>
      new Promise((_, reject) => {
        // What the real runner does on SIGTERM: dies without an exit event,
        // which gondolin.mjs reports as sandbox_runner_crashed.
        abortSignal.addEventListener("abort", () =>
          reject(
            Object.assign(
              new Error(
                "runner exited (null) without reporting a guest exit code",
              ),
              { code: "sandbox_runner_crashed" },
            ),
          ),
        );
      });
    const pending = execute({
      spec,
      def: sandboxDef(),
      workspaceDir: ws(),
      timeoutMs: 60_000,
      abortSignal: ac.signal,
      runSandbox,
    });
    setTimeout(() => ac.abort(), 10);
    const outcome = await pending;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.timedOut).toBe(false);
  });

  test("a host that cannot honour the policy fails typed — never falls back to a host pi", async () => {
    // Real runInSandbox with a preflight-failing host env: no qemu → SandboxUnavailableError.
    // Injecting nothing here would hit this machine's real preflight, which may pass; force the failure instead.
    const outcome = execute({
      spec,
      def: sandboxDef(),
      workspaceDir: ws(),
      timeoutMs: 1000,
      env: { PATH: `${tmpBase}` },
      runSandbox: async () => {
        throw new SandboxUnavailableError("qemu-system-aarch64 is not on PATH");
      },
    });
    await expect(outcome).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  test("an invalid policy is refused before any VM: unknown provider", async () => {
    // Goes through the real runInSandbox, whose first step is normalizePolicy — host-independent.
    await expect(
      execute({
        spec,
        def: sandboxDef({ sandbox: { provider: "firecracker" } }),
        workspaceDir: ws(),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/unknown sandbox provider/);
  });

  // ---- real VM, gated on preflight() -------------------------------------
  const report = preflight();
  const itVM = report.available ? test : test.skip;
  if (!report.available)
    console.warn(
      `[WM-313] skipping real-VM pi sandbox tests — ${report.reason}`,
    );
  const VM_TIMEOUT = 180_000;

  /**
   * A guest-side stand-in for pi: POSIX sh (the Alpine guest has no pi yet —
   * docs/eval-gondolin-guest-image.md), mounted read-only at /opt/tools and
   * selected via sandbox.guestBinaries. It reads its prompt from stdin, prints
   * one pi-shaped message_end line, and writes ./result.json into its cwd —
   * i.e. through the workspace mount, onto the host.
   */
  const guestToolsDir = path.join(tmpBase, "guest-tools");
  mkdirSync(guestToolsDir, { recursive: true });
  writeFileSync(
    path.join(guestToolsDir, "pi"),
    `#!/bin/sh
prompt=$(cat)
if [ -f ./.behaviour ]; then behaviour=$(cat ./.behaviour); else behaviour=normal; fi
echo "guest pi: cwd=$(pwd) key=\${OPENAI_API_KEY:-unset} home=$HOME" >&2
if [ "$behaviour" = "sleep" ]; then
  echo '{"type":"session","id":"guest-sess","cwd":"/workspace"}'
  echo '{"schemaVersion":"factory.agent-result/v1","terminalState":"completed","reasonCode":"ok","artifact":{"partial":true},"evidence":{}}' > ./result.json
  sleep 600
  exit 0
fi
printf '%s\\n' "$prompt" > ./.prompt-as-seen
echo '{"type":"session","id":"guest-sess","cwd":"/workspace"}'
echo '{"type":"message_end","message":{"role":"assistant","model":"guest-model","content":[{"type":"text","text":"hello from the guest"}],"usage":{"input":3,"output":4,"cost":{"total":0.0001}}}}'
echo "{\\"schemaVersion\\":\\"factory.agent-result/v1\\",\\"terminalState\\":\\"completed\\",\\"reasonCode\\":\\"ok\\",\\"artifact\\":{\\"argv\\":\\"$*\\",\\"keyLooksLikePlaceholder\\":\\"$(case "\${OPENAI_API_KEY:-}" in GONDOLIN_SECRET_*) echo yes;; *) echo no;; esac)\\"},\\"evidence\\":{}}" > ./result.json
exit 0
`,
    { mode: 0o755 },
  );
  const vmDef = (extra = {}) =>
    sandboxDef({
      sandbox: {
        ...sandboxDef().sandbox,
        mounts: { "/opt/tools": { path: guestToolsDir, readonly: true } },
        guestBinaries: { pi: "/opt/tools/pi" },
      },
      ...extra,
    });
  // The declared secret resolves from the HOST env at run time. This is a
  // fake, test-only value; the assertion is that the guest never sees it.
  const FAKE_KEY = "sk-test-fake-not-a-real-key-000";
  const withFakeKey = async (fn) => {
    const prev = process.env.FACTORY_TEST_FAKE_OPENAI_KEY;
    process.env.FACTORY_TEST_FAKE_OPENAI_KEY = FAKE_KEY;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.FACTORY_TEST_FAKE_OPENAI_KEY;
      else process.env.FACTORY_TEST_FAKE_OPENAI_KEY = prev;
    }
  };

  itVM(
    "real VM: pi runs in the guest, prompt arrives on stdin, result.json lands on the host, the key is a placeholder",
    async () => {
      await withFakeKey(async () => {
        const workspaceDir = ws();
        const trace = [];
        const outcome = await execute({
          spec,
          def: vmDef(),
          workspaceDir,
          timeoutMs: 120_000,
          env: { OPENAI_API_KEY: "sk-host-side-fake" },
          onTrace: (k, p) => trace.push({ k, p }),
        });
        expect(outcome.exitCode).toBe(0);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.usage.model).toBe("guest-model");
        expect(outcome.usage.inputTokens).toBe(3);

        const result = JSON.parse(
          readFileSync(path.join(workspaceDir, "result.json"), "utf8"),
        );
        expect(result.terminalState).toBe("completed");
        expect(result.artifact.argv).toContain("-p --mode json");
        expect(result.artifact.keyLooksLikePlaceholder).toBe("yes");
        expect(
          readFileSync(path.join(workspaceDir, ".prompt-as-seen"), "utf8"),
        ).toContain("You are a sandboxed test agent.");
        expect(
          readFileSync(path.join(workspaceDir, ".transcript.json"), "utf8"),
        ).toContain("hello from the guest");
        const console_ = readFileSync(
          path.join(workspaceDir, SANDBOX_CONSOLE_FILE),
          "utf8",
        );
        expect(console_).toContain("guest pi: cwd=/workspace");
        expect(console_).toContain("key=GONDOLIN_SECRET_");
        expect(console_).not.toContain(FAKE_KEY);
        expect(
          readFileSync(path.join(workspaceDir, ".transcript.json"), "utf8"),
        ).not.toContain(FAKE_KEY);
        expect(
          trace.some(
            (t) =>
              t.k === "assistant_text" && t.p.text === "hello from the guest",
          ),
        ).toBe(true);
      });
    },
    VM_TIMEOUT,
  );

  itVM(
    "real VM: timeout caps the guest and the partial result.json is on the host",
    async () => {
      await withFakeKey(async () => {
        const workspaceDir = ws();
        writeFileSync(path.join(workspaceDir, ".behaviour"), "sleep");
        const started = Date.now();
        // Generous enough that a cold guest (first exec after asset load) has
        // written result.json before the cap lands; the assertion is on the cap.
        const outcome = await execute({
          spec,
          def: vmDef(),
          workspaceDir,
          timeoutMs: 10_000,
        });
        expect(outcome.timedOut).toBe(true);
        expect(outcome.exitCode).toBeNull();
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(
          JSON.parse(
            readFileSync(path.join(workspaceDir, "result.json"), "utf8"),
          ).artifact.partial,
        ).toBe(true);
      });
    },
    VM_TIMEOUT,
  );

  itVM(
    "real VM: cooperative cancel tears the guest down and reports like a host cancel",
    async () => {
      await withFakeKey(async () => {
        const workspaceDir = ws();
        writeFileSync(path.join(workspaceDir, ".behaviour"), "sleep");
        const ac = new AbortController();
        const trace = [];
        const pending = execute({
          spec,
          def: vmDef(),
          workspaceDir,
          timeoutMs: 120_000,
          abortSignal: ac.signal,
          onTrace: (k, p) => trace.push({ k, p }),
        });
        // Abort once the guest has produced its first line, i.e. it is really running.
        for (
          let i = 0;
          i < 600 &&
          !trace.some((t) => t.k === "lifecycle" || t.k === "assistant_text");
          i += 1
        ) {
          if (existsSync(path.join(workspaceDir, "result.json"))) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        ac.abort();
        const outcome = await pending;
        expect(outcome.timedOut).toBe(false);
        expect(outcome.exitCode).toBeNull();
      });
    },
    VM_TIMEOUT,
  );
});

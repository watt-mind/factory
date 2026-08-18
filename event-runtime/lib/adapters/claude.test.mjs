import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-claude-test-mjs";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BASE_INHERITED_ENV,
  buildClaudeArgv,
  buildClaudeSettings,
  deriveAllowedTools,
  execute,
  isHarnessDenial,
  KILL_GRACE_MS,
  mapStreamEvent,
  PROMPT_SUFFIX,
  PUSH_CREDENTIAL_ENV,
  READ_ONLY_TOOLS,
  safeChildEnvironment,
  SANDBOX_DEFERRAL_REASON,
  SANDBOX_SUPPORT,
  WRITE_TOOLS,
} from "./claude.mjs";
import { SandboxUnsupportedError } from "./sandboxed.mjs";
import {
  processOwnerWatchdogSource,
  trackProcessGroupForPid,
} from "../test-helpers-process.mjs";

describe("sandbox decision (WM-313): deferred, so refused — never ignored", () => {
  const sandboxedDef = (promptPath) => ({
    ref: "sandboxed-claude@1",
    promptPath,
    mutating: false,
    sandbox: { provider: "gondolin", allowedHosts: ["api.anthropic.com"] },
  });

  test("declares itself unsupported and carries the reasoned deferral", () => {
    expect(SANDBOX_SUPPORT).toBe("unsupported");
    expect(SANDBOX_DEFERRAL_REASON).toContain("--mcp-config");
    expect(SANDBOX_DEFERRAL_REASON).toContain("--settings");
    expect(SANDBOX_DEFERRAL_REASON).toContain("WM-313");
  });

  test("a sandboxed definition is refused with a typed error naming the adapter, before any spawn or workspace write", async () => {
    const workspaceDir = realpathSync(tmpDir("evrt-claude-sandbox-"));
    const promptPath = path.join(workspaceDir, "prompt.md");
    writeFileSync(promptPath, "hello", "utf8");
    let caught;
    try {
      await execute({
        spec: {
          agent: "sandboxed-claude@1",
          input: {},
          workspace: { type: "repository", checkoutDir: "repo" },
        },
        def: sandboxedDef(promptPath),
        workspaceDir,
        timeoutMs: 1000,
        env: { PATH: workspaceDir },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnsupportedError);
    expect(caught.code).toBe("sandbox_unsupported");
    expect(caught.adapter).toBe("claude");
    expect(caught.message).toContain(
      'adapter "claude" cannot honour a sandbox policy',
    );
    expect(caught.message).toContain(SANDBOX_DEFERRAL_REASON);
    // Nothing host-side happened: no settings policy, no transcript.
    expect(existsSync(path.join(workspaceDir, ".claude-policy.json"))).toBe(
      false,
    );
    expect(existsSync(path.join(workspaceDir, ".transcript.json"))).toBe(false);
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});

describe("isHarnessDenial (WM-127)", () => {
  test("matches the harness's own refusal shapes", () => {
    expect(
      isHarnessDenial(
        "Claude requested permissions to use Bash, but you haven't granted it yet.",
      ),
    ).toBe(true);
    expect(
      isHarnessDenial(
        "Claude requested permissions to use mcp__linear__create_issue, but you haven't granted it yet.",
      ),
    ).toBe(true);
    expect(isHarnessDenial("Permission to use Bash has been denied.")).toBe(
      true,
    );
    expect(isHarnessDenial("Sandbox denied write to /tmp/run-a1/repo/x")).toBe(
      true,
    );
  });

  test("does not match permission-flavored stderr from commands the harness allowed", () => {
    // The run_38deabb4 misclassification: git push over SSH without agent access.
    expect(
      isHarnessDenial(
        "git@ssh.github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      ),
    ).toBe(false);
    expect(isHarnessDenial("bash: /etc/hosts: Permission denied")).toBe(false);
    expect(
      isHarnessDenial(
        "sudo: a terminal is required to read the password; permission denied",
      ),
    ).toBe(false);
    expect(
      isHarnessDenial("EACCES: permission denied, open '/var/log/system.log'"),
    ).toBe(false);
    expect(
      isHarnessDenial(
        "remote: Write access to repository not granted.\nfatal: unable to access: The requested URL returned error: 403",
      ),
    ).toBe(false);
    expect(
      isHarnessDenial(
        "curl: (22) The requested URL returned error: 403 Forbidden — request blocked by firewall permissions",
      ),
    ).toBe(false);
    expect(isHarnessDenial(null)).toBe(false);
  });
});

describe("mapStreamEvent", () => {
  test("assistant text block → assistant_text", () => {
    const events = mapStreamEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Looking at the input now." }],
      },
      session_id: "s-1",
    });
    expect(events).toEqual([
      {
        kind: "assistant_text",
        payload: { text: "Looking at the input now." },
      },
    ]);
  });

  test("assistant tool_use block → tool_use; mixed blocks map in order", () => {
    const events = mapStreamEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running the query." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "assistant_text", payload: { text: "Running the query." } },
      {
        kind: "tool_use",
        payload: { id: "toolu_1", name: "Bash", input: { command: "ls" } },
      },
    ]);
  });

  test("user tool_result → tool_result, string and block-array content, isError", () => {
    const plain = mapStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" },
        ],
      },
    });
    expect(plain).toEqual([
      {
        kind: "tool_result",
        payload: { content: "file.txt", toolUseId: "toolu_1" },
      },
    ]);

    const blocks = mapStreamEvent({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
            is_error: true,
          },
        ],
      },
    });
    expect(blocks).toEqual([
      {
        kind: "tool_result",
        payload: {
          content: "line 1\nline 2",
          toolUseId: "toolu_2",
          isError: true,
        },
      },
    ]);
  });

  test("final result → usage with only the token fields that exist", () => {
    const events = mapStreamEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 4321,
      duration_api_ms: 4000,
      num_turns: 3,
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 12,
        output_tokens: 345,
        cache_creation_input_tokens: 6789,
        cache_read_input_tokens: 1011,
        server_tool_use: { web_search_requests: 0 },
        service_tier: "standard",
      },
      result: "done",
    });
    expect(events).toEqual([
      {
        kind: "usage",
        payload: {
          durationMs: 4321,
          numTurns: 3,
          costUSD: 0.0421,
          usage: {
            input_tokens: 12,
            output_tokens: 345,
            cache_creation_input_tokens: 6789,
            cache_read_input_tokens: 1011,
          },
        },
      },
    ]);
  });

  test("unrecognized messages are ignored silently", () => {
    expect(
      mapStreamEvent({ type: "system", subtype: "init", tools: [] }),
    ).toEqual([]);
    expect(mapStreamEvent({ type: "system", subtype: "hook_started" })).toEqual(
      [],
    );
    expect(mapStreamEvent({ type: "stream_event", event: {} })).toEqual([]);
    expect(mapStreamEvent({ type: "assistant" })).toEqual([]); // no message body
    expect(
      mapStreamEvent({ type: "user", message: { content: "just a string" } }),
    ).toEqual([]);
    expect(mapStreamEvent(null)).toEqual([]);
    expect(mapStreamEvent("not an object")).toEqual([]);
  });

  test("very long assistant text is clipped, not passed through whole", () => {
    const [event] = mapStreamEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "y".repeat(10_000) }] },
    });
    expect(event.kind).toBe("assistant_text");
    expect(event.payload.text.length).toBeLessThan(5_000);
    expect(event.payload.text.endsWith("…[truncated]")).toBe(true);
  });
});

describe("deriveAllowedTools (OPS-407)", () => {
  test("defaults to read-only tools when mutating is false", () => {
    const def = { mutating: false };
    expect(deriveAllowedTools(def)).toEqual(READ_ONLY_TOOLS);
  });

  test("uses the workspace policy instead of a narrower tool declaration for mutating:false", () => {
    const def = {
      mutating: false,
      capabilities: { tools: ["Read", "Grep"] },
    };
    expect(deriveAllowedTools(def)).toEqual(READ_ONLY_TOOLS);
  });

  test("permits shell inspection and workspace-local output for non-mutating agents", () => {
    expect(deriveAllowedTools({ mutating: false })).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Write",
      "Edit",
    ]);
  });

  test("allows requested tools when mutating is true", () => {
    const def = {
      mutating: true,
      capabilities: {
        tools: ["Read", "Write", "Bash"],
      },
    };
    expect(deriveAllowedTools(def)).toEqual(["Read", "Write", "Bash"]);
  });
});

describe("safeChildEnvironment (WM-128)", () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  test("strips push credentials and secret keys for non-mutating configurations (mutating: false)", () => {
    const env = {
      SSH_AUTH_SOCK: "/tmp/test.sock",
      SSH_AGENT_PID: "12345",
      GITHUB_TOKEN: "ghp_secret_token",
      GH_TOKEN: "ghp_other_token",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CUSTOM_INSPECT_VAR: "allowed",
    };
    const childEnv = safeChildEnvironment(env, { mutating: false });

    expect(childEnv.CUSTOM_INSPECT_VAR).toBe("allowed");
    expect(childEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(childEnv.SSH_AGENT_PID).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.GH_TOKEN).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.CLAUDECODE).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  test("preserves push credentials while stripping secret keys for mutating configurations (mutating: true)", () => {
    const env = {
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SSH_AGENT_PID: "54321",
      GITHUB_TOKEN: "ghp_mutating_token",
      GH_TOKEN: "ghp_gh_token",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CUSTOM_MUTATING_VAR: "allowed",
    };
    const childEnv = safeChildEnvironment(env, { mutating: true });

    expect(childEnv.CUSTOM_MUTATING_VAR).toBe("allowed");
    expect(childEnv.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(childEnv.SSH_AGENT_PID).toBe("54321");
    expect(childEnv.GITHUB_TOKEN).toBe("ghp_mutating_token");
    expect(childEnv.GH_TOKEN).toBe("ghp_gh_token");
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.CLAUDECODE).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  test("inherits push credentials from process.env when mutating: true", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/inherited.sock";
    process.env.GITHUB_TOKEN = "ghp_inherited_token";

    const mutatingEnv = safeChildEnvironment({}, { mutating: true });
    expect(mutatingEnv.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
    expect(mutatingEnv.GITHUB_TOKEN).toBe("ghp_inherited_token");

    const readOnlyEnv = safeChildEnvironment({}, { mutating: false });
    expect(readOnlyEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(readOnlyEnv.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("buildClaudeArgv (OPS-407, WM-62, WM-137)", () => {
  test("generates a sandbox policy that permits output but denies repository writes", () => {
    const settings = buildClaudeSettings({
      spec: { workspace: { type: "repository", checkoutDir: "repo" } },
      def: { mutating: false },
      workspaceDir: "/private/tmp/run-a1",
    });
    expect(settings.permissions.allow).toEqual(READ_ONLY_TOOLS);
    expect(settings.permissions.deny).toEqual([
      "Edit(//private/tmp/run-a1/repo/**)",
    ]);
    expect(settings.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ["/private/tmp/run-a1/repo"] },
    });
  });

  test("mutating runs include --dangerously-skip-permissions and omit --settings (WM-137)", () => {
    const mutatingDef = {
      mutating: true,
      capabilities: { tools: ["Bash", "Read", "Write"] },
    };
    const argv = buildClaudeArgv({ prompt: "Fix issue", def: mutatingDef });

    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--settings");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Bash,Read,Write");
  });

  test("read-only runs omit --dangerously-skip-permissions and include --settings (WM-137)", () => {
    const readOnlyDef = { mutating: false };
    const argv = buildClaudeArgv({
      prompt: "Inspect repo",
      def: readOnlyDef,
      settingsPath: "/tmp/policy.json",
    });

    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--settings");
    expect(argv).toContain("/tmp/policy.json");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Read,Grep,Glob,Bash,Write,Edit");
  });

  test("default definition with unspecified mutating passes --dangerously-skip-permissions (WM-137)", () => {
    const def = {};
    const argv = buildClaudeArgv({ prompt: "Default run", def });
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  test("constructs argv with --allowedTools, --mcp-config, and --strict-mcp-config", () => {
    const def = { mutating: false };
    const prompt = "Do a status check.";
    const argv = buildClaudeArgv({
      prompt,
      def,
      mcpConfig: "/path/to/mcp.json",
    });

    expect(argv).toContain("-p");
    expect(argv).toContain(prompt);
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Read,Grep,Glob,Bash,Write,Edit");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/path/to/mcp.json");
    expect(argv).toContain("--strict-mcp-config");
  });

  test("limits.budget_usd → --max-budget-usd; absent or invalid → no flag (WM-108)", () => {
    const withBudget = buildClaudeArgv({
      prompt: "p",
      def: { mutating: false, limits: { budget_usd: 15 } },
    });
    const i = withBudget.indexOf("--max-budget-usd");
    expect(i).toBeGreaterThan(-1);
    expect(withBudget[i + 1]).toBe("15");

    expect(
      buildClaudeArgv({ prompt: "p", def: { mutating: false } }),
    ).not.toContain("--max-budget-usd");
    expect(
      buildClaudeArgv({
        prompt: "p",
        def: { mutating: false, limits: { budget_usd: 0 } },
      }),
    ).not.toContain("--max-budget-usd");
    expect(
      buildClaudeArgv({
        prompt: "p",
        def: { mutating: false, limits: { budget_usd: "15" } },
      }),
    ).not.toContain("--max-budget-usd");
  });

  test("planner-pinned model → --model verbatim; default sentinel, null, or absent → no flag (WM-135)", () => {
    const withModel = buildClaudeArgv({
      prompt: "p",
      def: { mutating: false },
      model: "sonnet",
    });
    const i = withModel.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(withModel[i + 1]).toBe("sonnet");

    // The "default" sentinel means "ride the CLI default" — no flag at all,
    // byte-identical argv to a spec that pinned nothing.
    const unpinned = buildClaudeArgv({ prompt: "p", def: { mutating: false } });
    expect(
      buildClaudeArgv({
        prompt: "p",
        def: { mutating: false },
        model: "default",
      }),
    ).toEqual(unpinned);
    expect(
      buildClaudeArgv({ prompt: "p", def: { mutating: false }, model: null }),
    ).toEqual(unpinned);
    expect(
      buildClaudeArgv({ prompt: "p", def: { mutating: false }, model: "" }),
    ).toEqual(unpinned);
  });
});

describe("execute conformance (OPS-427, docs/event-runtime.md §6)", () => {
  const tmpBase = realpathSync(tmpDir("evrt-claude-test-"));
  const stubBinDir = path.join(tmpBase, "bin");
  mkdirSync(stubBinDir, { recursive: true });

  const stubClaudePath = path.join(stubBinDir, "claude");
  const stubScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

${processOwnerWatchdogSource()}

if (process.env.FACTORY_TEST_RECORD_FILE) {
  writeFileSync(
    process.env.FACTORY_TEST_RECORD_FILE,
    JSON.stringify({
      cwd: process.cwd(),
      env: process.env,
      argv: process.argv,
    }),
    "utf8",
  );
}

const behavior = process.env.FACTORY_TEST_BEHAVIOR || "normal";

if (behavior === "normal") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Working..." }] },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 15, output_tokens: 25 },
    }) + "\\n",
  );
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
  process.on("SIGTERM", () => {
    // deliberately ignore SIGTERM to test SIGKILL escalation
  });
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

if (behavior === "emit_bash_then_success") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pwd" } }] },
    }) + "\\n",
  );
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", usage: {} }) + "\\n");
    process.exit(0);
  }, 150);
}

if (behavior === "emit_policy_denial") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "touch repo/nope" } }],
      },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." }] },
    }) + "\\n",
  );
  process.exit(1);
}

// run_38deabb4's transcript shape: git push fails with SSH publickey stderr in
// an error tool_result, the agent retries over gh auth and finishes clean.
if (behavior === "emit_ssh_denied" || behavior === "emit_ssh_denied_then_recovery") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_push", name: "Bash", input: { command: "git push -u origin HEAD" } }],
      },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_push", is_error: true, content: "git@ssh.github.com: Permission denied (publickey).\\r\\nfatal: Could not read from remote repository.\\n\\nPlease make sure you have the correct access rights\\nand the repository exists." }] },
    }) + "\\n",
  );
  if (behavior === "emit_ssh_denied") process.exit(1);
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_retry", name: "Bash", input: { command: "git -c credential.helper='!gh auth git-credential' push -u origin HEAD" } }],
      },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_retry", content: "branch pushed" }] },
    }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} }) + "\\n");
  process.exit(0);
}

if (behavior === "emit_denial_then_recovery") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "WebFetch", input: { url: "https://example.com" } }],
      },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Claude requested permissions to use WebFetch, but you haven't granted it yet." }] },
    }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} }) + "\\n");
  process.exit(0);
}
`;
  writeFileSync(stubClaudePath, stubScript, { mode: 0o755 });

  const promptFile = path.join(tmpBase, "prompt.md");
  writeFileSync(promptFile, "You are a test agent.", "utf8");

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const ws = () => realpathSync(tmpDir("ws-", tmpBase));
  const defaultDef = {
    ref: "test-agent@1",
    promptPath: promptFile,
    mutating: false,
    capabilities: { tools: ["Read", "Grep"] },
  };
  const defaultSpec = {
    agent: "test-agent@1",
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

  test("executes stub binary in workspaceDir, strips ANTHROPIC_API_KEY, captures .transcript.json and trace", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const traceEvents = [];

    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        ANTHROPIC_API_KEY: "sk-secret-key-must-be-stripped",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
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
    });

    // 1. Workspace confinement: cwd is workspaceDir
    expect(existsSync(recordFile)).toBe(true);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.cwd).toBe(workspaceDir);

    // 2. Env security: ANTHROPIC_API_KEY, CLAUDECODE, CLAUDE_CODE_ENTRYPOINT deleted
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record.env.CLAUDECODE).toBeUndefined();
    expect(record.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(record.env.CUSTOM_VAR).toBe("custom_value");

    // 3. Prompt & argv verification
    const promptIdx = record.argv.indexOf("-p");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(record.argv[promptIdx + 1]).toBe(
      `You are a test agent.${PROMPT_SUFFIX}`,
    );
    expect(record.argv).toContain("--output-format");
    expect(record.argv).toContain("stream-json");
    expect(record.argv).toContain("--verbose");
    expect(record.argv).toContain("--allowedTools");
    expect(record.argv).toContain("Read,Grep,Glob,Bash,Write,Edit");
    expect(record.argv).toContain("--settings");
    const policyPath = record.argv[record.argv.indexOf("--settings") + 1];
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    expect(policy.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(policy.permissions.allow).toEqual(READ_ONLY_TOOLS);
    expect(record.argv).toContain("--strict-mcp-config");

    // 4. .transcript.json artifact capture
    const transcriptPath = path.join(workspaceDir, ".transcript.json");
    expect(existsSync(transcriptPath)).toBe(true);
    const transcript = readFileSync(transcriptPath, "utf8");
    expect(transcript).toContain('"type":"assistant"');
    expect(transcript).toContain('"type":"result"');

    // 5. Live trace mapping
    expect(traceEvents).toHaveLength(2);
    expect(traceEvents[0].kind).toBe("assistant_text");
    expect(traceEvents[0].payload.text).toBe("Working...");
    expect(traceEvents[1].kind).toBe("usage");
    expect(traceEvents[1].payload.usage.input_tokens).toBe(15);
  });

  test("nonzero exit code propagates and timedOut is false", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
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
    const workspaceDir = ws();
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
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

  test("pre-aborted abortSignal terminates child immediately", async () => {
    const workspaceDir = ws();
    const ac = new AbortController();
    ac.abort();

    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 10_000,
      killGraceMs: 500,
      abortSignal: ac.signal,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "sleep_sigterm",
      },
    });
    expect(outcome.timedOut).toBe(false);
  });

  test("does not turn a permitted Bash inspection into agent_exit_143", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_bash_then_success",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
    });
    expect(
      traceEvents.some(
        (e) => e.kind === "tool_use" && e.payload.name === "Bash",
      ),
    ).toBe(true);
  });

  test("records a policy denial without terminating the child from the trace observer", async () => {
    const workspaceDir = ws();
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: { ...defaultDef, mutating: false },
      workspaceDir,
      timeoutMs: 5000,
      killGraceMs: 500,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_policy_denial",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });

    expect(outcome).toEqual({
      exitCode: 1,
      timedOut: false,
      policyDenials: [
        {
          tool: "Bash",
          rule: "Claude requested permissions to use Bash, but you haven't granted it yet.",
        },
      ],
    });
    expect(
      traceEvents.some(
        (e) =>
          e.kind === "lifecycle" &&
          e.payload.note === "policy_denial" &&
          e.payload.tool === "Bash",
      ),
    ).toBe(true);
  });

  test("SSH publickey stderr in an error tool_result is not a policy denial (WM-127)", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_ssh_denied",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    // The harness allowed and executed the push; the command failed on its
    // own. The run must fail as an ordinary agent exit, never policy_denied.
    expect(outcome).toEqual({
      exitCode: 1,
      timedOut: false,
      policyDenials: [],
    });
    expect(
      traceEvents.some(
        (e) => e.kind === "lifecycle" && e.payload.note === "policy_denial",
      ),
    ).toBe(false);
  });

  test("SSH publickey stderr followed by a recovered push and clean exit completes (WM-127, run_38deabb4)", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_ssh_denied_then_recovery",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
    });
    expect(
      traceEvents.some(
        (e) => e.kind === "lifecycle" && e.payload.note === "policy_denial",
      ),
    ).toBe(false);
  });

  test("a genuine denial the model recovers from does not fail a clean exit; trace keeps the evidence (WM-127)", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_denial_then_recovery",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    // Evidence, not verdict: the observation stays in the lifecycle trace,
    // but a run that ends exit 0 with a valid result is not failed for it.
    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
    });
    expect(
      traceEvents.some(
        (e) =>
          e.kind === "lifecycle" &&
          e.payload.note === "policy_denial" &&
          e.payload.tool === "WebFetch",
      ),
    ).toBe(true);
  });

  test("returns a policy denial even when no trace sink is attached", async () => {
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_policy_denial",
      },
    });
    expect(outcome.policyDenials).toEqual([
      {
        tool: "Bash",
        rule: "Claude requested permissions to use Bash, but you haven't granted it yet.",
      },
    ]);
  });

  test("mutating dispatch execution passes --dangerously-skip-permissions and preserves push credentials (WM-137, WM-128)", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const mutatingDef = {
      ref: "dispatch@1",
      promptPath: promptFile,
      mutating: true,
      capabilities: { tools: ["Bash", "Read", "Write", "Edit"] },
    };

    const outcome = await execute({
      spec: defaultSpec,
      def: mutatingDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        SSH_AUTH_SOCK: "/tmp/dispatch-ssh.sock",
        GITHUB_TOKEN: "ghp_dispatch_secret",
        ANTHROPIC_API_KEY: "sk-must-be-stripped",
        FACTORY_TEST_BEHAVIOR: "normal",
        FACTORY_TEST_RECORD_FILE: recordFile,
      },
    });

    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
    });
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.argv).toContain("--dangerously-skip-permissions");
    expect(record.argv).not.toContain("--settings");
    expect(record.env.SSH_AUTH_SOCK).toBe("/tmp/dispatch-ssh.sock");
    expect(record.env.GITHUB_TOKEN).toBe("ghp_dispatch_secret");
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(existsSync(path.join(workspaceDir, ".claude-policy.json"))).toBe(
      false,
    );
  });

  test("read-only dispatch execution enforces settings policy and strips push credentials (WM-137, WM-128)", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const readOnlyDef = {
      ref: "status-report@1",
      promptPath: promptFile,
      mutating: false,
      capabilities: { tools: ["Read", "Grep"] },
    };

    const outcome = await execute({
      spec: defaultSpec,
      def: readOnlyDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        SSH_AUTH_SOCK: "/tmp/read-only-ssh.sock",
        GITHUB_TOKEN: "ghp_read_only_secret",
        ANTHROPIC_API_KEY: "sk-must-be-stripped",
        FACTORY_TEST_BEHAVIOR: "normal",
        FACTORY_TEST_RECORD_FILE: recordFile,
      },
    });

    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
    });
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.argv).not.toContain("--dangerously-skip-permissions");
    expect(record.argv).toContain("--settings");
    expect(record.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(record.env.GITHUB_TOKEN).toBeUndefined();
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(existsSync(path.join(workspaceDir, ".claude-policy.json"))).toBe(
      true,
    );
  });

  test("spawn error (e.g. claude not on PATH) rejects promise", async () => {
    const workspaceDir = ws();
    await expect(
      execute({
        spec: defaultSpec,
        def: defaultDef,
        workspaceDir,
        timeoutMs: 1000,
        env: { PATH: "/nonexistent-bin-dir" },
      }),
    ).rejects.toThrow();
  });
});

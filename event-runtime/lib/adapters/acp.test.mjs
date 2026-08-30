import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-acp-test-mjs";
import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as acp from "./acp.mjs";
import {
  AcpProtocolError,
  CliNotFoundError,
  DEFAULT_ACP_CONFIG,
  DEFAULT_ALLOW_COMMANDS,
  KILL_GRACE_MS,
  PROTOCOL_VERSION,
  SANDBOX_DEFERRAL_REASON,
  SANDBOX_SUPPORT,
  commandBasename,
  decidePermission,
  execute,
  isInsideWorkspace,
  mapSessionUpdate,
  permissionPolicyFor,
  resolveAcpCommand,
  resolveAcpConfig,
  selectPermissionOption,
  usageFromUpdate,
} from "./acp.mjs";
import { createAdapterRegistry, validateAdapterContract } from "./index.mjs";
import { PROMPT_SUFFIX } from "./claude.mjs";
import { SandboxUnsupportedError } from "./sandboxed.mjs";
import {
  processOwnerWatchdogSource,
  registerTestProcessCleanup,
  trackProcessGroupForPid,
} from "../test-helpers-process.mjs";

registerTestProcessCleanup(import.meta.url);

const tmpBase = tmpDir("evrt-acp-");
const stubPath = path.join(tmpBase, "fake-acp.mjs");
const promptPath = path.join(tmpBase, "prompt.md");
writeFileSync(promptPath, "You are a test agent.", "utf8");

writeFileSync(
  stubPath,
  `#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import path from "node:path";

${processOwnerWatchdogSource()}

const behavior = process.env.ACP_FAKE_BEHAVIOR || "happy";
if (process.env.ACP_FAKE_RECORD) {
  writeFileSync(
    process.env.ACP_FAKE_RECORD,
    JSON.stringify({ cwd: process.cwd(), env: process.env, argv: process.argv }),
  );
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

const pending = new Map();
let nextId = 9000;
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

const allowOnce = {
  optionId: "allow-once",
  name: "Allow once",
  kind: "allow_once",
};
const rejectOnce = {
  optionId: "reject-once",
  name: "Reject",
  kind: "reject_once",
};

async function handlePrompt(sessionId) {
  if (behavior === "hang" || behavior === "ignore_sigterm") return;
  if (behavior === "spawn_grandchild") {
    const grandchild = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 10_000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    writeFileSync(
      process.env.ACP_FAKE_GRANDCHILD_PID,
      String(grandchild.pid),
      "utf8",
    );
    return;
  }

  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Working..." },
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Read input",
        kind: "read",
        status: "pending",
        rawInput: { path: path.join(process.cwd(), "input.json") },
      },
    },
  });

  if (behavior.startsWith("permission_")) {
    const kind =
      behavior === "permission_edit"
        ? "edit"
        : behavior === "permission_outside"
          ? "edit"
          : "execute";
    const toolCall =
      kind === "edit"
        ? {
            toolCallId: "call_perm",
            kind: "edit",
            title: "Edit file",
            locations: [
              {
                path:
                  behavior === "permission_outside"
                    ? "/etc/passwd"
                    : path.join(process.cwd(), "result.json"),
              },
            ],
          }
        : {
            toolCallId: "call_perm",
            kind: "execute",
            title: "Run command",
            rawInput: {
              command:
                behavior === "permission_git" ? "git status" : "curl https://evil.example",
            },
          };
    const decided = await request("session/request_permission", {
      sessionId,
      toolCall,
      options: [allowOnce, rejectOnce],
    });
    writeFileSync(
      path.join(process.cwd(), "permission.json"),
      JSON.stringify(decided),
    );
  }

  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [
          {
            type: "diff",
            path: path.join(process.cwd(), "result.json"),
            oldText: null,
            newText: "{\\"ok\\":true}",
          },
        ],
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 1200,
        size: 200000,
        cost: { amount: 0.02, currency: "USD" },
      },
    },
  });
  writeFileSync(
    path.join(process.cwd(), "result.json"),
    JSON.stringify({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
    }) + "\\n",
  );
  send({
    jsonrpc: "2.0",
    id: currentPromptId,
    result: { stopReason: "end_turn" },
  });
}

let currentPromptId = null;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
    return;
  }
  if (msg.method === "initialize") {
    if (behavior === "protocol_v2") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 2 } });
      return;
    }
    if (behavior === "auth_required") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          authMethods: [{ id: "api-key", name: "API key" }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp" },
        authMethods: [],
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_test" } });
    return;
  }
  if (msg.method === "session/prompt") {
    if (process.env.ACP_FAKE_PROMPT_RECORD) {
      writeFileSync(
        process.env.ACP_FAKE_PROMPT_RECORD,
        msg.params?.prompt?.[0]?.text ?? "",
      );
    }
    currentPromptId = msg.id;
    handlePrompt(msg.params.sessionId).catch((err) => {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err.message },
      });
    });
    return;
  }
  if (msg.method === "session/cancel") return;
  if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "method not found" },
    });
  }
});

if (behavior === "ignore_sigterm") {
  process.on("SIGTERM", () => {});
}
if (
  behavior === "hang" ||
  behavior === "ignore_sigterm" ||
  behavior === "spawn_grandchild"
) {
  setInterval(() => {}, 10_000);
}
`,
  { mode: 0o755 },
);

writeFileSync(promptPath, "You are a test agent.", "utf8");

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

const ws = () => realpathSync(tmpDir("ws-", tmpBase));
const defaultDef = {
  ref: "test-acp@1",
  promptPath,
  promptText: "You are a test agent.",
  mutating: false,
};
const mutatingDef = { ...defaultDef, mutating: true };
const defaultSpec = { agent: "test-acp@1", input: {} };
const fakeConfig = {
  command: process.execPath,
  args: [stubPath],
};

function run(workspaceDir, extra = {}) {
  return execute({
    spec: defaultSpec,
    def: extra.def ?? defaultDef,
    workspaceDir,
    timeoutMs: extra.timeoutMs ?? 5000,
    killGraceMs: extra.killGraceMs ?? 200,
    env: {
      ACP_FAKE_BEHAVIOR: extra.behavior ?? "happy",
      ...(extra.env ?? {}),
    },
    config: fakeConfig,
    onTrace: extra.onTrace,
    onUsage: extra.onUsage,
    onPermissionRequest: extra.onPermissionRequest,
    abortSignal: extra.abortSignal,
    ...(extra.transcriptMaxBytes !== undefined
      ? { transcriptMaxBytes: extra.transcriptMaxBytes }
      : {}),
  });
}

describe("transcript cap (GH-1420)", () => {
  test("caps the transcript, flags truncation, and still exits cleanly", async () => {
    const workspaceDir = ws();
    const traceEvents = [];
    const outcome = await run(workspaceDir, {
      transcriptMaxBytes: 64,
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.transcriptTruncated).toBe(true);
    expect(
      traceEvents.some(
        (event) =>
          event.kind === "lifecycle" &&
          event.payload.note === "transcript_truncated" &&
          event.payload.bytes === 64,
      ),
    ).toBe(true);
    const transcript = readFileSync(
      path.join(workspaceDir, ".transcript.json"),
      "utf8",
    );
    expect(Buffer.byteLength(transcript)).toBeLessThanOrEqual(
      64 +
        Buffer.byteLength(
          '\n{"type":"factory","subtype":"transcript_truncated","bytes":64}\n',
        ),
    );
    expect(
      transcript.endsWith(
        '\n{"type":"factory","subtype":"transcript_truncated","bytes":64}\n',
      ),
    ).toBe(true);
  });

  test("a transcript under the cap is stored whole with no truncation flag", async () => {
    const workspaceDir = ws();
    const outcome = await run(workspaceDir);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.transcriptTruncated).toBeUndefined();
    const transcript = readFileSync(
      path.join(workspaceDir, ".transcript.json"),
      "utf8",
    );
    const lines = transcript.split("\n");
    expect(lines.at(-1)).toBe("");
    const parsed = lines.slice(0, -1).map(JSON.parse);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed.some((msg) => msg.type === "factory")).toBe(false);
  });
});

describe("adapter contract", () => {
  test("satisfies WM-837: execute + SANDBOX_SUPPORT unsupported", () => {
    expect(SANDBOX_SUPPORT).toBe("unsupported");
    expect(typeof execute).toBe("function");
    expect(PROTOCOL_VERSION).toBe(1);
    expect(KILL_GRACE_MS).toBe(30_000);
    expect(DEFAULT_ACP_CONFIG.command).toBe("claude-code-acp");
    expect(SANDBOX_DEFERRAL_REASON).toContain("claude-code-acp");
    expect(validateAdapterContract("acp", acp)).toEqual({
      name: "acp",
      sandboxSupport: "unsupported",
    });
  });

  test("registers behind createAdapterRegistry and the sandbox wrapper refuses first", async () => {
    const registry = createAdapterRegistry({ builtins: { acp } });
    expect(registry.has("acp")).toBe(true);
    expect(registry.get("acp").SANDBOX_SUPPORT).toBe("unsupported");
    const workspaceDir = ws();
    let caught;
    try {
      await registry.get("acp").execute({
        spec: defaultSpec,
        def: {
          ref: "sandboxed-acp@1",
          promptPath,
          sandbox: { provider: "gondolin", allowedHosts: [] },
        },
        workspaceDir,
        timeoutMs: 1000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnsupportedError);
    expect(caught.adapter).toBe("acp");
    expect(existsSync(path.join(workspaceDir, ".transcript.json"))).toBe(false);
  });
});

describe("sandbox decision: refused, never ignored", () => {
  test("a sandboxed definition is refused before spawn", async () => {
    const workspaceDir = ws();
    let caught;
    try {
      await execute({
        spec: defaultSpec,
        def: {
          ref: "sandboxed-acp@1",
          promptPath,
          sandbox: { provider: "gondolin" },
        },
        workspaceDir,
        timeoutMs: 1000,
        config: { command: "/nonexistent/acp-agent" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnsupportedError);
    expect(caught.adapter).toBe("acp");
    expect(caught.message).toContain(SANDBOX_DEFERRAL_REASON);
    expect(existsSync(path.join(workspaceDir, ".transcript.json"))).toBe(false);
  });
});

describe("resolveAcpConfig / resolveAcpCommand", () => {
  test("defaults to claude-code-acp and overlays spec/def/config", () => {
    expect(resolveAcpConfig({})).toEqual({
      command: "claude-code-acp",
      args: [],
      env: {},
    });
    expect(
      resolveAcpConfig({
        spec: { acp: { command: "goose", args: ["--foo"], env: { A: "1" } } },
      }),
    ).toEqual({ command: "goose", args: ["--foo"], env: { A: "1" } });
    expect(
      resolveAcpConfig({
        spec: { acp: { command: "goose" } },
        config: { command: "override" },
      }).command,
    ).toBe("override");
  });

  test("absolute missing command is null; existing path resolves", () => {
    expect(resolveAcpCommand({ command: "/no/such/acp-agent" })).toBeNull();
    expect(resolveAcpCommand({ command: stubPath, args: [] })).toEqual({
      command: stubPath,
      args: [],
    });
  });
});

describe("mapSessionUpdate / usageFromUpdate", () => {
  test("agent_message_chunk → assistant_text", () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Looking at the input now." },
      }),
    ).toEqual([
      {
        kind: "assistant_text",
        payload: { text: "Looking at the input now." },
      },
    ]);
  });

  test("tool_call → tool_use; completed update with diff → tool_result", () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Edit result",
        kind: "edit",
        rawInput: { path: "/ws/result.json" },
      }),
    ).toEqual([
      {
        kind: "tool_use",
        payload: {
          id: "call_1",
          name: "edit",
          input: { path: "/ws/result.json" },
          title: "Edit result",
        },
      },
    ]);
    const done = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/ws/result.json",
          oldText: null,
          newText: "{}\n",
        },
      ],
    });
    expect(done[0].kind).toBe("tool_result");
    expect(done[0].payload.toolUseId).toBe("call_1");
    expect(done[0].payload.diff.path).toBe("/ws/result.json");
    expect(done[0].payload.isError).toBeUndefined();
  });

  test("usage_update maps tokens and USD cost; unknown kinds are empty", () => {
    const update = {
      sessionUpdate: "usage_update",
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    };
    expect(mapSessionUpdate(update)[0]).toEqual({
      kind: "usage",
      payload: {
        durationMs: null,
        numTurns: null,
        costUSD: 0.045,
        usage: { used: 53000, size: 200000 },
      },
    });
    expect(usageFromUpdate(update)).toEqual({
      inputTokens: 53000,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      contextSize: 200000,
      costUSD: 0.045,
    });
    expect(mapSessionUpdate({ sessionUpdate: "plan", entries: [] })).toEqual(
      [],
    );
    expect(mapSessionUpdate(null)).toEqual([]);
  });
});

describe("permission policy", () => {
  const root = "/tmp/acp-ws";
  const inside = `${root}/repo/file.ts`;

  test("read/search/think allow; workspace edits allow; outside and unknown escalate", () => {
    const policy = permissionPolicyFor(
      { mutating: true },
      { workspaceDir: root },
    );
    expect(decidePermission({ toolCall: { kind: "read" } }, policy)).toBe(
      "allow",
    );
    expect(
      decidePermission(
        { toolCall: { kind: "edit", locations: [{ path: inside }] } },
        policy,
      ),
    ).toBe("allow");
    expect(
      decidePermission(
        { toolCall: { kind: "edit", locations: [{ path: "/etc/passwd" }] } },
        policy,
      ),
    ).toBe("escalate");
    expect(decidePermission({ toolCall: { kind: "fetch" } }, policy)).toBe(
      "escalate",
    );
  });

  test("execute allow-lists command basename; mutating:false has an empty list", () => {
    expect(commandBasename("/usr/bin/git status")).toBe("git");
    expect(isInsideWorkspace(inside, root)).toBe(true);
    expect(isInsideWorkspace("/etc/passwd", root)).toBe(false);
    const mutating = permissionPolicyFor(
      { mutating: true },
      { workspaceDir: root },
    );
    expect(mutating.allowCommands).toEqual([...DEFAULT_ALLOW_COMMANDS]);
    expect(
      decidePermission(
        { toolCall: { kind: "execute", rawInput: { command: "git status" } } },
        mutating,
      ),
    ).toBe("allow");
    expect(
      decidePermission(
        {
          toolCall: {
            kind: "execute",
            rawInput: { command: "curl https://evil" },
          },
        },
        mutating,
      ),
    ).toBe("escalate");
    expect(
      permissionPolicyFor({ mutating: false }, { workspaceDir: root })
        .allowCommands,
    ).toEqual([]);
  });

  test("selectPermissionOption prefers once-only options", () => {
    const options = [
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ];
    expect(selectPermissionOption(options, "allow")).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(selectPermissionOption(options, "reject")).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(selectPermissionOption(options, "cancel")).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});

describe("execute against a fake ACP agent", () => {
  test("spawn errors destroy the transcript before rejecting", async () => {
    const workspaceDir = ws();
    let transcript;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = null;
    child.stderr = null;

    const pending = execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 1000,
      config: fakeConfig,
      spawnProcess: () => {
        queueMicrotask(() =>
          child.emit(
            "error",
            Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
          ),
        );
        return child;
      },
      transcriptFactory: () => {
        transcript = new PassThrough();
        return transcript;
      },
    });

    await expect(pending).rejects.toMatchObject({ code: "ENOENT" });
    expect(transcript.destroyed).toBe(true);
  });

  test("a child without stdout still settles when it closes", async () => {
    const workspaceDir = ws();
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = null;
    child.stderr = null;

    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 1000,
      config: fakeConfig,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
      transcriptFactory: () => new PassThrough(),
    });

    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      policyDenials: [],
    });
  });

  test("refuses a definition without verified promptText before launching the ACP agent", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const { promptText, ...unverifiedDef } = defaultDef;

    await expect(
      run(workspaceDir, {
        def: unverifiedDef,
        env: { ACP_FAKE_RECORD: recordFile },
      }),
    ).rejects.toThrow(
      "acp: definition test-acp@1 has no verified promptText (registry-loaded definitions only)",
    );
    expect(existsSync(recordFile)).toBe(false);
  });

  test("session lifecycle uses the verified prompt snapshot after its path changes", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const promptRecord = path.join(workspaceDir, "prompt.txt");
    const replacedPrompt = path.join(workspaceDir, "replaced-prompt.md");
    writeFileSync(replacedPrompt, "mutable replacement", "utf8");
    const traceEvents = [];
    const usageSeen = [];
    const outcome = await run(workspaceDir, {
      def: { ...defaultDef, promptPath: replacedPrompt },
      env: {
        ACP_FAKE_RECORD: recordFile,
        ACP_FAKE_PROMPT_RECORD: promptRecord,
        ANTHROPIC_API_KEY: "sk-must-strip",
        CLAUDECODE: "1",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
      onUsage: (usage) => usageSeen.push(usage),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.policyDenials).toEqual([]);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.cwd).toBe(workspaceDir);
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record.env.CLAUDECODE).toBeUndefined();
    expect(readFileSync(promptRecord, "utf8")).toBe(
      `You are a test agent.${PROMPT_SUFFIX}`,
    );
    expect(existsSync(path.join(workspaceDir, "result.json"))).toBe(true);
    expect(
      readFileSync(path.join(workspaceDir, ".transcript.json"), "utf8"),
    ).toContain("session/update");
    expect(traceEvents.some((e) => e.kind === "assistant_text")).toBe(true);
    expect(traceEvents.some((e) => e.kind === "tool_use")).toBe(true);
    expect(traceEvents.some((e) => e.kind === "tool_result")).toBe(true);
    expect(traceEvents.some((e) => e.kind === "usage")).toBe(true);
    const toolResult = traceEvents.find((e) => e.kind === "tool_result");
    expect(toolResult.payload.diff).toBeDefined();
    expect(usageSeen[0].costUSD).toBe(0.02);
    expect(usageSeen[0].inputTokens).toBe(1200);
  });

  test("workspace-scoped edit is auto-allowed", async () => {
    const workspaceDir = ws();
    await run(workspaceDir, { behavior: "permission_edit", def: mutatingDef });
    const decided = JSON.parse(
      readFileSync(path.join(workspaceDir, "permission.json"), "utf8"),
    );
    expect(decided.outcome).toEqual({
      outcome: "selected",
      optionId: "allow-once",
    });
  });

  test("git execute is auto-allowed on mutating runs; curl fail-closes", async () => {
    const gitDir = ws();
    await run(gitDir, { behavior: "permission_git", def: mutatingDef });
    expect(
      JSON.parse(readFileSync(path.join(gitDir, "permission.json"), "utf8"))
        .outcome.optionId,
    ).toBe("allow-once");

    const curlDir = ws();
    const traces = [];
    const curl = await run(curlDir, {
      behavior: "permission_curl",
      def: mutatingDef,
      onTrace: (kind, payload) => traces.push({ kind, payload }),
    });
    expect(
      JSON.parse(readFileSync(path.join(curlDir, "permission.json"), "utf8"))
        .outcome.optionId,
    ).toBe("reject-once");
    expect(curl.policyDenials).toEqual([]);
    expect(
      traces.some(
        (e) => e.kind === "lifecycle" && e.payload.note === "policy_denial",
      ),
    ).toBe(true);
  });

  test("onPermissionRequest can allow an escalated request", async () => {
    const workspaceDir = ws();
    const seen = [];
    await run(workspaceDir, {
      behavior: "permission_outside",
      def: mutatingDef,
      onPermissionRequest: async (params) => {
        seen.push(params.toolCall.kind);
        return "allow";
      },
    });
    expect(seen).toEqual(["edit"]);
    expect(
      JSON.parse(
        readFileSync(path.join(workspaceDir, "permission.json"), "utf8"),
      ).outcome.optionId,
    ).toBe("allow-once");
  });

  test("missing binary is cli_not_found before spawn", async () => {
    const workspaceDir = ws();
    let caught;
    try {
      await execute({
        spec: defaultSpec,
        def: defaultDef,
        workspaceDir,
        timeoutMs: 1000,
        config: { command: "definitely-not-an-acp-agent-wm937" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliNotFoundError);
    expect(caught.code).toBe("cli_not_found");
  });

  test("protocol version mismatch is a typed refusal", async () => {
    const workspaceDir = ws();
    let caught;
    try {
      await run(workspaceDir, { behavior: "protocol_v2" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AcpProtocolError);
    expect(caught.code).toBe("acp_protocol_mismatch");
  });

  test("authMethods required is a typed refusal — no API key sent", async () => {
    const workspaceDir = ws();
    let caught;
    try {
      await run(workspaceDir, { behavior: "auth_required" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AcpProtocolError);
    expect(caught.code).toBe("acp_auth_required");
  });

  test("timeout sets timedOut and does not throw", async () => {
    const workspaceDir = ws();
    const outcome = await run(workspaceDir, {
      behavior: "hang",
      timeoutMs: 200,
      killGraceMs: 50,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
  });

  test("abort resolves timedOut false, exitCode null", async () => {
    const workspaceDir = ws();
    const ac = new AbortController();
    const pending = run(workspaceDir, {
      behavior: "hang",
      timeoutMs: 10_000,
      killGraceMs: 50,
      abortSignal: ac.signal,
    });
    ac.abort();
    const outcome = await pending;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBeNull();
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace", async () => {
    const workspaceDir = ws();
    const started = Date.now();
    const outcome = await run(workspaceDir, {
      behavior: "ignore_sigterm",
      timeoutMs: 200,
      killGraceMs: 150,
    });
    const elapsed = Date.now() - started;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    // TERM at 200 ms is ignored; only the KILL escalation settles the run.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(4000);
  });

  const testProcessGroup = process.platform === "win32" ? test.skip : test;
  testProcessGroup("timeout kills a long-lived grandchild", async () => {
    const workspaceDir = ws();
    const pidFile = path.join(workspaceDir, "grandchild.pid");
    const pending = run(workspaceDir, {
      behavior: "spawn_grandchild",
      timeoutMs: 400,
      killGraceMs: 200,
      env: { ACP_FAKE_GRANDCHILD_PID: pidFile },
    });
    let pid = null;
    for (let i = 0; i < 200; i += 1) {
      if (existsSync(pidFile)) {
        pid = Number(readFileSync(pidFile, "utf8"));
        trackProcessGroupForPid(pid);
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pid).toBeGreaterThan(0);
    const outcome = await pending;
    expect(outcome.timedOut).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

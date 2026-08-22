import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-hermes-test-mjs";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CliNotFoundError,
  DEFAULT_HERMES_CONFIG,
  HARNESS_LAYOUT,
  KILL_GRACE_MS,
  SANDBOX_SUPPORT,
  execute,
  resolveHermesConfig,
} from "./hermes.mjs";
import { createAdapterRegistry, validateAdapterContract } from "./index.mjs";
import { SandboxUnsupportedError } from "./sandboxed.mjs";
import { processOwnerWatchdogSource } from "../test-helpers-process.mjs";

const tmpBase = tmpDir("evrt-hermes-");
const stubPath = path.join(tmpBase, "fake-hermes-acp.mjs");
const promptPath = path.join(tmpBase, "prompt.md");
writeFileSync(promptPath, "You are a test agent.", "utf8");

// A minimal ACP v1 stdio agent: initialize -> session/new -> session/prompt,
// emitting one assistant_text update and a usage_update before end_turn.
// Behaviors: "happy" (default) and "hang" (never answers session/prompt, so
// the caller's timeout must fire).
writeFileSync(
  stubPath,
  `#!/usr/bin/env bun
import { createInterface } from "node:readline";

${processOwnerWatchdogSource()}

const behavior = process.env.HERMES_FAKE_BEHAVIOR || "happy";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "hermes_sess" } });
    return;
  }
  if (msg.method === "session/prompt") {
    if (behavior === "hang") return;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi from hermes" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "usage_update", used: 10, size: 1000 },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
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

if (behavior === "hang") {
  setInterval(() => {}, 10_000);
}
`,
  { mode: 0o755 },
);

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

const ws = () => realpathSync(tmpDir("ws-", tmpBase));
const defaultDef = { ref: "test-hermes@1", promptPath, mutating: false };
const defaultSpec = { agent: "test-hermes@1", input: {} };
const fakeConfig = { command: process.execPath, args: [stubPath] };

function run(workspaceDir, extra = {}) {
  return execute({
    spec: extra.spec ?? defaultSpec,
    def: extra.def ?? defaultDef,
    workspaceDir,
    timeoutMs: extra.timeoutMs ?? 5000,
    killGraceMs: extra.killGraceMs ?? 200,
    env: {
      HERMES_FAKE_BEHAVIOR: extra.behavior ?? "happy",
      ...(extra.env ?? {}),
    },
    config: extra.config ?? fakeConfig,
    onTrace: extra.onTrace,
    onUsage: extra.onUsage,
    abortSignal: extra.abortSignal,
  });
}

describe("adapter contract", () => {
  test("satisfies WM-837: execute + SANDBOX_SUPPORT unsupported", () => {
    const report = validateAdapterContract("hermes", {
      execute,
      SANDBOX_SUPPORT,
    });
    expect(report.sandboxSupport).toBe("unsupported");
  });

  test("registers cleanly and is sandbox-guarded through the registry", () => {
    const registry = createAdapterRegistry({ builtins: {} });
    registry.register(
      "hermes",
      { execute, SANDBOX_SUPPORT },
      { source: "test" },
    );
    expect(registry.has("hermes")).toBe(true);
  });
});

describe("resolveHermesConfig", () => {
  test("defaults to the shipped ACP binary when nothing is configured", () => {
    expect(resolveHermesConfig({})).toEqual({
      command: DEFAULT_HERMES_CONFIG.command,
      args: [],
      env: {},
    });
  });

  test("prefers explicit config, then spec.hermes, then def.hermes", () => {
    expect(
      resolveHermesConfig({
        config: { command: "explicit" },
        spec: { hermes: { command: "spec-level" } },
        def: { hermes: { command: "def-level" } },
      }).command,
    ).toBe("explicit");
    expect(
      resolveHermesConfig({
        spec: { hermes: { command: "spec-level" } },
        def: { hermes: { command: "def-level" } },
      }).command,
    ).toBe("spec-level");
    expect(
      resolveHermesConfig({ def: { hermes: { command: "def-level" } } })
        .command,
    ).toBe("def-level");
  });

  test("ignores malformed args/env instead of throwing", () => {
    const resolved = resolveHermesConfig({
      config: { command: "x", args: "not-an-array", env: null },
    });
    expect(resolved.args).toEqual([]);
    expect(resolved.env).toEqual({});
  });
});

describe("execute: sandbox refusal", () => {
  test("a sandboxed definition is refused before anything spawns", async () => {
    const workspaceDir = ws();
    const def = {
      ...defaultDef,
      sandbox: { provider: "gondolin", allowedHosts: [] },
    };
    let caught = null;
    try {
      await run(workspaceDir, { def });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnsupportedError);
    expect(caught.adapter).toBe("hermes");
    expect(caught.code).toBe("sandbox_unsupported");
    expect(existsSync(path.join(workspaceDir, ".transcript.json"))).toBe(false);
  });
});

describe("execute: delegates to the ACP engine", () => {
  test("happy path spawns the configured binary and reports success", async () => {
    const workspaceDir = ws();
    const trace = [];
    const usages = [];
    const result = await run(workspaceDir, {
      onTrace: (kind, payload) => trace.push({ kind, payload }),
      onUsage: (u) => usages.push(u),
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(
      trace.find(
        (t) =>
          t.kind === "assistant_text" && t.payload.text === "hi from hermes",
      ),
    ).toBeTruthy();
    expect(usages.length).toBeGreaterThan(0);
  });

  test("timeout sends TERM then KILL and reports timedOut", async () => {
    const workspaceDir = ws();
    const result = await run(workspaceDir, {
      behavior: "hang",
      timeoutMs: 200,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test("CLI not found is rewrapped with a hermes-specific message", async () => {
    const workspaceDir = ws();
    let caught = null;
    try {
      await run(workspaceDir, {
        config: { command: "definitely-not-a-real-hermes-binary" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliNotFoundError);
    expect(caught.message).toContain("definitely-not-a-real-hermes-binary");
    expect(caught.message).toContain("Hermes");
  });
});

describe("HARNESS_LAYOUT / KILL_GRACE_MS", () => {
  test("packages commands and subagents under .hermes/", () => {
    expect(HARNESS_LAYOUT.commands.dest("plan")).toEqual([
      ".hermes",
      "commands",
      "plan.md",
    ]);
    expect(HARNESS_LAYOUT.subagents.dest("reviewer")).toEqual([
      ".hermes",
      "agents",
      "reviewer.md",
    ]);
  });

  test("KILL_GRACE_MS matches the shared ACP/claude convention", () => {
    expect(typeof KILL_GRACE_MS).toBe("number");
    expect(KILL_GRACE_MS).toBeGreaterThan(0);
  });
});

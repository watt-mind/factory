/**
 * ACP (Agent Client Protocol) harness adapter (WM-937).
 *
 * Speaks ACP v1 as newline-delimited JSON-RPC 2.0 over stdio
 * (https://agentclientprotocol.com/protocol/v1). Config is
 * `{ command, args, env }` with `claude-code-acp` as the shipped default, so
 * any ACP agent is a factory harness without a per-CLI stdout parser.
 *
 * Spike scope: session lifecycle, `session/update` folding into
 * factory.trace/v1, a closed permission auto-allow plus fail-closed escalate,
 * and the same TERM→KILL / subscription-auth conventions as claude.mjs.
 * Sandbox is refused (`SANDBOX_SUPPORT = "unsupported"`): the first target
 * wraps Claude Code on host OAuth, and there is no guest translation yet.
 *
 * Not yet in `builtinAdapters()` — `index.mjs` is outside this ticket's
 * Owned Paths. Tests register the module through `createAdapterRegistry`.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  HARNESS_LAYOUT as CLAUDE_HARNESS_LAYOUT,
  KILL_GRACE_MS as CLAUDE_KILL_GRACE_MS,
  PROMPT_SUFFIX,
  PUSH_CREDENTIAL_ENV,
  killProcessGroup,
  safeChildEnvironment,
  verifiedPrompt,
} from "./claude.mjs";
import { refuseSandbox } from "./sandboxed.mjs";

export { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV, killProcessGroup };

/** ACP v1 major version. Agents that answer anything else are refused. */
export const PROTOCOL_VERSION = 1;

export const KILL_GRACE_MS = CLAUDE_KILL_GRACE_MS;

export const SANDBOX_SUPPORT = "unsupported";

export const SANDBOX_DEFERRAL_REASON =
  "acp wraps host-authenticated coding agents (first target: claude-code-acp) whose binary, subscription OAuth, and permission surface have no Gondolin guest translation yet (WM-313 deferral; see lib/adapters/acp.mjs)";

/**
 * First target is Claude Code via ACP, so harness packaging matches claude.
 * Not part of the WM-837 contract.
 */
export const HARNESS_LAYOUT = CLAUDE_HARNESS_LAYOUT;

/** Shipped default — the Zed `claude-code-acp` binary on PATH. */
export const DEFAULT_ACP_CONFIG = Object.freeze({
  command: "claude-code-acp",
  args: Object.freeze([]),
  env: Object.freeze({}),
});

/**
 * Commands auto-allowed on mutating runs when `kind === "execute"`.
 * Basename of the first token must match. Empty on `mutating: false`.
 */
export const DEFAULT_ALLOW_COMMANDS = Object.freeze([
  "bun",
  "git",
  "gh",
  "node",
  "npm",
  "npx",
]);

export const CLIENT_INFO = Object.freeze({
  name: "factory-acp",
  title: "Watt Mind Factory",
  version: "0.0.0",
});

const TEXT_PREVIEW_CHARS = 4000;
const STDERR_FILE_CHARS = 16_384;

export class CliNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliNotFoundError";
    this.code = "cli_not_found";
  }
}

export class AcpProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "AcpProtocolError";
    this.code = code;
  }
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS
    ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]`
    : s;
}

/**
 * Merge `{ command, args, env }` from execute options, then spec/def, then
 * the shipped default.
 */
export function resolveAcpConfig({ spec, def, config } = {}) {
  const raw = config ?? spec?.acp ?? def?.acp ?? {};
  const command =
    typeof raw.command === "string" && raw.command !== ""
      ? raw.command
      : DEFAULT_ACP_CONFIG.command;
  const args = Array.isArray(raw.args)
    ? raw.args.map(String)
    : [...DEFAULT_ACP_CONFIG.args];
  const env =
    raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
      ? { ...raw.env }
      : {};
  return { command, args, env };
}

/**
 * Resolve the agent binary. Absolute paths must exist; names go through
 * `which`. Returns null when missing so execute() can throw CliNotFoundError.
 */
export function resolveAcpCommand(config, { which = Bun.which, pathEnv } = {}) {
  const command = config?.command;
  if (typeof command !== "string" || command === "") return null;
  const args = Array.isArray(config.args) ? config.args : [];
  if (path.isAbsolute(command)) {
    return existsSync(command) ? { command, args } : null;
  }
  const found =
    typeof pathEnv === "string"
      ? which(command, { PATH: pathEnv })
      : which(command);
  if (!found) return null;
  return { command: found, args };
}

function writeRpc(stream, obj) {
  if (!stream || stream.destroyed || stream.writableEnded) return;
  stream.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Newline-delimited JSON-RPC 2.0 over a child stdin/stdout pair
 * (ACP stdio transport).
 */
export function createAcpRpc({ stdin, stdout, onRequest, onNotification }) {
  let nextId = 1;
  const pending = new Map();
  const rl = createInterface({ input: stdout });

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (
      typeof msg.method === "string" &&
      msg.id !== undefined &&
      msg.id !== null
    ) {
      onRequest?.(msg);
      return;
    }
    if (typeof msg.method === "string") {
      onNotification?.(msg);
      return;
    }
    if (msg.id === undefined || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      const err = new AcpProtocolError(
        "acp_rpc_error",
        msg.error.message ?? "ACP JSON-RPC error",
      );
      err.rpcError = msg.error;
      waiter.reject(err);
    } else {
      waiter.resolve(msg.result);
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          writeRpc(stdin, { jsonrpc: "2.0", id, method, params });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    notify(method, params) {
      writeRpc(stdin, { jsonrpc: "2.0", method, params });
    },
    respond(id, result) {
      writeRpc(stdin, { jsonrpc: "2.0", id, result });
    },
    respondError(id, error) {
      writeRpc(stdin, { jsonrpc: "2.0", id, error });
    },
    rejectAll(err) {
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    },
    close() {
      try {
        rl.close();
      } catch {
        // already closed
      }
    },
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && content.type === "text") {
    return content.text ?? "";
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "content") return contentText(block.content);
        if (block?.type === "diff") {
          return `diff ${block.path ?? ""}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function firstDiff(content) {
  if (!Array.isArray(content)) return null;
  const diff = content.find((block) => block?.type === "diff");
  if (!diff) return null;
  return {
    path: diff.path ?? null,
    oldText: clip(diff.oldText ?? ""),
    newText: clip(diff.newText ?? ""),
  };
}

/**
 * Map one ACP `session/update` payload to factory.trace/v1 events. Pure.
 * Unknown update kinds yield an empty array — never fatal.
 *
 * @param {any} update
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapSessionUpdate(update) {
  if (!update || typeof update !== "object") return [];
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = contentText(update.content);
    return text
      ? [{ kind: "assistant_text", payload: { text: clip(text) } }]
      : [];
  }
  if (kind === "tool_call") {
    return [
      {
        kind: "tool_use",
        payload: {
          id: update.toolCallId ?? null,
          name: update.kind || update.title || "tool",
          input: update.rawInput ?? {},
          title: update.title ?? null,
        },
      },
    ];
  }
  if (kind === "tool_call_update") {
    const status = update.status;
    if (status !== "completed" && status !== "failed") return [];
    const content = Array.isArray(update.content) ? update.content : [];
    const payload = {
      content: clip(contentText(content) || contentText(update.rawOutput)),
      toolUseId: update.toolCallId ?? null,
    };
    if (status === "failed") payload.isError = true;
    const diff = firstDiff(content);
    if (diff) payload.diff = diff;
    return [{ kind: "tool_result", payload }];
  }
  if (kind === "usage_update") {
    const usage = {};
    if (typeof update.used === "number") usage.used = update.used;
    if (typeof update.size === "number") usage.size = update.size;
    const amount = update.cost?.amount;
    const currency = update.cost?.currency;
    return [
      {
        kind: "usage",
        payload: {
          durationMs: null,
          numTurns: null,
          costUSD:
            typeof amount === "number" && currency === "USD" ? amount : null,
          usage,
        },
      },
    ];
  }
  return [];
}

export function usageFromUpdate(update) {
  if (!update || update.sessionUpdate !== "usage_update") return null;
  const amount = update.cost?.amount;
  const currency = update.cost?.currency;
  return {
    inputTokens: typeof update.used === "number" ? update.used : null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    contextSize: typeof update.size === "number" ? update.size : null,
    costUSD: typeof amount === "number" && currency === "USD" ? amount : null,
  };
}

function collectPaths(toolCall) {
  const paths = [];
  if (typeof toolCall?.path === "string") paths.push(toolCall.path);
  if (Array.isArray(toolCall?.locations)) {
    for (const loc of toolCall.locations) {
      if (typeof loc?.path === "string") paths.push(loc.path);
    }
  }
  const raw = toolCall?.rawInput;
  if (raw && typeof raw === "object") {
    for (const key of ["path", "file", "file_path", "filePath"]) {
      if (typeof raw[key] === "string") paths.push(raw[key]);
    }
  }
  return paths;
}

export function isInsideWorkspace(filePath, workspaceDir) {
  if (typeof filePath !== "string" || filePath === "") return false;
  if (typeof workspaceDir !== "string" || workspaceDir === "") return false;
  const root = path.resolve(workspaceDir);
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export function commandBasename(command) {
  if (typeof command !== "string") return "";
  const token = command.trim().split(/\s+/)[0] ?? "";
  return token ? path.basename(token) : "";
}

/**
 * Closed permission policy for unattended runs.
 *
 * @returns {"allow" | "reject" | "escalate"}
 */
export function decidePermission(params, policy = {}) {
  const toolCall = params?.toolCall ?? params ?? {};
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const workspaceDir = policy.workspaceDir;
  const allowCommands = Array.isArray(policy.allowCommands)
    ? policy.allowCommands
    : [];

  if (kind === "read" || kind === "search" || kind === "think") return "allow";

  if (kind === "edit" || kind === "delete" || kind === "move") {
    if (policy.allowWorkspaceEdits === false) return "escalate";
    const paths = collectPaths(toolCall);
    if (paths.length === 0) return "escalate";
    return paths.every((p) => isInsideWorkspace(p, workspaceDir))
      ? "allow"
      : "escalate";
  }

  if (kind === "execute") {
    const command =
      toolCall.rawInput?.command ??
      toolCall.rawInput?.cmd ??
      toolCall.title ??
      "";
    const base = commandBasename(command);
    return base && allowCommands.includes(base) ? "allow" : "escalate";
  }

  return "escalate";
}

/**
 * Pick a JSON-RPC result for `session/request_permission`.
 * Prefers once-only options so a spike run does not persist always-allow.
 */
export function selectPermissionOption(options, intent) {
  if (intent === "cancel") return { outcome: { outcome: "cancelled" } };
  const list = Array.isArray(options) ? options : [];
  const kinds =
    intent === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  const opt = kinds
    .map((kind) => list.find((o) => o?.kind === kind))
    .find(Boolean);
  if (!opt?.optionId) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: opt.optionId } };
}

export function permissionPolicyFor(def, { workspaceDir, allowCommands } = {}) {
  const mutating = def?.mutating !== false;
  return {
    workspaceDir,
    allowWorkspaceEdits: true,
    allowCommands: Array.isArray(allowCommands)
      ? allowCommands
      : mutating
        ? [...DEFAULT_ALLOW_COMMANDS]
        : [],
  };
}

function stopReasonExit(stopReason) {
  if (stopReason === "end_turn") return 0;
  if (stopReason === "cancelled") return null;
  return 1;
}

function emitTrace(onTrace, event) {
  try {
    onTrace?.(event.kind, event.payload);
  } catch {
    // observability must not fail the child
  }
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, policyDenials?: object[], usage?: object }>}
 */
export async function execute({
  spec,
  def,
  workspaceDir,
  timeoutMs,
  killGraceMs = KILL_GRACE_MS,
  env = {},
  config,
  onTrace,
  onUsage,
  onPermissionRequest,
  resume = null,
  abortSignal,
  signal,
}) {
  refuseSandbox("acp", def, SANDBOX_DEFERRAL_REASON);

  const prompt = verifiedPrompt(def, "acp");
  const acpConfig = resolveAcpConfig({ spec, def, config });
  const childEnv = safeChildEnvironment({ ...acpConfig.env, ...env }, def);
  const resolved = resolveAcpCommand(acpConfig, {
    which: (name) =>
      Bun.which(name, { PATH: childEnv.PATH ?? process.env.PATH }),
    pathEnv: childEnv.PATH ?? process.env.PATH,
  });
  if (!resolved) {
    throw new CliNotFoundError(
      `ACP agent "${acpConfig.command}" is not on PATH — install @zed-industries/claude-code-acp or pass config.command (docs/event-runtime-workers.md §2c)`,
    );
  }

  const policy = permissionPolicyFor(def, { workspaceDir });
  const argv = [...resolved.args];

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, argv, {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.stdin?.on("error", () => {});

    const transcript = createWriteStream(
      path.join(workspaceDir, ".transcript.json"),
    );
    transcript.on("error", () => {});
    // Child close only says its stdio handles are closed; the file stream may
    // still have buffered bytes. Register before piping so a fast child cannot
    // finish before we can observe the output flush.
    const transcriptClosed = new Promise((done) => {
      transcript.once("finish", done);
      transcript.once("close", done);
    });
    if (child.stdout) child.stdout.pipe(transcript);

    let stderrBuf = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf = (stderrBuf + chunk).slice(-STDERR_FILE_CHARS);
      });
    }

    const policyDenials = [];
    const pendingPermissionIds = new Set();
    let lastUsage = null;
    let sessionId = null;
    let sessionOutcome = null;
    let handshakeError = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    let cancelledPermissions = false;

    const finishHandshakeError = (err) => {
      if (handshakeError || sessionOutcome) return;
      handshakeError = err;
    };

    const cancelPendingPermissions = () => {
      if (cancelledPermissions) return;
      cancelledPermissions = true;
      for (const id of pendingPermissionIds) {
        try {
          rpc.respond(id, selectPermissionOption([], "cancel"));
        } catch {
          // child already gone
        }
      }
      pendingPermissionIds.clear();
    };

    const onAbortOrTimeout = (asTimeout) => {
      if (asTimeout) timedOut = true;
      else aborted = true;
      if (sessionId) {
        try {
          rpc.notify("session/cancel", { sessionId });
        } catch {
          // ignore
        }
      }
      cancelPendingPermissions();
      killProcessGroup(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(
          () => killProcessGroup(child, "SIGKILL"),
          killGraceMs,
        );
        killTimer.unref?.();
      }
    };

    const rpc = createAcpRpc({
      stdin: child.stdin,
      stdout: child.stdout,
      onNotification: (msg) => {
        if (msg.method !== "session/update") return;
        const update = msg.params?.update;
        for (const event of mapSessionUpdate(update)) {
          emitTrace(onTrace, event);
        }
        const usage = usageFromUpdate(update);
        if (usage) {
          lastUsage = usage;
          try {
            onUsage?.(usage);
          } catch {
            // observability
          }
        }
      },
      onRequest: (msg) => {
        if (msg.method !== "session/request_permission") {
          rpc.respondError(msg.id, {
            code: -32601,
            message: `method not found: ${msg.method}`,
          });
          return;
        }
        pendingPermissionIds.add(msg.id);
        Promise.resolve()
          .then(async () => {
            const decision = decidePermission(msg.params, policy);
            let intent = decision;
            if (decision === "escalate") {
              if (typeof onPermissionRequest === "function") {
                const answer = await onPermissionRequest(msg.params, {
                  workspaceDir,
                  def,
                });
                intent =
                  typeof answer === "string"
                    ? answer
                    : (answer?.intent ?? "reject");
                if (answer && typeof answer === "object" && answer.outcome) {
                  pendingPermissionIds.delete(msg.id);
                  rpc.respond(msg.id, { outcome: answer.outcome });
                  return;
                }
              } else {
                intent = "reject";
                const tool =
                  msg.params?.toolCall?.kind ||
                  msg.params?.toolCall?.title ||
                  "unknown";
                const denial = {
                  tool,
                  rule: clip(
                    `ACP permission escalated and fail-closed: ${tool}`,
                  ),
                };
                policyDenials.push(denial);
                emitTrace(onTrace, {
                  kind: "lifecycle",
                  payload: { note: "policy_denial", ...denial },
                });
              }
            }
            pendingPermissionIds.delete(msg.id);
            rpc.respond(
              msg.id,
              selectPermissionOption(msg.params?.options, intent),
            );
          })
          .catch((err) => {
            pendingPermissionIds.delete(msg.id);
            rpc.respondError(msg.id, {
              code: -32000,
              message: err?.message ?? "permission handler failed",
            });
          });
      },
    });

    const runSession = async () => {
      const init = await rpc.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: CLIENT_INFO,
        clientCapabilities: {},
      });
      const answeredVersion = init?.protocolVersion;
      if (Number(answeredVersion) !== PROTOCOL_VERSION) {
        throw new AcpProtocolError(
          "acp_protocol_mismatch",
          `ACP agent negotiated protocolVersion ${JSON.stringify(answeredVersion)}, factory pins ${PROTOCOL_VERSION}`,
        );
      }
      if (Array.isArray(init?.authMethods) && init.authMethods.length > 0) {
        throw new AcpProtocolError(
          "acp_auth_required",
          "ACP agent requires authenticate(); factory uses host subscription auth and will not send API keys (same rule as the claude adapter)",
        );
      }

      const cwd = path.resolve(workspaceDir);
      const resumeId =
        typeof resume?.sessionId === "string" && resume.sessionId
          ? resume.sessionId
          : null;
      const canResume = Boolean(
        init?.agentCapabilities?.sessionCapabilities?.resume,
      );
      const canLoad = init?.agentCapabilities?.loadSession === true;
      if (resumeId && canResume) {
        await rpc.request("session/resume", {
          sessionId: resumeId,
          cwd,
          mcpServers: [],
        });
        sessionId = resumeId;
      } else if (resumeId && canLoad) {
        await rpc.request("session/load", {
          sessionId: resumeId,
          cwd,
          mcpServers: [],
        });
        sessionId = resumeId;
      } else {
        const created = await rpc.request("session/new", {
          cwd,
          mcpServers: [],
        });
        sessionId = created?.sessionId;
      }
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new AcpProtocolError(
          "acp_session_failed",
          "ACP agent did not return a sessionId from session/new",
        );
      }

      const promptResult = await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      return {
        sessionId,
        stopReason: promptResult?.stopReason ?? "end_turn",
      };
    };

    runSession()
      .then((outcome) => {
        sessionOutcome = outcome;
        try {
          child.stdin?.end();
        } catch {
          // already closed
        }
        if (!timedOut && !killTimer) {
          killProcessGroup(child, "SIGTERM");
          killTimer = setTimeout(
            () => killProcessGroup(child, "SIGKILL"),
            killGraceMs,
          );
          killTimer.unref?.();
        }
      })
      .catch((err) => {
        finishHandshakeError(err);
        cancelPendingPermissions();
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        killProcessGroup(child, "SIGTERM");
        if (!killTimer) {
          killTimer = setTimeout(
            () => killProcessGroup(child, "SIGKILL"),
            killGraceMs,
          );
          killTimer.unref?.();
        }
      });

    const termTimer = setTimeout(() => onAbortOrTimeout(true), timeoutMs);

    const onAbort = () => onAbortOrTimeout(false);
    const abortSig = abortSignal ?? signal;
    if (abortSig) {
      if (abortSig.aborted) onAbort();
      else abortSig.addEventListener("abort", onAbort, { once: true });
    }

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
      cancelPendingPermissions();
      rpc.rejectAll(new Error("ACP child closed"));
      rpc.close();
      transcript.destroy();
      fn(value);
    };

    child.on("error", (err) => {
      settle(reject, err);
    });
    child.on("close", async (exitCode) => {
      if (handshakeError && !timedOut && !aborted) {
        settle(reject, handshakeError);
        return;
      }
      if (stderrBuf && exitCode !== 0) {
        try {
          writeFileSync(
            path.join(workspaceDir, ".stderr.txt"),
            stderrBuf,
            "utf8",
          );
        } catch {
          // best-effort
        }
      }
      const stopExit = sessionOutcome
        ? stopReasonExit(sessionOutcome.stopReason)
        : exitCode;
      const finalExit =
        timedOut || aborted ? null : stopExit === null ? exitCode : stopExit;
      const usage = lastUsage ?? undefined;
      try {
        if (usage) onUsage?.(usage);
      } catch {
        // observability
      }
      await transcriptClosed;
      settle(resolve, {
        exitCode: finalExit,
        timedOut,
        policyDenials: finalExit === 0 ? [] : policyDenials,
        ...(usage ? { usage } : {}),
      });
    });
  });
}

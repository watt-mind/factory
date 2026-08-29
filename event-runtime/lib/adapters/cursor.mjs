/**
 * Cursor Agent CLI adapter (docs/event-runtime.md §6, §14; WM-440) — a fourth
 * LLM harness alongside `claude`, `pi`, and `agy`. Spawns a bounded
 * `agent -p --output-format stream-json` process (prompt as a positional
 * argument, the standard `./input.json` → `./result.json` PROMPT_SUFFIX
 * contract, cwd = workspace), enforces the run spec's timeout with
 * TERM→KILL(killGraceMs), strips provider API keys and `CURSOR_API_ENDPOINT`,
 * passes `CURSOR_API_KEY` through (`agent -p` does not consume the login
 * session — WM-443), captures full stdout as the `.transcript.json` artifact,
 * and on a non-zero exit writes `.stderr.txt` plus a `lifecycle` trace.
 *
 * Flags confirmed against the installed CLI (`agent` 2026.08.11,
 * `agent --help`), not inferred from Claude/Pi:
 *   - `-p/--print` is a boolean; the prompt is a trailing positional
 *   - `--output-format stream-json` is NDJSON (do not pass
 *     `--stream-partial-output` — those deltas would double-emit)
 *   - `--trust` skips the workspace prompt (unattended)
 *   - `--force` is required to *apply* writes; print without it only
 *     proposes them. `--mode ask|plan` is documented no-edits and would
 *     fail the result contract (OPS-518), so it is never passed. Read-only
 *     containment is the workspace cwd plus the worker integrity gate.
 *   - `--worktree` is Cursor's own worktree feature — never passed; the
 *     factory owns workspaces.
 *
 * Binary: `agent` on PATH, else `cursor-agent`. Not `cursor` — that is the
 * editor CLI.
 */
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { FACTORY_ROOT } from "../config.mjs";
import { DEFAULT_MODEL } from "../registry.mjs";
import { PROMPT_SUFFIX, verifiedPrompt } from "./claude.mjs";
import {
  BASE_INHERITED_ENV as SHARED_BASE_INHERITED_ENV,
  PROVIDER_CREDENTIAL_ENV,
  PUSH_CREDENTIAL_ENV,
  RUNTIME_IDENTITY_ENV,
  safeChildEnvironment as sharedSafeChildEnvironment,
} from "./child-env.mjs";
import { refuseSandbox } from "./sandboxed.mjs";

export {
  PROVIDER_CREDENTIAL_ENV,
  PROMPT_SUFFIX,
  PUSH_CREDENTIAL_ENV,
  RUNTIME_IDENTITY_ENV,
};

/**
 * No guest execution path exists for this adapter (WM-313): a sandboxed
 * definition is refused, not run on the host. See lib/adapters/sandboxed.mjs.
 */
export const SANDBOX_SUPPORT = "unsupported";
const SANDBOX_REFUSAL_REASON =
  "the Cursor Agent CLI has no guest execution path yet — its binary and CURSOR_API_KEY transport have not been translated to the microVM";

/**
 * Workspace-relative packaging of RunSpec.harness (WM-851). Cursor emit has
 * commands and agents, not skills — a spec that names skills is refused
 * `harness_unsupported` by the worker rather than silently dropped.
 */
export const HARNESS_LAYOUT = Object.freeze({
  commands: Object.freeze({
    source: (name) => ["dist", "cursor", "commands", `${name}.md`],
    dest: (name) => [".cursor", "commands", `${name}.md`],
    type: "file",
  }),
  subagents: Object.freeze({
    source: (name) => ["dist", "cursor", "agents", `${name}.md`],
    dest: (name) => [".cursor", "agents", `${name}.md`],
    type: "file",
  }),
});

export const KILL_GRACE_MS = 30_000;

/** Terminate a detached CLI and every subprocess it started (WM-263). */
export function killProcessGroup(
  child,
  signal = "SIGTERM",
  kill = process.kill,
) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already terminated
    }
  }
}

const TEXT_PREVIEW_CHARS = 4000;

export class CliNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliNotFoundError";
    this.code = "cli_not_found";
  }
}

/**
 * Resolve the Cursor Agent CLI: `agent` on PATH, else `cursor-agent`.
 * `which` is injectable for tests; defaults to `Bun.which` scoped to the
 * child's PATH. The `cursor` editor binary is deliberately not a fallback.
 */
export function resolveCursorCommand({ which = Bun.which } = {}) {
  if (which("agent")) return { command: "agent", args: [] };
  if (which("cursor-agent")) return { command: "cursor-agent", args: [] };
  return null;
}

/**
 * Build argv for spawning the Cursor Agent CLI.
 * `-p` is a boolean; the prompt is a positional after `--` so a prompt that
 * starts with `-` cannot be parsed as a flag.
 */
export function buildCursorArgv({ prompt, model }) {
  const args = ["-p", "--output-format", "stream-json", "--trust", "--force"];
  if (typeof model === "string" && model !== "" && model !== DEFAULT_MODEL) {
    args.push("--model", model);
  }
  args.push("--", prompt);
  return args;
}

export const BASE_INHERITED_ENV = [
  ...SHARED_BASE_INHERITED_ENV,
  // `agent -p` ignores the login session and requires this Cursor user key
  // (WM-443). It authenticates as the account and bills the user's plan —
  // not a provider BYOK key. Still strip CURSOR_API_ENDPOINT below.
  "CURSOR_API_KEY",
];

/**
 * Keep untrusted model subprocesses from inheriting the worker's authority.
 * Fail-closed: only an explicit `mutating: true` (or a boolean `true`)
 * inherits push credentials (pi's rule, not Claude's legacy).
 *
 * `CURSOR_API_KEY` is passed through: CLI 2026.08.11 `agent -p` does not
 * use the `agent login` session (WM-443). Provider keys and
 * `CURSOR_API_ENDPOINT` stay stripped.
 */
export function safeChildEnvironment(env = {}, defOrOpts = {}) {
  const cursorEnv = { ...env };
  if (
    !Object.hasOwn(cursorEnv, "CURSOR_API_KEY") &&
    process.env.CURSOR_API_KEY !== undefined
  ) {
    cursorEnv.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
  }
  return sharedSafeChildEnvironment(cursorEnv, defOrOpts, {
    factoryRoot: FACTORY_ROOT,
    extraStrip: ["CURSOR_API_ENDPOINT"],
  });
}

/** No confirmed Cursor-authored refusal shape yet (WM-127). */
export const HARNESS_DENIAL_PATTERNS = [];

export function isHarnessDenial(content) {
  return (
    typeof content === "string" &&
    HARNESS_DENIAL_PATTERNS.some((re) => re.test(content))
  );
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS
    ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]`
    : s;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  }
  return "";
}

/** `readToolCall` → `read`; unknown keys stay as-is, lowercased first letter. */
export function toolNameFromKey(key) {
  if (typeof key !== "string" || key === "") return "tool";
  const base = key.endsWith("ToolCall") ? key.slice(0, -8) : key;
  if (!base) return "tool";
  return base[0].toLowerCase() + base.slice(1);
}

export function describeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object")
    return { name: "tool", input: {} };
  if (toolCall.function && typeof toolCall.function === "object") {
    let args = toolCall.function.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // keep the raw string — some tools send non-JSON arguments
      }
    }
    return { name: toolCall.function.name ?? "tool", input: args ?? {} };
  }
  const key = Object.keys(toolCall)[0];
  if (!key) return { name: "tool", input: {} };
  return { name: toolNameFromKey(key), input: toolCall[key]?.args ?? {} };
}

function toolResultPayload(msg) {
  const toolCall = msg.tool_call ?? {};
  const inner = toolCall.function ?? Object.values(toolCall)[0] ?? {};
  const result = inner.result ?? {};
  const id = msg.call_id ?? null;
  if (result.success !== undefined) {
    const success = result.success;
    const content =
      typeof success?.content === "string"
        ? success.content
        : JSON.stringify(success ?? {});
    return { content: clip(content), toolUseId: id };
  }
  if (result.error !== undefined) {
    const content =
      typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
    return { content: clip(content), toolUseId: id, isError: true };
  }
  return { content: "", toolUseId: id };
}

/**
 * Map one parsed `agent --output-format stream-json` line to factory.trace/v1.
 * Pure. Skip `--stream-partial-output` deltas (`timestamp_ms` present) so a
 * future flag flip cannot double-emit. Confirmed shapes from
 * https://cursor.com/docs/cli/reference/output-format.md and the installed CLI.
 *
 * @param {any} msg
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapStreamEvent(msg) {
  if (!msg || typeof msg !== "object") return [];

  if (msg.type === "assistant") {
    if (msg.timestamp_ms != null) return [];
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events = [];
    for (const block of blocks) {
      if (block?.type === "text" && block.text) {
        events.push({
          kind: "assistant_text",
          payload: { text: clip(block.text) },
        });
      }
    }
    return events;
  }

  if (msg.type === "tool_call" && msg.subtype === "started") {
    const { name, input } = describeToolCall(msg.tool_call);
    return [
      { kind: "tool_use", payload: { id: msg.call_id ?? null, name, input } },
    ];
  }

  if (msg.type === "tool_call" && msg.subtype === "completed") {
    const payload = toolResultPayload(msg);
    return [{ kind: "tool_result", payload }];
  }

  return [];
}

/** Terminal `result` usage, or null. Cursor's documented result has duration, not tokens. */
export function extractUsage(msg) {
  if (!msg || msg.type !== "result") return null;
  return {
    usage: {},
    costUSD: null,
    durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : null,
    isError: msg.is_error === true,
  };
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, policyDenials?: object[] }>}
 */
export async function execute({
  spec,
  def,
  workspaceDir,
  timeoutMs,
  killGraceMs = KILL_GRACE_MS,
  env = {},
  onTrace,
  onUsage,
  abortSignal,
  signal,
}) {
  refuseSandbox("cursor", def, SANDBOX_REFUSAL_REASON);
  const prompt = verifiedPrompt(def, "cursor");
  const childEnv = safeChildEnvironment(env, def);

  const resolved = resolveCursorCommand({
    which: (name) => Bun.which(name, { PATH: childEnv.PATH ?? "" }),
  });
  if (!resolved) {
    throw new CliNotFoundError(
      "neither agent nor cursor-agent is on PATH — install the Cursor Agent CLI (docs/event-runtime.md §6)",
    );
  }
  const argv = [
    ...resolved.args,
    ...buildCursorArgv({ prompt, model: spec?.model }),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, argv, {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

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
    if (child.stdout) {
      child.stdout.pipe(transcript);
    }

    const STDERR_FILE_CHARS = 16_384;
    let stderrBuf = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf = (stderrBuf + chunk).slice(-STDERR_FILE_CHARS);
      });
    }

    const policyDenials = [];
    let lastTool = null;
    const toolNames = new Map();
    let observedModel = null;
    let finalUsage = null;
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        try {
          if (
            parsed?.type === "system" &&
            parsed?.subtype === "init" &&
            typeof parsed.model === "string"
          ) {
            observedModel = parsed.model;
          }
          const usageInfo = extractUsage(parsed);
          if (usageInfo) finalUsage = usageInfo;
          for (const event of mapStreamEvent(parsed)) {
            if (event.kind === "tool_use") {
              lastTool = event.payload?.name ?? null;
              if (event.payload?.id) toolNames.set(event.payload.id, lastTool);
            }
            onTrace?.(event.kind, event.payload);
            const content =
              typeof event.payload?.content === "string"
                ? event.payload.content
                : "";
            if (
              event.kind === "tool_result" &&
              event.payload?.isError &&
              isHarnessDenial(content)
            ) {
              const denial = {
                tool:
                  toolNames.get(event.payload?.toolUseId) ??
                  lastTool ??
                  "unknown",
                rule: clip(content),
              };
              policyDenials.push(denial);
              onTrace?.("lifecycle", { note: "policy_denial", ...denial });
            }
          }
        } catch {
          // a recorder failure must never fail the run
        }
      });
    }

    let timedOut = false;
    let killTimer = null;
    const termTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        killGraceMs,
      );
      killTimer.unref?.();
    }, timeoutMs);

    const onAbort = () => {
      killProcessGroup(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(
          () => killProcessGroup(child, "SIGKILL"),
          killGraceMs,
        );
        killTimer.unref?.();
      }
    };
    const abortSig = abortSignal ?? signal;
    if (abortSig) {
      if (abortSig.aborted) {
        onAbort();
      } else {
        abortSig.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
      transcript.destroy();
      reject(err);
    });
    child.on("close", async (exitCode) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
      try {
        onUsage?.({
          model: observedModel,
          durationMs: finalUsage?.durationMs ?? null,
          costUSD: finalUsage?.costUSD ?? null,
        });
      } catch {
        // Usage is observability: a consumer failure must not change execution.
      }
      try {
        onTrace?.("usage", {
          durationMs: finalUsage?.durationMs ?? null,
          numTurns: null,
          costUSD: finalUsage?.costUSD ?? null,
          usage: finalUsage?.usage ?? {},
        });
      } catch {
        // same
      }
      await transcriptClosed;
      if (exitCode !== 0 && stderrBuf) {
        try {
          writeFileSync(
            path.join(workspaceDir, ".stderr.txt"),
            stderrBuf,
            "utf8",
          );
        } catch {
          // workspace may already be gone; trace still carries the tail
        }
        try {
          onTrace?.("lifecycle", {
            note: "adapter_stderr",
            text: clip(stderrBuf),
          });
        } catch {
          // observability
        }
      }
      resolve({
        exitCode,
        timedOut,
        policyDenials: exitCode === 0 ? [] : policyDenials,
      });
    });
  });
}

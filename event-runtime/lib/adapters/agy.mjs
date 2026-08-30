/**
 * agy (Antigravity) CLI adapter (docs/event-runtime.md §6, §14; WM-424) — the
 * third LLM harness alongside `claude` and `pi`, on the Antigravity/Gemini
 * subscription and Google Cloud authentication window.
 *
 * Spawns a bounded `agy -p <prompt> --output-format stream-json --dangerously-skip-permissions`
 * process (the prompt travels as an argv value and stdin is closed, the standard
 * `./input.json` → `./result.json` PROMPT_SUFFIX contract, cwd = workspace),
 * enforces the run spec's timeout with
 * TERM→KILL(killGraceMs), strips API keys so the CLI authenticates against the
 * session/subscription instead of per-token billing, captures full stdout as
 * the `.transcript.json` artifact, and preserves a bounded stderr tail for
 * failed runs.
 */
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { killProcessGroup } from "./child-process.mjs";
import { PROMPT_SUFFIX, verifiedPrompt } from "./claude.mjs";
import { FACTORY_ROOT } from "../config.mjs";
import {
  BASE_INHERITED_ENV,
  PROVIDER_CREDENTIAL_ENV,
  PUSH_CREDENTIAL_ENV,
  RUNTIME_IDENTITY_ENV,
  safeChildEnvironment as sharedSafeChildEnvironment,
} from "./child-env.mjs";
import { refuseSandbox } from "./sandboxed.mjs";

export {
  BASE_INHERITED_ENV,
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
  "the agy CLI has no guest execution path yet — its binary, Google Cloud/Antigravity auth, and prompt transport have not been translated to the microVM";

/**
 * Workspace-relative packaging of RunSpec.harness (WM-851). agy/gemini emit
 * packages commands as skills (`dist/gemini/skills/<name>/`), so both
 * `skills` and `commands` copy that directory into `.gemini/skills`.
 */
export const HARNESS_LAYOUT = Object.freeze({
  skills: Object.freeze({
    source: (name) => ["dist", "gemini", "skills", name],
    dest: (name) => [".gemini", "skills", name],
    type: "dir",
  }),
  commands: Object.freeze({
    source: (name) => ["dist", "gemini", "skills", name],
    dest: (name) => [".gemini", "skills", name],
    type: "dir",
  }),
  subagents: Object.freeze({
    source: (name) => ["dist", "gemini", "agents", `${name}.md`],
    dest: (name) => [".gemini", "agents", `${name}.md`],
    type: "file",
  }),
});

export { killProcessGroup };

export const KILL_GRACE_MS = 30_000;
const TEXT_PREVIEW_CHARS = 4000;
const STDERR_FILE_CHARS = 16_384;

/**
 * How much sooner agy's own print-mode wait expires than the worker's timeout.
 *
 * The CLI should give up just before the worker's TERM→KILL so it exits on its
 * own terms and still emits the terminal `result` event — that event carries
 * the status, error and token counts the trace and usage accounting depend on.
 * Killing it first would discard them.
 */
export const PRINT_TIMEOUT_GRACE_MS = 5_000;

export class CliNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliNotFoundError";
    this.code = "cli_not_found";
  }
}

/**
 * Resolve the agy binary: `agy` on PATH.
 * `which` is injectable for tests; defaults to `Bun.which` scoped to the child's PATH.
 */
export function resolveAgyCommand({ which = Bun.which } = {}) {
  if (which("agy")) return { command: "agy", args: [] };
  return null;
}

/**
 * Build argv for spawning agy.
 * The prompt itself travels on stdin via `-p -`.
 */
export function buildAgyArgv({
  prompt,
  def,
  model,
  effort,
  workspaceDir,
  timeoutMs,
}) {
  const args = [
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];

  if (workspaceDir) {
    args.push("--add-dir", workspaceDir);
  }

  if (timeoutMs) {
    // Seconds, not rounded minutes: `--print-timeout` takes Go duration syntax,
    // and minute granularity used to floor every sub-three-minute budget to 1m
    // (a 120s run gave agy 60s, so it quit while the worker still waited).
    const printSeconds = Math.max(
      1,
      Math.round((timeoutMs - PRINT_TIMEOUT_GRACE_MS) / 1000),
    );
    args.push("--print-timeout", `${printSeconds}s`);
  }

  if (typeof model === "string" && model !== "" && model !== "default") {
    args.push("--model", model);
  }

  const tierEffort =
    def?.model_tier === "light"
      ? "low"
      : def?.model_tier === "strong"
        ? "high"
        : def?.model_tier === "standard"
          ? "medium"
          : null;
  const effectiveEffort = effort ?? def?.effort ?? tierEffort;
  if (
    typeof effectiveEffort === "string" &&
    ["low", "medium", "high"].includes(effectiveEffort.toLowerCase())
  ) {
    args.push("--effort", effectiveEffort.toLowerCase());
  }

  if (typeof prompt === "string" && prompt.length > 0) {
    args.push("-p", prompt);
  }

  return args;
}

/**
 * Keep untrusted model subprocesses from inheriting the worker's authority.
 * Strips provider API keys to force subscription/login authentication.
 */
export function safeChildEnvironment(env = {}, defOrOpts = {}) {
  return sharedSafeChildEnvironment(env, defOrOpts, {
    factoryRoot: FACTORY_ROOT,
    stripPrefixes: ["ANTIGRAVITY_"],
  });
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS
    ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]`
    : s;
}

/** agy's token counters, renamed to the trace's shape. Absent fields stay absent. */
function normalizeUsage(raw) {
  const usage = {};
  const map = {
    input_tokens: "input",
    output_tokens: "output",
    thinking_tokens: "thinking",
    cache_read_tokens: "cacheRead",
    total_tokens: "total",
  };
  for (const [from, to] of Object.entries(map)) {
    if (typeof raw?.[from] === "number") usage[to] = raw[from];
  }
  return usage;
}

/** agy reports step durations in fractional seconds; the trace speaks milliseconds. */
function durationMsOf(seconds) {
  return typeof seconds === "number" ? Math.round(seconds * 1000) : null;
}

/**
 * Map agy's terminal `result` line to trace events.
 *
 * This is the only place the agent's final answer and its failure reason
 * appear: step updates carry neither. Before WM-435 the whole event was
 * dropped, so a failed agy run produced a completely blank trace even though
 * the CLI had reported a status, an error string and full token counts.
 */
function mapResultEvent(result) {
  if (!result || typeof result !== "object") return [];
  const events = [];

  const response =
    typeof result.response === "string" ? result.response.trim() : "";
  if (response) {
    events.push({ kind: "assistant_text", payload: { text: clip(response) } });
  }

  const status = result.status ?? null;
  if (status && status !== "SUCCESS") {
    events.push({
      kind: "lifecycle",
      payload: { note: "agent_error", status, error: result.error ?? null },
    });
  }

  events.push({
    kind: "usage",
    payload: {
      durationMs: durationMsOf(result.duration_seconds),
      numTurns: typeof result.num_turns === "number" ? result.num_turns : null,
      costUSD: null, // agy bills against the subscription; no per-run cost is reported
      usage: normalizeUsage(result.usage),
      status,
      error: result.error ?? null,
    },
  });

  return events;
}

/**
 * Map one parsed `agy` NDJSON stream line to factory.trace/v1 events.
 *
 * Verified against agy 1.1.13's real output (WM-435). What the CLI actually
 * emits, and the constraints that follow:
 *
 * - Steps are keyed by `step_index`, not an id — so the same index correlates
 *   a tool's ACTIVE and DONE/ERROR events, which is what lets the UI pair them.
 * - `agent_response` steps carry `usage` and `duration_seconds` and **no text**.
 *   The agent's prose only ever arrives on the terminal `result` event.
 * - Tool steps carry no output either. A `tool_result` can honestly report the
 *   tool, its parameters and how long it took — not what it returned.
 * - Failure is signalled by `state: "ERROR"` with the detail at
 *   `tool_info.error.message`; there is no `status` field on a step.
 *
 * @param {any} msg - one parsed NDJSON line from agy stream-json output
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapStreamEvent(msg) {
  if (!msg || typeof msg !== "object") return [];

  if (msg.event === "result") return mapResultEvent(msg.result);
  if (msg.event !== "step_update") return [];

  const s = msg.step_update ?? {};
  const stepIndex =
    s.step_index === undefined || s.step_index === null
      ? null
      : String(s.step_index);
  const durationMs = durationMsOf(s.duration_seconds);

  if (s.step_type === "tool") {
    const info = s.tool_info ?? {};
    const name = s.tool_name ?? info.name ?? "tool";
    if (s.state === "ACTIVE") {
      return [
        {
          kind: "tool_use",
          payload: { id: stepIndex, name, input: info.parameters ?? {} },
        },
      ];
    }
    if (s.state === "DONE" || s.state === "ERROR") {
      const isError = s.state === "ERROR";
      return [
        {
          kind: "tool_result",
          payload: {
            toolUseId: stepIndex,
            name,
            content: isError
              ? clip(info.error?.message ?? `${name} failed`)
              : `${name} completed${durationMs == null ? "" : ` in ${(durationMs / 1000).toFixed(2)}s`}`,
            isError,
            durationMs,
          },
        },
      ];
    }
    return [];
  }

  if (s.step_type === "error_message") {
    return [
      { kind: "lifecycle", payload: { note: "error_message", stepIndex } },
    ];
  }

  // agent_response and checkpoint steps exist to report incremental token
  // spend; surfacing them keeps mid-run accounting available while the run
  // is still going, which the terminal result alone cannot provide.
  if (s.usage && typeof s.usage === "object") {
    return [
      {
        kind: "usage",
        payload: {
          durationMs,
          numTurns: null,
          costUSD: null,
          usage: normalizeUsage(s.usage),
          incremental: true,
        },
      },
    ];
  }

  return [];
}

/**
 * Extract token and runtime usage from an agy result event.
 */
export function extractUsage(msg) {
  if (!msg || msg.event !== "result" || !msg.result) return null;
  const r = msg.result;
  const u = r.usage ?? {};
  const usage = {};
  if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
  if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
  if (typeof u.cache_read_tokens === "number")
    usage.cacheRead = u.cache_read_tokens;
  if (typeof r.num_turns === "number") usage.turns = r.num_turns;

  return {
    usage,
    costUSD: null,
    durationMs:
      typeof r.duration_seconds === "number" ? r.duration_seconds * 1000 : null,
    status: r.status ?? null,
    error: r.error ?? null,
  };
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, usage?: object }>}
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
  refuseSandbox("agy", def, SANDBOX_REFUSAL_REASON);
  const prompt = verifiedPrompt(def, "agy");
  const childEnv = safeChildEnvironment(env, def);

  const resolved = resolveAgyCommand({
    which: (name) => Bun.which(name, { PATH: childEnv.PATH ?? "" }),
  });
  if (!resolved) {
    throw new CliNotFoundError(
      "agy CLI is not on PATH — install the Antigravity CLI (docs/event-runtime.md §6)",
    );
  }

  const argv = [
    ...resolved.args,
    ...buildAgyArgv({
      prompt,
      def,
      model: spec?.model,
      effort: spec?.effort ?? def?.effort,
      workspaceDir,
      timeoutMs,
    }),
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

    let stderrBuf = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf = (stderrBuf + chunk).slice(-STDERR_FILE_CHARS);
      });
    }

    let finalUsage = null;
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // not JSON — agy interleaves plain text on some paths
        }

        try {
          const usageInfo = extractUsage(parsed);
          if (usageInfo) {
            finalUsage = usageInfo.usage;
            onUsage?.(usageInfo.usage);
          }
        } catch {
          // usage is accounting, not correctness
        }

        // Guard each emission separately: one throwing observer must not cost
        // us the rest of this line's events, nor the run (cf. WM-305 for pi).
        let events = [];
        try {
          events = mapStreamEvent(parsed);
        } catch {
          /* malformed event: events stays [] from the initializer */
        }
        for (const event of events) {
          try {
            onTrace?.(event.kind, event.payload);
          } catch {
            // trace is observability, not correctness
          }
        }
      });
    }

    let timedOut = false;
    let timer = null;
    let cancelTermination = null;
    const terminate = () => {
      cancelTermination ??= killProcessGroup(child, { killGraceMs });
    };
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }

    const cancel = () => terminate();
    abortSignal?.addEventListener("abort", cancel, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });

    child.on("close", async (exitCode) => {
      if (timer) clearTimeout(timer);
      cancelTermination?.();
      abortSignal?.removeEventListener("abort", cancel);
      signal?.removeEventListener("abort", cancel);
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
      resolve({ exitCode, timedOut, usage: finalUsage });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      cancelTermination?.();
      abortSignal?.removeEventListener("abort", cancel);
      signal?.removeEventListener("abort", cancel);
      transcript.destroy();
      reject(err);
    });
  });
}

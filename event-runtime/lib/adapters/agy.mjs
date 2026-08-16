/**
 * agy (Antigravity) CLI adapter (docs/event-runtime.md §6, §14; WM-424) — the
 * third LLM harness alongside `claude` and `pi`, on the Antigravity/Gemini
 * subscription and Google Cloud authentication window.
 *
 * Spawns a bounded `agy -p - --output-format stream-json --dangerously-skip-permissions`
 * process (prompt piped to stdin, the standard `./input.json` → `./result.json`
 * PROMPT_SUFFIX contract, cwd = workspace), enforces the run spec's timeout with
 * TERM→KILL(killGraceMs), strips API keys so the CLI authenticates against the
 * session/subscription instead of per-token billing, and captures full stdout as
 * the `.transcript.json` artifact.
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV } from "./claude.mjs";

export { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV };

export const KILL_GRACE_MS = 30_000;
const TEXT_PREVIEW_CHARS = 4000;

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
export function buildAgyArgv({ def, model, effort, workspaceDir, timeoutMs }) {
  const args = [
    "-p", "-",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
  ];

  if (workspaceDir) {
    args.push("--add-dir", workspaceDir);
  }

  if (timeoutMs) {
    const printMin = Math.max(1, Math.round(timeoutMs / 60000) - 2);
    args.push("--print-timeout", `${printMin}m`);
  }

  if (typeof model === "string" && model !== "" && model !== "default") {
    args.push("--model", model);
  }

  const effectiveEffort = effort ?? def?.effort;
  if (typeof effectiveEffort === "string" && ["low", "medium", "high"].includes(effectiveEffort.toLowerCase())) {
    args.push("--effort", effectiveEffort.toLowerCase());
  }

  return args;
}

export const BASE_INHERITED_ENV = [
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM",
  "TMPDIR", "USER", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
];

/**
 * Keep untrusted model subprocesses from inheriting the worker's authority.
 * Strips provider API keys to force subscription/login authentication.
 */
export function safeChildEnvironment(env = {}, defOrOpts = {}) {
  const isMutating = typeof defOrOpts === "boolean" ? defOrOpts : defOrOpts?.mutating === true;
  const inherited = isMutating ? [...BASE_INHERITED_ENV, ...PUSH_CREDENTIAL_ENV] : BASE_INHERITED_ENV;
  const childEnv = Object.fromEntries(
    inherited.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  Object.assign(childEnv, env);

  for (const key of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY",
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
  ]) {
    delete childEnv[key];
  }

  if (!isMutating) {
    for (const key of PUSH_CREDENTIAL_ENV) {
      delete childEnv[key];
    }
  }

  return childEnv;
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]` : s;
}

/**
 * Map one parsed `agy` NDJSON stream line to factory.trace/v1 events.
 *
 * @param {any} msg - one parsed NDJSON line from agy stream-json output
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapStreamEvent(msg) {
  if (!msg || typeof msg !== "object") return [];

  if (msg.event === "step_update") {
    const s = msg.step_update ?? {};
    if (s.step_type === "tool" && s.state === "ACTIVE") {
      return [{
        kind: "tool_use",
        payload: {
          id: s.step_id ?? null,
          name: s.tool_name ?? "tool",
          input: s.tool_info?.parameters ?? {},
        },
      }];
    }
    if (s.step_type === "tool" && s.state === "DONE") {
      return [{
        kind: "tool_result",
        payload: {
          toolUseId: s.step_id ?? null,
          content: clip(s.output ?? s.result ?? ""),
          isError: s.status === "ERROR",
        },
      }];
    }
    if (s.step_type === "agent_response" && (s.text || s.text_delta)) {
      return [{
        kind: "assistant_text",
        payload: { text: clip(s.text ?? s.text_delta) },
      }];
    }
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
  if (typeof u.cache_read_tokens === "number") usage.cacheRead = u.cache_read_tokens;
  if (typeof r.num_turns === "number") usage.turns = r.num_turns;

  return {
    usage,
    costUSD: null,
    durationMs: typeof r.duration_seconds === "number" ? r.duration_seconds * 1000 : null,
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
  const prompt = readFileSync(def.promptPath, "utf8") + PROMPT_SUFFIX;
  const childEnv = safeChildEnvironment(env, def);

  const resolved = resolveAgyCommand({ which: (name) => Bun.which(name, { PATH: childEnv.PATH ?? "" }) });
  if (!resolved) {
    throw new CliNotFoundError(
      "agy CLI is not on PATH — install the Antigravity CLI (docs/event-runtime.md §6)",
    );
  }

  const argv = [
    ...resolved.args,
    ...buildAgyArgv({
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
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    const transcript = createWriteStream(path.join(workspaceDir, ".transcript.json"));
    transcript.on("error", () => {});
    if (child.stdout) {
      child.stdout.pipe(transcript);
    }

    let finalUsage = null;
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          const usageInfo = extractUsage(parsed);
          if (usageInfo) {
            finalUsage = usageInfo.usage;
            onUsage?.(usageInfo.usage);
          }
          for (const event of mapStreamEvent(parsed)) {
            onTrace?.(event.kind, event.payload);
          }
        } catch {
          // not JSON — ignore
        }
      });
    }

    let timedOut = false;
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
      }, timeoutMs);
    }

    const cancel = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
    };
    abortSignal?.addEventListener("abort", cancel, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", cancel);
      signal?.removeEventListener("abort", cancel);
      resolve({ exitCode, timedOut, usage: finalUsage });
    });

    child.on("error", reject);
  });
}

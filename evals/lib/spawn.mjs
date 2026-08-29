/**
 * Bounded `claude -p` spawn for the eval runner (watt-mind/factory#1073).
 *
 * The runner makes model calls (run a skill on a case, grade the response) and
 * they must be bounded exactly the way real factory runs are. Rather than
 * re-derive the discipline, this mirrors the one in
 * `event-runtime/lib/adapters/claude.mjs`:
 *   - subscription auth: ANTHROPIC_API_KEY is stripped so the CLI uses the
 *     operator's Claude subscription (docs/architecture.md §2.9)
 *   - TERM, then KILL after a grace period, against the whole process group
 *     (the CLI spawns children) — a hung model never wedges the run
 *   - `--model` is passed verbatim unless it is the "default" sentinel
 *
 * It stays deliberately smaller than the adapter: an eval call needs plain
 * text out, no MCP, no workspace policy, no trace mapping. `--output-format
 * text` is enough. The adapter owns real dispatch; this owns evaluation.
 */
import { spawn } from "node:child_process";

export const DEFAULT_MODEL_SENTINEL = "default";
export const KILL_GRACE_MS = 10_000;

/** Terminate the CLI and every subprocess it started (mirrors the adapter). */
export function killProcessGroup(child, signal, kill = process.kill) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Assemble a safe child environment: inherit the shell, drop the API key. */
export function graderEnv(env = process.env) {
  const child = { ...env };
  delete child.ANTHROPIC_API_KEY;
  delete child.CLAUDECODE;
  delete child.CLAUDE_CODE_ENTRYPOINT;
  return child;
}

export function buildArgv({ prompt, model }) {
  const args = ["-p", prompt, "--output-format", "text"];
  if (typeof model === "string" && model && model !== DEFAULT_MODEL_SENTINEL) {
    args.push("--model", model);
  }
  return args;
}

/**
 * Run one bounded `claude -p` call.
 *
 * @returns {Promise<{ text: string, exitCode: number|null, timedOut: boolean }>}
 *   Never rejects on a non-zero exit or a timeout — the caller decides what a
 *   given exit means for the case. Rejects only if the CLI cannot be spawned
 *   at all (e.g. `claude` not on PATH), which is an environment fault.
 */
export function runClaude({
  prompt,
  model,
  cwd = process.cwd(),
  timeoutMs = 120_000,
  killGraceMs = KILL_GRACE_MS,
  env = process.env,
  command = "claude",
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, buildArgv({ prompt, model }), {
      cwd,
      env: graderEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

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

    child.on("error", (err) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        text: stdout.trim() || stderr.trim(),
        exitCode,
        timedOut,
      });
    });
  });
}

/**
 * Claude Code adapter (docs/event-runtime.md §6, §14; OPS-407) — the one real
 * registry entry. Spawns a bounded `claude -p` process with the workspace as
 * its cwd, enforces the run spec's timeout with the factory's shutdown discipline
 * (TERM, then KILL after 30s), strips ANTHROPIC_API_KEY so the CLI uses
 * subscription auth (docs/architecture.md §2.9), and confines tool access:
 *   - passes `--allowedTools` derived from `def.capabilities`, denying write tools
 *     when `mutating: false`
 *   - passes `--mcp-config config/mcp/claude.json` and `--strict-mcp-config` so
 *     only git-declared factory MCP servers are loaded
 *
 * Output is `--output-format stream-json` (NDJSON; the CLI requires
 * `--verbose` with it in -p mode): the full raw stream is captured to
 * `.transcript.json` as the runtime transcript artifact, and each line is
 * additionally mapped to factory.trace/v1 events via the optional `onTrace`
 * callback so the operator can watch the agent live. Trace mapping is
 * best-effort — an unparseable or unrecognized line is ignored, never fatal.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { FACTORY_ROOT } from "../config.mjs";
import { DEFAULT_MODEL } from "../registry.mjs";

export const KILL_GRACE_MS = 30_000;

/** Trace events preview text; the recorder's byte bound is the real limit. */
const TEXT_PREVIEW_CHARS = 4000;

export const PROMPT_SUFFIX =
  "\n\n---\nInput is at ./input.json. Write ./result.json per the factory.agent-result/v1 contract. Work only inside this directory.";

// `mutating: false` means no durable mutation beyond the run's declared
// workspace output; it does not mean a model cannot use the shell to inspect
// that workspace. The per-run Claude policy below enforces the boundary.
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash", "Write", "Edit"];
export const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "Replace",
  "NotebookEdit",
  "Bash",
  "Kill",
  "DeleteFile",
  "CreateFile",
]);

/**
 * Derive allowed tools from a definition (OPS-407).
 *
 * A non-mutating model needs Bash to inspect a repository and Write/Edit for
 * its required `result.json`. The actual write boundary is the generated
 * settings policy and the worker's post-run repository integrity gate; a
 * tool-name ban cannot distinguish safe workspace output from repo mutation.
 */
export function deriveAllowedTools(def) {
  if (def?.mutating === false) return [...READ_ONLY_TOOLS];
  if (Array.isArray(def?.capabilities?.tools)) return [...def.capabilities.tools];
  return [...READ_ONLY_TOOLS];
}

/** Generate a per-run settings file; absolute paths cannot drift with cwd. */
export function buildClaudeSettings({ spec, def, workspaceDir }) {
  if (def?.mutating !== false) return null;
  const checkoutDir = spec?.workspace?.type === "repository"
    ? path.resolve(workspaceDir, spec.workspace.checkoutDir ?? "repo")
    : null;
  return {
    permissions: {
      allow: [...READ_ONLY_TOOLS],
      // Claude's file permission matcher uses `//` for filesystem-absolute
      // paths. `Edit` covers both the Edit and Write tools.
      deny: checkoutDir ? [`Edit(//${checkoutDir.replace(/^\/+/, "")}/**)`] : [],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: checkoutDir ? { denyWrite: [checkoutDir] } : {},
    },
  };
}

/** Keep untrusted model subprocesses from inheriting the worker's authority. */
export function safeChildEnvironment(env = {}) {
  const inherited = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"];
  const childEnv = Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(childEnv, env);
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return childEnv;
}

/**
 * Build argv for spawning claude (OPS-407, WM-62, WM-108).
 * Enforces --allowedTools and --strict-mcp-config with the repo's declared MCP servers.
 * A definition declaring `limits.budget_usd` gets `--max-budget-usd` — the
 * runaway guard tick.mjs passes every ticket process (policy.yaml `budget`:
 * notional API-equivalent units on subscription auth, not money). The
 * dispatch design (§6) requires it before the first tier-2 mutating run.
 * `model` is the planner-resolved value pinned in the RunSpec (WM-135):
 * passed verbatim as `--model` unless it is the "default" sentinel or null,
 * both of which mean "ride the CLI's own default" — today's behavior.
 */
export function buildClaudeArgv({ prompt, def, allowedTools = deriveAllowedTools(def), mcpConfig, settingsPath, model }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (typeof model === "string" && model !== "" && model !== DEFAULT_MODEL) {
    args.push("--model", model);
  }
  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  if (settingsPath) args.push("--settings", settingsPath);
  const budget = def?.limits?.budget_usd;
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    args.push("--max-budget-usd", String(budget));
  }
  if (mcpConfig) {
    args.push("--mcp-config", mcpConfig);
  }
  args.push("--strict-mcp-config");
  return args;
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]` : s;
}

/**
 * Harness-authored refusal shapes only (WM-127). An error tool_result carries
 * arbitrary command output — `git@ssh.github.com: Permission denied
 * (publickey)`, `sudo: a password is required`, EACCES traces — and matching
 * any of that produced receipts blaming the harness for denials it never
 * issued (run_38deabb4). Each pattern here is anchored to the start of a
 * message Claude Code itself writes into the tool_result when its policy
 * layer refuses the call. The trade-off is deliberate: a missed shape
 * degrades to a truthful generic `agent_exit_*`; a false positive lies about
 * causality. Extend only with strings confirmed from the CLI.
 */
export const HARNESS_DENIAL_PATTERNS = [
  // -p + --allowedTools: call to a tool the run never granted (CLI 2.1.232).
  /^\s*Claude requested permissions to use .{1,120}, but you haven't granted it yet/,
  // A permissions.deny rule (the generated settings policy) refusing a tool.
  /^\s*Permission to use .{1,120} has been denied/,
  // The generated sandbox policy blocking an operation.
  /^\s*Sandbox denied/,
];

export function isHarnessDenial(content) {
  return typeof content === "string" && HARNESS_DENIAL_PATTERNS.some((re) => re.test(content));
}

/** Flatten a tool_result content value (string or content-block array) to text. */
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

/**
 * Map one parsed stream-json message to factory.trace/v1 events. Pure, so it
 * is unit-testable without spawning a model. One message can carry several
 * content blocks, hence an array (empty for anything unrecognized).
 *
 * @param {any} msg - one parsed NDJSON line from `claude -p --output-format stream-json`
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapStreamEvent(msg) {
  if (!msg || typeof msg !== "object") return [];

  if (msg.type === "assistant") {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events = [];
    for (const block of blocks) {
      if (block?.type === "text" && block.text) {
        events.push({ kind: "assistant_text", payload: { text: clip(block.text) } });
      } else if (block?.type === "tool_use") {
        events.push({ kind: "tool_use", payload: { id: block.id ?? null, name: block.name, input: block.input } });
      }
    }
    return events;
  }

  if (msg.type === "user") {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events = [];
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue;
      const payload = { content: clip(contentText(block.content)), toolUseId: block.tool_use_id ?? null };
      if (block.is_error === true) payload.isError = true;
      events.push({ kind: "tool_result", payload });
    }
    return events;
  }

  if (msg.type === "result") {
    const usage = {};
    for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
      if (typeof msg.usage?.[key] === "number") usage[key] = msg.usage[key];
    }
    return [
      {
        kind: "usage",
        payload: {
          durationMs: msg.duration_ms ?? null,
          numTurns: msg.num_turns ?? null,
          costUSD: msg.total_cost_usd ?? null,
          usage,
        },
      },
    ];
  }

  return []; // system/init, hooks, partials — not part of the trace contract
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({
  spec,
  def,
  workspaceDir,
  timeoutMs,
  killGraceMs = KILL_GRACE_MS,
  env = {},
  onTrace,
  abortSignal,
  signal,
}) {
  const prompt = readFileSync(def.promptPath, "utf8") + PROMPT_SUFFIX;
  const childEnv = safeChildEnvironment(env);

  const mcpConfig = path.join(FACTORY_ROOT, "config", "mcp", "claude.json");
  const settings = buildClaudeSettings({ spec, def, workspaceDir });
  const settingsPath = settings ? path.join(workspaceDir, ".claude-policy.json") : null;
  if (settingsPath) writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`, "utf8");
  const argv = buildClaudeArgv({ prompt, def, mcpConfig, settingsPath, model: spec?.model });

  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture the CLI's structured output as a runtime artifact: the worker
    // collects .transcript.json into the §7 store, so the operator can read
    // what the agent reported long after the workspace is gone. With
    // stream-json the artifact is NDJSON, one message per line — consumers
    // stream bytes, none parses it as a single JSON document.
    const transcript = createWriteStream(path.join(workspaceDir, ".transcript.json"));
    transcript.on("error", () => {});
    if (child.stdout) {
      child.stdout.pipe(transcript);
    }

    // Live trace: same stdout, line by line. It is observational only: a
    // trace recorder must never race execution by terminating the child.
    const policyDenials = [];
    let lastTool = null;
    const toolNames = new Map();
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          for (const event of mapStreamEvent(parsed)) {
            if (event.kind === "tool_use") {
              lastTool = event.payload?.name ?? null;
              if (event.payload?.id) toolNames.set(event.payload.id, lastTool);
            }
            onTrace?.(event.kind, event.payload);
            const content = typeof event.payload?.content === "string" ? event.payload.content : "";
            if (event.kind === "tool_result" && event.payload?.isError && isHarnessDenial(content)) {
              const denial = { tool: toolNames.get(event.payload?.toolUseId) ?? lastTool ?? "unknown", rule: clip(content) };
              policyDenials.push(denial);
              // Keep the registry's closed trace-kind set. The payload turns
              // this existing lifecycle event into an operator-visible denial.
              onTrace?.("lifecycle", { note: "policy_denial", ...denial });
            }
          }
        } catch {
          // not JSON, or a recorder failure — ignore
        }
      });
    }

    let timedOut = false;
    let killTimer = null;
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
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
    child.on("close", (exitCode) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
      // A denial observed mid-run is evidence, not a verdict: the model can
      // recover (run_38deabb4 retried a failed push over gh auth, opened its
      // PR, and exited clean). A clean exit outranks the observation — report
      // denials to the worker only when the run also failed; the lifecycle
      // trace events above keep the evidence visible either way.
      resolve({ exitCode, timedOut, policyDenials: exitCode === 0 ? [] : policyDenials });
    });
  });
}

/**
 * pi CLI adapter (docs/event-runtime.md §6, §14; OPS-296) — the second LLM
 * harness alongside `lib/adapters/claude.mjs`, on the Codex subscription
 * window (`--model openai-codex/<id>`, OAuth, no API key). MVP scope only:
 * native capability enforcement derived from `spec.capabilities` and
 * cooperative cancellation with partial output are deliberately deferred to
 * stage 2 (see the follow-up ticket linked from OPS-296).
 *
 * Spawns a bounded `pi -p --mode json` process (prompt piped to stdin, the
 * standard `./input.json` → `./result.json` PROMPT_SUFFIX contract, cwd =
 * workspace), enforces the run spec's timeout with TERM→KILL(killGraceMs),
 * strips OpenAI-family (and other provider) API keys so the CLI authenticates
 * against the subscription window instead of billing per token, and captures
 * full stdout as the `.transcript.json` artifact — same shape as the claude
 * adapter.
 *
 * Correction from the ticket's design text, confirmed against the installed
 * CLI (`pi --help`, `pi 0.84.1`): `-r` is `--resume`, not read-only — using it
 * for `mutating: false` would have been actively wrong (it selects a session
 * to resume, it does not restrict tools). pi's own documented read-only
 * pattern is `--tools read,grep,find,ls,write`: bash/edit are never offered
 * to the model, so there is no runtime "permission denied" message to
 * intercept the way claude's settings/sandbox policy produces one. `write`
 * stays even for mutating: false — the result contract requires writing
 * ./result.json (OPS-518) — so read-only containment here is bash/edit
 * omission plus the workspace cwd, audited-not-enforced per §14 until stage
 * 2's native capability enforcement lands.
 *
 * Trace mapping targets pi's real `--mode json` shape (investigated live, not
 * assumed): assistant text/tool calls arrive fully formed on `message_end`
 * (role `assistant`) content blocks — `message_update` deltas are the same
 * data streamed incrementally and are skipped to avoid double-emitting. Tool
 * results come from `tool_execution_end`, not the redundant `toolResult`-role
 * message pair. pi has no single terminal summary message the way claude's
 * `type: "result"` is one; each assistant turn reports its own token/cost
 * usage, so `execute()` accumulates `extractUsage()` across the run and emits
 * one combined `usage` trace event at process close — present fields when pi
 * reported them, explicit null/empty when it never got that far.
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV } from "./claude.mjs";

// PUSH_CREDENTIAL_ENV is imported, not redeclared: the WM-128 carve-out is one
// list shared by both LLM adapters (WM-223), so it cannot drift between them.
export { PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV };

export const KILL_GRACE_MS = 30_000;

/** Trace events preview text; the recorder's byte bound is the real limit. */
const TEXT_PREVIEW_CHARS = 4000;

// Read-only here means "cannot edit the repository", NOT "cannot act". Every
// tool below is load-bearing for a mutating: false agent, and removing one
// breaks the run rather than tightening it — this list has been wrong twice:
//   write  every agent-result contract requires ./result.json; without it a run
//          fails contract_violation:missing_result before doing anything (OPS-518)
//   bash   the entire scan fleet works by shelling out — work/triage/sweep/
//          unblock scans call tools/linear.mjs, merge/ship scans call gh and
//          git, ci-doctor and disk-diagnose call gh/ssh. Without a shell they
//          refuse with "reads could not be performed with the available tools"
//          (WM-301, run_e881a392)
// `edit` stays out: that is the actual repository-mutation boundary. Same
// reasoning as claude.mjs, which likewise keeps Bash/Write/Edit for read-only
// agents and enforces the boundary through workspace confinement instead of
// tool removal. Containment for mutating: false is therefore the ephemeral or
// pinned workspace as cwd — audited, not enforced, per §14 until stage 2's
// native capability enforcement (OPS-515).
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "write", "bash"];

// The mutating counterpart, and the reason it exists (WM-336): until now
// `--tools` was passed ONLY for `mutating: false`, so a mutating agent ran on
// pi's implicit defaults. Measured against pi 0.84.1, that set was:
//
//   read bash edit write subagent web_search fetch_content get_search_content
//   pi_claude_code_provider_web_search interactive_shell intercom vcc_recall
//   ask_user
//
// The agent with the widest surface was therefore `dispatch@1` — the unattended
// one that also inherits SSH_AUTH_SOCK and GITHUB_TOKEN/GH_TOKEN (WM-223).
//
// Be precise about what pinning this buys, because it is easy to overclaim:
// `bash` is in the set, so egress and arbitrary subprocesses remain reachable
// regardless. This is NOT a containment boundary — §14 still names the
// workspace cwd and (once WM-313 lands) the sandbox as the real one. What it
// buys is that the surface is DECLARED: it cannot widen silently when pi ships
// a new default tool, and a globally installed pi extension cannot hand every
// mutating agent a capability nobody reviewed (the reason WM-335 loads the
// chrome-devtools extension per run rather than via `pi install`).
//
// `edit` is the repository-mutation tool and is the whole point of a mutating
// agent. `subagent` is deliberately included: dispatch delegates focused work —
// notably the UX critique (WM-335) — and the alternative is one context doing
// everything, which is what long-run degradation looks like.
export const MUTATING_TOOLS = ["read", "grep", "find", "ls", "write", "bash", "edit", "subagent"];

export class CliNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliNotFoundError";
    this.code = "cli_not_found";
  }
}

/**
 * Resolve the pi binary: `pi` on PATH, else `npx pi` (runners/run-agent.sh
 * precedent). `which` is injectable for tests; defaults to `Bun.which`
 * scoped to the child's own PATH, not the worker process's.
 */
export function resolvePiCommand({ which = Bun.which } = {}) {
  if (which("pi")) return { command: "pi", args: [] };
  if (which("npx")) return { command: "npx", args: ["pi"] };
  return null;
}

/**
 * Build argv for spawning pi. The prompt itself travels on stdin, not argv
 * (matches `runners/run-agent.sh`'s `printf "%s\n" "$BODY" | pi -p ...`).
 * `model` is the planner-resolved value pinned in the RunSpec (WM-135):
 * passed verbatim as `--model` unless it is the "default" sentinel or null/empty.
 */
export function buildPiArgv({ def, model }) {
  const args = ["-p", "--mode", "json"];
  if (typeof model === "string" && model !== "" && model !== "default") {
    args.push("--model", model);
  }
  // Extensions are definition-scoped and loaded explicitly for this process.
  // Never `pi install` here: that writes global settings and would expose an
  // extension's tools to unrelated agents (WM-335).
  for (const extension of piExtensions(def)) args.push("-e", extension);
  // Always allowlist (WM-336). Omitting `--tools` does not mean "no tools", it
  // means "every tool pi currently ships" — a set that grows without review.
  args.push("--tools", piTools(def).join(","));
  return args;
}

/**
 * The tool allowlist for one definition: the base set for its mutability, plus
 * any tools the definition explicitly declares.
 *
 * `def.tools` is additive on purpose. A definition that needs something unusual
 * (WM-335's critic needs `chrome_devtools_*`) states it in the content-hashed
 * definition, so widening a surface is a reviewable diff rather than an
 * environment change. Order is stable and duplicates are dropped so the argv —
 * and therefore the transcript — is deterministic.
 */
export function piTools(def) {
  const base = def?.mutating === false ? READ_ONLY_TOOLS : MUTATING_TOOLS;
  const extra = Array.isArray(def?.tools) ? def.tools : [];
  return [...new Set([...base, ...extra])];
}

/** Repeatable `-e` sources declared by this definition, normalized for argv. */
export function piExtensions(def) {
  if (!Array.isArray(def?.extensions)) return [];
  return [
    ...new Set(
      def.extensions
        .filter((extension) => typeof extension === "string")
        .map((extension) => extension.trim())
        .filter(Boolean),
    ),
  ];
}

export const BASE_INHERITED_ENV = [
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM",
  "TMPDIR", "USER", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
];

/**
 * Keep untrusted model subprocesses from inheriting the worker's authority.
 *
 * Mutating runs additionally inherit `PUSH_CREDENTIAL_ENV` (SSH_AUTH_SOCK,
 * SSH_AGENT_PID, GITHUB_TOKEN, GH_TOKEN) so a dispatch ticket can actually
 * push its branch; non-mutating runs have those stripped — the WM-128 carve-out
 * claude.mjs has always had, brought to pi in WM-223. Before this, a pi-routed
 * dispatch run had *no* push credentials of any kind and survived only on `gh`'s
 * own stored OAuth reachable through the inherited HOME/XDG_CONFIG_HOME. That
 * gh-HTTPS route stays the paved road for pushing (agents/dispatch.md step 5);
 * this restores the credentials it was never supposed to be doing without.
 *
 * The strip runs *after* the caller's `env` is merged in, so a read-only run
 * cannot be handed a token through `env` either.
 *
 * Deliberate divergence from claude.mjs: only an explicit `mutating: true` (or a
 * boolean argument) counts as mutating here, where claude.mjs also treats any
 * other non-`undefined` value as mutating. Identical for every real agent
 * definition — `mutating` is a JSON boolean — but this direction fails closed.
 */
export function safeChildEnvironment(env = {}, defOrOpts = {}) {
  const isMutating = typeof defOrOpts === "boolean" ? defOrOpts : defOrOpts?.mutating === true;
  const inherited = isMutating ? [...BASE_INHERITED_ENV, ...PUSH_CREDENTIAL_ENV] : BASE_INHERITED_ENV;
  const childEnv = Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(childEnv, env);
  // Subscription auth (Codex/ChatGPT OAuth) is the point of routing through
  // pi at all — an inherited key would silently switch a run to per-token
  // billing (same rationale as run-agent.sh's UNSET_KEYS, all providers pi
  // itself recognizes, not just OpenAI's).
  for (const key of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY",
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

/**
 * Harness-authored refusal shapes only (WM-127 lesson, carried over from the
 * claude adapter). pi enforces read-only by never exposing bash/edit/write to
 * the model — there is no runtime "permission denied" interception the way
 * claude's settings/sandbox policy produces one, so no pattern has been
 * confirmed from the CLI yet. An arbitrary tool_execution_end error (a failed
 * `bash` command, an OS-level EACCES) must not be misclassified as a policy
 * denial; leaving this empty is the honest MVP state, not an oversight.
 * Extend only with strings confirmed from the CLI.
 */
export const HARNESS_DENIAL_PATTERNS = [];

export function isHarnessDenial(content) {
  return typeof content === "string" && HARNESS_DENIAL_PATTERNS.some((re) => re.test(content));
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]` : s;
}

/** Flatten a tool result content value (pi's shape: an array of text blocks). */
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
 * Map one parsed `pi --mode json` line to factory.trace/v1 events. Pure, so
 * it is unit-testable without spawning a model. Keyed off `message_end` (the
 * complete message) and `tool_execution_end` (the canonical tool-result
 * source) — `message_update` deltas and the redundant `toolResult`-role
 * message pair carry the same information and are deliberately not mapped,
 * to avoid double-emitting.
 *
 * @param {any} msg - one parsed NDJSON line from `pi -p --mode json`
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapStreamEvent(msg) {
  if (!msg || typeof msg !== "object") return [];

  if (msg.type === "message_end" && msg.message?.role === "assistant") {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events = [];
    for (const block of blocks) {
      if (block?.type === "text" && block.text) {
        events.push({ kind: "assistant_text", payload: { text: clip(block.text) } });
      } else if (block?.type === "toolCall") {
        events.push({ kind: "tool_use", payload: { id: block.id ?? null, name: block.name, input: block.arguments } });
      }
    }
    return events;
  }

  if (msg.type === "tool_execution_end") {
    const payload = { content: clip(contentText(msg.result?.content)), toolUseId: msg.toolCallId ?? null };
    if (msg.isError === true) payload.isError = true;
    return [{ kind: "tool_result", payload }];
  }

  return []; // session/agent_start/turn_start/message_update/turn_end/agent_end/agent_settled — not part of the trace contract
}

/**
 * Extract one assistant turn's token/cost usage, or null when the message
 * carries none. Pure — `execute()` accumulates across a run into the single
 * `usage` trace event pi's protocol has no equivalent terminal message for.
 */
export function extractUsage(msg) {
  if (!msg || msg.type !== "message_end" || msg.message?.role !== "assistant") return null;
  const u = msg.message?.usage;
  if (!u || typeof u !== "object") return null;
  const usage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
    if (typeof u[key] === "number") usage[key] = u[key];
  }
  const costUSD = typeof u.cost?.total === "number" ? u.cost.total : null;
  return { usage, costUSD };
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
  const childEnv = safeChildEnvironment(env, def);

  const resolved = resolvePiCommand({ which: (name) => Bun.which(name, { PATH: childEnv.PATH ?? "" }) });
  if (!resolved) {
    // Preflight refusal (OPS-296 AC): missing CLI is a typed condition the
    // worker recognizes as `cli_not_found`, not an opaque `adapter_error`
    // crash — see the `CliNotFoundError` handling in lib/worker.mjs.
    throw new CliNotFoundError(
      "neither pi nor npx is on PATH — install the pi CLI, or ensure npx can fetch it (docs/event-runtime.md §6)",
    );
  }
  const argv = [...resolved.args, ...buildPiArgv({ def, model: spec?.model })];

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, argv, {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.on("error", () => {}); // a child that exits before reading stdin must not crash the worker
    child.stdin.write(prompt);
    child.stdin.end();

    // Capture the CLI's structured output as a runtime artifact, same
    // contract as the claude adapter: NDJSON, one message per line.
    const transcript = createWriteStream(path.join(workspaceDir, ".transcript.json"));
    transcript.on("error", () => {});
    if (child.stdout) {
      child.stdout.pipe(transcript);
    }

    // Live trace: same stdout, line by line. Observational only — a trace
    // recorder must never race execution by terminating the child.
    const policyDenials = [];
    let lastTool = null;
    const toolNames = new Map();
    let turnCount = 0;
    let costTotal = null;
    const usageTotals = {};
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // not JSON — ignore
        }
        try {
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
              onTrace?.("lifecycle", { note: "policy_denial", ...denial });
            }
          }
          const turnUsage = extractUsage(parsed);
          if (turnUsage) {
            turnCount += 1;
            if (turnUsage.costUSD !== null) costTotal = (costTotal ?? 0) + turnUsage.costUSD;
            for (const [key, value] of Object.entries(turnUsage.usage)) {
              usageTotals[key] = (usageTotals[key] ?? 0) + value;
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
      // pi has no single terminal summary message; report what was actually
      // observed — explicit null/empty when the run never produced a turn,
      // never a fabricated zero.
      onTrace?.("usage", {
        durationMs: null,
        numTurns: turnCount > 0 ? turnCount : null,
        costUSD: costTotal,
        usage: usageTotals,
      });
      // Same WM-127 rule as claude: a denial observed mid-run is evidence,
      // not a verdict — only surfaced to the worker when the run also failed.
      resolve({ exitCode, timedOut, policyDenials: exitCode === 0 ? [] : policyDenials });
    });
  });
}

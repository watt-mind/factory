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
 *
 * Sandboxing (WM-313): this adapter does NOT yet execute inside the Gondolin
 * microVM, and it says so — a definition carrying a `sandbox` block is refused
 * with `SandboxUnsupportedError` before anything is spawned, never run on the
 * host as if the block were absent. The deferral is deliberate and narrow;
 * `SANDBOX_DEFERRAL_REASON` below is the whole rationale, and it names what
 * the pi path did not have to solve.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { FACTORY_ROOT } from "../config.mjs";
import { DEFAULT_MODEL } from "../registry.mjs";
import { refuseSandbox } from "./sandboxed.mjs";

/**
 * Deferred, not ignored. Everything this adapter passes claude on the host is
 * a host-shaped contract that has no guest translation yet:
 *   - `--mcp-config` names `FACTORY_ROOT/config/mcp/claude.json`, whose only
 *     server is fetched with `npx` — a deny-all guest cannot start it, and a
 *     translated config would need the checkout mounted read-only in the guest;
 *   - the generated `--settings` policy for `mutating: false` carries host
 *     absolute deny paths (`Edit(//<checkoutDir>/**)`, `filesystem.denyWrite`)
 *     and turns on Claude Code's own OS sandbox (`sandbox.enabled`), which is
 *     seatbelt/bubblewrap — untested inside an Alpine guest and, with
 *     `allowUnsandboxedCommands: false`, would deny every Bash call if absent;
 *   - the auth model is subscription OAuth held on the host (this adapter
 *     strips ANTHROPIC_API_KEY on purpose); in-guest that becomes API-key
 *     placeholder mode, a billing-policy change docs/eval-gondolin-guest-image.md
 *     §4.2 says must be an explicit profile, not a transparent switch.
 * pi shares the third point but not the first two: its extensions and tools are
 * argv-declared and it needs no host config file, which is why it went first.
 * Until a follow-up translates the settings/MCP contract to guest paths, the
 * only honest behaviour is to refuse — placement then keeps such a definition
 * from ever being claimed by a worker that would refuse it.
 */
export const SANDBOX_DEFERRAL_REASON =
  "claude's --mcp-config and generated --settings policy carry host absolute paths and enable Claude Code's own OS sandbox, neither of which has a guest translation yet (WM-313 deferral; see lib/adapters/claude.mjs)";

/** This adapter refuses sandboxed definitions (fail closed) until the deferral above is resolved. */
export const SANDBOX_SUPPORT = "unsupported";

/**
 * Workspace-relative packaging of RunSpec.harness (WM-851). Sources are emit
 * output under FACTORY_ROOT (`plugins/core`) so the bytes match the Claude
 * plugin; dest is the project `.claude/` tree the CLI reads from cwd.
 */
export const HARNESS_LAYOUT = Object.freeze({
  skills: Object.freeze({
    source: (name) => ["plugins", "core", "skills", name],
    dest: (name) => [".claude", "skills", name],
    type: "dir",
  }),
  commands: Object.freeze({
    source: (name) => ["plugins", "core", "commands", `${name}.md`],
    dest: (name) => [".claude", "commands", `${name}.md`],
    type: "file",
  }),
  subagents: Object.freeze({
    source: (name) => ["plugins", "core", "agents", `${name}.md`],
    dest: (name) => [".claude", "agents", `${name}.md`],
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

/** Trace events preview text; the recorder's byte bound is the real limit. */
const TEXT_PREVIEW_CHARS = 4000;

export const PROMPT_SUFFIX =
  "\n\n---\nInput is at ./input.json. Write ./result.json per the factory.agent-result/v1 contract. Work only inside this directory.";

/**
 * Prompt bytes are verified by the registry before they reach an adapter.
 * `promptPath` remains provenance only: re-reading it would bypass that pin.
 */
export function verifiedPrompt(def, adapter) {
  if (typeof def?.promptText !== "string") {
    throw new Error(
      `${adapter}: definition ${def?.ref ?? "<unknown>"} has no verified promptText (registry-loaded definitions only)`,
    );
  }
  return def.promptText + PROMPT_SUFFIX;
}

// `mutating: false` means no durable mutation beyond the run's declared
// workspace output; it does not mean a model cannot use the shell to inspect
// that workspace. The per-run Claude policy below enforces the boundary.
export const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Write",
  "Edit",
];
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
  if (Array.isArray(def?.capabilities?.tools))
    return [...def.capabilities.tools];
  return [...READ_ONLY_TOOLS];
}

/**
 * Can Claude Code's own OS sandbox actually start on this host?
 *
 * It is seatbelt on macOS and a nested user namespace on Linux. Hosts that
 * forbid unprivileged nesting (hardened kernels, some containers, LXC/LXD)
 * fail *before* the policy matters: every Bash call, `echo hello` included,
 * dies with `apply-seccomp: write /proc/self/setgroups: permission denied`.
 * Combined with `allowUnsandboxedCommands: false` that makes a read-only
 * agent unable to run any command at all, and the honest thing it can then
 * do is refuse — which is exactly what a work-scan did here, at a cost of
 * ~$0.70 and a human in the loop, on a host where the harness works fine
 * outside the sandbox.
 *
 * So probe once per process, cheaply, with the same primitive Claude uses.
 * FACTORY_CLAUDE_OS_SANDBOX=0/1 forces the answer for an operator who knows
 * better than the probe.
 *
 * The write boundary does not depend on this: `permissions.deny` still
 * refuses Edit under the checkout, and the worker's post-run repository
 * integrity gate is what actually proves a read-only run changed nothing.
 * The OS sandbox is defence in depth on top of those, so losing it degrades
 * isolation rather than correctness — and it is visible in the run log.
 */
let _osSandboxUsable = null;
export function osSandboxUsable(env = {}) {
  // The run env wins, then the worker's own — a spawn env is a narrow
  // allowlist, so the operator's export must still reach this decision.
  const forced =
    env?.FACTORY_CLAUDE_OS_SANDBOX ?? process.env.FACTORY_CLAUDE_OS_SANDBOX;
  if (forced === "0" || forced === "false") return false;
  if (forced === "1" || forced === "true") return true;
  if (_osSandboxUsable !== null) return _osSandboxUsable;
  if (process.platform !== "linux") {
    _osSandboxUsable = true;
    return _osSandboxUsable;
  }
  // Mirror what the sandbox actually does, not merely "can I unshare a user
  // namespace". Plain `unshare -Ur` succeeds on this host; the step that
  // fails is denying setgroups inside the new namespace, which is exactly
  // the `write /proc/self/setgroups` in the observed error. Probing the
  // weaker capability reports a sandbox that then dies on first use.
  const probe = spawnSync(
    "unshare",
    ["--map-root-user", "--setgroups", "deny", "true"],
    { stdio: "ignore" },
  );
  _osSandboxUsable = probe.status === 0;
  return _osSandboxUsable;
}

/** Generate a per-run settings file; absolute paths cannot drift with cwd. */
export function buildClaudeSettings({ spec, def, workspaceDir, env }) {
  if (def?.mutating !== false) return null;
  const checkoutDir =
    spec?.workspace?.type === "repository"
      ? path.resolve(workspaceDir, spec.workspace.checkoutDir ?? "repo")
      : null;
  return {
    permissions: {
      allow: [...READ_ONLY_TOOLS],
      // Claude's file permission matcher uses `//` for filesystem-absolute
      // paths. `Edit` covers both the Edit and Write tools.
      deny: checkoutDir
        ? [`Edit(//${checkoutDir.replace(/^\/+/, "")}/**)`]
        : [],
    },
    sandbox: osSandboxUsable(env)
      ? {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: checkoutDir ? { denyWrite: [checkoutDir] } : {},
        }
      : // Unusable here: enabling it would deny every Bash call rather than
        // confine it. permissions.deny above and the post-run integrity gate
        // remain the write boundary.
        { enabled: false },
  };
}

export const BASE_INHERITED_ENV = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];

export const PUSH_CREDENTIAL_ENV = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

/**
 * Keep untrusted model subprocesses from inheriting the worker's authority (WM-128).
 * Mutating runs (`mutating !== false` when def/options provide mutating: true)
 * preserve push credentials (SSH_AUTH_SOCK, SSH_AGENT_PID, GITHUB_TOKEN, GH_TOKEN)
 * so tickets can push git branches to remote origin. Non-mutating runs
 * (`mutating: false` or default) have push credentials and secret keys stripped.
 */
export function safeChildEnvironment(env = {}, defOrOpts = {}) {
  const isMutating =
    typeof defOrOpts === "boolean"
      ? defOrOpts
      : defOrOpts?.mutating === true ||
        (defOrOpts?.mutating !== false && defOrOpts?.mutating !== undefined);

  const inherited = isMutating
    ? [...BASE_INHERITED_ENV, ...PUSH_CREDENTIAL_ENV]
    : BASE_INHERITED_ENV;

  const childEnv = Object.fromEntries(
    inherited.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  Object.assign(childEnv, env);
  // Read-only repository workspaces contain the selected target checkout, not
  // Factory's runtime support code. Expose the running Factory checkout the
  // same way the pi adapter does (WM-433) so pinned procedures such as
  // merge-scan's `bun "$FACTORY_ROOT/event-runtime/lib/merge-ci-proof.mjs"`
  // resolve regardless of adapter. Without it merge-scan on claude/agy
  // escalated every PR ("FACTORY_ROOT is unset") and, trying to compensate,
  // dirtied its read-only checkout (workspace_integrity_violation).
  childEnv.FACTORY_ROOT = FACTORY_ROOT;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;

  if (!isMutating) {
    for (const key of PUSH_CREDENTIAL_ENV) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

/**
 * Build argv for spawning claude (OPS-407, WM-62, WM-108, WM-137).
 * Mutating runs (`mutating !== false`) pass `--dangerously-skip-permissions`
 * to prevent Claude Code's auto-classifier from blocking unattended tool calls (WM-137).
 * Read-only runs (`mutating: false`) enforce repository write protections via `--settings`.
 * Enforces --allowedTools and --strict-mcp-config with the repo's declared MCP servers.
 * A definition declaring `limits.budget_usd` gets `--max-budget-usd` — the
 * runaway guard tick.mjs passes every ticket process (policy.yaml `budget`:
 * notional API-equivalent units on subscription auth, not money). The
 * dispatch design (§6) requires it before the first tier-2 mutating run.
 * `model` is the planner-resolved value pinned in the RunSpec (WM-135):
 * passed verbatim as `--model` unless it is the "default" sentinel or null,
 * both of which mean "ride the CLI's own default" — today's behavior.
 */
export function buildClaudeArgv({
  prompt,
  def,
  allowedTools = deriveAllowedTools(def),
  mcpConfig,
  settingsPath,
  model,
  resumeSessionId,
}) {
  const args = ["-p", prompt];
  if (typeof resumeSessionId === "string" && resumeSessionId) {
    // Continue from the stale attempt's context under a new native session ID;
    // the expired source process may still exist and must not share writes.
    args.push("--resume", resumeSessionId, "--fork-session");
  }
  args.push("--output-format", "stream-json", "--verbose");
  if (def?.mutating !== false) {
    args.push("--dangerously-skip-permissions");
  }
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
  return s.length > TEXT_PREVIEW_CHARS
    ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]`
    : s;
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
  return (
    typeof content === "string" &&
    HARNESS_DENIAL_PATTERNS.some((re) => re.test(content))
  );
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
        events.push({
          kind: "assistant_text",
          payload: { text: clip(block.text) },
        });
      } else if (block?.type === "tool_use") {
        events.push({
          kind: "tool_use",
          payload: {
            id: block.id ?? null,
            name: block.name,
            input: block.input,
          },
        });
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
      const payload = {
        content: clip(contentText(block.content)),
        toolUseId: block.tool_use_id ?? null,
      };
      if (block.is_error === true) payload.isError = true;
      events.push({ kind: "tool_result", payload });
    }
    return events;
  }

  if (msg.type === "result") {
    const usage = {};
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ]) {
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
  onUsage,
  resume = null,
  abortSignal,
  signal,
}) {
  // First, before the prompt is read or the env assembled: a sandboxed
  // definition never reaches the host spawn below (WM-313).
  refuseSandbox("claude", def, SANDBOX_DEFERRAL_REASON);

  const prompt = verifiedPrompt(def, "claude");
  const childEnv = safeChildEnvironment(env, def);

  const mcpConfig = path.join(FACTORY_ROOT, "config", "mcp", "claude.json");
  const settings = buildClaudeSettings({ spec, def, workspaceDir, env });
  const settingsPath = settings
    ? path.join(workspaceDir, ".claude-policy.json")
    : null;
  if (settingsPath)
    writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`, "utf8");
  const argv = buildClaudeArgv({
    prompt,
    def,
    mcpConfig,
    settingsPath,
    model: spec?.model,
    resumeSessionId: resume?.sessionId,
  });

  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // Capture the CLI's structured output as a runtime artifact: the worker
    // collects .transcript.json into the §7 store, so the operator can read
    // what the agent reported long after the workspace is gone. With
    // stream-json the artifact is NDJSON, one message per line — consumers
    // stream bytes, none parses it as a single JSON document.
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

    // Live trace: same stdout, line by line. It is observational only: a
    // trace recorder must never race execution by terminating the child.
    const policyDenials = [];
    let lastTool = null;
    const toolNames = new Map();
    const tokenKeys = [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ];
    const assistantUsage = Object.fromEntries(tokenKeys.map((key) => [key, 0]));
    let finalUsage = null;
    let observedModel = null;
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          if (
            parsed?.type === "system" &&
            parsed?.subtype === "init" &&
            typeof parsed.model === "string"
          ) {
            observedModel = parsed.model;
          } else if (parsed?.type === "assistant") {
            if (!observedModel && typeof parsed.message?.model === "string")
              observedModel = parsed.message.model;
            for (const key of tokenKeys) {
              const value = parsed.message?.usage?.[key];
              if (
                typeof value === "number" &&
                Number.isFinite(value) &&
                value >= 0
              )
                assistantUsage[key] += value;
            }
          } else if (parsed?.type === "result") {
            finalUsage = parsed;
          }
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
      // A denial observed mid-run is evidence, not a verdict: the model can
      // recover (run_38deabb4 retried a failed push over gh auth, opened its
      // PR, and exited clean). A clean exit outranks the observation — report
      // denials to the worker only when the run also failed; the lifecycle
      // trace events above keep the evidence visible either way.
      const finalTokens = finalUsage?.usage ?? {};
      const tokenValue = (key) => {
        const value = finalTokens[key];
        return typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : assistantUsage[key];
      };
      try {
        onUsage?.({
          model: observedModel,
          inputTokens: tokenValue("input_tokens"),
          outputTokens: tokenValue("output_tokens"),
          cacheCreationInputTokens: tokenValue("cache_creation_input_tokens"),
          cacheReadInputTokens: tokenValue("cache_read_input_tokens"),
          costUSD:
            typeof finalUsage?.total_cost_usd === "number"
              ? finalUsage.total_cost_usd
              : 0,
        });
      } catch {
        // Usage is observability: a consumer failure must not change execution.
      }
      await transcriptClosed;
      resolve({
        exitCode,
        timedOut,
        policyDenials: exitCode === 0 ? [] : policyDenials,
      });
    });
  });
}

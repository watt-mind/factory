/**
 * Hermes harness adapter (WM-995 migration, GH-867) — a fifth LLM coding
 * harness alongside `claude`, `pi`, `agy`, and `cursor`.
 *
 * Investigation outcome (this ticket's first AC): Hermes Agent
 * (`NousResearch/hermes-agent`) is not a `-p <prompt> --output-format
 * stream-json` one-shot CLI the way Cursor/agy are — the deployment
 * inventoried in docs/editorial-agent-runtime.md §4 runs it as a long-lived
 * `hermes-gateway` service with its own session/kanban/cron state, which is
 * the wrong shape for a bounded, single-task factory run. Hermes's task
 * entry point instead speaks the Agent Client Protocol (ACP v1) — the same
 * newline-delimited JSON-RPC-over-stdio transport lib/adapters/acp.mjs
 * already implements generically (session lifecycle, permission handling,
 * factory.trace/v1 mapping, TERM→KILL). Rather than duplicate that engine,
 * this adapter is a thin Hermes-flavored configuration over acp.mjs's
 * `execute()`: same protocol, same trace/permission/timeout conventions,
 * different default binary and harness packaging.
 *
 * Sandbox: unsupported (WM-313) — no Gondolin guest translation for Hermes's
 * host binary/auth yet, same deferral as acp.mjs itself.
 */
import {
  CliNotFoundError,
  KILL_GRACE_MS,
  PROMPT_SUFFIX,
  PUSH_CREDENTIAL_ENV,
  execute as acpExecute,
} from "./acp.mjs";
import { refuseSandbox } from "./sandboxed.mjs";

export { CliNotFoundError, KILL_GRACE_MS, PROMPT_SUFFIX, PUSH_CREDENTIAL_ENV };

/**
 * No guest execution path exists for this adapter (WM-313): a sandboxed
 * definition is refused, not run on the host. See lib/adapters/sandboxed.mjs.
 */
export const SANDBOX_SUPPORT = "unsupported";
const SANDBOX_REFUSAL_REASON =
  "Hermes Agent has no guest execution path yet — its binary and host auth have not been translated to the microVM (same WM-313 deferral as lib/adapters/acp.mjs)";

/**
 * Workspace-relative packaging of RunSpec.harness (WM-851). Hermes has no
 * confirmed skills/commands packaging convention yet, so only the ACP-first
 * targets (commands, subagents) are declared; a spec naming skills is
 * refused `harness_unsupported` by the worker rather than silently dropped.
 */
export const HARNESS_LAYOUT = Object.freeze({
  commands: Object.freeze({
    source: (name) => ["dist", "hermes", "commands", `${name}.md`],
    dest: (name) => [".hermes", "commands", `${name}.md`],
    type: "file",
  }),
  subagents: Object.freeze({
    source: (name) => ["dist", "hermes", "agents", `${name}.md`],
    dest: (name) => [".hermes", "agents", `${name}.md`],
    type: "file",
  }),
});

/**
 * Shipped default — an ACP-speaking Hermes binary on PATH. Overridable via
 * `config`, `spec.hermes`, or `def.hermes` (same precedence as
 * `resolveAcpConfig`), so a deployment with a differently named binary or
 * subcommand does not need a code change.
 */
export const DEFAULT_HERMES_CONFIG = Object.freeze({
  command: "hermes-agent-acp",
  args: Object.freeze([]),
  env: Object.freeze({}),
});

/**
 * Merge `{ command, args, env }` from execute options, then spec/def, then
 * the shipped default — mirrors `resolveAcpConfig` in lib/adapters/acp.mjs.
 */
export function resolveHermesConfig({ spec, def, config } = {}) {
  const raw = config ?? spec?.hermes ?? def?.hermes ?? {};
  const command =
    typeof raw.command === "string" && raw.command !== ""
      ? raw.command
      : DEFAULT_HERMES_CONFIG.command;
  const args = Array.isArray(raw.args)
    ? raw.args.map(String)
    : [...DEFAULT_HERMES_CONFIG.args];
  const env =
    raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
      ? { ...raw.env }
      : {};
  return { command, args, env };
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
  refuseSandbox("hermes", def, SANDBOX_REFUSAL_REASON);
  const hermesConfig = resolveHermesConfig({ spec, def, config });
  try {
    return await acpExecute({
      spec,
      def,
      workspaceDir,
      timeoutMs,
      killGraceMs,
      env,
      config: hermesConfig,
      onTrace,
      onUsage,
      onPermissionRequest,
      resume,
      abortSignal,
      signal,
    });
  } catch (err) {
    if (err instanceof CliNotFoundError) {
      throw new CliNotFoundError(
        `Hermes agent "${hermesConfig.command}" is not on PATH — install an ACP-speaking Hermes binary or pass config.command (docs/event-runtime.md §6)`,
      );
    }
    throw err;
  }
}

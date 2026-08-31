/**
 * Human-facing subject / question for a proposal / run spec (WM-896 / WM-897).
 *
 * `proposalSubject` prefers the agent's `factory.artifact-view/v1` `subject`
 * template when the view defines one (`specSubject`, WM-897) — callers that
 * pass a registry get that priority. Dispatch keeps a hard-coded fallback
 * (ticket · repo · model, with a cached Linear ticket title appended after
 * an em dash when evidence has one) so a missing sidecar still reads as
 * "Dispatch TICKET · repo · model" on the inbox card and Telegram — the
 * same line WM-896 shipped before the view existed. Every other agent
 * without a subject falls through to an action-first `<Agent verb> <primary
 * input>` line instead of a bare null, so inbox items and Telegram pushes
 * always say what is being approved (WM-896).
 *
 * Callable either as `proposalSubject(spec)` — registry-less call sites
 * (notify.mjs, decision-templates.mjs) skip the view-template step — or as
 * `proposalSubject(registry, spec)` (api-runs.mjs), which tries the view
 * first.
 */
import { specSubject } from "./spec-subject.mjs";

const REASON_PLAIN = Object.freeze({
  "auto_approval_ineligible:dispatch_recheck_failed":
    "Auto-approval re-check failed (see proposal)",
  "auto_approval_ineligible:capacity_full": "Repo at in-flight cap",
  "auto_approval_ineligible:evidence_changed_since_plan":
    "Ticket changed since planning",
  owned_paths_not_closed:
    "The ticket's allowed paths do not cover every required file.",
  merge_barrier_unverified: "Merge barrier has not been verified.",
});

const PRIMARY_INPUT_KEYS = Object.freeze([
  "ticket",
  "issue",
  "pr",
  "prNumber",
  "runId",
  "repo",
]);

/** Agent id without the `@version` suffix (`dispatch@1` → `dispatch`). */
export function agentFamily(agent) {
  if (typeof agent !== "string" || agent.trim() === "") return "";
  return agent.trim().replace(/@\d+$/, "");
}

/**
 * Agent IDs whose runs hold a ticket lease and worktree, including their
 * strong-tier escalation continuation. Keep this explicit: a dispatch-like
 * name alone does not make an agent dispatch-class work.
 */
export const DISPATCH_CLASS_AGENT_IDS = new Set(["dispatch"]);

/** Whether an agent id or versioned ref belongs to the dispatch class. */
export function isDispatchClassAgent(agent) {
  return DISPATCH_CLASS_AGENT_IDS.has(agentFamily(agent));
}

/** Title-case the agent family so it reads as a verb (`ci-doctor` → `Ci-doctor`). */
export function agentVerb(agent) {
  const family = agentFamily(agent);
  if (!family) return "Run";
  return family
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function stringField(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The first operator-meaningful field on `spec.input`. */
export function primaryInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  for (const key of PRIMARY_INPUT_KEYS) {
    const value = stringField(input[key]);
    if (value) return value;
  }
  return null;
}

function dispatchTicketTitle(spec) {
  const title = spec?.approvalPolicy?.dispatchEvidence?.ticket?.title;
  return stringField(title);
}

function dispatchFallback(spec) {
  const input = spec?.input && typeof spec.input === "object" ? spec.input : {};
  const ticket = typeof input.ticket === "string" ? input.ticket : "?";
  const repo = typeof input.repo === "string" ? input.repo : "?";
  const model =
    typeof spec?.model === "string" && spec.model ? spec.model : "default";
  const subject = `Dispatch ${ticket} · ${repo} · ${model}`;
  const ticketTitle = dispatchTicketTitle(spec);
  return ticketTitle ? `${subject} — ${ticketTitle}` : subject;
}

/**
 * `proposalSubject(spec) → string` or `proposalSubject(registry, spec) → string | null`
 *
 * View `subject` wins when a registry is passed. Dispatch without a subject
 * still gets the ticket/repo/model fallback. Every other agent without a
 * subject gets an action-first `<Verb> <primary input>` line. Only a
 * non-object spec (with a registry supplied) returns null. Never throws.
 */
export function proposalSubject(a, b) {
  const hasRegistry = b !== undefined;
  const registry = hasRegistry ? a : null;
  const spec = hasRegistry ? b : a;

  const fromView = registry ? specSubject(registry, spec) : null;
  if (fromView) return fromView;

  const agent = spec?.agent;
  if (agentFamily(agent) === "dispatch") return dispatchFallback(spec);

  if (hasRegistry && (!spec || typeof spec !== "object")) return null;
  if (hasRegistry && typeof agent !== "string") return null;

  const verb = agentVerb(agent);
  const primary = primaryInput(spec?.input);
  return primary ? `${verb} ${primary}` : verb;
}

/** Decision-card question: what the operator is about to run. */
export function proposalQuestion(spec, { proposalId } = {}) {
  const agent = stringField(spec?.agent);
  if (!agent) {
    return proposalId
      ? `Decide proposal ${proposalId}`
      : "Should this proposal notification be dismissed?";
  }
  const input = spec?.input ?? {};
  if (agentFamily(agent) === "dispatch") {
    const ticket = stringField(input.ticket) ?? "?";
    const repo = stringField(input.repo) ?? "?";
    const model = stringField(spec?.model) ?? "?";
    return `Run ${agent} for ${ticket} (${repo}) on ${model}?`;
  }
  const primary = primaryInput(input);
  return primary ? `Run ${agent} for ${primary}?` : `Run ${agent}?`;
}

/** Operator-facing sentence for `proposals.reason`; unknown codes pass through. */
export function proposalReasonPlain(reason) {
  const code = stringField(reason);
  if (!code) return null;
  if (REASON_PLAIN[code]) return REASON_PLAIN[code];
  const prefixed = code.startsWith("auto_approval_ineligible:")
    ? code
    : `auto_approval_ineligible:${code}`;
  if (REASON_PLAIN[prefixed]) return REASON_PLAIN[prefixed];

  const barrier =
    /^(?:auto_approval_ineligible:)?merge_barrier_unverified(?::.+)?$/.test(
      code,
    );
  if (barrier) return REASON_PLAIN.merge_barrier_unverified;
  return code;
}

/**
 * Markdown context for the proposal decision card. Only the why-line lives
 * here; ticket and proposal links are rendered from `refs` on the card.
 */
export function proposalDecisionContext(reason) {
  const why = proposalReasonPlain(reason);
  if (!why) return undefined;
  return `**Why you're being asked.** ${why}`;
}

export default proposalSubject;

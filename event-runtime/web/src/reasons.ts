/**
 * Planner and worker reason codes, as an operator reads them (WM-594).
 *
 * The runtime records *why* it did not run something as a snake_case code —
 * `owned_paths_overlap` on a noop proposal, `needs_human` on a refused run,
 * `auto_approval_ineligible:proposal_expired` on an open proposal that aged
 * out. `humanizeReason()` turns any of them into one sentence and keeps the
 * raw code beside it (for a tooltip / copy), plus whatever identifiers ride in
 * the `:`-separated suffix so a caller can render them as jump links.
 *
 * Kept small and dependency-free on purpose: the Events pane, the per-ticket
 * Decisions block, the chain timeline (WM-639) and the PR journeys (WM-640)
 * all render from this one table, so a new planner code is added here once.
 */

/** Head codes → sentence-cased phrase. Suffix fragments are appended after ` — `. */
export const REASONS: Record<string, string> = {
  // run lifecycle actors
  planned: "Planned",
  claimed: "Claimed",
  started: "Started",
  auto_approved: "Auto-approved",
  approved: "Approved",
  // planner: dispatch gate (lib/planner.mjs worktreeDispatchAutoEligibility)
  owned_paths_overlap: "Owned paths overlap",
  owned_paths_unknown: "Owned paths unknown",
  owned_paths_not_closed: "Owned paths not closed",
  escalate_paths_intersect: "Touches an escalate path",
  escalate_paths_unverifiable: "Escalate paths could not be verified",
  ticket_assigned: "Ticket is already assigned",
  ticket_not_found: "Ticket not found",
  ticket_not_todo: "Ticket is not in Todo",
  ticket_not_agent_ready: "Ticket is not agent-ready",
  ticket_escalated: "Ticket is escalated",
  ticket_security: "Ticket is security-labelled",
  ticket_dispatch_already_live: "A dispatch for this ticket is already live",
  same_ticket_worktree_held: "its worktree is still held",
  ticket_claim_lost: "Ticket claim was lost",
  repo_unknown: "Repo is not configured",
  repo_unconfigured: "Repo is not configured",
  repo_report_only: "Repo is report-only",
  no_worktree_scripts: "Repo has no worktree scripts",
  budget_exhausted: "Budget exhausted",
  budget_check_failed: "Budget check failed",
  budget_policy_unavailable: "Budget policy unavailable",
  capacity_full: "No worker capacity",
  no_capacity: "No worker capacity",
  worker_cap_full: "Worker cap reached",
  worker_cap_policy_invalid: "Worker cap policy invalid",
  circuit_breaker_tripped: "Circuit breaker tripped",
  circuit_breaker_policy_invalid: "Circuit breaker policy invalid",
  runtime_policy_unavailable: "Runtime policy unavailable",
  runtime_guard_failed: "Runtime guard failed",
  // planner: proposal outcomes
  observed: "Observed only — nothing to run",
  duplicate_run: "Duplicate of an existing run",
  previous_run_in_flight: "Previous run still in flight",
  work_scan_already_in_flight: "A work scan is already in flight",
  superseded_by_ttl_replan: "Superseded by a TTL re-plan",
  replanned_after_ttl: "Re-planned after TTL",
  run_cancelled: "Run was cancelled",
  unregistered_event_type: "No agent registered for this event type",
  fresh_scan_required: "A fresh scan is required",
  // planner: auto-approval (lib/auto-approval.mjs)
  auto_approval_ineligible: "Not eligible for auto-approval",
  proposal_expired: "Proposal expired",
  dispatch_ineligible: "Dispatch ineligible",
  dispatch_recheck_failed: "Dispatch re-check failed",
  dispatch_recheck_unavailable: "Dispatch re-check unavailable",
  dispatch_paused: "Dispatch paused by operator",
  evidence_changed_since_plan: "evidence changed since plan",
  event_human_approval_only: "Event requires human approval",
  merge_barrier_unverified: "Merge barrier unverified",
  merge_barrier_uncertain: "Merge barrier uncertain",
  merge_fix_round_not_durable: "Merge-fix round not durable",
  merge_fix_round_exhausted: "Merge-fix rounds exhausted",
  merge_fix_not_mechanical_or_in_scope:
    "Merge-fix not mechanical or out of scope",
  merge_fix_pr_moved: "PR head moved since the plan",
  merge_fix_pr_not_open: "PR is no longer open",
  merge_fix_pr_not_found: "PR not found",
  merge_fix_pr_read_failed: "PR could not be read from GitHub",
  merge_fix_run_active: "A merge-fix run is already active",
  merge_fix_run_check_failed: "Could not check for competing merge-fix runs",
  merge_fix_owned_paths_moved: "PR touches paths outside Owned Paths",
  merge_fix_owned_paths_unknown: "Owned paths unknown",
  merge_fix_ticket_state: "Ticket is not in a merge-fix state",
  merge_fix_ticket_escalated: "Ticket is escalated",
  merge_fix_ticket_security: "Ticket is security-labelled",
  merge_fix_ticket_not_found: "Ticket not found",
  merge_fix_ticket_read_failed: "Ticket could not be read from Linear",
  merge_apply_pr_moved: "PR head moved since the plan",
  merge_apply_base_moved: "Base moved since the plan",
  // worker / verify (lib/worker.mjs, lib/verify.mjs, adapters)
  needs_human: "Needs human",
  missing_input: "Missing input",
  permission_denied: "Permission denied",
  unsupported_capability: "Unsupported capability",
  contract_violation: "Output contract violated",
  baseline_red: "Baseline was already red",
  timeout: "Timed out",
  adapter_error: "Adapter error",
  lease_expired: "Lease expired",
  linear_unconfigured: "Linear is not configured",
  linear_read_failed: "Linear read failed",
  cli_not_found: "Agent CLI not found",
  unknown_adapter: "Unknown adapter",
  agent_definition_mismatch: "Agent definition mismatch",
  workspace_integrity_violation: "Workspace integrity violated",
  workspace_provisioning_error: "Workspace provisioning failed",
  worktree_gate_unknown: "Worktree gate could not decide",
  claim_lock_contention: "Claim lock contention",
  claim_lock_starvation: "Claim lock starved",
  claim_lock_busy: "Claim lock busy",
  policy_denied: "Policy denied tool",
  sandbox_unsupported: "Sandbox unsupported on this worker",
  sandbox_unavailable: "Sandbox unavailable",
  attempts_exhausted: "Attempts exhausted",
  transient_retry_exhausted: "Transient retries exhausted",
  dispatch_gate: "Dispatch gate refused",
  dispatch_gate_transient: "Dispatch gate deferred",
  cancelled: "Cancelled",
  operator_cancel: "Cancelled by operator",
  ok: "OK",
};

export interface ReasonRefs {
  runId?: string;
  ticket?: string;
  proposalId?: string;
}

export interface HumanReason {
  /** One sentence. Empty string when there was no code. */
  text: string;
  /** The code exactly as recorded, for tooltips and copy. */
  raw: string | null;
  /** Identifiers found in the suffix, so callers can render jump links. */
  refs?: ReasonRefs;
}

const RUN_REF = /\brun_[A-Za-z0-9-]+/;
const PROPOSAL_REF = /\bprop_[A-Za-z0-9-]+/;
const TICKET_REF = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;
/** `agent_exit_1`, `agent_exit_143` — one family, the number is the detail. */
const AGENT_EXIT = /^agent_exit_(\d+)$/;

function extractRefs(text: string): ReasonRefs | undefined {
  const refs: ReasonRefs = {};
  const run = RUN_REF.exec(text);
  // `run_cancelled` is a code, not an id: real ids are `run_<uuid>`.
  if (run && !REASONS[run[0]]) refs.runId = run[0];
  const prop = PROPOSAL_REF.exec(text);
  if (prop) refs.proposalId = prop[0];
  const ticket = TICKET_REF.exec(text);
  if (ticket) refs.ticket = ticket[0];
  return Object.keys(refs).length ? refs : undefined;
}

/** A known head, or the family it belongs to (`agent_exit_143`), or nothing. */
function phraseFor(code: string): string | null {
  if (REASONS[code]) return REASONS[code];
  const exit = AGENT_EXIT.exec(code);
  if (exit) return `Agent exited with code ${exit[1]}`;
  return null;
}

/** Fragment text: a known code reads as its phrase, an unknown one drops its underscores. */
function fragmentText(fragment: string): string {
  const phrase = phraseFor(fragment);
  if (phrase) return phrase;
  // Free text (a Linear title, an error message) and identifiers are kept verbatim.
  if (/\s/.test(fragment) || !/^[a-z0-9_]+$/i.test(fragment)) return fragment;
  if (
    RUN_REF.test(fragment) ||
    PROPOSAL_REF.test(fragment) ||
    TICKET_REF.test(fragment)
  )
    return fragment;
  return fragment.replace(/_/g, " ");
}

/**
 * `owned_paths_overlap` → `Owned paths overlap`;
 * `ticket_dispatch_already_live:run_x:same_ticket_worktree_held` →
 * `A dispatch for this ticket is already live — run_x · its worktree is still held`
 * with `refs.runId = "run_x"`;
 * `some_new_code:detail` → `some new code — detail`. Free-text reasons
 * (anything with whitespace before the first colon) come back verbatim.
 */
export function humanizeReason(code: string | null | undefined): HumanReason {
  const raw = code == null ? null : String(code);
  if (!raw || !raw.trim()) return { text: "", raw: null };
  const trimmed = raw.trim();
  const refs = extractRefs(trimmed);
  const colon = trimmed.indexOf(":");
  const head = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const rest = colon === -1 ? "" : trimmed.slice(colon + 1);

  // Not a code at all: an operator wrote this sentence, keep it.
  if (/\s/.test(head)) return { text: trimmed, raw, ...(refs ? { refs } : {}) };

  const headText = phraseFor(head) ?? head.replace(/_/g, " ");
  // A suffix that is itself a free-text message (`repo_unknown: no such repo:
  // here`) stays one fragment; a coded chain gets ` · ` between its links.
  const fragments = (/\s/.test(rest.trim()) ? [rest] : rest.split(":"))
    .map((f) => f.trim())
    .filter(Boolean)
    .map(fragmentText);
  const detail = fragments.join(" · ");
  const text = detail ? `${headText} — ${detail}` : headText;
  return { text, raw, ...(refs ? { refs } : {}) };
}

/**
 * Chain timeline (WM-639): the chronological narrative of one correlation id.
 *
 * The chain graph (WM-527) answers "what is connected to what"; this module
 * answers "what happened, in what order, and what happens next". It is a
 * pure client-side join of:
 *   - `GET /chain/:correlationId` — every event and run in the chain,
 *   - `GET /runs/:id` per run — the lifecycle rows (LEASED, REFUSED, …),
 *   - `GET /proposals?status=all` — planner decisions with their timestamps,
 *   - `GET /schedules` — which loop will re-examine a refused/noop chain,
 *   - `GET /inbox?status=open` — the decision the operator owes when none will.
 * Everything here is pure so the row grammar can be tested from fixtures.
 */
import type { ScheduleItem } from "./api";
import { eventNodeId, runNodeId } from "./graph/chainModel";
import { formatDuration } from "./ticketJourney";
import type { ChainEvent, ChainRun, ChainView, InboxItem, LifecycleEvent, Proposal, RunDetail } from "./types";

// ---------------------------------------------------------------------------
// View mode (Graph | Timeline), persisted like the other display options.
// ---------------------------------------------------------------------------

export type ChainViewMode = "graph" | "timeline";
export const CHAIN_VIEW_MODES: readonly ChainViewMode[] = ["graph", "timeline"];
export const CHAIN_VIEW_STORAGE_KEY = "evrt-chain-view";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function isChainViewMode(value: unknown): value is ChainViewMode {
  return value === "graph" || value === "timeline";
}

/** Persisted mode; graph when nothing (or garbage) is stored. */
export function loadChainViewMode(storage: StorageLike | null = defaultStorage()): ChainViewMode {
  try {
    const raw = storage?.getItem(CHAIN_VIEW_STORAGE_KEY);
    return isChainViewMode(raw) ? raw : "graph";
  } catch {
    return "graph";
  }
}

export function saveChainViewMode(mode: ChainViewMode, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(CHAIN_VIEW_STORAGE_KEY, mode);
  } catch {
    // Private mode / quota: the toggle still works for the session.
  }
}

/** `?view=timeline` on a chain deep link; null when absent or unknown. */
export function chainViewModeFromQuery(query: URLSearchParams): ChainViewMode | null {
  const raw = query.get("view");
  return isChainViewMode(raw) ? raw : null;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reasons. Local table until WM-594 lands `src/reasons.ts` (humanizeReason);
// this folds into that map on rebase.
// ---------------------------------------------------------------------------

export const RUN_REASONS: Record<string, string> = {
  // lifecycle actors' own reasons
  planned: "planned",
  claimed: "claimed",
  started: "started",
  ok: "completed",
  auto_approved: "auto-approved",
  approved: "approved",
  observed: "observed — nothing to do",
  duplicate_run: "a run for this input already exists",
  previous_run_in_flight: "the previous run is still in flight",
  proposal_expired: "the proposal expired before anyone approved it",
  needs_human: "needs a human decision",
  attempts_exhausted: "attempts are exhausted",
  timeout: "timed out",
  cancelled: "cancelled by the operator",
  // planner refusals (lib/planner.mjs)
  capacity_full: "capacity is full for this repo",
  ticket_assigned: "the ticket is already assigned",
  ticket_dispatch_already_live: "a dispatch is already live for this ticket",
  same_ticket_worktree_held: "the ticket worktree is still held",
  ticket_escalated: "the ticket is escalated",
  ticket_not_agent_ready: "the ticket is not agent-ready",
  ticket_not_found: "the ticket was not found in Linear",
  ticket_not_todo: "the ticket is not in Todo",
  ticket_security: "the ticket is security-labelled — humans only",
  owned_paths_overlap: "owned paths overlap a live run",
  owned_paths_not_closed: "owned paths are not a closed set",
  owned_paths_unknown: "owned paths are unknown",
  no_worktree_scripts: "the repo ships no worktree scripts",
  repo_report_only: "the repo is report-only",
  repo_unconfigured: "the repo is not configured for Linear",
  merge_fix_pr_moved: "PR head moved after the plan",
  merge_fix_pr_not_found: "the PR was not found",
  merge_fix_pr_not_open: "the PR is no longer open",
  merge_fix_pr_read_failed: "the PR could not be read from GitHub",
  merge_fix_run_active: "another run is already working on this PR",
  merge_fix_run_check_failed: "could not check for competing runs",
  merge_fix_owned_paths_moved: "the fix touches paths outside the ticket's owned paths",
  merge_fix_owned_paths_unknown: "the ticket's owned paths could not be parsed",
  merge_fix_ticket_escalated: "the ticket is escalated",
  merge_fix_ticket_not_found: "the ticket was not found in Linear",
  merge_fix_ticket_read_failed: "the ticket could not be read from Linear",
  merge_fix_ticket_security: "the ticket is security-labelled — humans only",
  merge_fix_ticket_state: "the ticket is not In Review / In Progress",
  // worker / verify (lib/worker.mjs, lib/verify.mjs)
  agent_definition_mismatch: "the agent definition changed since the plan",
  claim_lock_contention: "another worker held the claim lock",
  claim_lock_starvation: "could not win the claim lock",
  contract_violation: "the output violated its contract",
  linear_unconfigured: "Linear is not configured",
  unknown_adapter: "unknown adapter",
  workspace_integrity_violation: "the workspace was modified outside the run",
  worktree_gate_unknown: "the worktree gate could not decide",
};

export interface HumanReason {
  text: string;
  raw: string;
}

/**
 * `code[:suffix]` → sentence, keeping any suffix (policy version, detail)
 * as a mono-ish tail. Unknown codes are de-snaked rather than hidden.
 */
export function humanizeRunReason(reason: string | null | undefined): HumanReason | null {
  if (!reason) return null;
  const [code, ...suffix] = reason.split(":");
  const words = RUN_REASONS[code] ?? code.replaceAll("_", " ").trim();
  const tail = suffix.join(":").trim();
  return { text: tail ? `${words}: ${tail}` : words, raw: reason };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type TimelineRefKind = "event" | "run" | "proposal" | "pr" | "ticket" | "agent" | "schedule" | "inbox";

export interface TimelineRef {
  kind: TimelineRefKind;
  /** Short display label ("PR #541", "WM-627", "run_643c2c35"). */
  label: string;
  /** The object id — run id, proposal id, ticket id, loop, inbox id, PR URL. */
  id: string;
  /** Companion id where one is not enough (event source). */
  source?: string;
  /** Absolute href when the object lives outside the SPA (PR URL). */
  href?: string;
}

export type TimelineRowKind = "event" | "decision" | "lifecycle" | "next";
export type TimelineHues = "event" | "decision" | "run" | "muted";

export interface ChainTimelineRow {
  id: string;
  kind: TimelineRowKind;
  /** Chain graph node this row belongs to — Enter opens its pane. */
  nodeId: string | null;
  at: string | null;
  /** Milliseconds since the previous row; null on the first row / the next-step row. */
  deltaMs: number | null;
  badge: string;
  hues: TimelineHues;
  actor: string | null;
  what: string;
  reason: HumanReason | null;
  refs: TimelineRef[];
  muted: boolean;
}

export interface ChainTimeline {
  rows: ChainTimelineRow[];
  /** Distinct node ids in row order — j/k traversal in timeline mode. */
  nodeOrder: string[];
  /** True when at least one run's lifecycle is still being fetched. */
  partial: boolean;
}

export interface ChainTimelineInput {
  chain: ChainView;
  /** `GET /runs/:id` per run in the chain; missing while loading. */
  runDetails: Record<string, RunDetail | undefined>;
  proposals: Proposal[];
  schedules: ScheduleItem[];
  inbox: InboxItem[];
  /** Wall clock (ms) — drives "in 9m" on the next-step row. */
  now: number;
}

const TERMINAL = new Set(["COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED"]);
const REVISIT_STATES = new Set(["REFUSED", "FAILED", "TIMED_OUT"]);
const REVISIT_EVENT_STATUSES = new Set(["noop", "human_needed", "dead_lettered"]);

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function shortRunId(runId: string): string {
  const m = runId.match(/^(run_[0-9a-f]{8})/);
  return m ? m[1] : runId.length > 16 ? `${runId.slice(0, 16)}…` : runId;
}

export function shortSha(sha: string): string {
  return /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/** `+6s`, `+<1s`, `+1m 5s` — the Δ gutter. */
export function formatDelta(deltaMs: number | null): string {
  if (deltaMs == null || !Number.isFinite(deltaMs) || deltaMs < 0) return "";
  if (deltaMs === 0) return "+0s";
  if (deltaMs < 1000) return "+<1s";
  return `+${formatDuration(deltaMs)}`;
}

/** `in 9m`, `now`, `overdue by 3m`. */
export function formatUntil(atMs: number, now: number): string {
  const diff = atMs - now;
  if (Math.abs(diff) < 30_000) return "now";
  return diff > 0 ? `in ${formatDuration(diff)}` : `overdue by ${formatDuration(-diff)}`;
}

/** Ticket + PR references named by a run's spec input (merge-fix, dispatch, …). */
export function specInputRefs(input: unknown): TimelineRef[] {
  const refs: TimelineRef[] = [];
  if (!input || typeof input !== "object") return refs;
  const record = input as Record<string, unknown>;
  const github = typeof record.github === "string" && /^[^/]+\/[^/]+$/.test(record.github) ? record.github : null;
  const pr = record.pr ?? record.prNumber ?? record.pullRequestNumber;
  const prNumber = typeof pr === "number" ? pr : typeof pr === "string" && /^\d+$/.test(pr) ? Number(pr) : null;
  const prUrl =
    typeof record.prUrl === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(record.prUrl)
      ? record.prUrl
      : prNumber != null && github
        ? `https://github.com/${github}/pull/${prNumber}`
        : null;
  if (prNumber != null || prUrl) {
    const number = prNumber ?? Number(prUrl!.match(/\/pull\/(\d+)/)?.[1]);
    refs.push({ kind: "pr", label: `PR #${number}`, id: prUrl ?? String(number), href: prUrl ?? undefined });
  }
  for (const key of ["ticket", "ticketId", "issue", "issueId"]) {
    const value = record[key];
    if (typeof value === "string" && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(value.trim().toUpperCase())) {
      refs.push({ kind: "ticket", label: value.trim().toUpperCase(), id: value.trim().toUpperCase() });
      break;
    }
  }
  return refs;
}

function dedupeRefs(refs: TimelineRef[]): TimelineRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function approvalNote(lifecycle: LifecycleEvent[], proposal: Proposal | undefined): string | null {
  const approved = lifecycle.find((entry) => entry.to_state === "APPROVED");
  if (approved) {
    const reason = approved.reason ?? "";
    if (reason.startsWith("auto_approved")) {
      const policy = reason.split(":").slice(1).join(":");
      const by = approved.actor.replace(/-auto-approval$/, "");
      return `auto-approved: ${policy || by}`;
    }
    return `approved by ${approved.actor}`;
  }
  if (proposal?.status === "approved") return `approved by ${proposal.decided_by ?? "operator"}`;
  if (proposal?.status === "rejected") return `rejected by ${proposal.decided_by ?? "operator"}`;
  if (proposal?.status === "open") return "awaiting approval";
  return null;
}

/** Reason detail the row can add from the spec: which PR head the plan saw. */
function reasonDetail(code: string | null, input: unknown): string | null {
  if (!code || !input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (code === "merge_fix_pr_moved" && typeof record.headSha === "string") {
    return `planned at ${shortSha(record.headSha)}`;
  }
  return null;
}

interface Draft {
  row: Omit<ChainTimelineRow, "deltaMs">;
  atMs: number;
  /** Tie-break for equal timestamps: event < decision < lifecycle(seq). */
  rank: number;
}

export function buildChainTimeline(input: ChainTimelineInput): ChainTimeline {
  const { chain, runDetails, proposals, schedules, inbox, now } = input;
  const drafts: Draft[] = [];
  const runsById = new Map(chain.runs.map((run) => [run.runId, run]));
  const proposalsById = new Map(proposals.map((p) => [p.id, p]));
  const proposalsByEvent = new Map<string, Proposal>();
  for (const p of proposals) {
    if (p.eventId && p.eventSource) {
      const key = `${p.eventSource}:${p.eventId}`;
      // History is newest-first; keep the latest decision per event.
      if (!proposalsByEvent.has(key)) proposalsByEvent.set(key, p);
    }
  }
  const runInput = (runId: string | null | undefined): unknown =>
    runId ? runDetails[runId]?.run.spec.input : undefined;
  const runRefs = (runId: string | null | undefined): TimelineRef[] => specInputRefs(runInput(runId));

  const decidedRuns = new Set<string>();
  let partial = false;

  // --- events + decisions -------------------------------------------------
  for (const event of chain.events) {
    const nodeId = eventNodeId(event.source, event.eventId);
    const admittedMs = ms(event.admittedAt) ?? ms(event.occurredAt) ?? 0;
    const refs = dedupeRefs([
      { kind: "event", label: event.type, id: event.eventId, source: event.source },
      ...runRefs(event.runId),
    ]);
    const suffix = refs
      .filter((r) => r.kind === "pr" || r.kind === "ticket")
      .map((r) => r.label)
      .join(", ");
    drafts.push({
      atMs: admittedMs,
      rank: 0,
      row: {
        id: `${nodeId}:admitted`,
        kind: "event",
        nodeId,
        at: event.admittedAt ?? event.occurredAt,
        badge: "admitted",
        hues: "event",
        actor: event.causationId ? "chain" : event.source,
        what: suffix ? `${event.type} (${suffix})` : event.type,
        reason: null,
        refs,
        muted: false,
      },
    });

    const proposal =
      (event.proposalId ? proposalsById.get(event.proposalId) : undefined) ??
      proposalsByEvent.get(`${event.source}:${event.eventId}`);
    const decision = proposal?.decision ?? event.proposalDecision ?? null;
    const status = event.status;
    const run = event.runId ? runsById.get(event.runId) : proposal?.runId ? runsById.get(proposal.runId) : undefined;
    const decisionAt = proposal?.created_at ?? run?.created_at ?? null;
    if (decision || REVISIT_EVENT_STATUSES.has(status)) {
      const kindLabel = decision === "run" ? "planned" : (decision ?? status);
      const detail = run ? runDetails[run.runId] : undefined;
      const note = run ? approvalNote(detail?.lifecycle ?? [], proposal) : null;
      const reason = decision === "run" ? null : humanizeRunReason(proposal?.reason ?? null);
      const rowRefs = dedupeRefs([
        ...(proposal ? [{ kind: "proposal" as const, label: proposal.id.slice(0, 13), id: proposal.id }] : []),
        ...(run ? [{ kind: "run" as const, label: shortRunId(run.runId), id: run.runId }] : []),
        ...(run?.agent ? [{ kind: "agent" as const, label: run.agent, id: run.agent }] : []),
      ]);
      const what = run
        ? `${run.agent ? `${run.agent} → ` : ""}${shortRunId(run.runId)}${note ? ` (${note})` : ""}`
        : (reason?.text ?? kindLabel);
      if (run) decidedRuns.add(run.runId);
      const at = decisionAt ?? event.admittedAt;
      drafts.push({
        atMs: ms(at) ?? admittedMs,
        rank: 1,
        row: {
          id: `${nodeId}:decision`,
          kind: "decision",
          nodeId: run ? runNodeId(run.runId) : nodeId,
          at,
          badge: kindLabel,
          hues: "decision",
          actor: "planner",
          what,
          reason: run ? null : reason,
          refs: rowRefs,
          muted: false,
        },
      });
    }
  }

  // --- run lifecycles -----------------------------------------------------
  for (const run of chain.runs) {
    const nodeId = runNodeId(run.runId);
    const detail = runDetails[run.runId];
    // Every lifecycle row links its run; only the terminal row repeats the
    // PR / ticket it decided about — the actor column already names the agent.
    const runRef: TimelineRef = { kind: "run", label: shortRunId(run.runId), id: run.runId };
    const stepRefs = [runRef];
    const outcomeRefs = dedupeRefs([runRef, ...runRefs(run.runId)]);
    const actorLabel = run.agent ?? shortRunId(run.runId);
    if (!detail) {
      partial = true;
      drafts.push(...fallbackRunRows(run, nodeId, stepRefs, decidedRuns.has(run.runId), actorLabel));
      continue;
    }
    const lifecycle = [...detail.lifecycle].sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    const input = detail.run.spec.input;
    let lastEmitted: LifecycleEvent | null = null;
    lifecycle.forEach((entry, index) => {
      const next = lifecycle[index + 1];
      const state = entry.to_state;
      if (state === "PROPOSED") {
        if (decidedRuns.has(run.runId)) return;
        push(entry, "planned", "decision", "planner", `${actorLabel} → ${shortRunId(run.runId)}`, null);
        return;
      }
      if (state === "APPROVED") return; // folded into the planned row's note
      if (state === "QUEUED" && (entry.from_state === "APPROVED" || entry.from_state === null)) return;
      if (state === "RUNNING" && lastEmitted?.to_state === "LEASED" && (ms(entry.at) ?? 0) - (ms(lastEmitted.at) ?? 0) < 1000) return;
      if (state === "VERIFYING" && next && TERMINAL.has(next.to_state)) return;
      const reason = humanizeRunReason(entry.reason);
      const detailText = TERMINAL.has(state) ? reasonDetail(entry.reason, input) : null;
      const shown = reason && detailText ? { ...reason, text: `${reason.text} (${detailText})` } : reason;
      const actor = state === "QUEUED" || TERMINAL.has(state) ? actorLabel : entry.actor;
      const what = TERMINAL.has(state)
        ? entry.actor && entry.actor !== actorLabel && !entry.actor.startsWith("worker_") ? `by ${entry.actor}` : ""
        : state === "LEASED" && entry.attempt != null && entry.attempt > 1
          ? `attempt ${entry.attempt}`
          : "";
      push(entry, state, "run", actor, what, shown);
    });

    function push(
      entry: LifecycleEvent,
      badge: string,
      hues: TimelineHues,
      actor: string,
      what: string,
      reason: HumanReason | null,
    ) {
      lastEmitted = entry;
      drafts.push({
        atMs: ms(entry.at) ?? 0,
        rank: 2 + entry.seq / 1e9,
        row: {
          id: `${nodeId}:lc:${entry.seq}`,
          kind: "lifecycle",
          nodeId,
          at: entry.at,
          badge,
          hues,
          actor,
          what,
          reason,
          refs: TERMINAL.has(entry.to_state) ? outcomeRefs : stepRefs,
          muted: false,
        },
      });
    }
  }

  drafts.sort((a, b) => a.atMs - b.atMs || a.rank - b.rank || a.row.id.localeCompare(b.row.id));

  const rows: ChainTimelineRow[] = drafts.map((draft, index) => ({
    ...draft.row,
    deltaMs: index === 0 ? null : Math.max(0, draft.atMs - drafts[index - 1].atMs),
  }));

  const nextRow = nextStepRow(chain, schedules, inbox, now);
  if (nextRow) rows.push(nextRow);

  const nodeOrder: string[] = [];
  for (const row of rows) {
    if (row.nodeId && !nodeOrder.includes(row.nodeId)) nodeOrder.push(row.nodeId);
  }
  return { rows, nodeOrder, partial };
}

/** Rows from the chain summary alone, while `GET /runs/:id` is still loading. */
function fallbackRunRows(run: ChainRun, nodeId: string, refs: TimelineRef[], decided: boolean, actorLabel: string): Draft[] {
  const out: Draft[] = [];
  const base = {
    kind: "lifecycle" as const,
    nodeId,
    refs,
    muted: false,
  };
  if (!decided) {
    out.push({
      atMs: ms(run.created_at) ?? 0,
      rank: 2,
      row: { ...base, id: `${nodeId}:planned`, at: run.created_at, badge: "planned", hues: "decision", actor: "planner", what: `${actorLabel} → ${shortRunId(run.runId)}`, reason: null },
    });
  }
  if (run.startedAt) {
    out.push({
      atMs: ms(run.startedAt) ?? 0,
      rank: 2.5,
      row: { ...base, id: `${nodeId}:started`, at: run.startedAt, badge: TERMINAL.has(run.state) || run.state === "RUNNING" || run.state === "VERIFYING" ? "RUNNING" : run.state, hues: "run", actor: "worker", what: "", reason: null },
    });
  }
  if (run.finishedAt && TERMINAL.has(run.state)) {
    out.push({
      atMs: ms(run.finishedAt) ?? 0,
      rank: 3,
      row: { ...base, id: `${nodeId}:finished`, at: run.finishedAt, badge: run.state, hues: "run", actor: actorLabel, what: "", reason: humanizeRunReason(run.reasonCode) },
    });
  }
  return out;
}

/** The chain's origin: the earliest event with no causation parent. */
export function chainOriginEvent(chain: Pick<ChainView, "events">): ChainEvent | null {
  const roots = chain.events.filter((e) => !e.causationId);
  const pool = roots.length ? roots : chain.events;
  return [...pool].sort((a, b) => a.admittedAt.localeCompare(b.admittedAt))[0] ?? null;
}

/** The enabled schedule that will re-emit this chain's origin event, if any. */
export function coveringSchedule(origin: ChainEvent | null, schedules: ScheduleItem[]): ScheduleItem | null {
  if (!origin) return null;
  const candidates = schedules.filter(
    (s) =>
      s.enabled &&
      !s.stopped &&
      s.eventType === origin.type &&
      (s.repo == null || origin.repos.length === 0 || origin.repos.includes(s.repo)),
  );
  candidates.sort((a, b) => (a.nextDue ?? "￿").localeCompare(b.nextDue ?? "￿"));
  return candidates[0] ?? null;
}

/** Whether the chain ended somewhere a loop or a human must revisit. */
export function chainNeedsRevisit(chain: ChainView): boolean {
  if (chain.runs.some((run) => !TERMINAL.has(run.state))) return false;
  return (
    chain.runs.some((run) => REVISIT_STATES.has(run.state)) ||
    chain.events.some((event) => REVISIT_EVENT_STATUSES.has(event.status))
  );
}

function inboxItemFor(chain: ChainView, inbox: InboxItem[]): InboxItem | null {
  const runIds = new Set(chain.runs.map((r) => r.runId));
  const eventIds = new Set(chain.events.map((e) => e.eventId));
  const proposalIds = new Set(chain.events.map((e) => e.proposalId).filter(Boolean) as string[]);
  return (
    inbox.find(
      (item) =>
        (item.refs.runId && runIds.has(item.refs.runId)) ||
        (item.refs.eventId && eventIds.has(item.refs.eventId)) ||
        (item.refs.proposalId && proposalIds.has(item.refs.proposalId)),
    ) ?? null
  );
}

function nextStepRow(chain: ChainView, schedules: ScheduleItem[], inbox: InboxItem[], now: number): ChainTimelineRow | null {
  if (!chainNeedsRevisit(chain)) return null;
  const origin = chainOriginEvent(chain);
  const schedule = coveringSchedule(origin, schedules);
  const base = { id: "next", kind: "next" as const, nodeId: null, deltaMs: null, hues: "muted" as const, reason: null, muted: true };
  if (schedule && schedule.nextDue) {
    const dueMs = ms(schedule.nextDue);
    const clock = dueMs == null ? schedule.nextDue : new Date(dueMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return {
      ...base,
      at: schedule.nextDue,
      badge: "next",
      actor: schedule.loop,
      what: `re-examines at ${clock}${dueMs == null ? "" : ` (${formatUntil(dueMs, now)})`}`,
      refs: [{ kind: "schedule", label: schedule.loop, id: schedule.loop }],
    };
  }
  const item = inboxItemFor(chain, inbox);
  return {
    ...base,
    at: null,
    badge: "next",
    actor: null,
    what: "no automatic retry — needs a decision",
    refs: item ? [{ kind: "inbox", label: item.title, id: item.id }] : [],
  };
}

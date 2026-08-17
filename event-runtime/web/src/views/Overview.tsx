import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { goPrefixActive } from "../goSequence";
import { keyGuard, useNow, useRequeuePoll } from "../hooks";
import type { JournalEntry, EventFocus, Proposal, RunState, StatusView } from "../types";
import type { OperatorContext } from "../context";
import { scopedCount, scopedTally } from "../context";
import type { WorkerHealthFilter } from "./Workers";
import {
  Ago,
  Button,
  Disclosure,
  Dialog,
  EVENT_STATUS_HUES,
  STATE_HUES,
  humanSize,
  JsonBlock,
  JumpLink,
  StateBadge,
  StateIcon,
  VerbError,
  ago,
  copyText,
  notify,
  shortId,
} from "../components/ui";

const FEED_CAP = 50;

export function SectionTitle({
  title,
  meta,
  collapsible = false,
  collapsed = false,
  onToggle,
  className = "mb-2.5",
}: {
  title: string;
  meta?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const label = (
    <span className="text-[11px] font-semibold uppercase tracking-wider text-(--text-faint)">
      {title}
    </span>
  );
  const metaNode = meta != null && (
    <span className="ml-auto text-right text-[11px] text-(--text-faint)">{meta}</span>
  );

  if (collapsible) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={`${className} flex w-full cursor-pointer items-center gap-1.5 text-left hover:text-(--text-dim)`}
      >
        <span
          aria-hidden="true"
          className={`text-[9px] text-(--text-faint) transition-transform ${collapsed ? "" : "rotate-90"}`}
        >
          ▶
        </span>
        {label}
        {metaNode}
      </button>
    );
  }

  return (
    <div className={`${className} flex items-baseline justify-between gap-3`}>
      <h2>{label}</h2>
      {metaNode}
    </div>
  );
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  hue?: string;
}

/**
 * 6px proportional horizontal meter with hover highlights and tooltips.
 */
export function SegmentMeter({
  segments,
  onSegment,
}: {
  segments: Segment[];
  onSegment?: (key: string) => void;
}) {
  const total = segments.reduce((acc, s) => acc + (s.value > 0 ? s.value : 0), 0);

  if (total === 0) {
    return (
      <div
        aria-hidden="true"
        className="h-1.5 w-full rounded-full border border-(--border) bg-(--surface-2)"
        title="No active items in this stage"
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="flex h-1.5 w-full overflow-hidden rounded-full border border-(--border) bg-(--surface-2)"
    >
      {segments.map((s) => {
        if (s.value <= 0) return null;
        const pct = (s.value / total) * 100;
        return (
          <div
            key={s.key}
            onClick={() => onSegment?.(s.key)}
            style={{
              width: `${pct}%`,
              backgroundColor: s.hue || "var(--text-dim)",
            }}
            tabIndex={-1}
            className={`h-full transition-all ${onSegment ? "cursor-pointer hover:brightness-125" : ""}`}
            title={`${s.label}: ${s.value} (${Math.round(pct)}%)`}
          />
        );
      })}
    </div>
  );
}

/**
 * Interactive stat legend button with OPS-498 state icon, label, and monospace value.
 */
export function StatLegendItem({
  token,
  label,
  value,
  hue,
  attention = false,
  onClick,
  factoryWide = false,
  total,
}: {
  token: string;
  label: string;
  value: ReactNode;
  hue?: string;
  attention?: boolean;
  onClick?: () => void;
  factoryWide?: boolean;
  total?: number;
}) {
  const isZero = value === 0 || value === "0";
  const lit = attention && !isZero && hue;
  const fullLabel = factoryWide ? `${label} · factory-wide` : label;
  const pctStr =
    typeof total === "number" && total > 0 && typeof value === "number"
      ? ` (${Math.round((value / total) * 100)}%)`
      : "";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${fullLabel}: ${value}`}
      title={`${label}: ${value}${pctStr}`}
      style={lit ? { color: hue } : undefined}
      className={`group flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-left text-[12px] transition-all hover:border-(--border) hover:bg-(--surface-2) focus-visible:border-(--accent) focus-visible:outline-none ${
        isZero ? "opacity-60 text-(--text-faint)" : "text-(--text-dim)"
      }`}
    >
      <StateIcon state={token} />
      <span className={lit ? "" : "group-hover:text-(--text) group-hover:underline"}>
        {label.split(" · ").pop()}
      </span>
      <span
        className="mono tabular-nums font-semibold"
        style={!lit && hue && !isZero ? { color: hue } : undefined}
      >
        {value}
      </span>
      {factoryWide && <span className="text-[10px] text-(--text-faint)">(all)</span>}
    </button>
  );
}

/**
 * Unified Stage Card container.
 */
export function StageCard({
  index,
  title,
  headline,
  headlineHue,
  meta,
  children,
  className = "",
}: {
  index?: number;
  title: string;
  headline?: ReactNode;
  headlineHue?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-(--border) bg-(--surface-1) p-3.5 ${className}`}>
      <SectionTitle
        title={index != null ? `${index}. ${title}` : title}
        meta={
          <span className="flex items-baseline gap-2">
            {meta && <span>{meta}</span>}
            {headline != null && (
              <span
                className="display text-xl font-semibold tabular-nums"
                style={headlineHue ? { color: headlineHue } : undefined}
              >
                {headline}
              </span>
            )}
          </span>
        }
      />
      {children}
    </section>
  );
}

function OverviewSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="mb-5">
      <SectionTitle
        title={title}
        meta={meta}
        collapsible
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        className="mb-1.5"
      />
      {!collapsed && children}
    </section>
  );
}

/**
 * One collapsed activity-feed row (WM-100): a consecutive span of state
 * transitions belonging to the same run, keyed by its most recent entry.
 */
export interface ActivityGroup {
  /** seq of the most recent entry in the span — stable render key. */
  seq: number;
  runId: string;
  /** Starting state of the span (the `from` of its oldest transition). */
  from: string | null;
  /** Last (most recent) state — carries the state color badge. */
  to: string;
  /** Number of transitions collapsed into this row. */
  count: number;
  /** Actor / reason / attempt of the most recent transition. */
  actor: string;
  reason: string | null;
  attempt: number | null;
  /** Full oldest-to-newest state path represented by this group. */
  path: string[];
  /** Timestamp of the most recent transition. */
  at: string;
}

/**
 * Collapse consecutive transitions of the same run into one row (WM-100).
 * `entries` is newest-first (as kept by useJournalFeed); the output preserves
 * that order. A run interleaved with other runs' activity produces a separate
 * group per consecutive span — only adjacent same-run entries merge.
 */
export function groupJournalEntries(entries: JournalEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const e of entries) {
    const open = groups[groups.length - 1];
    if (open && open.runId === e.runId) {
      // `e` is older than the entries already merged: extend the span's start.
      open.from = e.from;
      open.path.unshift(e.from ?? "START");
      open.count += 1;
    } else {
      groups.push({
        seq: e.seq,
        runId: e.runId,
        from: e.from,
        to: e.to,
        count: 1,
        actor: e.actor,
        reason: e.reason,
        attempt: e.attempt,
        path: [e.from ?? "START", e.to],
        at: e.at,
      });
    }
  }
  return groups;
}

const DUPLICATE_STATE_REASONS: Partial<Record<string, Set<string>>> = {
  RUNNING: new Set(["run", "running", "start", "started"]),
  COMPLETED: new Set(["complete", "completed", "ok", "success", "succeeded", "exit_0", "exit 0"]),
  FAILED: new Set(["fail", "failed"]),
  QUEUED: new Set(["queue", "queued"]),
  LEASED: new Set(["lease", "leased"]),
  VERIFYING: new Set(["verify", "verifying"]),
  REFUSED: new Set(["refuse", "refused"]),
  TIMED_OUT: new Set(["timed_out", "timed out", "timeout"]),
  CANCELLED: new Set(["cancel", "cancelled", "canceled"]),
};

export function formatActivityGroup(group: ActivityGroup): {
  steps: string | null;
  path: string;
  reason: string | null;
} {
  const normalizedReason = group.reason?.trim().toLowerCase() ?? null;
  const reason =
    normalizedReason && !DUPLICATE_STATE_REASONS[group.to]?.has(normalizedReason)
      ? group.reason?.trim() ?? null
      : null;
  return {
    steps: group.count > 1 ? `+${group.count} steps` : null,
    path: group.path.join(" → "),
    reason,
  };
}

export type AnomalyKind =
  | "proposal"
  | "dead_letter"
  | "worker"
  | "lease"
  | "outbox"
  | "capacity"
  | "ambiguous"
  | "schedule"
  | "configuration";

export interface AnomalyRow {
  kind: AnomalyKind;
  text: string;
  links: { label: string; go: () => void }[];
  requeue?: { source: string; eventId: string };
  archive?: { source: string; eventId: string };
  releaseWorker?: { workerId: string; runId: string };
  dismissProposalId?: string;
  proposalId?: string;
  proposal?: Proposal;
}

/**
 * Pure function to construct anomaly rows from doctor status data (WM-95, WM-205).
 */
export function buildAnomalyRows(
  anomalies: StatusView["anomalies"] | undefined,
  proposalsById: Map<string, Proposal>,
  callbacks: {
    onJumpProposal: (id: string) => void;
    onJumpRuns: (state?: string) => void;
    onJumpEvents: (focus: EventFocus) => void;
    onJumpRun: (runId: string) => void;
    onNavigate: (path: string) => void;
  },
  s?: StatusView,
  now?: number,
): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  if (!anomalies) return rows;

  for (const schedule of anomalies.stoppedSchedules ?? []) {
    rows.push({
      kind: "schedule",
      text: `stopped schedule ${schedule.loop}: ${schedule.error ? `error: ${schedule.error}` : `${schedule.intervalsLate} intervals late`}`,
      links: [{ label: "View schedules", go: () => callbacks.onNavigate("schedules") }],
    });
  }
  for (const proposal of anomalies.proposalsPilingUp ?? []) {
    rows.push({
      kind: "proposal",
      text: `proposals piling up for schedule ${proposal.loop}: ${proposal.count} open proposals (threshold ${proposal.threshold})`,
      links: [{ label: "View proposals", go: () => callbacks.onNavigate("proposals") }],
    });
  }
  for (const warning of anomalies.configuration ?? []) {
    rows.push({
      kind: "configuration",
      text: `configuration: ${warning}`,
      links: [],
    });
  }

  for (const id of anomalies.expiredOpenProposals) {
    rows.push({
      kind: "proposal",
      text: `expired open proposal ${id}`,
      proposalId: id,
      proposal: proposalsById.get(id),
      links: [{ label: "View proposal", go: () => callbacks.onJumpProposal(id) }],
      dismissProposalId: id,
    });
  }
  if (anomalies.staleLeases > 0) {
    rows.push({
      kind: "lease",
      text: `stale leases: ${anomalies.staleLeases}`,
      links: [{ label: "View leased runs", go: () => callbacks.onJumpRuns("LEASED") }],
    });
  }
  if (anomalies.unpublishedOutbox > 0) {
    rows.push({
      kind: "outbox",
      text: `unpublished outbox rows: ${anomalies.unpublishedOutbox}`,
      links: [
        {
          label: "View outbox",
          go: () => document.getElementById("outbox")?.scrollIntoView({ block: "start" }),
        },
      ],
    });
  }
  for (const d of anomalies.deadLettered) {
    rows.push({
      kind: "dead_letter",
      text: `dead-lettered (${d.source}, ${d.eventId}): ${d.lastError ?? "unknown error"}`,
      links: [{ label: "View event", go: () => callbacks.onJumpEvents({ source: d.source, eventId: d.eventId }) }],
      requeue: { source: d.source, eventId: d.eventId },
      archive: { source: d.source, eventId: d.eventId },
    });
  }
  for (const w of anomalies.stalledWorkers) {
    rows.push({
      kind: "worker",
      text: `stalled worker ${w.workerId} still holds run ${w.runId} (host ${w.host}, last seen ${now ? ago(w.lastSeen, now) : "recently"})`,
      links: [
        { label: "View worker", go: () => callbacks.onNavigate("workers") },
        { label: "View run", go: () => callbacks.onJumpRun(w.runId) },
      ],
      releaseWorker: { workerId: w.workerId, runId: w.runId },
    });
  }
  for (const a of anomalies.ambiguousOpenProposals) {
    rows.push({
      kind: "ambiguous",
      text: `ambiguous open proposals: ${a.count} proposals target run ${a.runId}`,
      links: [
        { label: "View proposals", go: () => callbacks.onNavigate("proposals") },
        { label: "View run", go: () => callbacks.onJumpRun(a.runId) },
      ],
    });
  }
  for (const run of anomalies.unmatchedPlacementRuns ?? []) {
    rows.push({
      kind: "capacity",
      text: `queued run ${run.runId} requires placement ${JSON.stringify(run.placement)}, but no live worker matches`,
      links: [
        { label: "View run", go: () => callbacks.onJumpRun(run.runId) },
        { label: "View workers", go: () => callbacks.onNavigate("workers") },
      ],
    });
  }
  if (anomalies.noWorkers && (s?.runs.byState?.QUEUED ?? 0) > 0) {
    rows.push({
      kind: "capacity",
      text: `${s?.runs.byState?.QUEUED ?? 0} queued runs and no live worker available to claim them`,
      links: [{ label: "View workers", go: () => callbacks.onNavigate("workers") }],
    });
  }

  return rows;
}

function CategoryPill({ kind }: { kind: AnomalyKind }) {
  const labels: Record<AnomalyKind, string> = {
    proposal: "proposal",
    dead_letter: "dead-letter",
    lease: "stalled lease",
    worker: "worker lease",
    outbox: "outbox",
    capacity: "capacity",
    ambiguous: "ambiguous",
    schedule: "schedule",
    configuration: "configuration",
  };
  return (
    <span className="shrink-0 rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-(--text-dim)">
      {labels[kind]}
    </span>
  );
}

function OverviewScopeNotice({ context }: { context: OperatorContext }) {
  if (context.kind === "all") return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-(--border) bg-(--surface-2) px-3 py-2 text-[13px] text-(--text)"
    >
      {context.kind === "inflight"
        ? "In flight filters Runs to leased and running. Other Overview counts are factory-wide."
        : `Showing ${context.name} on Events, Proposals, and Runs. Workers, artifacts, and the feeds below are factory-wide.`}
    </div>
  );
}

/**
 * Recent Outcomes Tick Strip (WM-205) — derived from journal feed
 */
function RecentOutcomesStrip({
  entries,
  now,
  onJumpRun,
}: {
  entries: JournalEntry[];
  now: number;
  onJumpRun: (runId: string) => void;
}) {
  const terminalStates = new Set(["COMPLETED", "FAILED", "REFUSED", "TIMED_OUT", "CANCELLED"]);
  const outcomes = entries.filter((e) => terminalStates.has(e.to)).slice(0, 48);

  if (outcomes.length === 0) return null;

  // Chronological left-to-right (oldest -> newest at right)
  const chrono = outcomes.slice().reverse();
  const completed = outcomes.filter((outcome) => outcome.to === "COMPLETED").length;
  const failed = outcomes.filter((outcome) => outcome.to === "FAILED").length;

  return (
    <div
      className="rounded-lg border border-(--border) bg-(--surface-1) p-3.5"
      title="Recent outcomes (newest on the right)"
    >
      <SectionTitle title="Recent outcomes" meta={`last ${outcomes.length}`} />
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {chrono.map((o) => {
            const hue =
              o.to === "COMPLETED"
                ? "var(--hue-ok)"
                : o.to === "FAILED"
                  ? "var(--hue-err)"
                  : o.to === "TIMED_OUT"
                    ? "var(--hue-warn)"
                    : "var(--text-faint)";
            const label = `${o.runId} · ${o.to} · ${ago(o.at, now)}`;
            return (
              <button
                key={o.seq}
                type="button"
                onClick={() => onJumpRun(o.runId)}
                aria-label={label}
                className="group flex size-6 cursor-pointer items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:outline-none"
                title={label}
              >
                <span
                  aria-hidden="true"
                  className="h-4 w-2 rounded-xs opacity-80 transition-all group-hover:scale-125 group-hover:opacity-100 group-hover:ring-1 group-hover:ring-(--text)"
                  style={{ backgroundColor: hue }}
                />
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-(--text-faint)" aria-label={`${completed} completed, ${failed} failed`}>
          <span className="text-(--hue-ok)">●</span>
          <span>{completed} completed</span>
          <span>·</span>
          <span className="text-(--hue-err)">●</span>
          <span>{failed} failed</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Live activity feed off GET /journal: first fetch seeds the latest entries,
 * then each 2 s poll asks only for `since=<last head>` and prepends what is
 * new — an append-only log consumed incrementally, capped at FEED_CAP shown.
 */
function useJournalFeed(): { entries: JournalEntry[]; isPending: boolean; isError: boolean } {
  const headRef = useRef(0);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const query = useQuery({
    queryKey: ["journal"],
    queryFn: async () => {
      const res = await api.journal(headRef.current, FEED_CAP);
      headRef.current = res.head;
      if (res.entries.length) {
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          const fresh = res.entries.filter((e) => !seen.has(e.seq));
          return fresh.length ? [...fresh, ...prev].slice(0, FEED_CAP) : prev;
        });
      }
      return res;
    },
    refetchInterval: 2000,
  });
  return {
    entries,
    isPending: query.isPending && entries.length === 0,
    isError: query.isError && entries.length === 0,
  };
}

const ATTENTION_KEYS = new Set(["human_needed", "dead_lettered", "FAILED", "TIMED_OUT", "expired", "stale"]);

/**
 * Overview (webui spec §4.1 + doc §10.4, pipeline OPS-360, WM-205) — the unified StageCard dashboard:
 * Band A: Promoted Doctor Anomaly Deck / Nominal status
 * Band B: 4-Stage Workload Pipeline & Capacity Cards
 * Band C: Live Recent Outcomes Telemetry
 * Band D: Housekeeping & Live Operations Feeds
 */
export function Overview({
  connected,
  context,
  onJumpRun,
  onJumpProposal,
  onJumpEvents,
  onJumpRuns,
  onJumpWorkers,
  onNavigate,
  onJumpExpired: _onJumpExpired,
  onJumpGraph: _onJumpGraph,
  onInject: _onInject,
}: {
  connected: boolean;
  context: OperatorContext;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvents: (focus: EventFocus) => void;
  onJumpRuns: (state?: string) => void;
  onJumpWorkers?: (health: WorkerHealthFilter) => void;
  onNavigate: (path: string) => void;
  onJumpExpired?: () => void;
  onJumpGraph?: () => void;
  onInject?: () => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const pollRequeue = useRequeuePoll(onJumpProposal);
  const [rejectingProposalId, setRejectingProposalId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const outbox = useQuery({
    queryKey: ["outbox"],
    queryFn: () => api.outbox(15),
    refetchInterval: 2000,
  });
  const proposalsForDeck = useQuery({
    queryKey: ["proposals"],
    queryFn: api.proposals,
    refetchInterval: 2000,
  });
  const eventsQ = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    refetchInterval: 2000,
    enabled: context.kind === "repo",
  });
  const runsQ = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    refetchInterval: 2000,
    enabled: context.kind !== "all",
  });
  const feed = useJournalFeed();

  const requeue = useMutation({
    mutationFn: ({ source, eventId }: { source: string; eventId: string }) => api.requeue(source, eventId),
    onSuccess: async (_, { source, eventId }) => {
      queryClient.invalidateQueries();
      notify(`Requeued event ${eventId}`, "ok");
      await pollRequeue(source, eventId);
    },
    onError: () => queryClient.invalidateQueries(),
  });

  const resolveAnomaly = useMutation({
    mutationFn: (
      target:
        | { kind: "archive"; source: string; eventId: string }
        | { kind: "release"; workerId: string; runId: string },
    ) => {
      if (target.kind === "archive") return api.archive(target.source, target.eventId).then(() => undefined);
      return api.releaseWorker(target.workerId, target.runId).then(() => undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      notify("Anomaly resolved", "ok");
    },
    onError: () => queryClient.invalidateQueries(),
  });

  const reject = useMutation({
    mutationFn: ({ proposalId, why }: { proposalId: string; why: string }) => {
      const trimmed = why.trim();
      if (!trimmed) return Promise.reject(new Error("Rejection reason required"));
      return api.reject(proposalId, trimmed);
    },
    onSuccess: (_, { proposalId }) => {
      queryClient.invalidateQueries();
      notify(`Rejected proposal ${proposalId}`, "info");
      setRejectingProposalId(null);
      setRejectReason("");
    },
    onError: () => queryClient.invalidateQueries(),
  });

  const closeReject = () => {
    if (reject.isPending) return;
    reject.reset();
    setRejectingProposalId(null);
    setRejectReason("");
  };

  const submitReject = () => {
    if (!rejectingProposalId || !rejectReason.trim() || reject.isPending || !connected) return;
    reject.mutate({ proposalId: rejectingProposalId, why: rejectReason });
  };

  const s = status.data;
  const anomalies = s?.anomalies;
  const proposalsById = useMemo(() => {
    return new Map<string, Proposal>(
      (proposalsForDeck.data?.proposals ?? []).map((p) => [p.id, p]),
    );
  }, [proposalsForDeck.data?.proposals]);

  const anomalyRows = useMemo(() => {
    return buildAnomalyRows(
      anomalies,
      proposalsById,
      {
        onJumpProposal,
        onJumpRuns,
        onJumpEvents,
        onJumpRun,
        onNavigate,
      },
      s,
      now,
    );
  }, [anomalies, proposalsById, onJumpProposal, onJumpRuns, onJumpEvents, onJumpRun, onNavigate, s, now]);

  const hasAnomalies = anomalyRows.length > 0;
  const anomalyRowRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey || goPrefixActive()) return;

      if ("12345".includes(e.key)) {
        e.preventDefault();
        if (e.key === "1") onJumpEvents({});
        else if (e.key === "2") onNavigate("proposals");
        else onJumpRuns(["QUEUED", "RUNNING", "COMPLETED"][+e.key - 3]);
        return;
      }

      const focusedIndex = anomalyRowRefs.current.indexOf(
        document.activeElement as HTMLDivElement,
      );
      if (e.key === "." && anomalyRows.length > 0) {
        e.preventDefault();
        anomalyRowRefs.current[(focusedIndex + 1) % anomalyRows.length]?.focus();
        return;
      }

      if (e.key === "r") {
        const focused = anomalyRows[focusedIndex];
        if (!focused?.requeue || !connected || requeue.isPending) return;
        e.preventDefault();
        requeue.mutate(focused.requeue);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anomalyRows, connected, onJumpEvents, onJumpRuns, onNavigate, requeue]);

  const activeRunStates: RunState[] = ["QUEUED", "LEASED", "RUNNING", "VERIFYING"];
  const terminalRunStates: RunState[] = ["COMPLETED", "FAILED", "REFUSED", "TIMED_OUT", "CANCELLED"];
  const factoryWide = context.kind !== "all";
  const feedsUnscoped = context.kind === "repo";
  const eventTally =
    context.kind === "repo"
      ? scopedTally(eventsQ.data?.events ?? [], context, {
          repos: (e) => e.repos,
          key: (e) => e.status,
        })
      : null;
  const runTally = factoryWide
    ? scopedTally(runsQ.data?.runs ?? [], context, {
        repos: (r) => r.repos,
        state: (r) => r.state,
        key: (r) => r.state,
      })
    : null;
  const openProposals = proposalsForDeck.data?.proposals ?? [];
  const proposalOpen =
    context.kind === "repo"
      ? scopedCount(openProposals, context, { repos: (p) => p.repos })
      : (s?.proposals.open ?? 0);
  const proposalExpired =
    context.kind === "repo"
      ? scopedCount(
          openProposals.filter((p) => p.expired),
          context,
          { repos: (p) => p.repos },
        )
      : (s?.proposals.expired ?? 0);
  const eventValue = (k: string, factory: number) => (eventTally ? (eventTally[k] ?? 0) : factory);
  const runValue = (k: RunState) => (runTally ? (runTally[k] ?? 0) : (s?.runs.byState[k] ?? 0));

  const groupedFeed = useMemo(() => groupJournalEntries(feed.entries), [feed.entries]);

  // Stage 1 metrics
  const activeEventKeys = (
    Object.keys(s?.events ?? {}) as (keyof typeof EVENT_STATUS_HUES)[]
  ).sort((a, b) => {
    const order = ["admitted", "planned", "noop", "human_needed", "dead_lettered"];
    return order.indexOf(a) - order.indexOf(b);
  });
  const eventSegs: Segment[] = activeEventKeys.map((k) => ({
    key: k,
    label: k,
    value: eventValue(k, s?.events[k] ?? 0),
    hue: EVENT_STATUS_HUES[k],
  }));
  const intakeTotal = eventSegs.reduce((a, x) => a + x.value, 0);

  // Stage 2 metrics
  const proposalSegs: Segment[] = [
    { key: "open", label: "open", value: proposalOpen, hue: "var(--hue-info)" },
    { key: "expired", label: "expired", value: proposalExpired, hue: "var(--hue-warn)" },
  ];
  const proposalTotal = proposalOpen + proposalExpired;

  // Stage 3 metrics
  const inflightSegs: Segment[] = activeRunStates.map((k) => ({
    key: k,
    label: k.toLowerCase(),
    value: runValue(k),
    hue: STATE_HUES[k],
  }));
  const terminalSegs: Segment[] = terminalRunStates.map((k) => ({
    key: k,
    label: k.toLowerCase(),
    value: runValue(k),
    hue: STATE_HUES[k],
  }));
  const inflightTotal = inflightSegs.reduce((a, x) => a + x.value, 0);
  const finishedTotal = terminalSegs.reduce((a, x) => a + x.value, 0);
  const okTotal = terminalSegs.find((x) => x.key === "COMPLETED")?.value ?? 0;
  const idleWorkers = Math.max(0, (s?.workers.live ?? 0) - (s?.workers.busy ?? 0));
  const capacity = s
    ? (s.capacity ?? {
        running: s.workers.busy,
        capacity: s.workers.live,
        queued: s.runs.byState.QUEUED ?? 0,
        live: s.workers.live,
        idle: idleWorkers,
        draining: 0,
        target: s.workers.live,
        min: null,
        max: null,
        supervisor: "absent" as const,
        source: "live-workers" as const,
        limitingFactor: null,
        classes: [],
      })
    : null;
  const jumpToWorkerHealth = (health: WorkerHealthFilter) => {
    if (onJumpWorkers) onJumpWorkers(health);
    else onNavigate("workers");
  };

  return (
    <div className="h-full min-w-0 overflow-auto p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="display text-lg font-semibold">Overview</h1>
      </div>
      <OverviewScopeNotice context={context} />

      {/* Band A: Promoted Doctor Deck or Nominal Status (WM-205) */}
      {hasAnomalies ? (
        <div
          className="mb-5 rounded-lg border p-3"
          style={{
            borderColor: "var(--hue-warn)",
            backgroundColor: "color-mix(in oklch, var(--hue-warn) 8%, var(--surface-1))",
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-(--hue-warn)">
              <span className="size-2 rounded-full bg-(--hue-warn) motion-safe:animate-pulse" />
              Anomalies · {anomalyRows.length} active issue{anomalyRows.length === 1 ? "" : "s"}
              {feedsUnscoped ? " · factory-wide" : ""}
            </div>
          </div>
          <div className="rounded-md border border-(--border) bg-(--surface-1)">
            {anomalyRows.map((a, i) => (
              <div
                key={i}
                ref={(node) => {
                  anomalyRowRefs.current[i] = node;
                }}
                tabIndex={-1}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 border-b border-(--border) px-3 py-2 last:border-0 focus-visible:outline-2 focus-visible:outline-(--accent)"
              >
                <div className="min-w-0 flex items-start sm:items-center gap-2">
                  <CategoryPill kind={a.kind} />
                  {a.proposalId ? (
                    <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 break-words text-[12px] text-(--hue-warn)">
                      <span>expired open proposal</span>
                      <span className="text-(--text-faint)">·</span>
                      <span
                        className="mono text-[11px] text-(--text-dim) cursor-pointer hover:underline"
                        title={`${a.proposalId} — click to copy`}
                        onClick={() => copyText(a.proposalId!, "proposal id")}
                      >
                        {shortId(a.proposalId)}
                      </span>
                      <span className="text-(--text-faint)">·</span>
                      <span>agent: {a.proposal?.agent ?? "—"}</span>
                      <span className="text-(--text-faint)">·</span>
                      <span>
                        {a.proposal?.decision ?? "—"}
                        {a.proposal?.reason ? ` — ${a.proposal.reason}` : ""}
                      </span>
                      <span className="text-(--text-faint)">·</span>
                      <span className="text-(--text-faint)">
                        origin {a.proposal?.eventSource ?? "—"}/{a.proposal?.eventId ?? "—"}
                      </span>
                      <span className="text-(--text-faint)">·</span>
                      {a.proposal?.created_at ? (
                        <Ago iso={a.proposal.created_at} now={now} className="mono text-(--text-faint)" />
                      ) : (
                        <span className="text-(--text-faint)">age —</span>
                      )}
                    </div>
                  ) : (
                    <span
                      className="min-w-0 break-words sm:truncate text-[12px]"
                      title={a.text}
                      style={{ color: "var(--hue-warn)" }}
                    >
                      {a.text}
                    </span>
                  )}
                </div>
                <span className="flex flex-wrap items-center gap-1.5 sm:gap-2 sm:shrink-0">
                  <button
                    type="button"
                    onClick={() => copyText(a.text, "anomaly")}
                    className="cursor-pointer text-[11px] text-(--text-faint) hover:text-(--text) hover:underline"
                  >
                    copy
                  </button>
                  {a.dismissProposalId && (
                    <Button
                      disabled={!connected || reject.isPending}
                      onClick={() => {
                        reject.reset();
                        setRejectingProposalId(a.dismissProposalId!);
                        setRejectReason("");
                      }}
                    >
                      Reject…
                    </Button>
                  )}
                  {a.archive && (
                    <Button
                      disabled={!connected || resolveAnomaly.isPending}
                      onClick={() => resolveAnomaly.mutate({ kind: "archive", ...a.archive! })}
                    >
                      Archive
                    </Button>
                  )}
                  {a.requeue && (
                    <Button
                      disabled={!connected || requeue.isPending}
                      onClick={() => requeue.mutate(a.requeue!)}
                    >
                      Requeue
                    </Button>
                  )}
                  {a.releaseWorker && (
                    <Button
                      disabled={!connected || resolveAnomaly.isPending}
                      onClick={() => resolveAnomaly.mutate({ kind: "release", ...a.releaseWorker! })}
                    >
                      Release lease
                    </Button>
                  )}
                  {a.links.map((l, idx) => (
                    <Button
                      key={l.label}
                      variant={idx === 0 ? "primary" : "default"}
                      onClick={l.go}
                    >
                      {l.label}
                    </Button>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <VerbError error={resolveAnomaly.error ?? reject.error ?? requeue.error} />
        </div>
      ) : (
        <div className="mb-5 flex items-center justify-between rounded-lg border border-(--border) bg-(--surface-1) px-3.5 py-2.5 text-[12px] text-(--text-dim)">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-(--hue-ok)" />
            <span className="font-medium text-(--text)">Doctor: All systems nominal</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-(--text-faint)">
            <span>
              as of <Ago iso={new Date(status.dataUpdatedAt || now).toISOString()} now={now} />
            </span>
            <span>·</span>
            <span>{feedsUnscoped ? "scope: factory-wide" : "scope: all repos"}</span>
          </div>
        </div>
      )}

      {/* Band B: Unified Stage Cards (WM-205) */}
      {!s ? (
        <div className="mb-6 text-(--text-faint)">
          {status.isError ? "Cannot reach the control API." : "Loading overview…"}
        </div>
      ) : (
        <div className="mb-6 flex flex-col gap-4">
          {/* Card 1: Intake & Approval Gate */}
          <StageCard
            title="Intake & Approval Gate"
            headline={intakeTotal}
            meta="events"
          >
            {/* Sub-row 1: Event Intake */}
            <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
              <span className="font-semibold text-(--text)">Event Intake</span>
            </div>
            {intakeTotal > 0 ? (
              <>
                <SegmentMeter
                  segments={eventSegs}
                  onSegment={(k) => onJumpEvents({ status: k })}
                />
                <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                  {eventSegs.map((seg) => (
                    <StatLegendItem
                      key={seg.key}
                      token={seg.key}
                      label={`events · ${seg.key}`}
                      value={seg.value}
                      hue={seg.value > 0 ? seg.hue : undefined}
                      attention={ATTENTION_KEYS.has(seg.key)}
                      onClick={() => onJumpEvents({ status: seg.key })}
                      total={intakeTotal}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="text-[12px] text-(--text-faint)">no events yet</div>
            )}

            {/* Sub-row 2: Approval Gate */}
            <div className="mt-3.5 border-t border-(--border) pt-2.5">
              <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
                <span className="font-semibold text-(--text)">Approval Gate</span>
                <span className="mono text-(--text-dim)">
                  {proposalTotal > 0
                    ? `${proposalExpired > 0 ? `${proposalExpired} expired · ` : ""}${proposalOpen} open`
                    : "no proposals in gate"}
                </span>
              </div>
              {proposalTotal > 0 ? (
                <>
                  <SegmentMeter
                    segments={proposalSegs}
                    onSegment={() => onNavigate("proposals")}
                  />
                  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                    <StatLegendItem
                      token="open"
                      label="proposals · open"
                      value={proposalOpen}
                      hue={proposalOpen > 0 ? "var(--hue-info)" : undefined}
                      onClick={() => onNavigate("proposals")}
                      total={proposalTotal}
                    />
                    <StatLegendItem
                      token="expired"
                      label="proposals · expired"
                      value={proposalExpired}
                      hue={proposalExpired > 0 ? "var(--hue-warn)" : undefined}
                      attention={proposalExpired > 0}
                      onClick={() => onNavigate("proposals")}
                      total={proposalTotal}
                    />
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-(--text-faint)">no proposals in gate</div>
              )}
            </div>

            {/* Sub-row 3: Waiting on you (inbox ledger, WM-286). Absent on a
                pre-inbox control API — the row simply does not render. */}
            {s.inbox && (
              <div className="mt-3.5 border-t border-(--border) pt-2.5">
                <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
                  <span className="font-semibold text-(--text)">Waiting on you</span>
                  <span className="mono text-(--text-dim)">
                    {s.inbox.open > 0
                      ? `${s.inbox.open} open${s.inbox.acked > 0 ? ` · ${s.inbox.acked} acked` : ""}`
                      : s.inbox.acked > 0
                        ? `${s.inbox.acked} acked`
                        : "nothing waiting"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("inbox")}
                  aria-label={`Waiting on you: ${s.inbox.open} open inbox item${s.inbox.open === 1 ? "" : "s"} — open the inbox`}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-(--border) bg-(--surface-1) px-3 py-1.5 text-left hover:bg-(--surface-2)"
                >
                  <span
                    className="display text-xl tabular-nums"
                    style={s.inbox.open > 0 ? { color: "var(--hue-warn)" } : undefined}
                  >
                    {s.inbox.open}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-(--text-faint)">
                    {s.inbox.open > 0 && s.inbox.byKind
                      ? (() => {
                          const kinds = Object.entries(s.inbox.byKind!)
                            .filter(([, n]) => n > 0)
                            .sort((a, b) => b[1] - a[1]);
                          const total = kinds.reduce((sum, [, n]) => sum + n, 0);
                          // byKind spans open + acked on the API; say so when the
                          // breakdown would not add up to the open headline.
                          const prefix = total !== s.inbox!.open ? "open + acked · " : "";
                          return prefix + kinds.map(([kind, n]) => `${n} ${kind}`).join(" · ");
                        })()
                      : "Nothing needs a decision right now."}
                  </span>
                  <span className="mono text-[11px] text-(--text-faint)">g n →</span>
                </button>
              </div>
            )}
          </StageCard>

          {/* Card 2: Execution & Fleet Capacity */}
          <StageCard
            title="Execution & Fleet Capacity"
            headline={finishedTotal + inflightTotal}
            meta="runs"
          >
            {/* Sub-row 1: Active In-Flight Workloads */}
            <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
              <span className="font-semibold text-(--text)">Active In-Flight Pipeline</span>
              {inflightTotal > 0 && (
                <span className="mono text-(--text-dim)">{inflightTotal} active</span>
              )}
            </div>
            {inflightTotal > 0 ? (
              <>
                <SegmentMeter
                  segments={inflightSegs}
                  onSegment={(k) => onJumpRuns(k)}
                />
                <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                  {inflightSegs.map((seg) => (
                    <StatLegendItem
                      key={seg.key}
                      token={seg.key}
                      label={`active · ${seg.label}`}
                      value={seg.value}
                      hue={seg.value > 0 ? seg.hue : undefined}
                      onClick={() => onJumpRuns(seg.key)}
                      total={inflightTotal}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="text-[12px] text-(--text-faint)">nothing in flight</div>
            )}

            {/* Sub-row 2: Outcomes */}
            <div className="mt-3.5 border-t border-(--border) pt-2.5">
              <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
                <span className="font-semibold text-(--text)">Terminal Outcomes</span>
                <span className="mono text-(--text-dim)">
                  {finishedTotal > 0
                    ? `${Math.round((okTotal / finishedTotal) * 100)}% completed (${finishedTotal} runs)`
                    : "no terminal runs"}
                </span>
              </div>
              {finishedTotal > 0 ? (
                <>
                  <SegmentMeter
                    segments={terminalSegs}
                    onSegment={(k) => onJumpRuns(k)}
                  />
                  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                    {terminalSegs.map((seg) => (
                      <StatLegendItem
                        key={seg.key}
                        token={seg.key}
                        label={`runs · ${seg.label}`}
                        value={seg.value}
                        hue={seg.value > 0 ? seg.hue : undefined}
                        attention={ATTENTION_KEYS.has(seg.key)}
                        onClick={() => onJumpRuns(seg.key)}
                        total={finishedTotal}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-(--text-faint)">no terminal runs</div>
              )}
            </div>

            {/* Sub-row 3: Worker Fleet Capacity */}
            <div className="mt-3.5 border-t border-(--border) pt-2.5">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold text-(--text)">
                  Worker Fleet Capacity{factoryWide ? " · factory-wide" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate("workers")}
                  aria-label={`worker capacity${factoryWide ? " · factory-wide" : ""}: ${capacity!.running} running of ${capacity!.capacity}, ${capacity!.queued} queued`}
                  className="mono cursor-pointer rounded-full border border-(--border) bg-(--surface-2) px-2.5 py-1 text-(--text-dim) hover:text-(--text)"
                >
                  <strong className="text-(--text)">{capacity!.running}/{capacity!.capacity}</strong> capacity · {capacity!.queued} queued
                  {capacity!.draining > 0 ? ` · ${capacity!.draining} draining` : ""}
                </button>
              </div>
              {capacity!.queued > 0 && capacity!.limitingFactor && (
                <div className="mb-2 text-[11px] text-(--hue-warn)">
                  Queue is waiting: <strong>{capacity!.limitingFactor}</strong>
                </div>
              )}
              {capacity!.classes.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-(--text-dim)">
                  {capacity!.classes.map((workerClass) => (
                    <span key={workerClass.name} className="mono rounded-full bg-(--surface-2) px-2 py-0.5">
                      {workerClass.name} {workerClass.running}/{workerClass.capacity}
                    </span>
                  ))}
                </div>
              )}
              <div className="mb-1.5 mono text-[11px] text-(--text-dim)">
                {s.workers.live} live · {s.workers.busy} busy · {idleWorkers} idle{s.workers.stale > 0 ? ` · ${s.workers.stale} stale` : ""}
              </div>
              <SegmentMeter
                segments={[
                  { key: "busy", label: "busy", value: s.workers.busy, hue: "var(--hue-info)" },
                  { key: "idle", label: "idle", value: idleWorkers, hue: "var(--hue-ok)" },
                  { key: "stale", label: "stale", value: s.workers.stale, hue: "var(--hue-warn)" },
                ]}
                onSegment={(status) =>
                  jumpToWorkerHealth(status === "busy" || status === "stale" ? status : "live")
                }
              />
              <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                <StatLegendItem
                  token="live"
                  label="workers · live"
                  value={s.workers.live}
                  hue={s.workers.live > 0 ? "var(--hue-ok)" : undefined}
                  onClick={() => jumpToWorkerHealth("live")}
                  factoryWide={factoryWide}
                  total={s.workers.live + s.workers.stale}
                />
                <StatLegendItem
                  token="busy"
                  label="workers · busy"
                  value={s.workers.busy}
                  hue={s.workers.busy > 0 ? "var(--hue-info)" : undefined}
                  onClick={() => jumpToWorkerHealth("busy")}
                  factoryWide={factoryWide}
                  total={s.workers.live + s.workers.stale}
                />
                <StatLegendItem
                  token="stale"
                  label="workers · stale"
                  value={s.workers.stale}
                  hue={s.workers.stale > 0 ? "var(--hue-warn)" : undefined}
                  attention={s.workers.stale > 0}
                  onClick={() => jumpToWorkerHealth("stale")}
                  factoryWide={factoryWide}
                  total={s.workers.live + s.workers.stale}
                />
              </div>
            </div>
          </StageCard>

          {/* Band C: Recent Outcomes Strip */}
          <RecentOutcomesStrip
            entries={feed.entries}
            now={now}
            onJumpRun={onJumpRun}
          />

          {/* Band D: Artifact Store Housekeeping Line */}
          <div className="rounded-lg border border-(--border) bg-(--surface-1) px-3.5 py-2.5 text-(--text-dim)">
            <SectionTitle
              title="Artifacts store"
              className="mb-0"
              meta={
                <span className="mono">
                  {s.artifacts.files} files · {humanSize(s.artifacts.bytes)}
                  {s.artifacts.orphans > 0 ? ` · ${s.artifacts.orphans} orphans` : ""}
                  {factoryWide ? " · factory-wide" : ""}
                </span>
              }
            />
          </div>
        </div>
      )}

      {/* Band D Feeds: Real-time Activity Stream & Outbox Results */}
      <div className="grid gap-x-5 xl:grid-cols-2">
        <OverviewSection
          title="Activity"
          meta={`latest ${Math.min(feed.entries.length, FEED_CAP)}${feedsUnscoped ? " · factory-wide" : ""}`}
        >
          {feed.entries.length === 0 ? (
            <div className="text-(--text-faint)">
              {feed.isPending
                ? "Loading activity…"
                : feed.isError
                  ? "Cannot reach the control API."
                  : "No lifecycle activity yet."}
            </div>
          ) : (
            <div
              className="max-h-[420px] overflow-y-auto rounded-md border border-(--border) px-3 py-1"
              aria-live="off"
            >
              {groupedFeed.map((group) => {
                const row = formatActivityGroup(group);
                return (
                  <div key={group.seq} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-(--border) py-1.5 last:border-0">
                    <Ago iso={group.at} now={now} className="mono shrink-0 text-(--text-faint)" />
                    <span className="text-(--text-faint)">·</span>
                    <JumpLink onClick={() => onJumpRun(group.runId)} title={group.runId} className="shrink-0">
                      {shortId(group.runId)}
                    </JumpLink>
                    <span className="text-(--text-faint)">·</span>
                    <StateBadge state={group.to} />
                    {row.steps && (
                      <span className="shrink-0 text-[11px] text-(--text-faint)" title={row.path}>
                        {row.steps}
                      </span>
                    )}
                    <span className="text-(--text-faint)">·</span>
                    <span className="shrink-0 text-(--text-faint)">by {shortId(group.actor)}</span>
                    {row.reason && (
                      <>
                        <span className="text-(--text-faint)">·</span>
                        <span className="min-w-0 break-words text-(--text-dim)">{row.reason}</span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </OverviewSection>

        <OverviewSection
          title="Outbox"
          meta={`published results${feedsUnscoped ? " · factory-wide" : ""}`}
        >
          <div id="outbox">
            {(outbox.data?.outbox ?? []).length === 0 ? (
              <div className="text-(--text-faint)">
                {outbox.isPending && !outbox.data
                  ? "Loading outbox…"
                  : outbox.isError && !outbox.data
                    ? "Cannot reach the control API."
                    : "Nothing published yet."}
              </div>
            ) : (
              <div className="rounded-md border border-(--border) px-3 py-1" aria-live="off">
                {(outbox.data?.outbox ?? []).map((o) => {
                  const type = String(o.event.type ?? "unknown event");
                  const source = typeof o.event.source === "string" ? o.event.source : null;
                  const eventId = typeof o.event.eventId === "string" ? o.event.eventId : null;
                  const payload = (o.event.payload ?? {}) as Record<string, unknown>;
                  const summary =
                    typeof payload.outcome === "string"
                      ? payload.outcome
                      : typeof payload.recommendation === "string"
                        ? payload.recommendation
                        : typeof payload.verdict === "string"
                          ? payload.verdict
                          : null;

                  return (
                    <div key={o.seq} className="border-b border-(--border) py-1.5 last:border-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="flex items-baseline gap-2 min-w-0 max-w-[75%]">
                          {source && eventId ? (
                            <JumpLink
                              onClick={() => onJumpEvents({ source, eventId })}
                              title={`Open origin event — ${type}`}
                              className="truncate font-medium"
                            >
                              {type}
                            </JumpLink>
                          ) : (
                            <span className="truncate text-(--text-dim) font-medium" title={type}>
                              {type}
                            </span>
                          )}
                          {summary && (
                            <span className="mono truncate text-[11px] text-(--text-faint)">
                              [{summary}]
                            </span>
                          )}
                        </div>
                        {o.published_at ? (
                          <Ago iso={o.published_at} now={now} className="mono shrink-0 text-(--text-faint)" />
                        ) : (
                          <span className="shrink-0 text-[11px] text-(--hue-warn)">
                            unpublished
                          </span>
                        )}
                      </div>
                      <Disclosure label="event JSON">
                        <JsonBlock value={o.event} />
                      </Disclosure>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </OverviewSection>
      </div>

      {rejectingProposalId && (
        <Dialog title="Reject expired proposal?" onClose={closeReject}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitReject();
            }}
          >
            <p className="mb-3 text-[12px] text-(--text-dim)">
              Rejections are audit records. Explain why this proposal should not run.
            </p>
            <label
              htmlFor="overview-rejection-reason"
              className="mb-1 block text-[11px] font-medium text-(--text-faint)"
            >
              Rejection reason
            </label>
            <input
              id="overview-rejection-reason"
              autoFocus
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Reason (required — rejections are audit records)"
              className="w-full rounded-md border border-(--border-strong) bg-(--surface-1) px-2.5 py-1.5 text-(--text) outline-none focus:border-(--accent)"
            />
            <VerbError error={reject.error} />
            <div className="mt-4 flex justify-end gap-2">
              <Button disabled={reject.isPending} onClick={closeReject}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={!rejectReason.trim() || reject.isPending || !connected}
                onClick={submitReject}
              >
                {reject.isPending ? "Rejecting…" : "Reject proposal"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { hashPath } from "../hash";
import { useNow, useRequeuePoll } from "../hooks";
import type { JournalEntry, EventFocus, Proposal, RunState, StatusView } from "../types";
import type { OperatorContext } from "../context";
import { scopedCount, scopedTally } from "../context";
import {
  Ago,
  Button,
  Disclosure,
  EVENT_STATUS_HUES,
  STATE_HUES,
  humanSize,
  JsonBlock,
  JumpLink,
  Section,
  StateBadge,
  VerbError,
  ago,
  copyText,
  notify,
  shortId,
} from "../components/ui";

const FEED_CAP = 50;

/**
 * 14px viewBox, 1.5px stroke state icons per OPS-498 / §5.2.
 * Shape is redundancy for color-blind and peripheral reading.
 */
export function StateIcon({ state, className = "size-3.5 shrink-0" }: { state: string; className?: string }) {
  const norm = state.toLowerCase();
  switch (norm) {
    case "admitted":
      return (
        <svg viewBox="0 0 14 14" fill="currentColor" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="3" />
        </svg>
      );
    case "planned":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
          <polygon points="5,3.5 10.5,7 5,10.5" fill="currentColor" fillOpacity="0.2" />
        </svg>
      );
    case "noop":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <line x1="4" y1="7" x2="10" y2="7" />
        </svg>
      );
    case "human_needed":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <path d="M7 2.5 L12 11.5 L2 11.5 Z" fill="currentColor" fillOpacity="0.18" />
          <line x1="7" y1="5.5" x2="7" y2="8" />
          <circle cx="7" cy="9.8" r="0.5" fill="currentColor" />
        </svg>
      );
    case "dead_lettered":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <line x1="3.8" y1="10.2" x2="10.2" y2="3.8" />
        </svg>
      );
    case "queued":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
        </svg>
      );
    case "leased":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <circle cx="7" cy="7" r="1.8" fill="currentColor" />
        </svg>
      );
    case "running":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M7 2.5 A4.5 4.5 0 0 1 7 11.5 Z" fill="currentColor" />
        </svg>
      );
    case "verifying":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="6" cy="6" r="3.5" />
          <line x1="8.5" y1="8.5" x2="11.5" y2="11.5" />
        </svg>
      );
    case "completed":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="currentColor" fillOpacity="0.18" />
          <polyline points="4.8,7.2 6.3,8.7 9.3,5.3" />
        </svg>
      );
    case "failed":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="currentColor" fillOpacity="0.18" />
          <line x1="5" y1="5" x2="9" y2="9" />
          <line x1="9" y1="5" x2="5" y2="9" />
        </svg>
      );
    case "timed_out":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <polyline points="7,4.5 7,7 9,7" />
        </svg>
      );
    case "cancelled":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <line x1="4" y1="7" x2="10" y2="7" />
        </svg>
      );
    case "refused":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <line x1="10" y1="4" x2="4" y2="10" />
        </svg>
      );
    case "open":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" strokeDasharray="3 2" />
        </svg>
      );
    case "expired":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="currentColor" fillOpacity="0.18" />
          <line x1="7" y1="4" x2="7" y2="7.5" />
          <circle cx="7" cy="9.5" r="0.5" fill="currentColor" />
        </svg>
      );
    case "live":
    case "idle":
      return (
        <svg viewBox="0 0 14 14" fill="currentColor" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="3.5" />
        </svg>
      );
    case "busy":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M7 2.5 A4.5 4.5 0 0 1 7 11.5 Z" fill="currentColor" />
        </svg>
      );
    case "stale":
      return (
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="currentColor" fillOpacity="0.18" />
          <line x1="7" y1="4" x2="7" y2="7.5" />
          <circle cx="7" cy="9.5" r="0.5" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 14 14" fill="currentColor" className={className} aria-hidden="true">
          <circle cx="7" cy="7" r="2.5" />
        </svg>
      );
  }
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
      <div className="h-1.5 w-full rounded-full bg-(--surface-2)" title="No active items in this stage" />
    );
  }

  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-(--surface-2)">
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
}: {
  token: string;
  label: string;
  value: ReactNode;
  hue?: string;
  attention?: boolean;
  onClick?: () => void;
  factoryWide?: boolean;
}) {
  const isZero = value === 0 || value === "0";
  const lit = attention && !isZero && hue;
  const fullLabel = factoryWide ? `${label} · factory-wide` : label;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${fullLabel}: ${value}`}
      style={lit ? { color: hue } : undefined}
      className={`group flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors
        hover:bg-(--surface-2) ${isZero ? "opacity-45" : ""} ${lit ? "" : "text-(--text-dim)"}`}
    >
      <StateIcon state={token} />
      <span className={lit ? "" : "group-hover:text-(--text)"}>
        {label.split(" · ").pop()}
      </span>
      <span
        className="mono tabular-nums font-medium"
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
  index: number;
  title: string;
  headline?: ReactNode;
  headlineHue?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-(--border) bg-(--surface-1) p-3.5 ${className}`}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-(--text-faint)">
          {index}. {title}
        </h2>
        <div className="flex items-baseline gap-2">
          {meta && <span className="text-[11px] text-(--text-faint)">{meta}</span>}
          {headline != null && (
            <span
              className="display text-xl font-semibold tabular-nums"
              style={headlineHue ? { color: headlineHue } : undefined}
            >
              {headline}
            </span>
          )}
        </div>
      </div>
      {children}
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
        at: e.at,
      });
    }
  }
  return groups;
}

export type AnomalyKind =
  | "proposal"
  | "dead_letter"
  | "worker"
  | "lease"
  | "outbox"
  | "capacity"
  | "ambiguous";

export interface AnomalyRow {
  kind: AnomalyKind;
  text: string;
  links: { label: string; go: () => void }[];
  requeue?: { source: string; eventId: string };
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
      links: [
        {
          label: "View event",
          go: () => callbacks.onJumpEvents({ status: "dead_lettered", source: d.source, eventId: d.eventId }),
        },
      ],
      requeue: { source: d.source, eventId: d.eventId },
    });
  }
  for (const w of anomalies.stalledWorkers) {
    const ageStr = now ? ago(w.lastSeen, now) : "stalled";
    rows.push({
      kind: "worker",
      text: `stalled worker ${w.workerId} still holds run ${w.runId} — last heartbeat ${ageStr} on ${w.host}`,
      links: [
        { label: "View worker", go: () => callbacks.onNavigate(hashPath("workers", w.workerId)) },
        { label: "View run", go: () => callbacks.onJumpRun(w.runId) },
      ],
    });
  }
  for (const amb of anomalies.ambiguousOpenProposals ?? []) {
    rows.push({
      kind: "ambiguous",
      text: `ambiguous open proposals: ${amb.count} open proposals exist for run ${amb.runId}`,
      links: [
        { label: "View run", go: () => callbacks.onJumpRun(amb.runId) },
        { label: "View proposals", go: () => callbacks.onNavigate("proposals") },
      ],
    });
  }
  if (anomalies.noWorkers) {
    const queued = s?.runs.byState.QUEUED ?? 0;
    rows.push({
      kind: "capacity",
      text: `${queued} queued run${queued === 1 ? "" : "s"} and no live worker to claim ${queued === 1 ? "it" : "them"} — nothing will start until one registers`,
      links: [
        { label: "View workers", go: () => callbacks.onNavigate("workers") },
        { label: "View queued runs", go: () => callbacks.onJumpRuns("QUEUED") },
      ],
    });
  }

  return rows;
}

function CategoryPill({ kind }: { kind: AnomalyKind }) {
  const labels: Record<AnomalyKind, string> = {
    proposal: "PROPOSAL",
    dead_letter: "DEAD-LETTER",
    lease: "STALLED LEASE",
    worker: "WORKER LEASE",
    outbox: "OUTBOX",
    capacity: "CAPACITY",
    ambiguous: "AMBIGUOUS",
  };
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider bg-(--surface-2) text-(--hue-warn) border border-(--hue-warn)/20">
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

  return (
    <div className="rounded-lg border border-(--border) bg-(--surface-1) p-3.5">
      <div className="mb-2 flex items-baseline justify-between text-[11px]">
        <span className="font-medium uppercase tracking-wide text-(--text-faint)">
          Recent Outcomes ({outcomes.length})
        </span>
        <span className="text-[11px] text-(--text-faint)">newest → oldest</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {outcomes.map((o) => {
          const hue =
            o.to === "COMPLETED"
              ? "var(--hue-ok)"
              : o.to === "FAILED"
                ? "var(--hue-err)"
                : o.to === "TIMED_OUT"
                  ? "var(--hue-warn)"
                  : "var(--text-faint)";
          return (
            <button
              key={o.seq}
              type="button"
              onClick={() => onJumpRun(o.runId)}
              className="h-4 w-2 rounded-xs transition-opacity hover:opacity-100 opacity-80"
              style={{ backgroundColor: hue }}
              title={`${o.runId} · ${o.to}${o.reason ? ` (${o.reason})` : ""} · ${ago(o.at, now)}`}
            />
          );
        })}
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
  onNavigate,
  onJumpExpired: _onJumpExpired,
  onJumpGraph,
  onInject,
}: {
  connected: boolean;
  context: OperatorContext;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvents: (focus: EventFocus) => void;
  onJumpRuns: (state?: string) => void;
  onNavigate: (path: string) => void;
  onJumpExpired: () => void;
  onJumpGraph: () => void;
  onInject: () => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const pollRequeue = useRequeuePoll(onJumpProposal);
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

  const dismiss = useMutation({
    mutationFn: (proposalId: string) => api.reject(proposalId),
    onSuccess: (_, proposalId) => {
      queryClient.invalidateQueries();
      notify(`Dismissed proposal ${proposalId}`, "ok");
    },
    onError: () => queryClient.invalidateQueries(),
  });

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

  return (
    <div className="h-full min-w-0 overflow-auto p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="display text-lg font-semibold">Overview</h1>
        <div className="flex gap-3 text-[12px] text-(--text-dim)">
          <button type="button" className="hover:text-(--accent)" onClick={onJumpGraph}>
            Graph
          </button>
          <button type="button" className="hover:text-(--accent)" onClick={onInject}>
            Inject event…
          </button>
        </div>
      </div>
      <OverviewScopeNotice context={context} />

      {/* Band A: Promoted Doctor Deck or Nominal Status (WM-205) */}
      {hasAnomalies ? (
        <div className="mb-5 rounded-lg border border-(--hue-warn) bg-[color-mix(in_oklch,var(--hue-warn)_8%,var(--surface-1))] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-(--hue-warn) uppercase tracking-wide">
              <span className="size-2 rounded-full bg-(--hue-warn) motion-safe:animate-pulse" />
              Doctor Anomaly Deck · {anomalyRows.length} active issue{anomalyRows.length === 1 ? "" : "s"}
              {feedsUnscoped ? " · factory-wide" : ""}
            </div>
          </div>
          <div className="rounded-md border border-(--border) bg-(--surface-1)">
            {anomalyRows.map((a, i) => (
              <div
                key={i}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 border-b border-(--border) px-3 py-2 last:border-0"
              >
                <div className="min-w-0 flex items-start sm:items-center gap-2">
                  <CategoryPill kind={a.kind} />
                  {a.proposalId ? (
                    <span className="min-w-0 flex flex-col gap-0.5 text-[12px] text-(--hue-warn)">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 break-words">
                        <span>expired open proposal</span>
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
                      </span>
                      <span
                        className="mono truncate text-[11px] text-(--text-faint) cursor-pointer"
                        title={`${a.proposalId} — click to copy`}
                        onClick={() => copyText(a.proposalId!, "proposal id")}
                      >
                        {a.proposalId}
                      </span>
                    </span>
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
                  <Button onClick={() => copyText(a.text, "anomaly")}>Copy</Button>
                  {a.requeue && (
                    <Button
                      disabled={!connected || requeue.isPending}
                      onClick={() => requeue.mutate(a.requeue!)}
                    >
                      Requeue
                    </Button>
                  )}
                  {a.dismissProposalId && (
                    <Button
                      disabled={!connected || dismiss.isPending}
                      onClick={() => dismiss.mutate(a.dismissProposalId!)}
                    >
                      Dismiss
                    </Button>
                  )}
                  {a.links.map((l) => (
                    <Button key={l.label} onClick={l.go}>
                      {l.label}
                    </Button>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <VerbError error={requeue.error} />
        </div>
      ) : (
        <div className="mb-5 flex items-center justify-between rounded-lg border border-(--border) bg-(--surface-1) px-3.5 py-2.5 text-[12px] text-(--text-dim)">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-(--hue-ok)" />
            <span className="font-medium text-(--text)">Doctor: All systems nominal</span>
            <span className="text-(--text-faint)">·</span>
            <span className="text-(--text-faint)">No active anomalies detected</span>
          </div>
          <div className="text-[11px] text-(--text-faint)">
            {feedsUnscoped ? "factory-wide" : "in scope"}
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
          {/* Stage 1 & Stage 2 in 2-column layout */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Stage 1: Event Intake & Triage Card */}
            <StageCard
              index={1}
              title="Event Intake & Triage"
              headline={intakeTotal}
              meta={intakeTotal > 0 ? `${intakeTotal} total` : "no events yet"}
              className="lg:col-span-2"
            >
              <SegmentMeter
                segments={eventSegs}
                onSegment={(k) => onJumpEvents({ status: k })}
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-1">
                {eventSegs.map((seg) => (
                  <StatLegendItem
                    key={seg.key}
                    token={seg.key}
                    label={`events · ${seg.key}`}
                    value={seg.value}
                    hue={seg.value > 0 ? seg.hue : undefined}
                    attention={ATTENTION_KEYS.has(seg.key)}
                    onClick={() => onJumpEvents({ status: seg.key })}
                  />
                ))}
              </div>
            </StageCard>

            {/* Stage 2: Watched Approval Gate Card */}
            <StageCard
              index={2}
              title="Watched Approval Gate"
              headline={proposalTotal}
              headlineHue={proposalExpired > 0 ? "var(--hue-warn)" : proposalOpen > 0 ? "var(--hue-info)" : undefined}
              meta={proposalExpired > 0 ? `${proposalExpired} expired` : "gate queue"}
            >
              <SegmentMeter
                segments={proposalSegs}
                onSegment={() => onNavigate("proposals")}
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-1">
                <StatLegendItem
                  token="open"
                  label="proposals · open"
                  value={proposalOpen}
                  hue={proposalOpen > 0 ? "var(--hue-info)" : undefined}
                  onClick={() => onNavigate("proposals")}
                />
                <StatLegendItem
                  token="expired"
                  label="proposals · expired"
                  value={proposalExpired}
                  hue={proposalExpired > 0 ? "var(--hue-warn)" : undefined}
                  attention={proposalExpired > 0}
                  onClick={() => onNavigate("proposals")}
                />
              </div>
            </StageCard>
          </div>

          {/* Stage 3: Execution Fleet & Capacity Card */}
          <StageCard
            index={3}
            title="Execution Fleet & Capacity"
            headline={inflightTotal}
            headlineHue={inflightTotal > 0 ? "var(--hue-info)" : undefined}
            meta="in flight"
          >
            {/* Sub-row 1: Active In-Flight Workloads */}
            <div className="mb-1 text-[11px] font-medium text-(--text-faint)">
              Active In-Flight Pipeline
            </div>
            <SegmentMeter
              segments={inflightSegs}
              onSegment={(k) => onJumpRuns(k)}
            />
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {inflightSegs.map((seg) => (
                <StatLegendItem
                  key={seg.key}
                  token={seg.key}
                  label={`active · ${seg.label}`}
                  value={seg.value}
                  hue={seg.value > 0 ? seg.hue : undefined}
                  onClick={() => onJumpRuns(seg.key)}
                />
              ))}
            </div>

            {/* Sub-row 2: Outcomes */}
            <div className="mt-3.5 border-t border-(--border) pt-2.5">
              <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
                <span className="font-medium text-(--text-faint)">Terminal Outcomes</span>
                <span className="mono text-(--text-dim)">
                  {finishedTotal > 0 ? `${Math.round((okTotal / finishedTotal) * 100)}% completed (${finishedTotal} total)` : "no terminal runs"}
                </span>
              </div>
              <SegmentMeter
                segments={terminalSegs}
                onSegment={(k) => onJumpRuns(k)}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {terminalSegs.map((seg) => (
                  <StatLegendItem
                    key={seg.key}
                    token={seg.key}
                    label={`runs · ${seg.label}`}
                    value={seg.value}
                    hue={seg.value > 0 ? seg.hue : undefined}
                    attention={ATTENTION_KEYS.has(seg.key)}
                    onClick={() => onJumpRuns(seg.key)}
                  />
                ))}
              </div>
            </div>

            {/* Sub-row 3: Worker Fleet Capacity */}
            <div className="mt-3.5 border-t border-(--border) pt-2.5">
              <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
                <span className="font-medium text-(--text-faint)">
                  Worker Fleet Capacity{factoryWide ? " · factory-wide" : ""}
                </span>
                <span className="mono text-(--text-dim)">
                  {s.workers.live} live · {s.workers.busy} busy · {idleWorkers} idle{s.workers.stale > 0 ? ` · ${s.workers.stale} stale` : ""}
                </span>
              </div>
              <SegmentMeter
                segments={[
                  { key: "busy", label: "busy", value: s.workers.busy, hue: "var(--hue-info)" },
                  { key: "idle", label: "idle", value: idleWorkers, hue: "var(--hue-ok)" },
                  { key: "stale", label: "stale", value: s.workers.stale, hue: "var(--hue-warn)" },
                ]}
                onSegment={() => onNavigate("workers")}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <StatLegendItem
                  token="live"
                  label="workers · live"
                  value={s.workers.live}
                  hue={s.workers.live > 0 ? "var(--hue-ok)" : undefined}
                  onClick={() => onNavigate("workers")}
                  factoryWide={factoryWide}
                />
                <StatLegendItem
                  token="busy"
                  label="workers · busy"
                  value={s.workers.busy}
                  hue={s.workers.busy > 0 ? "var(--hue-info)" : undefined}
                  onClick={() => onNavigate("workers")}
                  factoryWide={factoryWide}
                />
                <StatLegendItem
                  token="stale"
                  label="workers · stale"
                  value={s.workers.stale}
                  hue={s.workers.stale > 0 ? "var(--hue-warn)" : undefined}
                  attention={s.workers.stale > 0}
                  onClick={() => onNavigate("workers")}
                  factoryWide={factoryWide}
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
          <div className="flex items-center justify-between rounded-lg border border-(--border) bg-(--surface-1) px-3.5 py-2.5 text-[12px] text-(--text-dim)">
            <div className="flex items-center gap-2">
              <span className="font-medium text-(--text)">Artifacts Store</span>
              <span className="text-(--text-faint)">·</span>
              <span className="mono">{s.artifacts.files} files</span>
              <span className="text-(--text-faint)">·</span>
              <span className="mono">{humanSize(s.artifacts.bytes)}</span>
              {s.artifacts.orphans > 0 && (
                <>
                  <span className="text-(--text-faint)">·</span>
                  <span className="mono text-(--hue-warn)">{s.artifacts.orphans} orphans</span>
                </>
              )}
            </div>
            {factoryWide && <span className="text-[11px] text-(--text-faint)">factory-wide</span>}
          </div>
        </div>
      )}

      {/* Band D Feeds: Real-time Activity Stream & Outbox Results */}
      <div className="grid gap-x-5 xl:grid-cols-2">
        <Section
          title={
            feedsUnscoped
              ? `Activity · latest ${Math.min(feed.entries.length, FEED_CAP)} · factory-wide`
              : `Activity · latest ${Math.min(feed.entries.length, FEED_CAP)}`
          }
          card={false}
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
              {groupedFeed.map((g) => (
                <div key={g.seq} className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                  <Ago iso={g.at} now={now} className="mono w-[52px] shrink-0 text-(--text-faint)" />
                  <JumpLink
                    onClick={() => onJumpRun(g.runId)}
                    title={g.runId}
                    className="max-w-36 shrink-0 truncate"
                  >
                    {shortId(g.runId)}
                  </JumpLink>
                  <span className="shrink-0">
                    {g.from ? `${g.from} → ` : "START → "}
                    {g.count > 1 ? "… → " : ""}
                    <StateBadge state={g.to} />
                  </span>
                  <span
                    className="truncate text-(--text-faint)"
                    title={`by ${g.actor}${g.reason ? ` (${g.reason})` : ""}${g.count > 1 ? ` · ${g.count} transitions` : ""}`}
                  >
                    by {g.actor}
                    {g.reason ? ` (${g.reason})` : ""}
                    {g.count > 1 ? ` · ${g.count} transitions` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title={feedsUnscoped ? "Outbox — published results · factory-wide" : "Outbox — published results"}
          card={false}
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
        </Section>
      </div>
    </div>
  );
}

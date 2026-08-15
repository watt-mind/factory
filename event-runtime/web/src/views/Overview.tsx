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
  humanSize,
  JsonBlock,
  JumpLink,
  Section,
  StateBadge,
  StatTile,
  VerbError,
  ago,
  copyText,
  notify,
  shortId,
} from "../components/ui";

const FEED_CAP = 50;

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

function OverviewTile({
  label,
  value,
  hue,
  onClick,
  factoryWide = false,
}: {
  label: string;
  value: ReactNode;
  hue?: string;
  onClick?: () => void;
  factoryWide?: boolean;
}) {
  return (
    <div className={factoryWide ? "opacity-70" : undefined}>
      <StatTile
        label={factoryWide ? `${label} · factory-wide` : label}
        value={value}
        hue={factoryWide ? undefined : hue}
        onClick={onClick}
      />
    </div>
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
 * Fleet Capacity Utilization Bar (WM-205)
 */
function FleetCapacityMeter({
  live,
  busy,
  stale,
  onClick,
}: {
  live: number;
  busy: number;
  stale: number;
  onClick: () => void;
}) {
  const idle = Math.max(0, live - busy);
  const total = live + stale;
  const busyPct = total > 0 ? (busy / total) * 100 : 0;
  const idlePct = total > 0 ? (idle / total) * 100 : 0;
  const stalePct = total > 0 ? (stale / total) * 100 : 0;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-lg border border-(--border) bg-(--surface-1) p-3 transition hover:border-(--border-focus,var(--accent))"
      title="Click to view workers"
    >
      <div className="mb-2 flex items-baseline justify-between text-[11px]">
        <span className="font-medium uppercase tracking-wide text-(--text-faint)">Worker Fleet Capacity</span>
        <span className="mono text-(--text-dim)">
          {live} live · {busy} busy · {idle} idle{stale > 0 ? ` · ${stale} stale` : ""}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded bg-(--surface-2)">
        {busyPct > 0 && (
          <div
            style={{ width: `${busyPct}%` }}
            className="bg-(--hue-info) transition-all"
            title={`Busy: ${busy}`}
          />
        )}
        {idlePct > 0 && (
          <div
            style={{ width: `${idlePct}%` }}
            className="bg-(--hue-ok) transition-all"
            title={`Idle: ${idle}`}
          />
        )}
        {stalePct > 0 && (
          <div
            style={{ width: `${stalePct}%` }}
            className="bg-(--hue-warn) transition-all"
            title={`Stale: ${stale}`}
          />
        )}
      </div>
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
  const outcomes = entries.filter((e) => terminalStates.has(e.to)).slice(0, 36);

  if (outcomes.length === 0) return null;

  return (
    <div className="rounded-lg border border-(--border) bg-(--surface-1) p-3">
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

/**
 * Overview (webui spec §4.1 + doc §10.4, pipeline OPS-360, WM-205) — the 4-band dashboard:
 * Band A: Promoted Doctor Anomaly Deck / Nominal status
 * Band B: 4-Stage Workload Pipeline & Capacity Funnel
 * Band C: Fleet Capacity & Recent Outcomes Telemetry
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
  // Client-side join for the anomaly deck (WM-95): the doctor only reports
  // expired proposal ids, so pull the same proposals list the Proposals view
  // uses to enrich each id with agent/decision/reason/origin/age.
  const proposalsForDeck = useQuery({
    queryKey: ["proposals"],
    queryFn: api.proposals,
    refetchInterval: 2000,
  });
  // Same lists the destination views fetch when scoped, so tile counts match
  // what a click would show (WM-147). Events/Proposals only filter on a repo
  // tab; In flight only scopes Runs (LEASED / RUNNING).
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

      {/* Band B: Workload Pipeline & Capacity Funnel (WM-205) */}
      {!s ? (
        <div className="mb-6 text-(--text-faint)">
          {status.isError ? "Cannot reach the control API." : "Loading overview…"}
        </div>
      ) : (
        <div className="mb-6 flex flex-col gap-4">
          {/* Stage 1: Event Intake & Watched Approval Gate */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                1. Event Intake & Triage
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {Object.entries(s.events).map(([k, v]) => {
                  const value = eventValue(k, v);
                  return (
                    <OverviewTile
                      key={k}
                      label={`events · ${k}`}
                      value={value}
                      hue={value > 0 ? EVENT_STATUS_HUES[k] : undefined}
                      onClick={() => onJumpEvents({ status: k })}
                    />
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                2. Watched Approval Gate
              </div>
              <div className="grid grid-cols-2 gap-2">
                <OverviewTile
                  label="proposals · open"
                  value={proposalOpen}
                  hue={proposalOpen > 0 ? "var(--hue-info)" : undefined}
                  onClick={() => onNavigate("proposals")}
                />
                <OverviewTile
                  label="proposals · expired"
                  value={proposalExpired}
                  hue={proposalExpired > 0 ? "var(--hue-warn)" : undefined}
                  onClick={() => onNavigate("proposals")}
                />
              </div>
            </div>
          </div>

          {/* Stage 2: Execution Fleet & Capacity (Fixed Hue Budget) */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
              3. Execution Fleet & Capacity
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {activeRunStates.map((k) => {
                const value = runValue(k);
                // Fix hue budget (WM-205): normal running runs are not warnings!
                const activeHue =
                  value > 0
                    ? k === "RUNNING" || k === "LEASED"
                      ? "var(--hue-info)"
                      : k === "VERIFYING"
                        ? "var(--hue-verify)"
                        : undefined
                    : undefined;
                return (
                  <OverviewTile
                    key={k}
                    label={`active · ${k.toLowerCase()}`}
                    value={value}
                    hue={activeHue}
                    onClick={() => onJumpRuns(k)}
                  />
                );
              })}
              {terminalRunStates.map((k) => {
                const value = runValue(k);
                const terminalHue =
                  value > 0
                    ? k === "COMPLETED"
                      ? "var(--hue-ok)"
                      : k === "FAILED"
                        ? "var(--hue-err)"
                        : k === "TIMED_OUT"
                          ? "var(--hue-warn)"
                          : undefined
                    : undefined;
                return (
                  <OverviewTile
                    key={k}
                    label={`runs · ${k.toLowerCase()}`}
                    value={value}
                    hue={terminalHue}
                    onClick={() => onJumpRuns(k)}
                  />
                );
              })}
              <OverviewTile
                label="workers · live"
                value={s.workers.live}
                hue={s.workers.live > 0 ? "var(--hue-ok)" : undefined}
                onClick={() => onNavigate("workers")}
                factoryWide={factoryWide}
              />
              <OverviewTile
                label="workers · busy"
                value={s.workers.busy}
                hue={s.workers.busy > 0 ? "var(--hue-info)" : undefined}
                onClick={() => onNavigate("workers")}
                factoryWide={factoryWide}
              />
              <OverviewTile
                label="workers · stale"
                value={s.workers.stale}
                hue={s.workers.stale > 0 ? "var(--hue-warn)" : undefined}
                onClick={() => onNavigate("workers")}
                factoryWide={factoryWide}
              />
            </div>
          </div>

          {/* Band C: Fleet Capacity Utilization & Recent Outcomes Strip (WM-205) */}
          <div className="grid gap-4 lg:grid-cols-2">
            <FleetCapacityMeter
              live={s.workers.live}
              busy={s.workers.busy}
              stale={s.workers.stale}
              onClick={() => onNavigate("workers")}
            />
            <RecentOutcomesStrip
              entries={feed.entries}
              now={now}
              onJumpRun={onJumpRun}
            />
          </div>

          {/* Band D: Artifact Store Housekeeping */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
              4. Artifact Store
            </div>
            <div className="grid grid-cols-3 gap-2 lg:max-w-md">
              <OverviewTile label="artifacts · files" value={s.artifacts.files} factoryWide={factoryWide} />
              <OverviewTile label="artifacts · size" value={humanSize(s.artifacts.bytes)} factoryWide={factoryWide} />
              <OverviewTile
                label="artifacts · orphans"
                value={s.artifacts.orphans}
                hue={s.artifacts.orphanBytes > 0 ? "var(--hue-warn)" : undefined}
                factoryWide={factoryWide}
              />
            </div>
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

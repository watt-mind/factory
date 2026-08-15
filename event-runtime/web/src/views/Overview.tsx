import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { hashPath } from "../hash";
import { useNow, useRequeuePoll } from "../hooks";
import type { JournalEntry, EventFocus, Proposal, RunState } from "../types";
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
 * Overview (webui spec §4.1 + doc §10.4, pipeline OPS-360) — the dashboard:
 * promoted doctor anomaly deck, 3-stage pipeline layout (Intake -> Watched Gate -> Execution),
 * live journal feed, and outbox results.
 */
export function Overview({
  connected,
  context,
  onJumpRun,
  onJumpProposal,
  onJumpEvents,
  onJumpRuns,
  onNavigate,
  onJumpExpired,
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
  const proposalsById = new Map<string, Proposal>(
    (proposalsForDeck.data?.proposals ?? []).map((p) => [p.id, p]),
  );
  const anomalyRows: {
    text: string;
    links: { label: string; go: () => void }[];
    requeue?: { source: string; eventId: string };
    dismissProposalId?: string;
    proposalId?: string;
    proposal?: Proposal;
  }[] = [];
  if (anomalies) {
    for (const id of anomalies.expiredOpenProposals) {
      anomalyRows.push({
        text: `expired open proposal ${id}`,
        proposalId: id,
        proposal: proposalsById.get(id),
        links: [{ label: "View proposal", go: () => onJumpProposal(id) }],
        dismissProposalId: id,
      });
    }
    if (anomalies.staleLeases > 0) {
      anomalyRows.push({
        text: `stale leases: ${anomalies.staleLeases}`,
        links: [{ label: "View leased runs", go: () => onJumpRuns("LEASED") }],
      });
    }
    if (anomalies.unpublishedOutbox > 0) {
      anomalyRows.push({
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
      anomalyRows.push({
        text: `dead-lettered (${d.source}, ${d.eventId}): ${d.lastError ?? "unknown error"}`,
        links: [
          {
            label: "View event",
            go: () => onJumpEvents({ status: "dead_lettered", source: d.source, eventId: d.eventId }),
          },
        ],
        requeue: { source: d.source, eventId: d.eventId },
      });
    }
    for (const w of anomalies.stalledWorkers) {
      anomalyRows.push({
        text: `stalled worker ${w.workerId} still holds run ${w.runId} — last heartbeat ${ago(w.lastSeen, now)} on ${w.host}`,
        links: [
          { label: "View worker", go: () => onNavigate(hashPath("workers", w.workerId)) },
          { label: "View run", go: () => onJumpRun(w.runId) },
        ],
      });
    }
    for (const amb of anomalies.ambiguousOpenProposals ?? []) {
      anomalyRows.push({
        text: `ambiguous open proposals: ${amb.count} open proposals exist for run ${amb.runId}`,
        links: [
          { label: "View run", go: () => onJumpRun(amb.runId) },
          { label: "View proposals", go: () => onNavigate("proposals") },
        ],
      });
    }
    if (anomalies.noWorkers) {
      const queued = s?.runs.byState.QUEUED ?? 0;
      anomalyRows.push({
        text: `${queued} queued run${queued === 1 ? "" : "s"} and no live worker to claim ${queued === 1 ? "it" : "them"} — nothing will start until one registers`,
        links: [
          { label: "View workers", go: () => onNavigate("workers") },
          { label: "View queued runs", go: () => onJumpRuns("QUEUED") },
        ],
      });
    }
  }

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

      {/* Promoted Doctor Deck when anomalies exist */}
      {hasAnomalies && (
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
      )}

      {status.isPending && !s && <div className="mb-5 text-(--text-faint)">Loading status…</div>}
      {status.isError && !s && (
        <div className="mb-5 text-(--text-faint)">Cannot reach the control API — tiles will appear when it is up.</div>
      )}

      {/* 3-Stage Pipeline Overview */}
      {s && (
        <div className="mb-6 space-y-4">
          {/* Stage 1: Intake & Gate */}
          <div className="grid gap-3 lg:grid-cols-12">
            <div className="lg:col-span-7">
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

            <div className="lg:col-span-5">
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
                  onClick={onJumpExpired}
                />
              </div>
            </div>
          </div>

          {/* Stage 2: Execution Fleet & Workers */}
          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
              3. Execution Fleet & Capacity
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {activeRunStates.map((k) => {
                const value = runValue(k);
                return (
                  <OverviewTile
                    key={k}
                    label={`active · ${k.toLowerCase()}`}
                    value={value}
                    hue={value > 0 ? "var(--hue-warn)" : undefined}
                    onClick={() => onJumpRuns(k)}
                  />
                );
              })}
              {terminalRunStates.map((k) => {
                const value = runValue(k);
                return (
                  <OverviewTile
                    key={k}
                    label={`runs · ${k.toLowerCase()}`}
                    value={value}
                    hue={k === "FAILED" && value > 0 ? "var(--hue-err)" : undefined}
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

          {/* Stage 3: Artifact store health */}
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

      {!hasAnomalies && (
        <Section title="Doctor">
          {!s ? (
            <div className="text-(--text-faint)">
              {status.isError ? "Cannot reach the control API." : "Loading anomalies…"}
            </div>
          ) : (
            <div className="text-(--text-faint)">No anomalies.</div>
          )}
        </Section>
      )}

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
              {groupJournalEntries(feed.entries).map((g) => (
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
                    {g.from ?? "·"} → {g.count > 1 ? "… → " : ""}
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
              {(outbox.data?.outbox ?? []).map((o) => (
                <div key={o.seq} className="border-b border-(--border) py-1.5 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    {(() => {
                      const type = String(o.event.type ?? "unknown event");
                      const source = typeof o.event.source === "string" ? o.event.source : null;
                      const eventId = typeof o.event.eventId === "string" ? o.event.eventId : null;
                      return source && eventId ? (
                        <JumpLink
                          onClick={() => onJumpEvents({ source, eventId })}
                          title={`Open origin event — ${type}`}
                          className="max-w-[70%] truncate"
                        >
                          {type}
                        </JumpLink>
                      ) : (
                        <span className="truncate text-(--text-dim)" title={type}>
                          {type}
                        </span>
                      );
                    })()}
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
              ))}
            </div>
          )}
          </div>
        </Section>
      </div>
    </div>
  );
}

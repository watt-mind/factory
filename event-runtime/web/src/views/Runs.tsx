import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { api, ApiError, type RunListFilters } from "../api";
import { hashPath, hashProject, hashSearch, withProject } from "../hash";
import {
  keyGuard,
  refetchIntervals,
  tableTokens,
  useDisplayOptions,
  useListKeys,
  useNow,
  useTabKeys,
  useTableWindow,
} from "../hooks";
import { goPrefixActive } from "../goSequence";
import {
  buildSections,
  cycleColumnSort,
  flattenSections,
  grouped,
  removeCustomColumn,
  sortRows,
  toggleCollapsed,
  visibleColumns,
  type DisplayConfig,
} from "../displayOptions";
import { DisplayOptions, exportJson } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import { setContextActions } from "../palette";
import { RunTrace } from "../components/RunTrace";
const NotesPanelLazy = lazy(() =>
  import("../components/NotesPanel").then((m) => ({ default: m.NotesPanel })),
);
import { AgentHoverCard } from "../components/AgentHoverCard";
import { CausationGlyphs, chainHref } from "../components/EventHoverCard";
import { RunHoverCard, runDurationSeconds } from "../components/RunHoverCard";
import { chainKeyOfEvent, runNodeId } from "../graph/chainModel";
import {
  ApprovalRiskDetails,
  useProposalAgent,
} from "../components/ApprovalRisk";
import {
  IN_FLIGHT,
  RunDetailBlocks,
  RunFailureBanner,
  clockTo,
  isCancellable,
  pinnedModelText,
  type Clock,
} from "../components/RunDetailBlocks";
import { readPinnedRuns, savePinnedRuns } from "../components/ContextTabs";
import type { OperatorContext } from "../context";
import { matchesInFlight, matchesRepo } from "../context";
import {
  RUN_FACETS,
  matchesFilterQuery,
  parseFilterQuery,
} from "../filterQuery";
import { decideRevealFilters, formatRevealNotification } from "../reveal";
import type { AdmittedEvent, Proposal, RunListItem, RunState } from "../types";
import { EMPTY, formatDuration, formatRelative } from "../format";
import {
  Button,
  CopyActions,
  Dialog,
  FilterInput,
  ListToolbar,
  ListPane,
  DetailPane,
  JumpLink,
  ListEmpty,
  ModelCell,
  notify,
  StateBadge,
  STATE_HUES,
  GroupHeaderRow,
  Table,
  TableWindowFooter,
  Th,
  VerbError,
  copyText,
  copyLink,
  rowKeyHandler,
  shortId,
} from "../components/ui";
import { Button as PrimitiveButton } from "../components/ui";

export type RunTab = "ALL" | "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED";

export const RUN_TABS: readonly RunTab[] = [
  "ALL",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export function toggleRunPin(id: string) {
  const pinned = readPinnedRuns();
  if (pinned.includes(id)) {
    savePinnedRuns(pinned.filter((runId) => runId !== id));
    notify(`Unpinned ${id}`, "info");
  } else {
    savePinnedRuns([...pinned, id]);
    notify(`Pinned ${id}`, "ok");
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable=true]"))
  );
}

export const RUN_TAB_LABELS: Record<RunTab, string> = {
  ALL: "All",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const RUN_TAB_TITLES: Record<RunTab, string> = {
  ALL: "All runs",
  ACTIVE: "QUEUED, LEASED, RUNNING, VERIFYING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED, TIMED_OUT, REFUSED",
  CANCELLED: "CANCELLED",
};

export function matchesRunTab(state: RunState, tab: RunTab): boolean {
  if (tab === "ALL") return true;
  if (tab === "ACTIVE")
    return ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(state);
  if (tab === "FAILED")
    return ["FAILED", "TIMED_OUT", "REFUSED"].includes(state);
  if (tab === "COMPLETED") return state === "COMPLETED";
  if (tab === "CANCELLED") return state === "CANCELLED";
  return true;
}

export function statesForRunTab(tab: RunTab): readonly string[] {
  if (tab === "ALL") {
    return [
      "PROPOSED",
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
      "REFUSED",
      "FAILED",
      "TIMED_OUT",
      "CANCELLED",
    ];
  }
  if (tab === "ACTIVE") return ["QUEUED", "LEASED", "RUNNING", "VERIFYING"];
  if (tab === "FAILED") return ["FAILED", "TIMED_OUT", "REFUSED"];
  if (tab === "COMPLETED") return ["COMPLETED"];
  if (tab === "CANCELLED") return ["CANCELLED"];
  return [];
}

export function tabForRunState(state: string): RunTab {
  if (["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(state))
    return "ACTIVE";
  if (["FAILED", "TIMED_OUT", "REFUSED"].includes(state)) return "FAILED";
  if (state === "COMPLETED") return "COMPLETED";
  if (state === "CANCELLED") return "CANCELLED";
  return "ALL";
}

export function countRunsByTab(
  runs: readonly Pick<RunListItem, "state">[],
): Record<RunTab, number> {
  const counts: Record<RunTab, number> = {
    ALL: 0,
    ACTIVE: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const run of runs) {
    counts.ALL += 1;
    const stateTab = tabForRunState(run.state);
    if (stateTab !== "ALL") counts[stateTab] += 1;
  }
  return counts;
}

const RUN_DRILLDOWN_POPULATIONS = new Set<RunListFilters["population"]>([
  "created",
  "terminal",
  "started",
  "retried",
  "leased",
  "finished",
  "usage",
]);

export function runDrilldownFilters(hash: string): RunListFilters | null {
  const query = hashSearch(hash);
  const from = query.get("from");
  const to = query.get("to");
  const population = query.get("population") as
    RunListFilters["population"] | null;
  if (!from || !to || !population || !RUN_DRILLDOWN_POPULATIONS.has(population))
    return null;
  return {
    from,
    to,
    population,
    state: query.get("state") ?? undefined,
    agent: query.get("agent") ?? undefined,
  };
}

/**
 * The pinned model as a list cell (WM-221) — the pair to the Agents view's
 * Model column (WM-211), same words for the same facts. The *observed* model
 * is deliberately detail-only: answering it per row means opening one stored
 * transcript per run.
 */
const rowModel = (r: RunListItem) => pinnedModelText(r.adapter, r.model);

/** The budget deadline shared by the Remaining display and its sort order. */
const remainingDeadline = (r: RunListItem): string => {
  if (r.deadlineAt) return r.deadlineAt;
  if (!r.startedAt || !r.timeoutSeconds || r.timeoutSeconds <= 0) return "";
  const deadline = new Date(Date.parse(r.startedAt) + r.timeoutSeconds * 1000);
  return Number.isNaN(deadline.getTime()) ? "" : deadline.toISOString();
};

/**
 * Grouping/ordering/columns (OPS-493). One config for every status tab: the
 * tabs only filter rows, the column set never changes with them.
 */
const RUNS_DISPLAY: DisplayConfig<RunListItem> = {
  view: "runs",
  groups: [
    {
      key: "state",
      label: "State",
      get: (r) => r.state,
      order: [
        "PROPOSED",
        "APPROVED",
        "QUEUED",
        "LEASED",
        "RUNNING",
        "VERIFYING",
        "COMPLETED",
        "REFUSED",
        "FAILED",
        "TIMED_OUT",
        "CANCELLED",
      ],
      hue: STATE_HUES,
    },
    { key: "agent", label: "Agent", get: (r) => r.agent },
    { key: "adapter", label: "Adapter", get: (r) => r.adapter },
    { key: "model", label: "Model", get: rowModel },
  ],
  subGroups: ["agent", "adapter", "state"],
  sorts: [
    { key: "run", label: "Run", get: (r) => r.runId, column: "run" },
    { key: "state", label: "State", get: (r) => r.state, column: "state" },
    {
      key: "remaining",
      label: "Remaining",
      get: remainingDeadline,
      column: "remaining",
    },
    {
      key: "duration",
      label: "Duration",
      get: (r) => runDurationSeconds(r, undefined, Date.now()) ?? -1,
      column: "duration",
    },
    { key: "agent", label: "Agent", get: (r) => r.agent, column: "agent" },
    {
      key: "adapter",
      label: "Adapter",
      get: (r) => r.adapter,
      column: "adapter",
    },
    { key: "model", label: "Model", get: rowModel, column: "model" },
    {
      key: "attempts",
      label: "Attempts",
      get: (r) => r.attempts,
      defaultDir: "desc",
      column: "attempts",
    },
    {
      key: "reason",
      label: "Reason",
      get: (r) => r.reasonCode ?? "",
      column: "reason",
    },
    {
      key: "origin",
      label: "Origin",
      get: (r) => `${r.eventSource ?? ""}:${r.eventId ?? ""}`,
      column: "origin",
    },
    {
      key: "updated",
      label: "Updated",
      get: (r) => r.updated_at,
      defaultDir: "desc",
      column: "updated",
    },
    {
      key: "created",
      label: "Created",
      get: (r) => r.created_at,
      defaultDir: "desc",
    },
  ],
  columns: [
    { key: "run", label: "Run", always: true },
    { key: "state", label: "State" },
    { key: "remaining", label: "Remaining" },
    { key: "duration", label: "Duration" },
    { key: "agent", label: "Agent" },
    { key: "adapter", label: "Adapter" },
    { key: "model", label: "Model" },
    { key: "attempts", label: "Attempts" },
    { key: "reason", label: "Reason" },
    { key: "origin", label: "Origin" },
    { key: "updated", label: "Updated" },
  ],
};

/** Minutes, coarse enough that a row-level countdown does not tick every second. */
const leftLabel = (leftMs: number) => {
  const minutes = Math.ceil(leftMs / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
};

type RemainingPart = { text: string; title: string; hue?: string };

/** Relative phrasing plus the wall-clock ISO, matching other time-column titles (WM-747). */
function remainingTitle(relative: string, iso?: string | null): string {
  return iso ? `${relative} · ${iso}` : relative;
}

/**
 * The compact form of the detail pane's `BudgetClock`, on the same thresholds
 * so the two never disagree: the full phrasing moves to the cell's title.
 */
function budgetPart(
  c: Clock,
  timeoutSeconds: number,
  iso?: string | null,
): RemainingPart | null {
  if (c.kind === "off") return null;
  if (c.kind === "spent")
    return {
      text: "spent",
      title: remainingTitle("budget spent", iso),
      hue: "var(--hue-err)",
    };
  // The last tenth of the declared budget — long enough to notice on a long run.
  const hue =
    timeoutSeconds > 0 && c.leftMs <= timeoutSeconds * 100
      ? "var(--hue-warn)"
      : undefined;
  return {
    text: leftLabel(c.leftMs),
    title: remainingTitle(`timeout in ${formatDuration(c.leftMs / 1000)}`, iso),
    hue,
  };
}

/**
 * The lease is minted at claim for the budget plus a grace, so it usually
 * expires after the budget and adds nothing to the row. It earns its half of
 * the line only when it is the deadline that will actually fire first.
 */
function leasePart(
  c: Clock,
  budget: Clock | null,
  iso?: string | null,
): RemainingPart | null {
  if (c.kind === "off") return null;
  if (c.kind === "spent")
    return {
      text: "lease due",
      title: remainingTitle("reap due", iso),
      hue: "var(--hue-err)",
    };
  if (budget?.kind === "live" && c.leftMs >= budget.leftMs) return null;
  return {
    text: `lease ${leftLabel(c.leftMs)}`,
    title: remainingTitle(`reaped in ${formatDuration(c.leftMs / 1000)}`, iso),
    hue: budget?.kind === "spent" ? "var(--hue-warn)" : undefined,
  };
}

/** The compact lease label shared by the list and the full run view. */
export function leaseRemaining(
  leaseExpiresAt: string | null | undefined,
  now: number,
) {
  if (!leaseExpiresAt) return null;
  const lease = leasePart(
    clockTo(leaseExpiresAt, 0, now),
    null,
    leaseExpiresAt,
  );
  return lease?.text ?? null;
}

/**
 * The one place a row says how long an in-flight attempt has left (WM-725).
 * Budget and lease share this single line: stacking a second line of clocks
 * under the State badge made every in-flight row taller than the terminal rows
 * around it, for a number this column already carried.
 */
function RemainingCell({ r, now }: { r: RunListItem; now: number }) {
  const { leaseExpiresAt, timeoutSeconds = 0 } = r;
  const deadline = remainingDeadline(r);
  const budgetClock = deadline ? clockTo(deadline, 0, now) : null;
  const leaseClock = leaseExpiresAt ? clockTo(leaseExpiresAt, 0, now) : null;
  const budget =
    budgetClock &&
    budgetPart(budgetClock, timeoutSeconds, r.deadlineAt || deadline);
  const lease =
    leaseClock && leasePart(leaseClock, budgetClock, leaseExpiresAt);
  if (!budget && !lease) return <span>{EMPTY}</span>;

  return (
    <span
      className="inline-flex items-baseline gap-1"
      title={[budget?.title, lease?.title].filter(Boolean).join(" · ")}
    >
      {budget && <span style={{ color: budget.hue }}>{budget.text}</span>}
      {budget && lease && <span className="text-(--text-faint)">·</span>}
      {lease && (
        <span
          className="text-[11px] text-(--text-faint)"
          style={{ color: lease.hue }}
        >
          {lease.text}
        </span>
      )}
    </span>
  );
}

function DurationCell({ r, now }: { r: RunListItem; now: number }) {
  const duration = runDurationSeconds(r, undefined, now);
  return <span>{duration === null ? EMPTY : formatDuration(duration)}</span>;
}

/** Missing durations are not zero-length runs; keep them behind measured rows. */
function measuredDurationsFirst(rows: RunListItem[], now: number) {
  const measured: RunListItem[] = [];
  const missing: RunListItem[] = [];
  for (const row of rows) {
    (runDurationSeconds(row, undefined, now) === null
      ? missing
      : measured
    ).push(row);
  }
  return [...measured, ...missing];
}

/**
 * The sentence the row's `↳` / `→ N` arrows stand for (WM-702). The Run column
 * has room for the glyphs and nothing else; this is where they say what they
 * mean, to a screen reader as much as to a pointer.
 *
 * `↳` marks a run whose *origin event was itself emitted by a run* — not
 * merely one that names an origin event. Almost every run does the latter, and
 * an arrow on every row is a decoration, not a signal.
 */
export function runCausationTitle(
  parentRunId: string | null,
  fanOut: number,
): string {
  const parts: string[] = [];
  if (parentRunId) parts.push(`Downstream of run ${shortId(parentRunId)}`);
  if (fanOut > 0)
    parts.push(`${fanOut} event${fanOut === 1 ? "" : "s"} emitted`);
  return `${parts.join(" · ")} — open the chain`;
}

/**
 * The Run column: the id, its hover card, and the causation glyphs (WM-702).
 * Kept a component rather than inline JSX so the row stays a concise arrow —
 * `causationOf(r)` needs somewhere to land, and a `const` in the row body
 * would reindent every cell below it for no change in behaviour.
 */
function RunIdCell({
  run,
  causation,
  onJumpEvent,
  onJumpRun,
}: {
  run: RunListItem;
  causation: {
    chainId: string | null;
    parentRun: string | null;
    fanOut: number;
  };
  onJumpEvent?: (source: string, eventId: string) => void;
  onJumpRun?: (runId: string) => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <RunHoverCard
        run={run}
        chainId={causation.chainId}
        className="min-w-0"
        onJumpEvent={onJumpEvent}
        onJumpRun={onJumpRun}
      >
        <span className="truncate">{shortId(run.runId)}</span>
      </RunHoverCard>
      <CausationGlyphs
        causedBy={causation.parentRun}
        fanOut={causation.fanOut}
        href={chainHref(causation.chainId, runNodeId(run.runId))}
        title={runCausationTitle(causation.parentRun, causation.fanOut)}
      />
    </span>
  );
}

const rowWash = (s: string) =>
  s === "FAILED" || s === "TIMED_OUT"
    ? "row-wash-err"
    : s === "REFUSED"
      ? "row-wash-warn"
      : "";

/** Route raw links rendered by RunDetailBlocks to the deep-linkable artifact inspector. */
export function handleRunArtifactClick(event: ReactMouseEvent<HTMLElement>) {
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
  if (!target) return;
  const match = (target.getAttribute("href") ?? "").match(
    /\/api\/artifacts\/([0-9a-f]{64})(?=[?#]|$)/,
  );
  if (!match) return;
  event.preventDefault();
  event.stopPropagation();
  window.location.hash = `#/${withProject(hashPath("artifacts", match[1]), hashProject(window.location.hash))}`;
}

/** Runs (webui spec §4.3): state tabs, lifecycle timeline, guarded verbs. */
export function Runs({
  connected,
  context,
  focusRunId,
  onSelectRun,
  onOpenFull,
  focusState,
  onFocusStateConsumed,
  onJumpAgent,
  onJumpEvent,
  onJumpProposal,
  rejumpEpoch,
}: {
  connected: boolean;
  context: OperatorContext;
  focusRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onOpenFull: (runId: string) => void;
  focusState: string | null;
  onFocusStateConsumed: () => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpProposal?: (id: string) => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<RunTab>("ALL");
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const drilldown = runDrilldownFilters(window.location.hash);
  const drilldownKey = JSON.stringify(drilldown);
  const [runCursor, setRunCursor] = useState<string | null>(null);

  const proposalsQ = useQuery({
    queryKey: ["proposals", "open"],
    queryFn: () => api.proposals(),
    ...refetchIntervals.secondary,
  });

  const proposalByRunId = useMemo(() => {
    const map = new Map<string, Proposal>();
    for (const p of proposalsQ.data?.proposals ?? []) {
      if (p.runId) map.set(p.runId, p);
    }
    return map;
  }, [proposalsQ.data?.proposals]);

  // A project / In-flight filter is client-side; fetching only the active
  // status tab would make every other tab's badge a factory-wide lie.
  const fetchAll = context.kind !== "all" || drilldown !== null;

  // A cursor identifies a boundary in one particular list. Carrying it into a
  // different tab, drilldown, or context can hide that list's newest runs.
  useEffect(() => {
    setRunCursor(null);
  }, [tab, drilldownKey, context.kind]);

  const list = useQuery({
    queryKey: ["runs", fetchAll ? "ALL" : tab, drilldownKey, runCursor],
    queryFn: () =>
      api.runs(undefined, {
        ...(drilldown ?? {}),
        before: runCursor ?? undefined,
      }),
    ...refetchIntervals.primary,
  });
  const statusQ = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    ...refetchIntervals.fast,
  });
  // Causation needs the events on either side of a run (WM-702): the origin
  // event is the only thing carrying the chain's correlation id, and the
  // events a run emitted are its fan-out. Same cache key as the Events view.
  const eventsQ = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    ...refetchIntervals.secondary,
  });
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    ...refetchIntervals.secondary,
  });
  const inputSchemaByAgent = useMemo(
    () =>
      new Map(
        agentsQ.data?.agents.map((agent) => [agent.ref, agent.inputSchema]),
      ),
    [agentsQ.data],
  );
  const causation = useMemo(() => {
    const originByKey = new Map<string, AdmittedEvent>();
    const emittedCount = new Map<string, number>();
    const emittedFirst = new Map<string, AdmittedEvent>();
    for (const e of eventsQ.data?.events ?? []) {
      originByKey.set(`${e.source}:${e.eventId}`, e);
      if (!e.causationId) continue;
      emittedCount.set(
        e.causationId,
        (emittedCount.get(e.causationId) ?? 0) + 1,
      );
      if (!emittedFirst.has(e.causationId)) emittedFirst.set(e.causationId, e);
    }
    return { originByKey, emittedCount, emittedFirst };
  }, [eventsQ.data]);
  /**
   * Where a run sits in its chain. The chain key comes off the origin event; a
   * run whose origin is outside the loaded page is still placed by any event
   * it emitted, because those carry the same correlation id.
   */
  const causationOf = (r: RunListItem) => {
    const origin =
      r.eventSource && r.eventId
        ? causation.originByKey.get(`${r.eventSource}:${r.eventId}`)
        : undefined;
    const emitted = causation.emittedFirst.get(r.runId);
    return {
      chainId: origin
        ? chainKeyOfEvent(origin)
        : emitted
          ? chainKeyOfEvent(emitted)
          : null,
      parentRun: origin?.causationId ?? null,
      fanOut: causation.emittedCount.get(r.runId) ?? 0,
    };
  };
  const rows = list.data?.runs ?? [];
  const nextBefore = list.data?.nextBefore;
  const scoped = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.runId === focusRunId ||
          (matchesRepo(r.repos, context) && matchesInFlight(r.state, context)),
      ),
    [rows, context, focusRunId],
  );
  const byTab = useMemo(
    () =>
      tab === "ALL"
        ? scoped
        : scoped.filter((r) => matchesRunTab(r.state, tab)),
    [scoped, tab],
  );
  // `is:stale` is the doctor's projection, not a guess this view makes: a run
  // held by a worker whose heartbeat has gone (lib/workers.mjs stalledWorkers).
  const staleRuns = useMemo(
    () =>
      new Set(
        (statusQ.data?.anomalies?.stalledWorkers ?? []).map((w) => w.runId),
      ),
    [statusQ.data],
  );
  const parsed = useMemo(() => parseFilterQuery(filter, RUN_FACETS), [filter]);
  const filteredScoped = useMemo(
    () =>
      scoped.filter((r) =>
        matchesFilterQuery(r, parsed, RUN_FACETS, { staleRuns }),
      ),
    [scoped, parsed, staleRuns],
  );
  const visible = useMemo(
    () =>
      tab === "ALL"
        ? filteredScoped
        : filteredScoped.filter((r) => matchesRunTab(r.state, tab)),
    [filteredScoped, tab],
  );

  // Display options (OPS-493): partition into sections, order inside them,
  // and feed keyboard navigation only the rows of open sections. Under a
  // single-state tab the empty-group universe narrows to that state — "show
  // empty groups" on the COMPLETED tab must not render ten 0-count bands the
  // tab itself already filtered out.
  const displayConfig = useMemo(
    () => ({
      ...RUNS_DISPLAY,
      groups: RUNS_DISPLAY.groups.map((g) =>
        g.key === "state" ? { ...g, order: statesForRunTab(tab) } : g,
      ),
      // Every row sorts against the same clock it renders against. Calling
      // Date.now() per getter could straddle a second boundary mid-sort.
      sorts: RUNS_DISPLAY.sorts.map((s) =>
        s.key === "duration"
          ? {
              ...s,
              get: (r: RunListItem) =>
                runDurationSeconds(r, undefined, now) ?? -1,
            }
          : s,
      ),
    }),
    [tab, now],
  );
  const [display, setDisplay] = useDisplayOptions(displayConfig);
  const sections = useMemo(() => {
    const built = buildSections(visible, displayConfig, display);
    if (display.sortBy !== "duration") return built;
    return built.map((section) => ({
      ...section,
      rows: measuredDurationsFirst(section.rows, now),
      subsections: section.subsections?.map((subsection) => ({
        ...subsection,
        rows: measuredDurationsFirst(subsection.rows, now),
      })),
    }));
  }, [visible, displayConfig, display, now]);
  const flat = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(displayConfig, display);

  const selectedId = focusRunId;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(
    () => flat.findIndex((r) => r.runId === selectedId),
    [flat, selectedId],
  );
  const tokens = tableTokens(sections, display.collapsed, grouped(display));
  const [windowTokens, windowStart, windowEnd, moveWindow] = useTableWindow(
    tokens,
    selectedId,
    (row) => row.runId,
    JSON.stringify([tab, filter, context, display]),
  );

  // Deep link / jump: switch to ALL if the run isn't on this tab. Hash stays put.
  // Reveal (clear filter) once per focus id, after the run is on the tab so a
  // late arrival still surfaces. Typing a filter does not re-reveal.
  // Under `fetchAll` the list carries every state, so presence in `rows` says
  // nothing about the tab — the tab has to be part of the membership test, or
  // the switch to ALL never fires and the row stays unrendered.
  const pendingReveal = useRef<{
    key: string;
    snapshot: { filter: string };
  } | null>(null);
  const lastKey = useRef<string | null>(null);
  const lastRejump = useRef<number | undefined>(rejumpEpoch);
  const tabChangedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRunId) {
      pendingReveal.current = null;
      lastKey.current = null;
      lastRejump.current = rejumpEpoch;
      tabChangedFor.current = null;
      return;
    }

    const isNewKey = focusRunId !== lastKey.current;
    const isRejump = rejumpEpoch !== lastRejump.current;
    lastKey.current = focusRunId;
    lastRejump.current = rejumpEpoch;

    if (isNewKey || isRejump) {
      pendingReveal.current = {
        key: focusRunId,
        snapshot: { filter },
      };
    }

    const onTab = rows.some(
      (r) =>
        r.runId === focusRunId &&
        (tab === "ALL" || matchesRunTab(r.state, tab)),
    );
    if (onTab) {
      const latch = pendingReveal.current;
      if (latch && latch.key === focusRunId) {
        pendingReveal.current = null; // decided once
        const isVisible = visible.some((r) => r.runId === focusRunId);
        const currentFilters = { filter };
        const emptyFilters = { filter: "" };
        const decision = decideRevealFilters(
          latch.snapshot,
          currentFilters,
          emptyFilters,
          isVisible,
        );
        if (decision.cleared) {
          setFilter(decision.next.filter);
        }
        const tabChanged = tabChangedFor.current === focusRunId;
        tabChangedFor.current = null;
        if (tabChanged || decision.cleared) {
          const row = rows.find((r) => r.runId === focusRunId);
          const msg = formatRevealNotification({
            kind: "run",
            id: focusRunId,
            state: row?.state,
            tabChanged,
            filterCleared: decision.cleared,
          });
          if (msg) notify(msg, "info");
        }
      }
      return;
    }
    if (tab !== "ALL") {
      tabChangedFor.current = focusRunId;
      setTab("ALL");
    }
  }, [focusRunId, rejumpEpoch, rows, tab, visible, fetchAll, filter]);

  useEffect(() => {
    if (focusState) {
      setTab(tabForRunState(focusState));
      onFocusStateConsumed();
    }
  }, [focusState, onFocusStateConsumed]);

  // In flight is LEASED+RUNNING; a COMPLETED (etc.) status tab would be empty.
  useEffect(() => {
    if (context.kind !== "inflight") return;
    setTab((t) => (t === "ACTIVE" || t === "ALL" ? t : "ALL"));
  }, [context.kind]);

  const sel = useMemo(
    () =>
      selectedId ? (visible.find((r) => r.runId === selectedId) ?? null) : null,
    [visible, selectedId],
  );
  // A side pane turns the list into a compact comparison rail. Keep the five
  // decision-bearing columns instead of forcing a horizontal scrollbar; the
  // pane and the unselected list retain every configured column.
  const listCols = sel
    ? cols.filter((c) =>
        [
          "run",
          "state",
          "remaining",
          "duration",
          "reason",
          "origin",
          "updated",
        ].includes(c.key),
      )
    : cols;
  const show = useMemo(() => new Set(listCols.map((c) => c.key)), [listCols]);

  useEffect(() => {
    document
      .querySelector("tr.row-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, windowStart]);

  const detail = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api.run(selectedId as string),
    enabled: sel !== null,
    ...refetchIntervals.primary,
  });

  const invalidate = () => queryClient.invalidateQueries();

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.cancel(id, reason),
    onSuccess: (_, { id }) => {
      invalidate();
      notify(`Cancelled run ${id}`, "info");
      setConfirm(null);
      setCancelReason("");
    },
    onError: invalidate,
  });

  const retry = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      api.retry(id, force),
    onSuccess: (_, { id, force }) => {
      invalidate();
      notify(`${force ? "Force retried" : "Retried"} run ${id}`, "ok");
      setConfirm(null);
    },
    onError: (err) => {
      invalidate();
      // attempts_exhausted → offer the explicit, recorded override (spec §4.3)
      if (err instanceof ApiError && err.message === "attempts_exhausted")
        setConfirm("force-retry");
    },
  });

  const approve = useMutation({
    mutationFn: (proposalId: string) => api.approve(proposalId),
    onSuccess: (outcome) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      if (outcome.approved && outcome.runId) {
        notify(`Approved proposal — queued ${outcome.runId}`, "ok");
      } else if (outcome.replanned && outcome.proposal) {
        notify(`Proposal expired — re-planned new spec`, "info");
        if (onJumpProposal) onJumpProposal(outcome.proposal.id);
      }
      setConfirmApprove(false);
    },
    onError: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
    },
  });

  const byState = statusQ.data?.runs?.byState;
  const tabCounts = useMemo((): Record<RunTab, number> => {
    if (filter.trim()) {
      return countRunsByTab(filteredScoped);
    }
    if (fetchAll) {
      return countRunsByTab(scoped);
    }
    const counts: Record<RunTab, number> = {
      ALL: 0,
      ACTIVE: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLED: 0,
    };
    for (const [state, count] of Object.entries(byState ?? {})) {
      const value = count ?? 0;
      counts.ALL += value;
      const stateTab = tabForRunState(state);
      if (stateTab !== "ALL") counts[stateTab] += value;
    }
    return counts;
  }, [byState, fetchAll, filter, filteredScoped, scoped]);

  const tabCount = (t: RunTab) => tabCounts[t];

  const selectTab = (t: RunTab) => {
    setTab(t);
    if (selectedId) onSelectRun(null);
  };
  useTabKeys(RUN_TABS, tab, selectTab);

  // A query can resolve with a partial payload while caches hydrate. Treat a
  // detail without its root run as unpopulated so every guarded d.run access
  // below stays on the loading/fallback path.
  const d = detail.data?.run ? detail.data : undefined;
  const attemptsExhausted = d
    ? d.run.attempts >= d.run.spec.maxAttempts
    : false;

  const selProposal = useMemo(() => {
    if (sel?.runId && proposalByRunId.has(sel.runId))
      return proposalByRunId.get(sel.runId)!;
    if (d?.run?.runId && proposalByRunId.has(d.run.runId))
      return proposalByRunId.get(d.run.runId)!;
    return null;
  }, [sel?.runId, d?.run?.runId, proposalByRunId]);

  /** Agent behind the selected proposal — drives the approve dialog's risk card. */
  const approveAgent = useProposalAgent(selProposal);

  const canApprove = Boolean(
    selProposal &&
    selProposal.status === "open" &&
    selProposal.decision === "run" &&
    (sel?.state === "PROPOSED" || d?.run?.state === "PROPOSED"),
  );

  const pendingC = useRef<number>(0);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (isTypingTarget(e.target)) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= RUN_TABS.length) {
        e.preventDefault();
        selectTab(RUN_TABS[num - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectTab]);

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectRun(flat[i]?.runId ?? null),
    // §5 "Enter/o — open detail": selection already opens the panel, so the
    // open verb graduates to the full-page run view (`g o` is safe — list
    // verbs stand down while the chord prefix is armed, hooks.ts).
    onOpen: () => sel && onOpenFull(sel.runId),
    onClose: () => {
      if (selectedId) onSelectRun(null);
      else if (filter) setFilter("");
    },
    keys: {
      a: () =>
        canApprove &&
        connected &&
        !approve.isPending &&
        setConfirmApprove(true),
      // §5 convention: `x` is the destructive verb on the selection — here, cancel.
      x: () =>
        sel && connected && isCancellable(sel.state) && setConfirm("cancel"),
      c: () => {
        if (!sel) return;
        const now = Date.now();
        if (pendingC.current > 0 && now - pendingC.current < 800) {
          copyText(
            `bun event-runtime/cli.mjs inspect ${sel.runId}`,
            "CLI inspect command",
          );
          pendingC.current = 0;
        } else {
          copyText(sel.runId, "run id");
          pendingC.current = now;
        }
      },
      l: () => {
        if (
          sel &&
          pendingC.current > 0 &&
          Date.now() - pendingC.current < 800
        ) {
          copyLink();
          pendingC.current = 0;
        }
      },
      p: () => sel && toggleRunPin(sel.runId),
    },
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (!sel) return;
      const now = Date.now();
      if (pendingC.current > 0 && now - pendingC.current < 800) {
        if (e.key === "i" || e.key === "I") {
          e.preventDefault();
          e.stopImmediatePropagation();
          copyText(
            `bun event-runtime/cli.mjs inspect ${sel.runId}`,
            "CLI inspect command",
          );
          pendingC.current = 0;
        }
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [sel]);

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: "Open in tab", hint: "p", run: () => toggleRunPin(sel.runId) },
        {
          label: "Open full view",
          hint: "o",
          run: () => onOpenFull(sel.runId),
        },
        {
          label: "Copy run id",
          hint: "c",
          run: () => copyText(sel.runId, "run id"),
        },
        {
          label: "Copy CLI inspect command",
          hint: "c i",
          run: () =>
            copyText(
              `bun event-runtime/cli.mjs inspect ${sel.runId}`,
              "CLI inspect command",
            ),
        },
        { label: "Copy link", hint: "c l", run: copyLink },
      ];
      if (!d || !connected) {
        setContextActions(copy);
      } else {
        setContextActions([
          ...(canApprove && selProposal
            ? [
                {
                  label: `Approve proposal ${selProposal.id}…`,
                  hint: "a",
                  run: () => setConfirmApprove(true),
                },
              ]
            : []),
          ...(selProposal && onJumpProposal
            ? [
                {
                  label: `Open proposal ${selProposal.id}`,
                  run: () => onJumpProposal(selProposal.id),
                },
              ]
            : []),
          ...(isCancellable(d.run.state)
            ? [
                {
                  label: "Cancel run…",
                  hint: "x",
                  run: () => setConfirm("cancel"),
                },
              ]
            : []),
          ...(d.run.state === "FAILED"
            ? [
                attemptsExhausted
                  ? {
                      label: "Force retry run…",
                      run: () => setConfirm("force-retry"),
                    }
                  : {
                      label: "Retry run",
                      run: () =>
                        retry.mutate({ id: d.run.runId, force: false }),
                    },
              ]
            : []),
          ...copy,
        ]);
      }
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sel?.runId,
    d?.run?.runId,
    d?.run?.state,
    attemptsExhausted,
    connected,
    canApprove,
    selProposal,
  ]);

  const handleExport = () => {
    const sorted = sortRows(visible, displayConfig, display);
    const dateStr = new Date().toISOString().slice(0, 10);
    exportJson(`runs-export-${dateStr}.json`, sorted);
    notify(
      `Exported ${sorted.length} run${sorted.length === 1 ? "" : "s"} to JSON`,
      "info",
    );
  };

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-h1 font-semibold">Runs</h1>
            {drilldown && (
              <div
                role="status"
                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-(--border) bg-(--surface-2) px-3 py-2 text-[11px] text-(--text-dim)"
              >
                <span>
                  Metrics drill-down ·{" "}
                  <span className="mono">{drilldown.population}</span>
                  {drilldown.state ? ` · ${drilldown.state}` : ""}
                  {drilldown.agent ? ` · ${drilldown.agent}` : ""} ·{" "}
                  {new Date(drilldown.from!).toLocaleString()} →{" "}
                  {new Date(drilldown.to!).toLocaleString()}
                </span>
                <a href="#/runs" className="font-medium text-(--accent)">
                  Clear metrics filter
                </a>
              </div>
            )}

            {/* `flex-wrap`: the token chips are a full-width item, so they take
            their own line under the tabs and the box instead of squeezing them. */}
            <ListToolbar
              tabs={
                <div
                  className="flex w-max flex-nowrap gap-1 whitespace-nowrap"
                  role="tablist"
                  aria-label="Run state"
                >
                  {RUN_TABS.map((t, idx) => {
                    const count = tabCount(t);
                    return (
                      <Button
                        key={t}
                        size="sm"
                        variant="ghost"
                        role="tab"
                        aria-selected={tab === t}
                        onClick={() => selectTab(t)}
                        title={RUN_TAB_TITLES[t]}
                        className={`shrink-0 rounded-md ${
                          tab === t
                            ? "bg-(--surface-3) text-(--text)"
                            : "text-(--text-faint) hover:bg-(--surface-1)"
                        }`}
                      >
                        {RUN_TAB_LABELS[t]}
                        {count > 0 && (
                          <span className="ml-1.5 tabular-nums text-(--text-faint)">
                            {count}
                          </span>
                        )}
                        <span
                          aria-hidden="true"
                          className="mono ml-1 text-(--text-faint) text-xs opacity-70"
                        >
                          {idx + 1}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              }
              tools={
                <>
                  <DisplayOptions
                    config={displayConfig}
                    state={display}
                    onChange={setDisplay}
                    onExport={visible.length > 0 ? handleExport : undefined}
                    rows={scoped}
                  />
                  <FilterInput
                    value={filter}
                    onChange={setFilter}
                    placeholder="agent:… state:… is:stale"
                    label="Filter runs"
                    query={parsed}
                  />
                </>
              }
            />
          </>
        }
      >
        <Table
          role="grid"
          aria-label="Runs"
          className="w-full table-fixed border-separate border-spacing-0"
          style={{
            minWidth: `${listCols.reduce(
              (width, c) => width + (c.key === "state" ? 176 : 112),
              0,
            )}px`,
          }}
        >
          <colgroup>
            {listCols.map((c) => (
              <col
                key={c.key}
                className={c.key === "state" ? "w-44" : "w-28"}
              />
            ))}
          </colgroup>
          <thead role="rowgroup">
            <tr role="row" className="text-left">
              {listCols.map((c) => {
                const sort = displayConfig.sorts.find(
                  (s) => s.column === c.key,
                );
                const isCustom = c.isCustom || c.key.startsWith("custom:");
                const customPath = c.key.replace(/^custom:/, "");
                const isCurrentSort = isCustom
                  ? display.sortBy === c.key
                  : sort && display.sortBy === sort.key;
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={isCurrentSort ? display.sortDir : null}
                    naturalDir={sort?.defaultDir ?? "asc"}
                    onSort={
                      sort || isCustom
                        ? () =>
                            setDisplay((s) =>
                              cycleColumnSort(displayConfig, s, c.key),
                            )
                        : undefined
                    }
                    onRemove={
                      isCustom
                        ? () =>
                            setDisplay((s) => removeCustomColumn(s, customPath))
                        : undefined
                    }
                  />
                );
              })}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {(() => {
              const renderRow = (r: RunListItem) => (
                <tr
                  key={r.runId}
                  role="row"
                  tabIndex={0}
                  onClick={() => onSelectRun(r.runId)}
                  onKeyDown={rowKeyHandler(() => onSelectRun(r.runId))}
                  aria-selected={r.runId === selectedId}
                  className={`cursor-pointer hover:bg-(--surface-1) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent) ${rowWash(r.state)} ${r.runId === selectedId ? "row-selected" : ""}`}
                >
                  <td
                    className="mono max-w-28 overflow-hidden border-b border-(--border) px-3 py-1.5 whitespace-nowrap"
                    title={r.runId}
                  >
                    <RunIdCell
                      run={r}
                      causation={causationOf(r)}
                      onJumpEvent={onJumpEvent}
                      onJumpRun={onOpenFull}
                    />
                  </td>
                  {/*
                    State cell carries no `max-w-*`/`truncate` (WM-505): its content is a
                    bounded-length badge plus an optional `proposal` jump link, and
                    `truncate` cannot ellipsize a flex child — it hard-clipped the link
                    mid-glyph and left most of its hit area unclickable. The column sizes
                    to its content instead, which keeps the link fully rendered.
                  */}
                  {show.has("state") && (
                    <td className="min-w-44 border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        <StateBadge state={r.state} />
                        {r.state === "PROPOSED" &&
                          (() => {
                            const prop = proposalByRunId.get(r.runId);
                            if (prop && onJumpProposal) {
                              return (
                                <JumpLink
                                  onClick={(e) => {
                                    e?.stopPropagation();
                                    onJumpProposal(prop.id);
                                  }}
                                  title={`Open proposal ${prop.id}`}
                                  className="text-[11px]"
                                >
                                  proposal
                                </JumpLink>
                              );
                            }
                            return null;
                          })()}
                      </div>
                    </td>
                  )}
                  {show.has("remaining") && (
                    <td className="max-w-36 overflow-hidden whitespace-nowrap border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      {IN_FLIGHT.includes(r.state) ? (
                        <RemainingCell r={r} now={now} />
                      ) : (
                        ""
                      )}
                    </td>
                  )}
                  {show.has("duration") && (
                    <td className="max-w-24 overflow-hidden whitespace-nowrap border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      <DurationCell r={r} now={now} />
                    </td>
                  )}
                  {show.has("agent") && (
                    <td className="max-w-32 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)">
                      <AgentHoverCard
                        agentRef={r.agent}
                        onJumpAgent={onJumpAgent}
                      />
                    </td>
                  )}
                  {show.has("adapter") && (
                    <td
                      className="max-w-24 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-faint)"
                      title={r.adapter}
                    >
                      {r.adapter}
                    </td>
                  )}
                  {show.has("model") && (
                    <td className="max-w-40 border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                      <ModelCell
                        model={rowModel(r)}
                        className="text-(--text-faint)"
                      />
                    </td>
                  )}
                  {show.has("attempts") && (
                    <td className="max-w-16 whitespace-nowrap border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      {r.attempts}
                    </td>
                  )}
                  {show.has("reason") && (
                    <td
                      className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-faint)"
                      title={
                        r.reasonCode && r.reasonCode.toLowerCase() !== "ok"
                          ? r.reasonCode
                          : undefined
                      }
                    >
                      {r.reasonCode && r.reasonCode.toLowerCase() !== "ok"
                        ? r.reasonCode
                        : EMPTY}
                    </td>
                  )}
                  {show.has("origin") && (
                    <td
                      className="mono max-w-32 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-faint)"
                      title={r.eventId ?? undefined}
                    >
                      {r.eventId && r.eventSource ? (
                        <JumpLink
                          onClick={() =>
                            onJumpEvent(r.eventSource!, r.eventId!)
                          }
                          title={`Open origin event ${r.eventId}`}
                        >
                          {shortId(r.eventId)}
                        </JumpLink>
                      ) : r.eventId ? (
                        shortId(r.eventId)
                      ) : (
                        EMPTY
                      )}
                    </td>
                  )}
                  {show.has("updated") && (
                    <td className="max-w-24 whitespace-nowrap border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                      <span title={r.updated_at}>
                        {formatRelative(r.updated_at, now)}
                      </span>
                    </td>
                  )}
                  {listCols
                    .filter((c) => c.isCustom || c.key.startsWith("custom:"))
                    .map((c) => (
                      <CustomCell
                        key={c.key}
                        row={r}
                        path={c.key.replace(/^custom:/, "")}
                        schema={inputSchemaByAgent.get(r.agent)}
                      />
                    ))}
                </tr>
              );
              return windowTokens.map((token) => {
                if (token.length === 1) return renderRow(token[0]);
                const [s, sub] = token;
                return (
                  <GroupHeaderRow
                    key={`group:${s.key}`}
                    colSpan={listCols.length}
                    section={s}
                    collapsed={display.collapsed.includes(s.key)}
                    onToggle={() =>
                      setDisplay((st) => toggleCollapsed(st, s.key))
                    }
                    sub={sub}
                  />
                );
              });
            })()}
            <TableWindowFooter
              colSpan={listCols.length}
              range={[windowStart, windowEnd, tokens.length]}
              move={moveWindow}
            />
            {(nextBefore || runCursor) && (
              <tr>
                <td>
                  {runCursor && (
                    <button onClick={() => setRunCursor(null)}>Newest</button>
                  )}
                  {nextBefore && (
                    <button onClick={() => setRunCursor(nextBefore)}>
                      Older
                    </button>
                  )}
                </td>
              </tr>
            )}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={listCols.length}
                query={list}
                filtered={byTab.length > 0}
                onClear={filter.trim() ? () => setFilter("") : undefined}
                noun="runs"
                empty={
                  context.kind === "inflight"
                    ? "No runs in flight."
                    : context.kind === "repo"
                      ? `No runs for ${context.name}.`
                      : tab === "ALL"
                        ? "No runs."
                        : `No ${RUN_TAB_LABELS[tab].toLowerCase()} runs.`
                }
                escHint={Boolean(filter.trim())}
                action={
                  // Only In flight can strand an operator with no way back but the
                  // context strip's All tab — offer the same exit inline (WM-91).
                  context.kind === "inflight" ? (
                    <Button
                      onClick={() => {
                        if (typeof window !== "undefined")
                          window.location.hash = "#/runs";
                      }}
                    >
                      Show all runs
                    </Button>
                  ) : undefined
                }
              />
            )}
          </tbody>
        </Table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="fixed inset-0 z-20 w-full sm:static sm:z-auto sm:w-[440px]"
          title={
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal"
            >
              <PrimitiveButton
                bare
                type="button"
                onClick={() => onSelectRun(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to runs list"
              >
                Runs
              </PrimitiveButton>
              <span className="text-(--text-faint)" aria-hidden="true">
                /
              </span>
              <span
                className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)"
                aria-current="page"
              >
                <StateBadge state={sel.state} />
                <JumpLink
                  onClick={() => onOpenFull(sel.runId)}
                  title={`Open ${sel.runId}`}
                  className="truncate mono"
                >
                  {shortId(sel.runId)}
                </JumpLink>
              </span>
            </nav>
          }
          actions={
            <>
              <div className="flex items-center gap-1.5">
                {canApprove && selProposal && (
                  <Button
                    disabled={!connected || approve.isPending}
                    onClick={() => setConfirmApprove(true)}
                  >
                    Approve…{" "}
                    <span
                      className="mono ml-1 text-(--text-faint)"
                      aria-hidden="true"
                    >
                      a
                    </span>
                  </Button>
                )}
                {selProposal && onJumpProposal && (
                  <Button onClick={() => onJumpProposal(selProposal.id)}>
                    Open proposal
                  </Button>
                )}
                {d && isCancellable(d.run.state) && (
                  <Button
                    variant="danger"
                    disabled={!connected || cancel.isPending}
                    onClick={() => setConfirm("cancel")}
                  >
                    Cancel{" "}
                    <span
                      className="mono ml-1 text-(--text-faint)"
                      aria-hidden="true"
                    >
                      x
                    </span>
                  </Button>
                )}
                {d &&
                  d.run.state === "FAILED" &&
                  (attemptsExhausted ? (
                    <Button
                      disabled={!connected}
                      onClick={() => setConfirm("force-retry")}
                    >
                      Force retry…
                    </Button>
                  ) : (
                    <Button
                      disabled={!connected || retry.isPending}
                      onClick={() =>
                        retry.mutate({ id: d.run.runId, force: false })
                      }
                    >
                      Retry
                    </Button>
                  ))}
              </div>
              <div className="flex items-center gap-1.5">
                <Button onClick={() => onOpenFull(sel.runId)}>
                  Expand{" "}
                  <span
                    className="mono ml-1 text-(--text-faint)"
                    aria-hidden="true"
                  >
                    o
                  </span>
                </Button>
                <Button onClick={() => toggleRunPin(sel.runId)}>
                  Open in tab{" "}
                  <span
                    className="mono ml-1 text-(--text-faint)"
                    aria-hidden="true"
                  >
                    p
                  </span>
                </Button>
              </div>
            </>
          }
          utility={
            <CopyActions
              id={sel.runId}
              idLabel="run id"
              cli={`bun event-runtime/cli.mjs inspect ${sel.runId}`}
              cliLabel="CLI inspect command"
            />
          }
          close={<Button onClick={() => onSelectRun(null)}>Close</Button>}
        >
          {!d && (
            <div className="text-(--text-faint)">
              {detail.isError ? "Could not load run detail." : "Loading run…"}
            </div>
          )}

          {d && (
            <>
              <RunFailureBanner state={d.run.state} lifecycle={d.lifecycle} />
              {d.run.state === "PROPOSED" && (
                <div className="mb-4 rounded-md border border-(--border) bg-(--surface-1) p-3 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-(--text)">
                        Awaiting Proposal Approval
                      </div>
                      <div className="text-[11px] text-(--text-dim) mt-0.5">
                        {selProposal
                          ? `Proposal ${shortId(selProposal.id)} is open and ready to approve.`
                          : "This run was proposed and is waiting for proposal approval."}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {selProposal && onJumpProposal && (
                        <Button onClick={() => onJumpProposal(selProposal.id)}>
                          Open proposal
                        </Button>
                      )}
                      {canApprove && selProposal && (
                        <Button
                          disabled={!connected || approve.isPending}
                          onClick={() => setConfirmApprove(true)}
                        >
                          Approve…
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div onClickCapture={handleRunArtifactClick}>
                <RunDetailBlocks
                  d={d}
                  now={now}
                  connected={connected}
                  origin={sel}
                  onJumpAgent={onJumpAgent}
                  onJumpEvent={onJumpEvent}
                  onCancel={() => setConfirm("cancel")}
                  onRetry={() =>
                    retry.mutate({ id: d.run.runId, force: false })
                  }
                  onForceRetry={() => setConfirm("force-retry")}
                  retryPending={retry.isPending}
                  verbError={
                    cancel.error ??
                    (confirm === "force-retry" ? null : retry.error) ??
                    approve.error
                  }
                  afterLifecycle={
                    /* key: a run switch must reset the feed's cursor and scroll state. */
                    <RunTrace
                      key={d.run.runId}
                      runId={d.run.runId}
                      state={d.run.state}
                      onExpand={() => onOpenFull(d.run.runId)}
                    />
                  }
                />
                <Suspense fallback={null}>
                  <NotesPanelLazy
                    runInput={d.run.spec.input}
                    runId={d.run.runId}
                    wroteRunId={d.run.runId}
                  />
                </Suspense>
              </div>
            </>
          )}
        </DetailPane>
      )}

      {confirmApprove && selProposal && d && (
        <Dialog
          title={`Approve and queue run ${shortId(selProposal.runId ?? d.run.runId)}?`}
          onClose={() => setConfirmApprove(false)}
          wide
          footer={
            <>
              <Button onClick={() => setConfirmApprove(false)}>Not yet</Button>
              <Button
                variant="primary"
                disabled={!connected || approve.isPending}
                onClick={() => {
                  approve.mutate(selProposal.id);
                }}
              >
                Approve and queue{" "}
                <span className="mono ml-1 opacity-80" aria-hidden="true">
                  ↵
                </span>
              </Button>
            </>
          }
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            You are approving this exact immutable spec — the agent below runs
            with these capabilities the moment you confirm. Approving proposal{" "}
            <span className="mono font-semibold">{selProposal.id}</span> queues
            this run for execution.
          </div>
          <ApprovalRiskDetails proposal={selProposal} agent={approveAgent} />
          <VerbError error={approve.error} />
        </Dialog>
      )}

      {confirm === "cancel" && d && (
        <Dialog
          title={`Cancel ${d.run.runId}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Keep run</Button>
              <Button
                variant="danger"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate({
                    id: d.run.runId,
                    reason: cancelReason.trim() || undefined,
                  })
                }
              >
                Cancel run
              </Button>
            </>
          }
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            {d.run.state === "RUNNING"
              ? "Running attempt is stopped with TERM/KILL and cancelled."
              : "Run is cancelled before execution."}
          </div>
          <VerbError error={cancel.error} />
          <input
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason (optional)"
            className="mb-3 w-full rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-(--text) outline-none focus:border-(--accent)"
          />
        </Dialog>
      )}

      {confirm === "force-retry" && d && (
        <Dialog
          title="Retry past attempt budget?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Leave it</Button>
              <Button
                variant="primary"
                disabled={retry.isPending}
                onClick={() => retry.mutate({ id: d.run.runId, force: true })}
              >
                Force retry
              </Button>
            </>
          }
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Used {d.run.attempts}/{d.run.spec.maxAttempts} attempts. Forcing
            retry is recorded as an operator override.
          </div>
          <VerbError error={retry.error} />
        </Dialog>
      )}
    </div>
  );
}

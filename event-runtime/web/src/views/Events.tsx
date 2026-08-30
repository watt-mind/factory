import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { retriggerEnvelope } from "../templates";
import {
  keyGuard,
  refetchIntervals,
  tableTokens,
  useDisplayOptions,
  useListKeys,
  useNow,
  useRequeuePoll,
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
import {
  CausationGlyphs,
  EventHoverCard,
  chainHref,
} from "../components/EventHoverCard";
import { chainKeyOfEvent, eventNodeId } from "../graph/chainModel";
import { setContextActions } from "../palette";
import { ScopeCaption } from "../components/ContextTabs";
import type { AdmittedEvent, EventFocus, Proposal, RunSummary } from "../types";
import type { OperatorContext } from "../context";
import { matchesRepo } from "../context";
import {
  EVENT_FACETS,
  matchesFilterQuery,
  parseFilterQuery,
  type EventFilterRow,
  type FilterToken,
} from "../filterQuery";
import { humanizeReason } from "../reasons";
import {
  ReasonText,
  TicketDecisionsPanel,
  eventTicket,
} from "../components/RunDetailBlocks";
import { decideRevealFilters, formatRevealNotification } from "../reveal";
import {
  Ago,
  Button,
  CopyActions,
  Dialog,
  Disclosure,
  EVENT_STATUS_HUES,
  FilterInput,
  ListToolbar,
  ListPane,
  DetailPane,
  JsonBlock,
  JumpLink,
  KV,
  ListEmpty,
  notify,
  GroupHeaderRow,
  Section,
  StateBadge,
  Table,
  TableWindowFooter,
  Th,
  VerbError,
  copyText,
  copyLink,
  shortId,
} from "../components/ui";
import { Button as PrimitiveButton } from "../components/ui";

function removeTokensFromQuery(
  filter: string,
  tokens: readonly FilterToken[],
): string {
  const ordered = [...tokens].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let next = "";

  for (const token of ordered) {
    next += filter.slice(cursor, token.start);
    cursor = token.end;
  }
  next += filter.slice(cursor);

  return next.replace(/\s+/g, " ").trim();
}

const FACET_PREVIEW_LIMIT = 2;

function FacetChoice({
  value,
  count,
  active,
  mono = false,
  onClick,
}: {
  value: string;
  count: number;
  active: boolean;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <PrimitiveButton
      bare
      type="button"
      aria-pressed={active}
      title={value}
      onClick={onClick}
      className={`inline-flex min-w-0 max-w-44 items-center rounded-md px-2 py-0.5 text-[11px] transition-colors ${
        mono ? "mono" : ""
      } ${
        active
          ? "bg-(--surface-3) font-medium text-(--text)"
          : "text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text)"
      }`}
    >
      <span className="min-w-0 truncate">{value}</span>
      {count > 0 && (
        <span
          className={`${mono ? "font-sans" : ""} ml-1.5 shrink-0 tabular-nums text-(--text-faint)`}
        >
          {count}
        </span>
      )}
    </PrimitiveButton>
  );
}

function FacetOverflow({
  children,
  count,
  label,
}: {
  children: React.ReactNode;
  count: number;
  label: string;
}) {
  if (count === 0) return null;
  return (
    <details className="relative shrink-0">
      <summary
        className="cursor-pointer list-none rounded-md px-2 py-0.5 text-[11px] text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text) [&::-webkit-details-marker]:hidden"
        title={`Show ${count} more ${label.toLowerCase()}`}
      >
        +{count} more
      </summary>
      <div className="absolute top-full right-0 z-30 mt-1 flex min-w-56 max-w-80 flex-col items-stretch gap-1 rounded-md border border-(--border-strong) bg-(--surface-1) p-1 shadow-xl">
        {children}
      </div>
    </details>
  );
}

function toggleFacetInQuery(
  filter: string,
  key: "type" | "source",
  value: string,
): string {
  const parsed = parseFilterQuery(filter, EVENT_FACETS);
  const existingTokens = parsed.tokens.filter(
    (t): t is Extract<FilterToken, { kind: "field" }> =>
      t.kind === "field" && t.key === key,
  );
  const isAlreadyActive = existingTokens.some(
    (t) => t.value.toLowerCase() === value.toLowerCase(),
  );

  if (isAlreadyActive) {
    const matching = existingTokens.filter(
      (t) => t.value.toLowerCase() === value.toLowerCase(),
    );
    return removeTokensFromQuery(filter, matching);
  }

  const next = removeTokensFromQuery(filter, existingTokens);
  const addition = `${key}:${value}`;
  return next ? `${next} ${addition}` : addition;
}

function setFacetInQuery(
  filter: string,
  key: "type" | "source",
  value: string,
): string {
  const parsed = parseFilterQuery(filter, EVENT_FACETS);
  const existingTokens = parsed.tokens.filter(
    (t): t is Extract<FilterToken, { kind: "field" }> =>
      t.kind === "field" && t.key === key,
  );
  const next = removeTokensFromQuery(filter, existingTokens);
  const addition = `${key}:${value}`;
  return next ? `${next} ${addition}` : addition;
}

const STATUS_TABS = [
  "all",
  "admitted",
  "planned",
  "noop",
  "human_needed",
  "dead_lettered",
] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable=true]"))
  );
}

/** Only these two statuses may be requeued (planner.mjs requeueEvent). */
const REQUEUEABLE = new Set(["dead_lettered", "human_needed"]);

const TAB_LABEL: Record<StatusTab, string> = {
  all: "All",
  admitted: "Admitted",
  planned: "Planned",
  noop: "Noop",
  human_needed: "Human needed",
  dead_lettered: "Dead lettered",
};

const keyOf = (e: AdmittedEvent) => `${e.source}:${e.eventId}`;

/**
 * What the planner decided about one event (WM-594): the proposal it opened
 * (`planned` / `noop` / `human_needed` + reason), or `refused` when the run it
 * planned was turned away by the dispatch gate, or the plan error on an event
 * that never got a proposal. `null` when there is nothing to explain yet.
 */
export interface EventDecision {
  outcome: string;
  status: string | null;
  reason: string | null;
}

export function decisionOf(
  e: AdmittedEvent,
  proposalsById: ReadonlyMap<string, Proposal>,
  proposalsByEvent: ReadonlyMap<string, Proposal>,
  runsById: ReadonlyMap<string, RunSummary>,
): EventDecision | null {
  // A noop proposal can point at the *blocking* run (`duplicate_run`,
  // `ticket_dispatch_already_live`); only a run this event's own proposal
  // actually planned (`decision === "run"`) makes the event's decision
  // `refused` — `e.runId` alone is not enough, it is set from the event's
  // latest proposal even when that proposal is `noop` and merely points at
  // the run it deduplicated onto. The bounded GET /runs summary (WM-976)
  // dropped eventSource/eventId/reasonCode off the run row, so the reason
  // text is not available here; open the run for that.
  const proposal =
    (e.proposalId ? proposalsById.get(e.proposalId) : undefined) ??
    proposalsByEvent.get(keyOf(e));
  const plannedRun =
    e.runId && (!proposal || proposal.decision === "run")
      ? runsById.get(e.runId)
      : undefined;
  if (plannedRun?.state === "REFUSED")
    return { outcome: "refused", status: null, reason: null };
  if (proposal) {
    return {
      outcome: proposal.decision === "run" ? "planned" : proposal.decision,
      status: proposal.status,
      reason: proposal.reason,
    };
  }
  if (e.lastPlanError)
    return { outcome: e.status, status: null, reason: e.lastPlanError };
  return null;
}

/**
 * Whether `e.runId` names a run this event's own proposal actually planned
 * (`decision === "run"`) rather than one it merely points at as the run it
 * deduplicated onto (`noop`/`duplicate_run`, `ticket_dispatch_already_live`).
 * Shared by `decisionOf`'s REFUSED check and the fan-out count below so both
 * agree on what "this event planned that run" means.
 */
function runPlannedBy(
  e: AdmittedEvent,
  proposalsById: ReadonlyMap<string, Proposal>,
  proposalsByEvent: ReadonlyMap<string, Proposal>,
): boolean {
  if (!e.runId) return false;
  const proposal =
    (e.proposalId ? proposalsById.get(e.proposalId) : undefined) ??
    proposalsByEvent.get(keyOf(e));
  return !proposal || proposal.decision === "run";
}

/** `noop · Owned paths overlap` — badge tooltip and the decision row's text. */
export function decisionText(d: EventDecision | null): string {
  if (!d) return "";
  const reason = humanizeReason(d.reason).text;
  const status =
    d.outcome === "planned" && d.status && d.status !== "approved"
      ? ` (${d.status})`
      : "";
  return `${d.outcome}${status}${reason ? ` · ${reason}` : ""}`;
}

/**
 * The sentence the row's `↳` / `→ N` arrows stand for (WM-702). The glyphs are
 * the only thing narrow enough for the Event column; the tooltip is where they
 * say what they mean, to a screen reader as much as to a pointer.
 */
export function eventCausationTitle(
  causedBy: string | null,
  fanOut: number,
): string {
  const parts: string[] = [];
  if (causedBy) parts.push(`Emitted by run ${shortId(causedBy)}`);
  if (fanOut > 0)
    parts.push(`${fanOut} run${fanOut === 1 ? "" : "s"} planned from it`);
  return `${parts.join(" · ")} — open the chain`;
}

function isStatusTab(value: string | undefined): value is StatusTab {
  return !!value && (STATUS_TABS as readonly string[]).includes(value);
}

/** The list badge can also read `refused` — an event whose planned run the gate turned away. */
const LIST_STATUS_HUES: Record<string, string> = {
  ...EVENT_STATUS_HUES,
  refused: "var(--hue-warn)",
};

const rowWash = (s: string) =>
  s === "dead_lettered"
    ? "row-wash-err"
    : s === "human_needed"
      ? "row-wash-warn"
      : "";

/**
 * Grouping/ordering/columns (OPS-493) — one config across every status tab:
 * the tabs filter the same table, they never change its columns. Occurred and
 * Received have no column of their own (the table shows Admitted), so those
 * sorts live in the Display popover only; Type is the click-to-sort header.
 */
const EVENTS_DISPLAY: DisplayConfig<AdmittedEvent> = {
  view: "events",
  groups: [
    {
      key: "status",
      label: "Status",
      get: (e) => e.status,
      order: ["admitted", "planned", "noop", "human_needed", "dead_lettered"],
      hue: EVENT_STATUS_HUES,
    },
    { key: "source", label: "Source", get: (e) => e.source },
    { key: "type", label: "Type", get: (e) => e.type },
  ],
  subGroups: ["type", "source", "status"],
  sorts: [
    { key: "event", label: "Event", get: (e) => e.eventId, column: "event" },
    { key: "source", label: "Source", get: (e) => e.source, column: "source" },
    { key: "type", label: "Type", get: (e) => e.type, column: "type" },
    {
      key: "subject",
      label: "Subject",
      get: (e) => e.subject ?? "",
      column: "subject",
    },
    { key: "status", label: "Status", get: (e) => e.status, column: "status" },
    {
      key: "admitted",
      label: "Admitted",
      get: (e) => e.admittedAt,
      defaultDir: "desc",
      column: "admitted",
    },
    {
      key: "occurred",
      label: "Occurred",
      get: (e) => e.occurredAt,
      defaultDir: "desc",
    },
    {
      key: "received",
      label: "Received",
      get: (e) => e.receivedAt,
      defaultDir: "desc",
    },
  ],
  columns: [
    { key: "event", label: "Event", always: true },
    { key: "source", label: "Source" },
    { key: "type", label: "Type" },
    { key: "subject", label: "Subject" },
    { key: "status", label: "Status" },
    { key: "admitted", label: "Admitted" },
  ],
};

/**
 * Events (webui doc §10.1) — the event inbox. Every admitted envelope with
 * its planning outcome; dead letters carry the error tone, and requeue
 * (`q`) re-plans a dead_lettered/human_needed event through the same path
 * as a fresh admission.
 */
export function Events({
  connected,
  context,
  focusEvent,
  onFocusConsumed,
  onSelectEvent,
  onSelectType,
  onJumpProposal,
  onJumpRun,
  onJumpChain,
  onTriggerAgain,
  onInject,
  rejumpEpoch,
}: {
  connected: boolean;
  context: OperatorContext;
  focusEvent: EventFocus | null;
  onFocusConsumed: () => void;
  onSelectEvent: (source: string | null, eventId?: string) => void;
  onSelectType: (type: string | null) => void;
  onJumpProposal: (id: string) => void;
  onJumpRun: (runId: string) => void;
  /** Open the chain trace this event belongs to (WM-527). Optional so tests can omit it. */
  onJumpChain?: (correlationId: string, nodeId?: string) => void;
  onTriggerAgain: (envelope: Record<string, unknown>) => void;
  onInject: () => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const pollRequeue = useRequeuePoll(onJumpProposal);
  const [tab, setTab] = useState<StatusTab>(
    isStatusTab(focusEvent?.status) ? focusEvent.status : "all",
  );
  const [filter, setFilter] = useState(
    focusEvent?.type ? `type:${focusEvent.type}` : "",
  );
  const [confirmReplay, setConfirmReplay] = useState(false);
  const [replayedEventKey, setReplayedEventKey] = useState<string | null>(null);

  const fetchAll = context.kind === "repo";
  const list = useInfiniteQuery({
    queryKey: ["events", fetchAll ? "all" : tab],
    queryFn: ({ pageParam }) =>
      api.events(fetchAll || tab === "all" ? undefined : tab, {
        before: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    ...refetchIntervals.primary,
  });
  const statusQ = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    ...refetchIntervals.fast,
  });
  // The reason behind a noop / refused row lives on the proposal and the run,
  // not the event (WM-594); both lists are already cached by other views.
  const proposalsQ = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    ...refetchIntervals.secondary,
  });
  const runsQ = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    ...refetchIntervals.secondary,
  });
  // Dynamic payload columns can be marked by the producing route's input
  // schema. Keep this separate from row fetching: a registry refresh must not
  // make Events wait for a second events response before its cells gain their
  // semantic rendering.
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    ...refetchIntervals.secondary,
  });
  const inputSchemaByEventType = useMemo(() => {
    const registry = agentsQ.data;
    const byRef = new Map(registry?.agents.map((agent) => [agent.ref, agent]));
    const schemas = new Map<string, unknown>();
    for (const route of registry?.eventTypes ?? []) {
      const schema = route.agent ? byRef.get(route.agent)?.inputSchema : null;
      if (schema) schemas.set(route.type, schema);
    }
    // The route is also retained with its agent definition. This fallback
    // keeps the semantic cell useful for older registry responses that predate
    // the top-level eventTypes index.
    for (const agent of registry?.agents ?? []) {
      for (const route of agent.eventTypes) {
        if (!schemas.has(route.type))
          schemas.set(route.type, agent.inputSchema);
      }
    }
    return schemas;
  }, [agentsQ.data]);
  const decisions = useMemo(() => {
    const byId = new Map<string, Proposal>();
    const byEvent = new Map<string, Proposal>();
    for (const p of proposalsQ.data?.proposals ?? []) {
      byId.set(p.id, p);
      const k = `${p.eventSource}:${p.eventId}`;
      const prev = byEvent.get(k);
      if (!prev || prev.created_at < p.created_at) byEvent.set(k, p);
    }
    const runsById = new Map<string, RunSummary>();
    for (const r of runsQ.data?.runs ?? []) runsById.set(r.runId, r);
    return { byId, byEvent, runsById };
  }, [proposalsQ.data, runsQ.data]);
  const decisionFor = (e: AdmittedEvent) =>
    decisionOf(e, decisions.byId, decisions.byEvent, decisions.runsById);
  const rows: EventFilterRow[] = useMemo(
    () =>
      (list.data?.pages ?? [])
        .flatMap((page) => page?.events ?? [])
        .map((e) => {
          const d = decisionOf(
            e,
            decisions.byId,
            decisions.byEvent,
            decisions.runsById,
          );
          return d?.reason ? { ...e, decisionReason: d.reason } : e;
        }),
    [list.data, decisions],
  );
  const scoped = useMemo(() => {
    const focusKey =
      focusEvent?.source && focusEvent?.eventId
        ? `${focusEvent.source}:${focusEvent.eventId}`
        : null;
    return rows.filter(
      (e) => keyOf(e) === focusKey || matchesRepo(e.repos, context),
    );
  }, [rows, context, focusEvent?.source, focusEvent?.eventId]);

  const tabScoped = useMemo(() => {
    if (fetchAll && tab !== "all") {
      return scoped.filter((e) => e.status === tab);
    }
    return scoped;
  }, [scoped, fetchAll, tab]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of tabScoped) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    return counts;
  }, [tabScoped]);

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of tabScoped) {
      counts[e.source] = (counts[e.source] ?? 0) + 1;
    }
    return counts;
  }, [tabScoped]);

  const types = useMemo(
    () =>
      Object.keys(typeCounts).sort(
        (a, b) =>
          (typeCounts[b] ?? 0) - (typeCounts[a] ?? 0) || a.localeCompare(b),
      ),
    [typeCounts],
  );
  const sources = useMemo(
    () =>
      Object.keys(sourceCounts).sort(
        (a, b) =>
          (sourceCounts[b] ?? 0) - (sourceCounts[a] ?? 0) || a.localeCompare(b),
      ),
    [sourceCounts],
  );

  const parsed = useMemo(
    () => parseFilterQuery(filter, EVENT_FACETS),
    [filter],
  );

  // `reason:` value suggestions come from the reasons actually in the loaded
  // set (head code only, most frequent first) — the vocabulary is the planner's.
  const facets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of tabScoped) {
      const raw = e.decisionReason;
      if (!raw) continue;
      const head = raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : raw;
      if (/\s/.test(head)) continue;
      counts.set(head, (counts.get(head) ?? 0) + 1);
    }
    const reasons = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([r]) => r);
    return {
      ...EVENT_FACETS,
      values: { ...EVENT_FACETS.values, reason: reasons },
    };
  }, [tabScoped]);

  const activeTypes = useMemo(() => {
    return new Set(
      parsed.tokens
        .filter(
          (t): t is Extract<FilterToken, { kind: "field" }> =>
            t.kind === "field" && t.key === "type",
        )
        .map((t) => t.value.toLowerCase()),
    );
  }, [parsed.tokens]);

  const activeSources = useMemo(() => {
    return new Set(
      parsed.tokens
        .filter(
          (t): t is Extract<FilterToken, { kind: "field" }> =>
            t.kind === "field" && t.key === "source",
        )
        .map((t) => t.value.toLowerCase()),
    );
  }, [parsed.tokens]);

  const visible = useMemo(() => {
    return scoped.filter((e) => {
      if (fetchAll && tab !== "all" && e.status !== tab) return false;
      return matchesFilterQuery(e, parsed, EVENT_FACETS, undefined);
    });
  }, [scoped, parsed, fetchAll, tab]);

  // Display options (OPS-493): partition into sections, order inside them,
  // and feed keyboard navigation only the rows of open sections. Under a
  // single-status tab the empty-group universe narrows to that status, so
  // "show empty groups" never renders bands the tab already filtered out.
  const displayConfig = useMemo(
    () =>
      tab === "all"
        ? EVENTS_DISPLAY
        : {
            ...EVENTS_DISPLAY,
            groups: EVENTS_DISPLAY.groups.map((g) =>
              g.key === "status" ? { ...g, order: [tab] } : g,
            ),
          },
    [tab],
  );
  const [display, setDisplay] = useDisplayOptions(displayConfig);
  const sections = useMemo(
    () => buildSections(visible, displayConfig, display),
    [visible, displayConfig, display],
  );
  const flat = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(displayConfig, display);

  const selectedKey =
    focusEvent?.source && focusEvent?.eventId
      ? `${focusEvent.source}:${focusEvent.eventId}`
      : null;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(
    () => flat.findIndex((e) => keyOf(e) === selectedKey),
    [flat, selectedKey],
  );
  const tokens = tableTokens(sections, display.collapsed, grouped(display));
  const [windowTokens, windowStart, windowEnd, moveWindow] = useTableWindow(
    tokens,
    selectedKey,
    keyOf,
    JSON.stringify([tab, filter, context, display]),
  );
  const sel = useMemo(
    () =>
      selectedKey
        ? (visible.find((e) => keyOf(e) === selectedKey) ?? null)
        : null,
    [visible, selectedKey],
  );
  const replayed = selectedKey === replayedEventKey;

  // A replay is a one-shot action for the current detail selection. Closing
  // the pane or selecting another event restores the action for that detail.
  useEffect(() => {
    setReplayedEventKey(null);
  }, [selectedKey]);

  // The detail pane leaves a compact triage list. Keep the columns needed to
  // identify and compare events; the complete row remains in Display when the
  // pane closes, and every field remains available in the pane itself.
  const listCols = sel
    ? cols.filter((c) =>
        ["event", "type", "subject", "status", "admitted"].includes(c.key),
      )
    : cols;
  const show = useMemo(() => new Set(listCols.map((c) => c.key)), [listCols]);

  useEffect(() => {
    document
      .querySelector("tr.row-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, windowStart]);

  // Ephemeral Overview/Graph jumps: apply tab/type then drop them so the hash
  // (if any) is the only remaining selection source.
  useEffect(() => {
    if (!focusEvent) return;
    if (isStatusTab(focusEvent.status) && tab !== focusEvent.status)
      setTab(focusEvent.status);
    if (focusEvent.type) {
      setFilter((cur) => setFacetInQuery(cur, "type", focusEvent.type!));
    }
    if (focusEvent.status || focusEvent.type) onFocusConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEvent?.status, focusEvent?.type]);

  // Reveal a hash-selected row only when current filters hide it. Latch until
  // the row is on the active tab (inject / tab switch / poll); decide once so a
  // later 2s poll does not wipe a typed filter. j/k/click on a visible row
  // keeps the chips. Under `fetchAll` the row can sit in `rows` while another
  // status tab is active, so deciding on presence alone would clear the chips
  // before the tab effect below has made the row renderable.
  const pendingReveal = useRef<{
    key: string;
    snapshot: { filter: string };
  } | null>(null);
  const lastKey = useRef<string | null>(null);
  const lastRejump = useRef<number | undefined>(rejumpEpoch);
  const tabChangedFor = useRef<string | null>(null);
  useEffect(() => {
    const isNewKey = selectedKey !== lastKey.current;
    const isRejump = rejumpEpoch !== lastRejump.current;
    lastKey.current = selectedKey;
    lastRejump.current = rejumpEpoch;

    if (selectedKey && (isNewKey || isRejump)) {
      pendingReveal.current = {
        key: selectedKey,
        snapshot: { filter },
      };
    }
    const latch = pendingReveal.current;
    if (!latch || latch.key !== selectedKey) return;
    const row = rows.find((e) => keyOf(e) === latch.key);
    if (!row) return; // tab switch / poll still pending
    if (fetchAll && tab !== "all" && row.status !== tab) return; // waiting on the tab switch
    pendingReveal.current = null; // decided once
    const isVisible = visible.some((e) => keyOf(e) === latch.key);
    const currentFilters = { filter };
    const emptyFilters = {
      filter: "",
    };
    const decision = decideRevealFilters(
      latch.snapshot,
      currentFilters,
      emptyFilters,
      isVisible,
    );
    if (decision.cleared) {
      if (decision.clearedFields.includes("filter")) {
        setFilter(decision.next.filter);
        if (!focusEvent?.type) onSelectType(null);
      }
    }
    const tabChanged = tabChangedFor.current === latch.key;
    tabChangedFor.current = null;
    if (tabChanged || decision.cleared) {
      const msg = formatRevealNotification({
        kind: "event",
        id: focusEvent?.eventId ?? row.eventId,
        state: row.status,
        tabChanged,
        filterCleared: decision.cleared,
      });
      if (msg) notify(msg, "info");
    }
  }, [
    selectedKey,
    rejumpEpoch,
    rows,
    visible,
    focusEvent?.type,
    focusEvent?.eventId,
    fetchAll,
    tab,
    filter,
    onSelectType,
  ]);

  // Hash id: switch to All if the row isn't on this tab. Don't strip the hash.
  // With a repo context the fetch ignores the tab, so the row's own status —
  // not its presence in `rows` — decides whether this tab can render it.
  useEffect(() => {
    if (!focusEvent?.source || !focusEvent?.eventId) {
      tabChangedFor.current = null;
      return;
    }
    if (isStatusTab(focusEvent.status) && tab !== focusEvent.status) return;
    if (list.isPending || !list.data) return;
    const key = `${focusEvent.source}:${focusEvent.eventId}`;
    const row = rows.find((e) => keyOf(e) === key);
    if (fetchAll) {
      if (row && tab !== "all" && row.status !== tab) {
        tabChangedFor.current = key;
        setTab("all");
      }
      return;
    }
    if (!row && tab !== "all") {
      tabChangedFor.current = key;
      setTab("all");
    }
  }, [
    focusEvent?.source,
    focusEvent?.eventId,
    focusEvent?.status,
    rows,
    tab,
    fetchAll,
    list.isPending,
    list.data,
  ]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["events"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
    queryClient.invalidateQueries({ queryKey: ["proposals"] });
  };

  const requeue = useMutation({
    mutationFn: (e: AdmittedEvent) => api.requeue(e.source, e.eventId),
    onSuccess: async (_, e) => {
      invalidate();
      notify(`Requeued event ${e.eventId}`, "ok");
      await pollRequeue(e);
    },
    onError: invalidate, // 404/409 mean someone else acted — converge on truth
  });

  const replay = useMutation({
    mutationFn: (event: AdmittedEvent) => api.replay(event.envelope),
    onSuccess: (data, event) => {
      queryClient.invalidateQueries();
      setConfirmReplay(false);
      setReplayedEventKey(keyOf(event));
      notify(
        data.duplicate
          ? `Duplicate event ${data.eventId}`
          : `Replayed event ${data.eventId}`,
        "info",
      );
    },
  });

  const canRequeue = sel !== null && REQUEUEABLE.has(sel.status);

  const selectTab = (t: StatusTab) => {
    setTab(t);
    if (selectedKey) onSelectEvent(null);
  };
  useTabKeys(STATUS_TABS, tab, selectTab);

  const pendingC = useRef<number>(0);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (isTypingTarget(e.target)) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= STATUS_TABS.length) {
        e.preventDefault();
        selectTab(STATUS_TABS[num - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectTab]);

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => {
      const e = flat[i];
      onSelectEvent(e ? e.source : null, e?.eventId);
    },
    onClose: () => {
      if (sel) onSelectEvent(null);
      else if (filter) {
        setFilter("");
        onSelectType(null);
      } else if (selectedKey) {
        onSelectEvent(null);
      }
    },
    keys: {
      // `q` not `r`: `r` is the `g r` navigation suffix, and both listeners
      // see the same keydown — `g r` with a selection must never requeue.
      q: () => canRequeue && connected && sel && requeue.mutate(sel),
      c: () => {
        if (!sel) return;
        if (onJumpChain) {
          onJumpChain(
            sel.correlationId ?? sel.eventId,
            `event:${sel.source}:${sel.eventId}`,
          );
        } else {
          copyText(sel.eventId, "event id");
          pendingC.current = Date.now();
        }
      },
      r: () => {
        if (sel?.runId && onJumpRun) {
          onJumpRun(sel.runId);
        }
      },
      p: () => {
        if (sel?.proposalId && onJumpProposal) {
          onJumpProposal(sel.proposalId);
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
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel || !connected) {
      setContextActions([]);
    } else {
      setContextActions([
        ...(canRequeue
          ? [
              {
                label: `Requeue ${sel.eventId} (re-plan admitted event)`,
                hint: "q",
                run: () => requeue.mutate(sel),
              },
            ]
          : []),
        ...(onJumpChain
          ? [
              {
                label: "View chain",
                hint: "c",
                run: () =>
                  onJumpChain(
                    sel.correlationId ?? sel.eventId,
                    `event:${sel.source}:${sel.eventId}`,
                  ),
              },
            ]
          : []),
        ...(sel.proposalId && onJumpProposal
          ? [
              {
                label: `Open proposal ${sel.proposalId}`,
                hint: "p",
                run: () => onJumpProposal(sel.proposalId!),
              },
            ]
          : []),
        ...(sel.runId && onJumpRun
          ? [
              {
                label: `Open run ${sel.runId}`,
                hint: "r",
                run: () => onJumpRun(sel.runId!),
              },
            ]
          : []),
        ...(replayed
          ? []
          : [
              {
                label: `Replay ${sel.eventId} through intake…`,
                run: () => setConfirmReplay(true),
              },
            ]),
        {
          label: `Trigger ${sel.type} again (new event id)…`,
          run: () =>
            onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now())),
        },
        {
          label: `Copy ${sel.eventId}`,
          hint: "c",
          run: () => copyText(sel.eventId, "event id"),
        },
        { label: "Copy link to this event", hint: "c l", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sel ? keyOf(sel) : null,
    canRequeue,
    connected,
    replayed,
    onJumpChain,
    onJumpRun,
    onJumpProposal,
  ]);

  const eventCounts = statusQ.data?.events ?? {};
  const allCount = Object.values(eventCounts).reduce((n, v) => n + v, 0);
  const tabCount = (t: StatusTab) =>
    fetchAll
      ? t === "all"
        ? scoped.length
        : scoped.filter((e) => e.status === t).length
      : t === "all"
        ? allCount
        : (eventCounts[t] ?? 0);

  const handleExport = () => {
    const sorted = sortRows(visible, displayConfig, display);
    const dateStr = new Date().toISOString().slice(0, 10);
    exportJson(`events-export-${dateStr}.json`, sorted);
    notify(
      `Exported ${sorted.length} event${sorted.length === 1 ? "" : "s"} to JSON`,
      "info",
    );
  };

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-h1 font-semibold">Events</h1>
            {context.kind === "inflight" && (
              <ScopeCaption context={context} surface="fleet" />
            )}
            {context.kind === "repo" && (
              <p className="mb-3 text-[11px] text-(--text-faint)">
                Scoped to <span className="mono">{context.name}</span> — only
                rows naming this repo.
              </p>
            )}
            <p className="mb-3 text-[11px] text-(--text-faint)">
              {rows.length} loaded {rows.length === 1 ? "row" : "rows"}
              {list.hasNextPage && " · more events available"}. Facet counts
              reflect loaded rows.
              {fetchAll
                ? " Status-tab counts reflect loaded rows."
                : " Status-tab counts reflect all available events."}
            </p>

            {(types.length > 1 || sources.length > 1) && (
              <div className="mb-2 flex min-w-0 items-center gap-x-4 whitespace-nowrap text-[11px]">
                {types.length > 1 && (
                  <div
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                    role="group"
                    aria-label="Event types"
                  >
                    <span className="shrink-0 text-[11px] font-medium text-(--text-dim)">
                      Type:
                    </span>
                    {types.slice(0, FACET_PREVIEW_LIMIT).map((t) => {
                      const isPressed = activeTypes.has(t.toLowerCase());
                      return (
                        <FacetChoice
                          key={t}
                          value={t}
                          count={typeCounts[t] ?? 0}
                          active={isPressed}
                          onClick={() => {
                            setFilter((cur) =>
                              toggleFacetInQuery(cur, "type", t),
                            );
                            onSelectType(isPressed ? null : t);
                          }}
                        />
                      );
                    })}
                    <FacetOverflow
                      count={Math.max(0, types.length - FACET_PREVIEW_LIMIT)}
                      label="event types"
                    >
                      {types.slice(FACET_PREVIEW_LIMIT).map((t) => {
                        const isPressed = activeTypes.has(t.toLowerCase());
                        return (
                          <FacetChoice
                            key={t}
                            value={t}
                            count={typeCounts[t] ?? 0}
                            active={isPressed}
                            onClick={() => {
                              setFilter((cur) =>
                                toggleFacetInQuery(cur, "type", t),
                              );
                              onSelectType(isPressed ? null : t);
                            }}
                          />
                        );
                      })}
                    </FacetOverflow>
                  </div>
                )}
                {sources.length > 1 && (
                  <div
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                    role="group"
                    aria-label="Event sources"
                  >
                    <span className="shrink-0 text-[11px] font-medium text-(--text-dim)">
                      Source:
                    </span>
                    {sources.slice(0, FACET_PREVIEW_LIMIT).map((s) => (
                      <FacetChoice
                        key={s}
                        value={s}
                        count={sourceCounts[s] ?? 0}
                        active={activeSources.has(s.toLowerCase())}
                        mono
                        onClick={() =>
                          setFilter((cur) =>
                            toggleFacetInQuery(cur, "source", s),
                          )
                        }
                      />
                    ))}
                    <FacetOverflow
                      count={Math.max(0, sources.length - FACET_PREVIEW_LIMIT)}
                      label="event sources"
                    >
                      {sources.slice(FACET_PREVIEW_LIMIT).map((s) => (
                        <FacetChoice
                          key={s}
                          value={s}
                          count={sourceCounts[s] ?? 0}
                          active={activeSources.has(s.toLowerCase())}
                          mono
                          onClick={() =>
                            setFilter((cur) =>
                              toggleFacetInQuery(cur, "source", s),
                            )
                          }
                        />
                      ))}
                    </FacetOverflow>
                  </div>
                )}
              </div>
            )}

            <ListToolbar
              tabs={
                <div
                  className="flex w-max flex-nowrap gap-1 whitespace-nowrap"
                  role="tablist"
                  aria-label="Event status"
                >
                  {STATUS_TABS.map((t, idx) => {
                    const count = tabCount(t);
                    return (
                      <PrimitiveButton
                        bare
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={tab === t}
                        onClick={() => selectTab(t)}
                        title={t}
                        className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                          tab === t
                            ? "bg-(--surface-3) text-(--text)"
                            : "text-(--text-faint) hover:bg-(--surface-1)"
                        }`}
                      >
                        {TAB_LABEL[t]}
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
                      </PrimitiveButton>
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
                  {/* Last in the row: the token chips are a full-width item, so anything
                  after the filter box would be pushed onto a third line the moment
                  a chip appeared. */}
                  <FilterInput
                    value={filter}
                    onChange={setFilter}
                    placeholder="source:… type:… reason:… is:stale"
                    label="Filter events"
                    query={parsed}
                    facets={facets}
                  />
                </>
              }
            />
          </>
        }
      >
        <Table className="w-full table-fixed border-separate border-spacing-0">
          <thead>
            <tr className="text-left">
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
          <tbody>
            {(() => {
              const renderRow = (e: EventFilterRow) => {
                const decision = decisionFor(e);
                const decisionTitle = decisionText(decision);
                const isSelected = keyOf(e) === selectedKey;
                const causedBy = e.causationId ?? null;
                // The bounded GET /runs summary (WM-976) dropped the run's
                // origin event id, so a multi-run count can no longer be
                // joined back to this event — only whether the event's own
                // proposal actually planned `runId` (not merely pointed at
                // it as a `noop`/`duplicate_run` dedup target) and that run
                // is still in the list.
                const fanOut =
                  runPlannedBy(e, decisions.byId, decisions.byEvent) &&
                  decisions.runsById.has(e.runId!)
                    ? 1
                    : 0;
                const chainId = chainKeyOfEvent(e);
                const nodeId = eventNodeId(e.source, e.eventId);
                return (
                  <tr
                    key={keyOf(e)}
                    onClick={() => onSelectEvent(e.source, e.eventId)}
                    aria-selected={isSelected}
                    className={`cursor-pointer hover:bg-(--surface-1) ${rowWash(e.status)} ${isSelected ? "row-selected" : ""}`}
                  >
                    <td
                      className="mono max-w-28 overflow-hidden border-b border-(--border) px-3 py-1.5 whitespace-nowrap"
                      title={e.eventId}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <EventHoverCard
                          event={e}
                          className="min-w-0"
                          onJumpChain={onJumpChain}
                          onJumpEvent={onSelectEvent}
                          onJumpRun={onJumpRun}
                        >
                          <span className="truncate">{shortId(e.eventId)}</span>
                        </EventHoverCard>
                        <CausationGlyphs
                          causedBy={causedBy}
                          fanOut={fanOut}
                          href={chainHref(chainId, nodeId)}
                          title={eventCausationTitle(causedBy, fanOut)}
                          onJump={
                            onJumpChain
                              ? () => onJumpChain(chainId, nodeId)
                              : undefined
                          }
                        />
                      </span>
                    </td>
                    {show.has("source") && (
                      <td
                        className="mono max-w-24 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-faint)"
                        title={e.source}
                      >
                        {e.source}
                      </td>
                    )}
                    {show.has("type") && (
                      <td
                        className="max-w-44 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)"
                        title={e.type}
                      >
                        {e.type}
                      </td>
                    )}
                    {show.has("subject") && (
                      <td
                        className="max-w-36 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-faint)"
                        title={e.subject ?? undefined}
                      >
                        {e.subject ?? "-"}
                      </td>
                    )}
                    {show.has("status") && (
                      <td
                        className="max-w-44 overflow-hidden border-b border-(--border) px-3 py-1.5 whitespace-nowrap"
                        title={e.lastPlanError ?? undefined}
                      >
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
                          {/* Why, on hover (WM-594): `noop · Owned paths overlap` — the
                              raw code follows on a second line for copy/grep. */}
                          <span
                            className="flex shrink-0 items-center"
                            title={
                              decisionTitle
                                ? decision?.reason &&
                                  decision.reason !== decisionTitle
                                  ? `${decisionTitle}\n${decision.reason}`
                                  : decisionTitle
                                : undefined
                            }
                            data-decision={decision?.outcome ?? undefined}
                          >
                            <StateBadge
                              state={e.status}
                              hues={EVENT_STATUS_HUES}
                            />
                            {decision?.outcome === "refused" && (
                              <span className="ml-1.5">
                                <StateBadge
                                  state="refused"
                                  hues={LIST_STATUS_HUES}
                                  dot={false}
                                />
                              </span>
                            )}
                          </span>
                          {e.planFailures > 0 && (
                            <span className="shrink-0 text-[11px] text-(--hue-err)">
                              {e.planFailures} failure
                              {e.planFailures === 1 ? "" : "s"}
                            </span>
                          )}
                          {e.lastPlanError && (
                            <span className="mono min-w-0 truncate text-(--text-dim)">
                              {e.lastPlanError}
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                    {show.has("admitted") && (
                      <td className="max-w-24 whitespace-nowrap border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                        <Ago iso={e.admittedAt} now={now} />
                      </td>
                    )}
                    {listCols
                      .filter((c) => c.isCustom || c.key.startsWith("custom:"))
                      .map((c) => (
                        <CustomCell
                          key={c.key}
                          row={e}
                          path={c.key.replace(/^custom:/, "")}
                          schema={inputSchemaByEventType.get(e.type)}
                        />
                      ))}
                  </tr>
                );
              };
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
            {list.hasNextPage && (
              <tr>
                <td colSpan={listCols.length}>
                  <Button
                    onClick={() => list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                  >
                    {list.isFetchingNextPage
                      ? "Loading older events…"
                      : "Older events"}
                  </Button>
                </td>
              </tr>
            )}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={listCols.length}
                query={list}
                filtered={tabScoped.length > 0}
                onClear={
                  filter.trim()
                    ? () => {
                        setFilter("");
                        onSelectType(null);
                      }
                    : undefined
                }
                noun="events"
                empty={
                  context.kind === "repo"
                    ? `No events for ${context.name}.`
                    : tab === "all"
                      ? "No events."
                      : `No ${TAB_LABEL[tab].toLowerCase()} events.`
                }
                escHint={Boolean(filter.trim())}
                action={
                  tab === "all" ? (
                    <Button onClick={onInject}>Inject event…</Button>
                  ) : undefined
                }
              />
            )}
          </tbody>
        </Table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[440px]"
          title={
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal"
            >
              <PrimitiveButton
                bare
                type="button"
                onClick={() => onSelectEvent(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to events list"
              >
                Events
              </PrimitiveButton>
              <span className="text-(--text-faint)" aria-hidden="true">
                /
              </span>
              <span
                className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)"
                aria-current="page"
              >
                <StateBadge state={sel.status} hues={EVENT_STATUS_HUES} />
                <span className="truncate mono" title={sel.eventId}>
                  {shortId(sel.eventId)}
                </span>
              </span>
            </nav>
          }
          actions={
            <>
              {canRequeue && (
                <Button
                  variant="primary"
                  disabled={!connected || requeue.isPending}
                  onClick={() => requeue.mutate(sel)}
                >
                  Requeue{" "}
                  <span
                    className="mono ml-1 text-(--text-faint)"
                    aria-hidden="true"
                  >
                    q
                  </span>
                </Button>
              )}
              <div className="flex items-center gap-1.5">
                {onJumpChain && (
                  <Button
                    onClick={() =>
                      onJumpChain(
                        sel.correlationId ?? sel.eventId,
                        `event:${sel.source}:${sel.eventId}`,
                      )
                    }
                  >
                    <span>View chain</span>
                    <span
                      aria-hidden="true"
                      className="mono ml-1 text-(--text-faint) text-xs"
                    >
                      c
                    </span>
                  </Button>
                )}
                <Button
                  disabled={!connected || replay.isPending || replayed}
                  title={
                    replayed
                      ? "Already replayed — select another event to replay again"
                      : undefined
                  }
                  onClick={() => setConfirmReplay(true)}
                >
                  {replay.isPending
                    ? "Replaying…"
                    : replayed
                      ? "Replayed"
                      : "Replay…"}
                </Button>
                <Button
                  disabled={!connected}
                  onClick={() =>
                    onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now()))
                  }
                >
                  Trigger again…
                </Button>
              </div>
            </>
          }
          utility={<CopyActions id={sel.eventId} idLabel="event id" />}
          close={<Button onClick={() => onSelectEvent(null)}>Close</Button>}
        >
          <Section title="Event" icons>
            <KV k="source" v={sel.source} />
            <KV k="type" v={sel.type} />
            <KV k="subject" v={sel.subject} />
            <KV
              k="status"
              v={<StateBadge state={sel.status} hues={EVENT_STATUS_HUES} />}
            />
            {(() => {
              // Why the planner did what it did (WM-594): directly under status,
              // humanized, raw code in the tooltip, references as jump links.
              const d = decisionFor(sel);
              if (!d) return null;
              return (
                <KV
                  k="decision"
                  v={
                    <span
                      className="flex min-w-0 flex-wrap items-baseline gap-1.5 whitespace-normal"
                      data-testid="event-decision"
                      title={d.reason ?? undefined}
                    >
                      <StateBadge
                        state={d.outcome}
                        hues={LIST_STATUS_HUES}
                        dot={false}
                      />
                      {d.outcome === "planned" &&
                        d.status &&
                        d.status !== "approved" && (
                          <span className="text-(--text-faint)">
                            ({d.status})
                          </span>
                        )}
                      {d.reason && (
                        <>
                          <span
                            className="text-(--text-faint)"
                            aria-hidden="true"
                          >
                            ·
                          </span>
                          <ReasonText
                            code={d.reason}
                            onJumpRun={onJumpRun}
                            onJumpProposal={onJumpProposal}
                            className="min-w-0 break-words"
                          />
                        </>
                      )}
                    </span>
                  }
                />
              );
            })()}
            <KV
              k="correlationId"
              v={
                sel.correlationId && onJumpChain ? (
                  <JumpLink
                    onClick={() => onJumpChain(sel.correlationId!)}
                    title="Open chain trace"
                  >
                    {sel.correlationId}
                  </JumpLink>
                ) : (
                  sel.correlationId
                )
              }
            />
            <KV
              k="causationId"
              v={
                sel.causationId ? (
                  <JumpLink
                    onClick={() => onJumpRun(sel.causationId!)}
                    title="The run that emitted this event"
                  >
                    {shortId(sel.causationId)}
                  </JumpLink>
                ) : null
              }
            />
            <KV k="occurredAt" v={<Ago iso={sel.occurredAt} now={now} />} />
            <KV k="receivedAt" v={<Ago iso={sel.receivedAt} now={now} />} />
            <KV k="admittedAt" v={<Ago iso={sel.admittedAt} now={now} />} />
            <KV
              k="proposal"
              v={
                sel.proposalId ? (
                  <JumpLink
                    onClick={() => onJumpProposal(sel.proposalId!)}
                    title={sel.proposalId}
                  >
                    {shortId(sel.proposalId)}
                  </JumpLink>
                ) : null
              }
            />
            <KV
              k="run"
              v={
                sel.runId ? (
                  <JumpLink
                    onClick={() => onJumpRun(sel.runId!)}
                    title={sel.runId}
                  >
                    {shortId(sel.runId)}
                  </JumpLink>
                ) : null
              }
            />
          </Section>

          {(() => {
            const ticket = eventTicket(sel);
            if (!ticket) return null;
            return (
              <TicketDecisionsPanel
                ticket={ticket}
                now={now}
                onJumpRun={onJumpRun}
                onJumpProposal={onJumpProposal}
              />
            );
          })()}

          {(() => {
            if (sel.planFailures <= 0 && !sel.lastPlanError) return null;
            const err = sel.lastPlanError;
            const hue = "var(--hue-err)";
            return (
              <Section title="Planning" icons>
                {sel.planFailures > 0 && (
                  <KV k="planFailures" v={String(sel.planFailures)} />
                )}
                {err && (
                  <div
                    className="mt-1.5 rounded-md px-2.5 py-1.5 text-[12px]"
                    style={{
                      color: hue,
                      background: `color-mix(in oklch, ${hue} 10%, transparent)`,
                    }}
                  >
                    {err}
                  </div>
                )}
              </Section>
            );
          })()}

          <Section title="Envelope">
            <Disclosure label="payload JSON">
              <JsonBlock value={sel.envelope} />
            </Disclosure>
          </Section>

          <VerbError error={requeue.error ?? replay.error} />
        </DetailPane>
      )}

      {confirmReplay && sel && (
        <Dialog
          title={`Replay ${sel.eventId} through intake?`}
          onClose={() => setConfirmReplay(false)}
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Replay re-injects this envelope through intake.
          </div>
          <VerbError error={replay.error} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmReplay(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!connected || replay.isPending || replayed}
              onClick={() => replay.mutate(sel)}
            >
              {replay.isPending
                ? "Replaying…"
                : replayed
                  ? "Replayed"
                  : "Replay"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

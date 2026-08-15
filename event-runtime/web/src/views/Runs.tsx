import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api, ApiError } from "../api";
import { keyGuard, useDisplayOptions, useListKeys, useNow, useTabKeys } from "../hooks";
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
import {
  BudgetClock,
  IN_FLIGHT,
  LeaseClock,
  RunDetailBlocks,
  RunFailureBanner,
  clockTo,
  isCancellable,
  pinnedModelText,
} from "../components/RunDetailBlocks";
import { readPinnedRuns, savePinnedRuns } from "../components/ContextTabs";
import type { OperatorContext } from "../context";
import { matchesInFlight, matchesRepo } from "../context";
import { RUN_FACETS, matchesFilterQuery, parseFilterQuery } from "../filterQuery";
import { decideRevealFilters, formatRevealNotification } from "../reveal";
import type { RunListItem, RunState } from "../types";
import {
  Ago,
  Button,
  Dialog,
  FilterInput,
  ListPane,
  DetailPane,
  JumpLink,
  ListEmpty,
  notify,
  StateBadge,
  STATE_HUES,
  GroupHeaderRow,
  Th,
  VerbError,
  copyText,
  copyLink,
  shortId,
} from "../components/ui";

export type RunTab = "ALL" | "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED";

export const RUN_TABS: readonly RunTab[] = [
  "ALL",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
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
  if (tab === "ACTIVE") return ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(state);
  if (tab === "FAILED") return ["FAILED", "TIMED_OUT", "REFUSED"].includes(state);
  if (tab === "COMPLETED") return state === "COMPLETED";
  if (tab === "CANCELLED") return state === "CANCELLED";
  return true;
}

export function tabForRunState(state: string): RunTab {
  if (["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(state)) return "ACTIVE";
  if (["FAILED", "TIMED_OUT", "REFUSED"].includes(state)) return "FAILED";
  if (state === "COMPLETED") return "COMPLETED";
  if (state === "CANCELLED") return "CANCELLED";
  return "ALL";
}

/**
 * The pinned model as a list cell (WM-221) — the pair to the Agents view's
 * Model column (WM-211), same words for the same facts. The *observed* model
 * is deliberately detail-only: answering it per row means opening one stored
 * transcript per run.
 */
const rowModel = (r: RunListItem) => pinnedModelText(r.adapter, r.model);

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
        "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING",
        "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
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
    { key: "agent", label: "Agent", get: (r) => r.agent, column: "agent" },
    { key: "adapter", label: "Adapter", get: (r) => r.adapter, column: "adapter" },
    { key: "model", label: "Model", get: rowModel, column: "model" },
    { key: "attempts", label: "Attempts", get: (r) => r.attempts, defaultDir: "desc", column: "attempts" },
    { key: "reason", label: "Reason", get: (r) => r.reasonCode ?? "", column: "reason" },
    {
      key: "origin",
      label: "Origin",
      get: (r) => `${r.eventSource ?? ""}:${r.eventId ?? ""}`,
      column: "origin",
    },
    { key: "updated", label: "Updated", get: (r) => r.updated_at, defaultDir: "desc", column: "updated" },
    { key: "created", label: "Created", get: (r) => r.created_at, defaultDir: "desc" },
  ],
  columns: [
    { key: "run", label: "Run", always: true },
    { key: "state", label: "State" },
    { key: "agent", label: "Agent" },
    { key: "adapter", label: "Adapter" },
    { key: "model", label: "Model" },
    { key: "attempts", label: "Attempts" },
    { key: "reason", label: "Reason" },
    { key: "origin", label: "Origin" },
    { key: "updated", label: "Updated" },
  ],
};

function RowDeadlines({ r, now }: { r: RunListItem; now: number }) {
  const { startedAt, leaseExpiresAt, timeoutSeconds = 0 } = r as { startedAt?: string | null; leaseExpiresAt?: string | null; timeoutSeconds?: number };
  const t = startedAt && timeoutSeconds > 0 ? clockTo(startedAt, timeoutSeconds * 1000, now) : null;
  const l = leaseExpiresAt ? clockTo(leaseExpiresAt, 0, now) : null;
  const hasT = t && t.kind !== "off";
  const hasL = l && l.kind !== "off";
  if (!hasT && !hasL) return null;
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums text-(--text-faint)">
      {hasT && <BudgetClock c={t} timeoutSeconds={timeoutSeconds} />}
      {hasT && hasL && <span>·</span>}
      {hasL && <LeaseClock c={l} urgent={t?.kind === "spent"} />}
    </div>
  );
}

const rowWash = (s: string) =>
  s === "FAILED" || s === "TIMED_OUT" ? "row-wash-err" : s === "REFUSED" ? "row-wash-warn" : "";

/** Route raw links rendered by RunDetailBlocks to the deep-linkable artifact inspector. */
export function handleRunArtifactClick(event: ReactMouseEvent<HTMLElement>) {
  const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!target) return;
  const match = (target.getAttribute("href") ?? "").match(/\/api\/artifacts\/([0-9a-f]{64})(?=[?#]|$)/);
  if (!match) return;
  event.preventDefault();
  event.stopPropagation();
  window.location.hash = `#/artifacts/${match[1]}`;
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
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<RunTab>("ALL");
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // A project / In-flight filter is client-side; fetching only the active
  // status tab would make every other tab's badge a factory-wide lie.
  const fetchAll = context.kind !== "all";
  const list = useQuery({
    queryKey: ["runs", fetchAll ? "ALL" : tab],
    queryFn: () => api.runs(),
    refetchInterval: 2000,
  });
  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const rows = list.data?.runs ?? [];
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
    () => (tab === "ALL" ? scoped : scoped.filter((r) => matchesRunTab(r.state, tab))),
    [scoped, tab],
  );
  // `is:stale` is the doctor's projection, not a guess this view makes: a run
  // held by a worker whose heartbeat has gone (lib/workers.mjs stalledWorkers).
  const staleRuns = useMemo(
    () => new Set((statusQ.data?.anomalies.stalledWorkers ?? []).map((w) => w.runId)),
    [statusQ.data],
  );
  const parsed = useMemo(() => parseFilterQuery(filter, RUN_FACETS), [filter]);
  const visible = useMemo(
    () => byTab.filter((r) => matchesFilterQuery(r, parsed, RUN_FACETS, { staleRuns })),
    [byTab, parsed, staleRuns],
  );

  // Display options (OPS-493): partition into sections, order inside them,
  // and feed keyboard navigation only the rows of open sections. Under a
  // single-state tab the empty-group universe narrows to that state — "show
  // empty groups" on the COMPLETED tab must not render ten 0-count bands the
  // tab itself already filtered out.
  const displayConfig = useMemo(
    () =>
      tab === "ALL"
        ? RUNS_DISPLAY
        : {
            ...RUNS_DISPLAY,
            groups: RUNS_DISPLAY.groups.map((g) => (g.key === "state" ? { ...g, order: [tab] } : g)),
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
  const show = useMemo(() => new Set(cols.map((c) => c.key)), [cols]);

  const selectedId = focusRunId;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(() => flat.findIndex((r) => r.runId === selectedId), [flat, selectedId]);

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
      (r) => r.runId === focusRunId && (tab === "ALL" || matchesRunTab(r.state, tab)),
    );
    if (onTab) {
      const latch = pendingReveal.current;
      if (latch && latch.key === focusRunId) {
        pendingReveal.current = null; // decided once
        const isVisible = visible.some((r) => r.runId === focusRunId);
        const currentFilters = { filter };
        const emptyFilters = { filter: "" };
        const decision = decideRevealFilters(latch.snapshot, currentFilters, emptyFilters, isVisible);
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
    () => (selectedId ? (visible.find((r) => r.runId === selectedId) ?? null) : null),
    [visible, selectedId],
  );

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const detail = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api.run(selectedId as string),
    enabled: sel !== null,
    refetchInterval: 2000,
  });

  const invalidate = () => queryClient.invalidateQueries();

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.cancel(id, reason),
    onSuccess: (_, { id }) => {
      invalidate();
      notify(`Cancelled run ${id}`, "info");
      setConfirm(null);
      setCancelReason("");
    },
    onError: invalidate,
  });

  const retry = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.retry(id, force),
    onSuccess: (_, { id, force }) => {
      invalidate();
      notify(`${force ? "Force retried" : "Retried"} run ${id}`, "ok");
      setConfirm(null);
    },
    onError: (err) => {
      invalidate();
      // attempts_exhausted → offer the explicit, recorded override (spec §4.3)
      if (err instanceof ApiError && err.message === "attempts_exhausted") setConfirm("force-retry");
    },
  });

  const byState = statusQ.data?.runs.byState ?? {};
  const tabCount = (t: RunTab) => {
    if (fetchAll) {
      return t === "ALL" ? scoped.length : scoped.filter((r) => matchesRunTab(r.state, t)).length;
    }
    if (t === "ALL") return Object.values(byState).reduce((n, v) => n + (v ?? 0), 0);
    if (t === "ACTIVE")
      return (byState.QUEUED ?? 0) + (byState.LEASED ?? 0) + (byState.RUNNING ?? 0) + (byState.VERIFYING ?? 0);
    if (t === "FAILED") return (byState.FAILED ?? 0) + (byState.TIMED_OUT ?? 0) + (byState.REFUSED ?? 0);
    if (t === "COMPLETED") return byState.COMPLETED ?? 0;
    if (t === "CANCELLED") return byState.CANCELLED ?? 0;
    return 0;
  };

  const selectTab = (t: RunTab) => {
    setTab(t);
    if (selectedId) onSelectRun(null);
  };
  useTabKeys(RUN_TABS, tab, selectTab);

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
      // §5 convention: `x` is the destructive verb on the selection — here, cancel.
      x: () => sel && connected && isCancellable(sel.state) && setConfirm("cancel"),
      c: () => {
        if (!sel) return;
        const now = Date.now();
        if (pendingC.current > 0 && now - pendingC.current < 800) {
          copyText(`bun event-runtime/cli.mjs inspect ${sel.runId}`, "CLI inspect command");
          pendingC.current = 0;
        } else {
          copyText(sel.runId, "run id");
          pendingC.current = now;
        }
      },
      l: () => {
        if (sel && pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          copyLink();
          pendingC.current = 0;
        }
      },
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
          copyText(`bun event-runtime/cli.mjs inspect ${sel.runId}`, "CLI inspect command");
          pendingC.current = 0;
        }
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [sel]);

  const d = detail.data;
  const attemptsExhausted = d ? d.run.attempts >= d.run.spec.maxAttempts : false;

  const pinRun = (id: string) => {
    const cur = readPinnedRuns();
    if (!cur.includes(id)) {
      savePinnedRuns([...cur, id]);
      notify(`Pinned ${id}`, "ok");
    } else {
      notify("Already pinned", "info");
    }
  };

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: "Open in tab", run: () => pinRun(sel.runId) },
        { label: "Open full view", hint: "o", run: () => onOpenFull(sel.runId) },
        { label: "Copy run id", hint: "c", run: () => copyText(sel.runId, "run id") },
        {
          label: "Copy CLI inspect command",
          hint: "c i",
          run: () => copyText(`bun event-runtime/cli.mjs inspect ${sel.runId}`, "CLI inspect command"),
        },
        { label: "Copy link", hint: "c l", run: copyLink },
      ];
      if (!d || !connected) {
        setContextActions(copy);
      } else {
        setContextActions([
          ...(isCancellable(d.run.state)
            ? [{ label: "Cancel run…", hint: "x", run: () => setConfirm("cancel") }]
            : []),
          ...(d.run.state === "FAILED"
            ? [
                attemptsExhausted
                  ? { label: "Force retry run…", run: () => setConfirm("force-retry") }
                  : { label: "Retry run", run: () => retry.mutate({ id: d.run.runId, force: false }) },
              ]
            : []),
          ...copy,
        ]);
      }
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.runId, d?.run.runId, d?.run.state, attemptsExhausted, connected]);

  const handleExport = () => {
    const sorted = sortRows(visible, displayConfig, display);
    const dateStr = new Date().toISOString().slice(0, 10);
    exportJson(`runs-export-${dateStr}.json`, sorted);
    notify(`Exported ${sorted.length} run${sorted.length === 1 ? "" : "s"} to JSON`, "info");
  };

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Runs</h1>

        {/* `flex-wrap`: the token chips are a full-width item, so they take
            their own line under the tabs and the box instead of squeezing them. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* Wrap, never scroll or clip: at 1280px the strip used to run out of
              width at CANCELLED with no scrollbar affordance (WM-96). */}
          <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="tablist" aria-label="Run state">
            {RUN_TABS.map((t, idx) => {
              const count = tabCount(t);
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => selectTab(t)}
                  title={RUN_TAB_TITLES[t]}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium ${
                    tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {RUN_TAB_LABELS[t]}
                  {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
                  <span aria-hidden="true" className="mono ml-1 text-(--text-faint) text-[10px] opacity-70">
                    {idx + 1}
                  </span>
                </button>
              );
            })}
          </div>
          <span className="ml-auto">
            <DisplayOptions
              config={displayConfig}
              state={display}
              onChange={setDisplay}
              onExport={visible.length > 0 ? handleExport : undefined}
              rows={scoped}
            />
          </span>
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="agent:… state:… is:stale"
            label="Filter runs"
            query={parsed}
          />
        </div>
          </>
        }
      >

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {cols.map((c) => {
                const sort = displayConfig.sorts.find((s) => s.column === c.key);
                const isCustom = c.isCustom || c.key.startsWith("custom:");
                const customPath = c.key.replace(/^custom:/, "");
                const isCurrentSort = isCustom ? display.sortBy === c.key : (sort && display.sortBy === sort.key);
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={isCurrentSort ? display.sortDir : null}
                    naturalDir={sort?.defaultDir ?? "asc"}
                    onSort={sort || isCustom ? () => setDisplay((s) => cycleColumnSort(displayConfig, s, c.key)) : undefined}
                    onRemove={isCustom ? () => setDisplay((s) => removeCustomColumn(s, customPath)) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const renderRow = (r: RunListItem) => (
                <tr
                  key={r.runId}
                  onClick={() => onSelectRun(r.runId)}
                  aria-selected={r.runId === selectedId}
                  className={`cursor-pointer hover:bg-(--surface-1) ${rowWash(r.state)} ${r.runId === selectedId ? "row-selected" : ""}`}
                >
                  <td className="mono max-w-28 truncate border-b border-(--border) px-3 py-1.5" title={r.runId}>
                    {shortId(r.runId)}
                  </td>
                  {show.has("state") && (
                    <td className="max-w-32 truncate border-b border-(--border) px-3 py-1.5">
                      <StateBadge state={r.state} />
                      {IN_FLIGHT.includes(r.state) && <RowDeadlines r={r} now={now} />}
                    </td>
                  )}
                  {show.has("agent") && (
                    <td className="max-w-32 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                      <JumpLink
                        onClick={() => onJumpAgent(r.agent)}
                        title={`Open ${r.agent} in Agents`}
                      >
                        {r.agent}
                      </JumpLink>
                    </td>
                  )}
                  {show.has("adapter") && (
                    <td className="max-w-24 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)" title={r.adapter}>
                      {r.adapter}
                    </td>
                  )}
                  {show.has("model") && (
                    <td
                      className="mono max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                      title={
                        rowModel(r) === "n/a"
                          ? `The ${r.adapter} adapter runs a fixed argv, not a model.`
                          : r.model && r.model !== "default"
                            ? `Pinned into the RunSpec at plan time${r.modelTier ? ` from model_tier "${r.modelTier}"` : ""} — open the run for the model it was observed on.`
                            : "This run pinned no model, so the CLI picked — open the run for the one it was observed on."
                      }
                    >
                      {rowModel(r)}
                    </td>
                  )}
                  {show.has("attempts") && (
                    <td className="max-w-16 whitespace-nowrap border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      {r.attempts}/{r.maxAttempts}
                    </td>
                  )}
                  {show.has("reason") && (
                    <td
                      className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                      title={r.reasonCode && r.reasonCode.toLowerCase() !== "ok" ? r.reasonCode : undefined}
                    >
                      {r.reasonCode && r.reasonCode.toLowerCase() !== "ok" ? r.reasonCode : ""}
                    </td>
                  )}
                  {show.has("origin") && (
                    <td
                      className="mono max-w-32 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                      title={r.eventId ?? undefined}
                    >
                      {r.eventId && r.eventSource ? (
                        <JumpLink
                          onClick={() => onJumpEvent(r.eventSource!, r.eventId!)}
                          title={`Open origin event ${r.eventId}`}
                        >
                          {shortId(r.eventId)}
                        </JumpLink>
                      ) : (
                        (r.eventId ? shortId(r.eventId) : "-")
                      )}
                    </td>
                  )}
                  {show.has("updated") && (
                    <td className="max-w-24 whitespace-nowrap border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                      <Ago iso={r.updated_at} now={now} />
                    </td>
                  )}
                  {cols.filter((c) => c.isCustom || c.key.startsWith("custom:")).map((c) => (
                    <CustomCell key={c.key} row={r} path={c.key.replace(/^custom:/, "")} />
                  ))}
                </tr>
              );
              if (!grouped(display)) return sections[0]?.rows.map(renderRow);
              return sections.map((s) => {
                const closed = display.collapsed.includes(s.key);
                return (
                  <Fragment key={s.key}>
                    <GroupHeaderRow
                      colSpan={cols.length}
                      section={s}
                      collapsed={closed}
                      onToggle={() => setDisplay((st) => toggleCollapsed(st, s.key))}
                    />
                    {!closed &&
                      (s.subsections
                        ? s.subsections.map((child) => {
                            const childClosed = display.collapsed.includes(child.key);
                            return (
                              <Fragment key={child.key}>
                                <GroupHeaderRow
                                  colSpan={cols.length}
                                  section={child}
                                  collapsed={childClosed}
                                  onToggle={() => setDisplay((st) => toggleCollapsed(st, child.key))}
                                  sub
                                />
                                {!childClosed && child.rows.map(renderRow)}
                              </Fragment>
                            );
                          })
                        : s.rows.map(renderRow))}
                  </Fragment>
                );
              });
            })()}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={cols.length}
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
                        if (typeof window !== "undefined") window.location.hash = "#/runs";
                      }}
                    >
                      Show all runs
                    </Button>
                  ) : undefined
                }
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[460px]"
          title={
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal">
              <button
                type="button"
                onClick={() => onSelectRun(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to runs list"
              >
                Runs
              </button>
              <span className="text-(--text-faint)" aria-hidden="true">
                /
              </span>
              <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)" aria-current="page">
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
                {d && isCancellable(d.run.state) && (
                  <Button
                    variant="danger"
                    disabled={!connected || cancel.isPending}
                    onClick={() => setConfirm("cancel")}
                  >
                    Cancel <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">x</span>
                  </Button>
                )}
                {d && d.run.state === "FAILED" && (
                  attemptsExhausted ? (
                    <Button disabled={!connected} onClick={() => setConfirm("force-retry")}>
                      Force retry…
                    </Button>
                  ) : (
                    <Button
                      disabled={!connected || retry.isPending}
                      onClick={() => retry.mutate({ id: d.run.runId, force: false })}
                    >
                      Retry
                    </Button>
                  )
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button onClick={() => onOpenFull(sel.runId)}>
                  Expand <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">o</span>
                </Button>
                <Button onClick={() => pinRun(sel.runId)}>Open in tab</Button>
              </div>
            </>
          }
          utility={
            <>
              <span>copy:</span>
              <button
                type="button"
                onClick={() => copyText(sel.runId, "run id")}
                className="cursor-pointer hover:text-(--text)"
              >
                id <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c</span>
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => copyText(`bun event-runtime/cli.mjs inspect ${sel.runId}`, "CLI inspect command")}
                className="cursor-pointer hover:text-(--text)"
              >
                CLI <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c i</span>
              </button>
              <span>·</span>
              <button type="button" onClick={copyLink} className="cursor-pointer hover:text-(--text)">
                link <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c l</span>
              </button>
            </>
          }
          close={<Button onClick={() => onSelectRun(null)}>Close</Button>}
        >

          {!d && (
            <div className="text-(--text-faint)">{detail.isError ? "Could not load run detail." : "Loading run…"}</div>
          )}

          {d && (
            <>
          <RunFailureBanner state={d.run.state} lifecycle={d.lifecycle} />
          <div onClickCapture={handleRunArtifactClick}>
            <RunDetailBlocks
              d={d}
              now={now}
              connected={connected}
              origin={sel}
              onJumpAgent={onJumpAgent}
              onJumpEvent={onJumpEvent}
              onCancel={() => setConfirm("cancel")}
              onRetry={() => retry.mutate({ id: d.run.runId, force: false })}
              onForceRetry={() => setConfirm("force-retry")}
              retryPending={retry.isPending}
              verbError={cancel.error ?? (confirm === "force-retry" ? null : retry.error)}
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
          </div>
            </>
          )}
        </DetailPane>
      )}

      {confirm === "cancel" && d && (
        <Dialog title={`Cancel ${d.run.runId}?`} onClose={() => setConfirm(null)}>
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
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Keep run</Button>
            <Button
              variant="danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ id: d.run.runId, reason: cancelReason.trim() || undefined })}
            >
              Cancel run
            </Button>
          </div>
        </Dialog>
      )}

      {confirm === "force-retry" && d && (
        <Dialog title="Retry past attempt budget?" onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Used {d.run.attempts}/{d.run.spec.maxAttempts} attempts. Forcing retry is recorded as an operator override.
          </div>
          <VerbError error={retry.error} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Leave it</Button>
            <Button
              variant="primary"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ id: d.run.runId, force: true })}
            >
              Force retry
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

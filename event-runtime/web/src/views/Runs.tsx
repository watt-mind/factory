import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useDisplayOptions, useListKeys, useNow, useTabKeys } from "../hooks";
import {
  buildSections,
  cycleColumnSort,
  flattenSections,
  grouped,
  sortRows,
  toggleCollapsed,
  visibleColumns,
  type DisplayConfig,
} from "../displayOptions";
import { DisplayOptions, exportJson } from "../components/DisplayOptions";
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

const STATE_TABS: (RunState | "ALL")[] = [
  "ALL", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
];
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
    { key: "created", label: "Created", get: (r) => r.created_at, defaultDir: "desc", column: "created" },
    { key: "updated", label: "Updated", get: (r) => r.updated_at, defaultDir: "desc", column: "updated" },
    { key: "agent", label: "Agent", get: (r) => r.agent, column: "agent" },
    { key: "attempts", label: "Attempts", get: (r) => r.attempts, defaultDir: "desc", column: "attempts" },
    { key: "model", label: "Model", get: rowModel, column: "model" },
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
  const [tab, setTab] = useState<(typeof STATE_TABS)[number]>("ALL");
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // A project / In-flight filter is client-side; fetching only the active
  // status tab would make every other tab's badge a factory-wide lie.
  const fetchAll = context.kind !== "all";
  const list = useQuery({
    queryKey: ["runs", fetchAll ? "ALL" : tab],
    queryFn: () => api.runs(fetchAll || tab === "ALL" ? undefined : tab),
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
    () => (!fetchAll || tab === "ALL" ? scoped : scoped.filter((r) => r.state === tab)),
    [fetchAll, scoped, tab],
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
      (r) => r.runId === focusRunId && (!fetchAll || tab === "ALL" || r.state === tab),
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
    if (focusState && (STATE_TABS as readonly string[]).includes(focusState)) {
      setTab(focusState as (typeof STATE_TABS)[number]);
      onFocusStateConsumed();
    } else if (focusState) {
      onFocusStateConsumed();
    }
  }, [focusState, onFocusStateConsumed]);

  // In flight is LEASED+RUNNING; a COMPLETED (etc.) status tab would be empty.
  useEffect(() => {
    if (context.kind !== "inflight") return;
    setTab((t) => (t === "LEASED" || t === "RUNNING" || t === "ALL" ? t : "ALL"));
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

  const selectTab = (t: (typeof STATE_TABS)[number]) => {
    setTab(t);
    if (selectedId) onSelectRun(null);
  };
  useTabKeys(STATE_TABS, tab, selectTab);

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
      c: () => sel && copyText(sel.runId, "run id"),
    },
  });

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
        { label: "Copy link", run: copyLink },
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
            {STATE_TABS.map((t) => {
              const byState = statusQ.data?.runs.byState ?? {};
              const count = fetchAll
                ? t === "ALL"
                  ? scoped.length
                  : scoped.filter((r) => r.state === t).length
                : t === "ALL"
                  ? Object.values(byState).reduce((n, v) => n + (v ?? 0), 0)
                  : (byState[t] ?? 0);
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => selectTab(t)}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium ${
                    tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {t === "ALL" ? "All" : t}
                  {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
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
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={sort && display.sortBy === sort.key ? display.sortDir : null}
                    naturalDir={sort?.defaultDir}
                    onSort={sort ? () => setDisplay((s) => cycleColumnSort(displayConfig, s, c.key)) : undefined}
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
                  <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5" title={r.runId}>
                    {shortId(r.runId)}
                  </td>
                  {show.has("state") && (
                    <td className="border-b border-(--border) px-3 py-1.5">
                      <StateBadge state={r.state} />
                      {IN_FLIGHT.includes(r.state) && <RowDeadlines r={r} now={now} />}
                    </td>
                  )}
                  {show.has("agent") && (
                    <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                      <JumpLink
                        onClick={() => onJumpAgent(r.agent)}
                        title={`Open ${r.agent} in Agents`}
                      >
                        {r.agent}
                      </JumpLink>
                    </td>
                  )}
                  {show.has("adapter") && (
                    <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{r.adapter}</td>
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
                    <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      {r.attempts}/{r.maxAttempts}
                    </td>
                  )}
                  {show.has("reason") && (
                    <td
                      className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                      title={r.reasonCode ?? undefined}
                    >
                      {r.reasonCode ?? "-"}
                    </td>
                  )}
                  {show.has("origin") && (
                    <td
                      className="mono max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                      title={r.eventId ?? undefined}
                    >
                      {r.eventId && r.eventSource ? (
                        <JumpLink
                          onClick={() => onJumpEvent(r.eventSource!, r.eventId!)}
                          title={`Open origin event ${r.eventId}`}
                        >
                          {r.eventId}
                        </JumpLink>
                      ) : (
                        (r.eventId ?? "-")
                      )}
                    </td>
                  )}
                  {show.has("updated") && (
                    <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                      <Ago iso={r.updated_at} now={now} />
                    </td>
                  )}
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
                filtered={scoped.length > 0}
                noun="runs"
                empty={
                  context.kind === "inflight"
                    ? "No runs in flight."
                    : context.kind === "repo"
                      ? `No runs for ${context.name}.`
                      : tab === "ALL"
                        ? "No runs."
                        : `No ${tab} runs.`
                }
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
              <Button onClick={() => pinRun(sel.runId)}>Open in tab</Button>
              <Button onClick={() => onOpenFull(sel.runId)}>
                Expand <span className="mono ml-1 opacity-70">o</span>
              </Button>
              <Button onClick={() => copyText(sel.runId, "run id")}>Copy id</Button>
              <Button onClick={() => copyText(`bun event-runtime/cli.mjs inspect ${sel.runId}`, "CLI inspect command")}>
                Copy CLI
              </Button>
              <Button onClick={copyLink}>Copy link</Button>
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

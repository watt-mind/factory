import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { keyGuard, useDisplayOptions, useListKeys, useNow, useTabKeys } from "../hooks";
import { goPrefixActive } from "../goSequence";
import {
  buildSections,
  cycleColumnSort,
  flattenSections,
  grouped,
  removeCustomColumn,
  toggleCollapsed,
  visibleColumns,
  type DisplayConfig,
} from "../displayOptions";
import { DisplayOptions } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import { setContextActions } from "../palette";
import type { Worker, WorkerCapacity } from "../types";
import type { OperatorContext } from "../context";
import {
  dur,
  heartbeatHue,
  heartbeatOf,
  HEARTBEAT_STALE_MS,
  isOverdue,
  type Heartbeat,
} from "../heartbeat";
import { ScopeCaption } from "../components/ContextTabs";
import {
  Ago,
  Button,
  DetailPane,
  FilterInput,
  JsonBlock,
  JumpLink,
  KV,
  ListEmpty,
  ListPane,
  GroupHeaderRow,
  Section,
  StateBadge,
  Th,
  copyLink,
  copyText,
  shortId,
} from "../components/ui";
import { health, WORKER_HUES } from "../workerHealth";

export const WORKER_TABS = ["ALL", "LIVE", "STOPPED"] as const;
export type WorkerTab = (typeof WORKER_TABS)[number];
export type WorkerDisplayState = ReturnType<typeof health> | "draining";

const WORKER_STATE_HUES: Record<WorkerDisplayState, string> = {
  ...WORKER_HUES,
  draining: "var(--hue-warn)",
};

/** Stale remains the strongest signal; otherwise a drain request is explicit. */
export const workerDisplayState = (worker: Worker): WorkerDisplayState =>
  worker.stale ? "stale" : worker.draining && worker.state !== "stopped" ? "draining" : health(worker);

/** Compatibility projection for an older API that has not added capacity yet. */
export function capacityFromWorkers(rows: Worker[]): WorkerCapacity {
  const live = rows.filter((worker) => worker.state !== "stopped" && !worker.stale);
  const running = live.filter((worker) => worker.state === "busy").length;
  const draining = live.filter((worker) => worker.draining).length;
  return {
    running,
    capacity: live.length,
    queued: 0,
    live: live.length,
    idle: live.filter((worker) => worker.state !== "busy" && !worker.draining).length,
    draining,
    target: Math.max(0, live.length - draining),
    min: null,
    max: null,
    supervisor: "absent",
    source: "live-workers",
    limitingFactor: null,
    classes: [],
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}

/**
 * Live = anything that could still be holding or claiming work: idle, busy, or
 * stale. Stale belongs here, not with stopped — a stale worker is a problem to
 * look at, while a cleanly stopped one is history.
 */
export const isLive = (w: Worker) => health(w) !== "stopped";

export type FleetBanner =
  | { kind: "empty" }
  | { kind: "all-stopped"; count: number }
  | { kind: "stale"; stale: number; stopped: number };

/**
 * Banner that agrees with `isLive` / the Live tab. Stale workers are live
 * (they may still hold a run), so a stale-only fleet is not “no live workers”.
 * Returns null when at least one idle/busy worker can claim work.
 */
export function fleetBanner(rows: Worker[]): FleetBanner | null {
  if (rows.length === 0) return { kind: "empty" };
  let stale = 0;
  let stopped = 0;
  let claiming = 0;
  for (const w of rows) {
    const h = health(w);
    if (h === "stale") stale += 1;
    else if (h === "stopped") stopped += 1;
    else claiming += 1;
  }
  if (claiming > 0) return null;
  if (stale > 0) return { kind: "stale", stale, stopped };
  return { kind: "all-stopped", count: stopped };
}

/** Split the registry into live and stopped, preserving order within each group. */
export function partitionWorkers(rows: Worker[]): { live: Worker[]; stopped: Worker[] } {
  const live: Worker[] = [];
  const stopped: Worker[] = [];
  for (const w of rows) (isLive(w) ? live : stopped).push(w);
  return { live, stopped };
}

/**
 * The list opens on the workers that matter: live ones when any exist. A fleet
 * that is all history (or empty) opens on All, so the page never looks blank
 * while stopped workers hide behind a tab.
 */
export const defaultWorkerTab = (rows: Worker[]): WorkerTab =>
  rows.some(isLive) ? "LIVE" : "ALL";

/** Grouping/ordering/columns for the fleet table (OPS-493). */
const WORKERS_DISPLAY: DisplayConfig<Worker> = {
  view: "workers",
  groups: [
    {
      key: "state",
      label: "State",
      get: workerDisplayState,
      order: ["busy", "draining", "idle", "stale", "stopped"],
      hue: WORKER_STATE_HUES,
    },
    { key: "host", label: "Host", get: (w) => w.host },
  ],
  subGroups: ["host", "state"],
  sorts: [
    { key: "worker", label: "Worker", get: (w) => w.workerId, column: "worker" },
    { key: "host", label: "Host", get: (w) => w.host, column: "host" },
    { key: "pid", label: "PID", get: (w) => w.pid, column: "pid" },
    { key: "state", label: "State", get: workerDisplayState, column: "state" },
    { key: "labels", label: "Labels", get: (w) => labelText(w.labels), column: "labels" },
    { key: "adapters", label: "Adapters", get: (w) => w.adapters.join(", "), column: "adapters" },
    { key: "run", label: "Current run", get: (w) => w.currentRun ?? "", column: "run" },
    { key: "started", label: "Started", get: (w) => w.startedAt ?? "", defaultDir: "desc", column: "uptime" },
    { key: "lastSeen", label: "Last seen", get: (w) => w.lastSeen ?? "", defaultDir: "desc", column: "heartbeat" },
  ],
  columns: [
    { key: "worker", label: "Worker", always: true },
    { key: "host", label: "Host" },
    { key: "pid", label: "PID" },
    { key: "state", label: "State" },
    { key: "labels", label: "Labels" },
    { key: "adapters", label: "Adapters" },
    { key: "run", label: "Current run" },
    { key: "uptime", label: "Uptime" },
    { key: "heartbeat", label: "Heartbeat" },
  ],
};

/**
 * The distance to the stale threshold, worded the same way in the row and the
 * detail pane so an operator only has to learn one phrase. The countdown is local
 * arithmetic and the verdict is the server's, so a spent window says `overdue`
 * rather than counting down to a self-contradicting `stale in 0:00`: the badge
 * catches up on the next poll, and until it does nothing here calls a worker dead
 * a second before the runtime does.
 */
function StaleClock({ hb, className }: { hb: Heartbeat; className?: string }) {
  const windowLabel = `${HEARTBEAT_STALE_MS / 1000}s`;
  if (hb.kind === "none")
    return (
      <span
        className={`text-(--text-faint) ${className ?? ""}`}
        title="A cleanly stopped worker stops checking in on purpose, so it is never marked stale."
      >
        heartbeat off
      </span>
    );
  const hue = heartbeatHue(hb);
  if (hb.kind === "stale")
    return (
      <span
        className={className}
        style={{ color: hue }}
        title={`No check-in for ${dur(hb.overdueMs)} longer than the ${windowLabel} window allows.`}
      >
        stale for {dur(hb.overdueMs)}
      </span>
    );
  if (isOverdue(hb))
    return (
      <span
        className={className}
        style={{ color: hue }}
        title={`The ${windowLabel} window is spent — the runtime marks this worker stale on its next read.`}
      >
        overdue
      </span>
    );
  return (
    <span
      className={className}
      style={{ color: hue }}
      title={`Goes stale unless this worker checks in within ${dur(hb.remainingMs)} (${windowLabel} window).`}
    >
      stale in {dur(hb.remainingMs)}
    </span>
  );
}

/** Age and countdown on one line: in a 90s window neither number means much alone. */
function HeartbeatCell({ w, now }: { w: Worker; now: number }) {
  const hb = heartbeatOf(w, now);
  return (
    <>
      <span style={{ color: heartbeatHue(hb) }}>
        <Ago iso={w.lastSeen} now={now} />
      </span>
      <span className="px-1.5">·</span>
      <StaleClock hb={hb} className="text-[11px]" />
    </>
  );
}

/** How much of the window is spent — the glance; `StaleClock` is the number. */
function HeartbeatMeter({ hb }: { hb: Heartbeat }) {
  if (hb.kind === "none") return null;
  const spent = hb.kind === "stale" ? 1 : 1 - hb.remainingMs / HEARTBEAT_STALE_MS;
  return (
    <div className="mt-2 h-1 overflow-hidden rounded-full bg-(--surface-2)" aria-hidden="true">
      <div
        className="h-full rounded-full transition-[width,background-color] duration-1000 ease-linear"
        style={{ width: `${Math.min(100, Math.max(2, spent * 100))}%`, background: heartbeatHue(hb) ?? "var(--hue-ok)" }}
      />
    </div>
  );
}

const labelText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "-";

/** Runs already own `#/runs/:id`; the fleet is a way in, not a second router. */
const openRun = (runId: string) => {
  window.location.hash = `#/runs/${runId}`;
};

export function CapacityBand({ capacity }: { capacity: WorkerCapacity }) {
  const constrained = capacity.queued > 0 && capacity.limitingFactor;
  const hue = constrained ? "var(--hue-warn)" : "var(--hue-ok)";
  return (
    <section
      aria-label="Worker pool capacity"
      className="mb-3 rounded-lg border border-(--border) bg-(--surface-1) px-3.5 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="display text-xl font-semibold tabular-nums" style={{ color: hue }}>
            {capacity.running} running / {capacity.capacity} capacity
          </span>
          <span className="mono text-[12px] text-(--text-dim)">
            {capacity.queued} queued run{capacity.queued === 1 ? "" : "s"}
          </span>
        </div>
        <span className="text-[11px] text-(--text-faint)">
          {capacity.live} live · {capacity.idle} idle
          {capacity.draining > 0 ? ` · ${capacity.draining} draining` : ""}
          {capacity.source === "worker-policy"
            ? ` · target ${capacity.target} · supervisor active`
            : ` · ${capacity.supervisor === "stopped" ? "supervisor stopped · " : ""}live-worker fallback${capacity.max != null ? ` · policy max ${capacity.max}` : ""}`}
        </span>
      </div>
      {constrained && (
        <div className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: hue }}>
          <span className="size-1.5 rounded-full" style={{ background: hue }} />
          <span>
            Queue is waiting: <strong>{capacity.limitingFactor}</strong>
          </span>
        </div>
      )}
      {capacity.classes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Worker class capacity">
          {capacity.classes.map((workerClass) => (
            <span key={workerClass.name} className="mono rounded-full bg-(--surface-2) px-2 py-0.5 text-[11px] text-(--text-dim)">
              {workerClass.name} {workerClass.running}/{workerClass.capacity}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function FleetStatusBanner({ banner }: { banner: FleetBanner }) {
  const hue = banner.kind === "stale" ? "var(--hue-err)" : "var(--hue-warn)";
  const title =
    banner.kind === "empty"
      ? "No workers registered"
      : banner.kind === "all-stopped"
        ? "All workers are stopped"
        : "Workers are stale";
  const lead =
    banner.kind === "empty"
      ? "No workers have registered with the runtime."
      : banner.kind === "all-stopped"
        ? `${banner.count} registered worker${banner.count === 1 ? " is" : "s are"} stopped.`
        : `${banner.stale} worker${banner.stale === 1 ? "" : "s"} missed the heartbeat window${
            banner.stopped > 0 ? ` (${banner.stopped} stopped)` : ""
          } and may still hold a run.`;
  return (
    <div
      className="mb-3 rounded-md border p-3 text-[12px]"
      style={{
        color: hue,
        borderColor: hue,
        background: `color-mix(in oklch, ${hue} 8%, var(--surface-1))`,
      }}
    >
      <div className="flex items-center gap-2 font-semibold">
        <span
          className={`size-2 shrink-0 rounded-full ${banner.kind === "stale" ? "" : "motion-safe:animate-pulse"}`}
          style={{ background: hue }}
        />
        <span>{title}</span>
      </div>
      <div className="mt-1 text-(--text-dim)">
        {lead}{" "}
        Queued runs will remain waiting until a worker is started with{" "}
        <code className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-[11px] text-(--text)">
          bun event-runtime/cli.mjs work
        </code>
        .
      </div>
    </div>
  );
}

/**
 * Workers — the registry the CLI `workers` command prints, made legible. The
 * question this view answers is who could claim the next run and who only
 * looks like they could: a worker whose heartbeat has gone stale still reports
 * `busy` and still holds a run, and that gap is the whole point of the column.
 */
export function Workers({
  context,
  focusWorkerId,
  onSelectWorker,
}: {
  context: OperatorContext;
  focusWorkerId: string | null;
  onSelectWorker: (id: string | null) => void;
}) {
  const now = useNow();
  const query = useQuery({ queryKey: ["workers"], queryFn: api.workers, refetchInterval: 2000 });
  // GET /workers gained capacity without changing the legacy client method's
  // minimum response contract; older servers simply exercise the fallback.
  const response = query.data as ({ workers: Worker[]; capacity?: WorkerCapacity } | undefined);
  const rows = response?.workers ?? [];
  const capacity = response?.capacity ?? capacityFromWorkers(rows);

  const parts = useMemo(() => partitionWorkers(rows), [rows]);
  const banner = useMemo(() => fleetBanner(rows), [rows]);

  // `null` = no explicit choice yet: follow the data (live when any worker is
  // live). The first click pins the tab and the default stops moving under it.
  const [tabChoice, setTabChoice] = useState<WorkerTab | null>(null);
  const tab = tabChoice ?? defaultWorkerTab(rows);
  useTabKeys(WORKER_TABS, tab, setTabChoice);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (isTypingTarget(e.target)) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= WORKER_TABS.length) {
        e.preventDefault();
        setTabChoice(WORKER_TABS[num - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Live before stopped regardless of recency; within a group the registry's
  // own order stands. Display Options grouping/sorting (OPS-493) applies on
  // top of whatever the active tab lets through.
  const byTab = useMemo(
    () =>
      tab === "ALL" ? [...parts.live, ...parts.stopped] : tab === "LIVE" ? parts.live : parts.stopped,
    [tab, parts],
  );

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter((w) =>
      [w.workerId, w.host, String(w.pid), workerDisplayState(w), labelText(w.labels), w.adapters.join(","), w.currentRun].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [byTab, filter]);

  // Display options (OPS-493): partition into sections, order inside them,
  // and feed keyboard navigation only the rows of open sections.
  const [display, setDisplay] = useDisplayOptions(WORKERS_DISPLAY);
  const sections = useMemo(
    () => buildSections(visible, WORKERS_DISPLAY, display),
    [visible, display],
  );
  const flat = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(WORKERS_DISPLAY, display);
  const show = useMemo(() => new Set(cols.map((c) => c.key)), [cols]);

  const selectedId = focusWorkerId;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(
    () => flat.findIndex((w) => w.workerId === selectedId),
    [flat, selectedId],
  );
  const sel = useMemo(
    () => (selectedId ? (visible.find((w) => w.workerId === selectedId) ?? null) : null),
    [visible, selectedId],
  );
  const selHeartbeat: Heartbeat = sel ? heartbeatOf(sel, now) : { kind: "none" };

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusWorkerId) setFilter("");
  }, [focusWorkerId]);

  // Deep link / jump: reveal a focused worker the active tab hides, once per
  // focus id, so the jump lands without overriding a tab the operator picks later.
  const jumpedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusWorkerId || jumpedFor.current === focusWorkerId) return;
    const w = rows.find((r) => r.workerId === focusWorkerId);
    if (!w) return;
    jumpedFor.current = focusWorkerId;
    if (tab !== "ALL" && (tab === "LIVE") !== isLive(w)) setTabChoice("ALL");
  }, [focusWorkerId, rows, tab]);

  const pendingC = useRef<number>(0);

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectWorker(flat[i]?.workerId ?? null),
    onClose: () => {
      if (selectedId) onSelectWorker(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => {
        if (!sel) return;
        copyText(sel.workerId, "worker id");
        pendingC.current = Date.now();
      },
      l: () => {
        if (sel && pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          copyLink();
          pendingC.current = 0;
        }
      },
      o: () => sel?.currentRun && openRun(sel.currentRun),
    },
  });

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      setContextActions([
        { label: `Copy ${sel.workerId}`, hint: "c", run: () => copyText(sel.workerId, "worker id") },
        ...(sel.currentRun
          ? [{ label: `Open run ${sel.currentRun}`, hint: "o", run: () => openRun(sel.currentRun!) }]
          : []),
        { label: "Copy link to this worker", hint: "c l", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.workerId, sel?.currentRun]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-lg font-semibold">Workers</h1>
            <ScopeCaption context={context} surface="fleet" />
            {query.isSuccess && <CapacityBand capacity={capacity} />}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Worker state">
                {WORKER_TABS.map((t, idx) => {
                  const count =
                    t === "ALL" ? rows.length : t === "LIVE" ? parts.live.length : parts.stopped.length;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      onClick={() => setTabChoice(t)}
                      title={t === "LIVE" ? "idle, busy, or stale" : t === "STOPPED" ? "cleanly stopped — history" : undefined}
                      className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium ${
                        tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                      }`}
                    >
                      {t === "ALL" ? "All" : t === "LIVE" ? "Live" : "Stopped"}
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
                  config={WORKERS_DISPLAY}
                  state={display}
                  onChange={setDisplay}
                  rows={byTab}
                />
              </span>
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter worker, host, label, adapter…"
                label="Filter workers"
              />
            </div>
            {query.isSuccess && banner && <FleetStatusBanner banner={banner} />}
          </>
        }
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {cols.map((c) => {
                const sort = WORKERS_DISPLAY.sorts.find((s) => s.column === c.key);
                const isCustom = c.isCustom || c.key.startsWith("custom:");
                const customPath = c.key.replace(/^custom:/, "");
                const isCurrentSort = isCustom ? display.sortBy === c.key : (sort && display.sortBy === sort.key);
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={isCurrentSort ? display.sortDir : null}
                    naturalDir={sort?.defaultDir ?? "asc"}
                    onSort={sort || isCustom ? () => setDisplay((s) => cycleColumnSort(WORKERS_DISPLAY, s, c.key)) : undefined}
                    onRemove={isCustom ? () => setDisplay((s) => removeCustomColumn(s, customPath)) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const renderRow = (w: Worker) => (
                <tr
                  key={w.workerId}
                  onClick={() => onSelectWorker(w.workerId)}
                  aria-selected={w.workerId === selectedId}
                  className={`cursor-pointer hover:bg-(--surface-1) ${w.stale ? "row-wash-err" : ""} ${
                    !isLive(w) ? "opacity-55" : ""
                  } ${w.workerId === selectedId ? "row-selected" : ""}`}
                >
                  <td
                    className={`mono max-w-52 truncate border-b border-(--border) px-3 py-1.5 ${
                      w.state === "stopped" && !w.stale ? "text-(--text-faint)" : ""
                    }`}
                    title={w.workerId}
                  >
                    {w.workerId}
                  </td>
                  {show.has("host") && (
                    <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{w.host}</td>
                  )}
                  {show.has("pid") && (
                    <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-faint)">{w.pid}</td>
                  )}
                  {show.has("state") && (
                    <td className="border-b border-(--border) px-3 py-1.5">
                      <span className="flex items-baseline gap-1.5">
                        <StateBadge state={workerDisplayState(w)} hues={WORKER_STATE_HUES} />
                        {w.stale && (
                          <span className="text-[11px] text-(--text-faint)" title="What the worker last reported before its heartbeat stopped">
                            reported {w.state}
                          </span>
                        )}
                      </span>
                    </td>
                  )}
                  {show.has("labels") && (
                    <td className="max-w-48 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)" title={labelText(w.labels)}>
                      {labelText(w.labels)}
                    </td>
                  )}
                  {show.has("adapters") && (
                    <td
                      className="max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                      title={w.adapters.length > 0 ? w.adapters.join(", ") : undefined}
                    >
                      {w.adapters.join(", ") || "-"}
                    </td>
                  )}
                  {show.has("run") && (
                    <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                      {w.currentRun ? (
                        <JumpLink onClick={() => openRun(w.currentRun!)} title={`Open ${w.currentRun}`}>
                          {shortId(w.currentRun)}
                        </JumpLink>
                      ) : (
                        "-"
                      )}
                    </td>
                  )}
                  {show.has("uptime") && (
                    <td
                      className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap tabular-nums text-(--text-faint)"
                      title={`Started ${w.startedAt}`}
                    >
                      <Ago iso={w.startedAt} now={now} />
                    </td>
                  )}
                  {show.has("heartbeat") && (
                    <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap tabular-nums text-(--text-faint)">
                      <HeartbeatCell w={w} now={now} />
                    </td>
                  )}
                  {cols.filter((c) => c.isCustom || c.key.startsWith("custom:")).map((c) => (
                    <CustomCell key={c.key} row={w} path={c.key.replace(/^custom:/, "")} />
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
                query={query}
                filtered={rows.length > 0}
                noun="workers"
                empty="No workers have registered — start one with bun event-runtime/cli.mjs work"
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[460px]"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <StateBadge state={workerDisplayState(sel)} hues={WORKER_STATE_HUES} />
              <span className="mono truncate" title={sel.workerId}>
                {sel.workerId}
              </span>
            </span>
          }
          actions={
            sel.currentRun ? (
              <Button onClick={() => openRun(sel.currentRun!)}>
                Open run <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">o</span>
              </Button>
            ) : undefined
          }
          utility={
            <>
              <span>copy:</span>
              <button
                type="button"
                onClick={() => copyText(sel.workerId, "worker id")}
                className="cursor-pointer hover:text-(--text)"
              >
                id <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c</span>
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={copyLink}
                className="cursor-pointer hover:text-(--text)"
              >
                link <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c l</span>
              </button>
            </>
          }
          close={<Button onClick={() => onSelectWorker(null)}>Close</Button>}
        >
          {selHeartbeat.kind === "stale" && (
            <div
              className="mb-4 rounded-md px-2.5 py-1.5 text-[12px]"
              style={{
                color: "var(--hue-err)",
                background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
              }}
            >
              Heartbeat went stale {dur(selHeartbeat.overdueMs)} ago — this process is gone, whatever it last reported
              {sel.currentRun ? ` (it still holds ${sel.currentRun}; the run is reclaimed when its lease expires)` : ""}.
            </div>
          )}

          <Section title="Heartbeat" card={false}>
            <div className="rounded-md border border-(--border) px-3 py-2 tabular-nums">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-(--text-faint)">
                  last check-in <Ago iso={sel.lastSeen} now={now} className="text-(--text-dim)" />
                </span>
                <StaleClock hb={selHeartbeat} />
              </div>
              <HeartbeatMeter hb={selHeartbeat} />
              {selHeartbeat.kind !== "none" && (
                <div className="mt-2 text-[11px] text-(--text-faint)">
                  A worker that has not checked in for {HEARTBEAT_STALE_MS / 1000}s is treated as gone, whatever its
                  last reported state was.
                </div>
              )}
            </div>
          </Section>

          <Section title="Process">
            <KV k="workerId" v={sel.workerId} />
            <KV k="host" v={sel.host} />
            <KV k="pid" v={String(sel.pid)} />
            <KV
              k="state"
              v={
                <span style={{ color: WORKER_STATE_HUES[workerDisplayState(sel)] ?? "var(--hue-idle)" }}>
                  {workerDisplayState(sel)}
                  {sel.stale ? ` (last reported ${sel.state})` : ""}
                </span>
              }
            />
            <KV
              k="currentRun"
              v={
                sel.currentRun ? (
                  <JumpLink onClick={() => openRun(sel.currentRun!)} title={`Open ${sel.currentRun}`}>
                    {shortId(sel.currentRun)}
                  </JumpLink>
                ) : (
                  "-"
                )
              }
            />
            <KV k="startedAt" v={<Ago iso={sel.startedAt} now={now} />} />
            {sel.stoppedAt && <KV k="stoppedAt" v={<Ago iso={sel.stoppedAt} now={now} />} />}
          </Section>

          <Section title="Adapters" card={false}>
            {sel.adapters.length === 0 ? (
              <div className="text-(--text-faint)">No adapters declared — this worker claims nothing.</div>
            ) : (
              <div className="rounded-md border border-(--border) px-3 py-1">
                {sel.adapters.map((a) => (
                  <div key={a} className="mono border-b border-(--border) py-1.5 last:border-0">
                    {a}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Labels" card={false}>
            <div className="mb-1.5 text-[11px] text-(--text-faint)">
              Placement labels the worker declared at registration — what a run&apos;s placement
              constraints are matched against.
            </div>
            <JsonBlock value={sel.labels} />
          </Section>
        </DetailPane>
      )}
    </div>
  );
}

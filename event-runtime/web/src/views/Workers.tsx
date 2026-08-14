import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useDisplayOptions, useListKeys, useNow } from "../hooks";
import {
  buildSections,
  cycleColumnSort,
  flattenSections,
  grouped,
  toggleCollapsed,
  visibleColumns,
  type DisplayConfig,
} from "../displayOptions";
import { DisplayOptions } from "../components/DisplayOptions";
import { setContextActions } from "../palette";
import type { Worker } from "../types";
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
} from "../components/ui";

/** Four mutually exclusive tokens; `stale` is the loudest because it is a lie detector. */
const WORKER_HUES: Record<string, string> = {
  idle: "var(--hue-ok)",
  busy: "var(--hue-warn)",
  stopped: "var(--hue-idle)",
  stale: "var(--hue-err)",
};

/**
 * A stale heartbeat outranks whatever the row claims: a stale busy worker is
 * gone, not busy. `listWorkers` never marks a cleanly stopped worker stale, so
 * these four are disjoint.
 */
const health = (w: Worker) => (w.stale ? "stale" : w.state);

/** Grouping/ordering/columns for the fleet table (OPS-493). */
const WORKERS_DISPLAY: DisplayConfig<Worker> = {
  view: "workers",
  groups: [
    {
      key: "state",
      label: "State",
      get: health,
      order: ["busy", "idle", "stale", "stopped"],
      hue: WORKER_HUES,
    },
    { key: "host", label: "Host", get: (w) => w.host },
  ],
  subGroups: ["host", "state"],
  sorts: [
    { key: "lastSeen", label: "Last seen", get: (w) => w.lastSeen ?? "", defaultDir: "desc", column: "heartbeat" },
    { key: "host", label: "Host", get: (w) => w.host, column: "host" },
    { key: "started", label: "Started", get: (w) => w.startedAt ?? "", defaultDir: "desc" },
  ],
  columns: [
    { key: "worker", label: "Worker", always: true },
    { key: "host", label: "Host" },
    { key: "pid", label: "PID" },
    { key: "state", label: "State" },
    { key: "labels", label: "Labels" },
    { key: "adapters", label: "Adapters" },
    { key: "run", label: "Current run" },
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
  const rows = query.data?.workers ?? [];

  const liveCount = useMemo(
    () => rows.filter((w) => !w.stale && w.state !== "stopped").length,
    [rows],
  );

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((w) =>
      [w.workerId, w.host, String(w.pid), health(w), labelText(w.labels), w.adapters.join(","), w.currentRun].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [rows, filter]);

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

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectWorker(flat[i]?.workerId ?? null),
    onClose: () => {
      if (selectedId) onSelectWorker(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => sel && copyText(sel.workerId, "worker id"),
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
        { label: "Copy link to this worker", run: copyLink },
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
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="ml-auto">
                <DisplayOptions config={WORKERS_DISPLAY} state={display} onChange={setDisplay} />
              </span>
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter worker, host, label, adapter…"
                label="Filter workers"
              />
            </div>
            {query.isSuccess && liveCount === 0 && (
              <div
                className="mb-3 rounded-md border border-[color:var(--hue-warn)] bg-[color:color-mix(in_oklch,var(--hue-warn)_8%,var(--surface-1))] p-3 text-[12px]"
                style={{ color: "var(--hue-warn)" }}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <span className="size-2 shrink-0 rounded-full bg-[color:var(--hue-warn)] animate-pulse" />
                  <span>No live workers detected</span>
                </div>
                <div className="mt-1 text-(--text-dim)">
                  {rows.length === 0
                    ? "No workers have registered with the runtime."
                    : `${rows.length} registered worker${rows.length === 1 ? " is" : "s are"} stopped or stale.`}{" "}
                  Queued runs will remain waiting until a worker is started with{" "}
                  <code className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-[11px] text-(--text)">
                    bun event-runtime/cli.mjs work
                  </code>
                  .
                </div>
              </div>
            )}
          </>
        }
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {cols.map((c) => {
                const sort = WORKERS_DISPLAY.sorts.find((s) => s.column === c.key);
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={sort && display.sortBy === sort.key ? display.sortDir : null}
                    naturalDir={sort?.defaultDir}
                    onSort={sort ? () => setDisplay((s) => cycleColumnSort(WORKERS_DISPLAY, s, c.key)) : undefined}
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
                    w.workerId === selectedId ? "row-selected" : ""
                  }`}
                >
                  <td
                    className={`mono max-w-52 truncate border-b border-(--border) px-3 py-1.5 ${
                      w.state === "stopped" && !w.stale ? "text-(--text-faint)" : ""
                    }`}
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
                        <StateBadge state={health(w)} hues={WORKER_HUES} />
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
                    <td className="max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                      {w.adapters.join(", ") || "-"}
                    </td>
                  )}
                  {show.has("run") && (
                    <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                      {w.currentRun ? (
                        <JumpLink onClick={() => openRun(w.currentRun!)} title="Open this run">
                          {w.currentRun}
                        </JumpLink>
                      ) : (
                        "-"
                      )}
                    </td>
                  )}
                  {show.has("heartbeat") && (
                    <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap tabular-nums text-(--text-faint)">
                      <HeartbeatCell w={w} now={now} />
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
              <StateBadge state={health(sel)} hues={WORKER_HUES} />
              <span className="mono truncate" title={sel.workerId}>
                {sel.workerId}
              </span>
            </span>
          }
          actions={
            <>
              <Button onClick={() => copyText(sel.workerId, "worker id")}>Copy id</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectWorker(null)}>Close</Button>
            </>
          }
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

          <Section title="Heartbeat">
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
                <span style={{ color: WORKER_HUES[sel.state] ?? "var(--hue-idle)" }}>
                  {sel.state}
                  {sel.stale ? " (last reported)" : ""}
                </span>
              }
            />
            <KV
              k="currentRun"
              v={
                sel.currentRun ? (
                  <JumpLink onClick={() => openRun(sel.currentRun!)} title="Open this run">
                    {sel.currentRun}
                  </JumpLink>
                ) : (
                  "-"
                )
              }
            />
            <KV k="startedAt" v={<Ago iso={sel.startedAt} now={now} />} />
            {sel.stoppedAt && <KV k="stoppedAt" v={<Ago iso={sel.stoppedAt} now={now} />} />}
          </Section>

          <Section title="Adapters">
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

          <Section title="Labels">
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ScheduleItem, type TriggerOutcome } from "../api";
import { refetchIntervals, useListKeys, useNow, useTabKeys } from "../hooks";
import {
  DEFAULT_ORDER,
  cycleColumnSort,
  defaultDisplayState,
  sortRows,
  type DisplayConfig,
} from "../displayOptions";
import { setContextActions } from "../palette";
import type { AdmittedEvent, AgentDef } from "../types";
import type { OperatorContext } from "../context";
import { EMPTY, formatDuration, formatRelative } from "../format";
import { ScopeCaption } from "../components/ContextTabs";
import {
  Button,
  CopyActions,
  Countdown,
  DetailPane,
  Dialog,
  EVENT_STATUS_HUES,
  FilterInput,
  JumpLink,
  KV,
  ListEmpty,
  ListPane,
  Section,
  Th,
  VerbError,
  copyLink,
  copyText,
  notify,
} from "../components/ui";

export type { ScheduleItem, TriggerOutcome };

/**
 * Free-text filter tokens for a schedule row (WM-101). The enabled/state
 * tokens must match the words rendered in the Enabled and State cells so
 * filtering by what the operator sees works.
 */
export function scheduleFilterTokens(s: ScheduleItem): string[] {
  return [
    s.loop,
    s.every,
    s.eventType,
    s.approval,
    s.catchUp,
    s.enabled ? "enabled" : "disabled",
    s.error ? "error" : !s.enabled ? "not scheduled" : s.stopped ? "stopped" : "running",
  ];
}

const scheduleState = (schedule: ScheduleItem): string =>
  schedule.error ? "error" : !schedule.enabled ? "not scheduled" : schedule.stopped ? "stopped" : "running";

type ScheduleTab = "all" | "enabled" | "disabled";
const SCHEDULE_TABS: readonly ScheduleTab[] = ["all", "enabled", "disabled"];

/** The registry's operator-first order when no column sort is selected. */
export function compareSchedules(a: ScheduleItem, b: ScheduleItem): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  // Disabled schedules are not due, even if the API retains a historical
  // nextDue value; the table renders the shared empty value for them, so name is their tie-break.
  const parsedADue = a.enabled && a.nextDue ? Date.parse(a.nextDue) : Number.POSITIVE_INFINITY;
  const parsedBDue = b.enabled && b.nextDue ? Date.parse(b.nextDue) : Number.POSITIVE_INFINITY;
  const aDue = Number.isNaN(parsedADue) ? Number.POSITIVE_INFINITY : parsedADue;
  const bDue = Number.isNaN(parsedBDue) ? Number.POSITIVE_INFINITY : parsedBDue;
  if (aDue !== bDue) return aDue - bDue;
  return a.loop.localeCompare(b.loop);
}

function ScheduleStateBadge({
  state,
  hue,
  title,
}: {
  state: string;
  hue: string;
  title: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: hue, background: `color-mix(in oklch, ${hue} 12%, transparent)` }}
      title={title}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {state}
    </span>
  );
}

const SCHEDULES_SORT: DisplayConfig<ScheduleItem> = {
  view: "schedules-table-sort",
  groups: [],
  sorts: [
    { key: "loop", label: "Loop", get: (schedule) => schedule.loop, column: "loop" },
    {
      key: "cadence",
      label: "Cadence",
      get: (schedule) => schedule.cadenceSeconds ?? Number.POSITIVE_INFINITY,
      column: "cadence",
    },
    { key: "enabled", label: "Enabled", get: (schedule) => Number(schedule.enabled), column: "enabled" },
    { key: "approval", label: "Approval", get: (schedule) => schedule.approval, column: "approval" },
    { key: "catchUp", label: "Catch-up", get: (schedule) => schedule.catchUp, column: "catchUp" },
    {
      key: "lastFire",
      label: "Last fire",
      get: (schedule) => schedule.lastSlot ?? "",
      defaultDir: "desc",
      column: "lastFire",
    },
    {
      key: "nextDue",
      label: "Next due",
      get: (schedule) => schedule.nextDue ?? "",
      column: "nextDue",
    },
    { key: "state", label: "State", get: scheduleState, column: "state" },
  ],
  columns: [
    { key: "loop", label: "Loop" },
    { key: "cadence", label: "Cadence" },
    { key: "enabled", label: "Enabled" },
    { key: "approval", label: "Approval" },
    { key: "catchUp", label: "Catch-up" },
    { key: "lastFire", label: "Last fire" },
    { key: "nextDue", label: "Next due" },
    { key: "state", label: "State" },
  ],
};

/**
 * Schedules view (OPS-400, OPS-401) — surfaces recurring loops, last fire,
 * next due countdown, and stopped clocks, with an ad-hoc trigger modal.
 */
export function Schedules({
  connected,
  context,
  focusScheduleLoop,
  onSelectSchedule,
  onJumpProposal,
  onJumpRun,
  onJumpEvent,
  onJumpAgent,
  rejumpEpoch,
}: {
  connected?: boolean;
  context: OperatorContext;
  focusScheduleLoop: string | null;
  onSelectSchedule: (loop: string | null) => void;
  onJumpProposal: (id: string) => void;
  onJumpRun: (runId: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpAgent: (ref: string) => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();

  const schedulesQ = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    ...refetchIntervals.primary,
  });
  const rows = schedulesQ.data?.schedules ?? [];

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    ...refetchIntervals.secondary,
  });
  const agents = agentsQ.data?.agents ?? [];

  const eventsQ = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    ...refetchIntervals.secondary,
  });
  const allEvents = eventsQ.data?.events ?? [];

  const enabledCount = rows.filter((schedule) => schedule.enabled).length;
  const disabledCount = rows.length - enabledCount;
  const [tab, setTab] = useState<ScheduleTab>("enabled");
  useTabKeys(SCHEDULE_TABS, tab, setTab);

  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((schedule) => {
      if (tab === "enabled" && !schedule.enabled) return false;
      if (tab === "disabled" && schedule.enabled) return false;
      return !q || scheduleFilterTokens(schedule).some((value) => value.toLowerCase().includes(q));
    });
  }, [rows, tab, filter]);
  const [sort, setSort] = useState(() => defaultDisplayState(SCHEDULES_SORT));
  const visible = useMemo(
    () => sort.sortBy === DEFAULT_ORDER
      ? [...filtered].sort(compareSchedules)
      : sortRows(filtered, SCHEDULES_SORT, sort),
    [filtered, sort],
  );
  const nextSchedule = useMemo(
    () => [...rows]
      .filter((schedule) => schedule.enabled && schedule.nextDue && !Number.isNaN(Date.parse(schedule.nextDue)))
      .sort(compareSchedules)[0] ?? null,
    [rows],
  );
  const nextFireSeconds = nextSchedule?.nextDue
    ? Math.max(0, Math.floor((Date.parse(nextSchedule.nextDue) - now) / 1000))
    : null;
  const nextFireLabel = nextFireSeconds === null
    ? "not scheduled"
    : nextFireSeconds === 0
      ? "due now"
      : `in ${Math.floor(nextFireSeconds / 60)}:${String(nextFireSeconds % 60).padStart(2, "0")}`;

  const selectedLoop = focusScheduleLoop;
  const selectedIndex = useMemo(
    () => visible.findIndex((s) => s.loop === selectedLoop),
    [visible, selectedLoop],
  );
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  // Find agent corresponding to the selected schedule's eventType
  const selAgent: AgentDef | undefined = useMemo(() => {
    if (!sel) return undefined;
    return agents.find((a) => a.eventTypes.some((t) => t.type === sel.eventType));
  }, [sel, agents]);

  // Recent ticks for the selected loop
  const recentTicks: AdmittedEvent[] = useMemo(() => {
    if (!sel) return [];
    return allEvents
      .filter((e) => e.type === sel.eventType || (e.envelope?.payload as Record<string, unknown> | undefined)?.loop === sel.loop)
      .slice(0, 10);
  }, [sel, allEvents]);

  const [confirmLoop, setConfirmLoop] = useState<ScheduleItem | null>(null);
  const [prNumbersInput, setPrNumbersInput] = useState("");
  const [triggerInputError, setTriggerInputError] = useState<string | null>(null);

  const triggerMut = useMutation({
    mutationFn: ({ loop, prNumbers }: { loop: string; prNumbers?: number[] }) =>
      api.triggerSchedule(loop, prNumbers),
    onSuccess: (outcome, request) => {
      const { loop } = request;
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      setConfirmLoop(null);
      if (outcome.decision === "noop") {
        notify(`Schedule "${loop}" was not started: ${outcome.reason ?? "previous run in flight"}`, "info");
      } else if (outcome.proposalId) {
        notify(`Triggered "${loop}" · proposal ${outcome.proposalId}`, "ok");
        onJumpProposal(outcome.proposalId);
      } else {
        notify(`Triggered "${loop}" ad-hoc event`, "ok");
      }
    },
  });

  useEffect(() => {
    setPrNumbersInput("");
    setTriggerInputError(null);
  }, [confirmLoop]);

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, rejumpEpoch]);

  useEffect(() => {
    if (!focusScheduleLoop) return;
    setFilter("");
    const focused = rows.find((schedule) => schedule.loop === focusScheduleLoop);
    // Keep deep-linked selections visible, but preserve an explicit All choice.
    if (focused && tab !== "all" && focused.enabled !== (tab === "enabled")) {
      setTab(focused.enabled ? "enabled" : "disabled");
    }
  }, [focusScheduleLoop, rows, tab]);

  const submitTrigger = () => {
    if (!confirmLoop) return;
    if (confirmLoop.eventType !== "factory.merge.requested") {
      triggerMut.mutate({ loop: confirmLoop.loop });
      return;
    }

    const raw = prNumbersInput.trim();
    if (raw === "") {
      triggerMut.mutate({ loop: confirmLoop.loop });
      return;
    }
    const tokens = raw.split(/[\s,]+/);
    if (tokens.some((token) => !/^\d+$/.test(token))) {
      setTriggerInputError("Enter positive PR numbers separated by commas or spaces.");
      return;
    }
    const prNumbers = tokens.map(Number);
    if (prNumbers.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
      setTriggerInputError("Enter positive PR numbers separated by commas or spaces.");
      return;
    }
    if (new Set(prNumbers).size !== prNumbers.length) {
      setTriggerInputError("Each PR number may be entered only once.");
      return;
    }
    setTriggerInputError(null);
    triggerMut.mutate({ loop: confirmLoop.loop, prNumbers });
  };

  const pendingC = useRef<number>(0);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectSchedule(visible[i]?.loop ?? null),
    onClose: () => {
      if (selectedLoop) onSelectSchedule(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => {
        if (!sel) return;
        copyText(sel.loop, "schedule loop");
        pendingC.current = Date.now();
      },
      l: () => {
        if (sel && pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          copyLink();
          pendingC.current = 0;
        }
      },
      r: () => sel && connected !== false && setConfirmLoop(sel),
    },
  });

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: `Copy ${sel.loop}`, hint: "c", run: () => copyText(sel.loop, "schedule loop") },
        { label: "Copy link to this schedule", hint: "c l", run: copyLink },
      ];
      setContextActions(
        connected === false
          ? copy
          : [{ label: `Run ${sel.loop} now…`, hint: "r", run: () => setConfirmLoop(sel) }, ...copy],
      );
    }
    return () => setContextActions([]);
  }, [sel, connected]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-lg font-semibold">Schedules</h1>
            <ScopeCaption
              context={context}
              surface="registry"
              subject={{ label: "Schedules", plural: true }}
            />
            <div className="mb-2 flex gap-1" role="tablist" aria-label="Schedule state">
              {SCHEDULE_TABS.map((scheduleTab) => {
                const count = scheduleTab === "all"
                  ? rows.length
                  : scheduleTab === "enabled"
                    ? enabledCount
                    : disabledCount;
                return (
                  <button
                    key={scheduleTab}
                    id={`schedule-tab-${scheduleTab}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === scheduleTab}
                    aria-controls="schedule-table-panel"
                    tabIndex={tab === scheduleTab ? 0 : -1}
                    onClick={() => setTab(scheduleTab)}
                    className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                      tab === scheduleTab
                        ? "bg-(--surface-3) text-(--text)"
                        : "text-(--text-faint) hover:bg-(--surface-1)"
                    }`}
                  >
                    {scheduleTab[0]!.toUpperCase() + scheduleTab.slice(1)}
                    <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>
                  </button>
                );
              })}
            </div>
            <p className="mb-3 text-[11px] text-(--text-faint)" aria-label="Schedule summary">
              {enabledCount} enabled · {disabledCount} disabled · next fire {nextFireLabel}
              {nextSchedule && <> ({nextSchedule.loop})</>}
            </p>
            <div className="mb-3">
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter loop, cadence, event type, approval…"
                label="Filter schedules"
              />
            </div>
          </>
        }
      >
        <div
          id="schedule-table-panel"
          role="tabpanel"
          aria-labelledby={`schedule-tab-${tab}`}
        >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {SCHEDULES_SORT.columns.map((column) => {
                const field = SCHEDULES_SORT.sorts.find((candidate) => candidate.column === column.key)!;
                const title =
                  column.key === "enabled"
                    ? "Config flag from event-runtime/schedules.json — edit that file (or use the CLI) to enable/disable; there is no toggle in this UI"
                    : column.key === "state"
                      ? "Runtime health of the scheduler loop: running, stopped (no ticks), not scheduled (disabled), or error"
                      : undefined;
                return (
                  <Th
                    key={column.key}
                    label={column.label}
                    title={title}
                    dir={sort.sortBy === field.key ? sort.sortDir : null}
                    naturalDir={field.defaultDir ?? "asc"}
                    onSort={() => setSort((state) => cycleColumnSort(SCHEDULES_SORT, state, column.key))}
                  />
                );
              })}
              <Th label="Action" align="right" />
            </tr>
          </thead>
          <tbody>
            {visible.map((s, idx) => {
              const isSel = idx === selectedIndex;
              const isAuto = s.approval === "auto";
              return (
                <tr
                  key={s.loop}
                  onClick={() => onSelectSchedule(s.loop)}
                  aria-selected={isSel}
                  className={`group cursor-pointer border-b border-(--border) text-[13px] hover:bg-(--surface-2) ${
                    isSel ? "row-selected bg-(--surface-3)" : ""
                  }`}
                >
                  <td className="mono border-b border-(--border) px-3 py-1.5 whitespace-nowrap font-medium text-(--text)">
                    {s.loop}
                  </td>
                  <td className="mono border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)">
                    {s.every}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                    <ScheduleStateBadge
                      state={s.enabled ? "enabled" : "disabled"}
                      hue={s.enabled ? "var(--hue-ok)" : "var(--text-faint)"}
                      title={s.enabled
                        ? "enabled: true in event-runtime/schedules.json — the scheduler will fire this loop on cadence"
                        : "enabled: false in event-runtime/schedules.json — edit that file (or use the CLI) to re-enable"}
                    />
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                    <ScheduleStateBadge
                      state={isAuto ? "auto" : "watched"}
                      hue={isAuto ? "var(--hue-warn)" : "var(--hue-info)"}
                      title={isAuto
                        ? "approval: auto — executes unattended without operator prompt"
                        : "approval: watched — requires human approval"}
                    />
                  </td>
                  <td className="mono border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-[11px] text-(--text-dim)">
                    {s.catchUp}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-[11px] text-(--text-dim)">
                    {s.lastSlot ? <span title={s.lastSlot}>{formatRelative(s.lastSlot, now)}</span> : <span className="text-(--text-faint)">never</span>}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-[11px] text-(--text-dim)">
                    {!s.enabled ? (
                      <span className="text-(--text-faint)">{EMPTY}</span>
                    ) : s.error ? (
                      <span className="text-(--hue-err)">{EMPTY}</span>
                    ) : s.nextDue && s.cadenceSeconds ? (
                      <Countdown
                        createdAt={
                          s.lastSlot ?? new Date(Date.parse(s.nextDue) - s.cadenceSeconds * 1000).toISOString()
                        }
                        ttlSeconds={s.cadenceSeconds}
                      />
                    ) : (
                      EMPTY
                    )}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                    {s.error ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--hue-err)"
                        style={{ background: "color-mix(in oklch, var(--hue-err) 12%, transparent)" }}
                        title={s.error}
                      >
                        error
                      </span>
                    ) : !s.enabled ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--text-faint)"
                        style={{ background: "var(--surface-2)" }}
                        title="Not scheduled: enabled: false in event-runtime/schedules.json, so the scheduler loop is not running for this schedule"
                      >
                        not scheduled
                      </span>
                    ) : s.stopped ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--hue-err)"
                        style={{ background: "color-mix(in oklch, var(--hue-err) 12%, transparent)" }}
                        title={`Stopped: enabled: true but the scheduler loop is not ticking — no ticks for ${s.intervalsLate} intervals. Check the event runtime serve process.`}
                      >
                        stopped ({s.intervalsLate} late)
                      </span>
                    ) : (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--hue-ok)"
                        style={{ background: "color-mix(in oklch, var(--hue-ok) 12%, transparent)" }}
                        title="Running: enabled: true and the scheduler loop is ticking on cadence"
                      >
                        running
                      </span>
                    )}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-right">
                    <span className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                      <Button
                        disabled={connected === false}
                        onClick={() => setConfirmLoop(s)}
                      >
                        Run now…
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={9}
                query={schedulesQ}
                filtered={rows.length > 0}
                noun="schedules"
                empty="No schedules registered (event-runtime/schedules.json)"
              />
            )}
          </tbody>
        </table>
        <div className="px-3 py-2 text-[11px] text-(--text-faint)">
          Enable or disable schedules in{" "}
          <code className="mono">event-runtime/schedules.json</code> (or via the CLI) — there is no
          toggle here.
        </div>
        </div>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[520px]"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="mono truncate" title={sel.loop}>
                {sel.loop}
              </span>
              {sel.approval === "auto" && (
                <span
                  className="rounded border px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase"
                  style={{
                    color: "var(--hue-warn)",
                    borderColor: "color-mix(in oklch, var(--hue-warn) 40%, var(--border))",
                    background: "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                  }}
                >
                  auto
                </span>
              )}
            </span>
          }
          actions={
            <Button
              variant="primary"
              disabled={connected === false}
              onClick={() => setConfirmLoop(sel)}
            >
              Run now… <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">r</span>
            </Button>
          }
          utility={<CopyActions id={sel.loop} idLabel="schedule loop" />}
          close={<Button onClick={() => onSelectSchedule(null)}>Close</Button>}
        >
          <div className="space-y-6">
            {sel.stopped && (
              <div
                className="rounded-md border border-(--hue-err) bg-[color-mix(in_oklch,var(--hue-err)_8%,var(--surface-1))] p-3 text-[12px] text-(--hue-err)"
              >
                <div className="font-semibold">Schedule clock stopped</div>
                <div className="mt-1 text-(--text-dim)">
                  This loop is enabled but has been silent for {sel.intervalsLate} intervals (cadence: {sel.every}).
                  Check that the event runtime serve process is running.
                </div>
              </div>
            )}

            {sel.error && (
              <div
                className="rounded-md border border-(--hue-err) bg-[color-mix(in_oklch,var(--hue-err)_8%,var(--surface-1))] p-3 text-[12px] text-(--hue-err)"
              >
                <div className="font-semibold">Cadence configuration error</div>
                <div className="mono mt-1 text-(--text-dim)">{sel.error}</div>
              </div>
            )}

            <Section id="schedule-configuration" title="Configuration" icons>
              <KV k="loop name" v={<span className="mono">{sel.loop}</span>} />
              <KV
                k="cadence"
                v={
                  <span>
                    <span className="mono">{sel.every}</span>
                    {sel.cadenceSeconds && (
                      <span className="ml-2 text-(--text-faint)" title={`${sel.cadenceSeconds}s`}>
                        ({formatDuration(sel.cadenceSeconds)})
                      </span>
                    )}
                  </span>
                }
              />
              <KV
                k="event type"
                v={
                  <JumpLink
                    onClick={() => {
                      window.location.hash = `#/events?type=${encodeURIComponent(sel.eventType)}`;
                    }}
                  >
                    {sel.eventType}
                  </JumpLink>
                }
              />
              {selAgent && (
                <KV
                  k="agent"
                  v={
                    <JumpLink onClick={() => onJumpAgent(selAgent.ref)}>
                      {selAgent.ref}
                    </JumpLink>
                  }
                />
              )}
              <KV
                k="approval"
                v={
                  sel.approval === "auto" ? (
                    <span className="font-medium text-(--hue-warn)">
                      auto (unattended execution)
                    </span>
                  ) : (
                    <span className="text-(--text-dim)">watched (requires human approval)</span>
                  )
                }
              />
              <KV k="catch-up" v={<span className="mono">{sel.catchUp}</span>} />
              <KV
                k="singleton"
                v={sel.singleton ? "true (previous run must finish before next starts)" : "false"}
              />
              <KV
                k="enabled"
                v={
                  sel.enabled ? (
                    <span className="text-(--hue-ok)">true</span>
                  ) : (
                    <span className="text-(--text-faint)">
                      false (disabled — re-enable in event-runtime/schedules.json or via the CLI)
                    </span>
                  )
                }
              />
            </Section>

            <Section title="Timing & Clocks" icons>
              <KV
                k="last fire"
                v={
                  sel.lastSlot ? (
                    <span>
                      <span title={sel.lastSlot}>{formatRelative(sel.lastSlot, now)}</span>{" "}
                      <span className="mono text-[11px] text-(--text-faint)">({sel.lastSlot})</span>
                    </span>
                  ) : (
                    <span className="text-(--text-faint)">never fired</span>
                  )
                }
              />
              <KV
                k="last completed"
                v={
                  sel.lastCompletedSlot ? (
                    <span>
                      <span title={sel.lastCompletedSlot}>{formatRelative(sel.lastCompletedSlot, now)}</span>{" "}
                      <span className="mono text-[11px] text-(--text-faint)">
                        ({sel.lastCompletedSlot})
                      </span>
                    </span>
                  ) : (
                    <span className="text-(--text-faint)">never completed</span>
                  )
                }
              />
              <KV
                k="next due"
                v={
                  !sel.enabled ? (
                    <span className="text-(--text-faint)">disabled</span>
                  ) : sel.nextDue && sel.cadenceSeconds ? (
                    <span>
                      <Countdown
                        createdAt={
                          sel.lastSlot ??
                          new Date(Date.parse(sel.nextDue) - sel.cadenceSeconds * 1000).toISOString()
                        }
                        ttlSeconds={sel.cadenceSeconds}
                      />{" "}
                      <span className="mono text-[11px] text-(--text-faint)">({sel.nextDue})</span>
                    </span>
                  ) : (
                    EMPTY
                  )
                }
              />
            </Section>

            <Section title="Recent Ticks">
              {recentTicks.length === 0 ? (
                <div className="text-[12px] text-(--text-faint)">
                  No tick events recorded yet for this loop.
                </div>
              ) : (
                <div className="space-y-2">
                  {recentTicks.map((e) => {
                    const payload = (e.envelope?.payload as Record<string, unknown> | undefined) ?? {};
                    const isAdhoc = e.source === "operator" || payload.adhoc === true;
                    return (
                      <div
                        key={`${e.source}:${e.eventId}`}
                        className="flex min-w-0 flex-col items-stretch rounded border border-(--border) bg-(--surface-2) px-3 py-2 text-[12px]"
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <JumpLink
                              className="min-w-0 truncate"
                              title={e.eventId}
                              onClick={() => onJumpEvent(e.source, e.eventId)}
                            >
                              {e.eventId}
                            </JumpLink>
                            {isAdhoc && (
                              <span className="shrink-0 rounded bg-(--surface-3) px-1 text-[11px] text-(--hue-info)">
                                ad-hoc
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-(--text-dim)">
                            <span title={e.occurredAt}>{formatRelative(e.occurredAt, now)}</span>
                            <span>·</span>
                            <span>source: {e.source}</span>
                            {typeof payload.skippedSlots === "number" && payload.skippedSlots > 0 && (
                              <>
                                <span>·</span>
                                <span className="text-(--hue-warn)">
                                  skipped: {payload.skippedSlots}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span
                            className="mono text-[11px]"
                            style={{ color: EVENT_STATUS_HUES[e.status] ?? "inherit" }}
                          >
                            {e.status}
                          </span>
                          {e.proposalId && (
                            <JumpLink onClick={() => onJumpProposal(e.proposalId!)}>
                              proposal
                            </JumpLink>
                          )}
                          {e.runId && (
                            <JumpLink onClick={() => onJumpRun(e.runId!)}>
                              run
                            </JumpLink>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>
        </DetailPane>
      )}

      {confirmLoop && (
        <Dialog
          title={`Run schedule "${confirmLoop.loop}" now?`}
          onClose={() => {
            if (!triggerMut.isPending) setConfirmLoop(null);
          }}
        >
          <div className="space-y-4 text-[13px]">
            <p className="text-(--text-dim)">
              Triggering an ad-hoc run admits a new event immediately with source{" "}
              <code className="mono rounded bg-(--surface-2) px-1 py-0.5 text-(--text)">
                operator
              </code>
              . It {confirmLoop.approval === "watched"
                ? "creates an open proposal for review"
                : "uses the schedule’s auto-approval policy"} and does not alter the schedule&apos;s normal slot timer.
            </p>

            {confirmLoop.eventType === "factory.merge.requested" && (
              <div className="space-y-1.5">
                <label
                  htmlFor="schedule-pr-numbers"
                  className="block text-[12px] font-medium text-(--text)"
                >
                  PR numbers (optional)
                </label>
                <input
                  id="schedule-pr-numbers"
                  type="text"
                  autoFocus
                  inputMode="numeric"
                  value={prNumbersInput}
                  aria-invalid={triggerInputError ? true : undefined}
                  aria-describedby={`schedule-pr-numbers-help${triggerInputError ? " schedule-pr-numbers-error" : ""}`}
                  onChange={(event) => {
                    setPrNumbersInput(event.target.value);
                    setTriggerInputError(null);
                  }}
                  placeholder="411, 426"
                  className="mono w-full rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1.5 text-[13px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
                />
                <p id="schedule-pr-numbers-help" className="text-[11px] text-(--text-faint)">
                  Enter unique positive PR numbers separated by commas or spaces. Leave blank to review all open PRs in {confirmLoop.repo ?? "the configured repository"}.
                </p>
                {triggerInputError && (
                  <div
                    id="schedule-pr-numbers-error"
                    role="alert"
                    className="text-[12px] text-(--hue-err)"
                  >
                    {triggerInputError}
                  </div>
                )}
              </div>
            )}

            {confirmLoop.eventType === "factory.merge.requested" && (
              <div className="rounded-md border border-(--hue-warn) bg-[color-mix(in_oklch,var(--hue-warn)_10%,var(--surface-1))] p-3 text-[12px]">
                <div className="font-semibold text-(--hue-warn)">Autonomous merge automation</div>
                <p className="mt-1 text-(--text-dim)">
                  The scanner is read-only, but a MERGE or FIX recommendation can launch mutating downstream automation without another confirmation.
                  {confirmLoop.approval === "auto" && " This schedule is auto-approved, so the scan starts unattended."}
                </p>
              </div>
            )}

            {confirmLoop && (
              <div className="rounded-md border border-(--border) bg-(--surface-2) p-3 space-y-2">
                <KV k="loop" v={<span className="mono font-semibold">{confirmLoop.loop}</span>} />
                <KV k="event type" v={<span className="mono">{confirmLoop.eventType}</span>} />
                {(() => {
                  const agent = agents.find((a) =>
                    a.eventTypes.some((t) => t.type === confirmLoop.eventType),
                  );
                  if (!agent) return null;
                  return (
                    <>
                      <KV
                        k="agent"
                        v={
                          <span>
                            <span className="mono">{agent.ref}</span>
                            {agent.mutating ? (
                              <span className="ml-2 font-medium text-(--hue-warn)">
                                (mutating)
                              </span>
                            ) : (
                              <span className="ml-2 text-(--text-faint)">(read-only)</span>
                            )}
                          </span>
                        }
                      />
                      {agent.command && (
                        <div className="mt-2">
                          <div className="text-[11px] font-medium text-(--text-faint) mb-1">
                            Command argv:
                          </div>
                          <pre className="mono max-h-24 overflow-auto rounded bg-(--surface-1) p-2 text-[11px] text-(--text)">
                            {agent.command.join(" ")}
                          </pre>
                        </div>
                      )}
                    </>
                  );
                })()}
                {!confirmLoop.enabled && (
                  <div className="mt-2 rounded bg-(--surface-3) p-2 text-[12px] text-(--hue-warn)">
                    Note: This schedule is disabled (<code className="mono">enabled: false</code> in{" "}
                    <code className="mono">event-runtime/schedules.json</code>), so it is not
                    scheduled to run on its own. Triggering ad-hoc will evaluate the loop once.
                  </div>
                )}
              </div>
            )}

            <VerbError error={triggerMut.error} />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                disabled={triggerMut.isPending}
                onClick={() => setConfirmLoop(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={triggerMut.isPending || connected === false}
                onClick={submitTrigger}
              >
                {triggerMut.isPending ? "Triggering…" : "Trigger Run"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

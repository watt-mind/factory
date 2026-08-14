import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { retriggerEnvelope } from "../templates";
import { useDisplayOptions, useListKeys, useNow, useRequeuePoll, useTabKeys } from "../hooks";
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
import { ScopeCaption } from "../components/ContextTabs";
import type { AdmittedEvent, EventFocus } from "../types";
import type { OperatorContext } from "../context";
import { matchesRepo } from "../context";
import { EVENT_FACETS, matchesFilterQuery, parseFilterQuery, removeFilterToken, type FilterToken } from "../filterQuery";
import { decideRevealFilters, formatRevealNotification } from "../reveal";
import {
  Ago,
  Button,
  Dialog,
  Disclosure,
  EVENT_STATUS_HUES,
  FilterInput,
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
  Th,
  VerbError,
  copyText,
  copyLink,
} from "../components/ui";

function toggleFacetInQuery(filter: string, key: "type" | "source", value: string): string {
  const parsed = parseFilterQuery(filter, EVENT_FACETS);
  const existingTokens = parsed.tokens.filter(
    (t): t is Extract<FilterToken, { kind: "field" }> =>
      t.kind === "field" && t.key === key,
  );
  const isAlreadyActive = existingTokens.some(
    (t) => t.value.toLowerCase() === value.toLowerCase(),
  );

  if (isAlreadyActive) {
    let next = filter;
    const matching = existingTokens
      .filter((t) => t.value.toLowerCase() === value.toLowerCase())
      .sort((a, b) => b.start - a.start);
    for (const t of matching) {
      next = removeFilterToken(next, t);
    }
    return next;
  }

  let next = filter;
  const toRemove = [...existingTokens].sort((a, b) => b.start - a.start);
  for (const t of toRemove) {
    next = removeFilterToken(next, t);
  }
  const addition = `${key}:${value}`;
  return next ? `${next} ${addition}`.replace(/\s+/g, " ").trim() : addition;
}

function setFacetInQuery(filter: string, key: "type" | "source", value: string): string {
  const parsed = parseFilterQuery(filter, EVENT_FACETS);
  const existingTokens = parsed.tokens.filter(
    (t): t is Extract<FilterToken, { kind: "field" }> =>
      t.kind === "field" && t.key === key,
  );
  let next = filter;
  const toRemove = [...existingTokens].sort((a, b) => b.start - a.start);
  for (const t of toRemove) {
    next = removeFilterToken(next, t);
  }
  const addition = `${key}:${value}`;
  return next ? `${next} ${addition}`.replace(/\s+/g, " ").trim() : addition;
}

const STATUS_TABS = ["all", "admitted", "planned", "noop", "human_needed", "dead_lettered"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

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

function isStatusTab(value: string | undefined): value is StatusTab {
  return !!value && (STATUS_TABS as readonly string[]).includes(value);
}

const rowWash = (s: string) =>
  s === "dead_lettered" ? "row-wash-err" : s === "human_needed" ? "row-wash-warn" : "";

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
    { key: "occurred", label: "Occurred", get: (e) => e.occurredAt, defaultDir: "desc" },
    { key: "received", label: "Received", get: (e) => e.receivedAt, defaultDir: "desc" },
    { key: "type", label: "Type", get: (e) => e.type, column: "type" },
    { key: "admitted", label: "Admitted", get: (e) => e.admittedAt, defaultDir: "desc", column: "admitted" },
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
  onTriggerAgain: (envelope: Record<string, unknown>) => void;
  onInject: () => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const pollRequeue = useRequeuePoll(onJumpProposal);
  const [tab, setTab] = useState<StatusTab>(isStatusTab(focusEvent?.status) ? focusEvent.status : "all");
  const [filter, setFilter] = useState(focusEvent?.type ? `type:${focusEvent.type}` : "");
  const [confirmReplay, setConfirmReplay] = useState(false);

  const fetchAll = context.kind === "repo";
  const list = useQuery({
    queryKey: ["events", fetchAll ? "all" : tab],
    queryFn: () => api.events(fetchAll || tab === "all" ? undefined : tab),
    refetchInterval: 2000,
  });
  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const rows = list.data?.events ?? [];
  const scoped = useMemo(() => {
    const focusKey =
      focusEvent?.source && focusEvent?.eventId ? `${focusEvent.source}:${focusEvent.eventId}` : null;
    return rows.filter((e) => keyOf(e) === focusKey || matchesRepo(e.repos, context));
  }, [rows, context, focusEvent?.source, focusEvent?.eventId]);

  const tabScoped = useMemo(() => {
    if (fetchAll && tab !== "all") {
      return scoped.filter((e) => e.status === tab);
    }
    return scoped;
  }, [scoped, fetchAll, tab]);

  const types = useMemo(() => [...new Set(tabScoped.map((e) => e.type))].sort(), [tabScoped]);
  const sources = useMemo(() => [...new Set(tabScoped.map((e) => e.source))].sort(), [tabScoped]);

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

  const parsed = useMemo(() => parseFilterQuery(filter, EVENT_FACETS), [filter]);

  const activeTypes = useMemo(() => {
    return new Set(
      parsed.tokens
        .filter((t): t is Extract<FilterToken, { kind: "field" }> => t.kind === "field" && t.key === "type")
        .map((t) => t.value.toLowerCase()),
    );
  }, [parsed.tokens]);

  const activeSources = useMemo(() => {
    return new Set(
      parsed.tokens
        .filter((t): t is Extract<FilterToken, { kind: "field" }> => t.kind === "field" && t.key === "source")
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
            groups: EVENTS_DISPLAY.groups.map((g) => (g.key === "status" ? { ...g, order: [tab] } : g)),
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

  const selectedKey =
    focusEvent?.source && focusEvent?.eventId ? `${focusEvent.source}:${focusEvent.eventId}` : null;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(
    () => flat.findIndex((e) => keyOf(e) === selectedKey),
    [flat, selectedKey],
  );
  const sel = useMemo(
    () => (selectedKey ? (visible.find((e) => keyOf(e) === selectedKey) ?? null) : null),
    [visible, selectedKey],
  );

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Ephemeral Overview/Graph jumps: apply tab/type then drop them so the hash
  // (if any) is the only remaining selection source.
  useEffect(() => {
    if (!focusEvent) return;
    if (isStatusTab(focusEvent.status) && tab !== focusEvent.status) setTab(focusEvent.status);
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
    const decision = decideRevealFilters(latch.snapshot, currentFilters, emptyFilters, isVisible);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEvent?.source, focusEvent?.eventId, focusEvent?.status, rows, tab, fetchAll, list.isPending, list.data]);

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
    mutationFn: (envelope: unknown) => api.replay(envelope),
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setConfirmReplay(false);
      notify(data.duplicate ? `Duplicate event ${data.eventId}` : `Replayed event ${data.eventId}`, "info");
    },
  });

  const canRequeue = sel !== null && REQUEUEABLE.has(sel.status);

  const selectTab = (t: StatusTab) => {
    setTab(t);
    if (selectedKey) onSelectEvent(null);
  };
  useTabKeys(STATUS_TABS, tab, selectTab);

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
      c: () => sel && copyText(sel.eventId, "event id"),
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel || !connected) {
      setContextActions([]);
    } else {
      setContextActions([
        ...(canRequeue
          ? [{ label: `Requeue ${sel.eventId} (re-plan admitted event)`, hint: "q", run: () => requeue.mutate(sel) }]
          : []),
        { label: `Replay ${sel.eventId} through intake…`, run: () => setConfirmReplay(true) },
        {
          label: `Trigger ${sel.type} again (new event id)…`,
          run: () => onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now())),
        },
        { label: `Copy ${sel.eventId}`, hint: "c", run: () => copyText(sel.eventId, "event id") },
        { label: "Copy link to this event", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel ? keyOf(sel) : null, canRequeue, connected]);

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
    notify(`Exported ${sorted.length} event${sorted.length === 1 ? "" : "s"} to JSON`, "info");
  };

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Events</h1>
        {context.kind === "inflight" && <ScopeCaption context={context} surface="fleet" />}

        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Event status">
          {STATUS_TABS.map((t) => {
            const count = tabCount(t);
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => selectTab(t)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                  tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                }`}
              >
                {TAB_LABEL[t]}
                {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
              </button>
            );
          })}
        </div>

        {/* Type / source facets get their own line, above the query box: the
            token chips below the box are full-width, so a facet chip beside it
            would jump a line the moment a token appeared. */}
        {(types.length > 1 || sources.length > 1) && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {types.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Event types">
              <span className="text-[11px] font-semibold text-(--text-dim)">Type:</span>
              {types.map((t) => {
                const isPressed = activeTypes.has(t.toLowerCase());
                const count = typeCounts[t] ?? 0;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={isPressed}
                    onClick={() => {
                      const next = isPressed ? null : t;
                      setFilter((cur) => toggleFacetInQuery(cur, "type", t));
                      onSelectType(next);
                    }}
                    className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                      isPressed
                        ? "bg-(--surface-3) text-(--text)"
                        : "text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text)"
                    }`}
                  >
                    <span>{t}</span>
                    <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
          {sources.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Event sources">
              <span className="text-[11px] font-semibold text-(--text-dim)">Source:</span>
              {sources.map((s) => {
                const isPressed = activeSources.has(s.toLowerCase());
                const count = sourceCounts[s] ?? 0;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={isPressed}
                    onClick={() => {
                      setFilter((cur) => toggleFacetInQuery(cur, "source", s));
                    }}
                    className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${
                      isPressed
                        ? "bg-(--surface-3) text-(--text)"
                        : "text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text)"
                    }`}
                  >
                    <span>{s}</span>
                    <span className="ml-1.5 font-sans tabular-nums text-(--text-faint)">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="ml-auto">
            <DisplayOptions
              config={displayConfig}
              state={display}
              onChange={setDisplay}
              onExport={visible.length > 0 ? handleExport : undefined}
            />
          </span>
          {/* Last in the row: the token chips are a full-width item, so anything
              after the filter box would be pushed onto a third line the moment
              a chip appeared. */}
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="source:… type:… is:stale"
            label="Filter events"
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
              const renderRow = (e: AdmittedEvent) => {
                const proposalReason = (e as any).proposalReason ?? (e as any).proposal_reason ?? null;
                const isSelected = keyOf(e) === selectedKey;
                return (
                  <tr
                    key={keyOf(e)}
                    onClick={() => onSelectEvent(e.source, e.eventId)}
                    aria-selected={isSelected}
                    className={`cursor-pointer hover:bg-(--surface-1) ${rowWash(e.status)} ${isSelected ? "row-selected" : ""}`}
                  >
                    <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5">{e.eventId}</td>
                    {show.has("source") && (
                      <td className="mono max-w-28 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                        {e.source}
                      </td>
                    )}
                    {show.has("type") && (
                      <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{e.type}</td>
                    )}
                    {show.has("subject") && (
                      <td className="max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                        {e.subject ?? "-"}
                      </td>
                    )}
                    {show.has("status") && (
                      <td className="max-w-56 border-b border-(--border) px-3 py-1.5">
                        <div>
                          <StateBadge state={e.status} hues={EVENT_STATUS_HUES} />
                          {e.planFailures > 0 && (
                            <span className="ml-2 whitespace-nowrap text-[11px]" style={{ color: "var(--hue-err)" }}>
                              {e.planFailures} plan failure{e.planFailures === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                        {/* Why the event is parked, on the row: `.mono` carries its own
                            11.5px, so no size utility (it is unlayered and would win).
                            The detail pane keeps the untruncated error. */}
                        {e.lastPlanError ? (
                          <div className="mono mt-0.5 truncate text-(--text-dim)" title={e.lastPlanError}>
                            {e.lastPlanError}
                          </div>
                        ) : proposalReason ? (
                          <div className="mono mt-0.5 truncate text-(--text-dim)" title={proposalReason}>
                            {proposalReason}
                          </div>
                        ) : null}
                      </td>
                    )}
                    {show.has("admitted") && (
                      <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                        <Ago iso={e.admittedAt} now={now} />
                      </td>
                    )}
                  </tr>
                );
              };
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
                noun="events"
                empty={
                  context.kind === "repo"
                    ? `No events for ${context.name}.`
                    : tab === "all"
                    ? "No events."
                    : `No ${TAB_LABEL[tab].toLowerCase()} events.`
                }
                action={
                  tab === "all" ? (
                    <Button onClick={onInject}>Inject event…</Button>
                  ) : undefined
                }
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[440px]"
          title={<span title={sel.eventId}>{sel.eventId}</span>}
          actions={
            <>
              <Button onClick={() => copyText(sel.eventId, "event id")}>Copy id</Button>
              <Button onClick={copyLink}>Copy link</Button>
            </>
          }
          close={<Button onClick={() => onSelectEvent(null)}>Close</Button>}
        >

          <Section title="Event">
            <KV k="source" v={sel.source} />
            <KV k="type" v={sel.type} />
            <KV k="subject" v={sel.subject} />
            <KV k="status" v={<StateBadge state={sel.status} hues={EVENT_STATUS_HUES} />} />
            <KV k="correlationId" v={sel.correlationId} />
            <KV k="occurredAt" v={<Ago iso={sel.occurredAt} now={now} />} />
            <KV k="receivedAt" v={<Ago iso={sel.receivedAt} now={now} />} />
            <KV k="admittedAt" v={<Ago iso={sel.admittedAt} now={now} />} />
            <KV
              k="proposal"
              v={
                sel.proposalId ? (
                  <JumpLink onClick={() => onJumpProposal(sel.proposalId!)} title="Open proposal">
                    {sel.proposalId}
                  </JumpLink>
                ) : null
              }
            />
            <KV
              k="run"
              v={
                sel.runId ? (
                  <JumpLink onClick={() => onJumpRun(sel.runId!)} title="Open run">
                    {sel.runId}
                  </JumpLink>
                ) : null
              }
            />
          </Section>

          {(() => {
            const r = (sel as any).proposalReason ?? (sel as any).proposal_reason ?? null;
            if (sel.planFailures <= 0 && !sel.lastPlanError && !r) return null;
            const err = sel.lastPlanError;
            const hue = err ? "var(--hue-err)" : "var(--hue-warn)";
            return (
              <Section title="Planning">
                {sel.planFailures > 0 && <KV k="planFailures" v={String(sel.planFailures)} />}
                {r && <KV k="proposalReason" v={r} />}
                {(err || r) && (
                  <div
                    className="mt-1.5 rounded-md px-2.5 py-1.5 text-[12px]"
                    style={{
                      color: hue,
                      background: `color-mix(in oklch, ${hue} 10%, transparent)`,
                    }}
                  >
                    {err ?? r}
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

          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              {canRequeue && (
                <Button
                  variant="primary"
                  disabled={!connected || requeue.isPending}
                  onClick={() => requeue.mutate(sel)}
                >
                  Requeue <span className="mono ml-1 opacity-70">q</span>
                </Button>
              )}
              <Button disabled={!connected || replay.isPending} onClick={() => setConfirmReplay(true)}>
                Replay through intake…
              </Button>
              <Button
                disabled={!connected}
                onClick={() => onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now()))}
              >
                Trigger again…
              </Button>
            </div>
            <div className="text-[11px] leading-relaxed text-(--text-faint)">
              Requeue re-plans this event. Replay re-injects through intake. Trigger again opens inject.
            </div>
          </div>
          <VerbError error={requeue.error ?? replay.error} />
        </DetailPane>
      )}

      {confirmReplay && sel && (
        <Dialog title={`Replay ${sel.eventId} through intake?`} onClose={() => setConfirmReplay(false)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Replay re-injects this envelope through intake.
          </div>
          <VerbError error={replay.error} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmReplay(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!connected || replay.isPending}
              onClick={() => replay.mutate(sel.envelope)}
            >
              Replay
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

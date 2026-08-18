import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { OperatorContext } from "../context";
import { matchesRepo } from "../context";
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
import type { FilterFacets } from "../filterQuery";
import { matchesFilterQuery, parseFilterQuery } from "../filterQuery";
import {
  tableTokens,
  useDisplayOptions,
  useListKeys,
  useNow,
  useTableWindow,
} from "../hooks";
import type { ChainListItem, RunState } from "../types";
import {
  Ago,
  FilterInput,
  GroupHeaderRow,
  ListEmpty,
  ListPane,
  STATE_HUES,
  StateBadge,
  TableWindowFooter,
  Th,
  shortId,
} from "../components/ui";

const ACTIVE_STATES = new Set<RunState>([
  "QUEUED",
  "LEASED",
  "RUNNING",
  "VERIFYING",
]);
const FAILED_STATES = new Set<RunState>(["FAILED", "TIMED_OUT", "REFUSED"]);

export type ChainStatus =
  "active" | "failed" | "completed" | "cancelled" | "no runs" | "other";

export function chainHasState(
  chain: ChainListItem,
  states: ReadonlySet<RunState>,
): boolean {
  return Object.entries(chain.states).some(
    ([state, count]) => (count ?? 0) > 0 && states.has(state as RunState),
  );
}

export function chainStatus(chain: ChainListItem): ChainStatus {
  if (chainHasState(chain, FAILED_STATES)) return "failed";
  if (chainHasState(chain, ACTIVE_STATES)) return "active";
  if (chain.runCount === 0) return "no runs";
  if ((chain.states.CANCELLED ?? 0) === chain.runCount) return "cancelled";
  if ((chain.states.COMPLETED ?? 0) === chain.runCount) return "completed";
  return "other";
}

const STATUS_HUES: Record<ChainStatus, string> = {
  active: "var(--hue-info)",
  failed: "var(--hue-err)",
  completed: "var(--hue-ok)",
  cancelled: "var(--hue-idle)",
  "no runs": "var(--hue-idle)",
  other: "var(--hue-warn)",
};

const CHAIN_FACETS: FilterFacets<ChainListItem> = {
  fields: {
    type: (chain) => chain.origin.type,
    repo: (chain) => chain.repos,
    state: (chain) => Object.keys(chain.states),
    source: (chain) => chain.origin.source,
    event: (chain) => chain.origin.eventId,
    id: (chain) => chain.correlationId,
  },
  flags: {
    active: {
      help: "A chain with a queued or executing run.",
      test: (chain) => chainHasState(chain, ACTIVE_STATES),
    },
    failed: {
      help: "A chain with a failed, timed-out, or refused run.",
      test: (chain) => chainHasState(chain, FAILED_STATES),
    },
  },
  text: (chain) => [
    chain.correlationId,
    chain.origin.eventId,
    chain.origin.type,
    chain.origin.source,
    chain.origin.subject,
    ...chain.repos,
    ...Object.keys(chain.states),
  ],
  values: {
    state: [
      "queued",
      "leased",
      "running",
      "verifying",
      "completed",
      "failed",
      "timed_out",
      "refused",
      "cancelled",
    ],
  },
};

const CHAINS_DISPLAY: DisplayConfig<ChainListItem> = {
  view: "chains",
  groups: [
    {
      key: "status",
      label: "Status",
      get: chainStatus,
      order: ["active", "failed", "other", "completed", "cancelled", "no runs"],
      hue: STATUS_HUES,
    },
    { key: "type", label: "Origin type", get: (chain) => chain.origin.type },
    {
      key: "repo",
      label: "Repo",
      get: (chain) => chain.repos.join(", ") || "unscoped",
    },
  ],
  subGroups: ["type", "repo", "status"],
  sorts: [
    {
      key: "origin",
      label: "Origin",
      get: (chain) => chain.origin.type,
      column: "origin",
    },
    {
      key: "root",
      label: "Root event",
      get: (chain) => chain.origin.eventId,
      column: "root",
    },
    {
      key: "depth",
      label: "Depth",
      get: (chain) => chain.maxDepth,
      defaultDir: "desc",
      column: "depth",
    },
    {
      key: "events",
      label: "Events",
      get: (chain) => chain.eventCount,
      defaultDir: "desc",
      column: "events",
    },
    {
      key: "runs",
      label: "Runs",
      get: (chain) => chain.runCount,
      defaultDir: "desc",
      column: "runs",
    },
    { key: "status", label: "States", get: chainStatus, column: "states" },
    {
      key: "activity",
      label: "Last activity",
      get: (chain) => chain.lastActivityAt,
      defaultDir: "desc",
      column: "activity",
    },
    {
      key: "repo",
      label: "Repos",
      get: (chain) => chain.repos.join(", "),
      column: "repos",
    },
  ],
  columns: [
    { key: "origin", label: "Origin", always: true },
    { key: "root", label: "Root event" },
    { key: "depth", label: "Depth" },
    { key: "events", label: "Events" },
    { key: "runs", label: "Runs" },
    { key: "states", label: "States" },
    { key: "activity", label: "Last activity" },
    { key: "repos", label: "Repos" },
  ],
  defaults: { groupBy: "status", sortBy: "activity", sortDir: "desc" },
};

export function Chains({
  context,
  initialStateFilter,
  onOpenChain,
}: {
  context: OperatorContext;
  initialStateFilter?: string | null;
  onOpenChain: (correlationId: string) => void;
}) {
  const now = useNow();
  const [filter, setFilter] = useState(() =>
    initialStateFilter ? `state:${initialStateFilter}` : "",
  );
  const [showSingles, setShowSingles] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    setFilter(initialStateFilter ? `state:${initialStateFilter}` : "");
  }, [initialStateFilter]);
  const list = useQuery({
    queryKey: ["chains", "24h", 100],
    queryFn: () => api.chains("24h", 100),
    refetchInterval: 3000,
  });
  const parsed = useMemo(
    () => parseFilterQuery(filter, CHAIN_FACETS),
    [filter],
  );
  const scoped = useMemo(
    () =>
      (list.data?.chains ?? []).filter(
        (chain) =>
          matchesRepo(chain.repos, context) &&
          (context.kind !== "inflight" || chainHasState(chain, ACTIVE_STATES)),
      ),
    [list.data, context],
  );
  const withoutSingles = useMemo(
    () => (showSingles ? scoped : scoped.filter((chain) => !chain.single)),
    [scoped, showSingles],
  );
  const visible = useMemo(
    () =>
      withoutSingles.filter((chain) =>
        matchesFilterQuery(chain, parsed, CHAIN_FACETS, undefined),
      ),
    [withoutSingles, parsed],
  );
  const [display, setDisplay] = useDisplayOptions(CHAINS_DISPLAY);
  const sections = useMemo(
    () => buildSections(visible, CHAINS_DISPLAY, display),
    [visible, display],
  );
  const flat = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(CHAINS_DISPLAY, display);
  const show = useMemo(() => new Set(cols.map((column) => column.key)), [cols]);
  const tokens = tableTokens(sections, display.collapsed, grouped(display));
  const [windowTokens, windowStart, windowEnd, moveWindow] = useTableWindow(
    tokens,
    selectedId,
    (chain) => chain.correlationId,
    JSON.stringify([filter, showSingles, context, display]),
  );
  const selectedIndex = flat.findIndex(
    (chain) => chain.correlationId === selectedId,
  );
  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (index) => setSelectedId(flat[index]?.correlationId ?? null),
    onOpen: () => selectedIndex >= 0 && selectedId && onOpenChain(selectedId),
    onClose: () => (filter ? setFilter("") : setSelectedId(null)),
  });

  const hiddenSingles = scoped.filter((chain) => chain.single).length;
  return (
    <ListPane
      chrome={
        <>
          <h1 className="display mb-1 text-lg font-semibold">Chains</h1>
          <p className="mb-3 text-[11px] text-(--text-faint)">
            Correlated event and run journeys with activity in the last 24
            hours.
          </p>
          {context.kind === "repo" && (
            <p className="mb-3 text-[11px] text-(--text-faint)">
              Scoped to <span className="mono">{context.name}</span> — only
              chains naming this repo.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={showSingles}
              onClick={() => setShowSingles((value) => !value)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                showSingles
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              Single-event roots{hiddenSingles > 0 ? ` ${hiddenSingles}` : ""}
            </button>
            <span className="ml-auto">
              <DisplayOptions
                config={CHAINS_DISPLAY}
                state={display}
                onChange={setDisplay}
                rows={scoped}
              />
            </span>
            <FilterInput
              value={filter}
              onChange={setFilter}
              placeholder="type:… repo:… state:… is:active"
              label="Filter chains"
              query={parsed}
              facets={CHAIN_FACETS}
            />
          </div>
        </>
      }
    >
      <table className="w-full table-fixed border-separate border-spacing-0">
        <thead>
          <tr className="text-left text-[11px] text-(--text-faint)">
            {cols.map((column) => {
              const sort = CHAINS_DISPLAY.sorts.find(
                (item) => item.column === column.key,
              );
              const isCustom =
                column.isCustom || column.key.startsWith("custom:");
              const path = column.key.replace(/^custom:/, "");
              const current = isCustom
                ? display.sortBy === column.key
                : sort && display.sortBy === sort.key;
              return (
                <Th
                  key={column.key}
                  label={column.label}
                  dir={current ? display.sortDir : null}
                  naturalDir={sort?.defaultDir ?? "asc"}
                  onSort={
                    sort || isCustom
                      ? () =>
                          setDisplay((state) =>
                            cycleColumnSort(CHAINS_DISPLAY, state, column.key),
                          )
                      : undefined
                  }
                  onRemove={
                    isCustom
                      ? () =>
                          setDisplay((state) => removeCustomColumn(state, path))
                      : undefined
                  }
                />
              );
            })}
          </tr>
        </thead>
        <tbody>
          {windowTokens.map((token) => {
            if (token.length === 2) {
              const [section, sub] = token;
              return (
                <GroupHeaderRow
                  key={`group:${section.key}`}
                  colSpan={cols.length}
                  section={section}
                  collapsed={display.collapsed.includes(section.key)}
                  onToggle={() =>
                    setDisplay((state) => toggleCollapsed(state, section.key))
                  }
                  sub={sub}
                />
              );
            }
            const chain = token[0];
            const selected = chain.correlationId === selectedId;
            return (
              <tr
                key={chain.correlationId}
                data-chain-id={chain.correlationId}
                aria-selected={selected}
                onClick={() => onOpenChain(chain.correlationId)}
                className={`cursor-pointer hover:bg-(--surface-1) ${selected ? "row-selected" : ""}`}
              >
                <td className="max-w-56 border-b border-(--border) px-3 py-1.5">
                  <div
                    className="truncate text-(--text-dim)"
                    title={chain.origin.type}
                  >
                    {chain.origin.type}
                  </div>
                  <div
                    className="mono truncate text-xs text-(--text-faint)"
                    title={chain.origin.source}
                  >
                    {chain.origin.source}
                  </div>
                </td>
                {show.has("root") && (
                  <td
                    className="mono max-w-28 truncate border-b border-(--border) px-3 py-1.5"
                    title={chain.origin.eventId}
                  >
                    {shortId(chain.origin.eventId)}
                  </td>
                )}
                {show.has("depth") && (
                  <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                    {chain.maxDepth}
                  </td>
                )}
                {show.has("events") && (
                  <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                    {chain.eventCount}
                  </td>
                )}
                {show.has("runs") && (
                  <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                    {chain.runCount}
                  </td>
                )}
                {show.has("states") && (
                  <td className="border-b border-(--border) px-3 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(chain.states).map(([state, count]) =>
                        count ? (
                          <StateBadge
                            key={state}
                            state={`${state} ${count}`}
                            hues={{ [`${state} ${count}`]: STATE_HUES[state] }}
                            dot={false}
                          />
                        ) : null,
                      )}
                      {chain.runCount === 0 && (
                        <span className="text-(--text-faint)">—</span>
                      )}
                    </div>
                  </td>
                )}
                {show.has("activity") && (
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-faint)">
                    <Ago iso={chain.lastActivityAt} now={now} />
                  </td>
                )}
                {show.has("repos") && (
                  <td
                    className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)"
                    title={chain.repos.join(", ")}
                  >
                    {chain.repos.join(", ") || "—"}
                  </td>
                )}
                {cols
                  .filter(
                    (column) =>
                      column.isCustom || column.key.startsWith("custom:"),
                  )
                  .map((column) => (
                    <CustomCell
                      key={column.key}
                      row={chain}
                      path={column.key.replace(/^custom:/, "")}
                    />
                  ))}
              </tr>
            );
          })}
          <TableWindowFooter
            colSpan={cols.length}
            range={[windowStart, windowEnd, tokens.length]}
            move={moveWindow}
          />
          {visible.length === 0 && (
            <ListEmpty
              colSpan={cols.length}
              query={list}
              filtered={withoutSingles.length > 0}
              onClear={filter ? () => setFilter("") : undefined}
              noun="chains"
              empty={
                context.kind === "repo"
                  ? `No chains for ${context.name}.`
                  : showSingles
                    ? "No chains in the last 24 hours."
                    : "No multi-step chains in the last 24 hours."
              }
              escHint={Boolean(filter)}
            />
          )}
        </tbody>
      </table>
    </ListPane>
  );
}

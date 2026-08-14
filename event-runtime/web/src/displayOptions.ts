/**
 * Linear-style display options for the table views (OPS-493): grouping into
 * collapsible sections, sub-grouping, in-group ordering, "show empty groups",
 * and column visibility — all behind one per-view config, the same shape of
 * per-view declaration `filterQuery.ts` uses for facets.
 *
 * Everything here is pure. The views own their `<table>` markup; this module
 * only decides how rows partition into sections and in what order, and the
 * `useListKeys` contract stays flat: a view feeds it `flattenSections()` — the
 * rows of open sections in render order — so keyboard traversal skips
 * collapsed groups without the hook ever learning about groups.
 */

export interface ColumnDef {
  key: string;
  label: string;
  /** Identity columns the view cannot render without; not toggleable. */
  always?: boolean;
  defaultHidden?: boolean;
}

export interface GroupField<T> {
  key: string;
  label: string;
  get: (row: T) => string;
  /**
   * Canonical bucket order for closed enums (lifecycle states, decisions).
   * Also the universe "show empty groups" draws zero-count buckets from.
   * Open-ended fields (agent) omit it: buckets order by count, then name.
   */
  order?: readonly string[];
  /** Section header dot hue by bucket value (STATE_HUES etc.). */
  hue?: Record<string, string>;
}

export interface SortField<T> {
  key: string;
  label: string;
  get: (row: T) => string | number;
  /** Sort direction that makes sense unprompted (times: newest first). */
  defaultDir?: SortDir;
  /** Column this sort field answers for, enabling click-to-sort on its header. */
  column?: string;
}

export type SortDir = "asc" | "desc";

export interface DisplayConfig<T> {
  /** Storage key suffix: settings persist under `evrt-display-<view>`. */
  view: string;
  groups: GroupField<T>[];
  /** Group keys offered as the secondary level. Empty: no sub-grouping UI. */
  subGroups?: string[];
  sorts: SortField<T>[];
  columns: ColumnDef[];
  defaults?: Partial<DisplayState>;
}

export interface DisplayState {
  groupBy: string;
  subGroupBy: string;
  sortBy: string;
  sortDir: SortDir;
  showEmpty: boolean;
  hiddenColumns: string[];
  collapsed: string[];
}

/** "No grouping" / "API order" sentinels — always offered, never in configs. */
export const NONE = "none";
export const DEFAULT_ORDER = "default";

export function defaultDisplayState<T>(config: DisplayConfig<T>): DisplayState {
  return {
    groupBy: NONE,
    subGroupBy: NONE,
    sortBy: DEFAULT_ORDER,
    sortDir: "asc",
    showEmpty: false,
    hiddenColumns: config.columns.filter((c) => c.defaultHidden).map((c) => c.key),
    collapsed: [],
    ...config.defaults,
  };
}

const storageKey = (view: string) => `evrt-display-${view}`;

/**
 * Tolerant load: a stale or hand-edited value must never wedge a view, so
 * anything that no longer names a known group/sort/column falls back field by
 * field rather than discarding the whole record.
 */
export function loadDisplayState<T>(config: DisplayConfig<T>): DisplayState {
  const fallback = defaultDisplayState(config);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey(config.view));
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const p = parsed as Record<string, unknown>;
  const groupKeys = new Set([NONE, ...config.groups.map((g) => g.key)]);
  const sortKeys = new Set([DEFAULT_ORDER, ...config.sorts.map((s) => s.key)]);
  const columnKeys = new Set(config.columns.filter((c) => !c.always).map((c) => c.key));
  const subGroupKeys = new Set([NONE, ...(config.subGroups ?? [])]);
  const str = (v: unknown, ok: Set<string>, fb: string) =>
    typeof v === "string" && ok.has(v) ? v : fb;
  const groupBy = str(p.groupBy, groupKeys, fallback.groupBy);
  const subGroupBy = str(p.subGroupBy, subGroupKeys, fallback.subGroupBy);
  return {
    groupBy,
    // A sub-group equal to the group is a single-level render pretending to
    // be two; normalize it away at the edge so nothing downstream checks.
    subGroupBy: subGroupBy === groupBy ? NONE : subGroupBy,
    sortBy: str(p.sortBy, sortKeys, fallback.sortBy),
    sortDir: p.sortDir === "desc" ? "desc" : p.sortDir === "asc" ? "asc" : fallback.sortDir,
    showEmpty: typeof p.showEmpty === "boolean" ? p.showEmpty : fallback.showEmpty,
    hiddenColumns: Array.isArray(p.hiddenColumns)
      ? p.hiddenColumns.filter((k): k is string => typeof k === "string" && columnKeys.has(k))
      : fallback.hiddenColumns,
    collapsed: Array.isArray(p.collapsed)
      ? p.collapsed.filter((k): k is string => typeof k === "string")
      : fallback.collapsed,
  };
}

export function saveDisplayState<T>(config: DisplayConfig<T>, state: DisplayState): void {
  try {
    localStorage.setItem(storageKey(config.view), JSON.stringify(state));
  } catch {
    // Private mode / quota: display options simply do not persist.
  }
}

export function isDefaultDisplayState<T>(config: DisplayConfig<T>, state: DisplayState): boolean {
  const d = defaultDisplayState(config);
  return (
    state.groupBy === d.groupBy &&
    state.subGroupBy === d.subGroupBy &&
    state.sortBy === d.sortBy &&
    state.sortDir === d.sortDir &&
    state.showEmpty === d.showEmpty &&
    state.hiddenColumns.length === d.hiddenColumns.length &&
    state.hiddenColumns.every((k) => d.hiddenColumns.includes(k))
  );
}

export interface Section<T> {
  /** Collapse identity: the group value, or "parent∕child" for sub-sections. */
  key: string;
  value: string;
  label: string;
  hue?: string;
  /** Every row in the bucket, including rows inside collapsed sub-sections. */
  count: number;
  rows: T[];
  subsections?: Section<T>[];
}

const cmp = (a: string | number, b: string | number): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
};

/** Stable sort by the configured field; DEFAULT_ORDER keeps (or reverses) API order. */
export function sortRows<T>(rows: T[], config: DisplayConfig<T>, state: DisplayState): T[] {
  const dirSign = state.sortDir === "desc" ? -1 : 1;
  if (state.sortBy === DEFAULT_ORDER) {
    return dirSign === 1 ? rows.slice() : rows.slice().reverse();
  }
  const field = config.sorts.find((s) => s.key === state.sortBy);
  if (!field) return rows.slice();
  return rows
    .map((row, i) => ({ row, i, v: field.get(row) }))
    .sort((a, b) => dirSign * cmp(a.v, b.v) || a.i - b.i)
    .map((e) => e.row);
}

function buckets<T>(rows: T[], field: GroupField<T>, showEmpty: boolean): Map<string, T[]> {
  const byValue = new Map<string, T[]>();
  if (showEmpty && field.order) for (const v of field.order) byValue.set(v, []);
  for (const row of rows) {
    const v = field.get(row) || "—";
    const bucket = byValue.get(v);
    if (bucket) bucket.push(row);
    else byValue.set(v, [row]);
  }
  if (!field.order) {
    // Open-ended fields: busiest bucket first, name breaking ties.
    return new Map(
      [...byValue.entries()].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0])),
    );
  }
  const rank = new Map(field.order.map((v, i) => [v, i]));
  return new Map(
    [...byValue.entries()].sort(
      (a, b) => (rank.get(a[0]) ?? field.order!.length) - (rank.get(b[0]) ?? field.order!.length) || cmp(a[0], b[0]),
    ),
  );
}

const section = <T,>(key: string, value: string, field: GroupField<T>, rows: T[]): Section<T> => ({
  key,
  value,
  label: value,
  hue: field.hue?.[value],
  count: rows.length,
  rows,
});

/**
 * Partition, order, and sort in one pass. With `groupBy: none` the result is a
 * single unlabeled section holding every row — the views render headers only
 * when `grouped(state)` says so, so the flat table is the same code path.
 */
export function buildSections<T>(
  rows: T[],
  config: DisplayConfig<T>,
  state: DisplayState,
): Section<T>[] {
  const sorted = sortRows(rows, config, state);
  const group = config.groups.find((g) => g.key === state.groupBy);
  if (!group) {
    return [{ key: NONE, value: NONE, label: "All", count: sorted.length, rows: sorted }];
  }
  const sub =
    state.subGroupBy !== state.groupBy
      ? config.groups.find((g) => g.key === state.subGroupBy)
      : undefined;
  const top: Section<T>[] = [];
  for (const [value, bucket] of buckets(sorted, group, state.showEmpty)) {
    const s = section(value, value, group, bucket);
    if (sub && bucket.length > 0) {
      s.subsections = [...buckets(bucket, sub, false).entries()].map(([v, b]) =>
        section(`${value}∕${v}`, v, sub, b),
      );
    }
    top.push(s);
  }
  return top;
}

export const grouped = (state: DisplayState): boolean => state.groupBy !== NONE;

/**
 * The rows keyboard navigation can reach, in exactly the order the table
 * renders them: open sections contribute their rows (through open
 * sub-sections), collapsed ones contribute nothing.
 */
export function flattenSections<T>(sections: Section<T>[], collapsed: readonly string[]): T[] {
  const closed = new Set(collapsed);
  const out: T[] = [];
  for (const s of sections) {
    if (closed.has(s.key)) continue;
    if (!s.subsections) {
      out.push(...s.rows);
      continue;
    }
    for (const child of s.subsections) {
      if (!closed.has(child.key)) out.push(...child.rows);
    }
  }
  return out;
}

export function toggleCollapsed(state: DisplayState, key: string): DisplayState {
  const collapsed = state.collapsed.includes(key)
    ? state.collapsed.filter((k) => k !== key)
    : [...state.collapsed, key];
  return { ...state, collapsed };
}

/** Columns the table actually renders, in declared order. */
export function visibleColumns<T>(config: DisplayConfig<T>, state: DisplayState): ColumnDef[] {
  return config.columns.filter((c) => c.always || !state.hiddenColumns.includes(c.key));
}

export function toggleColumn(state: DisplayState, key: string): DisplayState {
  const hiddenColumns = state.hiddenColumns.includes(key)
    ? state.hiddenColumns.filter((k) => k !== key)
    : [...state.hiddenColumns, key];
  return { ...state, hiddenColumns };
}

/**
 * A header click sorts by that column: first click applies the field's natural
 * direction, the second reverses it, a third returns to API order — so the
 * header is never a dead end.
 */
export function cycleColumnSort<T>(
  config: DisplayConfig<T>,
  state: DisplayState,
  columnKey: string,
): DisplayState {
  const field = config.sorts.find((s) => s.column === columnKey);
  if (!field) return state;
  const natural = field.defaultDir ?? "asc";
  if (state.sortBy !== field.key) {
    return { ...state, sortBy: field.key, sortDir: natural };
  }
  if (state.sortDir === natural) {
    return { ...state, sortDir: natural === "asc" ? "desc" : "asc" };
  }
  return { ...state, sortBy: DEFAULT_ORDER, sortDir: "asc" };
}

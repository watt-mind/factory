import "./test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ORDER,
  NONE,
  buildSections,
  cycleColumnSort,
  defaultDisplayState,
  flattenSections,
  isDefaultDisplayState,
  loadDisplayState,
  saveDisplayState,
  sortRows,
  toggleCollapsed,
  toggleColumn,
  visibleColumns,
  type DisplayConfig,
  type DisplayState,
} from "./displayOptions";

interface Row {
  id: string;
  state: string;
  agent: string;
  created_at: string;
}

const CONFIG: DisplayConfig<Row> = {
  view: "test",
  groups: [
    {
      key: "state",
      label: "State",
      get: (r) => r.state,
      order: ["RUNNING", "COMPLETED", "FAILED"],
      hue: { RUNNING: "var(--hue-warn)" },
    },
    { key: "agent", label: "Agent", get: (r) => r.agent },
  ],
  subGroups: ["agent"],
  sorts: [
    { key: "created", label: "Created", get: (r) => r.created_at, defaultDir: "desc", column: "created" },
    { key: "agent", label: "Agent", get: (r) => r.agent, column: "agent" },
  ],
  columns: [
    { key: "id", label: "Run", always: true },
    { key: "agent", label: "Agent" },
    { key: "created", label: "Created", defaultHidden: true },
  ],
};

const row = (id: string, state: string, agent: string, created: string): Row => ({
  id,
  state,
  agent,
  created_at: created,
});

const ROWS: Row[] = [
  row("r1", "COMPLETED", "doctor", "2026-01-03"),
  row("r2", "RUNNING", "scout", "2026-01-01"),
  row("r3", "FAILED", "doctor", "2026-01-04"),
  row("r4", "RUNNING", "doctor", "2026-01-02"),
  row("r5", "COMPLETED", "scout", "2026-01-05"),
];

const state = (over: Partial<DisplayState> = {}): DisplayState => ({
  ...defaultDisplayState(CONFIG),
  ...over,
});

afterEach(() => {
  localStorage.clear();
});

describe("buildSections", () => {
  test("no grouping yields one section holding every row in API order", () => {
    const sections = buildSections(ROWS, CONFIG, state());
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe(NONE);
    expect(sections[0].rows.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("enum grouping orders buckets canonically with counts and hues", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "state" }));
    expect(sections.map((s) => s.value)).toEqual(["RUNNING", "COMPLETED", "FAILED"]);
    expect(sections.map((s) => s.count)).toEqual([2, 2, 1]);
    expect(sections[0].hue).toBe("var(--hue-warn)");
  });

  test("open-ended grouping orders buckets by count then name", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "agent" }));
    expect(sections.map((s) => s.value)).toEqual(["doctor", "scout"]);
    expect(sections.map((s) => s.count)).toEqual([3, 2]);
  });

  test("a value outside the canonical order still gets a bucket, after the enums", () => {
    const rows = [...ROWS, row("r6", "MYSTERY", "scout", "2026-01-06")];
    const sections = buildSections(rows, CONFIG, state({ groupBy: "state" }));
    expect(sections.map((s) => s.value)).toEqual(["RUNNING", "COMPLETED", "FAILED", "MYSTERY"]);
  });

  test("show empty groups emits zero-count buckets from the canonical order", () => {
    const running = ROWS.filter((r) => r.state === "RUNNING");
    const withEmpty = buildSections(running, CONFIG, state({ groupBy: "state", showEmpty: true }));
    expect(withEmpty.map((s) => [s.value, s.count])).toEqual([
      ["RUNNING", 2],
      ["COMPLETED", 0],
      ["FAILED", 0],
    ]);
    const without = buildSections(running, CONFIG, state({ groupBy: "state" }));
    expect(without.map((s) => s.value)).toEqual(["RUNNING"]);
  });

  test("sub-grouping nests second-level sections with scoped collapse keys", () => {
    const sections = buildSections(
      ROWS,
      CONFIG,
      state({ groupBy: "state", subGroupBy: "agent" }),
    );
    const completed = sections.find((s) => s.value === "COMPLETED")!;
    expect(completed.subsections!.map((s) => s.value)).toEqual(["doctor", "scout"]);
    const keys = sections.flatMap((s) => (s.subsections ?? []).map((c) => c.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("sub-group equal to the group collapses to a single level", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "agent", subGroupBy: "agent" }));
    expect(sections.every((s) => s.subsections === undefined)).toBe(true);
  });

  test("rows with an empty group value land in a — bucket", () => {
    const rows = [row("r7", "COMPLETED", "", "2026-01-07")];
    const sections = buildSections(rows, CONFIG, state({ groupBy: "agent" }));
    expect(sections[0].value).toBe("—");
  });
});

describe("sortRows", () => {
  test("default order preserves API order and desc reverses it", () => {
    expect(sortRows(ROWS, CONFIG, state()).map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(sortRows(ROWS, CONFIG, state({ sortDir: "desc" })).map((r) => r.id)).toEqual([
      "r5",
      "r4",
      "r3",
      "r2",
      "r1",
    ]);
  });

  test("field sort is applied inside groups and is stable on ties", () => {
    const sections = buildSections(
      ROWS,
      CONFIG,
      state({ groupBy: "state", sortBy: "created", sortDir: "desc" }),
    );
    const completed = sections.find((s) => s.value === "COMPLETED")!;
    expect(completed.rows.map((r) => r.id)).toEqual(["r5", "r1"]);
    const tied = [row("a", "RUNNING", "x", "same"), row("b", "RUNNING", "y", "same")];
    expect(sortRows(tied, CONFIG, state({ sortBy: "created" })).map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("does not mutate its input", () => {
    const input = ROWS.slice();
    sortRows(input, CONFIG, state({ sortBy: "created", sortDir: "desc" }));
    expect(input.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });
});

describe("flattenSections", () => {
  test("skips collapsed sections and collapsed sub-sections", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "state" }));
    expect(flattenSections(sections, []).map((r) => r.id)).toEqual(["r2", "r4", "r1", "r5", "r3"]);
    expect(flattenSections(sections, ["RUNNING"]).map((r) => r.id)).toEqual(["r1", "r5", "r3"]);

    const nested = buildSections(ROWS, CONFIG, state({ groupBy: "state", subGroupBy: "agent" }));
    const flat = flattenSections(nested, ["COMPLETED∕doctor"]);
    expect(flat.map((r) => r.id)).not.toContain("r1");
    expect(flat.map((r) => r.id)).toContain("r5");
    // Collapsing the parent hides its open children too. Sub-grouping RUNNING
    // by agent puts doctor (r4) ahead of scout (r2): count ties break by name.
    expect(flattenSections(nested, ["COMPLETED"]).map((r) => r.id)).toEqual(["r4", "r2", "r3"]);
  });
});

describe("state transitions", () => {
  test("toggleCollapsed round-trips", () => {
    const s1 = toggleCollapsed(state(), "RUNNING");
    expect(s1.collapsed).toEqual(["RUNNING"]);
    expect(toggleCollapsed(s1, "RUNNING").collapsed).toEqual([]);
  });

  test("toggleColumn hides and shows; visibleColumns honours always", () => {
    const s0 = state();
    expect(visibleColumns(CONFIG, s0).map((c) => c.key)).toEqual(["id", "agent"]);
    const shown = toggleColumn(s0, "created");
    expect(visibleColumns(CONFIG, shown).map((c) => c.key)).toEqual(["id", "agent", "created"]);
    expect(visibleColumns(CONFIG, toggleColumn(shown, "created")).map((c) => c.key)).toEqual([
      "id",
      "agent",
    ]);
  });

  test("cycleColumnSort walks natural → reversed → API order", () => {
    const s0 = state();
    const s1 = cycleColumnSort(CONFIG, s0, "created");
    expect([s1.sortBy, s1.sortDir]).toEqual(["created", "desc"]);
    const s2 = cycleColumnSort(CONFIG, s1, "created");
    expect([s2.sortBy, s2.sortDir]).toEqual(["created", "asc"]);
    const s3 = cycleColumnSort(CONFIG, s2, "created");
    expect(s3.sortBy).toBe(DEFAULT_ORDER);
    expect(cycleColumnSort(CONFIG, s0, "no-such-column")).toBe(s0);
  });
});

describe("persistence", () => {
  test("round-trips through localStorage", () => {
    const saved = state({
      groupBy: "state",
      subGroupBy: "agent",
      sortBy: "created",
      sortDir: "desc",
      showEmpty: true,
      hiddenColumns: ["agent"],
      collapsed: ["FAILED"],
    });
    saveDisplayState(CONFIG, saved);
    expect(loadDisplayState(CONFIG)).toEqual(saved);
  });

  test("garbage and unknown keys fall back field by field", () => {
    localStorage.setItem("evrt-display-test", "not json");
    expect(loadDisplayState(CONFIG)).toEqual(defaultDisplayState(CONFIG));

    localStorage.setItem(
      "evrt-display-test",
      JSON.stringify({
        groupBy: "nope",
        subGroupBy: "state", // not offered as a sub-group
        sortBy: "created",
        sortDir: "sideways",
        hiddenColumns: ["id", "agent", 7], // id is always-on: dropped
        collapsed: "RUNNING",
      }),
    );
    const loaded = loadDisplayState(CONFIG);
    expect(loaded.groupBy).toBe(NONE);
    expect(loaded.subGroupBy).toBe(NONE);
    expect(loaded.sortBy).toBe("created");
    expect(loaded.sortDir).toBe("asc");
    expect(loaded.hiddenColumns).toEqual(["agent"]);
    expect(loaded.collapsed).toEqual([]);
  });

  test("a persisted sub-group equal to the group is normalized to none", () => {
    saveDisplayState(CONFIG, state({ groupBy: "agent", subGroupBy: "agent" }));
    expect(loadDisplayState(CONFIG).subGroupBy).toBe(NONE);
  });

  test("isDefaultDisplayState detects deviation and ignores collapse", () => {
    expect(isDefaultDisplayState(CONFIG, state())).toBe(true);
    expect(isDefaultDisplayState(CONFIG, state({ groupBy: "state" }))).toBe(false);
    expect(isDefaultDisplayState(CONFIG, state({ collapsed: ["RUNNING"] }))).toBe(true);
  });
});

import "./test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ORDER,
  NONE,
  addCustomColumn,
  buildSections,
  cycleColumnSort,
  defaultDisplayState,
  flattenSections,
  isDefaultDisplayState,
  loadDisplayState,
  removeCustomColumn,
  saveDisplayState,
  sortRows,
  toggleCollapsed,
  toggleColumn,
  visibleColumns,
  type DisplayConfig,
  type DisplayState,
} from "./displayOptions";
import { extractRowValue, getPathValue, parsePath } from "./pathExtractor";
import { discoverPayloadFields } from "./schemaDiscovery";

interface Row {
  id: string;
  state: string;
  agent: string;
  created_at: string;
  envelope?: {
    payload?: Record<string, unknown>;
  };
  spec?: {
    input?: Record<string, unknown>;
  };
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

const row = (id: string, state: string, agent: string, created: string, extra?: Partial<Row>): Row => ({
  id,
  state,
  agent,
  created_at: created,
  ...extra,
});

const ROWS: Row[] = [
  row("r1", "COMPLETED", "doctor", "2026-01-03", { envelope: { payload: { repo: "watt-mind/factory", priority: 1 } } }),
  row("r2", "RUNNING", "scout", "2026-01-01", { envelope: { payload: { repo: "watt-mind/core", priority: 3 } } }),
  row("r3", "FAILED", "doctor", "2026-01-04", { envelope: { payload: { repo: "watt-mind/factory", priority: 2 } } }),
  row("r4", "RUNNING", "doctor", "2026-01-02", { spec: { input: { repo: "watt-mind/agent" } } }),
  row("r5", "COMPLETED", "scout", "2026-01-05"),
];

const state = (over: Partial<DisplayState> = {}): DisplayState => ({
  ...defaultDisplayState(CONFIG),
  ...over,
});

afterEach(() => {
  localStorage.clear();
});

describe("pathExtractor", () => {
  test("parsePath tokenizes dot and bracket paths safely", () => {
    expect(parsePath("payload.repo")).toEqual(["payload", "repo"]);
    expect(parsePath("spec.input['model-name']")).toEqual(["spec", "input", "model-name"]);
    expect(parsePath("repos[0].name")).toEqual(["repos", "0", "name"]);
    expect(parsePath("payload.__proto__.polluted")).toEqual(["payload", "polluted"]);
  });

  test("getPathValue extracts nested property safely", () => {
    const obj = { spec: { input: { target: "prod", numbers: [10, 20] } } };
    expect(getPathValue(obj, "spec.input.target")).toBe("prod");
    expect(getPathValue(obj, "spec.input.numbers[1]")).toBe(20);
    expect(getPathValue(obj, "spec.input.missing")).toBeUndefined();
    expect(getPathValue(null, "foo")).toBeUndefined();
  });

  test("extractRowValue checks root and fallback payload/spec scopes", () => {
    const eventRow = { id: "e1", envelope: { payload: { repo: "my-repo", count: 42 } } };
    expect(extractRowValue(eventRow, "envelope.payload.repo")).toBe("my-repo");
    expect(extractRowValue(eventRow, "payload.repo")).toBe("my-repo");
    expect(extractRowValue(eventRow, "repo")).toBe("my-repo");

    const runRow = { runId: "run1", spec: { input: { model: "claude-3-7" } } };
    expect(extractRowValue(runRow, "spec.input.model")).toBe("claude-3-7");
    expect(extractRowValue(runRow, "input.model")).toBe("claude-3-7");
    expect(extractRowValue(runRow, "model")).toBe("claude-3-7");
  });
});

describe("schemaDiscovery", () => {
  test("discoverPayloadFields proposes candidate paths with sample values", () => {
    const fields = discoverPayloadFields(ROWS, []);
    expect(fields.length).toBeGreaterThan(0);
    const repoField = fields.find((f) => f.path === "payload.repo" || f.path === "spec.input.repo");
    expect(repoField).toBeDefined();
    expect(repoField?.occurrenceCount).toBeGreaterThanOrEqual(1);
  });
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
    expect(sections[3].count).toBe(1);
  });

  test("show empty groups emits zero-count buckets from the canonical order", () => {
    const rows = [row("r1", "RUNNING", "doctor", "2026-01-01")];
    const sections = buildSections(rows, CONFIG, state({ groupBy: "state", showEmpty: true }));
    expect(sections.map((s) => s.value)).toEqual(["RUNNING", "COMPLETED", "FAILED"]);
    expect(sections.map((s) => s.count)).toEqual([1, 0, 0]);
    expect(sections[1].rows).toEqual([]);
  });

  test("sub-grouping nests second-level sections with scoped collapse keys", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "state", subGroupBy: "agent" }));
    const running = sections.find((s) => s.value === "RUNNING");
    expect(running?.subsections).toBeDefined();
    expect(running?.subsections?.map((sub) => sub.key)).toEqual(["RUNNING∕doctor", "RUNNING∕scout"]);
  });

  test("sub-group equal to the group collapses to a single level", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "state", subGroupBy: "state" }));
    expect(sections.every((s) => !s.subsections)).toBe(true);
  });

  test("rows with an empty group value land in a — bucket", () => {
    const rows = [row("r1", "", "doctor", "2026-01-01")];
    const sections = buildSections(rows, CONFIG, state({ groupBy: "state" }));
    expect(sections[0].label).toBe("—");
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
    const sorted = sortRows(ROWS, CONFIG, state({ sortBy: "created", sortDir: "asc" }));
    expect(sorted.map((r) => r.created_at)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
  });

  test("custom column sort evaluates nested payload path", () => {
    const sorted = sortRows(ROWS, CONFIG, state({ sortBy: "custom:payload.priority", sortDir: "asc" }));
    expect(sorted[0].id).toBe("r1"); // priority 1
    expect(sorted[1].id).toBe("r3"); // priority 2
    expect(sorted[2].id).toBe("r2"); // priority 3
  });

  test("does not mutate its input", () => {
    const copy = [...ROWS];
    sortRows(ROWS, CONFIG, state({ sortBy: "created" }));
    expect(ROWS).toEqual(copy);
  });
});

describe("flattenSections", () => {
  test("skips collapsed sections and collapsed sub-sections", () => {
    const sections = buildSections(ROWS, CONFIG, state({ groupBy: "state", subGroupBy: "agent" }));
    const flatAll = flattenSections(sections, []);
    expect(flatAll).toHaveLength(ROWS.length);

    const flatClosedRunning = flattenSections(sections, ["RUNNING"]);
    expect(flatClosedRunning.map((r) => r.state)).not.toContain("RUNNING");

    const flatClosedSub = flattenSections(sections, ["RUNNING∕doctor"]);
    expect(flatClosedSub.find((r) => r.id === "r4")).toBeUndefined();
    expect(flatClosedSub.find((r) => r.id === "r2")).toBeDefined();
  });
});

describe("state transitions & custom columns (WM-214)", () => {
  test("toggleCollapsed round-trips", () => {
    const s1 = toggleCollapsed(state(), "RUNNING");
    expect(s1.collapsed).toEqual(["RUNNING"]);
    const s2 = toggleCollapsed(s1, "RUNNING");
    expect(s2.collapsed).toEqual([]);
  });

  test("addCustomColumn and removeCustomColumn work cleanly", () => {
    const s1 = addCustomColumn(state(), "payload.repo");
    expect(s1.customColumns).toEqual(["payload.repo"]);
    expect(visibleColumns(CONFIG, s1).map((c) => c.key)).toContain("custom:payload.repo");

    const s2 = removeCustomColumn(s1, "payload.repo");
    expect(s2.customColumns).toEqual([]);
    expect(visibleColumns(CONFIG, s2).map((c) => c.key)).not.toContain("custom:payload.repo");
  });

  test("cycleColumnSort walks custom column sort cycle", () => {
    let s = state({ customColumns: ["payload.repo"] });
    s = cycleColumnSort(CONFIG, s, "custom:payload.repo");
    expect(s.sortBy).toBe("custom:payload.repo");
    expect(s.sortDir).toBe("asc");

    s = cycleColumnSort(CONFIG, s, "custom:payload.repo");
    expect(s.sortBy).toBe("custom:payload.repo");
    expect(s.sortDir).toBe("desc");

    s = cycleColumnSort(CONFIG, s, "custom:payload.repo");
    expect(s.sortBy).toBe(DEFAULT_ORDER);
  });

  test("toggleColumn hides and shows; visibleColumns honours always", () => {
    const s1 = toggleColumn(state(), "agent");
    expect(s1.hiddenColumns).toContain("agent");
    expect(visibleColumns(CONFIG, s1).map((c) => c.key)).toEqual(["id"]);

    const s2 = toggleColumn(s1, "agent");
    expect(visibleColumns(CONFIG, s2).map((c) => c.key)).toEqual(["id", "agent"]);
  });
});

describe("persistence", () => {
  test("round-trips through localStorage with customColumns", () => {
    const original = state({
      groupBy: "state",
      sortBy: "created",
      sortDir: "desc",
      showEmpty: true,
      hiddenColumns: ["agent"],
      collapsed: ["RUNNING"],
      customColumns: ["payload.repo"],
    });
    saveDisplayState(CONFIG, original);
    const loaded = loadDisplayState(CONFIG);
    expect(loaded).toEqual(original);
  });

  test("garbage and unknown keys fall back field by field", () => {
    localStorage.setItem(
      "evrt-display-test",
      JSON.stringify({
        groupBy: "nonexistent",
        sortBy: "bogus",
        sortDir: "sideways",
        showEmpty: "not-a-bool",
        hiddenColumns: ["invalid", "agent"],
        collapsed: 123,
      }),
    );
    const loaded = loadDisplayState(CONFIG);
    expect(loaded.groupBy).toBe(NONE);
    expect(loaded.sortBy).toBe(DEFAULT_ORDER);
    expect(loaded.sortDir).toBe("asc");
    expect(loaded.showEmpty).toBe(false);
    expect(loaded.hiddenColumns).toEqual(["agent"]);
  });

  test("isDefaultDisplayState detects deviation including customColumns", () => {
    expect(isDefaultDisplayState(CONFIG, state())).toBe(true);
    expect(isDefaultDisplayState(CONFIG, state({ customColumns: ["payload.repo"] }))).toBe(false);
    expect(isDefaultDisplayState(CONFIG, state({ groupBy: "state" }))).toBe(false);
  });
});

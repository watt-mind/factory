import { describe, expect, test } from "bun:test";
import { NAV } from "../nav";
import {
  LIST_VERBS,
  NAV as REGISTRY_NAV,
  RESERVED_GO_SUFFIXES,
  VIEWS,
  artifactBackPath,
  findView,
  navIsCurrent,
  resolveView,
  viewLabel,
} from "./registry";

describe("view registry (WM-839)", () => {
  test("artifact reader returns to its explicit catalogue context or the plain fallback", () => {
    const digest = "a".repeat(64);
    expect(
      artifactBackPath(
        `#/artifact/${digest}?back=artifacts%2F${digest}%3Fkind%3Dtranscript%26search%3Df99e8b%26project%3Dfactory`,
      ),
    ).toBe(`artifacts/${digest}?kind=transcript&search=f99e8b&project=factory`);
    expect(artifactBackPath(`#/artifact/${digest}`)).toBe("artifacts");
  });

  test("every view has a unique key", () => {
    const keys = VIEWS.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Every key is a usable first hash segment.
    for (const key of keys) expect(key).toMatch(/^[a-z]+$/);
  });

  test("every `g` chord suffix is unique and a single lowercase letter", () => {
    const chords = NAV.map((n) => n.go);
    expect(new Set(chords).size).toBe(chords.length);
    for (const go of chords) expect(go).toMatch(/^[a-z]$/);
  });

  test("no `g` chord collides with a reserved suffix (list verb or context chord)", () => {
    // The rule from the registry header: list verbs (`LIST_VERBS`) would
    // double-fire under `g`, `g i` and `g 0`–`g 9` are the context chords
    // (WM-235), and `g h` is the Projects "open on GitHub" chord.
    for (const n of NAV) {
      expect(RESERVED_GO_SUFFIXES.has(n.go)).toBe(false);
    }
    expect(LIST_VERBS.length).toBeGreaterThan(0);
    for (const verb of LIST_VERBS) {
      expect(verb.keys).toMatch(/^[a-z]$/);
      expect(RESERVED_GO_SUFFIXES.has(verb.keys)).toBe(true);
    }
    expect(RESERVED_GO_SUFFIXES.has("i")).toBe(true);
    expect(RESERVED_GO_SUFFIXES.has("h")).toBe(true);
    for (let d = 0; d <= 9; d++)
      expect(RESERVED_GO_SUFFIXES.has(String(d))).toBe(true);
  });

  test("NAV is a projection of VIEWS: same objects, rail order, only chorded views", () => {
    expect(NAV).toBe(REGISTRY_NAV);
    const chorded = VIEWS.filter((v) => v.go !== undefined);
    expect(NAV.length).toBe(chorded.length);
    NAV.forEach((n, i) => {
      // Same object reference: mutating a NAV entry (goSequence.test does) is
      // seen by everything that derives from VIEWS.
      expect(n === chorded[i]).toBe(true);
      expect(n.group).toBeDefined();
    });
    expect(NAV.map((n) => n.key)).toEqual([
      "overview",
      "metrics",
      "inbox",
      "proposals",
      "runs",
      "events",
      "tickets",
      "chains",
      "projects",
      "artifacts",
      "agents",
      "workers",
      "schedules",
      "graph",
      "settings",
    ]);
  });

  test("every view declares a loader and its focus params", () => {
    for (const v of VIEWS) {
      expect(typeof v.load).toBe("function");
      expect(v.label.length).toBeGreaterThan(0);
    }
    expect(findView("runs")?.params).toEqual([":id"]);
    expect(findView("chain")?.params).toEqual([":correlationId", ":nodeId"]);
    expect(findView("settings")?.params).toEqual([":section"]);
    expect(findView("events")?.params).toEqual([":source", ":eventId"]);
  });

  test("drill-in routes keep their parent nav entry current", () => {
    expect(findView("run")?.parent).toBe("runs");
    expect(findView("prs")?.parent).toBe("tickets");
    expect(findView("chain")?.parent).toBe("chains");
    expect(findView("artifact")?.parent).toBe("artifacts");
    expect(navIsCurrent("runs", "run")).toBe(true);
    expect(navIsCurrent("tickets", "prs")).toBe(true);
    expect(navIsCurrent("chains", "chain")).toBe(true);
    expect(navIsCurrent("events", "chain")).toBe(false);
    expect(navIsCurrent("overview", undefined)).toBe(false);
  });

  test("resolveView maps a hash route to a view and its params", () => {
    expect(resolveView([]).def.key).toBe("overview");
    expect(resolveView(["overview"]).def.key).toBe("overview");
    expect(resolveView(["runs", "run_1"])).toMatchObject({
      def: { key: "runs" },
      params: ["run_1"],
    });
    expect(resolveView(["chain", "corr_1", "node_2"])).toMatchObject({
      def: { key: "chain" },
      params: ["corr_1", "node_2"],
    });
    expect(resolveView(["settings", "storage"])).toMatchObject({
      def: { key: "settings" },
      params: ["storage"],
    });
    // Unknown first segment: the existing not-found behaviour is Overview.
    expect(resolveView(["nope"]).def.key).toBe("overview");
    expect(resolveView(["nope", "x"]).params).toEqual([]);
  });

  test("id-less drill-in routes fall back to their list view", () => {
    // `#/run` without an id showed Runs before the registry; keep that.
    expect(resolveView(["run"]).def.key).toBe("runs");
    expect(resolveView(["run", "run_9"]).def.key).toBe("run");
    expect(resolveView(["artifact"]).def.key).toBe("artifacts");
    expect(resolveView(["artifact", "sha256:1"]).def.key).toBe("artifact");
    // `#/chain` without a correlation id fell through to Overview.
    expect(resolveView(["chain"]).def.key).toBe("overview");
    // `#/prs` without a number is the PR picker, not a fallback.
    expect(resolveView(["prs"]).def.key).toBe("prs");
  });

  test("viewLabel names drill-in views and defaults to Overview", () => {
    expect(viewLabel("runs")).toBe("Runs");
    expect(viewLabel("run")).toBe("Run");
    expect(viewLabel("prs")).toBe("PR");
    expect(viewLabel("chain")).toBe("Chain");
    expect(viewLabel("artifact")).toBe("Artifact");
    expect(viewLabel("nope")).toBe("Overview");
    expect(viewLabel(undefined)).toBe("Overview");
  });
});

import { describe, expect, test } from "bun:test";
import {
  CONTEXT_STORAGE_KEY,
  INFLIGHT,
  contextFromProject,
  matchesInFlight,
  matchesRepo,
  projectFromContext,
  readContextTabs,
  rememberOpenRepo,
  toggleInflight,
} from "./context";

describe("contextFromProject / projectFromContext", () => {
  test("null and all are All; inflight is reserved; anything else is a repo", () => {
    expect(contextFromProject(null)).toEqual({ kind: "all" });
    expect(contextFromProject("all")).toEqual({ kind: "all" });
    expect(contextFromProject(INFLIGHT)).toEqual({ kind: "inflight" });
    expect(contextFromProject("bj29")).toEqual({ kind: "repo", name: "bj29" });
    expect(projectFromContext({ kind: "all" })).toBeNull();
    expect(projectFromContext({ kind: "inflight" })).toBe(INFLIGHT);
    expect(projectFromContext({ kind: "repo", name: "bj29" })).toBe("bj29");
  });
});

describe("matchesRepo / matchesInFlight", () => {
  test("All and In flight pass every row; a repo tab requires the name", () => {
    expect(matchesRepo([], { kind: "all" })).toBe(true);
    expect(matchesRepo([], { kind: "inflight" })).toBe(true);
    expect(matchesRepo([], { kind: "repo", name: "bj29" })).toBe(false);
    expect(matchesRepo(["ok", "bj29"], { kind: "repo", name: "bj29" })).toBe(true);
    expect(matchesRepo(undefined, { kind: "repo", name: "bj29" })).toBe(false);
  });

  test("In flight is LEASED or RUNNING only", () => {
    expect(matchesInFlight("COMPLETED", { kind: "all" })).toBe(true);
    expect(matchesInFlight("LEASED", { kind: "inflight" })).toBe(true);
    expect(matchesInFlight("RUNNING", { kind: "inflight" })).toBe(true);
    expect(matchesInFlight("QUEUED", { kind: "inflight" })).toBe(false);
    expect(matchesInFlight("LEASED", { kind: "repo", name: "bj29" })).toBe(true);
  });
});

describe("readContextTabs", () => {
  test("empty, invalid, and reserved names", () => {
    expect(readContextTabs(null)).toEqual({ openRepos: [], active: "all" });
    expect(readContextTabs("{")).toEqual({ openRepos: [], active: "all" });
    expect(readContextTabs(JSON.stringify({ openRepos: ["bj29", "all", INFLIGHT, ""], active: "bj29" }))).toEqual({
      openRepos: ["bj29"],
      active: "bj29",
    });
    expect(readContextTabs(JSON.stringify({ openRepos: ["ok"], active: "gone" }))).toEqual({
      openRepos: ["ok"],
      active: "all",
    });
    expect(CONTEXT_STORAGE_KEY).toBe("factory.contextTabs");
  });
});

describe("toggleInflight", () => {
  test("In flight from any other context; All when already in flight", () => {
    expect(toggleInflight({ kind: "all" })).toEqual({ kind: "inflight" });
    expect(toggleInflight({ kind: "repo", name: "bj29" })).toEqual({ kind: "inflight" });
    expect(toggleInflight({ kind: "inflight" })).toEqual({ kind: "all" });
  });
});

describe("rememberOpenRepo", () => {
  test("appends a real repo once", () => {
    expect(rememberOpenRepo(["ok"], "bj29")).toEqual(["ok", "bj29"]);
    expect(rememberOpenRepo(["bj29"], "bj29")).toEqual(["bj29"]);
    expect(rememberOpenRepo([], INFLIGHT)).toEqual([]);
    expect(rememberOpenRepo([], "all")).toEqual([]);
  });
});

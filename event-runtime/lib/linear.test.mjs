import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  TICKET_SUPPLY_CACHE_TTL_MS,
  clearLinearSupplyCache,
  countOpenIssues,
  loadLinearSupply,
  setLinearSupplyBudget,
  setLinearSupplyGql,
} from "./linear.mjs";

// Pin a healthy budget by default so loadLinearSupply() exercises its GraphQL
// path deterministically. readBudget() otherwise falls back to the on-disk
// Linear budget of whatever host runs the suite (the self-hosted CI runner's
// real budget is often exhausted), which would non-deterministically short
// these tests to `linear_budget_exhausted`. The budget-exhaustion case is
// still exercised: its test injects `{ remaining: 0 }` explicitly.
beforeEach(() => {
  setLinearSupplyBudget({ remaining: 2000, limit: 2500 });
});

afterEach(() => {
  clearLinearSupplyCache();
  setLinearSupplyGql(null);
  setLinearSupplyBudget(undefined);
});

function issue(state, { assignee = null, labels = [] } = {}) {
  return {
    state: { name: state },
    assignee,
    labels: { nodes: labels.map((name) => ({ name })) },
  };
}

describe("countOpenIssues (WM-824)", () => {
  test("ready is Todo + unassigned + ai:agent-ready", () => {
    expect(
      countOpenIssues([
        issue("Triage"),
        issue("Todo", { labels: ["ai:agent-ready"] }),
        issue("Todo", { assignee: { id: "u1" }, labels: ["ai:agent-ready"] }),
        issue("Todo", { labels: ["type:bug"] }),
        issue("In Progress"),
        issue("Blocked"),
        issue("In Review"),
        issue("Done"),
      ]),
    ).toEqual({
      triage: 1,
      ready: 1,
      inFlight: 1,
      blocked: 1,
      inReview: 1,
    });
  });

  test("accepts a flat labels array", () => {
    expect(
      countOpenIssues([
        {
          state: { name: "Todo" },
          assignee: null,
          labels: [{ name: "ai:agent-ready" }],
        },
      ]).ready,
    ).toBe(1);
  });
});

describe("loadLinearSupply (WM-824)", () => {
  const repos = [
    { name: "factory", team: "WM", project: "Factory" },
    { name: "bj29", team: "CLNT", project: "BJ29 Coaching" },
    { name: "no-team", team: null, project: null },
  ];

  test("queries Linear per team+project and maps counts onto repos", async () => {
    const calls = [];
    setLinearSupplyGql(async (query, variables) => {
      calls.push({ query, variables });
      const nodes =
        variables.t === "WM"
          ? [issue("Triage"), issue("Todo", { labels: ["ai:agent-ready"] })]
          : [issue("In Progress"), issue("In Progress")];
      return { issues: { nodes, pageInfo: { hasNextPage: false } } };
    });
    const snap = await loadLinearSupply(repos, { nowMs: 1_700_000_000_000 });
    expect(snap.ok).toBe(true);
    expect(snap.cached).toBe(false);
    expect(snap.byRepo.factory).toEqual({
      triage: 1,
      ready: 1,
      inFlight: 0,
      blocked: 0,
      inReview: 0,
    });
    expect(snap.byRepo.bj29.inFlight).toBe(2);
    expect(snap.byRepo["no-team"]).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0].variables).toEqual({
      t: "WM",
      p: "Factory",
      after: null,
    });
  });

  test("TTL cache avoids a second GraphQL round-trip until refresh", async () => {
    const oneRepo = [{ name: "factory", team: "WM", project: "Factory" }];
    let calls = 0;
    setLinearSupplyGql(async () => {
      calls += 1;
      return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
    });
    const first = await loadLinearSupply(oneRepo, { nowMs: 1_000 });
    const cached = await loadLinearSupply(oneRepo, { nowMs: 1_000 + 10_000 });
    expect(first.cached).toBe(false);
    expect(cached.cached).toBe(true);
    expect(calls).toBe(1);
    const refreshed = await loadLinearSupply(oneRepo, {
      nowMs: 1_000 + 10_000,
      refresh: true,
    });
    expect(refreshed.cached).toBe(false);
    expect(calls).toBe(2);
    await loadLinearSupply(oneRepo, {
      nowMs: 1_000 + 10_000 + TICKET_SUPPLY_CACHE_TTL_MS + 1,
    });
    expect(calls).toBe(3);
  });

  test("coalesces concurrent callers onto one GraphQL fetch", async () => {
    const oneRepo = [{ name: "factory", team: "WM", project: "Factory" }];
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    setLinearSupplyGql(async () => {
      calls += 1;
      await gate;
      return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
    });
    const a = loadLinearSupply(oneRepo, { nowMs: 1_000 });
    const b = loadLinearSupply(oneRepo, { nowMs: 1_000, refresh: true });
    release();
    const [left, right] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
  });

  test("skips Linear when remaining budget is 0", async () => {
    let calls = 0;
    setLinearSupplyBudget({ remaining: 0, limit: 2500 });
    setLinearSupplyGql(async () => {
      calls += 1;
      return { issues: { nodes: [] } };
    });
    const snap = await loadLinearSupply(repos, { nowMs: 1_000 });
    expect(snap.ok).toBe(false);
    expect(snap.error).toBe("linear_budget_exhausted");
    expect(snap.budget).toEqual({ remaining: 0, limit: 2500 });
    expect(calls).toBe(0);
  });

  test("returns a fallback error instead of throwing when GraphQL fails", async () => {
    setLinearSupplyGql(async () => {
      throw new Error("RATELIMITED");
    });
    const snap = await loadLinearSupply(repos, { nowMs: 1_000 });
    expect(snap.ok).toBe(false);
    expect(snap.error).toBe("RATELIMITED");
    expect(snap.byRepo).toEqual({});
  });
});

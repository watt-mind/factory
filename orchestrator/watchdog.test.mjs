import { test, expect } from "bun:test";
import {
  formatWatchdogReport,
  idleApprovalGateReason,
  idleTickFailureCode,
  inFlightFromByState,
  liveIdleWatchdogDeps,
  runIdleWatchdogTick,
  runWatchdogCheck,
} from "./watchdog.mjs";

test("formatWatchdogReport formats clean watchdog status", () => {
  const cleanResult = {
    ok: true,
    issues: [],
    metrics: {
      apiOk: true,
      webOk: true,
      workersCount: 3,
      runningRuns: 1,
      wedgedRuns: 0,
      queuedRuns: 0,
      anomalies: [],
    },
  };

  const formatted = formatWatchdogReport(cleanResult);
  expect(formatted).toContain("WATCHDOG OK");
  expect(formatted).toContain("Workers: 3");
  expect(formatted).toContain("Running: 1");
});

test("formatWatchdogReport formats critical issues", () => {
  const badResult = {
    ok: false,
    issues: [
      {
        severity: "CRITICAL",
        code: "WEDGED_RUN",
        message: "Run run_test_123 in RUNNING for 55m without progress",
      },
      {
        severity: "WARNING",
        code: "WEB_DOWN",
        message: "Web UI on :7382 unreachable",
      },
    ],
    metrics: {
      apiOk: true,
      webOk: false,
      workersCount: 2,
      runningRuns: 1,
      wedgedRuns: 1,
      queuedRuns: 0,
      anomalies: [],
    },
  };

  const formatted = formatWatchdogReport(badResult);
  expect(formatted).toContain("WATCHDOG CRITICAL");
  expect(formatted).toContain("[CRITICAL]");
  expect(formatted).toContain("WEDGED_RUN");
  expect(formatted).toContain("[WARNING]");
  expect(formatted).toContain("WEB_DOWN");
});

test("runWatchdogCheck detects unreachable API as critical", async () => {
  // A hardcoded port assumes nothing else is listening on it, which a
  // stranger process (or a concurrent worktree) can invalidate (#876).
  // Bind loopback:0 to get OS-assigned ports, then release them
  // immediately so they are unreachable when runWatchdogCheck fetches them.
  const apiProbe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = apiProbe.port;
  apiProbe.stop(true);

  const webProbe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const webPort = webProbe.port;
  webProbe.stop(true);

  const result = await runWatchdogCheck({
    port,
    webPort,
    checkShadowFleet: false,
  });

  expect(result.ok).toBe(false);
  expect(result.issues.some((i) => i.code === "API_DOWN")).toBe(true);
});

/* ---------------- idle watchdog (#1063) ---------------- */

const openProposal = (over = {}) => ({
  id: "prop_1",
  status: "open",
  decision: "run",
  expired: false,
  agent: "work-scan@1",
  created_at: "2026-08-29T10:00:00.000Z",
  ...over,
});

/** A fake factory: every observation and effect the tick can reach. */
function fakeFactory(over = {}) {
  const calls = {
    approved: [],
    injected: [],
    logs: [],
    notified: [],
    supplyReads: 0,
  };
  const state = {};
  const deps = {
    repo: "factory",
    serveOk: async () => true,
    inFlight: async () => 0,
    proposals: async () => [],
    supply: async () => {
      calls.supplyReads += 1;
      return 0;
    },
    approve: async (id) => calls.approved.push(id),
    inject: async (env) => calls.injected.push(env),
    // The live gate reads config/policy.yaml and the spend log; tests state
    // the gate's answer instead of depending on the operator's machine.
    approvalGate: () => null,
    readState: () => state,
    writeState: (next) => Object.assign(state, next),
    notify: (message) => {
      calls.notified.push(message);
      return true;
    },
    log: (line) => calls.logs.push(line),
    now: () => Date.parse("2026-08-29T12:00:00.000Z"),
    ...over,
  };
  return { deps, calls };
}

test("inFlightFromByState counts only non-terminal states, null on garbage", () => {
  expect(
    inFlightFromByState({ RUNNING: 2, LEASED: 1, COMPLETED: 90, PROPOSED: 4 }),
  ).toBe(3);
  expect(inFlightFromByState({ COMPLETED: 12, FAILED: 3 })).toBe(0);
  expect(inFlightFromByState(null)).toBeNull();
  expect(inFlightFromByState({ RUNNING: "many" })).toBeNull();
});

test("idle with dispatchable supply injects one work-scan", async () => {
  const { deps, calls } = fakeFactory({ supply: async () => 3 });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("inject");
  expect(decision.reason).toBe("idle_with_supply");
  expect(calls.injected).toHaveLength(1);
  expect(calls.injected[0].type).toBe("factory.work.requested");
  expect(calls.injected[0].payload).toEqual({
    repo: "factory",
    reason: "idle-watchdog",
  });
  expect(calls.logs).toHaveLength(1);
});

test("busy factory takes no action and never reads the tracker", async () => {
  const { deps, calls } = fakeFactory({
    inFlight: async () => 2,
    supply: async () => 5,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("none");
  expect(decision.reason).toBe("busy");
  expect(calls.injected).toHaveLength(0);
  expect(calls.approved).toHaveLength(0);
  // The expensive read is skipped entirely when the cheap one already answered.
  expect(calls.supplyReads).toBe(0);
});

test("idle with an empty queue takes no action", async () => {
  const { deps, calls } = fakeFactory({ supply: async () => 0 });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("none");
  expect(decision.reason).toBe("no_supply");
  expect(calls.injected).toHaveLength(0);
});

test("an open dispatch proposal is approved instead of injecting a second scan", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "newer", created_at: "2026-08-29T11:00:00.000Z" }),
      openProposal({ id: "older", agent: "dispatch@1" }),
    ],
    supply: async () => 4,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("approve");
  // Oldest first: the proposal that has waited longest is the stall.
  expect(calls.approved).toEqual(["older"]);
  expect(calls.injected).toHaveLength(0);
});

test("only one proposal is approved per tick — no claim-lock burst", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "p1" }),
      openProposal({ id: "p2", created_at: "2026-08-29T10:30:00.000Z" }),
      openProposal({ id: "p3", created_at: "2026-08-29T10:45:00.000Z" }),
    ],
  });
  await runIdleWatchdogTick(deps);
  expect(calls.approved).toEqual(["p1"]);
});

test("human_needed, expired, and foreign-agent proposals are never approved", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "ask", decision: "human_needed" }),
      openProposal({ id: "stale", expired: true }),
      openProposal({ id: "other", agent: "merge-scan@2" }),
      openProposal({ id: "closed", status: "approved" }),
    ],
    supply: async () => 2,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(calls.approved).toHaveLength(0);
  expect(decision.action).toBe("inject");
});

test("serve unreachable skips — an unreadable factory is not an idle one", async () => {
  const { deps, calls } = fakeFactory({
    serveOk: async () => false,
    supply: async () => 9,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("serve_unreachable");
  expect(calls.injected).toHaveLength(0);
  expect(calls.supplyReads).toBe(0);
});

test("a throwing runtime read skips rather than reading zero as idle", async () => {
  const { deps, calls } = fakeFactory({
    inFlight: async () => {
      throw new Error("database is locked");
    },
    supply: async () => 9,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("runtime_state_unreadable");
  expect(calls.injected).toHaveLength(0);
});

test("a failed supply read skips instead of guessing", async () => {
  const { deps, calls } = fakeFactory({
    supply: async () => {
      throw new Error("tracker timeout");
    },
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("supply_unreadable");
  expect(calls.injected).toHaveLength(0);
});

test("injects are rate-limited to one a minute across one-shot ticks", async () => {
  const persisted = {};
  const base = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = base;
  const { deps, calls } = fakeFactory({
    supply: async () => 3,
    readState: () => ({ ...persisted }),
    writeState: (next) => Object.assign(persisted, next),
    now: () => clock,
  });

  expect((await runIdleWatchdogTick(deps)).decision.action).toBe("inject");
  clock = base + 30_000;
  const throttled = await runIdleWatchdogTick(deps);
  expect(throttled.decision.action).toBe("none");
  expect(throttled.decision.reason).toBe("inject_rate_limited");
  clock = base + 61_000;
  expect((await runIdleWatchdogTick(deps)).decision.action).toBe("inject");
  expect(calls.injected).toHaveLength(2);
});

test("a failed effect is logged on the decision, not swallowed", async () => {
  const { deps, calls } = fakeFactory({
    supply: async () => 1,
    inject: async () => {
      throw new Error("HTTP 503");
    },
  });
  const { decision, acted } = await runIdleWatchdogTick(deps);
  expect(acted).toBe(false);
  expect(decision.error).toBe("HTTP 503");
  expect(calls.logs[0]).toContain("error=HTTP 503");
});

test("every tick logs exactly one decision line", async () => {
  const { deps, calls } = fakeFactory({ supply: async () => 2 });
  await runIdleWatchdogTick(deps);
  expect(calls.logs).toHaveLength(1);
  expect(calls.logs[0]).toContain("idle-watchdog action=inject");
  expect(calls.logs[0]).toContain("inFlight=0");
  expect(calls.logs[0]).toContain("supply=2");
});

/* --- the budget/policy gate (#1063 post-review) --- */

test("a refusing budget gate skips instead of approving as operator", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [openProposal({ id: "waiting" })],
    supply: async () => 4,
    approvalGate: () => "budget_exhausted",
  });
  const { decision, acted } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("budget_gate:budget_exhausted");
  expect(acted).toBe(false);
  expect(calls.approved).toHaveLength(0);
  // Never a fall-through to inject: that would only manufacture another
  // proposal nobody is allowed to approve.
  expect(calls.injected).toHaveLength(0);
});

test("a refusing gate also blocks the inject path", async () => {
  const { deps, calls } = fakeFactory({
    supply: async () => 2,
    approvalGate: () => "runtime_policy_unavailable",
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("budget_gate:runtime_policy_unavailable");
  expect(calls.injected).toHaveLength(0);
});

test("a throwing gate is a refusal, never an approval", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [openProposal({ id: "waiting" })],
    approvalGate: () => {
      throw new Error("policy unreadable");
    },
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.reason).toBe("budget_gate:gate_check_failed");
  expect(calls.approved).toHaveLength(0);
});

test("proposals auto-approval refused on resource grounds are never approved", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({
        id: "budget",
        reason: "auto_approval_ineligible:budget_exhausted",
      }),
      openProposal({
        id: "capacity",
        reason: "auto_approval_ineligible:worker_cap_full",
      }),
      openProposal({
        id: "expired",
        reason: "auto_approval_ineligible:proposal_expired",
      }),
      openProposal({
        id: "policy",
        reason: "auto_approval_ineligible:runtime_policy_unavailable",
      }),
    ],
    supply: async () => 1,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(calls.approved).toHaveLength(0);
  expect(decision.action).toBe("inject");
});

test("a proposal deferred only because work was in flight is still approvable", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({
        id: "deferred",
        reason: "auto_approval_ineligible:dispatch_recheck_deferred",
      }),
    ],
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("approve");
  expect(calls.approved).toEqual(["deferred"]);
});

test("idleApprovalGateReason refuses without a runtime policy on disk", () => {
  expect(idleApprovalGateReason({ runtimePolicy: null })).toBe(
    "runtime_policy_unavailable",
  );
  expect(
    idleApprovalGateReason({
      runtimePolicy: { budget: { per_day_usd: 200 } },
      budgetCheck: () => "day budget spent",
    }),
  ).toBe("budget_exhausted");
  expect(
    idleApprovalGateReason({
      runtimePolicy: { budget: { per_day_usd: 200 } },
      budgetCheck: () => {
        throw new Error("no log dir");
      },
    }),
  ).toBe("budget_check_failed");
  expect(
    idleApprovalGateReason({
      runtimePolicy: { budget: { per_day_usd: 200 } },
      budgetCheck: () => null,
    }),
  ).toBeNull();
});

/* --- repeated-failure alert --- */

test("idleTickFailureCode counts blind ticks, not deliberate refusals", () => {
  expect(
    idleTickFailureCode({ action: "skip", reason: "serve_unreachable" }),
  ).toBe("serve_unreachable");
  expect(idleTickFailureCode({ action: "approve", error: "HTTP 401" })).toBe(
    "effect_failed",
  );
  expect(
    idleTickFailureCode({
      action: "skip",
      reason: "budget_gate:budget_exhausted",
    }),
  ).toBeNull();
  expect(idleTickFailureCode({ action: "none", reason: "busy" })).toBeNull();
});

test("three failed ticks in a row alert once, and notify at most hourly", async () => {
  const base = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = base;
  const persisted = {};
  const { deps, calls } = fakeFactory({
    proposals: async () => [openProposal({ id: "waiting" })],
    approve: async () => {
      throw new Error("HTTP 401");
    },
    readState: () => ({ ...persisted }),
    writeState: (next) => Object.assign(persisted, next),
    now: () => clock,
  });

  const first = await runIdleWatchdogTick(deps);
  expect(first.alerted).toBe(false);
  clock = base + 300_000;
  expect((await runIdleWatchdogTick(deps)).alerted).toBe(false);
  expect(calls.logs.filter((l) => l.includes("ALERT"))).toHaveLength(0);

  clock = base + 600_000;
  const third = await runIdleWatchdogTick(deps);
  expect(third.alerted).toBe(true);
  expect(calls.logs.at(-1)).toContain(
    "idle-watchdog ALERT repeated_failures=3",
  );
  expect(calls.notified).toHaveLength(1);

  // A fourth failure still logs the alert but does not re-notify inside the hour.
  clock = base + 900_000;
  const fourth = await runIdleWatchdogTick(deps);
  expect(fourth.alerted).toBe(false);
  expect(calls.logs.at(-1)).toContain("repeated_failures=4");
  expect(calls.notified).toHaveLength(1);

  // An hour later it is allowed to shout again.
  clock = base + 3_600_000 + 700_000;
  expect((await runIdleWatchdogTick(deps)).alerted).toBe(true);
  expect(calls.notified).toHaveLength(2);
});

test("one healthy tick clears the failure streak", async () => {
  const base = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = base;
  const persisted = {};
  let up = false;
  const { deps, calls } = fakeFactory({
    serveOk: async () => up,
    readState: () => ({ ...persisted }),
    writeState: (next) => Object.assign(persisted, next),
    now: () => clock,
  });

  await runIdleWatchdogTick(deps);
  clock = base + 60_000;
  await runIdleWatchdogTick(deps);
  expect(persisted.failureStreak).toBe(2);

  up = true;
  clock = base + 120_000;
  await runIdleWatchdogTick(deps);
  expect(persisted.failureStreak).toBe(0);

  up = false;
  clock = base + 180_000;
  await runIdleWatchdogTick(deps);
  expect(persisted.failureStreak).toBe(1);
  expect(calls.logs.filter((l) => l.includes("ALERT"))).toHaveLength(0);
});

/* --- ordering over the full open set --- */

test("the oldest approvable proposal wins however the API ordered the page", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "c", created_at: "2026-08-29T11:30:00.000Z" }),
      openProposal({ id: "a", created_at: "2026-08-29T09:00:00.000Z" }),
      openProposal({ id: "b", created_at: "2026-08-29T10:15:00.000Z" }),
    ],
  });
  await runIdleWatchdogTick(deps);
  expect(calls.approved).toEqual(["a"]);
});

test("live deps page open proposals newest-first and keep every page", async () => {
  const seen = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/proposals") return new Response("{}");
      seen.push(url.search);
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.get("status")).toBe("open");
      const before = url.searchParams.get("before");
      return Response.json(
        before
          ? { proposals: [{ id: "old" }], nextBefore: null }
          : { proposals: [{ id: "new" }], nextBefore: "cursor1" },
      );
    },
  });
  try {
    const { proposals } = liveIdleWatchdogDeps({ port: server.port });
    const rows = await proposals();
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("before=cursor1");
  } finally {
    server.stop(true);
  }
});

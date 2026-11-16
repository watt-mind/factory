import { test, expect } from "bun:test";
import { computeCapacity, formatPulse, gatherPulse } from "./pulse.mjs";

test("formatPulse renders structured pulse text", () => {
  const samplePulse = {
    timestamp: "2026-08-16T20:00:00.000Z",
    stack: {
      api: { ok: true, policyVersion: "git:test1234" },
      web: { ok: true },
      workers: { total: 3, busy: 1, idle: 2, list: [] },
    },
    runs: {
      active: [
        {
          runId: "run_test_123456",
          agent: "dispatch@1",
          state: "RUNNING",
          created_at: new Date(Date.now() - 5 * 60000).toISOString(),
          eventId: "test:event",
        },
      ],
      proposed: 0,
      byState: { RUNNING: 1, COMPLETED: 10 },
    },
    supply: {
      repo: "factory",
      team: "WM",
      dispatchable: 5,
      triage: 20,
      tickets: [{ identifier: "WM-100", title: "Sample ticket title" }],
      truncated: true,
    },
    prs: {
      total: 1,
      candidates: [
        {
          number: 99,
          title: "Fix sample bug",
          headRefName: "feat/sample",
          isDraft: false,
          ciStatus: "PASSING",
        },
      ],
    },
    workspace: {
      branch: "develop",
      head: "abc1234",
      behind: 0,
      ahead: 0,
      clean: true,
    },
  };

  const output = formatPulse(samplePulse);
  expect(output).toContain("FACTORY PULSE");
  expect(output).toContain("STACK & WORKERS");
  expect(output).toContain("API (:7381):");
  expect(output).toContain("git:test1234");
  expect(output).toContain("IN-FLIGHT RUNS");
  expect(output).toContain("run_test_123");
  expect(output).toContain("LINEAR SUPPLY (WM)");
  expect(output).toContain("5 tickets");
  expect(output).toContain("(truncated)");
  expect(output).toContain("WM-100");
  expect(output).toContain("#99");
  expect(output).toContain("[CI PASS]");
});

function linearIssue(number, { ready = false, triage = false } = {}) {
  return {
    id: `issue-${number}`,
    identifier: `WM-${number}`,
    title: `Issue ${number}`,
    state: { name: triage ? "Triage" : "Todo" },
    labels: { nodes: ready ? [{ name: "ai:agent-ready" }] : [] },
    assignee: null,
  };
}

// Bind loopback:0 for an OS-assigned port, then release it immediately so
// gatherPulse's /health probe hits nothing instead of a live local stack.
function deadPort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function testWorkspaceProbe(args) {
  const outputByCommand = {
    "git branch --show-current": "test-branch",
    "git rev-parse --short HEAD": "test-head",
    "git status --porcelain": "",
    "git rev-list --count HEAD..origin/develop": "2",
    "git rev-list --count origin/develop..HEAD": "3",
  };
  return { ok: true, out: outputByCommand[args.join(" ")] ?? "", err: "" };
}

test("gatherPulse counts qualifying Linear issues across pages", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    linearIssue(index + 1, {
      ready: index < 45,
      triage: index >= 45 && index < 55,
    }),
  );
  const secondPage = Array.from({ length: 20 }, (_, index) =>
    linearIssue(index + 101, {
      ready: index < 10,
      triage: index >= 10 && index < 15,
    }),
  );
  const calls = [];
  const controlPlane = {
    raw(query, variables) {
      calls.push({ query, variables });
      return Promise.resolve(
        variables.after
          ? {
              issues: {
                nodes: secondPage,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          : {
              issues: {
                nodes: firstPage,
                pageInfo: { hasNextPage: true, endCursor: "page-2" },
              },
            },
      );
    },
  };

  const pulse = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchGitHub: false,
    controlPlane,
    workspaceProbe: testWorkspaceProbe,
  });

  expect(pulse.supply.dispatchable).toBe(55);
  expect(pulse.supply.triage).toBe(15);
  expect(pulse.supply.tickets).toHaveLength(5);
  expect(pulse.supply.truncated).toBe(false);
  expect(calls).toHaveLength(2);
  expect(calls[0].query).toContain('state:{name:{in:["Todo","Triage"]}}');
  expect(calls[1].variables.after).toBe("page-2");
  expect(pulse.workspace).toEqual({
    branch: "test-branch",
    head: "test-head",
    behind: 2,
    ahead: 3,
    clean: true,
  });
});

test("gatherPulse marks Linear supply as truncated at the page cap", async () => {
  const calls = [];
  const controlPlane = {
    raw(_query, variables) {
      calls.push(variables);
      return Promise.resolve({
        issues: {
          nodes: [linearIssue(calls.length, { ready: true })],
          pageInfo: { hasNextPage: true, endCursor: `page-${calls.length}` },
        },
      });
    },
  };

  const pulse = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchGitHub: false,
    controlPlane,
    workspaceProbe: testWorkspaceProbe,
  });

  expect(calls).toHaveLength(5);
  expect(pulse.supply.dispatchable).toBe(5);
  expect(pulse.supply.truncated).toBe(true);
});

test("gatherPulse uses the configured dead web port instead of the default", async () => {
  // A hardcoded port assumes nothing else is listening on it, which a
  // stranger process (or a concurrent worktree) can invalidate (#876).
  const webPort = 9876;
  const webRequests = [];
  const pulse = await gatherPulse({
    port: deadPort(),
    webPort,
    fetchLinear: false,
    fetchGitHub: false,
    webFetch: async (url) => {
      webRequests.push(url);
      throw new Error("web intentionally unreachable");
    },
    workspaceProbe: testWorkspaceProbe,
  });

  expect(pulse.stack.api.ok).toBe(false);
  expect(pulse.stack.web.ok).toBe(false);
  expect(webRequests).toEqual([`http://127.0.0.1:${webPort}/`]);
  expect(webRequests.some((url) => url.includes(":7382/"))).toBe(false);
  expect(pulse.stack.workers.total).toBe(0);
  expect(pulse.runs.active.length).toBe(0);
});

test("gatherPulse sends the control API bearer on protected reads", async () => {
  const token = "pulse-control-token";
  const authorization = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/")
        authorization.push(req.headers.get("authorization"));
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname === "/status")
        return Response.json({ runs: { byState: {} } });
      if (url.pathname === "/workers") return Response.json({ workers: [] });
      if (url.pathname === "/runs") return Response.json({ runs: [] });
      return new Response("not found", { status: 404 });
    },
  });
  const previous = process.env.FACTORY_CONTROL_API_TOKEN;
  process.env.FACTORY_CONTROL_API_TOKEN = token;

  try {
    const pulse = await gatherPulse({
      port: server.port,
      webPort: server.port,
      fetchLinear: false,
      fetchGitHub: false,
      workspaceProbe: testWorkspaceProbe,
    });
    expect(pulse.stack.api.ok).toBe(true);
    expect(authorization.length).toBeGreaterThanOrEqual(4);
    expect(authorization).toEqual(
      Array(authorization.length).fill(`Bearer ${token}`),
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_CONTROL_API_TOKEN;
    else process.env.FACTORY_CONTROL_API_TOKEN = previous;
    server.stop(true);
  }
});

test("gatherPulse surfaces a failed protected read even when /health is fine", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health")
        return Response.json({ ok: true, policyVersion: "pv-1" });
      if (url.pathname === "/workers")
        return new Response("boom", { status: 500 });
      if (url.pathname === "/status")
        return Response.json({ runs: { byState: {} } });
      if (url.pathname === "/runs") return Response.json({ runs: [] });
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const pulse = await gatherPulse({
      port: server.port,
      webPort: server.port,
      fetchLinear: false,
      fetchGitHub: false,
      workspaceProbe: testWorkspaceProbe,
    });
    expect(pulse.stack.api.ok).toBe(false);
    expect(pulse.stack.api.code).toBe("API_ERROR");
    expect(pulse.stack.api.error).toContain("API_ERROR");
    expect(pulse.stack.api.policyVersion).toBe("pv-1");
  } finally {
    server.stop(true);
  }
});

test("computeCapacity coerces inputs and computes verdicts with precedence", () => {
  const widen = computeCapacity({
    activeRuns: "2",
    queuedRuns: -3,
    runnerCap: 8,
    openReadyPrs: 3,
    mergedLastHour: 4,
    mergeBatchSize: 8,
  });
  expect(widen).toMatchObject({
    runnerCap: 8,
    activeRuns: 2,
    queuedRuns: 0,
    runnerHeadroom: 6,
    openReadyPrs: 3,
    mergeBatchSize: 8,
    mergedLastHour: 4,
    verdict: "WIDEN",
  });
  expect(widen.reason).toContain("6");
  expect(widen.reason).toContain("3/8");

  const holdQueued = computeCapacity({
    activeRuns: 2,
    queuedRuns: 1,
    runnerCap: 8,
    openReadyPrs: 3,
    mergeBatchSize: 8,
  });
  expect(holdQueued.verdict).toBe("HOLD_OR_BUNDLE");
  expect(holdQueued.reason).toContain("2/8");
  expect(holdQueued.reason).toContain("1 queued");

  const holdAtCap = computeCapacity({
    activeRuns: 8,
    queuedRuns: 0,
    runnerCap: 8,
    openReadyPrs: 2,
    mergeBatchSize: 8,
  });
  expect(holdAtCap.runnerHeadroom).toBe(0);
  expect(holdAtCap.verdict).toBe("HOLD_OR_BUNDLE");

  const drainFirst = computeCapacity({
    activeRuns: 8,
    queuedRuns: 4,
    runnerCap: 8,
    openReadyPrs: 8,
    mergeBatchSize: 8,
  });
  expect(drainFirst.verdict).toBe("DRAIN_MERGES_FIRST");
  expect(drainFirst.reason).toContain("/factory-merge");

  const coerced = computeCapacity({
    queuedRuns: Number.NaN,
    activeRuns: Number.POSITIVE_INFINITY,
    runnerCap: -5,
    openReadyPrs: null,
    mergedLastHour: "bad",
    mergeBatchSize: undefined,
  });
  expect(coerced).toMatchObject({
    queuedRuns: 0,
    activeRuns: 0,
    runnerCap: 0,
    runnerHeadroom: 0,
    openReadyPrs: 0,
    mergedLastHour: 0,
    mergeBatchSize: 8,
    verdict: "HOLD_OR_BUNDLE",
  });
});

test("gatherPulse evaluates capacity, mergedLastHour window, and verdicts with injected forge", async () => {
  const now = Date.parse("2026-11-15T20:00:00.000Z");
  const fakeForge = {
    prList(_repo, { state }) {
      if (state === "open") {
        return [
          {
            number: 1,
            title: "Ready passing",
            headRefName: "feat/1",
            isDraft: false,
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          },
          {
            number: 2,
            title: "Ready pending",
            headRefName: "feat/2",
            isDraft: false,
            statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
          },
          {
            number: 3,
            title: "Draft passing",
            headRefName: "feat/3",
            isDraft: true,
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          },
          {
            number: 4,
            title: "Failing ready",
            headRefName: "feat/4",
            isDraft: false,
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
          },
        ];
      }
      if (state === "merged") {
        return [
          { number: 10, mergedAt: "2026-11-15T19:59:59.000Z" },
          { number: 11, mergedAt: "2026-11-15T19:00:00.000Z" },
          { number: 12, mergedAt: "2026-11-15T18:59:59.000Z" },
          { number: 13, mergedAt: "2026-11-15T20:00:01.000Z" },
          { number: 14, mergedAt: "not-a-date" },
        ];
      }
      return [];
    },
    runList() {
      return [
        { databaseId: 1, status: "in_progress", conclusion: null },
        { databaseId: 2, status: "in_progress", conclusion: null },
        { databaseId: 3, status: "completed", conclusion: "success" },
      ];
    },
  };

  const widenPulse = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchLinear: false,
    forge: fakeForge,
    runnerCap: 6,
    mergeBatchSize: 4,
    now,
    workspaceProbe: testWorkspaceProbe,
  });
  expect(widenPulse.capacity).toMatchObject({
    available: true,
    runnerCap: 6,
    activeRuns: 2,
    queuedRuns: 0,
    runnerHeadroom: 4,
    openReadyPrs: 2,
    mergeBatchSize: 4,
    mergedLastHour: 2,
    verdict: "WIDEN",
  });

  const holdForge = {
    ...fakeForge,
    runList() {
      return [
        { databaseId: 1, status: "in_progress", conclusion: null },
        { databaseId: 2, status: "queued", conclusion: null },
        { databaseId: 3, status: "waiting", conclusion: null },
        { databaseId: 4, status: "pending", conclusion: null },
        { databaseId: 5, status: "requested", conclusion: null },
      ];
    },
  };
  const holdPulse = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchLinear: false,
    forge: holdForge,
    runnerCap: 6,
    mergeBatchSize: 4,
    now,
    workspaceProbe: testWorkspaceProbe,
  });
  expect(holdPulse.capacity).toMatchObject({
    available: true,
    activeRuns: 1,
    queuedRuns: 4,
    verdict: "HOLD_OR_BUNDLE",
  });

  const drainPulse = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchLinear: false,
    forge: holdForge,
    runnerCap: 6,
    mergeBatchSize: 2,
    now,
    workspaceProbe: testWorkspaceProbe,
  });
  expect(drainPulse.capacity).toMatchObject({
    available: true,
    openReadyPrs: 2,
    mergeBatchSize: 2,
    verdict: "DRAIN_MERGES_FIRST",
  });
});

test("gatherPulse isolates forge errors and keeps capacity offline when disabled", async () => {
  const failingRunsForge = {
    prList(_repo, { state }) {
      if (state === "open") {
        return [
          {
            number: 1,
            title: "Ready",
            headRefName: "feat/1",
            isDraft: false,
            statusCheckRollup: [],
          },
        ];
      }
      throw new Error("merged query failed");
    },
    runList() {
      throw new Error("actions api down");
    },
  };

  const degraded = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchLinear: false,
    forge: failingRunsForge,
    workspaceProbe: testWorkspaceProbe,
  });
  expect(degraded.capacity.available).toBe(false);
  expect(degraded.capacity.ciRunError).toContain("actions api down");
  expect(degraded.capacity.mergedError).toContain("merged query failed");
  expect(degraded.capacity.openReadyPrs).toBe(1);

  const offline = await gatherPulse({
    port: deadPort(),
    webPort: deadPort(),
    fetchLinear: false,
    fetchGitHub: false,
    workspaceProbe: testWorkspaceProbe,
  });
  expect(offline.capacity.available).toBe(false);
  expect(offline.capacity.verdict).toBe("WIDEN");
});

test("formatPulse renders CAPACITY & FLOW before WORKSPACE", () => {
  const output = formatPulse({
    timestamp: "2026-11-15T20:00:00.000Z",
    stack: {
      api: { ok: true, policyVersion: "git:abc" },
      web: { ok: true },
      workers: { total: 1, busy: 0, idle: 1, list: [] },
    },
    runs: { active: [], proposed: 0, byState: {} },
    supply: {
      repo: "factory",
      team: "WM",
      dispatchable: 2,
      triage: 0,
      tickets: [],
    },
    prs: { total: 1, candidates: [] },
    capacity: {
      ...computeCapacity({
        activeRuns: 3,
        queuedRuns: 1,
        runnerCap: 8,
        openReadyPrs: 4,
        mergedLastHour: 2,
        mergeBatchSize: 8,
      }),
      available: true,
    },
    workspace: {
      branch: "develop",
      head: "abc1234",
      behind: 0,
      ahead: 0,
      clean: true,
    },
  });

  const capIdx = output.indexOf("CAPACITY & FLOW");
  const wsIdx = output.indexOf("WORKSPACE");
  expect(capIdx).toBeGreaterThan(-1);
  expect(wsIdx).toBeGreaterThan(capIdx);
  expect(output).toContain("3/8 active");
  expect(output).toContain("1 queued");
  expect(output).toContain("5 headroom");
  expect(output).toContain("4/8");
  expect(output).toContain("2");
  expect(output).toContain("HOLD_OR_BUNDLE");
});

import { test, expect } from "bun:test";
import { formatPulse, gatherPulse } from "./pulse.mjs";

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

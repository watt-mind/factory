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
  expect(output).toContain("WM-100");
  expect(output).toContain("#99");
  expect(output).toContain("[CI PASS]");
});

test("gatherPulse handles unreachable API gracefully", async () => {
  // A hardcoded port assumes nothing else is listening on it, which a
  // stranger process (or a concurrent worktree) can invalidate (#876).
  // Bind loopback:0 to get an OS-assigned port, then release it
  // immediately so it is unreachable when gatherPulse fetches it.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);

  const pulse = await gatherPulse({
    port,
    fetchLinear: false,
    fetchGitHub: false,
  });

  expect(pulse.stack.api.ok).toBe(false);
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
    });
    expect(pulse.stack.api.ok).toBe(false);
    expect(pulse.stack.api.code).toBe("API_ERROR");
    expect(pulse.stack.api.error).toContain("API_ERROR");
    expect(pulse.stack.api.policyVersion).toBe("pv-1");
  } finally {
    server.stop(true);
  }
});

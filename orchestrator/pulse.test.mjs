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
  const pulse = await gatherPulse({
    port: 59999, // unreachable port
    fetchLinear: false,
    fetchGitHub: false,
  });

  expect(pulse.stack.api.ok).toBe(false);
  expect(pulse.stack.workers.total).toBe(0);
  expect(pulse.runs.active.length).toBe(0);
});

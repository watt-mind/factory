import { test, expect } from "bun:test";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";
import { tick } from "../cli/serve.mjs";
import { startApi } from "./api.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

test("tick measures durationMs and per-step timings stepMs (WM-1208)", async () => {
  const dbFile = path.join(
    tmpdir(),
    `tick-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = openDb(dbFile);
  const registry = loadRegistry();

  const logs = [];
  const log = (msg) => logs.push(msg);

  const result = await tick({
    db,
    registry,
    policyVersion: "git:test",
    skipPlan: true,
    log,
    subsystems: {
      "tick emit": async () => {
        await Bun.sleep(10);
      },
    },
    autoApproveChainsFn: async () => ({
      approved: [],
      errors: [],
      skipped: 2,
      deadlineSkipped: 2,
    }),
  });

  expect(result.durationMs).toBeGreaterThanOrEqual(9);
  expect(result.stepMs).toBeDefined();
  expect(result.stepMs["tick emit"]).toBeGreaterThanOrEqual(9);
  expect(result.stepMs["plan"]).toBe(0);
  expect(result.deadlineSkipped).toBe(2);
});

test("GET /health exposes tick stats including deadline-truncated approvals", async () => {
  const dbFile = path.join(
    tmpdir(),
    `health-tick-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = openDb(dbFile);
  const registry = loadRegistry();

  let tickStats = {
    lastMs: 42,
    overruns: 2,
    deadlineSkipped: 2,
  };

  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);

  const server = startApi({
    db,
    registry,
    policyVersion: "git:test",
    port,
    getTickStats: () => tickStats,
  });

  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tick).toEqual({
      lastMs: 42,
      overruns: 2,
      deadlineSkipped: 2,
    });

    // Update stats and verify live reflection
    tickStats = { lastMs: 1500, overruns: 3, deadlineSkipped: 0 };
    const res2 = await fetch(`http://127.0.0.1:${port}/health`);
    const body2 = await res2.json();
    expect(body2.tick).toEqual({
      lastMs: 1500,
      overruns: 3,
      deadlineSkipped: 0,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

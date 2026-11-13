import { test, expect } from "bun:test";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";
import { startApi } from "./api.mjs";
import { startPlannerWorker } from "./planner-worker.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";

test("planning runs off the HTTP event loop: /health p95 < 500ms while 10 events plan back-to-back (WM-1208)", async () => {
  const envDir = path.join(
    tmpdir(),
    `off-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(envDir, { recursive: true });
  const dbFile = path.join(envDir, "runtime.db");
  const db = openDb(dbFile);
  const registry = loadRegistry();

  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);

  let tickStats = { lastMs: 10, overruns: 0 };
  let plannerWorker = null;

  const token = "test-token-1208";

  const server = startApi({
    db,
    registry,
    policyVersion: "git:bench",
    port,
    controlApiToken: token,
    env: { name: "test", home: envDir, adapter: "fake" },
    getTickStats: () => tickStats,
    onEvent: () => {
      plannerWorker?.wake();
    },
  });

  await new Promise((resolve) => server.once("listening", resolve));

  plannerWorker = startPlannerWorker({
    eventHome: envDir,
    policyVersion: "git:bench",
    adapterOverride: "fake",
    pollMs: 50,
  });

  try {
    // 1. Inject 10 dispatch events via POST /replay
    for (let i = 0; i < 10; i++) {
      const eventEnvelope = {
        schemaVersion: "factory.event/v1",
        source: "github",
        type: "factory.work.requested",
        eventId: `evt-bench-${i}-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        payload: {
          repo: "factory",
          seed: `seed-${i}-${Date.now()}`,
        },
      };

      const res = await fetch(`http://127.0.0.1:${port}/replay`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(eventEnvelope),
      });
      expect(res.status).toBe(200);
    }

    // 2. While the 10 events are being planned in the background worker,
    // fire 50 rapid GET /health requests and measure latency
    const latencies = [];
    const healthRequests = Array.from({ length: 50 }, async () => {
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      latencies.push(elapsed);
    });

    await Promise.all(healthRequests);

    // Calculate p95 latency
    latencies.sort((a, b) => a - b);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p95Latency = latencies[p95Index];

    console.log(
      `[off-loop-planner] 50 concurrent /health requests during planning:`,
    );
    console.log(
      `  min: ${latencies[0].toFixed(2)}ms | p50: ${latencies[Math.floor(latencies.length * 0.5)].toFixed(2)}ms | p95: ${p95Latency.toFixed(2)}ms | max: ${latencies[latencies.length - 1].toFixed(2)}ms`,
    );

    expect(p95Latency).toBeLessThan(500);

    // 3. Verify all 10 events are planned into proposals within a reasonable deadline
    let plannedCount = 0;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = db.query("SELECT COUNT(*) as count FROM proposals").get();
      plannedCount = rows.count;
      if (plannedCount >= 10) break;
      await Bun.sleep(50);
    }

    expect(plannedCount).toBe(10);

    // 4. The worker posts a `planned` message back to its supervisor, which
    // records lastPlannedAt — the /health staleness signal (gh-1903).
    const stateDeadline = Date.now() + 5_000;
    while (
      Date.now() < stateDeadline &&
      plannerWorker.state().lastPlannedAt == null
    ) {
      await Bun.sleep(50);
    }
    const state = plannerWorker.state({ queued: false });
    expect(state.lastPlannedAt).not.toBeNull();
    expect(state.ageMs).not.toBeNull();
    expect(state.stale).toBe(false);
  } finally {
    if (plannerWorker) await plannerWorker.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(envDir, { recursive: true, force: true });
  }
});

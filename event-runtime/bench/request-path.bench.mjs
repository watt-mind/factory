#!/usr/bin/env bun
/**
 * Benchmark for Control API GET endpoints on production-shaped SQLite DB (WM-1208).
 *
 * Verifies that all GET request handlers perform bounded SQLite reads and
 * complete in <100ms p95 on a DB with ≥4k runs, ≥6k events, ≥1k proposals, ~260MB.
 *
 * Usage:
 *   bun event-runtime/bench/request-path.bench.mjs [--iterations 50] [--check]
 */
import { Database } from "bun:sqlite";
import { openDb } from "../lib/db.mjs";
import { loadRegistry } from "../lib/registry.mjs";
import { startApi } from "../lib/api.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";

const ITERATIONS = Number(
  process.argv.find((a) => a.startsWith("--iterations="))?.split("=")[1] || 50,
);
const CHECK = process.argv.includes("--check");
const TOKEN = "bench-control-token";

async function populateProductionShapedDb(dbPath) {
  console.log(`[bench] Populating production-shaped database at ${dbPath}...`);
  const db = openDb(dbPath);

  db.exec("BEGIN TRANSACTION;");

  // 1. Generate ≥6,000 events with realistic payload size
  const insertEvent = db.prepare(`
    INSERT INTO events (
      source, event_id, type, subject, occurred_at, received_at,
      correlation_id, causation_id, envelope_json, payload_hash,
      status, plan_failures, last_plan_error, admitted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const largeText = "x".repeat(1024); // 1KB text block

  const eventTypes = [
    "factory.work.requested",
    "factory.dispatch.requested",
    "factory.merge.requested",
    "factory.ticket.dispatched",
    "factory.ticket.reaped",
  ];
  const statuses = ["admitted", "planned", "dead_lettered", "human_needed"];

  for (let i = 0; i < 6000; i++) {
    const type = eventTypes[i % eventTypes.length];
    const status = statuses[i % statuses.length];
    const envelope = JSON.stringify({
      schemaVersion: "factory.event/v1",
      source: "github",
      type,
      eventId: `evt_${i}`,
      occurredAt: new Date(Date.now() - (6000 - i) * 60000).toISOString(),
      payload: {
        repo: "factory",
        ticket: `CLNT-${1000 + (i % 500)}`,
        agent: "dispatch@1",
        extra: largeText,
        i,
      },
    });
    const nowIso = new Date(Date.now() - (6000 - i) * 60000).toISOString();
    insertEvent.run(
      "github",
      `evt_${i}`,
      type,
      `ticket:CLNT-${1000 + (i % 500)}`,
      nowIso,
      nowIso,
      `corr_${i % 100}`,
      null,
      envelope,
      `hash_${i}`,
      status,
      0,
      null,
      nowIso,
    );
  }

  // 2. Generate ≥4,000 runs
  const insertRun = db.prepare(`
    INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAttempt = db.prepare(`
    INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at, started_at, finished_at, terminal_state, reason_code, workspace_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLifecycle = db.prepare(`
    INSERT INTO lifecycle_events (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertResult = db.prepare(`
    INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const runStates = [
    "QUEUED",
    "LEASED",
    "RUNNING",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "REFUSED",
  ];

  for (let i = 0; i < 4000; i++) {
    const runId = `run_${String(i).padStart(6, "0")}`;
    const state = runStates[i % runStates.length];
    const agent = "dispatch@1";
    const spec = JSON.stringify({
      agent,
      input: {
        repo: "factory",
        ticket: `CLNT-${1000 + (i % 500)}`,
        extra: largeText,
      },
      correlationId: `corr_${i % 100}`,
      labels: { repo: "factory", tier: "fast" },
    });
    const nowIso = new Date(Date.now() - (4000 - i) * 60000).toISOString();
    const isLeased =
      state === "LEASED" || state === "RUNNING" || state === "VERIFYING";
    const leaseOwner = isLeased ? `worker_${i % 5}` : null;
    const leaseExpires = isLeased
      ? new Date(Date.now() + 600000).toISOString()
      : null;

    insertRun.run(
      runId,
      `idem_${runId}`,
      spec,
      `hash_${runId}`,
      state,
      1,
      nowIso,
      nowIso,
    );
    insertAttempt.run(
      runId,
      1,
      1,
      leaseOwner,
      leaseExpires,
      nowIso,
      null,
      state === "COMPLETED" ? "COMPLETED" : null,
      null,
      `/tmp/${runId}`,
    );

    insertLifecycle.run(
      runId,
      null,
      "QUEUED",
      "planner",
      null,
      1,
      `corr_${i % 100}`,
      null,
      "git:bench",
      nowIso,
      `hash_lc_${i}`,
    );
    if (state !== "QUEUED") {
      insertLifecycle.run(
        runId,
        "QUEUED",
        "LEASED",
        "worker",
        null,
        1,
        `corr_${i % 100}`,
        null,
        "git:bench",
        nowIso,
        `hash_lc_leased_${i}`,
      );
    }
    if (state === "COMPLETED" || state === "FAILED") {
      insertResult.run(
        runId,
        1,
        JSON.stringify({
          ok: state === "COMPLETED",
          summary: "done",
          output: largeText,
        }),
        `art_${i}`,
        `ev_${i}`,
        JSON.stringify({ verified: true, testsPassed: 42 }),
        JSON.stringify({ durationMs: 1200 }),
        nowIso,
      );
    }
  }

  // 3. Generate ≥1,000 proposals
  const insertProposal = db.prepare(`
    INSERT INTO proposals (
      id, event_source, event_id, run_id, decision, spec_json,
      spec_hash, idempotency_key, status, reason, created_at,
      ttl_seconds, decided_at, decided_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < 1000; i++) {
    const propId = `prop_${String(i).padStart(6, "0")}`;
    const status = i < 100 ? "open" : i % 2 === 0 ? "approved" : "rejected";
    const spec = JSON.stringify({
      agent: "dispatch@1",
      input: { repo: "factory", ticket: `CLNT-${2000 + i}`, extra: largeText },
    });
    const nowIso = new Date(Date.now() - (1000 - i) * 60000).toISOString();
    insertProposal.run(
      propId,
      "github",
      `evt_${i}`,
      `run_${String(i).padStart(6, "0")}`,
      "run",
      spec,
      `spec_hash_${propId}`,
      `idem_${propId}`,
      status,
      null,
      nowIso,
      1800,
      status !== "open" ? nowIso : null,
      status !== "open" ? "operator" : null,
    );
  }

  // 4. Pad table data with lifecycle events to reach ~260MB database size
  const insertPad = db.prepare(`
    INSERT INTO lifecycle_events (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const bigChunk = "A".repeat(8192); // 8KB per row
  for (let i = 0; i < 28000; i++) {
    insertPad.run(
      `run_000000`,
      "RUNNING",
      "RUNNING",
      "worker",
      bigChunk,
      1,
      null,
      null,
      "git:bench",
      new Date().toISOString(),
      `hash_pad_${i}`,
    );
  }

  db.exec("COMMIT;");
  db.exec("PRAGMA optimize;");

  const sizeMb = (statSync(dbPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[bench] Populated database: ${sizeMb} MB`);
  return db;
}

function computePercentiles(samples) {
  if (samples.length === 0)
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

async function benchmarkEndpoint(baseUrl, pathname, iterations) {
  const samples = [];
  const url = `${baseUrl}${pathname}`;

  // Warmup 3 requests
  for (let i = 0; i < 3; i++) {
    await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const elapsed = performance.now() - t0;
    if (!res.ok) {
      throw new Error(`Endpoint ${pathname} returned HTTP ${res.status}`);
    }
    await res.arrayBuffer(); // drain body
    samples.push(elapsed);
  }

  return computePercentiles(samples);
}

async function main() {
  const tempDir = path.join(tmpdir(), `factory-bench-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const dbFile = path.join(tempDir, "runtime.db");

  const db = await populateProductionShapedDb(dbFile);
  const registry = loadRegistry();

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
    policyVersion: "git:bench",
    port,
    controlApiToken: TOKEN,
    env: { name: "bench", home: tempDir, adapter: "fake" },
    getTickStats: () => ({ lastMs: 12, overruns: 0 }),
  });

  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  const endpoints = [
    "/health",
    "/status",
    "/runs",
    "/runs?state=RUNNING",
    "/runs?state=COMPLETED",
    "/runs/run_000050",
    "/events",
    "/events?status=admitted",
    "/proposals",
    "/proposals?status=open",
    "/inbox",
    "/agents",
    "/workers",
    "/schedules",
    "/repos",
    "/panels",
    "/journal",
    "/outbox",
    "/config",
    "/metrics",
  ];

  console.log(
    `\n### Benchmark Results (n=${ITERATIONS} requests per endpoint)\n`,
  );
  console.log(
    "| Endpoint | min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | mean (ms) | Status (<100ms p95) |",
  );
  console.log("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");

  let allPassed = true;
  const results = [];

  for (const ep of endpoints) {
    try {
      const stats = await benchmarkEndpoint(baseUrl, ep, ITERATIONS);
      const passed = stats.p95 < 100;
      if (!passed) allPassed = false;
      results.push({ ep, stats, passed });
      console.log(
        `| \`${ep}\` | ${stats.min.toFixed(2)} | ${stats.p50.toFixed(2)} | **${stats.p95.toFixed(2)}** | ${stats.p99.toFixed(2)} | ${stats.max.toFixed(2)} | ${stats.mean.toFixed(2)} | ${passed ? "PASS" : "FAIL"} |`,
      );
    } catch (err) {
      console.log(
        `| \`${ep}\` | ERROR: ${err.message} | - | - | - | - | - | FAIL |`,
      );
      allPassed = false;
    }
  }

  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(tempDir, { recursive: true, force: true });

  console.log(
    `\nOverall benchmark verdict: ${allPassed ? "PASS (all GET handlers p95 < 100ms)" : "FAIL"}\n`,
  );

  if (CHECK && !allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

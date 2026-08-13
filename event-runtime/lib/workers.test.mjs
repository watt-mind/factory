import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db.mjs";
import { createRun } from "./lifecycle.mjs";
import { claimNext } from "./worker.mjs";
import {
  deregisterWorker,
  HEARTBEAT_STALE_MS,
  heartbeat,
  listWorkers,
  pruneWorkers,
  registerWorker,
  satisfiesPlacement,
  stalledWorkers,
} from "./workers.mjs";

const PV = "git:test-pv";
const db = () => openDb(path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-workers-")), "runtime.db"));

/** A QUEUED run, straight through the real lifecycle. */
function queueRun(database, { runId, placement, adapter = "fake" }) {
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "a@1",
    input: {},
    adapter,
    timeoutSeconds: 60,
    maxAttempts: 1,
    ...(placement ? { placement } : {}),
  };
  createRun(database, {
    runId,
    idempotencyKey: runId,
    spec,
    specJson: JSON.stringify(spec),
    specHash: `sha256:${runId}`,
    actor: "planner",
    policyVersion: PV,
  });
  database.query(`UPDATE runs SET state = 'QUEUED' WHERE run_id = ?`).run(runId);
  return spec;
}

describe("cross-process claiming (OPS-233)", () => {
  test("two workers contending for one run: exactly one wins", () => {
    const d = db();
    queueRun(d, { runId: "run_contended" });

    const first = claimNext(d, { owner: "worker-a", policyVersion: PV });
    const second = claimNext(d, { owner: "worker-b", policyVersion: PV });

    expect(first?.runId).toBe("run_contended");
    expect(second).toBeNull(); // no double-claim, no second attempt row
    expect(d.query(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`).get("run_contended").n).toBe(1);
    expect(d.query(`SELECT state FROM runs WHERE run_id = ?`).get("run_contended").state).toBe("LEASED");
  });

  test("each worker takes a different run, oldest first", () => {
    const d = db();
    queueRun(d, { runId: "run_1" });
    queueRun(d, { runId: "run_2" });

    const a = claimNext(d, { owner: "worker-a", policyVersion: PV });
    const b = claimNext(d, { owner: "worker-b", policyVersion: PV });
    expect([a.runId, b.runId]).toEqual(["run_1", "run_2"]);
    expect(claimNext(d, { owner: "worker-c", policyVersion: PV })).toBeNull();
  });

  test("fencing tokens are monotonic across workers — the publish guard still holds", () => {
    const d = db();
    queueRun(d, { runId: "run_1" });
    queueRun(d, { runId: "run_2" });
    const a = claimNext(d, { owner: "worker-a", policyVersion: PV });
    const b = claimNext(d, { owner: "worker-b", policyVersion: PV });
    expect(b.fencingToken).toBeGreaterThan(a.fencingToken);
  });
});

describe("placement (OPS-233, workers doc §4)", () => {
  test("a worker only claims runs whose placement its labels satisfy", () => {
    const d = db();
    queueRun(d, { runId: "run_lab", placement: { node: "lab" } });

    expect(claimNext(d, { owner: "web-worker", policyVersion: PV, labels: { node: "web" } })).toBeNull();
    const claimed = claimNext(d, { owner: "lab-worker", policyVersion: PV, labels: { node: "lab" } });
    expect(claimed?.runId).toBe("run_lab");
  });

  test("an unplaced run is claimable by any worker", () => {
    const d = db();
    queueRun(d, { runId: "run_any" });
    expect(claimNext(d, { owner: "w", policyVersion: PV, labels: { node: "anywhere" } })?.runId).toBe("run_any");
  });

  test("a placed run is skipped, not blocking: the next eligible run is claimed", () => {
    const d = db();
    queueRun(d, { runId: "run_lab_first", placement: { node: "lab" } });
    queueRun(d, { runId: "run_unplaced" });
    const claimed = claimNext(d, { owner: "web-worker", policyVersion: PV, labels: { node: "web" } });
    expect(claimed?.runId).toBe("run_unplaced");
  });

  test("a worker skips adapters it does not have", () => {
    const d = db();
    queueRun(d, { runId: "run_claude", adapter: "claude" });
    expect(claimNext(d, { owner: "w", policyVersion: PV, adapters: ["command"] })).toBeNull();
    expect(claimNext(d, { owner: "w", policyVersion: PV, adapters: ["claude"] })?.runId).toBe("run_claude");
  });

  test("satisfiesPlacement: every declared key must match; no requirement means anywhere", () => {
    expect(satisfiesPlacement({ node: "lab" }, undefined)).toBe(true);
    expect(satisfiesPlacement({ node: "lab" }, {})).toBe(true);
    expect(satisfiesPlacement({ node: "lab", can: "infra-exec" }, { node: "lab" })).toBe(true);
    expect(satisfiesPlacement({ node: "lab" }, { node: "lab", can: "infra-exec" })).toBe(false);
    expect(satisfiesPlacement({}, { node: "lab" })).toBe(false);
  });
});

describe("worker registry and heartbeats (OPS-233)", () => {
  test("registers, heartbeats with its current run, and deregisters cleanly", () => {
    const d = db();
    registerWorker(d, { workerId: "w1", labels: { node: "lab" }, adapters: ["fake"] });
    let [w] = listWorkers(d);
    expect(w).toMatchObject({ workerId: "w1", state: "idle", labels: { node: "lab" }, adapters: ["fake"] });
    expect(w.stale).toBe(false);

    heartbeat(d, "w1", { state: "busy", runId: "run_1" });
    [w] = listWorkers(d);
    expect(w).toMatchObject({ state: "busy", currentRun: "run_1" });

    deregisterWorker(d, "w1");
    [w] = listWorkers(d);
    expect(w.state).toBe("stopped");
    expect(w.currentRun).toBeNull();
    expect(w.stale).toBe(false); // stopped is not stale — it left on purpose
  });

  test("a silent worker goes stale; holding a run makes it a doctor anomaly", () => {
    const d = db();
    const started = Date.now();
    registerWorker(d, { workerId: "w1", now: started });
    heartbeat(d, "w1", { state: "busy", runId: "run_1", now: started });

    const later = started + HEARTBEAT_STALE_MS + 1000;
    expect(listWorkers(d, { now: later })[0].stale).toBe(true);
    expect(stalledWorkers(d, { now: later })).toHaveLength(1);

    // An idle worker that goes quiet is stale but not an anomaly: nothing is stuck.
    heartbeat(d, "w1", { state: "idle", runId: null, now: started });
    expect(stalledWorkers(d, { now: later })).toHaveLength(0);
  });

  test("re-registering the same id revives it rather than duplicating", () => {
    const d = db();
    registerWorker(d, { workerId: "w1" });
    deregisterWorker(d, "w1");
    registerWorker(d, { workerId: "w1", labels: { node: "web" } });
    const rows = listWorkers(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "idle", labels: { node: "web" }, stoppedAt: null });
  });

  test("pruning drops long-stopped workers only", () => {
    const d = db();
    const old = Date.now() - 48 * 60 * 60 * 1000;
    registerWorker(d, { workerId: "old", now: old });
    deregisterWorker(d, "old", { now: old });
    registerWorker(d, { workerId: "live" });
    expect(pruneWorkers(d)).toBe(1);
    expect(listWorkers(d).map((w) => w.workerId)).toEqual(["live"]);
  });
});

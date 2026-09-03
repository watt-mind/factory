import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-workers-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "./db.mjs";
import { createRun } from "./lifecycle.mjs";
import { claimNext } from "./worker.mjs";
import {
  DEFAULT_POOL,
  deregisterWorker,
  HEARTBEAT_STALE_MS,
  heartbeat,
  listWorkers,
  loadWorkerPolicy,
  parsePoolSpec,
  poolCounts,
  poolDecision,
  pruneWorkers,
  registerWorker,
  satisfiesPlacement,
  stalledWorkers,
} from "./workers.mjs";

const PV = "git:test-pv";
const db = () => openDb(path.join(tmpDir("evrt-workers-"), "runtime.db"));

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
  database
    .query(`UPDATE runs SET state = 'QUEUED' WHERE run_id = ?`)
    .run(runId);
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
    expect(
      d
        .query(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`)
        .get("run_contended").n,
    ).toBe(1);
    expect(
      d.query(`SELECT state FROM runs WHERE run_id = ?`).get("run_contended")
        .state,
    ).toBe("LEASED");
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

    expect(
      claimNext(d, {
        owner: "web-worker",
        policyVersion: PV,
        labels: { node: "web" },
      }),
    ).toBeNull();
    const claimed = claimNext(d, {
      owner: "lab-worker",
      policyVersion: PV,
      labels: { node: "lab" },
    });
    expect(claimed?.runId).toBe("run_lab");
  });

  test("an unplaced run is claimable by any worker", () => {
    const d = db();
    queueRun(d, { runId: "run_any" });
    expect(
      claimNext(d, {
        owner: "w",
        policyVersion: PV,
        labels: { node: "anywhere" },
      })?.runId,
    ).toBe("run_any");
  });

  test("a placed run is skipped, not blocking: the next eligible run is claimed", () => {
    const d = db();
    queueRun(d, { runId: "run_lab_first", placement: { node: "lab" } });
    queueRun(d, { runId: "run_unplaced" });
    const claimed = claimNext(d, {
      owner: "web-worker",
      policyVersion: PV,
      labels: { node: "web" },
    });
    expect(claimed?.runId).toBe("run_unplaced");
  });

  test("a worker skips adapters it does not have", () => {
    const d = db();
    queueRun(d, { runId: "run_claude", adapter: "claude" });
    expect(
      claimNext(d, { owner: "w", policyVersion: PV, adapters: ["command"] }),
    ).toBeNull();
    expect(
      claimNext(d, { owner: "w", policyVersion: PV, adapters: ["claude"] })
        ?.runId,
    ).toBe("run_claude");
  });

  test("satisfiesPlacement: every declared key must match; no requirement means anywhere", () => {
    expect(satisfiesPlacement({ node: "lab" }, undefined)).toBe(true);
    expect(satisfiesPlacement({ node: "lab" }, {})).toBe(true);
    expect(
      satisfiesPlacement({ node: "lab", can: "infra-exec" }, { node: "lab" }),
    ).toBe(true);
    expect(
      satisfiesPlacement({ node: "lab" }, { node: "lab", can: "infra-exec" }),
    ).toBe(false);
    expect(satisfiesPlacement({}, { node: "lab" })).toBe(false);
  });
});

describe("worker registry and heartbeats (OPS-233)", () => {
  test("registers, heartbeats with its current run, and deregisters cleanly", () => {
    const d = db();
    registerWorker(d, {
      workerId: "w1",
      labels: { node: "lab" },
      adapters: ["fake"],
    });
    let [w] = listWorkers(d);
    expect(w).toMatchObject({
      workerId: "w1",
      state: "idle",
      labels: { node: "lab" },
      adapters: ["fake"],
    });
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

  test("heartbeats preserve omitted skipped diagnostics and clear them explicitly", () => {
    const d = db();
    registerWorker(d, { workerId: "w1" });
    const skipped = [
      { runId: "run_unplaced", reason: "placement did not match" },
    ];

    heartbeat(d, "w1", { skipped });
    expect(listWorkers(d)[0].skipped).toEqual(skipped);

    heartbeat(d, "w1", { state: "busy", runId: "run_busy" });
    expect(listWorkers(d)[0]).toMatchObject({
      state: "busy",
      currentRun: "run_busy",
      skipped,
    });

    heartbeat(d, "w1", { skipped: [] });
    expect(listWorkers(d)[0].skipped).toEqual([]);
  });

  test("worker skipped diagnostics require string run IDs and reasons", () => {
    const d = db();
    expect(() => registerWorker(d, { workerId: "w1", skipped: [{}] })).toThrow(
      /string runId and reason/,
    );
    expect(() => heartbeat(d, "w1", { skipped: "not-an-array" })).toThrow(
      /must be an array/,
    );
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
    expect(rows[0]).toMatchObject({
      state: "idle",
      labels: { node: "web" },
      stoppedAt: null,
    });
  });

  test("pruning keeps recent and leased workers while dropping expired rows", () => {
    const d = db();
    const now = Date.now();
    const hour = 60 * 60 * 1000;

    registerWorker(d, { workerId: "old-stopped", now });
    registerWorker(d, { workerId: "fresh-stopped", now });
    registerWorker(d, { workerId: "stale-dead", now });
    registerWorker(d, { workerId: "stale-but-leased", now });
    deregisterWorker(d, "old-stopped", { now: now - 2 * hour });
    deregisterWorker(d, "fresh-stopped", { now: now - 30 * 60 * 1000 });
    heartbeat(d, "stale-dead", { now: now - 7 * hour });
    heartbeat(d, "stale-but-leased", { now: now - 7 * hour });
    queueRun(d, { runId: "run_leased" });
    claimNext(d, {
      owner: "stale-but-leased",
      policyVersion: PV,
      now,
    });

    expect(pruneWorkers(d, { now })).toBe(2);
    expect(
      listWorkers(d, { now })
        .map((w) => w.workerId)
        .sort(),
    ).toEqual(["fresh-stopped", "stale-but-leased"]);
  });

  test("pruning correlates a lease with its run's current attempt", () => {
    const d = db();
    const now = Date.now();
    const hour = 60 * 60 * 1000;

    registerWorker(d, { workerId: "dead-first-attempt", now });
    queueRun(d, { runId: "retried-run" });
    d.query(
      `UPDATE runs SET state = 'RUNNING', attempts = 2 WHERE run_id = ?`,
    ).run("retried-run");
    d.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).run(
      "retried-run",
      1,
      1,
      "dead-first-attempt",
      "retried-run",
      2,
      2,
      "current-worker",
    );
    heartbeat(d, "dead-first-attempt", { now: now - 7 * hour });

    expect(pruneWorkers(d, { now })).toBe(1);
    expect(listWorkers(d, { now })).toEqual([]);
  });

  test("registering a worker retains recently stopped host rows", () => {
    const d = db();
    const now = Date.now();

    registerWorker(d, { workerId: "recently-stopped", now });
    registerWorker(d, { workerId: "expired-stopped", now });
    deregisterWorker(d, "recently-stopped", { now });
    deregisterWorker(d, "expired-stopped", { now: now - 2 * 60 * 60 * 1000 });
    registerWorker(d, { workerId: "new-pool", now: now + 1 });

    expect(
      listWorkers(d, { now: now + 1 })
        .map((w) => w.workerId)
        .sort(),
    ).toEqual(["new-pool", "recently-stopped"]);
  });

  test("a heartbeat restores a worker pruned while it was suspended", () => {
    const d = db();
    const now = Date.now();
    const startedAt = now - 8 * 60 * 60 * 1000;
    const labels = { node: "lab", can: "infra-exec" };
    const adapters = ["fake", "pi"];

    registerWorker(d, {
      workerId: "recovered",
      labels,
      adapters,
      now: startedAt,
    });
    heartbeat(d, "recovered", {
      state: "busy",
      runId: "run_recovered",
      now: now - 7 * 60 * 60 * 1000,
    });

    expect(pruneWorkers(d, { now })).toBe(1);
    expect(listWorkers(d, { now })).toEqual([]);

    heartbeat(d, "recovered", {
      state: "idle",
      labels,
      adapters,
      startedAt,
      now: now + 1,
    });
    expect(listWorkers(d, { now: now + 1 })).toEqual([
      expect.objectContaining({
        workerId: "recovered",
        state: "idle",
        currentRun: null,
        labels,
        adapters,
        startedAt: new Date(startedAt).toISOString(),
        stale: false,
      }),
    ]);
  });

  test("pruning stopped workers falls back to last_seen when stopped_at is NULL", () => {
    const d = db();
    const now = Date.now();

    registerWorker(d, {
      workerId: "missing-stop-time",
      now: now - 2 * 60 * 60 * 1000,
    });
    d.query(
      `UPDATE workers SET state = 'stopped', stopped_at = NULL WHERE worker_id = ?`,
    ).run("missing-stop-time");

    expect(pruneWorkers(d, { now })).toBe(1);
    expect(listWorkers(d, { now })).toEqual([]);
  });

  test("pruning retention windows are configurable", () => {
    const d = db();
    const now = Date.now();

    registerWorker(d, { workerId: "stopped", now });
    registerWorker(d, { workerId: "inactive", now });
    deregisterWorker(d, "stopped", { now: now - 30 * 60 * 1000 });
    heartbeat(d, "inactive", { now: now - 2 * 60 * 60 * 1000 });

    expect(
      pruneWorkers(d, {
        now,
        stoppedOlderThanMs: 15 * 60 * 1000,
        inactiveOlderThanMs: 60 * 60 * 1000,
      }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// pool supervision (WM-226)
// ---------------------------------------------------------------------------

describe("worker pool policy (WM-226)", () => {
  const configRoot = (yaml) => {
    const root = tmpDir("evrt-pool-cfg-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    if (yaml !== null)
      writeFileSync(path.join(root, "config", "policy.yaml"), yaml, "utf8");
    return root;
  };

  test("an absent workers: block is null, not a default — that absence keeps the single-worker stack", () => {
    expect(loadWorkerPolicy({ root: configRoot(null) })).toBeNull();
    expect(
      loadWorkerPolicy({
        root: configRoot("concurrency:\n  max_in_flight_per_repo: 3\n"),
      }),
    ).toBeNull();
  });

  test("a workers: block is read, and a partial one falls back per bound", () => {
    expect(
      loadWorkerPolicy({ root: configRoot("workers:\n  min: 2\n  max: 5\n") }),
    ).toEqual({ min: 2, max: 5 });
    expect(
      loadWorkerPolicy({ root: configRoot("workers:\n  max: 4\n") }),
    ).toEqual({ min: DEFAULT_POOL.min, max: 4 });
    // An empty block is still a block: it selects the pool at its defaults.
    expect(loadWorkerPolicy({ root: configRoot("workers: {}\n") })).toEqual(
      DEFAULT_POOL,
    );
  });

  test("nonsense bounds fail closed, naming the key — an unbounded pool is the expensive mistake", () => {
    expect(() =>
      loadWorkerPolicy({ root: configRoot("workers:\n  min: 4\n  max: 2\n") }),
    ).toThrow(/min \(4\) cannot exceed max \(2\)/);
    expect(() =>
      loadWorkerPolicy({ root: configRoot("workers:\n  max: 0\n") }),
    ).toThrow(/max must be at least 1/);
    expect(() =>
      loadWorkerPolicy({ root: configRoot("workers:\n  min: -1\n") }),
    ).toThrow(/min must be a non-negative integer/);
    expect(() =>
      loadWorkerPolicy({ root: configRoot("workers:\n  max: two\n") }),
    ).toThrow(/max must be a non-negative integer/);
    expect(() =>
      loadWorkerPolicy({ root: configRoot("workers: [1, 3]\n") }),
    ).toThrow(/must be a map with min\/max/);
  });

  test("--workers min:max parses; a bare N pins the pool", () => {
    expect(parsePoolSpec("1:3")).toEqual({ min: 1, max: 3 });
    expect(parsePoolSpec("2")).toEqual({ min: 2, max: 2 });
    expect(parsePoolSpec(" 0:4 ")).toEqual({ min: 0, max: 4 });
    expect(() => parsePoolSpec("")).toThrow(/expects min:max/);
    expect(() => parsePoolSpec("1:2:3")).toThrow(/expects min:max/);
    expect(() => parsePoolSpec("3:1")).toThrow(/cannot exceed max/);
  });
});

describe("pool scaling decisions (WM-226)", () => {
  const decide = (o) => poolDecision({ min: 1, max: 3, ...o });

  test("queued work with no idle worker spawns, bounded by max", () => {
    expect(decide({ queued: 1, idle: 0, pool: 1 }).action).toBe("spawn");
    expect(decide({ queued: 5, idle: 0, pool: 2 }).action).toBe("spawn");
    const capped = decide({ queued: 5, idle: 0, pool: 3 });
    expect(capped.action).toBe("hold");
    expect(capped.reason).toContain("workers.max 3");
  });

  test("an idle worker already covers the queue — no spawn", () => {
    expect(decide({ queued: 4, idle: 1, pool: 1 }).action).toBe("hold");
  });

  test("a worker still booting is capacity, not absence — one queued run cannot spawn the whole ceiling", () => {
    // The registry has not seen it yet (idle 0) but the process exists (pool 1).
    const d = decide({ queued: 1, idle: 0, pool: 1, pending: 1 });
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("still starting");
  });

  test("below min always spawns, even while another worker is booting", () => {
    expect(
      decide({ min: 2, max: 3, queued: 0, idle: 0, pool: 1, pending: 1 })
        .action,
    ).toBe("spawn");
  });

  test("idle surplus above min drains, one worker per tick", () => {
    const d = decide({ queued: 0, idle: 3, pool: 3 });
    expect(d.action).toBe("drain");
    expect(d.reason).toContain("above workers.min 1");
    // At min, an idle worker is the floor, not surplus.
    expect(decide({ queued: 0, idle: 1, pool: 1 }).action).toBe("hold");
    // And work waiting is never a reason to shrink.
    expect(decide({ queued: 2, idle: 1, pool: 3 }).action).toBe("hold");
  });

  test("a worker already draining is not counted as staying — the pool cannot drain through its floor", () => {
    // Two workers, min 1, one already asked to leave. Counting it as present
    // would drain the second too, and the pool would respawn from empty.
    expect(decide({ queued: 0, idle: 2, pool: 2, draining: 1 }).action).toBe(
      "hold",
    );
    expect(decide({ queued: 0, idle: 3, pool: 3, draining: 1 }).action).toBe(
      "drain",
    );
    // Symmetrically, a departure that takes the pool under min is refilled now
    // rather than a tick after the floor is breached.
    expect(decide({ queued: 0, idle: 1, pool: 1, draining: 1 }).action).toBe(
      "spawn",
    );
  });

  test("min 0 lets the pool reach zero and come back", () => {
    expect(decide({ min: 0, queued: 0, idle: 1, pool: 1 }).action).toBe(
      "drain",
    );
    expect(decide({ min: 0, queued: 1, idle: 0, pool: 0 }).action).toBe(
      "spawn",
    );
  });

  test("every decision carries the counts that justified it", () => {
    expect(decide({ queued: 2, idle: 0, pool: 1, pending: 0 }).counts).toEqual({
      queued: 2,
      idle: 0,
      pool: 1,
      pending: 0,
      draining: 0,
      min: 1,
      max: 3,
    });
  });
});

describe("poolCounts (WM-226)", () => {
  test("counts queued runs and the fleet that can take them, naming the idle workers", () => {
    const d = db();
    queueRun(d, { runId: "run_a" });
    queueRun(d, { runId: "run_b" });
    registerWorker(d, { workerId: "w-idle" });
    registerWorker(d, { workerId: "w-busy" });
    heartbeat(d, "w-busy", { state: "busy", runId: "run_b" });

    const counts = poolCounts(d);
    expect(counts).toMatchObject({ queued: 2, live: 2, busy: 1, idle: 1 });
    expect([...counts.idleWorkerIds]).toEqual(["w-idle"]);
  });

  test("a stale or stopped worker is not capacity — counting it as idle is how a queue starves", () => {
    const d = db();
    const started = Date.now();
    queueRun(d, { runId: "run_a" });
    registerWorker(d, { workerId: "w-gone", now: started });
    registerWorker(d, { workerId: "w-stopped", now: started });
    deregisterWorker(d, "w-stopped", { now: started });

    const counts = poolCounts(d, { now: started + HEARTBEAT_STALE_MS + 1000 });
    expect(counts).toMatchObject({ queued: 1, live: 0, idle: 0 });
    expect(poolDecision({ ...counts, pool: 0, min: 1, max: 2 }).action).toBe(
      "spawn",
    );
  });
});

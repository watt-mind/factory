/**
 * Worker registry and heartbeats (OPS-233; docs/event-runtime-workers.md §2, §4).
 *
 * Leases prove that an *attempt* is held. This answers a different question:
 * which worker processes are alive, where, and what are they allowed to run.
 * A lease alone cannot distinguish "a worker is busy on a long agent run"
 * from "a worker died and its lease has not expired yet" — the heartbeat can,
 * and the doctor view says so.
 *
 * Labels are the placement mechanism (§4): a worker declares what and where
 * it is, a spec may declare requirements, and the claim query filters. There
 * is no scheduler process — the claim IS the scheduler.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { tx } from "./db.mjs";
import { reposRoot } from "./repos.mjs";

/** A worker is considered gone if it has not checked in for this long. */
export const HEARTBEAT_STALE_MS = 90_000;

const iso = (now) => new Date(now).toISOString();

export function registerWorker(db, { workerId, labels = {}, adapters = [], now = Date.now() }) {
  const at = iso(now);
  db.query(
    `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')
     ON CONFLICT(worker_id) DO UPDATE SET
       host = excluded.host, pid = excluded.pid, labels_json = excluded.labels_json,
       adapters = excluded.adapters, last_seen = excluded.last_seen,
       state = 'idle', stopped_at = NULL`,
  ).run(workerId, hostname(), process.pid, JSON.stringify(labels), adapters.join(","), at, at);
  return { workerId, host: hostname(), pid: process.pid, labels, adapters };
}

/** Called every loop tick: proof of life, plus what the worker is doing. */
export function heartbeat(db, workerId, { state = "idle", runId = null, now = Date.now() } = {}) {
  db.query(`UPDATE workers SET last_seen = ?, state = ?, current_run = ? WHERE worker_id = ?`)
    .run(iso(now), state, runId, workerId);
}

/** Clean exit: recorded, so a stopped worker is distinguishable from a dead one. */
export function deregisterWorker(db, workerId, { now = Date.now() } = {}) {
  db.query(`UPDATE workers SET state = 'stopped', stopped_at = ?, current_run = NULL WHERE worker_id = ?`)
    .run(iso(now), workerId);
}

export function listWorkers(db, { now = Date.now() } = {}) {
  return db
    .query(`SELECT * FROM workers ORDER BY started_at DESC`)
    .all()
    .map((row) => ({
      workerId: row.worker_id,
      host: row.host,
      pid: row.pid,
      labels: JSON.parse(row.labels_json),
      adapters: row.adapters ? row.adapters.split(",") : [],
      startedAt: row.started_at,
      lastSeen: row.last_seen,
      state: row.state,
      currentRun: row.current_run,
      stoppedAt: row.stopped_at,
      stale: row.state !== "stopped" && now - Date.parse(row.last_seen) > HEARTBEAT_STALE_MS,
    }));
}

/**
 * Doctor input (§13): a worker holding a run whose heartbeat has gone stale.
 * Its lease may still be valid, so nothing has reclaimed the run yet — that
 * gap is exactly what an operator wants told, not discovered.
 */
export function stalledWorkers(db, { now = Date.now() } = {}) {
  return listWorkers(db, { now }).filter((w) => w.stale && w.currentRun);
}

/** Drop long-stopped workers so the registry reflects the fleet, not history. */
export function pruneWorkers(db, { olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  return tx(db, () => {
    const cutoff = iso(now - olderThanMs);
    const { changes } = db
      .query(`DELETE FROM workers WHERE state = 'stopped' AND stopped_at < ?`)
      .run(cutoff);
    return changes ?? 0;
  });
}

/**
 * Placement (§4): does this worker satisfy a spec's requirements? Absent
 * requirements mean any worker; a declared key must match exactly. Kept as a
 * pure predicate so the SQLite claim can filter in JS today and Postgres can
 * push the same rule into SQL later.
 */
export function satisfiesPlacement(labels, placement) {
  if (!placement || Object.keys(placement).length === 0) return true;
  return Object.entries(placement).every(([key, value]) => String(labels?.[key]) === String(value));
}

// ---------------------------------------------------------------------------
// Pool supervision (WM-226; docs/event-runtime-workers.md §2a)
// ---------------------------------------------------------------------------

/**
 * Pool bounds when policy.yaml carries a `workers:` block but leaves a bound
 * out. One worker is the floor because a pool that can reach zero has nothing
 * to notice the next queued run with; three is the same small ceiling §2 argues
 * for — idle workers are nearly free, concurrent agent RUNS are what cost.
 */
export const DEFAULT_POOL = { min: 1, max: 3 };

/**
 * Read the `workers:` block from config/policy.yaml (same root rule as
 * repos.yaml and the `models:` tier map). Returns null when the block is
 * absent — that absence is load-bearing: it means "no pool", and `factory up`
 * keeps starting exactly one plain `work` process, as it did before WM-226.
 *
 * Bad values fail closed with a named error rather than silently scaling to
 * something nobody wrote: an unbounded pool is the one mistake here that costs
 * real money.
 */
export function loadWorkerPolicy({ root = reposRoot() } = {}) {
  const file = path.join(root, "config", "policy.yaml");
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: unparseable policy.yaml — ${err.message}`);
  }
  const block = parsed?.workers;
  if (block === undefined || block === null) return null;
  if (typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${file}: "workers" must be a map with min/max (WM-226)`);
  }
  return normalizePool({ min: block.min, max: block.max }, `${file}: workers`);
}

/** Validate a {min,max} pair from any source (policy file or --workers m:n). */
export function normalizePool({ min, max } = {}, where = "workers") {
  const value = (raw, fallback, key) => {
    if (raw === undefined || raw === null) return fallback;
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (!Number.isInteger(n) || n < 0) throw new Error(`${where}.${key} must be a non-negative integer (got ${raw})`);
    return n;
  };
  const lo = value(min, DEFAULT_POOL.min, "min");
  const hi = value(max, DEFAULT_POOL.max, "max");
  if (hi < 1) throw new Error(`${where}.max must be at least 1 (got ${hi})`);
  if (lo > hi) throw new Error(`${where}.min (${lo}) cannot exceed max (${hi})`);
  return { min: lo, max: hi };
}

/** Parse the `--workers min:max` CLI form. A bare "N" means min=max=N. */
export function parsePoolSpec(spec) {
  const raw = String(spec ?? "").trim();
  if (raw === "") throw new Error("--workers expects min:max (e.g. 1:3)");
  const parts = raw.split(":");
  if (parts.length === 1) return normalizePool({ min: parts[0], max: parts[0] }, "--workers");
  if (parts.length !== 2) throw new Error(`--workers expects min:max (got "${raw}")`);
  return normalizePool({ min: parts[0], max: parts[1] }, "--workers");
}

/**
 * What the supervisor can see, in one read-only pass: how much work is waiting
 * and how much of the registered fleet is free to take it. Stale rows are
 * excluded — a worker that stopped heartbeating is not capacity, and counting
 * it as idle is how a queue starves behind a dead process.
 */
export function poolCounts(db, { now = Date.now() } = {}) {
  const queued = db.query(`SELECT COUNT(*) AS n FROM runs WHERE state = 'QUEUED'`).get().n;
  const workers = listWorkers(db, { now }).filter((w) => w.state !== "stopped" && !w.stale);
  const idle = workers.filter((w) => w.state !== "busy");
  return {
    queued,
    live: workers.length,
    busy: workers.length - idle.length,
    idle: idle.length,
    // Which ones, not just how many: the supervisor drains a named worker.
    idleWorkerIds: new Set(idle.map((w) => w.workerId)),
  };
}

/**
 * The scaling rule, as a pure function of observed counts (WM-226 §1: the
 * supervisor is deterministic and config-driven, never model-driven). One
 * decision per tick — scaling one worker at a time and re-observing is what
 * keeps a burst of queued runs from spawning the whole ceiling at once.
 *
 * `pool` counts the supervisor's live slots (a process exists); `idle` counts
 * registered non-busy workers (a process is ready to claim). They differ while
 * a worker boots, which is what `pending` is for: without it, every tick
 * during a spawn's first seconds sees "queued work, nothing idle" and spawns
 * again, straight to max, for one queued run.
 *
 * `draining` is the same correction at the other end. A worker that has been
 * asked to leave is not future capacity, so the floor is measured against the
 * pool that will REMAIN — otherwise a two-worker pool with min 1 drains one,
 * still counts two, and drains the second as well, straight through the floor
 * and into a respawn. The ceiling is measured against the physical pool,
 * because that is what the machine is actually running.
 */
export function poolDecision({ queued = 0, idle = 0, pool = 0, pending = 0, draining = 0, min, max } = {}) {
  const counts = { queued, idle, pool, pending, draining, min, max };
  const decide = (action, reason) => ({ action, reason, counts });
  const remaining = pool - draining;

  if (remaining < min) return decide("spawn", `pool ${remaining} below workers.min ${min}`);
  if (pending > 0) return decide("hold", `${pending} worker(s) still starting`);
  if (queued > 0 && idle === 0) {
    if (pool < max) return decide("spawn", `${queued} queued run(s), no idle worker, pool ${pool} < max ${max}`);
    return decide("hold", `${queued} queued run(s) but pool is at workers.max ${max}`);
  }
  if (queued === 0 && idle > 0 && remaining > min) {
    return decide("drain", `${idle} idle worker(s) and no queued runs, pool ${remaining} above workers.min ${min}`);
  }
  return decide("hold", `steady: ${queued} queued, ${idle} idle, pool ${pool} (min ${min}, max ${max})`);
}

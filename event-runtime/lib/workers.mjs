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
import { hostname } from "node:os";
import { tx } from "./db.mjs";

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

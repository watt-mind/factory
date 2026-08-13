/**
 * SQLite substrate for the event runtime (docs/event-runtime.md §10).
 *
 * One embedded database holds the whole operational model: admitted events,
 * proposals, immutable run specs, attempts and leases, the append-only
 * lifecycle journal, accepted results, and the transactional outbox. This is
 * a deliberate departure from the orchestrator's stateless model — a webhook,
 * unlike a Linear ticket, cannot be re-read after delivery. The ledger is
 * authoritative for event facts only; Linear stays authoritative for work.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dbPath } from "./config.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  source          TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  subject         TEXT,
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  correlation_id  TEXT,
  causation_id    TEXT,
  envelope_json   TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'admitted',
  plan_failures   INTEGER NOT NULL DEFAULT 0,
  last_plan_error TEXT,
  admitted_at     TEXT NOT NULL,
  PRIMARY KEY (source, event_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id              TEXT PRIMARY KEY,
  event_source    TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  run_id          TEXT,
  decision        TEXT NOT NULL,
  spec_json       TEXT,
  spec_hash       TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  reason          TEXT,
  created_at      TEXT NOT NULL,
  ttl_seconds     INTEGER NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  spec_json       TEXT NOT NULL,
  spec_hash       TEXT NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  run_id           TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  fencing_token    INTEGER NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  terminal_state   TEXT,
  reason_code      TEXT,
  workspace_path   TEXT,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  reason         TEXT,
  attempt        INTEGER,
  correlation_id TEXT,
  causation_id   TEXT,
  policy_version TEXT,
  at             TEXT NOT NULL,
  record_hash    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  run_id            TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  result_json       TEXT NOT NULL,
  artifact_hash     TEXT NOT NULL,
  evidence_set_hash TEXT,
  verification_json TEXT NOT NULL,
  receipt_json      TEXT NOT NULL,
  accepted_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE IF NOT EXISTS outbox (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_json    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  published_at  TEXT
);

CREATE TABLE IF NOT EXISTS workers (
  worker_id   TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  adapters    TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'idle',
  current_run TEXT,
  stopped_at  TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_run ON lifecycle_events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_workers_last_seen ON workers (last_seen);
`;

export function openDb(file = dbPath()) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  // busy_timeout FIRST: switching journal modes takes a brief exclusive lock,
  // and a second process opening the database concurrently must wait for it
  // rather than failing with SQLITE_BUSY_RECOVERY. Ordering matters here —
  // observed live the moment serve and work became separate processes.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside one SQLite transaction; returns its result. */
export function tx(db, fn) {
  return db.transaction(fn)();
}

/**
 * A write transaction that takes its lock up front (OPS-233).
 *
 * SQLite's default DEFERRED transaction acquires a read lock first and only
 * upgrades on the first write — so two workers can both SELECT the same
 * QUEUED run before either writes, and one then loses the upgrade with
 * SQLITE_BUSY. BEGIN IMMEDIATE serializes claimants at the start, which is
 * what makes multi-process claiming correct on one machine. (Postgres uses
 * FOR UPDATE SKIP LOCKED for the same job when workers span hosts.)
 */
export function txImmediate(db, fn) {
  return db.transaction(fn).immediate();
}

/** Monotonic named counter — fencing tokens come from here (§8). */
export function nextCounter(db, name) {
  const row = db
    .query(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name);
  return row.value;
}

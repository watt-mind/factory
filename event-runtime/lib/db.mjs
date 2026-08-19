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

export const SCHEMA_V1 = `
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

CREATE TABLE IF NOT EXISTS attempt_trace (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_run ON lifecycle_events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_workers_last_seen ON workers (last_seen);
CREATE INDEX IF NOT EXISTS idx_attempt_trace_run ON attempt_trace (run_id, seq);
`;

const SCHEMA = SCHEMA_V1;

/**
 * Ordered linear migrations list. Each migration runs sequentially inside a
 * transaction and advances PRAGMA user_version.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: "initial_schema",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
  {
    version: 2,
    name: "run_usage",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_usage (
          run_id                     TEXT NOT NULL,
          attempt                    INTEGER NOT NULL,
          adapter                    TEXT NOT NULL,
          model                      TEXT,
          input_tokens               INTEGER NOT NULL DEFAULT 0,
          output_tokens              INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens    INTEGER NOT NULL DEFAULT 0,
          cost_usd                   REAL NOT NULL DEFAULT 0,
          recorded_at                TEXT NOT NULL,
          PRIMARY KEY (run_id, attempt)
        );
        CREATE INDEX IF NOT EXISTS idx_run_usage_recorded_at ON run_usage (recorded_at);
      `);
    },
  },
  {
    version: 3,
    name: "metrics_query_indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_lifecycle_at ON lifecycle_events (at);
        CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at);
        CREATE INDEX IF NOT EXISTS idx_events_admitted_at ON events (admitted_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals (created_at);
      `);
    },
  },
  {
    version: 4,
    name: "human_inbox_ledger",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS inbox_items (
          id            TEXT PRIMARY KEY,
          kind          TEXT NOT NULL,
          severity      TEXT NOT NULL DEFAULT 'normal',
          title         TEXT NOT NULL,
          body          TEXT,
          refs_json     TEXT NOT NULL DEFAULT '{}',
          source        TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          acked_at      TEXT,
          resolved_at   TEXT,
          resolved_by   TEXT,
          delivery_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_inbox_items_status
          ON inbox_items (resolved_at, acked_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_inbox_items_kind
          ON inbox_items (kind, resolved_at);
      `);
    },
  },
  {
    version: 5,
    name: "archive_dead_lettered_events",
    up(db) {
      // A cold start can have several processes read user_version before one
      // acquires the migration lock. Keep the additive step retry-safe when a
      // waiter enters with that stale read after the first process committed.
      const columns = db
        .query(`PRAGMA table_info(events)`)
        .all()
        .map((row) => row.name);
      if (!columns.includes("archived_at")) {
        db.exec(`ALTER TABLE events ADD COLUMN archived_at TEXT;`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_dead_letter_archive
          ON events (status, archived_at);
      `);
    },
  },
  {
    // The inbox design originally reserved v5. The dead-letter archive
    // migration landed while WM-390 was blocked, so this additive upgrade is
    // v6 and its regression fixture starts from the now-real v5 schema.
    version: 6,
    name: "inbox_decisions",
    up(db) {
      const columns = new Set(
        db
          .query(`PRAGMA table_info(inbox_items)`)
          .all()
          .map((row) => row.name),
      );
      for (const [name, type] of [
        ["decision_json", "TEXT"],
        ["response_json", "TEXT"],
        ["decided_at", "TEXT"],
        ["decided_by", "TEXT"],
        ["dedupe_key", "TEXT"],
      ]) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE inbox_items ADD COLUMN ${name} ${type};`);
        }
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_open_dedupe
          ON inbox_items (dedupe_key)
          WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
      `);
    },
  },
  {
    version: 7,
    name: "inbox_resolved_reason",
    up(db) {
      const columns = db
        .query(`PRAGMA table_info(inbox_items)`)
        .all()
        .map((row) => row.name);
      if (!columns.includes("resolved_reason")) {
        db.exec(`ALTER TABLE inbox_items ADD COLUMN resolved_reason TEXT;`);
      }
    },
  },
  {
    version: 8,
    name: "memo_ledger",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memos (
          sha256           TEXT PRIMARY KEY,
          subject_type     TEXT NOT NULL,
          subject_id       TEXT NOT NULL,
          kind             TEXT NOT NULL,
          run_id           TEXT,
          inbox_item_id    TEXT,
          created_at       INTEGER NOT NULL,
          expires_at       INTEGER,
          description_hash TEXT,
          head_sha         TEXT,
          superseded_by    TEXT,
          retired_at       INTEGER,
          retired_reason   TEXT
        );
        CREATE INDEX IF NOT EXISTS memos_subject
          ON memos (subject_type, subject_id, kind, created_at DESC);
        CREATE TABLE IF NOT EXISTS memo_uses (
          sha256    TEXT NOT NULL,
          run_id    TEXT NOT NULL,
          verdict   TEXT,
          run_state TEXT NOT NULL,
          at        INTEGER NOT NULL,
          PRIMARY KEY (sha256, run_id)
        );
      `);
    },
  },
  {
    version: 9,
    name: "merge_reviews",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS merge_reviews (
          github         TEXT NOT NULL,
          pr             INTEGER NOT NULL,
          head_sha       TEXT NOT NULL,
          base_sha       TEXT NOT NULL,
          verdict        TEXT NOT NULL,
          findings_json  TEXT NOT NULL,
          fix_json       TEXT,
          plan_json      TEXT,
          policy_version TEXT,
          run_id         TEXT,
          reviewed_at    TEXT NOT NULL,
          PRIMARY KEY (github, pr, head_sha, base_sha)
        );
        CREATE INDEX IF NOT EXISTS idx_merge_reviews_github_pr
          ON merge_reviews (github, pr, reviewed_at DESC);
      `);
    },
  },
];

export const CURRENT_SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 1;

export const CORE_TABLES = [
  "events",
  "proposals",
  "runs",
  "attempts",
  "lifecycle_events",
  "results",
  "outbox",
  "workers",
  "counters",
  "attempt_trace",
  "run_usage",
  "inbox_items",
  "memos",
  "memo_uses",
  "merge_reviews",
];

/** Read current database schema version from PRAGMA user_version. */
export function getSchemaVersion(db) {
  return db.query("PRAGMA user_version").get()?.user_version ?? 0;
}

/** Set database schema version via PRAGMA user_version. */
export function setSchemaVersion(db, version) {
  db.exec(`PRAGMA user_version = ${Number(version)};`);
}

/**
 * Run pending linear migrations up to `targetVersion` inside an immediate transaction.
 *
 * Fails loudly when the database's user_version is newer than the code knows,
 * preventing silent drift or query-time failures during runtime execution.
 */
export function migrateDb(
  db,
  { migrations = MIGRATIONS, targetVersion = CURRENT_SCHEMA_VERSION } = {},
) {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion > targetVersion) {
    const msg = `Database schema version (${currentVersion}) is newer than code version (${targetVersion}). Please upgrade the runtime.`;
    console.error(`FATAL: ${msg}`);
    throw new Error(msg);
  }
  if (currentVersion < targetVersion) {
    txImmediate(db, () => {
      for (const m of migrations) {
        if (m.version > currentVersion && m.version <= targetVersion) {
          m.up(db);
          setSchemaVersion(db, m.version);
        }
      }
    });
  }
}

/**
 * Assert that all required tables exist and user_version matches current code expectation.
 */
export function assertSchema(
  db,
  {
    expectedTables = CORE_TABLES,
    expectedVersion = CURRENT_SCHEMA_VERSION,
  } = {},
) {
  const tables = new Set(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
  for (const table of expectedTables) {
    if (!tables.has(table)) {
      throw new Error(
        `Database schema drift detected: missing table "${table}"`,
      );
    }
  }
  const version = getSchemaVersion(db);
  if (version !== expectedVersion) {
    throw new Error(
      `Database schema assertion failed: user_version is ${version}, expected ${expectedVersion}`,
    );
  }
}

/**
 * Put the database in WAL, tolerating a cold-start race (OPS-376).
 *
 * Journal mode is persistent, so the steady state needs no lock at all — read
 * it first and skip the switch when it is already `wal`. Only the genuine
 * first-time switch needs momentary exclusive access, which `busy_timeout`
 * does NOT cover: two processes starting together against a brand-new file
 * (serve and work, as worktree-up.sh launches them) had one win and the other
 * die with SQLITE_BUSY. A bounded retry converges instead.
 */
function enableWal(db, { attempts = 20, waitMs = 50 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (db.query("PRAGMA journal_mode").get()?.journal_mode === "wal") return;
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err) {
      // Someone else is mid-switch; they will finish and the read above wins.
      if (i === attempts - 1) {
        throw new Error(
          `could not switch the database to WAL after ${attempts} attempts: ${err.message}`,
          { cause: err },
        );
      }
      Bun.sleepSync(waitMs);
    }
  }
}

export function openDb(file = dbPath()) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  // busy_timeout FIRST: switching journal modes takes a brief exclusive lock,
  // and a second process opening the database concurrently must wait for it
  // rather than failing with SQLITE_BUSY_RECOVERY. Ordering matters here —
  // observed live the moment serve and work became separate processes.
  db.exec("PRAGMA busy_timeout = 5000;");
  enableWal(db);
  // Set synchronous = FULL (OPS-414): under WAL mode, the default NORMAL only
  // fsyncs at checkpoint boundaries, which can lose recent committed transactions
  // on sudden OS crash or power loss. For an authoritative once-only event delivery
  // ledger that cannot be re-requested, synchronous=FULL ensures that every write
  // transaction is durably committed to disk.
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDb(db);
  assertSchema(db);
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

/**
 * Test whether an error represents a transient SQLite lock collision
 * (SQLITE_BUSY / SQLITE_LOCKED) that is safe to retry.
 */
export function isBusyError(err) {
  if (!err) return false;
  if (
    err.code === "SQLITE_BUSY" ||
    err.code === "SQLITE_LOCKED" ||
    err.code === "SQLITE_BUSY_RECOVERY"
  )
    return true;
  if (typeof err.errno === "number" && (err.errno === 5 || err.errno === 6))
    return true;
  const msg = String(err.message ?? err);
  return /database is locked|database table is locked|resource temporarily unavailable|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(
    msg,
  );
}

/** Normalize adapter-supplied usage into durable, non-negative values. */
function normalizedUsage(usage = {}) {
  const tokens = (value) =>
    Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  const money = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    model:
      typeof usage.model === "string" && usage.model !== ""
        ? usage.model
        : null,
    inputTokens: tokens(usage.inputTokens ?? usage.input_tokens),
    outputTokens: tokens(usage.outputTokens ?? usage.output_tokens),
    cacheCreationInputTokens: tokens(
      usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens,
    ),
    cacheReadInputTokens: tokens(
      usage.cacheReadInputTokens ?? usage.cache_read_input_tokens,
    ),
    costUSD: money(usage.costUSD ?? usage.cost_usd),
  };
}

function usageTimestamp(value) {
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(value ?? Date.now()).toISOString();
}

/**
 * Persist one attempt's final usage. Re-writing the same attempt is intentional:
 * cancellation can first record zero, then the aborting adapter can report the
 * tokens it consumed before stopping.
 */
export function recordRunUsage(
  db,
  { runId, attempt, adapter, recordedAt = Date.now(), ...rawUsage },
) {
  const usage = normalizedUsage(rawUsage.usage ?? rawUsage);
  const actualAdapter =
    adapter ??
    db
      .query(
        `SELECT json_extract(spec_json, '$.adapter') AS adapter FROM runs WHERE run_id = ?`,
      )
      .get(runId)?.adapter ??
    "unknown";
  db.query(
    `INSERT INTO run_usage
       (run_id, attempt, adapter, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_usd, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, attempt) DO UPDATE SET
       adapter = excluded.adapter,
       model = excluded.model,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_creation_input_tokens = excluded.cache_creation_input_tokens,
       cache_read_input_tokens = excluded.cache_read_input_tokens,
       cost_usd = excluded.cost_usd,
       recorded_at = excluded.recorded_at`,
  ).run(
    runId,
    attempt,
    actualAdapter,
    usage.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
    usage.costUSD,
    usageTimestamp(recordedAt),
  );
}

function usageRow(row) {
  const inputTokens = Number(row.input_tokens ?? 0);
  const outputTokens = Number(row.output_tokens ?? 0);
  const cacheCreationInputTokens = Number(row.cache_creation_input_tokens ?? 0);
  const cacheReadInputTokens = Number(row.cache_read_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens,
    costUSD: Number(row.cost_usd ?? 0),
  };
}

/** Persisted attempt usage plus a per-run total for inspect. */
export function runUsage(db, runId) {
  const rows = db
    .query(
      `SELECT attempt, adapter, model, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens, cost_usd, recorded_at
     FROM run_usage WHERE run_id = ? ORDER BY attempt`,
    )
    .all(runId);
  const attempts = rows.map((row) => ({
    attempt: row.attempt,
    adapter: row.adapter,
    model: row.model ?? null,
    ...usageRow(row),
    recordedAt: row.recorded_at,
  }));
  return {
    totals: attempts.reduce(
      (totals, row) => ({
        attempts: totals.attempts + 1,
        inputTokens: totals.inputTokens + row.inputTokens,
        outputTokens: totals.outputTokens + row.outputTokens,
        cacheCreationInputTokens:
          totals.cacheCreationInputTokens + row.cacheCreationInputTokens,
        cacheReadInputTokens:
          totals.cacheReadInputTokens + row.cacheReadInputTokens,
        totalTokens: totals.totalTokens + row.totalTokens,
        costUSD: totals.costUSD + row.costUSD,
      }),
      {
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 0,
        costUSD: 0,
      },
    ),
    attempts,
  };
}

const USAGE_TOTALS_SQL = `
  COUNT(DISTINCT run_id) AS runs,
  COUNT(*) AS attempts,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
  COALESCE(SUM(cost_usd), 0) AS cost_usd`;

function spendRow(row) {
  return {
    runs: Number(row.runs ?? 0),
    attempts: Number(row.attempts ?? 0),
    ...usageRow(row),
  };
}

/** Rolling usage windows for GET /status and the status CLI. */
export function usageSpend(db, { now = Date.now() } = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const nowIso = new Date(nowMs).toISOString();
  const since = (milliseconds) => new Date(nowMs - milliseconds).toISOString();
  const totalSince = (cutoff) =>
    spendRow(
      db
        .query(
          `SELECT ${USAGE_TOTALS_SQL} FROM run_usage WHERE recorded_at >= ? AND recorded_at <= ?`,
        )
        .get(cutoff, nowIso),
    );
  const cutoff24h = since(24 * 60 * 60 * 1000);
  const byAgent24h = db
    .query(
      `SELECT COALESCE(json_extract(r.spec_json, '$.agent'), 'unknown') AS agent,
            ${USAGE_TOTALS_SQL.replaceAll("run_id", "u.run_id")}
     FROM run_usage u JOIN runs r ON r.run_id = u.run_id
     WHERE u.recorded_at >= ? AND u.recorded_at <= ?
     GROUP BY agent
     ORDER BY (SUM(u.input_tokens) + SUM(u.output_tokens) +
               SUM(u.cache_creation_input_tokens) + SUM(u.cache_read_input_tokens)) DESC,
              agent`,
    )
    .all(cutoff24h, nowIso)
    .map((row) => ({ agent: row.agent, ...spendRow(row) }));
  return {
    rolling1h: totalSince(since(60 * 60 * 1000)),
    rolling24h: totalSince(cutoff24h),
    byAgent24h,
  };
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

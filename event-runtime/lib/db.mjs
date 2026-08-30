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
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_json        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  published_at      TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_error    TEXT
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
  {
    version: 10,
    name: "inbox_waiters",
    up(db) {
      const columns = db
        .query(`PRAGMA table_info(inbox_items)`)
        .all()
        .map((row) => row.name);
      if (!columns.includes("waiters_json")) {
        db.exec(
          `ALTER TABLE inbox_items ADD COLUMN waiters_json TEXT NOT NULL DEFAULT '[]';`,
        );
      }
    },
  },
  {
    version: 11,
    name: "runtime_overrides",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_overrides (
          kind       TEXT NOT NULL,
          key        TEXT NOT NULL,
          patch_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          PRIMARY KEY (kind, key)
        );
        CREATE TABLE IF NOT EXISTS runtime_override_journal (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          kind       TEXT NOT NULL,
          key        TEXT NOT NULL,
          before_json TEXT,
          after_json  TEXT,
          actor      TEXT NOT NULL,
          at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_override_journal_at
          ON runtime_override_journal (at, seq);
      `);
    },
  },
  {
    version: 12,
    name: "merge_reviews_key_head",
    up(db) {
      db.exec(`
        CREATE TABLE merge_reviews_v12 (
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
          PRIMARY KEY (github, pr, head_sha)
        );
        INSERT INTO merge_reviews_v12 (
          github, pr, head_sha, base_sha, verdict, findings_json, fix_json,
          plan_json, policy_version, run_id, reviewed_at
        )
        SELECT github, pr, head_sha, base_sha, verdict, findings_json, fix_json,
               plan_json, policy_version, run_id, reviewed_at
          FROM merge_reviews
         WHERE rowid IN (
           SELECT MAX(rowid) FROM merge_reviews GROUP BY github, pr, head_sha
         );
        DROP TABLE merge_reviews;
        ALTER TABLE merge_reviews_v12 RENAME TO merge_reviews;
        CREATE INDEX IF NOT EXISTS idx_merge_reviews_github_pr
          ON merge_reviews (github, pr, reviewed_at DESC);
      `);
    },
  },
  {
    version: 13,
    name: "outbox_publish_drain_index",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_outbox_published_seq
          ON outbox (published_at, seq);
      `);
    },
  },
  {
    version: 14,
    name: "chain_resolution_indexes",
    up(db) {
      const columns = db
        .query(`PRAGMA table_info(runs)`)
        .all()
        .map((row) => row.name);
      if (!columns.includes("chain_resolved_at")) {
        db.exec(`ALTER TABLE runs ADD COLUMN chain_resolved_at TEXT;`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_causation
          ON events (causation_id, source);
        CREATE INDEX IF NOT EXISTS idx_runs_chain_unresolved
          ON runs (state, chain_resolved_at);
      `);
    },
  },
  {
    // 15, not 14: #1230 (#1197) also introduces a migration 14 and lands
    // first. Guarded/idempotent like the rest, and the runner applies any
    // migration above the database's user_version, so a v13 or v14 database
    // and a fresh one all converge on 15.
    version: 15,
    name: "tier_escalations",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tier_escalations (
          root_run_id         TEXT PRIMARY KEY,
          failed_run_id       TEXT NOT NULL UNIQUE,
          continuation_run_id TEXT NOT NULL UNIQUE,
          repo                TEXT NOT NULL,
          ticket              TEXT NOT NULL,
          workspace_path      TEXT NOT NULL,
          source_workspace_path TEXT NOT NULL,
          projection_state    TEXT NOT NULL DEFAULT 'pending',
          projection_attempts INTEGER NOT NULL DEFAULT 0,
          projection_error    TEXT,
          created_at          TEXT NOT NULL,
          projected_at        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tier_escalations_projection
          ON tier_escalations (projection_state, created_at);
      `);
    },
  },
  {
    version: 16,
    name: "inbox_proposal_id",
    up(db) {
      const columns = new Set(
        db
          .query(`PRAGMA table_info(inbox_items)`)
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("proposal_id")) {
        db.exec(`ALTER TABLE inbox_items ADD COLUMN proposal_id TEXT;`);
      }
      db.exec(`
        UPDATE inbox_items
           SET proposal_id = json_extract(refs_json, '$.proposalId');
        CREATE INDEX IF NOT EXISTS idx_inbox_items_proposal_id
          ON inbox_items (proposal_id);
      `);
    },
  },
  {
    version: 17,
    name: "proposal_and_event_lookup_indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_proposals_run_id
          ON proposals (run_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_proposals_event
          ON proposals (event_source, event_id);
        CREATE INDEX IF NOT EXISTS idx_events_correlation
          ON events (correlation_id);
      `);
    },
  },
  {
    version: 18,
    name: "outbox_delivery_failures",
    up(db) {
      const columns = new Set(
        db
          .query(`PRAGMA table_info(outbox)`)
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("delivery_attempts")) {
        db.exec(
          `ALTER TABLE outbox ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;`,
        );
      }
      if (!columns.has("delivery_error")) {
        db.exec(`ALTER TABLE outbox ADD COLUMN delivery_error TEXT;`);
      }
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
  "runtime_overrides",
  "runtime_override_journal",
  "tier_escalations",
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

/** Every connection's busy_timeout: plain writers block for up to this long. */
export const DB_BUSY_TIMEOUT_MS = 5_000;
/** One retryBusy() attempt: short, so the event loop is pinned briefly. */
export const DB_BUSY_ATTEMPT_TIMEOUT_MS = 100;
/** The whole retryBusy() budget across attempts (matches the connection). */
export const DB_BUSY_RETRY_TIMEOUT_MS = DB_BUSY_TIMEOUT_MS;

export function openDb(file = dbPath()) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  // busy_timeout FIRST: switching journal modes takes a brief exclusive lock,
  // and a second process opening the database concurrently must wait for it
  // rather than failing with SQLITE_BUSY_RECOVERY. Ordering matters here —
  // observed live the moment serve and work became separate processes.
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
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

/**
 * Retry an idempotent SQLite attempt without holding the event loop for the
 * connection's normal busy timeout (#1349).
 *
 * Each attempt runs with a short `busy_timeout` (restored afterwards), and a
 * busy failure sleeps across event-loop turns before trying again, until the
 * total budget is spent — the same ~5 s a plain writer would block for, but
 * with /health and other requests served in between. The callback must be
 * synchronous and contain the complete transaction, so a SQLITE_BUSY rollback
 * leaves each retry safe to repeat; a thenable is rejected outright because
 * the timeout is restored as soon as the callback returns.
 *
 * A connection whose `busy_timeout` was deliberately lowered below one attempt
 * keeps its fail-fast contract: that value bounds the attempt, and there is no
 * retry budget beyond it, so it errors after that single short wait.
 */
export async function retryBusy(
  db,
  attempt,
  {
    busyTimeoutMs = DB_BUSY_ATTEMPT_TIMEOUT_MS,
    timeoutMs = DB_BUSY_RETRY_TIMEOUT_MS,
    minDelayMs = 15,
    maxDelayMs = 50,
    random = Math.random,
  } = {},
) {
  if (typeof attempt !== "function")
    throw new TypeError("retryBusy: attempt must be a function");
  const connectionTimeout = Number(
    db.query("PRAGMA busy_timeout").get()?.timeout ?? DB_BUSY_TIMEOUT_MS,
  );
  const attemptTimeoutMs = Math.max(
    0,
    Math.floor(Math.min(busyTimeoutMs, connectionTimeout)),
  );
  // SQLite already waits the connection's own timeout inside that single
  // attempt, so there is nothing left to retry across turns.
  const budgetMs = connectionTimeout < busyTimeoutMs ? 0 : timeoutMs;
  const startedAt = Date.now();
  let lastBusyError;
  for (;;) {
    const previousTimeout = db.query("PRAGMA busy_timeout").get().timeout;
    db.exec(`PRAGMA busy_timeout = ${attemptTimeoutMs};`);
    try {
      const result = attempt();
      if (result !== null && typeof result?.then === "function") {
        throw new TypeError(
          "retryBusy: attempt must be synchronous (it returned a thenable); the per-attempt busy_timeout is restored as soon as it returns",
        );
      }
      return result;
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastBusyError = err;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${previousTimeout};`);
    }

    const remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw lastBusyError;
    const spread = Math.max(0, maxDelayMs - minDelayMs);
    const delayMs = Math.min(
      remainingMs,
      minDelayMs + Math.floor(random() * (spread + 1)),
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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

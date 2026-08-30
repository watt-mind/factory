import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-db-test-mjs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  assertSchema,
  DB_BUSY_ATTEMPT_TIMEOUT_MS,
  DB_BUSY_TIMEOUT_MS,
  getSchemaVersion,
  migrateDb,
  openDb,
  recordRunUsage,
  retryBusy,
  runUsage,
  runSubject,
  setSchemaVersion,
  txImmediate,
  usageSpend,
} from "./db.mjs";
import { dbPath, isTestOrCiProcess, runtimeHome } from "./config.mjs";
import { createIsolatedHome, realFactorySnapshot } from "../test-helpers.mjs";

const freshFile = () => path.join(tmpDir("evrt-db-"), "runtime.db");

describe("retryBusy (#1349)", () => {
  const busyError = () =>
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

  test("retries busy attempts asynchronously and restores the connection timeout", async () => {
    const db = openDb(":memory:");
    expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(
      DB_BUSY_TIMEOUT_MS,
    );
    let attempts = 0;
    const busy = busyError();
    await expect(
      retryBusy(
        db,
        () => {
          attempts += 1;
          expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(
            DB_BUSY_ATTEMPT_TIMEOUT_MS,
          );
          throw busy;
        },
        { timeoutMs: 5, minDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toBe(busy);
    expect(attempts).toBeGreaterThan(1);
    // Other users of the connection get the plain 5 s timeout back.
    expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(
      DB_BUSY_TIMEOUT_MS,
    );
    db.close();
  });

  test("returns the first successful attempt's result", async () => {
    const db = openDb(":memory:");
    let attempts = 0;
    const value = await retryBusy(
      db,
      () => {
        attempts += 1;
        if (attempts < 3) throw busyError();
        return { attempts };
      },
      { minDelayMs: 1, maxDelayMs: 1 },
    );
    expect(value).toEqual({ attempts: 3 });
    db.close();
  });

  test("non-busy errors propagate immediately", async () => {
    const db = openDb(":memory:");
    let attempts = 0;
    await expect(
      retryBusy(db, () => {
        attempts += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(1);
    expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(
      DB_BUSY_TIMEOUT_MS,
    );
    db.close();
  });

  test("a connection tuned below one attempt keeps its fail-fast contract", async () => {
    const db = openDb(":memory:");
    db.exec("PRAGMA busy_timeout = 10;");
    let attempts = 0;
    const busy = busyError();
    const startedAt = Date.now();
    await expect(
      retryBusy(db, () => {
        attempts += 1;
        expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(10);
        throw busy;
      }),
    ).rejects.toBe(busy);
    // The lowered timeout bounds the whole budget, not just one attempt.
    expect(attempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(10);
    db.close();
  });

  test("rejects an asynchronous attempt instead of restoring the timeout under it", async () => {
    const db = openDb(":memory:");
    await expect(retryBusy(db, async () => "never")).rejects.toThrow(
      /must be synchronous/,
    );
    expect(db.query("PRAGMA busy_timeout").get().timeout).toBe(
      DB_BUSY_TIMEOUT_MS,
    );
    db.close();
  });
});

describe("cold start (OPS-376, OPS-424)", () => {
  test("a second connection to a brand-new database does not fight for the WAL switch", () => {
    const file = freshFile();
    // The first open performs the switch; the second must find it already
    // done. Before OPS-376 the second raced for an exclusive lock that
    // busy_timeout does not cover, and one process died with SQLITE_BUSY —
    // exactly what serve and work did when worktree-up.sh started them together.
    const first = openDb(file);
    const second = openDb(file);
    expect(first.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    expect(second.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    // Both are usable, which is the property that actually matters.
    expect(second.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
    first.close();
    second.close();
  });

  test("many connections to one fresh database all open cleanly", () => {
    const file = freshFile();
    const connections = Array.from({ length: 8 }, () => openDb(file));
    for (const db of connections) {
      expect(db.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    }
    for (const db of connections) db.close();
  });

  test("reopening an existing WAL database takes no exclusive lock", () => {
    const file = freshFile();
    const held = openDb(file); // stays open, holding the database
    const second = openDb(file); // would block on an exclusive switch
    expect(second.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    held.close();
    second.close();
  });

  test("multi-process cold start: concurrent processes opening a brand-new database all reach WAL (OPS-424)", async () => {
    const file = freshFile();
    const N = 8;
    const procs = Array.from({ length: N }, () => {
      return Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { openDb } from "./event-runtime/lib/db.mjs";
            const db = openDb(process.argv[1]);
            const mode = db.query("PRAGMA journal_mode").get()?.journal_mode;
            if (mode !== "wal") {
              console.error("expected WAL mode, got " + mode);
              process.exit(1);
            }
            const count = db.query("SELECT COUNT(*) AS n FROM events").get()?.n;
            if (count !== 0) {
              console.error("expected 0 events, got " + count);
              process.exit(1);
            }
            db.close();
          `,
          file,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    });

    const results = await Promise.all(
      procs.map(async (p) => {
        const code = await p.exited;
        const err = await new Response(p.stderr).text();
        return { code, err };
      }),
    );

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    }

    const verifyDb = openDb(file);
    expect(verifyDb.query("PRAGMA journal_mode").get().journal_mode).toBe(
      "wal",
    );
    verifyDb.close();
  });
});

describe("synchronous mode (OPS-414)", () => {
  test("openDb sets synchronous = FULL (2) to guarantee durability on power loss", () => {
    const file = freshFile();
    const db = openDb(file);
    const syncMode = db.query("PRAGMA synchronous").get()?.synchronous;
    expect(syncMode).toBe(2); // 2 = FULL
    db.close();
  });
});

describe("schema migration runner and assertions (OPS-415)", () => {
  test("a fresh database is migrated to CURRENT_SCHEMA_VERSION on open", () => {
    const file = freshFile();
    const db = openDb(file);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    assertSchema(db);
    expect(
      db
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_causation'`,
        )
        .get()?.sql,
    ).toContain("events (causation_id, source)");
    db.close();
  });

  test("chain lookup indexes migrate idempotently onto an existing v13 database", () => {
    const file = freshFile();
    const db = new Database(file);
    migrateDb(db, { targetVersion: 13 });
    expect(getSchemaVersion(db)).toBe(13);
    expect(
      db
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_causation'`,
        )
        .get(),
    ).toBeNull();
    db.close();

    const migrated = openDb(file);
    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      migrated
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_causation'`,
        )
        .get()?.sql,
    ).toContain("events (causation_id, source)");
    expect(
      migrated
        .query(`PRAGMA table_info(runs)`)
        .all()
        .map((row) => row.name),
    ).toContain("chain_resolved_at");

    // Re-running the idempotent DDL is safe and preserves the index.
    MIGRATIONS.find((entry) => entry.version === 14).up(migrated);
    expect(
      migrated
        .query(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_causation'`,
        )
        .get().n,
    ).toBe(1);
    migrated.close();
  });

  test("tier escalation handoffs, inbox proposal IDs and lookup indexes reach schema 19 from a fresh and from a v14 database", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(19);
    const fresh = openDb(freshFile());
    expect(getSchemaVersion(fresh)).toBe(19);
    expect(
      fresh
        .query(`PRAGMA table_info(outbox)`)
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(["delivery_attempts", "delivery_error"]));
    expect(
      fresh
        .query(`PRAGMA table_info(runs)`)
        .all()
        .map((row) => row.name),
    ).toContain("subject");
    fresh.close();

    // #1230 (#1197) owns migration 14 and lands first; a database already at
    // 14 must pick up later migrations, and the guarded DDL must survive
    // re-running.
    const file = freshFile();
    const at14 = new Database(file);
    migrateDb(at14, { targetVersion: 13 });
    at14.exec("PRAGMA user_version = 14;");
    migrateDb(at14);
    expect(getSchemaVersion(at14)).toBe(19);
    expect(
      at14
        .query(`PRAGMA table_info(outbox)`)
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(["delivery_attempts", "delivery_error"]));
    expect(
      at14
        .query(`PRAGMA table_info(runs)`)
        .all()
        .map((row) => row.name),
    ).toContain("subject");
    migrateDb(at14);
    expect(getSchemaVersion(at14)).toBe(19);
    expect(
      at14
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tier_escalations'`,
        )
        .get()?.name,
    ).toBe("tier_escalations");
    at14.close();
  });

  test("inbox proposal ID migration backfills populated v15 rows and indexes the column", () => {
    const db = new Database(freshFile());
    migrateDb(db, { targetVersion: 15 });
    db.query(
      `INSERT INTO inbox_items (id, kind, title, refs_json, source, created_at)
       VALUES (?, 'decision_needed', ?, ?, 'cli', '2026-08-30T00:00:00.000Z')`,
    ).run("with-proposal", "with proposal", '{"proposalId":"proposal-1"}');
    db.query(
      `INSERT INTO inbox_items (id, kind, title, refs_json, source, created_at)
       VALUES (?, 'BLOCKED', ?, ?, 'cli', '2026-08-30T00:00:00.000Z')`,
    ).run("without-proposal", "without proposal", '{"repo":"factory"}');

    migrateDb(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(19);
    expect(getSchemaVersion(db)).toBe(19);
    expect(
      db
        .query(
          `SELECT id, proposal_id FROM inbox_items
           WHERE id IN ('with-proposal', 'without-proposal') ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "with-proposal", proposal_id: "proposal-1" },
      { id: "without-proposal", proposal_id: null },
    ]);
    expect(
      db
        .query(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_inbox_items_proposal_id'`,
        )
        .get()?.sql,
    ).toContain("inbox_items (proposal_id)");
    db.close();
  });

  test("tier escalation handoffs migrate with unique root and continuation ownership", () => {
    const db = openDb(freshFile());
    const columns = db
      .query(`PRAGMA table_info(tier_escalations)`)
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "root_run_id",
        "failed_run_id",
        "continuation_run_id",
        "workspace_path",
        "source_workspace_path",
        "projection_state",
      ]),
    );
    db.close();
  });

  test("runs subject migration retains ticket identifiers and indexes the column", () => {
    const db = new Database(freshFile());
    migrateDb(db, { targetVersion: 18 });
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(
      "with-ticket",
      "with-ticket-key",
      JSON.stringify({ input: { ticket: " wm-1503 " } }),
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    );
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(
      "with-subject",
      "with-subject-key",
      JSON.stringify({ subject: "watt-mind/factory#873" }),
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    );
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(
      "with-ambiguous-subject",
      "with-ambiguous-subject-key",
      JSON.stringify({ subject: "#865" }),
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    );
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(
      "without-ticket",
      "without-ticket-key",
      JSON.stringify({ input: { repo: "factory" } }),
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    );

    migrateDb(db);

    expect(getSchemaVersion(db)).toBe(19);
    expect(
      db.query(`SELECT run_id, subject FROM runs ORDER BY run_id`).all(),
    ).toEqual([
      { run_id: "with-ambiguous-subject", subject: null },
      { run_id: "with-subject", subject: "watt-mind/factory#873" },
      { run_id: "with-ticket", subject: "WM-1503" },
      { run_id: "without-ticket", subject: null },
    ]);
    expect(
      db
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_subject'`,
        )
        .get()?.sql,
    ).toContain("runs (subject)");
    db.close();
  });

  test("runSubject normalizes Linear IDs and retains GitHub refs verbatim", () => {
    expect(runSubject({ input: { ticket: " wm-1503 " } })).toBe("WM-1503");
    expect(runSubject({ subject: "watt-mind/factory#873" })).toBe(
      "watt-mind/factory#873",
    );
    expect(runSubject({ subject: "873" })).toBeNull();
  });

  test("hot proposal, inbox and runs subject lookup indexes upgrade an existing database", () => {
    const file = freshFile();
    const db = new Database(file);
    // #1325 owns migration 16 (inbox_proposal_id); a database already at 16
    // must pick up later migrations, and the guarded DDL must survive
    // re-running.
    migrateDb(db, { targetVersion: 16 });
    expect(getSchemaVersion(db)).toBe(16);
    db.close();

    const migrated = openDb(file);
    expect(getSchemaVersion(migrated)).toBe(19);
    migrateDb(migrated);
    expect(getSchemaVersion(migrated)).toBe(19);
    const plans = [
      [
        "metrics latest proposal",
        `SELECT p2.rowid FROM proposals p2
         WHERE p2.run_id = 'run-1'
         ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1`,
        "idx_proposals_run_id",
      ],
      [
        "event proposal",
        `SELECT p2.rowid FROM proposals p2
         WHERE p2.event_source = 'github' AND p2.event_id = 'event-1'
         ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1`,
        "idx_proposals_event",
      ],
      [
        "inbox correlation",
        `SELECT p.id FROM events e
         JOIN proposals p
           ON p.event_source = e.source AND p.event_id = e.event_id
         WHERE e.correlation_id = 'inbox-1'
         ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`,
        "idx_events_correlation",
      ],
      [
        "runs subject",
        `SELECT run_id FROM runs WHERE subject = 'WM-1503'`,
        "idx_runs_subject",
      ],
    ];

    for (const [name, sql, index] of plans) {
      const detail = migrated
        .query(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join("\n");
      expect(detail, name).toMatch(
        new RegExp(`USING (?:COVERING )?INDEX ${index}`),
      );
      expect(detail, name).not.toMatch(/SCAN (?:p2|p|e)\b/);
    }
    migrated.close();
  });

  test("metrics indexes migrate onto an existing v2 database (WM-281)", () => {
    const file = freshFile();
    const db = new Database(file);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 2))
      migration.up(db);
    setSchemaVersion(db, 2);
    db.close();

    const migrated = openDb(file);
    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION);
    const indexes = migrated
      .query(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("idx_lifecycle_at");
    expect(indexes).toContain("idx_runs_created_at");
    expect(indexes).toContain("idx_events_admitted_at");
    expect(indexes).toContain("idx_proposals_created_at");
    migrated.close();
  });

  test("an older/unversioned database (user_version 0) is migrated on open", () => {
    const file = freshFile();
    // Simulate an unversioned raw sqlite db
    const rawDb = new Database(file);
    expect(getSchemaVersion(rawDb)).toBe(0);
    rawDb.close();

    const db = openDb(file);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.query("SELECT count(*) as count FROM events").get()?.count).toBe(
      0,
    );
    db.close();
  });

  test("the inbox migration upgrades an existing v2 database and advances user_version", () => {
    const file = freshFile();
    const db = new Database(file);
    migrateDb(db, { targetVersion: 2 });
    expect(getSchemaVersion(db)).toBe(2);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_items'",
        )
        .get(),
    ).toBeNull();
    db.close();

    const upgraded = openDb(file);
    expect(getSchemaVersion(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      upgraded
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_items'",
        )
        .get()?.name,
    ).toBe("inbox_items");
    const columns = upgraded
      .query("PRAGMA table_info(inbox_items)")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual([
      "id",
      "kind",
      "severity",
      "title",
      "body",
      "refs_json",
      "source",
      "created_at",
      "acked_at",
      "resolved_at",
      "resolved_by",
      "delivery_json",
      "decision_json",
      "response_json",
      "decided_at",
      "decided_by",
      "dedupe_key",
      "resolved_reason",
      "waiters_json",
      "proposal_id",
    ]);
    upgraded.close();
  });

  test("the decision ledger migration upgrades a populated v5 inbox database", () => {
    const file = freshFile();
    const db = new Database(file);
    migrateDb(db, { targetVersion: 5 });
    db.query(
      `INSERT INTO inbox_items
         (id, kind, title, source, created_at)
       VALUES ('legacy', 'BLOCKED', 'legacy item', 'cli', '2026-08-16T00:00:00.000Z')`,
    ).run();
    expect(getSchemaVersion(db)).toBe(5);
    db.close();

    const upgraded = openDb(file);
    expect(getSchemaVersion(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
    const columns = upgraded
      .query("PRAGMA table_info(inbox_items)")
      .all()
      .map((row) => row.name);
    expect(columns.slice(-8)).toEqual([
      "decision_json",
      "response_json",
      "decided_at",
      "decided_by",
      "dedupe_key",
      "resolved_reason",
      "waiters_json",
      "proposal_id",
    ]);
    expect(
      upgraded.query("SELECT title FROM inbox_items WHERE id = 'legacy'").get()
        .title,
    ).toBe("legacy item");
    const index = upgraded
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'inbox_items_open_dedupe'`,
      )
      .get();
    expect(index.sql).toContain(
      "WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL",
    );
    upgraded.close();
  });

  test("runtime_overrides migrate onto an existing v7 database (WM-887)", () => {
    const file = freshFile();
    const db = new Database(file);
    migrateDb(db, { targetVersion: 7 });
    expect(getSchemaVersion(db)).toBe(7);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_overrides'",
        )
        .get(),
    ).toBeNull();
    db.close();

    const upgraded = openDb(file);
    expect(getSchemaVersion(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      upgraded
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_overrides'",
        )
        .get()?.name,
    ).toBe("runtime_overrides");
    expect(
      upgraded
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_override_journal'",
        )
        .get()?.name,
    ).toBe("runtime_override_journal");
    upgraded.close();
  });

  test("a database at a newer user_version refuses to open loudly with a clear message", () => {
    const file = freshFile();
    const db = openDb(file);
    setSchemaVersion(db, 999);
    db.close();

    expect(() => openDb(file)).toThrow(
      `Database schema version (999) is newer than code version (${CURRENT_SCHEMA_VERSION}). Please upgrade the runtime.`,
    );
  });

  test("adding a column in a migration works against an existing populated database fixture", () => {
    const file = freshFile();
    const db = openDb(file);

    // Populate with existing event fixture
    db.query(
      `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at)
       VALUES ('github', 'evt-415', 'issue.opened', '2026-08-14T00:00:00Z', '2026-08-14T00:00:01Z', '{}', 'hash1', '2026-08-14T00:00:01Z')`,
    ).run();

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    // Apply one custom migration after the real migration chain.
    const customVersion = CURRENT_SCHEMA_VERSION + 1;
    const migrationsWithCustom = [
      ...MIGRATIONS,
      {
        version: customVersion,
        name: "add_priority_to_events",
        up(targetDb) {
          targetDb.exec(
            "ALTER TABLE events ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';",
          );
        },
      },
    ];

    migrateDb(db, {
      migrations: migrationsWithCustom,
      targetVersion: customVersion,
    });
    expect(getSchemaVersion(db)).toBe(customVersion);

    // Verify existing row is preserved and has default value
    const row = db
      .query("SELECT event_id, priority FROM events WHERE event_id = 'evt-415'")
      .get();
    expect(row.event_id).toBe("evt-415");
    expect(row.priority).toBe("normal");

    // Verify we can write with the new column
    db.query(
      `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at, priority)
       VALUES ('github', 'evt-416', 'issue.closed', '2026-08-14T00:01:00Z', '2026-08-14T00:01:01Z', '{}', 'hash2', '2026-08-14T00:01:01Z', 'urgent')`,
    ).run();

    const row2 = db
      .query("SELECT event_id, priority FROM events WHERE event_id = 'evt-416'")
      .get();
    expect(row2.priority).toBe("urgent");

    db.close();
  });

  test("startup schema assertion catches drift / missing table", () => {
    const file = freshFile();
    const db = openDb(file);
    db.exec("DROP TABLE counters;");
    expect(() => assertSchema(db)).toThrow(
      'Database schema drift detected: missing table "counters"',
    );
    db.close();
  });

  test("startup schema assertion catches user_version mismatch", () => {
    const file = freshFile();
    const db = openDb(file);
    setSchemaVersion(db, 0);
    expect(() => assertSchema(db)).toThrow(
      `Database schema assertion failed: user_version is 0, expected ${CURRENT_SCHEMA_VERSION}`,
    );
    db.close();
  });
});

describe("run usage persistence and aggregation (WM-66)", () => {
  function insertRun(db, runId, agent, at) {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(
      runId,
      `idem-${runId}`,
      JSON.stringify({ agent, adapter: "fake" }),
      at,
      at,
    );
  }

  test("persists per-attempt usage across reopen and returns explicit totals", () => {
    const file = freshFile();
    const at = "2026-08-15T10:00:00.000Z";
    let db = openDb(file);
    insertRun(db, "run-usage-1", "agent-a@1", at);
    recordRunUsage(db, {
      runId: "run-usage-1",
      attempt: 1,
      adapter: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      costUSD: 0.5,
      recordedAt: at,
    });
    db.close();

    db = openDb(file);
    expect(runUsage(db, "run-usage-1")).toEqual({
      totals: {
        attempts: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
        totalTokens: 100,
        costUSD: 0.5,
      },
      attempts: [
        {
          attempt: 1,
          adapter: "claude",
          model: "claude-sonnet-4-6",
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 30,
          cacheReadInputTokens: 40,
          totalTokens: 100,
          costUSD: 0.5,
          recordedAt: at,
        },
      ],
    });
    db.close();
  });

  test("rolling windows and per-definition 24h totals exclude older usage", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    const rows = [
      ["run-recent-a", "agent-a@1", now - 30 * 60_000, 10, 5],
      ["run-day-a", "agent-a@1", now - 2 * 60 * 60_000, 20, 10],
      ["run-day-b", "agent-b@2", now - 23 * 60 * 60_000, 7, 3],
      ["run-old", "agent-b@2", now - 25 * 60 * 60_000, 1000, 1000],
    ];
    for (const [runId, agent, atMs, inputTokens, outputTokens] of rows) {
      const at = new Date(atMs).toISOString();
      insertRun(db, runId, agent, at);
      recordRunUsage(db, {
        runId,
        attempt: 1,
        adapter: "fake",
        inputTokens,
        outputTokens,
        recordedAt: at,
      });
    }

    expect(usageSpend(db, { now })).toEqual({
      rolling1h: {
        runs: 1,
        attempts: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 15,
        costUSD: 0,
      },
      rolling24h: {
        runs: 3,
        attempts: 3,
        inputTokens: 37,
        outputTokens: 18,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 55,
        costUSD: 0,
      },
      byAgent24h: [
        {
          agent: "agent-a@1",
          runs: 2,
          attempts: 2,
          inputTokens: 30,
          outputTokens: 15,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 45,
          costUSD: 0,
        },
        {
          agent: "agent-b@2",
          runs: 1,
          attempts: 1,
          inputTokens: 7,
          outputTokens: 3,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 10,
          costUSD: 0,
        },
      ],
    });
    db.close();
  });
});

describe("txImmediate (OPS-233)", () => {
  test("commits like a normal transaction and rolls back on throw", () => {
    const db = openDb(freshFile());
    txImmediate(db, () => {
      db.query(`INSERT INTO counters (name, value) VALUES ('x', 1)`).run();
    });
    expect(
      db.query(`SELECT value FROM counters WHERE name = 'x'`).get().value,
    ).toBe(1);

    expect(() =>
      txImmediate(db, () => {
        db.query(`UPDATE counters SET value = 99 WHERE name = 'x'`).run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(
      db.query(`SELECT value FROM counters WHERE name = 'x'`).get().value,
    ).toBe(1);
    db.close();
  });
});

describe("hermetic execution guard (OPS-425)", () => {
  const expectRealDbUnchanged = (before, after) => {
    expect(after.dbMtime).toBe(before.dbMtime);
  };

  test("isolated home directories never mutate the operator's real ~/.factory", () => {
    const before = realFactorySnapshot();
    const isolated = trackTmpDir(createIsolatedHome("evrt-guard-test-"));
    const testDbPath = path.join(isolated, "runtime.db");
    const db = openDb(testDbPath);
    db.query(`INSERT INTO counters (name, value) VALUES ('guard', 42)`).run();
    expect(
      db.query(`SELECT value FROM counters WHERE name = 'guard'`).get().value,
    ).toBe(42);
    db.close();
    const after = realFactorySnapshot();
    expectRealDbUnchanged(before, after);
  });

  test("detects a write to runtime.db in a supplied real-home fixture", () => {
    const factoryHome = tmpDir("evrt-real-home-");
    const eventHome = path.join(factoryHome, "event-runtime");
    const dbPath = path.join(eventHome, "runtime.db");
    try {
      mkdirSync(eventHome);
      writeFileSync(dbPath, "before");
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      utimesSync(dbPath, oldTime, oldTime);

      const before = realFactorySnapshot(factoryHome);
      expect(() =>
        expectRealDbUnchanged(before, realFactorySnapshot(factoryHome)),
      ).not.toThrow();

      appendFileSync(dbPath, " after");
      const after = realFactorySnapshot(factoryHome);
      expect(() => expectRealDbUnchanged(before, after)).toThrow();
    } finally {
      rmSync(factoryHome, { recursive: true, force: true });
    }
  });
});

describe("default runtime home guard (fail closed in tests/CI)", () => {
  const liveDefault = path.join(homedir(), ".factory", "event-runtime");

  test("bun test runs with NODE_ENV=test, so the guard is armed here", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(isTestOrCiProcess(process.env)).toBe(true);
  });

  test("refuses the default home when FACTORY_EVENT_HOME is unset in a test or CI process", () => {
    for (const env of [
      { NODE_ENV: "test" },
      { BUN_ENV: "test" },
      { CI: "true" },
      { CI: "1" },
    ]) {
      expect(() => runtimeHome(env)).toThrow(
        /refusing to use the default runtime home/,
      );
      expect(() => dbPath(runtimeHome(env))).toThrow();
    }
  });

  test("honours FACTORY_EVENT_HOME in a test or CI process", () => {
    const isolated = trackTmpDir(createIsolatedHome("evrt-guard-home-"));
    expect(
      runtimeHome({ NODE_ENV: "test", FACTORY_EVENT_HOME: isolated }),
    ).toBe(isolated);
    expect(runtimeHome({ CI: "true", FACTORY_EVENT_HOME: isolated })).toBe(
      isolated,
    );
  });

  test("plain operator processes still resolve ~/.factory/event-runtime", () => {
    for (const env of [
      {},
      { CI: "" },
      { CI: "false" },
      { NODE_ENV: "production" },
    ]) {
      expect(isTestOrCiProcess(env)).toBe(false);
      expect(runtimeHome(env)).toBe(liveDefault);
    }
  });

  test("openDb() with no path cannot reach the live database from this test process", () => {
    const saved = process.env.FACTORY_EVENT_HOME;
    delete process.env.FACTORY_EVENT_HOME;
    try {
      expect(() => openDb()).toThrow(
        /refusing to use the default runtime home/,
      );
    } finally {
      process.env.FACTORY_EVENT_HOME = saved;
    }
  });
});

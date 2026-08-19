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
import path from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  assertSchema,
  getSchemaVersion,
  migrateDb,
  openDb,
  recordRunUsage,
  runUsage,
  setSchemaVersion,
  txImmediate,
  usageSpend,
} from "./db.mjs";
import { createIsolatedHome, realFactorySnapshot } from "../test-helpers.mjs";

const freshFile = () => path.join(tmpDir("evrt-db-"), "runtime.db");

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
    db.close();
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
    expect(columns.slice(-7)).toEqual([
      "decision_json",
      "response_json",
      "decided_at",
      "decided_by",
      "dedupe_key",
      "resolved_reason",
      "waiters_json",
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

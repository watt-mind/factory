import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, txImmediate } from "./db.mjs";

const freshFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-db-")), "runtime.db");

describe("cold start (OPS-376)", () => {
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
});

describe("txImmediate (OPS-233)", () => {
  test("commits like a normal transaction and rolls back on throw", () => {
    const db = openDb(freshFile());
    txImmediate(db, () => {
      db.query(`INSERT INTO counters (name, value) VALUES ('x', 1)`).run();
    });
    expect(db.query(`SELECT value FROM counters WHERE name = 'x'`).get().value).toBe(1);

    expect(() =>
      txImmediate(db, () => {
        db.query(`UPDATE counters SET value = 99 WHERE name = 'x'`).run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.query(`SELECT value FROM counters WHERE name = 'x'`).get().value).toBe(1);
    db.close();
  });
});

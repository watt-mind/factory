import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-backup-test-mjs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  backupArtifacts,
  backupDatabase,
  checkIntegrity,
  restoreDatabase,
  snapshotLedger,
} from "./backup.mjs";
import { openDb } from "./db.mjs";

const freshDir = (prefix = "evrt-backup-") => tmpDir(prefix);

describe("WAL-safe backup and integrity check (OPS-414)", () => {
  test("checkIntegrity reports ok on a valid database", () => {
    const dir = freshDir();
    const dbFile = path.join(dir, "runtime.db");
    const db = openDb(dbFile);
    const result = checkIntegrity(db);
    expect(result.ok).toBe(true);
    expect(result.result).toBe("ok");
    expect(result.errors).toEqual([]);

    // Check by file path too
    const pathResult = checkIntegrity(dbFile);
    expect(pathResult.ok).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("checkIntegrity detects corruption in a broken database file", () => {
    const dir = freshDir();
    const corruptFile = path.join(dir, "corrupt.db");
    writeFileSync(
      corruptFile,
      "SQLite format 3\0" + "garbage bytes everywhere".repeat(50),
    );

    const res = checkIntegrity(corruptFile);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);

    expect(() => checkIntegrity(corruptFile, { throwOnError: true })).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  test("VACUUM INTO captures uncheckpointed WAL data where naive file copy loses it (negative test / falsifiability)", () => {
    const dir = freshDir();
    const liveDbFile = path.join(dir, "live.db");
    const naiveDbFile = path.join(dir, "naive.db");
    const backupDbFile = path.join(dir, "backup.db");

    const liveDb = openDb(liveDbFile);
    // Disable autocheckpoint so all writes stay in the WAL file
    liveDb.exec("PRAGMA wal_autocheckpoint = 0;");

    for (let i = 0; i < 200; i++) {
      liveDb
        .query(
          `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at)
         VALUES ('src', ?, 'test.event', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', '{}', 'hash', '2026-08-14T00:00:00Z')`,
        )
        .run(`evt-${i}`);
    }

    // Live db has 200 events
    expect(liveDb.query("SELECT COUNT(*) AS n FROM events").get().n).toBe(200);

    // 1. Naive file copy (only copying live.db, ignoring live.db-wal)
    copyFileSync(liveDbFile, naiveDbFile);
    const naiveDb = new Database(naiveDbFile);
    // Naive copy cannot see uncheckpointed table/data or has 0 rows
    let naiveCount;
    try {
      naiveCount =
        naiveDb.query("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
    } catch {
      naiveCount = -1; // table did not even exist in main db file
    }
    naiveDb.close();
    expect(naiveCount).not.toBe(200);

    // 2. WAL-safe backupDatabase using VACUUM INTO
    const backupRes = backupDatabase(liveDb, backupDbFile);
    expect(backupRes.integrity).toBe("ok");
    expect(backupRes.sizeBytes).toBeGreaterThan(0);

    const backupDb = openDb(backupDbFile);
    expect(backupDb.query("SELECT COUNT(*) AS n FROM events").get().n).toBe(
      200,
    );
    backupDb.close();

    liveDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("full backup, corrupt original, restore and verify roundtrip (acceptance criteria)", () => {
    const dir = freshDir();
    const liveDbFile = path.join(dir, "runtime.db");
    const backupDbFile = path.join(dir, "snapshots", "runtime-backup.db");

    const liveDb = openDb(liveDbFile);
    for (let i = 0; i < 150; i++) {
      liveDb
        .query(
          `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at)
         VALUES ('webhook', ?, 'push', '2026-08-14T12:00:00Z', '2026-08-14T12:00:01Z', '{"ref":"main"}', 'hash', '2026-08-14T12:00:01Z')`,
        )
        .run(`webhook-${i}`);
    }
    liveDb
      .query(
        `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES ('run-1', 'idem-1', '{}', 'hash', 'COMPLETED', 1, '2026-08-14T12:00:00Z', '2026-08-14T12:05:00Z')`,
      )
      .run();

    // 1. Perform backup
    backupDatabase(liveDb, backupDbFile);
    liveDb.close();

    // 2. Corrupt live database and its companion files
    writeFileSync(
      liveDbFile,
      "CORRUPTED DATA BY POWER FAILURE OR ACCIDENTAL TRUNCATION",
    );
    writeFileSync(`${liveDbFile}-wal`, "STALE TRASH");
    writeFileSync(`${liveDbFile}-shm`, "STALE TRASH");

    expect(() => openDb(liveDbFile)).toThrow();

    // 3. Restore database from backup
    const restoreRes = restoreDatabase(backupDbFile, liveDbFile);
    expect(restoreRes.restored).toBe(true);
    expect(existsSync(`${liveDbFile}-wal`)).toBe(false); // companion files purged on restore

    // 4. Verify restored runtime database works seamlessly
    const restoredDb = openDb(liveDbFile);
    expect(restoredDb.query("SELECT COUNT(*) AS n FROM events").get().n).toBe(
      150,
    );
    expect(restoredDb.query("SELECT COUNT(*) AS n FROM runs").get().n).toBe(1);
    expect(
      restoredDb.query("SELECT state FROM runs WHERE run_id = 'run-1'").get()
        .state,
    ).toBe("COMPLETED");
    expect(checkIntegrity(restoredDb).ok).toBe(true);

    restoredDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("restoreDatabase refuses to restore a corrupt backup file", () => {
    const dir = freshDir();
    const corruptBackup = path.join(dir, "corrupt-backup.db");
    const targetDb = path.join(dir, "target.db");
    writeFileSync(corruptBackup, "garbage bytes not a sqlite db");

    expect(() => restoreDatabase(corruptBackup, targetDb)).toThrow(
      /backup file is corrupt/,
    );
    expect(existsSync(targetDb)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test("snapshotLedger packages both SQLite database snapshot and artifacts folder", () => {
    const dir = freshDir();
    const liveDbFile = path.join(dir, "live", "runtime.db");
    const artifactsDir = path.join(dir, "live", "artifacts");
    const backupDir = path.join(dir, "backups");

    mkdirSync(artifactsDir, { recursive: true });
    const liveDb = openDb(liveDbFile);
    liveDb
      .query(
        `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at)
       VALUES ('source', 'evt-1', 'build', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', '{}', 'h1', '2026-08-14T00:00:00Z')`,
      )
      .run();

    // Create some artifacts
    const sha1 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const sha2 =
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
    writeFileSync(path.join(artifactsDir, sha1), "artifact data 1");
    writeFileSync(path.join(artifactsDir, sha2), "artifact data 2");

    const snapshot = snapshotLedger({
      db: liveDb,
      artifactsDir,
      backupDir,
      snapshotName: "snap-1",
    });

    expect(snapshot.snapshotPath).toBe(path.join(backupDir, "snap-1"));
    expect(existsSync(path.join(snapshot.snapshotPath, "runtime.db"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(snapshot.snapshotPath, "artifacts", sha1)),
    ).toBe(true);
    expect(
      existsSync(path.join(snapshot.snapshotPath, "artifacts", sha2)),
    ).toBe(true);
    expect(snapshot.artifactsBackup.copiedFiles).toBe(2);

    liveDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

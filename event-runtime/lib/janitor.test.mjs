import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-janitor-test-mjs";
import { openDb } from "./db.mjs";
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  janitorArgv,
  JANITOR_MAX_BUFFER,
  JANITOR_TIMEOUT_MS,
  sweepRuntimeRetention,
  spawnFactoryJanitor,
} from "./janitor.mjs";

describe("janitor", () => {
  test("janitorArgv never includes --force and adds --apply only when asked (OPS-301, OPS-364)", () => {
    const dry = janitorArgv("bj29");
    expect(dry).toContain("--json");
    expect(dry).toContain("bj29");
    expect(dry).not.toContain("--force");
    expect(dry).not.toContain("--apply");
    const apply = janitorArgv("bj29", { apply: true });
    expect(apply).toContain("--apply");
    expect(apply).not.toContain("--force");
    expect(apply.filter((a) => a === "--apply")).toHaveLength(1);
  });

  test("spawnFactoryJanitor is an async function (OPS-364)", () => {
    expect(typeof spawnFactoryJanitor).toBe("function");
    const promise = spawnFactoryJanitor("nonexistent-repo-test-12345");
    expect(promise instanceof Promise).toBe(true);
    return promise.catch((err) => {
      expect(err.status).toBe(404);
    });
  });

  test("spawnFactoryJanitor times out with 504 status", async () => {
    // Calling with timeoutMs = 1 against something that takes longer will time out
    const promise = spawnFactoryJanitor("bj29", { timeoutMs: 1 });
    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err.status).toBe(504);
      expect(err.message).toContain("janitor timed out");
    }
  });
});

describe("runtime retention", () => {
  test("dry-runs then deletes old traces and only artifacts unreferenced by recent runs", () => {
    const root = tmpDir("evrt-retention-");
    const store = path.join(root, "artifacts");
    const db = openDb(path.join(root, "runtime.db"));
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const kept = "a".repeat(64);
    const stale = "b".repeat(64);
    const orphan = "c".repeat(64);
    try {
      mkdirSync(store);
      for (const [runId, createdAt, hash] of [
        ["run-recent", recent, kept],
        ["run-old", old, stale],
      ]) {
        db.query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
           VALUES (?, ?, '{}', 'sha256:test', 'COMPLETED', 1, ?, ?)`,
        ).run(runId, `${runId}-key`, createdAt, createdAt);
        db.query(
          `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, 1, ?, 'sha256:test', '{}', '{}', ?)`,
        ).run(
          runId,
          JSON.stringify({ artifacts: [{ sha256: hash }] }),
          createdAt,
        );
      }
      db.query(
        `INSERT INTO attempt_trace (run_id, attempt, ts, kind, payload_json)
         VALUES ('run-old', 1, ?, 'assistant_text', '{}')`,
      ).run(old);
      db.query(
        `INSERT INTO attempt_trace (run_id, attempt, ts, kind, payload_json)
         VALUES ('run-recent', 1, ?, 'assistant_text', '{}')`,
      ).run(recent);
      for (const hash of [kept, stale, orphan]) {
        const file = path.join(store, hash);
        writeFileSync(file, hash);
        utimesSync(file, new Date(old), new Date(old));
      }

      const dry = sweepRuntimeRetention(db, store, { now });
      expect(dry).toMatchObject({
        trace: { deleted: 1, dryRun: true },
        artifacts: { deleted: 2, dryRun: true },
      });
      expect(
        db.query(`SELECT COUNT(*) AS count FROM attempt_trace`).get().count,
      ).toBe(2);
      expect(() => Bun.file(path.join(store, stale)).text()).not.toThrow();

      const applied = sweepRuntimeRetention(db, store, { now, apply: true });
      expect(applied.artifacts.deleted).toBe(2);
      expect(Bun.file(path.join(store, kept)).size).toBeGreaterThan(0);
      expect(Bun.file(path.join(store, stale)).size).toBe(0);
      expect(Bun.file(path.join(store, orphan)).size).toBe(0);
      expect(
        db.query(`SELECT COUNT(*) AS count FROM attempt_trace`).get().count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  test("retention defaults preserve the documented 30-day artifact window", () => {
    expect(DEFAULT_ARTIFACT_RETENTION_DAYS).toBe(30);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-janitor-test-mjs";
import { DEFAULT_PROPOSAL_TTL_SECONDS } from "./config.mjs";
import { openDb } from "./db.mjs";
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_ROW_RETENTION_DAYS,
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

describe("terminal row retention (#1065)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const old = new Date(now - 40 * DAY).toISOString();
  const recent = new Date(now - 1 * DAY).toISOString();
  const cutoff = new Date(now - DEFAULT_ROW_RETENTION_DAYS * DAY).toISOString();

  function insertRun(db, runId, state, updatedAt) {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, '{}', 'sha256:test', ?, 1, ?, ?)`,
    ).run(runId, `${runId}-key`, state, updatedAt, updatedAt);
  }

  function insertProposal(
    db,
    id,
    status,
    createdAt,
    ttlSeconds,
    { runId = null, decision = "run" } = {},
  ) {
    db.query(
      `INSERT INTO proposals
         (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES (?, 'test', ?, ?, ?, ?, ?, ?)`,
    ).run(id, `${id}-evt`, runId, decision, status, createdAt, ttlSeconds);
  }

  function insertEvent(db, eventId, admittedAt, archivedAt) {
    db.query(
      `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, status, admitted_at, archived_at)
       VALUES ('test', ?, 'ping', ?, ?, '{}', 'h', ?, ?, ?)`,
    ).run(
      eventId,
      admittedAt,
      admittedAt,
      archivedAt ? "dead_lettered" : "admitted",
      admittedAt,
      archivedAt,
    );
  }

  function seed(db) {
    // Runs: two terminal-old (deleted), everything else kept.
    insertRun(db, "run-completed-old", "COMPLETED", old);
    insertRun(db, "run-failed-old", "FAILED", old);
    insertRun(db, "run-running-old", "RUNNING", old); // active — keep
    insertRun(db, "run-queued-old", "QUEUED", old); // active — keep
    insertRun(db, "run-completed-recent", "COMPLETED", recent); // within window
    insertRun(db, "run-completed-boundary", "COMPLETED", cutoff); // == cutoff, strict < keeps

    // Child rows for one deleted run and one kept run.
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES ('run-completed-old', 1, '{}', 'sha256:test', '{}', '{}', ?)`,
    ).run(old);
    db.query(
      `INSERT INTO lifecycle_events (run_id, to_state, actor, at, record_hash)
       VALUES ('run-completed-old', 'COMPLETED', 'test', ?, 'h')`,
    ).run(old);
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES ('run-running-old', 1, '{}', 'sha256:test', '{}', '{}', ?)`,
    ).run(old);

    // Proposals: three terminal-old (deleted), three kept.
    insertProposal(db, "prop-rejected-old", "rejected", old, 3600);
    insertProposal(db, "prop-superseded-old", "superseded", old, 3600);
    insertProposal(db, "prop-open-expired-old", "open", old, 3600); // past TTL
    insertProposal(db, "prop-open-within-ttl-old", "open", old, 100 * 86400); // TTL not reached
    insertProposal(db, "prop-approved-old", "approved", old, 3600); // decided, kept
    insertProposal(db, "prop-open-fresh", "open", recent, 3600); // inside window

    // Events: one archived-old (deleted), two kept.
    insertEvent(db, "evt-archived-old", old, old);
    insertEvent(db, "evt-archived-recent", recent, recent);
    insertEvent(db, "evt-admitted-old", old, null);
  }

  function counts(db) {
    return {
      runs: db.query(`SELECT COUNT(*) AS c FROM runs`).get().c,
      proposals: db.query(`SELECT COUNT(*) AS c FROM proposals`).get().c,
      events: db.query(`SELECT COUNT(*) AS c FROM events`).get().c,
      results: db.query(`SELECT COUNT(*) AS c FROM results`).get().c,
      lifecycle: db.query(`SELECT COUNT(*) AS c FROM lifecycle_events`).get().c,
    };
  }

  test("dry-run counts terminal rows without deleting; --apply removes them and keeps active state", () => {
    const root = tmpDir("evrt-rows-");
    const store = path.join(root, "artifacts");
    const db = openDb(path.join(root, "runtime.db"));
    try {
      mkdirSync(store);
      seed(db);

      const dry = sweepRuntimeRetention(db, store, { now });
      expect(dry.runs).toEqual({ deleted: 2, dryRun: true });
      expect(dry.proposals).toEqual({ deleted: 3, dryRun: true });
      expect(dry.events).toEqual({ deleted: 1, dryRun: true });
      expect(dry.vacuum).toEqual({ ran: false });
      // Nothing actually removed on a dry run.
      expect(counts(db)).toMatchObject({ runs: 6, proposals: 6, events: 3 });

      const applied = sweepRuntimeRetention(db, store, { now, apply: true });
      expect(applied.runs).toEqual({ deleted: 2, dryRun: false });
      expect(applied.proposals).toEqual({ deleted: 3, dryRun: false });
      expect(applied.events).toEqual({ deleted: 1, dryRun: false });
      expect(applied.vacuum).toEqual({ ran: true });

      const after = counts(db);
      expect(after.runs).toBe(4);
      expect(after.proposals).toBe(3);
      expect(after.events).toBe(2);
      // Child rows of a deleted run are swept; a kept run's children remain.
      expect(after.results).toBe(1);
      expect(after.lifecycle).toBe(0);

      const survivingRuns = db
        .query(`SELECT run_id FROM runs ORDER BY run_id`)
        .all()
        .map((r) => r.run_id);
      expect(survivingRuns).toEqual([
        "run-completed-boundary",
        "run-completed-recent",
        "run-queued-old",
        "run-running-old",
      ]);

      const survivingProps = db
        .query(`SELECT id FROM proposals ORDER BY id`)
        .all()
        .map((r) => r.id);
      expect(survivingProps).toEqual([
        "prop-approved-old",
        "prop-open-fresh",
        "prop-open-within-ttl-old",
      ]);

      const survivingEvents = db
        .query(`SELECT event_id FROM events ORDER BY event_id`)
        .all()
        .map((r) => r.event_id);
      expect(survivingEvents).toEqual([
        "evt-admitted-old",
        "evt-archived-recent",
      ]);
    } finally {
      db.close();
    }
  });

  test("cutoff boundary is strict: a terminal run updated exactly at the cutoff is retained", () => {
    const root = tmpDir("evrt-boundary-");
    const store = path.join(root, "artifacts");
    const db = openDb(path.join(root, "runtime.db"));
    try {
      mkdirSync(store);
      insertRun(db, "run-at-cutoff", "COMPLETED", cutoff);
      insertRun(
        db,
        "run-just-before",
        "COMPLETED",
        new Date(now - 40 * DAY).toISOString(),
      );

      const dry = sweepRuntimeRetention(db, store, { now });
      expect(dry.runs.deleted).toBe(1);

      sweepRuntimeRetention(db, store, { now, apply: true });
      const remaining = db
        .query(`SELECT run_id FROM runs`)
        .all()
        .map((r) => r.run_id);
      expect(remaining).toEqual(["run-at-cutoff"]);
    } finally {
      db.close();
    }
  });

  test("terminalizes PROPOSED runs when no live proposal remains", () => {
    const root = tmpDir("evrt-proposed-rows-");
    const store = path.join(root, "artifacts");
    const db = openDb(path.join(root, "runtime.db"));
    const expired = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now - 5 * 60 * 1000).toISOString();
    const oldWithoutProposals = new Date(
      now - DEFAULT_PROPOSAL_TTL_SECONDS * 1000 - 1,
    ).toISOString();
    try {
      mkdirSync(store);
      for (const runId of [
        "run-expired",
        "run-rejected",
        "run-superseded",
        "run-resolved-noop",
        "run-expired-human-needed",
        "run-approved",
        "run-mixed",
        "run-open",
        "run-without-proposals-fresh",
        "run-without-proposals-old",
      ]) {
        insertRun(
          db,
          runId,
          "PROPOSED",
          runId === "run-without-proposals-old" ? oldWithoutProposals : fresh,
        );
      }
      insertProposal(db, "proposal-expired", "open", expired, 60, {
        runId: "run-expired",
      });
      insertProposal(db, "proposal-rejected", "rejected", fresh, 3600, {
        runId: "run-rejected",
      });
      insertProposal(db, "proposal-superseded", "superseded", fresh, 3600, {
        runId: "run-superseded",
      });
      insertProposal(db, "proposal-resolved-noop", "resolved", fresh, 3600, {
        runId: "run-resolved-noop",
        decision: "noop",
      });
      insertProposal(
        db,
        "proposal-expired-human-needed",
        "expired",
        fresh,
        3600,
        {
          runId: "run-expired-human-needed",
          decision: "human_needed",
        },
      );
      // This fixture must remain otherwise unreachable: approveRun transitions
      // PROPOSED -> APPROVED -> QUEUED before it marks the proposal approved,
      // and tier escalation transitions before inserting its approved proposal.
      // If either ordering changes, the janitor correctly sweeps this run.
      insertProposal(db, "proposal-approved", "approved", fresh, 3600, {
        runId: "run-approved",
      });
      insertProposal(db, "proposal-mixed-expired", "open", expired, 60, {
        runId: "run-mixed",
      });
      insertProposal(db, "proposal-mixed-open", "open", fresh, 3600, {
        runId: "run-mixed",
      });
      insertProposal(db, "proposal-open", "open", fresh, 3600, {
        runId: "run-open",
      });

      const dryLog = [];
      const dry = sweepRuntimeRetention(db, store, {
        now,
        log: (message) => dryLog.push(message),
      });
      expect(dry.proposed).toEqual({ cancelled: 7, dryRun: true });
      expect(dryLog).toEqual([
        "retention: 0 trace rows and 0 artifacts (0 bytes), 7 proposed runs would be cancelled, 0 runs, 0 proposals, 0 events would be deleted",
      ]);
      expect(
        db.query(`SELECT COUNT(*) AS count FROM lifecycle_events`).get().count,
      ).toBe(0);

      const applyLog = [];
      const applied = sweepRuntimeRetention(db, store, {
        now,
        apply: true,
        log: (message) => applyLog.push(message),
      });
      expect(applied.proposed).toEqual({ cancelled: 7, dryRun: false });
      expect(applyLog).toEqual([
        "retention: 0 trace rows and 0 artifacts (0 bytes), 7 proposed runs cancelled, 0 runs, 0 proposals, 0 events deleted (VACUUMed)",
      ]);
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-expired'`).get()
          .state,
      ).toBe("CANCELLED");
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-rejected'`).get()
          .state,
      ).toBe("CANCELLED");
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-superseded'`).get()
          .state,
      ).toBe("CANCELLED");
      expect(
        db
          .query(`SELECT state FROM runs WHERE run_id = 'run-resolved-noop'`)
          .get().state,
      ).toBe("CANCELLED");
      expect(
        db
          .query(
            `SELECT state FROM runs WHERE run_id = 'run-expired-human-needed'`,
          )
          .get().state,
      ).toBe("CANCELLED");
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-approved'`).get()
          .state,
      ).toBe("CANCELLED");
      expect(
        db
          .query(
            `SELECT state FROM runs
             WHERE run_id = 'run-without-proposals-fresh'`,
          )
          .get().state,
      ).toBe("PROPOSED");
      expect(
        db
          .query(
            `SELECT state FROM runs
             WHERE run_id = 'run-without-proposals-old'`,
          )
          .get().state,
      ).toBe("CANCELLED");
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-mixed'`).get()
          .state,
      ).toBe("PROPOSED");
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-open'`).get()
          .state,
      ).toBe("PROPOSED");
      expect(
        db
          .query(
            `SELECT reason FROM lifecycle_events
           WHERE run_id = 'run-expired' AND to_state = 'CANCELLED'`,
          )
          .get().reason,
      ).toBe("proposal_expired");

      expect(
        sweepRuntimeRetention(db, store, { now, apply: true }).proposed,
      ).toEqual({
        cancelled: 0,
        dryRun: false,
      });
    } finally {
      db.close();
    }
  });

  test("row retention default is 30 days", () => {
    expect(DEFAULT_ROW_RETENTION_DAYS).toBe(30);
  });
});

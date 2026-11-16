import { describe, expect, test } from "bun:test";
import * as fake from "./adapters/fake.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import {
  createRun,
  runState,
  subscribeRunLifecycle,
  transition,
} from "./lifecycle.mjs";
import { reapExpiredLeases } from "./reaper.mjs";
import { cancelRun, claimNext, forceFailRun, retryRun } from "./worker.mjs";
import { deregisterWorker, listWorkers, registerWorker } from "./workers.mjs";

const T0 = Date.parse("2026-08-12T10:00:00Z");

let seq = 0;
function makeSpec(overrides = {}) {
  const runId =
    overrides.runId ??
    `run_reaper_${++seq}_${Math.random().toString(36).slice(2)}`;
  const input = overrides.input ?? { repos: ["ok"] };
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: false },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds: 5,
    maxAttempts: 1,
    idempotencyKey: `idem-${runId}`,
    ...overrides,
  };
}

function setupVerifyingRun(db, spec, { now = T0, expired = false } = {}) {
  createRun(db, {
    runId: spec.runId,
    idempotencyKey: spec.idempotencyKey,
    spec,
    specJson: canonicalJson(spec),
    specHash: hashJson(spec),
    actor: "test",
    policyVersion: "test",
    now,
  });
  transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now });
  transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now });
  transition(db, {
    runId: spec.runId,
    to: "LEASED",
    actor: "test",
    attempt: 1,
    now,
  });
  transition(db, {
    runId: spec.runId,
    to: "RUNNING",
    actor: "test",
    attempt: 1,
    now,
  });
  transition(db, {
    runId: spec.runId,
    to: "VERIFYING",
    actor: "test",
    attempt: 1,
    now,
  });

  const leaseExpiresAt = new Date(
    expired ? now - 1000 : now + (spec.timeoutSeconds + 120) * 1000,
  ).toISOString();

  db.query(`UPDATE runs SET attempts = 1 WHERE run_id = ?`).run(spec.runId);
  db.query(
    `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(spec.runId, 1, 1, "worker-1", leaseExpiresAt);
}

describe("reaper (OPS-416)", () => {
  test("reaps stranded VERIFYING run and re-queues when attempts remain", () => {
    const db = openDb(":memory:");
    const spec = makeSpec({ maxAttempts: 2 });
    setupVerifyingRun(db, spec, { now: T0, expired: true });

    expect(runState(db, spec.runId)).toBe("VERIFYING");

    const reaped = reapExpiredLeases(db, { now: T0, policyVersion: "test" });
    expect(reaped).toEqual({ reaped: 1, errors: [] });
    expect(runState(db, spec.runId)).toBe("QUEUED");

    const events = db
      .query(
        `SELECT from_state, to_state, reason FROM lifecycle_events WHERE run_id = ? ORDER BY seq`,
      )
      .all(spec.runId);
    const lastTwo = events.slice(-2);
    expect(lastTwo[0]).toEqual({
      from_state: "VERIFYING",
      to_state: "FAILED",
      reason: "failure:environment:lease_expired",
    });
    expect(lastTwo[1]).toEqual({
      from_state: "FAILED",
      to_state: "QUEUED",
      reason: "retry:environment",
    });
  });

  test("reaps stranded VERIFYING run and dead-letters to FAILED when maxAttempts reached", () => {
    const db = openDb(":memory:");
    const spec = makeSpec({ maxAttempts: 1, maxEnvironmentRetries: 0 });
    setupVerifyingRun(db, spec, { now: T0, expired: true });

    expect(runState(db, spec.runId)).toBe("VERIFYING");

    const reaped = reapExpiredLeases(db, { now: T0, policyVersion: "test" });
    expect(reaped).toEqual({ reaped: 1, errors: [] });
    expect(runState(db, spec.runId)).toBe("FAILED");

    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("lease_expired");
  });

  test("continues reaping and pruning when one expired lease has corrupt spec JSON", () => {
    const db = openDb(":memory:");
    const corrupt = makeSpec({ maxAttempts: 2 });
    const healthy = makeSpec({ maxAttempts: 2 });
    setupVerifyingRun(db, corrupt, { now: T0, expired: true });
    setupVerifyingRun(db, healthy, { now: T0, expired: true });
    db.query(`UPDATE runs SET spec_json = '{' WHERE run_id = ?`).run(
      corrupt.runId,
    );

    registerWorker(db, { workerId: "stale", now: T0 - 48 * 60 * 60 * 1000 });
    deregisterWorker(db, "stale", { now: T0 - 30 * 60 * 60 * 1000 });

    const logged = [];
    const result = reapExpiredLeases(db, {
      now: T0,
      policyVersion: "test",
      log: (line) => logged.push(line),
    });

    expect(result.reaped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].runId).toBe(corrupt.runId);
    expect(result.errors[0].error).toBeInstanceOf(Error);
    expect(result.errors[0].error.message).toMatch(/JSON/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[reaper]");
    expect(logged[0]).toContain(corrupt.runId);
    expect(runState(db, corrupt.runId)).toBe("VERIFYING");
    expect(runState(db, healthy.runId)).toBe("QUEUED");
    expect(
      listWorkers(db, { now: T0 }).map((worker) => worker.workerId),
    ).not.toContain("stale");
  });

  test("logs and skips a row whose transition edge is illegal; others still reap and count", () => {
    const db = openDb(":memory:");
    const healthy = makeSpec({ maxAttempts: 2 });
    const poisoned = makeSpec({ maxAttempts: 2 });
    setupVerifyingRun(db, healthy, { now: T0, expired: true });
    setupVerifyingRun(db, poisoned, { now: T0, expired: true });

    // The reaper drives VERIFYING -> FAILED -> QUEUED. Yank the poisoned run
    // to a terminal state right after its first hop so the second hop is an
    // illegal edge (COMPLETED -> QUEUED). The spec itself stays valid, so this
    // exercises the non-corrupt failure path with a real Error object.
    const unsubscribe = subscribeRunLifecycle((event) => {
      if (event.runId === poisoned.runId && event.to === "FAILED") {
        db.query(`UPDATE runs SET state = 'COMPLETED' WHERE run_id = ?`).run(
          poisoned.runId,
        );
      }
    });
    const logged = [];
    let result;
    try {
      result = reapExpiredLeases(db, {
        now: T0,
        policyVersion: "test",
        log: (line) => logged.push(line),
      });
    } finally {
      unsubscribe();
    }

    expect(result.reaped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].runId).toBe(poisoned.runId);
    expect(result.errors[0].error).toBeInstanceOf(Error);
    expect(result.errors[0].error.name).toBe("IllegalTransition");
    expect(result.errors[0].error.stack).toBeString();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[reaper]");
    expect(logged[0]).toContain(poisoned.runId);
    expect(logged[0]).toContain("illegal transition");
    // The poisoned row's partial work rolled back with its transaction.
    expect(runState(db, poisoned.runId)).toBe("VERIFYING");
    expect(
      db
        .query(`SELECT terminal_state FROM attempts WHERE run_id = ?`)
        .get(poisoned.runId).terminal_state,
    ).toBeNull();
    expect(runState(db, healthy.runId)).toBe("QUEUED");
  });

  test("does not reap a lease renewed between the candidate scan and the per-row transaction", () => {
    const db = openDb(":memory:");
    const first = makeSpec({ maxAttempts: 2 });
    const renewed = makeSpec({ maxAttempts: 2 });
    setupVerifyingRun(db, first, { now: T0, expired: true });
    setupVerifyingRun(db, renewed, { now: T0, expired: true });

    // Both rows are expired when the reaper scans. While it is reaping the
    // first, a worker renews the second's lease; the per-row transaction must
    // re-validate the lease and leave the renewed run alone.
    const renewedAt = new Date(T0 + 10 * 60 * 1000).toISOString();
    const unsubscribe = subscribeRunLifecycle((event) => {
      if (event.runId === first.runId) {
        db.query(
          `UPDATE attempts SET lease_expires_at = ? WHERE run_id = ? AND attempt = 1`,
        ).run(renewedAt, renewed.runId);
      }
    });
    const eventsBefore = db
      .query(`SELECT COUNT(*) AS n FROM lifecycle_events WHERE run_id = ?`)
      .get(renewed.runId).n;
    let result;
    try {
      result = reapExpiredLeases(db, { now: T0, policyVersion: "test" });
    } finally {
      unsubscribe();
    }

    expect(result).toEqual({ reaped: 1, errors: [] });
    expect(runState(db, first.runId)).toBe("QUEUED");
    expect(runState(db, renewed.runId)).toBe("VERIFYING");
    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(renewed.runId);
    expect(attempt.terminal_state).toBeNull();
    expect(attempt.lease_expires_at).toBe(renewedAt);
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM lifecycle_events WHERE run_id = ?`)
        .get(renewed.runId).n,
    ).toBe(eventsBefore);
  });

  test("cancelRun from VERIFYING transitions cleanly to FAILED without 409", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    setupVerifyingRun(db, spec, { now: T0, expired: false });

    expect(runState(db, spec.runId)).toBe("VERIFYING");
    cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(runState(db, spec.runId)).toBe("FAILED");

    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("cancelled");
  });

  test("forceFailRun on VERIFYING transitions to FAILED with audited journal entry", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    setupVerifyingRun(db, spec, { now: T0, expired: false });

    forceFailRun(db, spec.runId, {
      actor: "operator",
      reason: "stuck_in_verification",
      policyVersion: "test",
      now: T0,
    });
    expect(runState(db, spec.runId)).toBe("FAILED");

    const events = db
      .query(
        `SELECT from_state, to_state, reason, actor FROM lifecycle_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(spec.runId);
    expect(events.from_state).toBe("VERIFYING");
    expect(events.to_state).toBe("FAILED");
    expect(events.reason).toBe("stuck_in_verification");
    expect(events.actor).toBe("operator");
  });

  test("retryRun from VERIFYING moves to FAILED then QUEUED", () => {
    const db = openDb(":memory:");
    const spec = makeSpec({ maxAttempts: 2 });
    setupVerifyingRun(db, spec, { now: T0, expired: false });

    retryRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(runState(db, spec.runId)).toBe("QUEUED");

    const events = db
      .query(
        `SELECT from_state, to_state, reason FROM lifecycle_events WHERE run_id = ? ORDER BY seq`,
      )
      .all(spec.runId);
    const lastTwo = events.slice(-2);
    expect(lastTwo[0]).toEqual({
      from_state: "VERIFYING",
      to_state: "FAILED",
      reason: "operator_retry_verifying",
    });
    expect(lastTwo[1]).toEqual({
      from_state: "FAILED",
      to_state: "QUEUED",
      reason: "operator_retry",
    });
  });

  test("prunes expired stopped and dead workers during reap cycle", () => {
    const db = openDb(":memory:");
    const hour = 60 * 60 * 1000;
    registerWorker(db, { workerId: "w1", now: T0 });
    registerWorker(db, { workerId: "w2", now: T0 });
    registerWorker(db, { workerId: "w3", now: T0 });
    registerWorker(db, { workerId: "w4", now: T0 });
    registerWorker(db, { workerId: "w5", now: T0 });

    // w1: stopped 2 hours ago (> 1h retention window).
    deregisterWorker(db, "w1", { now: T0 - 2 * hour });
    // w3: stopped 30 minutes ago (< 1h retention window).
    deregisterWorker(db, "w3", { now: T0 - 30 * 60 * 1000 });
    // w4: dead for more than 6 hours without a lease.
    // w5: stale, but still owns an active attempt and must remain visible.
    for (const workerId of ["w4", "w5"]) {
      db.query(`UPDATE workers SET last_seen = ? WHERE worker_id = ?`).run(
        new Date(T0 - 7 * hour).toISOString(),
        workerId,
      );
    }
    const leased = makeSpec({ runId: "run-leased-worker", maxAttempts: 2 });
    setupVerifyingRun(db, leased, { now: T0, expired: false });
    db.query(`UPDATE attempts SET lease_owner = ? WHERE run_id = ?`).run(
      "w5",
      leased.runId,
    );
    expect(listWorkers(db, { now: T0 })).toHaveLength(5);

    reapExpiredLeases(db, { now: T0, policyVersion: "test" });

    const remaining = listWorkers(db, { now: T0 });
    expect(remaining.map((w) => w.workerId).sort()).toEqual(["w2", "w3", "w5"]);
  });

  test("returns reaped leases when worker pruning fails", () => {
    const db = openDb(":memory:");
    const healthy = makeSpec({ maxAttempts: 2 });
    setupVerifyingRun(db, healthy, { now: T0, expired: true });
    const logged = [];
    const pruneError = new Error("worker table busy");

    const result = reapExpiredLeases(db, {
      now: T0,
      policyVersion: "test",
      log: (line) => logged.push(line),
      pruneWorkers: () => {
        throw pruneError;
      },
    });

    expect(result.reaped).toBe(1);
    expect(result.errors).toEqual([
      { runId: null, stage: "prune_workers", error: pruneError },
    ]);
    expect(logged).toEqual([
      "[reaper] worker prune skipped: worker table busy",
    ]);
    expect(runState(db, healthy.runId)).toBe("QUEUED");
  });
});

import { describe, expect, test } from "bun:test";
import * as fake from "./adapters/fake.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { createRun, runState, transition } from "./lifecycle.mjs";
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

    const result = reapExpiredLeases(db, { now: T0, policyVersion: "test" });

    expect(result.reaped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(corrupt.runId);
    expect(runState(db, corrupt.runId)).toBe("VERIFYING");
    expect(runState(db, healthy.runId)).toBe("QUEUED");
    expect(
      listWorkers(db, { now: T0 }).map((worker) => worker.workerId),
    ).not.toContain("stale");
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

  test("prunes stale stopped workers during reap cycle (OPS-431)", () => {
    const db = openDb(":memory:");
    // w1: stopped 30 hours ago (> 24h retention window)
    registerWorker(db, { workerId: "w1", now: T0 - 48 * 60 * 60 * 1000 });
    deregisterWorker(db, "w1", { now: T0 - 30 * 60 * 60 * 1000 });

    // w2: active worker
    registerWorker(db, { workerId: "w2", now: T0 });

    // w3: stopped 2 hours ago (< 24h retention window)
    registerWorker(db, { workerId: "w3", now: T0 - 5 * 60 * 60 * 1000 });
    deregisterWorker(db, "w3", { now: T0 - 2 * 60 * 60 * 1000 });

    expect(listWorkers(db, { now: T0 })).toHaveLength(3);

    reapExpiredLeases(db, { now: T0, policyVersion: "test" });

    const remaining = listWorkers(db, { now: T0 });
    expect(remaining.map((w) => w.workerId).sort()).toEqual(["w2", "w3"]);
  });
});

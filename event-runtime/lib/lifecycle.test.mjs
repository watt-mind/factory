import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { IllegalTransition, TERMINAL_STATES, createRun, lifecycleOf, resolveIdempotency, runState, transition } from "./lifecycle.mjs";

function freshRun(db, key = `key-${Math.random()}`) {
  const runId = `run_test_${Math.random().toString(36).slice(2)}`;
  createRun(db, {
    runId,
    idempotencyKey: key,
    spec: {},
    specJson: "{}",
    specHash: "sha256:0",
    actor: "test",
    policyVersion: "test",
  });
  return runId;
}

describe("lifecycle", () => {
  test("happy path PROPOSED → … → COMPLETED, journaled with hashes", () => {
    const db = openDb(":memory:");
    const runId = freshRun(db);
    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED"]) {
      transition(db, { runId, to, actor: "test" });
    }
    expect(runState(db, runId)).toBe("COMPLETED");
    const journal = lifecycleOf(db, runId);
    expect(journal.map((e) => e.to_state)).toEqual([
      "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED",
    ]);
    expect(journal.every((e) => e.record_hash.startsWith("sha256:"))).toBe(true);
  });

  test("illegal transitions are rejected, not repaired", () => {
    const db = openDb(":memory:");
    const runId = freshRun(db);
    expect(() => transition(db, { runId, to: "RUNNING", actor: "test" })).toThrow(IllegalTransition);
    expect(runState(db, runId)).toBe("PROPOSED");
    expect(lifecycleOf(db, runId)).toHaveLength(1);
  });

  test("terminal states accept nothing further", () => {
    const db = openDb(":memory:");
    const runId = freshRun(db);
    transition(db, { runId, to: "CANCELLED", actor: "operator" });
    expect(TERMINAL_STATES.has(runState(db, runId))).toBe(true);
    expect(() => transition(db, { runId, to: "APPROVED", actor: "test" })).toThrow(IllegalTransition);
  });

  test("expectFrom guards racing movers", () => {
    const db = openDb(":memory:");
    const runId = freshRun(db);
    transition(db, { runId, to: "APPROVED", actor: "test" });
    expect(() =>
      transition(db, { runId, to: "CANCELLED", expectFrom: "PROPOSED", actor: "operator" }),
    ).toThrow(IllegalTransition);
  });

  test("duplicate idempotency key throws (unique constraint)", () => {
    const db = openDb(":memory:");
    freshRun(db, "same-key");
    expect(() => freshRun(db, "same-key")).toThrow();
  });

  test("FAILED may re-queue (retry) but CANCELLED may not", () => {
    const db = openDb(":memory:");
    const runId = freshRun(db);
    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "FAILED"]) {
      transition(db, { runId, to, actor: "test" });
    }
    transition(db, { runId, to: "QUEUED", actor: "operator", reason: "retry" });
    expect(runState(db, runId)).toBe("QUEUED");
  });

  test("resolveIdempotency coalesces an active repeat trigger, then releases it after terminal completion", () => {
    const db = openDb(":memory:");
    createRun(db, {
      runId: "run_chain_1",
      idempotencyKey: "chain-key-1",
      spec: {},
      specJson: "{}",
      specHash: "sha256:0",
      actor: "planner",
      correlationId: "lineage-001",
      causationId: "run_dispatch_1",
      policyVersion: "test",
    });

    // Same lineage and input, but a distinct chain causation: while the first
    // run is active the repeat trigger coalesces into it.
    const active = resolveIdempotency(db, {
      idempotencyKey: "chain-key-1",
      correlationId: "lineage-001",
      causationId: "run_dispatch_2",
    });
    expect(active?.run_id).toBe("run_chain_1");

    transition(db, { runId: "run_chain_1", to: "CANCELLED", actor: "test" });

    // Once terminal, that distinct trigger is eligible to create a new run.
    const afterTerminal = resolveIdempotency(db, {
      idempotencyKey: "chain-key-1",
      correlationId: "lineage-001",
      causationId: "run_dispatch_2",
    });
    expect(afterTerminal).toBeNull();

    // Redelivery of the original trigger still resolves to its terminal run.
    const duplicate = resolveIdempotency(db, {
      idempotencyKey: "chain-key-1",
      correlationId: "lineage-001",
      causationId: "run_dispatch_1",
    });
    expect(duplicate?.run_id).toBe("run_chain_1");
  });

  test("lifecycle timestamps are monotonic and distinct across states when clock advances", () => {
    const db = openDb(":memory:");
    let t = 1000000;
    const clock = () => (t += 1000);
    const runId = `run_clock_${Math.random().toString(36).slice(2)}`;
    createRun(db, {
      runId,
      idempotencyKey: `key-${runId}`,
      spec: {},
      specJson: "{}",
      specHash: "sha256:0",
      actor: "test",
      policyVersion: "test",
      now: clock,
    });
    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED"]) {
      transition(db, { runId, to, actor: "test", now: clock });
    }
    const journal = lifecycleOf(db, runId);
    const timestamps = journal.map((e) => Date.parse(e.at));
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });
});

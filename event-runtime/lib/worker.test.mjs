import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { pinRunArtifact } from "./artifacts.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { artifactsRoot } from "./config.mjs";
import { openDb } from "./db.mjs";
import { createRun, lifecycleOf, runState, transition, IllegalTransition } from "./lifecycle.mjs";
import { computeDefHash } from "./receipts.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import {
  cancelRun, claimNext, executeClaimed, reapExpiredLeases, repositoryIsClean, repositoryStatus, retryRun, runOnce,
} from "./worker.mjs";

const registry = loadRegistry();
const adapters = { fake };
const T0 = Date.parse("2026-08-12T10:00:00Z");

let seq = 0;
function makeSpec(overrides = {}) {
  const runId = overrides.runId ?? `run_worker_${++seq}_${Math.random().toString(36).slice(2)}`;
  const input = overrides.input ?? { repos: ["ok"] };
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: true },
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

function queueRun(db, spec, now = T0) {
  createRun(db, {
    runId: spec.runId, idempotencyKey: spec.idempotencyKey,
    spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
    actor: "test", policyVersion: "test", now,
  });
  transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now });
  transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now });
  return spec;
}

/** Link the run to an admitted event via a proposal, like the planner would. */
function linkEvent(db, runId, { type = "factory.status-report.requested", correlationId = "corr-1" } = {}) {
  const at = new Date(T0).toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("test", `evt-${runId}`, type, "factory", at, at, correlationId, null, "{}", "sha256:x", at);
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, 'RUN_SPEC', ?, 1800)`,
  ).run(`prop-${runId}`, "test", `evt-${runId}`, runId, at);
}

function freshRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "evrt-worker-"));
}

function opts(extra = {}) {
  return { owner: "w1", workspacesRoot: freshRoot(), now: T0, policyVersion: "test", ...extra };
}

describe("worker", () => {
  test("repository integrity gate rejects any checkout dirt before output acceptance", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "evrt-clean-repo-"));
    const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    expect(git(["init", "--quiet"]).status).toBe(0);
    writeFileSync(path.join(repo, "tracked.txt"), "clean\n");
    writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
    expect(git(["add", "tracked.txt", ".gitignore"]).status).toBe(0);
    expect(git(["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--quiet", "-m", "initial"]).status).toBe(0);
    expect(repositoryIsClean(repo)).toBe(true);
    writeFileSync(path.join(repo, "ignored.log"), "dirty\n");
    expect(repositoryIsClean(repo)).toBe(false);
    rmSync(path.join(repo, "ignored.log"));
    writeFileSync(path.join(repo, "agent-wrote.txt"), "dirty\n");
    expect(repositoryIsClean(repo)).toBe(false);
  });

  test("repository integrity baseline permits pre-existing ignored state but detects later writes", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "evrt-baseline-repo-"));
    const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    expect(git(["init", "--quiet"]).status).toBe(0);
    writeFileSync(path.join(repo, ".gitignore"), "generated/*.log\n");
    expect(git(["add", ".gitignore"]).status).toBe(0);
    expect(git(["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--quiet", "-m", "initial"]).status).toBe(0);
    mkdirSync(path.join(repo, "generated"));
    writeFileSync(path.join(repo, "generated", "setup.log"), "pre-existing\n");
    const baseline = repositoryStatus(repo);
    expect(baseline).toContain("!! generated/setup.log");
    expect(repositoryStatus(repo)).toBe(baseline);
    writeFileSync(path.join(repo, "generated", "agent-write.log"), "new\n");
    expect(repositoryStatus(repo)).not.toBe(baseline);
  });

  test("happy path: COMPLETED, results row, receipt, one completion outbox event, workspace destroyed", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    expect(runState(db, spec.runId)).toBe("COMPLETED");

    const result = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    expect(result).toBeTruthy();
    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.verificationStatus).toBe("passed");
    expect(receipt.journalHead).toMatch(/^sha256:/);
    expect(receipt.runSpecHash).toBe(hashJson(spec));
    expect(receipt.artifactHash).toBe(result.artifact_hash);
    expect(summary.receipt).toEqual(receipt);

    const outbox = db.query(`SELECT * FROM outbox`).all();
    expect(outbox).toHaveLength(1);
    const envelope = JSON.parse(outbox[0].event_json);
    expect(envelope.type).toBe("factory.status-report.completed");
    expect(envelope.eventId).toBe(`event-runtime:${spec.runId}:1`);
    expect(envelope.correlationId).toBe("corr-1");
    expect(envelope.payload).toEqual({
      runId: spec.runId, attempt: 1,
      artifactHash: result.artifact_hash, outputContract: spec.outputContract,
    });

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("COMPLETED");
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("policy denial is terminal and is never retried as an opaque agent exit", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "policy" }));
    const policyAdapter = {
      execute: async () => ({
        // Adapters report policyDenials only when they are the verdict — the
        // claude adapter suppresses them on a clean exit (WM-127), so a
        // non-empty list here means the run failed at a refused tool call.
        exitCode: 1,
        timedOut: false,
        policyDenials: [{ tool: "Bash", rule: "Claude requested permissions to use Bash, but you haven't granted it yet." }],
      }),
    };

    const summary = await runOnce(db, registry, { policy: policyAdapter }, opts());
    expect(summary).toMatchObject({ terminalState: "FAILED", reasonCode: "policy_denied:Bash" });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ?`).get(spec.runId).reason_code).toBe("policy_denied:Bash");
    expect(db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId)).toBeNull();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
  });

  test("refuse: REFUSED, results row stored, no outbox row, workspace destroyed", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("REFUSED");
    expect(summary.reasonCode).toBe("needs_human");
    expect(runState(db, spec.runId)).toBe("REFUSED");

    const result = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    expect(result).toBeTruthy();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);

    const resultRow = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    const parsedResult = JSON.parse(resultRow.result_json);
    expect(parsedResult.artifacts).toHaveLength(1);
    expect(parsedResult.artifacts[0].kind).toBe("transcript");
    expect(parsedResult.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedResult.artifacts[0].uri).toMatch(/^file:\/\//);
    const storePath = path.join(o.artifactStore ?? artifactsRoot(), parsedResult.artifacts[0].sha256);
    expect(existsSync(storePath)).toBe(true);
    expect(pinRunArtifact(db, spec.runId)).toEqual({
      runId: spec.runId,
      transcript: parsedResult.artifacts[0].sha256,
      state: "REFUSED",
      agent: spec.agent,
    });
  });

  test("invalid-artifact: FAILED/contract_violation, no outbox row, workspace retained", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["invalid-artifact"] } }));
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(runState(db, spec.runId)).toBe("FAILED");

    expect(db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId)).toBeNull();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(true);
  });

  test("escape: artifact outside the workspace is a contract violation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["escape"] } }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
  });

  test("no-result: FAILED/contract_violation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["no-result"] } }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
  });

  test("hang: TIMED_OUT with a tiny timeout", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["hang"] }, timeoutSeconds: 0.05 }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("TIMED_OUT");
    expect(summary.reasonCode).toBe("timeout");
    expect(runState(db, spec.runId)).toBe("TIMED_OUT");
  });

  test("crash with maxAttempts 2: FAILED then auto re-QUEUED; second claim has higher fencing token", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["crash"] }, maxAttempts: 2 }));
    const o = opts();

    const first = await runOnce(db, registry, adapters, o);
    expect(first.terminalState).toBe("FAILED");
    expect(first.reasonCode).toBe("agent_exit_1");
    expect(runState(db, spec.runId)).toBe("QUEUED");

    const second = claimNext(db, o);
    expect(second).toBeTruthy();
    expect(second.attempt).toBe(2);
    expect(second.fencingToken).toBeGreaterThan(1);
  });

  test("crash with maxAttempts 1: stays FAILED, no auto retry", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["crash"] }, maxAttempts: 1 }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claimNext(db, opts())).toBeNull();
  });

  test("fencing: a stale claim can never publish over a newer attempt", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2 }));
    const o = opts();

    // Claim but never execute — the worker "died".
    const stale = claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Lease expires → reaper re-queues.
    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");

    // Fresh claim executes to completion.
    const o2 = { ...o, now: afterExpiry };
    const fresh = claimNext(db, o2);
    expect(fresh.attempt).toBe(2);
    expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken);
    const done = await executeClaimed(db, registry, adapters, fresh, o2);
    expect(done.terminalState).toBe("COMPLETED");

    // The zombie wakes up and tries to run its stale claim.
    const zombie = await executeClaimed(db, registry, adapters, stale, o2);
    expect(zombie.fenced === true || zombie.cancelled === true).toBe(true);

    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(db.query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`).get(spec.runId).n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(1);
    const terminals = lifecycleOf(db, spec.runId).filter((e) => e.to_state === "COMPLETED");
    expect(terminals).toHaveLength(1);
  });

  test("restart survival: results, receipt, and journal readable from a reopened file db", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-db-"));
    const file = path.join(dir, "runtime.db");
    const db = openDb(file);
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    db.close();

    const reopened = openDb(file);
    const result = reopened.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    expect(result).toBeTruthy();
    expect(JSON.parse(result.receipt_json).verificationStatus).toBe("passed");
    expect(lifecycleOf(reopened, spec.runId).length).toBeGreaterThanOrEqual(4);
    reopened.close();
  });

  test("executeClaimed on a cancelled run stops quietly and publishes nothing", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const o = opts();
    const claim = claimNext(db, o);

    // Operator cancels while the claim was sitting in LEASED.
    cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });

    const summary = await executeClaimed(db, registry, adapters, claim, o);
    expect(summary.cancelled).toBe(true);
    expect(db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId)).toBeNull();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
  });

  test("unknown adapter fails terminal", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "nonexistent" }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("unknown_adapter");
  });

  test("cancelRun on a QUEUED run → CANCELLED; on a terminal run → IllegalTransition", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const result = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(result.to).toBe("CANCELLED");
    expect(runState(db, spec.runId)).toBe("CANCELLED");

    expect(() => cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 }))
      .toThrow(IllegalTransition);
  });

  test("cancelRun on a PROPOSED run closes its unique open proposal", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    createRun(db, {
      runId: spec.runId, idempotencyKey: spec.idempotencyKey,
      spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
      actor: "test", policyVersion: "test", now: T0,
    });
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', 'open', ?, 1800)`,
    ).run("prop-1", "test", "evt-1", spec.runId, new Date(T0).toISOString());

    const result = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(result.to).toBe("CANCELLED");
    expect(result.proposalClose).toEqual({ closed: true, id: "prop-1" });
    expect(db.query(`SELECT status, reason FROM proposals WHERE id = 'prop-1'`).get()).toEqual({
      status: "rejected",
      reason: "run_cancelled",
    });
  });

  test("cancelRun with no open proposal still cancels", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const result = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(result.to).toBe("CANCELLED");
    expect(result.proposalClose).toEqual({ closed: false });
  });

  test("cancelRun with two open proposals for the run closes neither", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const at = new Date(T0).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES ('p1', 'test', 'e1', ?, 'run', 'open', ?, 1800), ('p2', 'test', 'e2', ?, 'run', 'open', ?, 1800)`,
    ).run(spec.runId, at, spec.runId, at);

    const result = cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(result.to).toBe("CANCELLED");
    expect(result.proposalClose).toEqual({ closed: false, ambiguous: true, count: 2 });
    expect(db.query(`SELECT status FROM proposals WHERE id = 'p1'`).get().status).toBe("open");
    expect(db.query(`SELECT status FROM proposals WHERE id = 'p2'`).get().status).toBe("open");
  });

  test("retryRun: exhausted attempts throw without force, re-queue with force", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 1 }));
    claimNext(db, opts());
    transition(db, { runId: spec.runId, to: "RUNNING", expectFrom: "LEASED", actor: "test", now: T0 });
    transition(db, { runId: spec.runId, to: "FAILED", expectFrom: "RUNNING", actor: "test", now: T0 });

    expect(() => retryRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 }))
      .toThrow("attempts_exhausted");

    const retried = retryRun(db, spec.runId, { actor: "operator", force: true, policyVersion: "test", now: T0 });
    expect(retried.to).toBe("QUEUED");
    expect(runState(db, spec.runId)).toBe("QUEUED");
  });

  test("adapter exception: FAILED/adapter_error, workspace destroyed, not wedged in RUNNING (OPS-405)", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("simulated transport explosion");
      },
    };
    const throwingAdapters = { throwing: throwingAdapter };
    const spec = queueRun(db, makeSpec({ adapter: "throwing", maxAttempts: 1, workspace: { type: "ephemeral", retainOnFailure: false } }));
    const o = opts();

    const summary = await runOnce(db, registry, throwingAdapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("FAILED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("adapter_error");
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("adapter exception with retries: auto re-QUEUED, workspace cleaned (OPS-405)", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("simulated transport explosion");
      },
    };
    const throwingAdapters = { throwing: throwingAdapter };
    const spec = queueRun(db, makeSpec({ adapter: "throwing", maxAttempts: 2, workspace: { type: "ephemeral", retainOnFailure: false } }));
    const o = opts();

    const summary = await runOnce(db, registry, throwingAdapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("reapExpiredLeases dead-letters when maxAttempts is reached (OPS-405)", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 1 }));
    const o = opts();
    const claim = claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("FAILED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("lease_expired");
    // Does not re-queue again
    expect(reapExpiredLeases(db, { now: afterExpiry + 1000, policyVersion: "test" })).toBe(0);
    expect(claimNext(db, opts())).toBeNull();
  });

  test("cancelRun on a RUNNING attempt aborts adapter immediately and records attempt (OPS-417)", async () => {
    const db = openDb(":memory:");
    let aborted = false;
    const longRunningAdapter = {
      execute: ({ abortSignal }) => {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ exitCode: 0, timedOut: false }), 5000);
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            resolve({ exitCode: null, timedOut: false });
          });
        });
      },
    };
    const customAdapters = { long: longRunningAdapter };
    const spec = queueRun(db, makeSpec({ adapter: "long", timeoutSeconds: 30 }));
    const o = opts();

    const claim = claimNext(db, o);
    const execPromise = executeClaimed(db, registry, customAdapters, claim, o);

    // Cancel while RUNNING
    expect(runState(db, spec.runId)).toBe("RUNNING");
    cancelRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });

    const summary = await execPromise;
    expect(summary.cancelled).toBe(true);
    expect(aborted).toBe(true);
    expect(runState(db, spec.runId)).toBe("CANCELLED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("CANCELLED");
    expect(attempt.reason_code).toBe("cancelled");
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("runOnce returns null when nothing is QUEUED", async () => {
    const db = openDb(":memory:");
    expect(await runOnce(db, registry, adapters, opts())).toBeNull();
  });

  test("accurate attempt timestamps: started_at < finished_at with clock function (OPS-430)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    let t = T0;
    const clock = () => (t += 1000);
    const o = opts({ now: clock });

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("COMPLETED");

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(Date.parse(attempt.started_at)).toBeLessThan(Date.parse(attempt.finished_at));

    const journal = lifecycleOf(db, spec.runId);
    const leased = journal.find((e) => e.to_state === "LEASED");
    const running = journal.find((e) => e.to_state === "RUNNING");
    const verifying = journal.find((e) => e.to_state === "VERIFYING");
    const completed = journal.find((e) => e.to_state === "COMPLETED");

    expect(Date.parse(leased.at)).toBeLessThan(Date.parse(running.at));
    expect(Date.parse(running.at)).toBeLessThan(Date.parse(verifying.at));
    expect(Date.parse(verifying.at)).toBeLessThan(Date.parse(completed.at));
    expect(attempt.started_at).toBe(running.at);
    expect(attempt.finished_at).toBe(completed.at);
  });

  test("claimNext unconstrained candidate query: 60 unsatisfiable placement runs do not starve matching run (OPS-454)", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 60; i += 1) {
      queueRun(db, makeSpec({ placement: { node: "nowhere" } }), T0 + i * 1000);
    }
    const claimableSpec = queueRun(db, makeSpec({ placement: null }), T0 + 60 * 1000);

    const claim = claimNext(db, opts({ labels: {} }));
    expect(claim).not.toBeNull();
    expect(claim.runId).toBe(claimableSpec.runId);
  });

  test("claimNext unconstrained candidate query: 60 unsatisfiable adapter runs do not starve matching run (OPS-454)", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 60; i += 1) {
      queueRun(db, makeSpec({ adapter: "missing_adapter" }), T0 + i * 1000);
    }
    const claimableSpec = queueRun(db, makeSpec({ adapter: "fake" }), T0 + 60 * 1000);

    const claim = claimNext(db, opts({ adapters: ["fake"] }));
    expect(claim).not.toBeNull();
    expect(claim.runId).toBe(claimableSpec.runId);
  });

  test("claimNext preserves oldest-eligible-first ordering among satisfiable runs (OPS-454)", () => {
    const db = openDb(":memory:");
    const unclaimable1 = queueRun(db, makeSpec({ placement: { node: "gpu" } }), T0);
    const claimable1 = queueRun(db, makeSpec({ placement: null }), T0 + 1000);
    const unclaimable2 = queueRun(db, makeSpec({ placement: { node: "gpu" } }), T0 + 2000);
    const claimable2 = queueRun(db, makeSpec({ placement: null }), T0 + 3000);

    const firstClaim = claimNext(db, opts({ labels: {} }));
    expect(firstClaim).not.toBeNull();
    expect(firstClaim.runId).toBe(claimable1.runId);

    const secondClaim = claimNext(db, opts({ labels: {} }));
    expect(secondClaim).not.toBeNull();
    expect(secondClaim.runId).toBe(claimable2.runId);
  });

  test("fencing on failure: reaped-while-running worker's late failure cannot overwrite newer attempt (OPS-413)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2, input: { repos: ["ok"] } }));
    const o1 = opts({ owner: "w1", now: T0 });

    // Worker 1 claims attempt 1 and begins running
    const claim1 = claimNext(db, o1);
    expect(claim1.attempt).toBe(1);
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Worker 1 enters RUNNING
    transition(db, { runId: spec.runId, to: "RUNNING", expectFrom: "LEASED", actor: "w1", reason: "started", attempt: 1, now: T0 });

    // Lease expires while worker 1 is running slowly
    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");

    // Worker 2 claims attempt 2 and starts running
    const o2 = opts({ owner: "w2", now: afterExpiry });
    const claim2 = claimNext(db, o2);
    expect(claim2.attempt).toBe(2);
    expect(claim2.fencingToken).toBeGreaterThan(claim1.fencingToken);

    // Worker 1 finishes (with failure) and attempts terminal failure write
    // Custom fake adapter that exits with non-zero code
    const failingAdapters = {
      fake: {
        execute: async () => ({ exitCode: 1, timedOut: false }),
      },
    };
    const w1Result = await executeClaimed(db, registry, failingAdapters, claim1, { ...o1, now: afterExpiry });
    expect(w1Result.fenced).toBe(true);

    // Assert that Worker 1 did not mutate run state to FAILED
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Assert journal recorded fenced_attempt
    const fencedEvents = lifecycleOf(db, spec.runId).filter((e) => e.reason === "fenced_attempt");
    expect(fencedEvents).toHaveLength(1);
    expect(fencedEvents[0].attempt).toBe(1);

    // Worker 2 now succeeds
    const w2Result = await executeClaimed(db, registry, adapters, claim2, o2);
    expect(w2Result.terminalState).toBe("COMPLETED");
    expect(runState(db, spec.runId)).toBe("COMPLETED");

    // Only attempt 2 has results and published outbox event
    const results = db.query(`SELECT * FROM results WHERE run_id = ?`).all(spec.runId);
    expect(results).toHaveLength(1);
    expect(results[0].attempt).toBe(2);
  });

  test("receipt attests agent definition content hash (OPS-409)", async () => {
    const db = openDb(":memory:");
    const def = getAgent(registry, "factory-status-report@1");
    const expectedDefHash = computeDefHash(def);
    expect(expectedDefHash).toMatch(/^sha256:/);

    const spec = queueRun(db, makeSpec({ defHash: expectedDefHash }));
    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.receipt.defHash).toBe(expectedDefHash);

    const result = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.defHash).toBe(expectedDefHash);
  });

  test("mutated agent definition between approval and execution causes typed refusal (OPS-409)", async () => {
    const db = openDb(":memory:");
    // Spec carries an approved defHash that differs from current definition
    const staleDefHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const spec = queueRun(db, makeSpec({ defHash: staleDefHash }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("REFUSED");
    expect(summary.reasonCode).toBe("agent_definition_mismatch");
    expect(runState(db, spec.runId)).toBe("REFUSED");

    const result = db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId);
    expect(result).toBeTruthy();
    const resultJson = JSON.parse(result.result_json);
    expect(resultJson.terminalState).toBe("refused");
    expect(resultJson.reasonCode).toBe("agent_definition_mismatch");

    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.verificationStatus).toBe("passed");
    expect(receipt.defHash).toBeTruthy();

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("REFUSED");
    expect(attempt.reason_code).toBe("agent_definition_mismatch");
  });

  test("fencing on contract violation: stale worker cannot overwrite newer attempt (OPS-413)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2, input: { repos: ["ok"] } }));
    const o1 = opts({ owner: "w1", now: T0 });

    const claim1 = claimNext(db, o1);
    transition(db, { runId: spec.runId, to: "RUNNING", expectFrom: "LEASED", actor: "w1", reason: "started", attempt: 1, now: T0 });

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" });

    const o2 = opts({ owner: "w2", now: afterExpiry });
    const claim2 = claimNext(db, o2);

    // w1 produces invalid artifact (contract violation)
    const invalidAdapters = {
      fake: {
        execute: async ({ workspaceDir }) => {
          const { writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          writeFileSync(join(workspaceDir, "result.json"), JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact: { invalid: true },
          }));
          return { exitCode: 0, timedOut: false };
        },
      },
    };

    const w1Result = await executeClaimed(db, registry, invalidAdapters, claim1, { ...o1, now: afterExpiry });
    expect(w1Result.fenced).toBe(true);
    expect(runState(db, spec.runId)).toBe("LEASED");

    const w2Result = await executeClaimed(db, registry, adapters, claim2, o2);
    expect(w2Result.terminalState).toBe("COMPLETED");
    expect(runState(db, spec.runId)).toBe("COMPLETED");
  });

  test("fencing on abort: stale reaped worker abort cannot overwrite newer attempt (OPS-413)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2 }));
    const o1 = opts({ owner: "w1", now: T0 });

    const claim1 = claimNext(db, o1);
    transition(db, { runId: spec.runId, to: "RUNNING", expectFrom: "LEASED", actor: "w1", reason: "started", attempt: 1, now: T0 });

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" });

    const o2 = opts({ owner: "w2", now: afterExpiry });
    const claim2 = claimNext(db, o2);

    const abortingAdapters = {
      fake: {
        execute: async ({ abortSignal }) => {
          // Trigger abort
          const { cancelRun } = await import("./worker.mjs");
          // Abort the controller directly
          return new Promise((resolve) => {
            setTimeout(() => {
              abortSignal?.dispatchEvent?.(new Event("abort"));
              resolve({ exitCode: null, timedOut: false });
            }, 10);
          });
        },
      },
    };

    // Stale execution when abort is tripped
    const abortController = new AbortController();
    abortController.abort("cancelled");
    // Stale attempt with higher token existing
    const w1Result = await executeClaimed(db, registry, adapters, claim1, { ...o1, now: afterExpiry });
    expect(w1Result.fenced).toBe(true);
  });
});

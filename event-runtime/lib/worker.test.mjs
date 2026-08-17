import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { pinRunArtifact } from "./artifacts.mjs";
import { admitEvent } from "./intake.mjs";
import { planEvent } from "./planner.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { artifactsRoot } from "./config.mjs";
import { openDb, runUsage } from "./db.mjs";
import { createRun, lifecycleOf, runState, transition, IllegalTransition } from "./lifecycle.mjs";
import { computeDefHash } from "./receipts.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import {
  acquireClaimLock, cancelRun, claimNext, CODE_RELOAD_EXIT, codeStamp, codeStampFiles, codeStampRoot,
  createReloadWatcher, DEFAULT_MAX_ENVIRONMENT_RETRIES, defaultLocksDir, dispatchLockPath,
  executeClaimed, classifyFailureCause, reapExpiredLeases, releaseClaimLock, repositoryIsClean,
  repositoryStatus, retryRun, runLinearCli, runOnce,
} from "./worker.mjs";
import { liveWorkerLeases, writeWorkerLease } from "../../lib/worker-leases.mjs";

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

  test("repository status returns null when git exceeds its timeout", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-hanging-git-"));
    const hangingGit = path.join(dir, "git");
    writeFileSync(hangingGit, "#!/bin/bash\nwhile :; do :; done\n", "utf8");
    execFileSync("chmod", ["+x", hangingGit]);

    const started = Date.now();
    expect(repositoryStatus(dir, { gitCommand: hangingGit, timeoutMs: 25 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("Linear helper subprocesses honor the configured timeout", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-hanging-linear-"));
    const hangingCommand = path.join(dir, "bun");
    writeFileSync(hangingCommand, "#!/bin/bash\nwhile :; do :; done\n", "utf8");
    execFileSync("chmod", ["+x", hangingCommand]);
    const previous = process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS;
    process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = "25";

    const started = Date.now();
    try {
      expect(() => runLinearCli(["get", "WM-262"], { command: hangingCommand })).toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS;
      else process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = previous;
    }
  });

  test("e2e (WM-135): tiered pi route plans a spec with the model pinned; the fake adapter executes it, ignoring the model", async () => {
    const db = openDb(":memory:");
    // The real status-report definition with a declared tier, on a registry
    // whose policy map says standard → the pi standard model.
    const synthetic = { ...registry, agents: new Map(registry.agents), modelTiers: { pi: { standard: "openai-codex/gpt-5.6-terra" } } };
    synthetic.agents.set("factory-status-report@1", { ...getAgent(registry, "factory-status-report@1"), model_tier: "standard" });

    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId: "wm135-e2e-1",
      type: "factory.status-report.requested",
      source: "operator-webhook",
      subject: "factory",
      occurredAt: new Date(T0).toISOString(),
      correlationId: "wm135-corr",
      causationId: null,
      payload: { repos: ["ok"] },
    };
    const admitted = admitEvent(db, synthetic, envelope, { now: T0 });
    expect(admitted.admitted).toBe(true);

    const outcome = planEvent(
      db,
      synthetic,
      { source: admitted.event.source, eventId: admitted.event.event_id },
      { now: T0, policyVersion: "git:test", adapterOverride: "fake" },
    );
    expect(outcome.decision).toBe("run");
    // The pinned resolution is what the operator would approve: the
    // registered pi route's model, even though execution is the fake.
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBe("openai-codex/gpt-5.6-terra");
    expect(spec.modelTier).toBe("standard");
    expect(spec.adapter).toBe("fake");

    transition(db, { runId: outcome.runId, to: "APPROVED", actor: "test", now: T0 });
    transition(db, { runId: outcome.runId, to: "QUEUED", actor: "test", now: T0 });
    const summary = await runOnce(db, synthetic, adapters, opts());
    expect(summary.runId).toBe(outcome.runId);
    expect(summary.terminalState).toBe("COMPLETED");
    // The run's stored spec — what inspect/receipts read — carries the pin.
    const stored = JSON.parse(db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(outcome.runId).spec_json);
    expect(stored.model).toBe("openai-codex/gpt-5.6-terra");
    expect(stored.modelTier).toBe("standard");
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
    expect(runUsage(db, spec.runId).attempts).toEqual([expect.objectContaining({
      attempt: 1,
      adapter: "fake",
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })]);

    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("COMPLETED");
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("persists usage returned by an adapter, including model and cache tokens", async () => {
    const db = openDb(":memory:");
    const usageAdapter = {
      async execute(args) {
        const outcome = await fake.execute(args);
        args.onUsage?.({
          model: "claude-sonnet-4-6",
          inputTokens: 101,
          outputTokens: 29,
          cacheCreationInputTokens: 300,
          cacheReadInputTokens: 700,
          costUSD: 0.123,
        });
        return outcome;
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "usage-stub" }));

    const summary = await runOnce(db, registry, { "usage-stub": usageAdapter }, opts());
    expect(summary.terminalState).toBe("COMPLETED");
    expect(runUsage(db, spec.runId)).toEqual({
      totals: {
        attempts: 1,
        inputTokens: 101,
        outputTokens: 29,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 700,
        totalTokens: 1130,
        costUSD: 0.123,
      },
      attempts: [expect.objectContaining({
        attempt: 1,
        adapter: "usage-stub",
        model: "claude-sonnet-4-6",
        totalTokens: 1130,
      })],
    });
  });

  test("failed adapter outcomes retain tokens consumed before failure", async () => {
    const db = openDb(":memory:");
    const consumedThenFailed = {
      async execute() {
        return {
          exitCode: 1,
          timedOut: false,
          usage: { model: "claude-sonnet-4-6", inputTokens: 11, outputTokens: 4 },
        };
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "consumed-failure", maxAttempts: 1 }));

    const summary = await runOnce(db, registry, { "consumed-failure": consumedThenFailed }, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(runUsage(db, spec.runId).attempts[0]).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-6",
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
    }));
  });

  test("policy denial is terminal and is never retried as an opaque agent exit", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "policy", maxAttempts: 5 }));
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
    expect(claimNext(db, opts())).toBeNull();
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

  test("retryRun: exhausted agent attempts throw without force, re-queue with force", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["crash"] }, maxAttempts: 1 }));
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("FAILED");

    expect(() => retryRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 }))
      .toThrow("attempts_exhausted");

    const retried = retryRun(db, spec.runId, { actor: "operator", force: true, policyVersion: "test", now: T0 });
    expect(retried.to).toBe("QUEUED");
    expect(runState(db, spec.runId)).toBe("QUEUED");
  });

  test("retryRun does not treat environment attempts as exhausted agent attempts", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = { execute: async () => { throw new Error("network dropped"); } };
    const spec = queueRun(db, makeSpec({ adapter: "throwing", maxAttempts: 1, maxEnvironmentRetries: 0 }));
    await runOnce(db, registry, { throwing: throwingAdapter }, opts());
    expect(runState(db, spec.runId)).toBe("FAILED");

    const retried = retryRun(db, spec.runId, { actor: "operator", policyVersion: "test", now: T0 });
    expect(retried.to).toBe("QUEUED");
  });

  test("failure cause taxonomy classifies retryable and fatal worker failures", () => {
    expect(classifyFailureCause("adapter_error")).toBe("environment");
    expect(classifyFailureCause("lease_expired")).toBe("environment");
    expect(classifyFailureCause("agent_exit_1")).toBe("agent_error");
    expect(classifyFailureCause("contract_violation")).toBe("agent_error");
    for (const reason of [
      "cli_not_found",
      "unknown_adapter",
      "agent_definition_mismatch",
      "policy_denied:Bash",
      "workspace_integrity_violation",
    ]) {
      expect(classifyFailureCause(reason)).toBe("fatal");
    }
    expect(DEFAULT_MAX_ENVIRONMENT_RETRIES).toBe(3);
  });

  test("adapter_error with maxAttempts 1 requeues and succeeds without consuming the agent budget", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const flakyAdapter = {
      async execute(args) {
        calls += 1;
        if (calls === 1) throw new Error("simulated transport explosion");
        return fake.execute(args);
      },
    };
    const spec = queueRun(db, makeSpec({
      adapter: "flaky",
      maxAttempts: 1,
      maxEnvironmentRetries: 1,
      workspace: { type: "ephemeral", retainOnFailure: false },
    }));
    const o = opts();

    const first = await runOnce(db, registry, { flaky: flakyAdapter }, o);
    expect(first).toMatchObject({ terminalState: "FAILED", reasonCode: "adapter_error" });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:environment");

    const second = await runOnce(db, registry, { flaky: flakyAdapter }, o);
    expect(second.terminalState).toBe("COMPLETED");
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`).all(spec.runId))
      .toEqual([{ reason_code: "adapter_error" }, { reason_code: "ok" }]);
  });

  test("repeated environment failures dead-letter after the dedicated retry ceiling", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("simulated transport explosion");
      },
    };
    const spec = queueRun(db, makeSpec({
      adapter: "throwing",
      maxAttempts: 1,
      maxEnvironmentRetries: 2,
      workspace: { type: "ephemeral", retainOnFailure: false },
    }));
    const o = opts();

    expect((await runOnce(db, registry, { throwing: throwingAdapter }, o)).reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect((await runOnce(db, registry, { throwing: throwingAdapter }, o)).reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect((await runOnce(db, registry, { throwing: throwingAdapter }, o)).reasonCode).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(db.query(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`).get(spec.runId).n).toBe(3);
    expect(lifecycleOf(db, spec.runId).filter((event) => event.reason === "retry:environment")).toHaveLength(2);
  });

  test("environment failures do not consume agent_exit retry attempts", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const mixedAdapter = {
      async execute() {
        calls += 1;
        if (calls === 1) throw new Error("network dropped");
        return { exitCode: 1, timedOut: false };
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "mixed", maxAttempts: 2, maxEnvironmentRetries: 1 }));
    const o = opts();

    await runOnce(db, registry, { mixed: mixedAdapter }, o);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    await runOnce(db, registry, { mixed: mixedAdapter }, o);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:agent_error");
    await runOnce(db, registry, { mixed: mixedAdapter }, o);
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`).all(spec.runId))
      .toEqual([
        { reason_code: "adapter_error" },
        { reason_code: "agent_exit_1" },
        { reason_code: "agent_exit_1" },
      ]);
  });

  test("contract violations consume maxAttempts independently of environment failures", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["invalid-artifact"] }, maxAttempts: 2 }));
    const o = opts();

    await runOnce(db, registry, adapters, o);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:agent_error");
    await runOnce(db, registry, adapters, o);
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`).all(spec.runId))
      .toEqual([{ reason_code: "contract_violation" }, { reason_code: "contract_violation" }]);
  });

  test("fatal errors never requeue regardless of either retry budget", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({
      adapter: "nonexistent",
      maxAttempts: 5,
      maxEnvironmentRetries: 5,
    }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary).toMatchObject({ terminalState: "FAILED", reasonCode: "unknown_adapter" });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claimNext(db, opts())).toBeNull();
    expect(lifecycleOf(db, spec.runId).some((event) => event.reason?.startsWith("retry:"))).toBe(false);
  });

  test("post-VERIFYING exception finalizes the attempt and re-queues instead of stranding it (WM-261)", async () => {
    const db = openDb(":memory:");
    const blockedStoreParent = path.join(freshRoot(), "not-a-directory");
    writeFileSync(blockedStoreParent, "blocks artifact store creation\n");
    const spec = queueRun(db, makeSpec({
      maxAttempts: 2,
      workspace: { type: "ephemeral", retainOnFailure: false },
    }));
    const o = opts({ artifactStore: path.join(blockedStoreParent, "artifacts") });

    const summary = await runOnce(db, registry, adapters, o);

    expect(summary).toMatchObject({ terminalState: "FAILED", reasonCode: "adapter_error" });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).slice(-3).map((event) => event.to_state)).toEqual([
      "VERIFYING", "FAILED", "QUEUED",
    ]);
    const attempt = db.query(`SELECT * FROM attempts WHERE run_id = ?`).get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("adapter_error");
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(false);
  });

  test("lease_expired uses the environment retry ceiling instead of maxAttempts", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 1, maxEnvironmentRetries: 1 }));
    const o = opts();
    claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    const firstExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(reapExpiredLeases(db, { now: firstExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:environment");

    const secondClaim = claimNext(db, { ...o, now: firstExpiry });
    const secondExpiry = firstExpiry + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(secondClaim.attempt).toBe(2);
    expect(reapExpiredLeases(db, { now: secondExpiry, policyVersion: "test" })).toBe(1);
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`).all(spec.runId))
      .toEqual([{ reason_code: "lease_expired" }, { reason_code: "lease_expired" }]);
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
            resolve({
              exitCode: null,
              timedOut: false,
              usage: { model: "claude-sonnet-4-6", inputTokens: 9, outputTokens: 2 },
            });
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
    expect(runUsage(db, spec.runId).attempts[0]).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-6",
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
    }));
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
    expect(lifecycleOf(db, spec.runId).slice(-2).map((event) => event.reason)).toEqual([
      "failure:fatal:agent_definition_mismatch",
      "failure:fatal:agent_definition_mismatch",
    ]);
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

  test("worker preserves push credentials for mutating runs and strips them for non-mutating runs (WM-128)", async () => {
    const db = openDb(":memory:");
    let capturedMutatingEnv = null;
    let capturedReadOnlyEnv = null;

    const spyAdapter = {
      execute: async ({ spec, def, env, workspaceDir }) => {
        const { safeChildEnvironment } = await import("./adapters/claude.mjs");
        const effectiveEnv = safeChildEnvironment(env, def);
        if (def.mutating) {
          capturedMutatingEnv = effectiveEnv;
        } else {
          capturedReadOnlyEnv = effectiveEnv;
        }
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const isMutating = Boolean(def.mutating);
        const artifact = isMutating
          ? {
              outcome: "PR_OPEN",
              repo: "bj29",
              ticket: "WM-128",
              prUrl: "https://github.com/watt-mind/factory/pull/1",
              verification: {
                command: "bun test",
                passed: true,
                output: "ok",
              },
              summary: "Implemented",
            }
          : {
              repos: [{ name: "ok", triage: 0, agentReady: 0, inProgress: 0, blocked: 0 }],
              recommendedAction: "wait",
            };
        writeFileSync(
          join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact,
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };

    const customAdapters = { spy: spyAdapter };

    // 1. Mutating run (dispatch@1 has mutating: true)
    const mutatingSpec = queueRun(
      db,
      makeSpec({
        agent: "dispatch@1",
        input: { repo: "bj29", ticket: "WM-128" },
        outputContract: "factory.dispatch-result/v1",
        adapter: "spy",
      }),
    );
    const mutatingResult = await runOnce(db, registry, customAdapters, opts({
      env: {
        SSH_AUTH_SOCK: "/tmp/worker-dispatch.sock",
        GITHUB_TOKEN: "ghp_worker_dispatch_token",
        ANTHROPIC_API_KEY: "sk-worker-must-strip",
      },
    }));
    expect(mutatingResult.terminalState).toBe("COMPLETED");
    expect(capturedMutatingEnv).not.toBeNull();
    expect(capturedMutatingEnv.SSH_AUTH_SOCK).toBe("/tmp/worker-dispatch.sock");
    expect(capturedMutatingEnv.GITHUB_TOKEN).toBe("ghp_worker_dispatch_token");
    expect(capturedMutatingEnv.ANTHROPIC_API_KEY).toBeUndefined();

    // 2. Non-mutating run (factory-status-report@1 has mutating: false)
    const readOnlySpec = queueRun(
      db,
      makeSpec({
        agent: "factory-status-report@1",
        input: { repos: ["ok"] },
        outputContract: "factory.status-report/v1",
        adapter: "spy",
      }),
    );
    const readOnlyResult = await runOnce(db, registry, customAdapters, opts({
      env: {
        SSH_AUTH_SOCK: "/tmp/worker-readonly.sock",
        GITHUB_TOKEN: "ghp_worker_readonly_token",
        ANTHROPIC_API_KEY: "sk-worker-must-strip",
      },
    }));
    expect(readOnlyResult.terminalState).toBe("COMPLETED");
    expect(capturedReadOnlyEnv).not.toBeNull();
    expect(capturedReadOnlyEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(capturedReadOnlyEnv.GITHUB_TOKEN).toBeUndefined();
    expect(capturedReadOnlyEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("execute-side dispatch hardening (WM-115)", () => {
  let factoryRoot;
  let repoDir;
  let wtRoot;
  let callsLog;
  let previousReposRoot;

  beforeAll(() => {
    factoryRoot = mkdtempSync(path.join(os.tmpdir(), "evrt-worker-hard-factory-"));
    repoDir = mkdtempSync(path.join(os.tmpdir(), "evrt-worker-hard-repo-"));
    wtRoot = mkdtempSync(path.join(os.tmpdir(), "evrt-worker-hard-trees-"));
    callsLog = path.join(repoDir, "calls.log");

    mkdirSync(path.join(repoDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up.sh"),
      `#!/bin/bash\nset -e\necho "up $1" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down.sh"),
      `#!/bin/bash\nset -e\necho "down $1" >> "${callsLog}"\nrm -rf "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-red-baseline.sh"),
      `#!/bin/bash\nset -e\necho "up-red $1" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\nprintf '%s\\n' '{"status":"red","check":"web_build","command":"bun run build:fast","exitCode":1,"output":"entry chunk exceeds budget"}' > "$FACTORY_WORKTREE_REPORT"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-broken.sh"),
      `#!/bin/bash\necho "dependency install failed" >&2\nexit 12\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-startup-crash.sh"),
      `#!/bin/bash\n` +
      `mkdir -p "${wtRoot}/$1/.factory/run"\n` +
      `echo "RegistryError: event type test: model_tier strong has no mapping" > "${wtRoot}/$1/.factory/run/serve.log"\n` +
      `echo "warn: event runtime log (${wtRoot}/$1/.factory/run/serve.log):" >&2\n` +
      `cat "${wtRoot}/$1/.factory/run/serve.log" >&2\n` +
      `echo "error: event runtime died during startup on 7400 — see ${wtRoot}/$1/.factory/run/serve.log" >&2\n` +
      `exit 1\n`,
    );

    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(path.join(factoryRoot, "config", "policy.yaml"), "{}\n");
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:\n` +
        `  - name: wt-worker\n    path: ${repoDir}\n    github: watt-mind/wt-worker\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo repo_verified\n    escalate_paths: []\n` +
        `  - name: wt-failing-verify\n    path: ${repoDir}\n    github: watt-mind/wt-failing-verify\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: exit 42\n    escalate_paths: []\n` +
        `  - name: wt-baseline-red\n    path: ${repoDir}\n    github: watt-mind/wt-baseline-red\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-red-baseline.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: printf 'entry chunk exceeds budget\\n' >&2; exit 9\n    escalate_paths: []\n` +
        `  - name: wm-baseline-real\n    path: ${repoDir}\n    github: watt-mind/wm-baseline-real\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo repo_verified\n    escalate_paths: []\n` +
        `  - name: wt-broken-up\n    path: ${repoDir}\n    github: watt-mind/wt-broken-up\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-broken.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo never\n    escalate_paths: []\n` +
        `  - name: wt-startup-crash\n    path: ${repoDir}\n    github: watt-mind/wt-startup-crash\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-startup-crash.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo never\n    escalate_paths: []\n`,
    );
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = factoryRoot;
  });

  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  function makeDispatchSpec(overrides = {}) {
    const runId = overrides.runId ?? `run_dispatch_${++seq}_${Math.random().toString(36).slice(2)}`;
    const input = overrides.input ?? { repo: "wt-worker", ticket: "WM-701" };
    return {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "dispatch@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "worktree", checkoutDir: "repo", retainOnFailure: true },
      adapter: "fake",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.dispatch-result/v1",
      capabilities: ["linear:write", "repo:write", "github:write"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
      ...overrides,
    };
  }

  const dispatchFakeAdapter = {
    async execute({ spec, workspaceDir }) {
      writeFileSync(path.join(workspaceDir, ".transcript.json"), `{"fake":"dispatch transcript"}\n`, "utf8");
      const repoPath = path.join(workspaceDir, "repo");
      if (existsSync(repoPath)) {
        writeFileSync(path.join(repoPath, "mutated.txt"), "some dirty edit\n", "utf8");
      }
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify({
          schemaVersion: "factory.agent-result/v1",
          terminalState: "completed",
          reasonCode: "ok",
          artifact: {
            outcome: "PR_OPEN",
            repo: spec.input.repo,
            ticket: spec.input.ticket,
            prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/10`,
            verification: { command: "echo repo_verified", passed: true, output: "repo_verified" },
            summary: `implemented ${spec.input.ticket}`,
          },
          evidence: { commands: ["echo repo_verified"] },
        }, null, 2)}\n`,
        "utf8",
      );
      return { exitCode: 0, timedOut: false };
    },
  };

  test("acquireClaimLock acquires lock file and prevents concurrent acquire, release unlocks", () => {
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 1000 })).toBe(true);
    // Second acquire by live PID fails
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 2000 })).toBe(false);
    releaseClaimLock(lockFile);
    expect(existsSync(lockFile)).toBe(false);
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 3000 })).toBe(true);
    releaseClaimLock(lockFile);
  });

  test("acquireClaimLock steals stale lock older than 120s or from dead PID", () => {
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-stale-"));
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    // Write stale lock from 200s ago
    writeFileSync(lockFile, `${process.pid} 1000\n`, "utf8");
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 201_000, isAlive: () => true })).toBe(true);
    releaseClaimLock(lockFile);

    // Write lock from dead PID
    writeFileSync(lockFile, `999999 1000\n`, "utf8");
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 2000, isAlive: () => false })).toBe(true);
    releaseClaimLock(lockFile);
  });

  test("contended claim lock at execute time causes typed refusal claim_lock_busy", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-busy-"));
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    // Hold the lock
    acquireClaimLock(lockFile, { pid: process.pid, now: T0 });

    const spec = queueRun(db, makeDispatchSpec());
    const o = opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-701", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    });

    const summary = await runOnce(db, registry, { fake: dispatchFakeAdapter }, o);
    expect(summary.terminalState).toBe("REFUSED");
    expect(summary.reasonCode).toBe("claim_lock_busy");
    releaseClaimLock(lockFile);
  });

  test("execute-time re-checks refuse on ticket_not_todo, ticket_assigned, capacity_full, owned_paths_overlap, ticket_claim_lost", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-rechecks-"));

    // 1. ticket_not_todo
    const spec1 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-702" } }));
    const sum1 = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-702", state: { name: "In Review" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
      },
    }));
    expect(sum1.terminalState).toBe("REFUSED");
    expect(sum1.reasonCode).toBe("ticket_not_todo");

    // 2. ticket_assigned
    const spec2 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-703" } }));
    const sum2 = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-703", state: { name: "Todo" }, assignee: { id: "other" }, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
      },
    }));
    expect(sum2.terminalState).toBe("REFUSED");
    expect(sum2.reasonCode).toBe("ticket_assigned");

    // 3. capacity_full
    const spec3 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-704" } }));
    const sum3 = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-704", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 2, // cap is 2
      },
    }));
    expect(sum3.terminalState).toBe("REFUSED");
    expect(sum3.reasonCode).toBe("capacity_full");

    // 4. owned_paths_overlap
    const spec4 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-705" } }));
    const sum4 = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-705", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] }, description: "## Owned Paths\n- src/api/**\n" }),
        fetchInFlight: () => [{ identifier: "WM-800", description: "## Owned Paths\n- src/api/routes.ts\n" }],
        countLeases: () => 0,
      },
    }));
    expect(sum4.terminalState).toBe("REFUSED");
    expect(sum4.reasonCode).toBe("owned_paths_overlap");

    // 5. ticket_claim_lost
    const spec5 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-706" } }));
    const sum5 = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-706", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: false, reasonCode: "ticket_claim_lost" }),
      },
    }));
    expect(sum5.terminalState).toBe("REFUSED");
    expect(sum5.reasonCode).toBe("ticket_claim_lost");
  });

  test("worker lease is acquired during execution and released on completion", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-lease-locks-"));
    const leaseDir = mkdtempSync(path.join(os.tmpdir(), "evrt-lease-dir-"));

    let sawActiveLease = false;
    const leaseCheckAdapter = {
      async execute({ spec, workspaceDir }) {
        const active = liveWorkerLeases("wt-worker", { dir: leaseDir, now: T0 });
        sawActiveLease = active.some((l) => l.ticket === spec.input.ticket);
        return dispatchFakeAdapter.execute({ spec, workspaceDir });
      },
    };

    const spec = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-710" } }));
    const summary = await runOnce(db, registry, { fake: leaseCheckAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ({ identifier: "WM-710", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    }));

    expect(sawActiveLease).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");
    // After execution, the lease must be released
    expect(liveWorkerLeases("wt-worker", { dir: leaseDir, now: T0 })).toHaveLength(0);
  });

  test("mutating worktree is exempt from read-only clean check and runs repo verify command", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-verify-locks-"));
    const leaseDir = mkdtempSync(path.join(os.tmpdir(), "evrt-verify-leases-"));

    const spec = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-720" } }));
    const summary = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ({ identifier: "WM-720", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    }));

    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    const resRow = db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(spec.runId);
    const result = JSON.parse(resRow.result_json);
    expect(result.verification.checks).toContain("repo_verify_passed");
  });

  test("failing repo verify command triggers contract_violation failure", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-fverify-locks-"));
    const leaseDir = mkdtempSync(path.join(os.tmpdir(), "evrt-fverify-leases-"));

    const spec = queueRun(db, makeDispatchSpec({ input: { repo: "wt-failing-verify", ticket: "WM-730" } }));
    const summary = await runOnce(db, registry, { fake: dispatchFakeAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ({ identifier: "WM-730", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    }));

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
  });

  test("a deliberately red baseline still reaches the agent with failure context, then terminates baseline_red", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-baseline-locks-"));
    const leaseDir = mkdtempSync(path.join(os.tmpdir(), "evrt-baseline-leases-"));
    let executionInput = null;
    const unclaimCalls = [];
    const blockCalls = [];
    const observingAdapter = {
      async execute({ spec, workspaceDir }) {
        executionInput = JSON.parse(readFileSync(path.join(workspaceDir, "input.json"), "utf8"));
        return dispatchFakeAdapter.execute({ spec, workspaceDir });
      },
    };

    const spec = queueRun(db, makeDispatchSpec({ input: { repo: "wt-baseline-red", ticket: "WM-731" } }));
    const summary = await runOnce(db, registry, { fake: observingAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ({ identifier: "WM-731", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
        unclaimTicket: (payload) => {
          unclaimCalls.push(payload);
          return false;
        },
        blockBaselineTicket: (payload) => {
          blockCalls.push(payload);
          return true;
        },
      },
    }));

    expect(executionInput).toMatchObject({
      repo: "wt-baseline-red",
      ticket: "WM-731",
      baseline: { status: "red", check: "web_build", output: "entry chunk exceeds budget" },
    });
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("baseline_red");
    expect(blockCalls).toHaveLength(1);
    expect(unclaimCalls).toHaveLength(0);
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ?`).get(spec.runId).reason_code).toBe("baseline_red");
  });

  test("worktree-up handles an actual baseline-red repo verification and deduplicates baseline blocker comments", { timeout: 45_000 }, async () => {
    const repoRoot = process.cwd();
    const repoName = "wm-baseline-real";
    const ticket = `WM-${732000000 + Math.floor(Math.random() * 1_000_000)}`;
    const apiPort = "7408";
    const apiPortNumber = Number(apiPort);
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "wm334-real-"));
    const stubDir = path.join(tmpRoot, "stub");
    const linearStateDir = path.join(tmpRoot, "linear-state");
    const worktreeRoot = path.join(tmpRoot, "worktrees");
    const reposFile = path.join(tmpRoot, "config", "repos.yaml");

    const write = (p, c) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, c, "utf8");
    };

    const baselineFailureSignature = ({ why, log = null, baseline }) =>
      createHash("sha256")
        .update(JSON.stringify({
          why,
          log,
          baseline: baseline && typeof baseline === "object"
            ? { check: baseline.check, exitCode: baseline.exitCode, output: baseline.output }
            : null,
        }))
        .digest("hex");

    const baselineFailureMarker = (payload) => `wm:baseline:red:${baselineFailureSignature(payload)}`;
    const keepAliveProcesses = [];

    const expectedHome = path.join(worktreeRoot, ticket, ".factory", "event-runtime");
    const seedRuntimeState = () => {};


    const currentBranch = (spawnSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout || "").trim();
    // GitHub Actions checks out a PR merge ref detached from its source branch.
    // Give worktree-up a verified origin ref to that checked-out commit, rather
    // than accidentally constructing the invalid origin/HEAD ref.
    const detachedBaseBranch = currentBranch === "HEAD" ? `wm334-test-${ticket}-${process.pid}` : null;
    if (detachedBaseBranch) {
      const head = (spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout || "").trim();
      execFileSync("git", ["-C", repoRoot, "update-ref", `refs/remotes/origin/${detachedBaseBranch}`, head]);
    }
    const hasRemoteBranch = (branch) => branch && branch !== "HEAD" && spawnSync(
      "git",
      ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    ).status === 0;
    const baseBranch = [currentBranch, detachedBaseBranch, process.env.GITHUB_BASE_REF, "develop"].find(hasRemoteBranch);
    expect(baseBranch).toBeDefined();
    expect(baseBranch).not.toBe("HEAD");
    expect(hasRemoteBranch(baseBranch)).toBe(true);
    const realBun = (spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8", env: { ...process.env } }).stdout || "").trim() || "bun";

    mkdirSync(stubDir, { recursive: true });
    mkdirSync(linearStateDir, { recursive: true });

    const worktreeUp = path.join(stubDir, "worktree-up-no-seed.sh");
    write(
      worktreeUp,
      `#!/usr/bin/env bash\nexec ${JSON.stringify(path.join(repoRoot, "bin", "worktree-up.sh"))} "$@" --no-seed\n`,
    );

    const testPortBase = 18400 + Math.floor(Math.random() * 1000) * 2;

    const bunStubLines = [
      "#!/usr/bin/env node",
      "const fs = require(\"fs\");",
      "const path = require(\"path\");",
      "const { spawn } = require(\"child_process\");",
      `const stateDir = process.env.WM334_LINEAR_STATE_DIR || ${JSON.stringify(linearStateDir)}`,
      `const realBun = process.env.WM334_REAL_BUN || ${JSON.stringify(realBun)}`,
      "const args = process.argv.slice(2);",
      "const logPath = process.env.WM334_BUN_LOG || null;",
      "if (logPath) {\n  try {\n    fs.appendFileSync(logPath, `CALL ${args.join(' ')}\\n`);\n  } catch {}\n}",
      "",
      "function commentsPath(ticket) {",
      "  return path.join(stateDir, ticket + \".comments.json\");",
      "}",
      "function readComments(ticket) {",
      "  try {",
      "    return JSON.parse(fs.readFileSync(commentsPath(ticket), \"utf8\"));",
      "  } catch {",
      "    return [];",
      "  }",
      "}",
      "function writeComments(ticket, rows) {",
      "  fs.writeFileSync(commentsPath(ticket), JSON.stringify(rows), \"utf8\");",
      "}",
      "",
      "if (args[0]?.endsWith(\"tools/linear.mjs\")) {",
      "  const verb = args[1];",
      "  if (verb === \"comments\") {",
      "    const ticket = args[2];",
      "    console.log(JSON.stringify(readComments(ticket)));",
      "    process.exit(0);",
      "  }",
      "  if (verb === \"comment\") {",
      "    const ticket = args[2];",
      "    const body = args.slice(3).join(\" \");",
      "    const rows = readComments(ticket);",
      "    rows.push({ body });",
      "    writeComments(ticket, rows);",
      "    process.exit(0);",
      "  }",
      "  if (verb === \"state\") {",
      "    console.log(\"ok\");",
      "    process.exit(0);",
      "  }",
      "  if (verb === \"claim\") {",
      "    console.log(\"ok\");",
      "    process.exit(0);",
      "  }",
      "  if (verb === \"get\") {",
      "    console.log(JSON.stringify({ identifier: args[2], state: { name: \"In Progress\" }, assignee: { name: \"agent\" }, labels: { nodes: [{ name: \"ai:in-progress\" }] } }));",
      "    process.exit(0);",
      "  }",
      "  console.log(\"[]\");",
      "  process.exit(0);",
      "}",
      "if (args.includes(\"install\")) {",
      "  process.exit(0);",
      "}",
      "if (args[0] === \"run\" && args[1] === \"build:fast\") {",
      "  console.log(\"entry chunk exceeds budget\");",
      "  process.exit(1);",
      "}",
      "const child = spawn(realBun, args, {",
      "  stdio: \"inherit\",",
      "  env: process.env,",
      "});",
      "process.on(\"SIGTERM\", () => child.kill(\"SIGTERM\"));",
      "process.on(\"SIGINT\", () => child.kill(\"SIGINT\"));",
      "process.on(\"SIGHUP\", () => child.kill(\"SIGHUP\"));",
      "child.on(\"exit\", (code, signal) => {",
      "  if (signal) {",
      "    try { process.kill(process.pid, signal); } catch {}",
      "  }",
      "  process.exit(code ?? 0);",
      "});",
    ];
    write(path.join(stubDir, "bun"), bunStubLines.join("\n") + "\n");

    for (const filePath of [path.join(stubDir, "bun"), worktreeUp]) {
      execFileSync("chmod", ["+x", filePath]);
    }

    write(
      reposFile,
      `repos:\n` +
        `  - name: ${repoName}\n` +
        `    path: ${repoRoot}\n` +
        `    github: watt-mind/${repoName}\n` +
        `    base: ${baseBranch}\n` +
        `    team: WM\n` +
        `    project: Factory\n` +
        `    max_in_flight: 1\n` +
        `    worktree_up: ${worktreeUp}\n` +
        `    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${worktreeRoot}\n` +
        `    verify: printf 'entry chunk exceeds budget\\n' \\n  >&2; exit 1\n` +
        `    escalate_paths: []\n`,
    );
    const basePolicy = readFileSync(path.join(repoRoot, "config", "policy.yaml"), "utf8");
    const testPolicy = basePolicy.includes("  fake:")
      ? basePolicy
      : basePolicy.replace(/^models:\n/m, "models:\n  fake:\n    strong: default\n    standard: default\n    light: default\n");
    write(path.join(tmpRoot, "config", "policy.yaml"), testPolicy);

    const originalEnv = {
      FACTORY_REPOS_ROOT: process.env.FACTORY_REPOS_ROOT,
      FACTORY_SKIP_FETCH: process.env.FACTORY_SKIP_FETCH,
      FACTORY_BASE_BRANCH: process.env.FACTORY_BASE_BRANCH,
      FACTORY_WT_ROOT: process.env.FACTORY_WT_ROOT,
      FACTORY_PORT_BASE: process.env.FACTORY_PORT_BASE,
      FACTORY_PORT_SPAN: process.env.FACTORY_PORT_SPAN,
      PATH: process.env.PATH,
      WM334_LINEAR_STATE_DIR: process.env.WM334_LINEAR_STATE_DIR,
      WM334_REAL_BUN: process.env.WM334_REAL_BUN,
      WM334_BUN_LOG: process.env.WM334_BUN_LOG,
    };
    try {
      process.env.FACTORY_REPOS_ROOT = tmpRoot;
      process.env.FACTORY_SKIP_FETCH = "1";
      process.env.FACTORY_BASE_BRANCH = baseBranch;
      process.env.FACTORY_WT_ROOT = worktreeRoot;
      process.env.FACTORY_PORT_BASE = String(testPortBase);
      process.env.FACTORY_PORT_SPAN = "50";
      process.env.PATH = `${path.join(stubDir)}:${process.env.PATH}`;
      process.env.WM334_LINEAR_STATE_DIR = linearStateDir;
      process.env.WM334_REAL_BUN = realBun;
      process.env.WM334_BUN_LOG = path.join(tmpRoot, 'bun-calls.log');

      const db = openDb(":memory:");
      const lockDir = mkdtempSync(path.join(os.tmpdir(), "wm334-real-locks-"));
      const leaseDir = mkdtempSync(path.join(os.tmpdir(), "wm334-real-leases-"));
      const executionInputs = [];
      const blockCalls = [];
      const observedAdapter = {
        async execute({ spec, workspaceDir }) {
          executionInputs.push(JSON.parse(readFileSync(path.join(workspaceDir, "input.json"), "utf8")));
          const result = {
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {
              outcome: "PR_OPEN",
              repo: spec.input.repo,
              ticket: spec.input.ticket,
              prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/10`,
              verification: {
                command: "printf 'entry chunk exceeds budget\\n' > /dev/null; exit 1",
                passed: true,
                output: "agent verification passed",
              },
              summary: `implemented ${spec.input.ticket}`,
            },
            evidence: { commands: ["cd event-runtime/web && bun run build:fast"] },
          };
          writeFileSync(path.join(workspaceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
          return { exitCode: 0, timedOut: false };
        },
      };

      const blockTicket = ({ ticket, why, baseline, log = null }) => {
        blockCalls.push({ ticket, why, baseline, log });
        const marker = baselineFailureMarker({ why, baseline, log });
        const commentsPath = path.join(linearStateDir, `${ticket}.comments.json`);
        const existing = existsSync(commentsPath) ? JSON.parse(readFileSync(commentsPath, "utf8")) : [];
        if (!existing.some((row) => String(row.body ?? "").includes(marker))) {
          existing.push({ body: `Dispatch run blocked due pre-existing baseline red.\n\n**Why:** ${why}\n\n<!-- ${marker} -->` });
          writeFileSync(commentsPath, JSON.stringify(existing), "utf8");
        }
        return true;
      };

      const run = async () => {
        seedRuntimeState();
        const spec = queueRun(db, makeDispatchSpec({
          input: { repo: repoName, ticket },
          workspace: { type: "worktree", checkoutDir: "repo", retainOnFailure: false },
        }));
        return runOnce(db, registry, { fake: observedAdapter }, opts({
          workspacesRoot: mkdtempSync(path.join(os.tmpdir(), `${repoName}-run-`)),
          dispatch: {
            locksDir: lockDir,
            leasesDir: leaseDir,
            fetchTicket: () => ({
              identifier: ticket,
              state: { name: "Todo" },
              assignee: null,
              labels: { nodes: [{ name: "ai:agent-ready" }] },
            }),
            fetchInFlight: () => [],
            countLeases: () => 0,
            claimTicket: () => ({ ok: true }),
            blockBaselineTicket: blockTicket,
          },
        }));
      };

      const first = await run();
      const second = await run();
      if (first.reasonCode !== "baseline_red") {
        console.log("first summary", first);
      }

      expect(first.terminalState).toBe("FAILED");
      expect(first.reasonCode).toBe("baseline_red");
      expect(second.terminalState).toBe("FAILED");
      expect(second.reasonCode).toBe("baseline_red");
      expect(executionInputs).toHaveLength(2);
      expect(blockCalls).toHaveLength(2);
      expect(executionInputs[0]).toMatchObject({
        repo: repoName,
        ticket,
        baseline: { status: "red", check: "web_build", exitCode: 1 },
      });
      expect(String(executionInputs[0].baseline.output ?? "")).toContain("entry chunk exceeds budget");

      const comments = JSON.parse(readFileSync(path.join(linearStateDir, `${ticket}.comments.json`), "utf8"));
      expect(comments).toHaveLength(1);

      const marker = baselineFailureMarker({
        why: blockCalls[0].why,
        baseline: blockCalls[0].baseline,
        log: blockCalls[0].log,
      });
      expect(comments[0].body).toContain(`<!-- ${marker} -->`);
    } finally {
      if (detachedBaseBranch) {
        spawnSync("git", ["-C", repoRoot, "update-ref", "-d", `refs/remotes/origin/${detachedBaseBranch}`]);
      }
      for (const child of keepAliveProcesses) {
        try {
          child.kill();
        } catch {
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      if (!process.env.WM334_KEEP_TMP_ROOT) {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  });

  test("worktree provisioning failure is not misclassified as adapter_error and never reaches execution", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-provision-locks-"));
    let executed = false;
    const observingAdapter = { async execute() { executed = true; return { exitCode: 0, timedOut: false }; } };

    const spec = queueRun(db, makeDispatchSpec({ input: { repo: "wt-broken-up", ticket: "WM-732" } }));
    const summary = await runOnce(db, registry, { fake: observingAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-732", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    }));

    expect(executed).toBe(false);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("workspace_provisioning_error");
    expect(summary.error).toContain("dependency install failed");
    expect(db.query(`SELECT reason_code FROM attempts WHERE run_id = ?`).get(spec.runId).reason_code).toBe("workspace_provisioning_error");
  });

  test("worktree_up daemon startup failure surfaces serve.log in provisioning error message", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-crash-locks-"));
    const observingAdapter = { async execute() { return { exitCode: 0, timedOut: false }; } };

    const spec = queueRun(db, makeDispatchSpec({ input: { repo: "wt-startup-crash", ticket: "WM-733" } }));
    const summary = await runOnce(db, registry, { fake: observingAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        fetchTicket: () => ({ identifier: "WM-733", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    }));

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("workspace_provisioning_error");
    expect(summary.error).toContain("RegistryError: event type test: model_tier strong has no mapping");
    expect(summary.error).toContain("event runtime died during startup on 7400");
  });

  test("rollback Linear ticket state to Todo on crash, timeout, and contract violation", async () => {
    const db = openDb(":memory:");
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "evrt-rollback-locks-"));
    const leaseDir = mkdtempSync(path.join(os.tmpdir(), "evrt-rollback-leases-"));

    const rollbacks = [];
    const mockUnclaim = ({ repo, ticket, why }) => {
      rollbacks.push({ repo, ticket, why });
      return true;
    };

    // 1. Crash (exit code 1)
    const crashingAdapter = { async execute() { return { exitCode: 1, timedOut: false }; } };
    const spec1 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-740" } }));
    const sum1 = await runOnce(db, registry, { fake: crashingAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ({ identifier: "WM-740", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
        unclaimTicket: mockUnclaim,
      },
    }));
    expect(sum1.terminalState).toBe("FAILED");
    expect(rollbacks).toContainEqual(expect.objectContaining({ ticket: "WM-740", why: "agent_exit_1" }));

    // 2. Timeout
    const timingOutAdapter = { async execute() { return { exitCode: 0, timedOut: true }; } };
    const spec2 = queueRun(db, makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-741" } }));
    const sum2 = await runOnce(db, registry, { fake: timingOutAdapter }, opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ({ identifier: "WM-741", state: { name: "Todo" }, assignee: null, labels: { nodes: [{ name: "ai:agent-ready" }] } }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
        unclaimTicket: mockUnclaim,
      },
    }));
    expect(sum2.terminalState).toBe("TIMED_OUT");
    expect(rollbacks).toContainEqual(expect.objectContaining({ ticket: "WM-741", why: "timeout" }));
  });
});

// ---------------------------------------------------------------------------
// Dev live-reload: code stamp + drain-aware reload watcher (WM-213)
// ---------------------------------------------------------------------------

function stampRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-stamp-"));
  mkdirSync(path.join(root, "event-runtime", "lib", "adapters"), { recursive: true });
  writeFileSync(path.join(root, "event-runtime", "cli.mjs"), "// cli\n", "utf8");
  writeFileSync(path.join(root, "event-runtime", "lib", "worker.mjs"), "// worker\n", "utf8");
  writeFileSync(path.join(root, "event-runtime", "lib", "adapters", "fake.mjs"), "// fake\n", "utf8");
  writeFileSync(path.join(root, "README.md"), "# outside the stamp\n", "utf8");
  return root;
}

describe("code stamp (WM-213)", () => {
  test("covers event-runtime/lib/** and cli.mjs, and nothing else", () => {
    const root = stampRepo();
    try {
      expect(codeStampFiles(root)).toEqual([
        "event-runtime/cli.mjs",
        "event-runtime/lib/adapters/fake.mjs",
        "event-runtime/lib/worker.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable across calls and changes on an uncommitted edit", () => {
    const root = stampRepo();
    try {
      const before = codeStamp(root);
      expect(codeStamp(root)).toBe(before);

      // No commit, no git at all — the stamp must still notice a working-tree edit.
      writeFileSync(path.join(root, "event-runtime", "lib", "worker.mjs"), "// worker v2\n", "utf8");
      const after = codeStamp(root);
      expect(after).not.toBe(before);

      // A new file under lib/ counts too, and a file outside the paths does not.
      writeFileSync(path.join(root, "event-runtime", "lib", "new.mjs"), "// new\n", "utf8");
      expect(codeStamp(root)).not.toBe(after);
      const withNew = codeStamp(root);
      writeFileSync(path.join(root, "README.md"), "# edited\n", "utf8");
      expect(codeStamp(root)).toBe(withNew);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree with no git still stamps (nogit), rather than throwing", () => {
    const root = stampRepo();
    try {
      expect(codeStamp(root).startsWith("nogit:")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY_CODE_STAMP_ROOT overrides the watched checkout", () => {
    const root = stampRepo();
    const previous = process.env.FACTORY_CODE_STAMP_ROOT;
    try {
      process.env.FACTORY_CODE_STAMP_ROOT = root;
      expect(codeStampRoot()).toBe(root);
      expect(codeStamp()).toBe(codeStamp(root));
    } finally {
      if (previous === undefined) delete process.env.FACTORY_CODE_STAMP_ROOT;
      else process.env.FACTORY_CODE_STAMP_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reload watcher (WM-213)", () => {
  /** Watcher over a stamp and clock the test drives by hand. */
  function harness(intervalMs = 1000) {
    let stamp = "a";
    let clock = 0;
    const watcher = createReloadWatcher({
      intervalMs,
      stamp: () => stamp,
      now: () => clock,
    });
    return {
      watcher,
      change: (to) => { stamp = to; },
      advance: (ms) => { clock += ms; },
    };
  }

  test("unchanged code never reloads", () => {
    const h = harness();
    h.advance(5000);
    expect(h.watcher.check(null).action).toBe("none");
    expect(h.watcher.check("run_1").action).toBe("none");
  });

  test("re-stamps at most once per interval", () => {
    let calls = 0;
    const watcher = createReloadWatcher({ intervalMs: 1000, stamp: () => { calls += 1; return "a"; }, now: () => 0 });
    expect(calls).toBe(1); // the startup stamp
    for (let i = 0; i < 20; i += 1) watcher.check(null);
    expect(calls).toBe(1); // the clock never moved, so nothing re-hashed
  });

  test("idle worker reloads, reporting old → new", () => {
    const h = harness();
    h.change("b");
    h.advance(1000);
    const r = h.watcher.check(null);
    expect(r.action).toBe("reload");
    expect(r.from).toBe("a");
    expect(r.to).toBe("b");
  });

  test("in-flight run defers the reload, then reloads at the next idle check", () => {
    const h = harness();
    h.change("b");
    h.advance(1000);

    // Busy: deferred, and flagged `first` exactly once so the log says it once.
    const first = h.watcher.check("run_busy");
    expect(first).toMatchObject({ action: "deferred", from: "a", to: "b", runId: "run_busy", first: true });
    h.advance(1000);
    expect(h.watcher.check("run_busy")).toMatchObject({ action: "deferred", first: false });

    // The run finishes. The very next check reloads — no extra interval of wait,
    // because the pending change was latched rather than re-detected.
    expect(h.watcher.check(null)).toMatchObject({ action: "reload", from: "a", to: "b" });
  });

  test("a change that reverts before the next check is never seen", () => {
    const h = harness();
    h.change("b");
    h.change("a");
    h.advance(1000);
    expect(h.watcher.check(null).action).toBe("none");
  });

  test("once latched, the pending stamp is not re-read", () => {
    let stamp = "a";
    let reads = 0;
    let clock = 0;
    const watcher = createReloadWatcher({
      intervalMs: 1000,
      stamp: () => { reads += 1; return stamp; },
      now: () => clock,
    });
    stamp = "b";
    clock += 1000;
    expect(watcher.check("run_busy").action).toBe("deferred");
    const afterLatch = reads;
    stamp = "c"; // a second edit while busy must not un-latch the reload
    clock += 5000;
    expect(watcher.check("run_busy").action).toBe("deferred");
    expect(watcher.check(null)).toMatchObject({ action: "reload", to: "b" });
    expect(reads).toBe(afterLatch);
  });

  test("CODE_RELOAD_EXIT is a code no ordinary worker exit uses", () => {
    expect(CODE_RELOAD_EXIT).toBe(75);
  });
});

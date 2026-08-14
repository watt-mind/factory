/**
 * Single-worker execution with leases and fencing (docs/event-runtime.md §8).
 *
 * Delivery is at-least-once, never assumed exactly-once: a claim takes a
 * lease with a monotonic fencing token, an expired lease re-queues the run,
 * and only the attempt holding the run's highest token may publish a terminal
 * result. Storing an accepted result and its derived completion event is one
 * transaction via the outbox — an invalid or refused output emits no
 * completion event at all (§15 exit criterion). An operator cancelling a run
 * mid-flight surfaces here as IllegalTransition; the worker stops quietly,
 * publishing nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { storeCollected } from "./artifacts.mjs";
import { canonicalJson, hashJson, sha256Hex } from "./canonical.mjs";
import { artifactsRoot } from "./config.mjs";
import { nextCounter, tx, txImmediate } from "./db.mjs";
import { getAgent } from "./registry.mjs";
import { IllegalTransition, transition } from "./lifecycle.mjs";
import { closeOpenProposalForRun } from "./proposals.mjs";
import { computeDefHash, createReceipt, verifyDefHash } from "./receipts.mjs";
import { traceRecorder } from "./trace.mjs";
import { ContractViolation, verifyResult } from "./verify.mjs";
import { satisfiesPlacement } from "./workers.mjs";
import { createWorkspace, destroyWorkspace, PathViolation, safeJoin } from "./workspace.mjs";

/**
 * Runtime-injected artifacts: adapters that capture the agent's output write
 * it here (workspace-relative); the verifier includes it when present. The
 * agent does not have to declare its own transcript.
 */
const RUNTIME_ARTIFACTS = [{ kind: "transcript", path: ".transcript.json" }];

/** Grace added to the spec timeout before a lease is considered abandoned. */
const LEASE_GRACE_SECONDS = 120;

function resolveNow(now) {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function iso(now) {
  return new Date(resolveNow(now)).toISOString();
}

function finishAttempt(db, runId, attempt, terminalState, reasonCode, now) {
  db.query(
    `UPDATE attempts SET terminal_state = ?, reason_code = ?, finished_at = ?
     WHERE run_id = ? AND attempt = ?`,
  ).run(terminalState, reasonCode, iso(now), runId, attempt);
}

/** Include ignored files: an agent must not be able to hide a repository write. */
export function repositoryStatus(checkoutPath) {
  const result = spawnSync("git", ["-C", checkoutPath, "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : null;
}

/** Fail closed: a read-only repository workspace is acceptable only if clean. */
export function repositoryIsClean(checkoutPath) {
  return repositoryStatus(checkoutPath)?.trim() === "";
}

function assertCurrentToken(db, runId, fencingToken) {
  const maxToken = db
    .query(`SELECT MAX(fencing_token) AS m FROM attempts WHERE run_id = ?`)
    .get(runId)?.m;
  return fencingToken === maxToken;
}

function recordFencedAttempt(db, { runId, attempt, actor, policyVersion, now = Date.now() }) {
  const at = iso(now);
  const run = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId);
  const state = run?.state ?? null;
  const record = {
    runId, from: state, to: "FENCED", actor,
    reason: "fenced_attempt", attempt, policyVersion, at,
  };
  const record_hash = hashJson(record);
  db.query(
    `INSERT INTO lifecycle_events
       (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId, state, "FENCED", actor, "fenced_attempt",
    attempt, null, null, policyVersion, at, record_hash,
  );
}

function latestJournalHash(db, runId) {
  return db
    .query(`SELECT record_hash FROM lifecycle_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(runId)?.record_hash ?? null;
}

/** The admitted event this run was planned from, via its proposal (may be absent). */
function originatingEvent(db, runId) {
  return db
    .query(
      `SELECT e.type, e.correlation_id, e.causation_id
       FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.run_id = ?
       LIMIT 1`,
    )
    .get(runId) ?? null;
}

/**
 * Claim the oldest QUEUED run: bump the attempt counter, take a lease with a
 * fresh fencing token, and move it to LEASED — all in one transaction.
 *
 * @returns {{ runId: string, attempt: number, fencingToken: number, spec: object } | null}
 */
export function claimNext(db, { owner, now = () => Date.now(), policyVersion = "unknown", labels = {}, adapters = null, adapterOverride } = {}) {
  // BEGIN IMMEDIATE, not the default deferred transaction: two workers must
  // not both read the same QUEUED row before either writes (OPS-233).
  return txImmediate(db, () => {
    // Oldest-first, but skip runs this worker may not take — placement
    // requirements (§4) and adapters it does not have. Filtering in JS keeps
    // the rule in one predicate; Postgres can push it into SQL later.
    const candidates = db
      .query(
        `SELECT run_id, spec_json, attempts FROM runs
         WHERE state = 'QUEUED' ORDER BY created_at, run_id`,
      )
      .all();
    let row = null;
    let spec = null;
    for (const candidate of candidates) {
      const candidateSpec = JSON.parse(candidate.spec_json);
      if (!satisfiesPlacement(labels, candidateSpec.placement)) continue;
      if (adapters && !adapterOverride && !adapters.includes(candidateSpec.adapter)) continue;
      row = candidate;
      spec = candidateSpec;
      break;
    }
    if (!row) return null;
    const attempt = row.attempts + 1;
    const fencingToken = nextCounter(db, "fencing");
    const claimNow = resolveNow(now);
    const leaseExpiresAt = iso(claimNow + (spec.timeoutSeconds + LEASE_GRACE_SECONDS) * 1000);

    db.query(`UPDATE runs SET attempts = ?, updated_at = ? WHERE run_id = ?`)
      .run(attempt, iso(claimNow), row.run_id);
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.run_id, attempt, fencingToken, owner, leaseExpiresAt);
    transition(db, {
      runId: row.run_id, to: "LEASED", expectFrom: "QUEUED",
      actor: owner, reason: "claimed", attempt, policyVersion, now: claimNow,
    });

    return { runId: row.run_id, attempt, fencingToken, spec };
  });
}

/** Active executions by runId for cooperative cancellation. */
const ACTIVE_EXECUTIONS = new Map();

/**
 * Execute one claimed attempt to a terminal state. Returns a summary
 * { runId, attempt, terminalState, reasonCode, receipt? }, or
 * { cancelled: true } when an operator moved the run under us, or
 * { fenced: true } when a newer attempt owns the run at publish time.
 */
export async function executeClaimed(db, registry, adapters, claim, {
  workspacesRoot, artifactStore = artifactsRoot(), now = () => Date.now(), policyVersion = "unknown", adapterOverride,
} = {}) {
  const { runId, attempt, fencingToken, spec } = claim;
  const owner = db
    .query(`SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`)
    .get(runId, attempt)?.lease_owner ?? "worker";
  const retain = spec.workspace?.retainOnFailure === true;
  let workspaceDir = null;
  let checkoutPath = null;
  let checkoutBaseline = null;
  const repoName = spec.input?.repoPin?.repo ?? spec.input?.repo ?? null;

  const nowFn = typeof now === "function" ? now : () => (now ?? Date.now());

  const abortController = new AbortController();
  ACTIVE_EXECUTIONS.set(runId, {
    abort: (reason) => abortController.abort(reason),
    controller: abortController,
    runId,
    attempt,
  });
  let cancelPoll = setInterval(() => {
    try {
      const state = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId)?.state;
      if (state === "CANCELLED" && !abortController.signal.aborted) {
        abortController.abort("db_cancelled");
      }
    } catch {
      // ignore
    }
  }, 250);
  cancelPoll?.unref?.();

  /** Terminal failure-shaped write: transition + attempts row, one tx. */
  const failTerminal = (to, journalReason, reasonCode, { requeue = false } = {}) =>
    txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
        return { fenced: true };
      }
      transition(db, {
        runId, to, expectFrom: "RUNNING",
        actor: owner, reason: journalReason, attempt, policyVersion, now: currentNow,
      });
      finishAttempt(db, runId, attempt, to, reasonCode, currentNow);
      if (requeue && attempt < spec.maxAttempts) {
        transition(db, {
          runId, to: "QUEUED", expectFrom: "FAILED",
          actor: owner, reason: "retry", attempt, policyVersion, now: nowFn(),
        });
      }
      return { ok: true };
    });

  try {
    const started = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
        return { fenced: true };
      }
      transition(db, {
        runId, to: "RUNNING", expectFrom: "LEASED",
        actor: owner, reason: "started", attempt, policyVersion, now: currentNow,
      });
      db.query(`UPDATE attempts SET started_at = ? WHERE run_id = ? AND attempt = ?`)
        .run(iso(currentNow), runId, attempt);
      return { ok: true };
    });
    if (started?.fenced) {
      return { fenced: true };
    }

    const created = createWorkspace({
      root: workspacesRoot, runId, attempt, input: spec.input, workspace: spec.workspace,
      artifactStore,
    });
    workspaceDir = created.dir;
    checkoutPath = created.checkout?.path ?? null;
    checkoutBaseline = checkoutPath ? repositoryStatus(checkoutPath) : null;
    db.query(`UPDATE attempts SET workspace_path = ? WHERE run_id = ? AND attempt = ?`)
      .run(workspaceDir, runId, attempt);

    const adapterKey = adapterOverride ?? spec.adapter;
    const adapter = adapters[adapterKey];
    if (!adapter) {
      const res = failTerminal("FAILED", "unknown_adapter", "unknown_adapter");
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode: "unknown_adapter" };
    }
    const def = getAgent(registry, spec.agent);

    if (!verifyDefHash(spec, def)) {
      const refusedRes = txImmediate(db, () => {
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now });
          return { fenced: true };
        }
        transition(db, {
          runId, to: "VERIFYING", expectFrom: "RUNNING",
          actor: owner, reason: "def_hash_mismatch", attempt, policyVersion, now,
        });
        transition(db, {
          runId, to: "REFUSED", expectFrom: "VERIFYING",
          actor: owner, reason: "agent_definition_mismatch", attempt, policyVersion, now,
        });
        const receipt = createReceipt({
          runId,
          spec,
          def,
          artifactHash: null,
          evidenceSetHash: null,
          journalHead: latestJournalHash(db, runId),
          verificationStatus: "passed",
        });
        const result = {
          schemaVersion: "factory.run-result/v1",
          runId,
          attempt,
          terminalState: "refused",
          reasonCode: "agent_definition_mismatch",
          outputContract: spec.outputContract,
          verification: { status: "passed", checks: ["def_hash_mismatch"] },
          artifacts: [],
        };
        db.query(
          `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId, attempt, canonicalJson(result), "none", null,
          canonicalJson(result.verification), canonicalJson(receipt), iso(now),
        );
        finishAttempt(db, runId, attempt, "REFUSED", "agent_definition_mismatch", now);
        return { ok: true, receipt };
      });
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      if (refusedRes?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "REFUSED", reasonCode: "agent_definition_mismatch", receipt: refusedRes.receipt };
    }

    // Live trace (factory.trace/v1): the recorder is already defensive, but
    // wrap it anyway — an adapter streaming trace events mid-run must never
    // be able to turn a recording problem into a failed attempt.
    // Real wall-clock per event — NOT the claim-time `now`. Trace timestamps
    // are the one place frozen time defeats the feature: "what is the agent
    // doing right now" needs to say when each step actually happened.
    const recorder = traceRecorder(db, { runId, attempt });
    const onTrace = (kind, payload) => {
      try {
        recorder(kind, payload);
      } catch {
        // swallow: trace is observability, not correctness
      }
    };

    let outcome;
    try {
      outcome = await adapter.execute({
        spec, def, workspaceDir, timeoutMs: spec.timeoutSeconds * 1000, env: {}, onTrace,
        abortSignal: abortController.signal, signal: abortController.signal,
      });
    } finally {
      clearInterval(cancelPoll);
      ACTIVE_EXECUTIONS.delete(runId);
    }

    if (abortController.signal.aborted) {
      if (workspaceDir) destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
          return { fenced: true };
        }
        try {
          finishAttempt(db, runId, attempt, "CANCELLED", "cancelled", currentNow);
        } catch {
          // ignore
        }
        return { ok: true };
      });
      if (res?.fenced) return { fenced: true };
      return { cancelled: true };
    }

    const { exitCode, timedOut, policyDenials = [] } = outcome ?? {};

    if (timedOut) {
      const res = failTerminal("TIMED_OUT", "timeout", "timeout");
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "TIMED_OUT", reasonCode: "timeout" };
    }
    const denial = policyDenials[0];
    if (denial) {
      const reasonCode = `policy_denied:${denial.tool}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }
    if (exitCode !== 0) {
      const reasonCode = `agent_exit_${exitCode}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode, { requeue: true });
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    // The settings policy is preventative; this is the independent, durable
    // check before a repository-read run's output can be accepted or emitted.
    if (checkoutPath && (checkoutBaseline === null || repositoryStatus(checkoutPath) !== checkoutBaseline)) {
      const reasonCode = "workspace_integrity_violation";
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      destroyWorkspace(workspaceDir, { retain: true, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    const toVerifying = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
        return { fenced: true };
      }
      transition(db, {
        runId, to: "VERIFYING", expectFrom: "RUNNING",
        actor: owner, reason: "exit_0", attempt, policyVersion, now: currentNow,
      });
      return { ok: true };
    });
    if (toVerifying?.fenced) {
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      return { fenced: true };
    }

    let verified;
    try {
      verified = verifyResult({ spec, def, registry, workspaceDir, attempt, extraArtifacts: RUNTIME_ARTIFACTS });
    } catch (err) {
      if (!(err instanceof ContractViolation)) throw err;
      // Invalid output is a typed contract failure and emits no completion
      // event (§15) — no results row, no outbox row.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
          return { fenced: true };
        }
        transition(db, {
          runId, to: "FAILED", expectFrom: "VERIFYING",
          actor: owner, reason: `contract_violation: ${err.violations.join(", ")}`,
          attempt, policyVersion, now: currentNow,
        });
        finishAttempt(db, runId, attempt, "FAILED", "contract_violation", currentNow);
        if (attempt < spec.maxAttempts) {
          transition(db, {
            runId, to: "QUEUED", expectFrom: "FAILED",
            actor: owner, reason: "retry", attempt, policyVersion, now: nowFn(),
          });
        }
        return { ok: true };
      });
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode: "contract_violation" };
    }

    if (verified.kind === "refused") {
      const collected = [];
      for (const entry of RUNTIME_ARTIFACTS) {
        let abs;
        try {
          abs = safeJoin(workspaceDir, entry.path);
        } catch (err) {
          if (!(err instanceof PathViolation)) throw err;
          continue;
        }
        if (existsSync(abs)) {
          collected.push({ kind: entry.kind, uri: `file://${abs}`, sha256: sha256Hex(readFileSync(abs)) });
        }
      }
      const artifacts = storeCollected({ entries: collected, storeRoot: artifactStore });
      const refusedResult = {
        ...verified.result,
        artifacts,
      };

      // Refusal is not failure (§5.3): store the typed result, publish no
      // completion event, clean the workspace normally.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
          return { fenced: true };
        }
        transition(db, {
          runId, to: "REFUSED", expectFrom: "VERIFYING",
          actor: owner, reason: verified.reasonCode, attempt, policyVersion, now: currentNow,
        });
        const receipt = createReceipt({
          runId,
          spec,
          def,
          artifactHash: null,
          evidenceSetHash: null,
          journalHead: latestJournalHash(db, runId),
          verificationStatus: "passed",
        });
        db.query(
          `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId, attempt, canonicalJson(refusedResult), "none", null,
          canonicalJson(refusedResult.verification), canonicalJson(receipt), iso(currentNow),
        );
        finishAttempt(db, runId, attempt, "REFUSED", verified.reasonCode, currentNow);
        return { ok: true, receipt };
      });
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "REFUSED", reasonCode: verified.reasonCode, receipt: res.receipt };
    }

    // Copy verified artifact files into the durable content-addressed store
    // (§7) BEFORE the workspace dies and before the row referencing them
    // commits. Orphans from a failed commit are harmless; dead links are not.
    verified.result.artifacts = storeCollected({ entries: verified.result.artifacts, storeRoot: artifactStore });

    // Completed: fencing check, result, receipt, outbox event, and the
    // COMPLETED transition are one transaction.
    const published = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
        return { fenced: true };
      }

      const receipt = createReceipt({
        runId,
        spec,
        def,
        artifactHash: verified.result.artifactHash,
        evidenceSetHash: verified.result.evidenceSetHash,
        journalHead: latestJournalHash(db, runId),
        verificationStatus: "passed",
        extraReceipt: verified.receipt,
      });
      const { result } = verified;
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId, attempt, canonicalJson(result), result.artifactHash, result.evidenceSetHash,
        canonicalJson(result.verification), canonicalJson(receipt), iso(currentNow),
      );

      const origin = originatingEvent(db, runId);
      const envelope = {
        schemaVersion: "factory.event/v1",
        eventId: `event-runtime:${runId}:${attempt}`,
        type: origin ? origin.type.replace(/\.requested$/, ".completed") : "factory.run.completed",
        source: "event-runtime",
        subject: spec.agent,
        occurredAt: iso(currentNow),
        correlationId: origin?.correlation_id ?? null,
        causationId: origin?.causation_id ?? null,
        payload: { runId, attempt, artifactHash: result.artifactHash, outputContract: spec.outputContract },
      };
      db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`)
        .run(canonicalJson(envelope), iso(currentNow));

      transition(db, {
        runId, to: "COMPLETED", expectFrom: "VERIFYING",
        actor: owner, reason: "ok", attempt, policyVersion, now: currentNow,
      });
      finishAttempt(db, runId, attempt, "COMPLETED", "ok", currentNow);
      return { receipt };
    });

    if (published.fenced) {
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      return { fenced: true };
    }
    destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
    return { runId, attempt, terminalState: "COMPLETED", reasonCode: "ok", receipt: published.receipt };
  } catch (err) {
    if (err instanceof IllegalTransition) {
      // Operator moved the run under us (cancel) — stop quietly, publish nothing.
      if (workspaceDir) destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      const state = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId)?.state;
      if (state === "CANCELLED") {
        return { cancelled: true };
      }
      if (!assertCurrentToken(db, runId, fencingToken)) {
        txImmediate(db, () => {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now });
        });
        return { fenced: true };
      }
      return { cancelled: false, error: err.message };
    }
    // A missing CLI (OPS-296: `pi`/`npx` absent from PATH) is a typed,
    // recognizable adapter precondition, not an opaque crash — an adapter
    // signals it by throwing an error with `code: "cli_not_found"` (see
    // lib/adapters/pi.mjs's CliNotFoundError) before ever spawning a child.
    // No `requeue`: retrying on the same worker just fails the same way.
    const isCliNotFound = err?.code === "cli_not_found";
    const reasonCode = isCliNotFound ? "cli_not_found" : "adapter_error";
    const journalReason = isCliNotFound
      ? `cli_not_found: ${err.message}`
      : `adapter_error: ${err?.message ?? String(err)}`;
    let res;
    try {
      res = failTerminal("FAILED", journalReason, reasonCode, { requeue: !isCliNotFound });
    } catch {
      // if failTerminal could not transition, continue
    }
    if (workspaceDir) {
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
    }
    if (res?.fenced) return { fenced: true };
    return { runId, attempt, terminalState: "FAILED", reasonCode, error: err?.message };
  }
}

/**
 * Re-queue LEASED/RUNNING/VERIFYING runs whose current attempt's lease expired.
 * The stale attempt keeps its (now lower) fencing token, so a late publish from
 * it is fenced out. Respects maxAttempts and dead-letters beyond it.
 */
export function reapExpiredLeases(db, { now = () => Date.now(), policyVersion = "unknown" } = {}) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const rows = db
      .query(
        `SELECT r.run_id, r.attempts, r.spec_json, r.state FROM runs r
         JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
         WHERE r.state IN ('LEASED', 'RUNNING', 'VERIFYING') AND a.lease_expires_at < ?`,
      )
      .all(iso(currentNow));
    for (const row of rows) {
      const spec = JSON.parse(row.spec_json);
      if (row.attempts < spec.maxAttempts) {
        if (row.state === "VERIFYING") {
          transition(db, {
            runId: row.run_id, to: "FAILED",
            actor: "reaper", reason: "lease_expired", attempt: row.attempts, policyVersion, now: currentNow,
          });
          transition(db, {
            runId: row.run_id, to: "QUEUED",
            actor: "reaper", reason: "retry", attempt: row.attempts, policyVersion, now: currentNow,
          });
        } else {
          transition(db, {
            runId: row.run_id, to: "QUEUED",
            actor: "reaper", reason: "lease_expired", attempt: row.attempts, policyVersion, now: currentNow,
          });
        }
      } else {
        if (row.state === "LEASED") {
          transition(db, {
            runId: row.run_id, to: "RUNNING",
            actor: "reaper", reason: "lease_expired_attempts_exhausted", attempt: row.attempts, policyVersion, now: currentNow,
          });
        }
        transition(db, {
          runId: row.run_id, to: "FAILED",
          actor: "reaper", reason: "lease_expired_attempts_exhausted", attempt: row.attempts, policyVersion, now: currentNow,
        });
        finishAttempt(db, row.run_id, row.attempts, "FAILED", "lease_expired", currentNow);
      }
    }
    return rows.length;
  });
}

/** Claim and execute one run, or null when nothing is QUEUED. */
export async function runOnce(db, registry, adapters, opts = {}) {
  const claim = claimNext(db, opts);
  if (!claim) return null;
  return executeClaimed(db, registry, adapters, claim, opts);
}

/**
 * Operator cancel (§13): cancels runs in pre-terminal states.
 * For VERIFYING, transitions to FAILED with reason operator_cancel.
 * A still-open proposal for the run is closed in the same transaction.
 */
export function cancelRun(db, runId, { actor, reason = "operator_cancel", now = () => Date.now(), policyVersion } = {}) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const run = db.query(`SELECT state, attempts FROM runs WHERE run_id = ?`).get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING") {
      result = transition(db, { runId, to: "FAILED", actor, reason, policyVersion, now: currentNow });
      finishAttempt(db, runId, run.attempts, "FAILED", "cancelled", currentNow);
    } else {
      result = transition(db, { runId, to: "CANCELLED", actor, reason, policyVersion, now: currentNow });
      if (run.state === "RUNNING" || run.state === "LEASED") {
        finishAttempt(db, runId, run.attempts, "CANCELLED", "cancelled", currentNow);
      }
    }
    const proposalClose = closeOpenProposalForRun(db, runId, { actor, now: currentNow });
    const active = ACTIVE_EXECUTIONS.get(runId);
    if (active) {
      active.abort(reason);
    }
    return { ...result, proposalClose };
  });
}

/**
 * Force-fail a stranded or non-terminal run with a journaled transition.
 */
export function forceFailRun(db, runId, { actor = "operator", reason = "operator_force_fail", now = () => Date.now(), policyVersion = "unknown" } = {}) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const run = db.query(`SELECT state, attempts FROM runs WHERE run_id = ?`).get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING" || run.state === "RUNNING") {
      result = transition(db, { runId, to: "FAILED", actor, reason, policyVersion, now: currentNow });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, currentNow);
    } else if (run.state === "LEASED") {
      transition(db, { runId, to: "RUNNING", actor, reason: "force_fail_start", attempt: run.attempts, policyVersion, now: currentNow });
      result = transition(db, { runId, to: "FAILED", actor, reason, policyVersion, now: currentNow });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, currentNow);
    } else if (run.state === "QUEUED" || run.state === "APPROVED" || run.state === "PROPOSED") {
      result = transition(db, { runId, to: "CANCELLED", actor, reason, policyVersion, now: currentNow });
    } else {
      throw new Error(`cannot force-fail run in terminal state ${run.state}`);
    }
    closeOpenProposalForRun(db, runId, { actor, now: currentNow });
    return result;
  });
}

/**
 * Operator retry (§13): FAILED → QUEUED, or recovery from VERIFYING. Retrying past maxAttempts requires
 * the explicit force override, which is recorded in the journal reason.
 */
export function retryRun(db, runId, { actor, force = false, now = () => Date.now(), policyVersion } = {}) {
  const currentNow = resolveNow(now);
  const row = db.query(`SELECT state, spec_json, attempts FROM runs WHERE run_id = ?`).get(runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  const spec = JSON.parse(row.spec_json);
  if (!force && row.attempts >= spec.maxAttempts) throw new Error("attempts_exhausted");
  if (row.state === "VERIFYING") {
    return txImmediate(db, () => {
      transition(db, { runId, to: "FAILED", actor, reason: "operator_retry_verifying", policyVersion, now: currentNow });
      finishAttempt(db, runId, row.attempts, "FAILED", "operator_retry", currentNow);
      return transition(db, {
        runId, to: "QUEUED", actor,
        reason: force ? "operator_retry_forced" : "operator_retry", policyVersion, now: currentNow,
      });
    });
  }
  return transition(db, {
    runId, to: "QUEUED", actor,
    reason: force ? "operator_retry_forced" : "operator_retry", policyVersion, now: currentNow,
  });
}

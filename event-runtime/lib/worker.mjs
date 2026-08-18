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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  LEASE_HEARTBEAT_MS,
  leaseDir,
  liveWorkerLeases,
  releaseWorkerLease,
  renewWorkerLease,
  writeWorkerLease,
} from "../../lib/worker-leases.mjs";
import { loadForge } from "../../lib/forge/index.mjs";
import { storeCollected, storeResultArtifact } from "./artifacts.mjs";
import { canonicalJson, hashJson, sha256Hex } from "./canonical.mjs";
import { artifactsRoot, FACTORY_ROOT } from "./config.mjs";
import { nextCounter, recordRunUsage, tx, txImmediate } from "./db.mjs";
import { getAgent } from "./registry.mjs";
import { IllegalTransition, transition } from "./lifecycle.mjs";
import {
  worktreeDispatchAutoEligibility,
  worktreeMergeFixEligibility,
} from "./planner.mjs";
import { closeOpenProposalForRun } from "./proposals.mjs";
import { computeDefHash, createReceipt, verifyDefHash } from "./receipts.mjs";
import { traceRecorder } from "./trace.mjs";
import {
  ContractViolation,
  composeHandoffVerification,
  HANDOFF_REASON_CODES,
  verifyResult,
} from "./verify.mjs";
import {
  effectiveOwnedPaths,
  parseOwnedPaths,
  parseVerificationCommand,
} from "../../orchestrator/owned-paths.mjs";
import { HEARTBEAT_STALE_MS, satisfiesPlacement } from "./workers.mjs";
import {
  assertSandboxWorkspaceSupported,
  createWorkspace,
  destroyWorkspace,
  PathViolation,
  safeJoin,
} from "./workspace.mjs";
import { createInboxItem } from "./inbox.mjs";
import { templateFor } from "./decision-templates.mjs";

/**
 * Runtime-injected artifacts: adapters that capture the agent's output write
 * it here (workspace-relative); the verifier includes it when present. The
 * agent does not have to declare its own transcript.
 */
const RUNTIME_ARTIFACTS = [
  { kind: "transcript", path: ".transcript.json" },
  { kind: "sandbox-console", path: ".sandbox-console.log" },
];

/** Grace added to the execution deadline before a lease is considered abandoned. */
export const LEASE_GRACE_SECONDS = 120;

/**
 * Adapters that honor AbortSignal, so the worker's durable DB-backed deadline
 * monitor — not the adapter's own TERM/KILL timer — is the authoritative
 * timer and can move while an attempt is running (WM-566). Their `timeoutMs`
 * is only a runaway backstop, but it must be a real one: agy forwards it out
 * of process as `--print-timeout` and the gondolin guest timer uses it to
 * stop a wedged runner from pinning the run slot open (WM-692).
 */
export const DYNAMIC_DEADLINE_ADAPTERS = new Set([
  "agy",
  "claude",
  "command",
  "cursor",
  "fake",
  "pi",
]);

/** `limits.max_run_minutes` from config/policy.yaml, or null when unavailable. */
export function policyMaxRunMinutes(root = FACTORY_ROOT) {
  try {
    const value = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    )?.limits?.max_run_minutes;
    return Number.isFinite(value) && value > 0 ? Number(value) : null;
  } catch {
    return null;
  }
}

/**
 * The `timeoutMs` handed to `adapter.execute`. Dynamic-deadline adapters get
 * the policy ceiling: no non-override extension can move a deadline past
 * `started_at + max_run_minutes`, so `max(budget, max_run_minutes) + lease
 * grace` keeps every policy-bounded extension alive while still bounding a
 * wedged child. Every other adapter keeps its exact run budget.
 */
export function adapterExecuteTimeoutMs({
  adapterKey,
  spec,
  maxRunMinutes = policyMaxRunMinutes(),
}) {
  const budgetMs = spec.timeoutSeconds * 1000;
  if (!DYNAMIC_DEADLINE_ADAPTERS.has(adapterKey)) return budgetMs;
  const policyMs =
    Number.isFinite(maxRunMinutes) && maxRunMinutes > 0
      ? maxRunMinutes * 60_000
      : 0;
  return Math.max(budgetMs, policyMs) + LEASE_GRACE_SECONDS * 1000;
}
const DEADLINE_POLL_MS = 100;

function deadlineEventFromReason(reason, type) {
  if (typeof reason !== "string" || !reason.startsWith("{")) return null;
  try {
    const value = JSON.parse(reason);
    if (
      value?.type === type &&
      typeof value.deadlineAt === "string" &&
      Number.isFinite(Date.parse(value.deadlineAt))
    )
      return value;
  } catch {
    /* intentionally ignored */
  }
  return null;
}

function deadlineExtensionFromReason(reason) {
  const value = deadlineEventFromReason(reason, "deadline_extended");
  return value && Number.isInteger(value.seconds) && value.seconds > 0
    ? value
    : null;
}

function deadlineExpiredFromReason(reason) {
  return deadlineEventFromReason(reason, "deadline_expired");
}

/** Durable attempt deadline: latest extension, then the immutable initial budget. */
export function attemptDeadline(db, runId, attempt, spec = null) {
  const extensionRows = db
    .query(
      `SELECT reason FROM lifecycle_events WHERE run_id = ? AND attempt = ? ORDER BY seq DESC`,
    )
    .all(runId, attempt);
  for (const row of extensionRows) {
    const extension = deadlineExtensionFromReason(row.reason);
    if (extension) return Date.parse(extension.deadlineAt);
  }
  const row = db
    .query(
      `SELECT started_at, lease_expires_at FROM attempts WHERE run_id = ? AND attempt = ?`,
    )
    .get(runId, attempt);
  if (!row) return null;
  const parsedSpec =
    spec ??
    (() => {
      const run = db
        .query(`SELECT spec_json FROM runs WHERE run_id = ?`)
        .get(runId);
      return run?.spec_json ? JSON.parse(run.spec_json) : null;
    })();
  if (row.started_at && Number.isFinite(Number(parsedSpec?.timeoutSeconds))) {
    return (
      Date.parse(row.started_at) + Number(parsedSpec.timeoutSeconds) * 1000
    );
  }
  if (row.lease_expires_at) {
    return Date.parse(row.lease_expires_at) - LEASE_GRACE_SECONDS * 1000;
  }
  return null;
}

export function deadlineExtensions(db, runId) {
  return db
    .query(
      `SELECT seq, actor, reason, at FROM lifecycle_events WHERE run_id = ? ORDER BY seq`,
    )
    .all(runId)
    .flatMap((row) => {
      const extension = deadlineExtensionFromReason(row.reason);
      return extension
        ? [{ seq: row.seq, actor: row.actor, at: row.at, ...extension }]
        : [];
    });
}

/** Append an audited extension and move the current attempt's lease atomically. */
export function extendRunDeadline(
  db,
  runId,
  {
    seconds,
    actor,
    override = false,
    maxDeadlineMs = null,
    policyVersion = "unknown",
    now = Date.now(),
  } = {},
) {
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`)
      .get(runId);
    if (!run) return { refused: true, code: "unknown_run", status: 404 };
    if (!["RUNNING", "VERIFYING"].includes(run.state)) {
      return {
        refused: true,
        code: "run_not_extendable",
        status: 409,
        state: run.state,
      };
    }
    const spec = JSON.parse(run.spec_json);
    if (spec.adapter === "actions") {
      return {
        refused: true,
        code: "adapter_deadline_not_extendable",
        status: 409,
        adapter: spec.adapter,
      };
    }
    const deadlineRows = db
      .query(
        `SELECT reason FROM lifecycle_events WHERE run_id = ? AND attempt = ? ORDER BY seq DESC`,
      )
      .all(runId, run.attempts);
    if (deadlineRows.some((row) => deadlineExpiredFromReason(row.reason))) {
      return { refused: true, code: "deadline_already_expired", status: 409 };
    }
    const currentDeadline = attemptDeadline(db, runId, run.attempts, spec);
    if (!Number.isFinite(currentDeadline)) {
      return { refused: true, code: "deadline_unavailable", status: 409 };
    }
    // Serialize the edge decision under the same write lock as worker expiry.
    // A delayed worker poll must not let an operator revive an already-spent
    // deadline merely because the durable expiry marker has not landed yet.
    if (resolveNow(now) >= currentDeadline) {
      return {
        refused: true,
        code: "deadline_already_expired",
        status: 409,
        deadlineAt: new Date(currentDeadline).toISOString(),
      };
    }
    const deadlineMs = currentDeadline + seconds * 1000;
    if (
      !override &&
      Number.isFinite(maxDeadlineMs) &&
      deadlineMs > maxDeadlineMs
    ) {
      return {
        refused: true,
        code: "policy_run_limit",
        status: 409,
        deadlineAt: new Date(currentDeadline).toISOString(),
        maxDeadlineAt: new Date(maxDeadlineMs).toISOString(),
      };
    }
    const at = iso(now);
    const deadlineAt = new Date(deadlineMs).toISOString();
    const leaseExpiresAt = new Date(
      deadlineMs + LEASE_GRACE_SECONDS * 1000,
    ).toISOString();
    const reason = canonicalJson({
      type: "deadline_extended",
      seconds,
      deadlineAt,
      override: override === true,
    });
    const record = {
      runId,
      from: run.state,
      to: run.state,
      actor,
      reason,
      attempt: run.attempts,
      policyVersion,
      at,
    };
    db.query(
      `INSERT INTO lifecycle_events
         (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      runId,
      run.state,
      run.state,
      actor,
      reason,
      run.attempts,
      policyVersion,
      at,
      hashJson(record),
    );
    db.query(
      `UPDATE attempts SET lease_expires_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(leaseExpiresAt, runId, run.attempts);
    db.query(`UPDATE runs SET updated_at = ? WHERE run_id = ?`).run(at, runId);
    return {
      runId,
      seconds,
      deadlineAt,
      leaseExpiresAt,
      override: override === true,
    };
  });
}

/**
 * Durably claim expiry before signalling the adapter. This transaction races
 * the extension transaction under the same SQLite write lock: an extension
 * that commits first moves the deadline, while an expiry that commits first
 * makes every later extension a typed refusal throughout TERM/KILL grace.
 */
export function expireRunDeadline(
  db,
  runId,
  attempt,
  fencingToken,
  { actor, policyVersion = "unknown", now = Date.now() } = {},
) {
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`)
      .get(runId);
    if (
      !run ||
      run.attempts !== attempt ||
      !["RUNNING", "VERIFYING"].includes(run.state)
    ) {
      return { expired: false, inactive: true };
    }
    if (!assertCurrentToken(db, runId, fencingToken))
      return { expired: false, fenced: true };
    const rows = db
      .query(
        `SELECT reason FROM lifecycle_events WHERE run_id = ? AND attempt = ? ORDER BY seq DESC`,
      )
      .all(runId, attempt);
    const prior = rows
      .map((row) => deadlineExpiredFromReason(row.reason))
      .find(Boolean);
    if (prior)
      return { expired: true, deadlineAt: prior.deadlineAt, existing: true };

    const deadlineMs = attemptDeadline(
      db,
      runId,
      attempt,
      JSON.parse(run.spec_json),
    );
    const currentNow = resolveNow(now);
    if (!Number.isFinite(deadlineMs) || currentNow < deadlineMs) {
      return { expired: false, deadlineMs };
    }

    const at = iso(currentNow);
    const deadlineAt = new Date(deadlineMs).toISOString();
    const reason = canonicalJson({ type: "deadline_expired", deadlineAt });
    const record = {
      runId,
      from: run.state,
      to: run.state,
      actor,
      reason,
      attempt,
      policyVersion,
      at,
    };
    db.query(
      `INSERT INTO lifecycle_events
         (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      runId,
      run.state,
      run.state,
      actor,
      reason,
      attempt,
      policyVersion,
      at,
      hashJson(record),
    );
    return { expired: true, deadlineAt };
  });
}

/** Infrastructure retries are independent from the agent-error attempt budget. */
export const DEFAULT_MAX_ENVIRONMENT_RETRIES = 3;

/** Claim-lock contention is deferred independently from execution attempts. */
export const DEFAULT_MAX_CLAIM_LOCK_REQUEUES = 8;
export const DEFAULT_MAX_TRANSIENT_GATE_REQUEUES = 3;
export const CLAIM_LOCK_BACKOFF_BASE_MS = 25;
export const CLAIM_LOCK_BACKOFF_MAX_MS = 1_000;

/** Hard ceiling for synchronous git and Linear helper processes (WM-262). */
export const DEFAULT_WORKER_SUBPROCESS_TIMEOUT_MS = 120_000;

function workerSubprocessTimeoutMs() {
  const configured = Number(process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_SUBPROCESS_TIMEOUT_MS;
}

const ENVIRONMENT_FAILURES = new Set([
  "adapter_error",
  "lease_expired",
  "linear_unconfigured",
  "registry_stale",
]);
// The handoff gate (WM-718) catching the agent's own red is an agent error:
// bounded by maxAttempts like any contract violation, never an environment
// retry and never fatal — the ticket is already back in Todo + agent-ready.
const AGENT_FAILURES = new Set(["contract_violation", ...HANDOFF_REASON_CODES]);
const FATAL_FAILURES = new Set([
  "cli_not_found",
  "sandbox_unsupported",
  "worktree_sandbox_unsupported",
  "unknown_adapter",
  "agent_definition_mismatch",
  "workspace_integrity_violation",
]);

/** Closed failure taxonomy: unknown reasons fail safe as fatal and never retry. */
export function classifyFailureCause(reasonCode) {
  if (ENVIRONMENT_FAILURES.has(reasonCode)) return "environment";
  if (
    AGENT_FAILURES.has(reasonCode) ||
    String(reasonCode).startsWith("agent_exit_")
  ) {
    return "agent_error";
  }
  if (
    FATAL_FAILURES.has(reasonCode) ||
    String(reasonCode).startsWith("policy_denied:")
  ) {
    return "fatal";
  }
  return "fatal";
}

function maxEnvironmentRetries(spec) {
  return Number.isInteger(spec.maxEnvironmentRetries) &&
    spec.maxEnvironmentRetries >= 0
    ? spec.maxEnvironmentRetries
    : DEFAULT_MAX_ENVIRONMENT_RETRIES;
}

function failureCount(db, runId, cause) {
  return db
    .query(
      `SELECT reason_code FROM attempts WHERE run_id = ? AND finished_at IS NOT NULL`,
    )
    .all(runId)
    .filter((row) => classifyFailureCause(row.reason_code) === cause).length;
}

/** Called after the current attempt is finalized, so counts include this failure. */
function retryDecision(db, runId, spec, reasonCode) {
  const cause = classifyFailureCause(reasonCode);
  if (cause === "environment") {
    return {
      cause,
      retry: failureCount(db, runId, cause) <= maxEnvironmentRetries(spec),
    };
  }
  if (cause === "agent_error") {
    return { cause, retry: failureCount(db, runId, cause) < spec.maxAttempts };
  }
  return { cause, retry: false };
}

function typedFailureReason(reasonCode, detail = reasonCode) {
  return `failure:${classifyFailureCause(reasonCode)}:${detail}`;
}

function resolveNow(now) {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function iso(now) {
  return new Date(resolveNow(now)).toISOString();
}

// Must mirror the refs verify.mjs validated the authored decision against
// (issue = input.ticket, repo, runId); a divergence here would let a decision
// that passed verify fail createInboxItem's legality check at write time.
function refusalInboxRefs(spec) {
  const refs = { runId: spec.runId };
  const input = spec.input ?? {};
  const issue = input.ticket;
  const repo = input.repo;
  const pr = input.pr ?? input.prNumber;
  if (issue !== undefined && issue !== null && String(issue).trim())
    refs.issue = String(issue);
  if (repo !== undefined && repo !== null && String(repo).trim())
    refs.repo = String(repo);
  if (pr !== undefined && pr !== null && String(pr).trim())
    refs.pr = String(pr);
  return refs;
}

function createRefusalInboxItem(db, spec, result, { now }) {
  if (result.reasonCode !== "needs_human") return null;
  const refs = refusalInboxRefs(spec);
  const decision =
    result.decision ??
    templateFor("ESCALATED", {
      producer: "escalation",
      refs,
    });
  const subject = refs.issue ?? refs.runId;
  const body = result.decisionErrors?.length
    ? `The agent's decision request was rejected:\n${result.decisionErrors.join("\n")}`
    : null;
  return createInboxItem(
    db,
    {
      kind: "ESCALATED",
      title:
        result.decision?.question ??
        `ESCALATED ${subject}: ${result.reasonCode}`,
      body,
      refs,
      source: `agent:${spec.runId}`,
      decision,
      dedupeKey: `ESCALATED:${refs.issue ?? refs.runId}`,
    },
    { now },
  );
}

function finishAttempt(
  db,
  runId,
  attempt,
  terminalState,
  reasonCode,
  now,
  usage = {},
) {
  const finishedAt = iso(now);
  db.query(
    `UPDATE attempts SET terminal_state = ?, reason_code = ?, finished_at = ?
     WHERE run_id = ? AND attempt = ?`,
  ).run(terminalState, reasonCode, finishedAt, runId, attempt);
  recordRunUsage(db, { runId, attempt, recordedAt: finishedAt, ...usage });
}

/** Include ignored files: an agent must not be able to hide a repository write. */
export function repositoryStatus(
  checkoutPath,
  { timeoutMs = workerSubprocessTimeoutMs(), gitCommand = "git" } = {},
) {
  const result = spawnSync(
    gitCommand,
    [
      "-C",
      checkoutPath,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
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

function recordFencedAttempt(
  db,
  { runId, attempt, actor, policyVersion, now = Date.now() },
) {
  const at = iso(now);
  const run = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId);
  const state = run?.state ?? null;
  const record = {
    runId,
    from: state,
    to: "FENCED",
    actor,
    reason: "fenced_attempt",
    attempt,
    policyVersion,
    at,
  };
  const record_hash = hashJson(record);
  db.query(
    `INSERT INTO lifecycle_events
       (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    state,
    "FENCED",
    actor,
    "fenced_attempt",
    attempt,
    null,
    null,
    policyVersion,
    at,
    record_hash,
  );
}

function latestJournalHash(db, runId) {
  return (
    db
      .query(
        `SELECT record_hash FROM lifecycle_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(runId)?.record_hash ?? null
  );
}

function receiptWithDeadlineExtensions(db, runId, options) {
  const receipt = createReceipt(options);
  const extensions = deadlineExtensions(db, runId);
  return extensions.length > 0
    ? { ...receipt, deadlineExtensions: canonicalJson(extensions) }
    : receipt;
}

/** The admitted event this run was planned from, via its proposal (may be absent). */
function originatingEvent(db, runId) {
  return (
    db
      .query(
        `SELECT e.type, e.correlation_id, e.causation_id
       FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.run_id = ?
       LIMIT 1`,
      )
      .get(runId) ?? null
  );
}

/**
 * Claim the oldest QUEUED run: bump the attempt counter, take a lease with a
 * fresh fencing token, and move it to LEASED — all in one transaction.
 *
 * @returns {{ runId: string, attempt: number, fencingToken: number, spec: object } | { runId: string, spec: object, refused: true, retryable: true, reloadRequired: boolean, reasonCode: "registry_stale", workerRegistryVersion: string, checkoutRegistryVersion: string } | null}
 */
export function claimNext(
  db,
  {
    owner,
    now = () => Date.now(),
    policyVersion = "unknown",
    registryVersion = null,
    currentRegistryVersion = null,
    labels = {},
    adapters = null,
    adapterOverride,
  } = {},
) {
  // BEGIN IMMEDIATE, not the default deferred transaction: two workers must
  // not both read the same QUEUED row before either writes (OPS-233).
  return txImmediate(db, () => {
    const claimNow = resolveNow(now);
    // Claim-lock backoff is recorded on the latest QUEUED lifecycle event.
    // updated_at cannot be treated as a generic not-before because tests and
    // event replay may enqueue rows whose source timestamps are ahead of this
    // worker's clock.
    const candidates = db
      .query(
        `SELECT r.run_id, r.spec_json, r.attempts,
                le.reason AS queue_reason, le.at AS queued_at
           FROM runs r
           JOIN lifecycle_events le ON le.seq = (
             SELECT MAX(latest.seq) FROM lifecycle_events latest WHERE latest.run_id = r.run_id
           )
          WHERE r.state = 'QUEUED'
          ORDER BY r.created_at, r.run_id`,
      )
      .all();
    let row = null;
    let spec = null;
    let staleRefusal = null;
    let checkoutVersion;
    const resolveCheckoutVersion = () => {
      if (checkoutVersion !== undefined) return checkoutVersion;
      checkoutVersion =
        typeof currentRegistryVersion === "function"
          ? currentRegistryVersion()
          : currentRegistryVersion;
      return checkoutVersion;
    };
    for (const candidate of candidates) {
      const backoff =
        /^(?:claim_lock_contention:\d+|dispatch_gate_transient:[^:]+:\d+):backoff_(\d+)ms$/.exec(
          candidate.queue_reason ?? "",
        );
      if (
        backoff &&
        Date.parse(candidate.queued_at) + Number(backoff[1]) > claimNow
      )
        continue;
      const candidateSpec = JSON.parse(candidate.spec_json);
      if (!satisfiesPlacement(labels, candidateSpec.placement)) continue;
      if (
        adapters &&
        !adapterOverride &&
        !adapters.includes(candidateSpec.adapter)
      )
        continue;
      // The worker snapshots the registry and policy at startup. A run planned
      // against another checkout must stay QUEUED; leasing it would execute and
      // validate with incompatible definitions. Compare the live checkout too
      // so only an actually stale worker reloads — an older queued spec must not
      // put a fresh supervisor into an endless exit-75 loop.
      if (
        registryVersion &&
        (candidateSpec.promptVersion !== registryVersion ||
          candidateSpec.policyVersion !== registryVersion)
      ) {
        const current = resolveCheckoutVersion();
        const reloadRequired =
          candidateSpec.promptVersion === current &&
          candidateSpec.policyVersion === current &&
          registryVersion !== current;
        const refusal = {
          runId: candidate.run_id,
          spec: candidateSpec,
          refused: true,
          retryable: true,
          reloadRequired,
          reasonCode: "registry_stale",
          workerRegistryVersion: registryVersion,
          checkoutRegistryVersion: current,
        };
        if (reloadRequired) return refusal;
        staleRefusal ??= refusal;
        continue;
      }
      row = candidate;
      spec = candidateSpec;
      break;
    }
    if (!row) return staleRefusal;
    const attempt = row.attempts + 1;
    const fencingToken = nextCounter(db, "fencing");
    const leaseExpiresAt = iso(
      claimNow + (spec.timeoutSeconds + LEASE_GRACE_SECONDS) * 1000,
    );

    db.query(
      `UPDATE runs SET attempts = ?, updated_at = ? WHERE run_id = ?`,
    ).run(attempt, iso(claimNow), row.run_id);
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.run_id, attempt, fencingToken, owner, leaseExpiresAt);
    transition(db, {
      runId: row.run_id,
      to: "LEASED",
      expectFrom: "QUEUED",
      actor: owner,
      reason: "claimed",
      attempt,
      policyVersion,
      now: claimNow,
    });

    return { runId: row.run_id, attempt, fencingToken, spec };
  });
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultLocksDir() {
  if (process.env.FACTORY_LOCKS_DIR) return process.env.FACTORY_LOCKS_DIR;
  if (process.env.FACTORY_EVENT_HOME)
    return path.join(process.env.FACTORY_EVENT_HOME, "locks");
  return path.join(homedir(), ".factory", "locks");
}

export function dispatchLockPath(repoName, root = defaultLocksDir()) {
  return path.join(root, `${repoName}.dispatch.lock`);
}

export function acquireClaimLock(
  lockFile,
  { pid = process.pid, now = Date.now(), isAlive = defaultIsAlive } = {},
) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, `${pid} ${now}\n`, { flag: "wx" });
      return true;
    } catch {
      let lockPid;
      try {
        const content = readFileSync(lockFile, "utf8").trim();
        [lockPid] = content.split(/\s+/).map(Number);
      } catch {
        return false;
      }
      const alive = isAlive(lockPid);
      // Age alone is not proof of abandonment: a slow but live Linear claim
      // must retain mutual exclusion. Only a dead owner makes the lock stale.
      if (alive) return false;
      try {
        unlinkSync(lockFile);
      } catch {
        /* intentionally ignored */
      }
    }
  }
  return false;
}

export function releaseClaimLock(lockFile) {
  try {
    unlinkSync(lockFile);
  } catch {
    /* intentionally ignored */
  }
}

function claimLockBackoffMs(contentionNumber, random = Math.random) {
  const cap = Math.min(
    CLAIM_LOCK_BACKOFF_MAX_MS,
    CLAIM_LOCK_BACKOFF_BASE_MS * 2 ** Math.max(0, contentionNumber - 1),
  );
  const sample = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.floor(cap / 2 + (sample * cap) / 2);
}

/**
 * Put a run that never acquired the claim lock back in the queue without
 * spending its execution attempt. The lifecycle reason and timestamp form a
 * durable not-before value consumed by claimNext().
 */
function deferClaimLockContention(
  db,
  {
    runId,
    attempt,
    fencingToken,
    owner,
    policyVersion,
    now,
    maxRequeues = DEFAULT_MAX_CLAIM_LOCK_REQUEUES,
    random = Math.random,
  },
) {
  return txImmediate(db, () => {
    const currentNow = resolveNow(now);
    if (!assertCurrentToken(db, runId, fencingToken)) {
      recordFencedAttempt(db, {
        runId,
        attempt,
        actor: owner,
        policyVersion,
        now: currentNow,
      });
      return { fenced: true };
    }
    const prior = Number(
      db
        .query(
          `SELECT COUNT(*) AS n FROM lifecycle_events
       WHERE run_id = ? AND reason LIKE 'claim_lock_contention:%'`,
        )
        .get(runId)?.n ?? 0,
    );
    if (prior >= maxRequeues) return { starved: true, contentions: prior };

    const contentionNumber = prior + 1;
    const backoffMs = claimLockBackoffMs(contentionNumber, random);
    transition(db, {
      runId,
      to: "QUEUED",
      expectFrom: "RUNNING",
      actor: owner,
      reason: `claim_lock_contention:${contentionNumber}:backoff_${backoffMs}ms`,
      attempt,
      policyVersion,
      now: currentNow,
    });
    db.query(`DELETE FROM attempts WHERE run_id = ? AND attempt = ?`).run(
      runId,
      attempt,
    );
    db.query(`UPDATE runs SET attempts = ? WHERE run_id = ?`).run(
      attempt - 1,
      runId,
    );
    return { requeued: true, contentions: contentionNumber, backoffMs };
  });
}

/**
 * A plan-time eligibility proof makes a contradictory claim-time Linear read
 * distinguishable from a real gate refusal. Defer those reads without spending
 * an execution attempt, with the same durable not-before mechanism as the
 * machine-local claim lock.
 */
function deferTransientDispatchGate(
  db,
  {
    runId,
    attempt,
    fencingToken,
    owner,
    policyVersion,
    now,
    reasonCode,
    maxRequeues = DEFAULT_MAX_TRANSIENT_GATE_REQUEUES,
    random = Math.random,
  },
) {
  return txImmediate(db, () => {
    const currentNow = resolveNow(now);
    if (!assertCurrentToken(db, runId, fencingToken)) {
      recordFencedAttempt(db, {
        runId,
        attempt,
        actor: owner,
        policyVersion,
        now: currentNow,
      });
      return { fenced: true };
    }
    const prior = Number(
      db
        .query(
          `SELECT COUNT(*) AS n FROM lifecycle_events
       WHERE run_id = ? AND reason GLOB ?`,
        )
        .get(runId, `dispatch_gate_transient:${reasonCode}:*`)?.n ?? 0,
    );
    if (prior >= maxRequeues) return { exhausted: true, requeues: prior };

    const requeueNumber = prior + 1;
    const backoffMs = claimLockBackoffMs(requeueNumber, random);
    transition(db, {
      runId,
      to: "QUEUED",
      expectFrom: "RUNNING",
      actor: owner,
      reason: `dispatch_gate_transient:${reasonCode}:${requeueNumber}:backoff_${backoffMs}ms`,
      attempt,
      policyVersion,
      now: currentNow,
    });
    db.query(`DELETE FROM attempts WHERE run_id = ? AND attempt = ?`).run(
      runId,
      attempt,
    );
    db.query(`UPDATE runs SET attempts = ? WHERE run_id = ?`).run(
      attempt - 1,
      runId,
    );
    return { requeued: true, requeues: requeueNumber, backoffMs };
  });
}

function hasPlanTimeDispatchEvidence(spec) {
  return Boolean(
    spec?.approvalPolicy?.dispatchEvidence?.ticket?.descriptionHash,
  );
}

/**
 * A reaped lease leaves the Linear claim in place. Prove from the attempt
 * ledger that this new attempt belongs to the same run and immediately follows
 * a lease-expired claim before relaxing the Todo/unassigned dispatch gate.
 */
function claimedRetryFor(db, runId, attempt) {
  if (!Number.isInteger(attempt) || attempt <= 1) return null;
  const priorAttempt = attempt - 1;
  const prior = db
    .query(
      `SELECT terminal_state, reason_code FROM attempts WHERE run_id = ? AND attempt = ?`,
    )
    .get(runId, priorAttempt);
  if (
    prior?.terminal_state !== "FAILED" ||
    prior?.reason_code !== "lease_expired"
  )
    return null;
  const requeue = db
    .query(
      `SELECT reason FROM lifecycle_events
     WHERE run_id = ? AND to_state = 'QUEUED' AND attempt = ?
     ORDER BY seq DESC LIMIT 1`,
    )
    .get(runId, priorAttempt);
  if (requeue?.reason !== "retry:environment") return null;
  return { runId, priorAttempt, reasonCode: "lease_expired" };
}

function contradictsPlanTimeOwnedPaths(spec, gateResult) {
  const planned = spec?.approvalPolicy?.dispatchEvidence?.ticket;
  const current = gateResult?.evidence?.ticket;
  return Boolean(
    planned?.descriptionHash &&
    planned.ownedPathsParsed === true &&
    current?.ownedPathsParsed === false &&
    current.descriptionHash !== planned.descriptionHash,
  );
}

// ---------------------------------------------------------------------------
// Dev live-reload: code stamp + drain-aware reload watcher (WM-213)
// ---------------------------------------------------------------------------

/**
 * Exit code the worker uses to ask its supervisor for a restart. Distinct from
 * 0 (drained cleanly — stay down) and from any crash, so `bin/live-stack.sh
 * __supervise-worker` re-execs on exactly this and nothing else.
 */
export const CODE_RELOAD_EXIT = 75;

/** Uncached checkout provenance, used to distinguish a stale worker from a stale queued spec. */
export function checkoutPolicyVersion(repoRoot = FACTORY_ROOT) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: workerSubprocessTimeoutMs(),
    }).trim();
    return `git:${sha}`;
  } catch {
    return "unknown";
  }
}

/** What "the worker's code" is: everything the claim loop actually executes. */
export const CODE_STAMP_PATHS = ["event-runtime/lib", "event-runtime/cli.mjs"];

/** Re-stamping cadence. The poll loop is faster (500ms) and must not re-hash twice a second. */
export const RELOAD_CHECK_INTERVAL_MS = 1_000;

/**
 * Which checkout the stamp describes. `FACTORY_CODE_STAMP_ROOT` exists because
 * a worker can be started from a different checkout than the one it watches —
 * and because tests must be able to dirty a tree that is not this repo.
 */
export function codeStampRoot() {
  return process.env.FACTORY_CODE_STAMP_ROOT || FACTORY_ROOT;
}

function walkStampFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkStampFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Repo-relative, sorted list of the files the stamp covers. */
export function codeStampFiles(
  repoRoot = codeStampRoot(),
  paths = CODE_STAMP_PATHS,
) {
  const files = [];
  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkStampFiles(abs, files);
    else if (st.isFile()) files.push(abs);
  }
  return files.map((f) => path.relative(repoRoot, f)).sort();
}

function gitHead(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: workerSubprocessTimeoutMs(),
  });
  return result.status === 0 ? result.stdout.trim().slice(0, 12) : "nogit";
}

/**
 * A short, stable identity for the code this worker is running: HEAD plus a
 * content hash of the stamp paths.
 *
 * Contents, not mtimes — a `git checkout` that rewrites a file back to what it
 * already was must NOT bounce the worker, and an uncommitted edit must, which
 * a HEAD-only stamp misses entirely. Reading ~1MB once a second is free next
 * to the agent runs this loop supervises.
 */
export function codeStamp(
  repoRoot = codeStampRoot(),
  paths = CODE_STAMP_PATHS,
) {
  const hash = createHash("sha256");
  for (const rel of codeStampFiles(repoRoot, paths)) {
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(readFileSync(path.join(repoRoot, rel)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return `${gitHead(repoRoot)}:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Poll-boundary reload detection. `check(inFlight, { force })` is called by
 * the claim loop *between* claims and returns one of:
 *
 *   none      nothing changed (or it is not time to re-stamp yet)
 *   deferred  code changed but this worker holds a lease — keep going
 *   reload    code changed and the worker is idle — exit CODE_RELOAD_EXIT
 *
 * `deferred` can never become `reload` inside the same call, so a running
 * agent cannot be killed by a code change *by construction* — that is the
 * whole reason this is a poll-boundary check and not an fs watcher. Once a
 * change is seen it is latched (`pending`), so the reload happens on the very
 * next idle check rather than one interval later, and the stamp is not
 * recomputed while it waits.
 */
export function createReloadWatcher({
  repoRoot = codeStampRoot(),
  intervalMs = RELOAD_CHECK_INTERVAL_MS,
  stamp = () => codeStamp(repoRoot),
  now = () => Date.now(),
} = {}) {
  const from = stamp();
  let lastCheck = now();
  let pending = null;
  let deferredSeen = false;

  return {
    from,
    check(inFlight = null, { force = false } = {}) {
      if (!pending) {
        const at = now();
        // A completed run is a mandatory freshness boundary: force bypasses
        // only the cadence gate so a hot queue cannot hide a recent edit.
        if (!force && at - lastCheck < intervalMs)
          return { action: "none", from, to: from };
        lastCheck = at;
        const to = stamp();
        if (to === from) return { action: "none", from, to };
        pending = to;
      }
      if (inFlight) {
        const first = !deferredSeen;
        deferredSeen = true;
        return {
          action: "deferred",
          from,
          to: pending,
          runId: inFlight,
          first,
        };
      }
      return { action: "reload", from, to: pending };
    },
  };
}

const linearCli = () => path.join(FACTORY_ROOT, "tools", "linear.mjs");

/**
 * Resolve Linear credentials the same way the CLI does: process env first,
 * then the operator's shared env file. The resolved value is copied into the
 * supplied env so every Linear CLI child inherits it; it is never logged.
 */
export function resolveLinearApiKey({
  env = process.env,
  envFile = path.join(homedir(), "Develop", "hdkiller", ".env"),
} = {}) {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  if (!existsSync(envFile)) return null;

  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
        continue;
      const idx = trimmed.indexOf("=");
      if (trimmed.slice(0, idx).trim() !== "LINEAR_API_KEY") continue;
      const value = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (!value) return null;
      env.LINEAR_API_KEY = value;
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

/** Execute one bounded Linear CLI operation; exported for timeout regression tests. */
export function runLinearCli(
  args,
  { command = "bun", timeoutMs = workerSubprocessTimeoutMs() } = {},
) {
  return execFileSync(command, [linearCli(), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function defaultClaimTicket({ repo, ticket, harness = "claude" }) {
  try {
    runLinearCli(["claim", ticket, "--agent", harness]);
    return { ok: true };
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    return { ok: false, error: stderr.trim().split("\n").pop() || err.message };
  }
}

function defaultUnclaimTicket({ repo, ticket, why, log = null, fetchTicket }) {
  try {
    let cur = null;
    if (typeof fetchTicket === "function") {
      cur = fetchTicket(ticket);
    } else {
      const out = runLinearCli(["get", ticket, "--json"]);
      cur = JSON.parse(out);
    }
    if (!cur || cur.state?.name !== "In Progress") return false;
    if (!(cur.labels?.nodes ?? []).some((l) => l.name === "ai:in-progress"))
      return false;

    runLinearCli([
      "state",
      ticket,
      "Todo",
      "--unassign",
      "--remove",
      "ai:in-progress",
    ]);
    const body = `Dispatch run failed, claim released back to Todo.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedir(), "~")}\`` : ""}`;
    runLinearCli(["comment", ticket, body]);
    return true;
  } catch {
    return false;
  }
}

function defaultFetchTicket(ticket) {
  return JSON.parse(runLinearCli(["get", ticket, "--json"]));
}

/**
 * The claim-time facts the handoff gate (WM-718) needs and the run spec does
 * not carry: the ticket's Verification Command and Owned Paths. Read once
 * here, persisted on the worktree record, so verify.mjs runs exactly what the
 * agent was told to run. A read failure degrades to "no ticket command" (the
 * repo `verify:` still gates) rather than killing a run before it started.
 */
function ticketHandoffContext(ticket, fetchTicket) {
  try {
    const cur = fetchTicket(ticket);
    const description = cur?.description ?? "";
    const parsed = parseOwnedPaths(description);
    return {
      verificationCommand: parseVerificationCommand(description),
      ownedPaths: effectiveOwnedPaths(description),
      ownedPathsParsed: parsed.length > 0,
      descriptionHash: hashJson(description),
    };
  } catch (err) {
    return {
      verificationCommand: null,
      ownedPaths: ["**"],
      ownedPathsParsed: false,
      unavailable: String(err?.message ?? err),
    };
  }
}

function defaultCommentTicket({ ticket, body }) {
  runLinearCli(["comment", ticket, body]);
  return true;
}

/**
 * The handoff gate refused (WM-718): the agent already moved the ticket to
 * In Review, so the ordinary un-claim (which only acts on In Progress) is a
 * no-op here. Return it to Todo + ai:agent-ready — the harness caught the
 * agent, the spec is fine — and leave the worker-observed verification as
 * the record of why. Never Blocked.
 *
 * `runCli` defaults to the real `runLinearCli` and exists only so tests can
 * inject a stub that fails the first call without touching Linear.
 */
export function defaultReturnHandoffTicket({
  ticket,
  body,
  fetchTicket,
  runCli = runLinearCli,
}) {
  try {
    const cur =
      typeof fetchTicket === "function"
        ? fetchTicket(ticket)
        : defaultFetchTicket(ticket);
    const state = cur?.state?.name;
    if (!cur || !["In Progress", "In Review"].includes(state)) return false;
    const args = [
      "state",
      ticket,
      "Todo",
      "--unassign",
      "--add",
      "ai:agent-ready",
      "--remove",
      "ai:in-progress",
      "--remove",
      "ai:needs-review",
    ];
    let agentReadyRestored = true;
    let labelWarning = null;
    try {
      runCli(args);
    } catch {
      // `--add ai:agent-ready` can fail independently of the state move
      // (e.g. the Owned Paths closure check re-running on `--add`). Retry as
      // two separate calls — state+unassign+removes first, then the label
      // add on its own — so a labels-endpoint failure never silently strands
      // the ticket Todo/unassigned WITHOUT the label that makes it
      // dispatchable again.
      runCli(
        args.filter((a, i) => !(a === "--add" || args[i - 1] === "--add")),
      );
      try {
        runCli(["labels", ticket, "--add", "ai:agent-ready"]);
      } catch (err) {
        agentReadyRestored = false;
        labelWarning = String(err?.stderr ?? err?.message ?? err)
          .trim()
          .split("\n")
          .pop();
        // This must never be silent: the ticket is now Todo/unassigned
        // without the label that makes it dispatchable, and nothing else
        // will notice.
        console.error(
          `[worker] ai:agent-ready NOT restored on ${ticket} after handoff return: ${labelWarning}`,
        );
      }
    }
    const finalBody = agentReadyRestored
      ? body
      : [
          body,
          `**ai:agent-ready NOT restored** — the label add failed after the ticket returned to Todo (${labelWarning ?? "unknown error"}). This ticket will not redispatch until the label is added manually.`,
        ]
          .filter(Boolean)
          .join("\n\n");
    if (finalBody) runCli(["comment", ticket, finalBody]);
    return { ok: true, agentReadyRestored, warning: labelWarning };
  } catch {
    return false;
  }
}

/** Convert an already-opened PR to draft and say why, so nobody merges a red handoff. */
function defaultHoldPullRequest({ github, prNumber, body }) {
  if (!github || !Number.isInteger(prNumber)) return false;
  const forge = loadForge();
  const opts = { timeout: workerSubprocessTimeoutMs() };
  let held = false;
  try {
    forge.prSetDraft(github, prNumber, true, opts);
    held = true;
  } catch {
    /* already a draft, or forge unavailable — the comment still lands */
  }
  try {
    forge.prComment(github, prNumber, body, opts);
    held = true;
  } catch {
    /* intentionally ignored */
  }
  return held;
}

const BASELINE_COMMENT_MARKER = "wm:baseline:red:";

function baselineFailureSignature({ why, log = null, baseline = null }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        why,
        log,
        baseline:
          baseline && typeof baseline === "object"
            ? {
                check: baseline.check,
                exitCode: baseline.exitCode,
                output: baseline.output,
              }
            : null,
      }),
    )
    .digest("hex");
}

function hasRecordedBaselineFailureComment(ticket, signature) {
  const marker = `${BASELINE_COMMENT_MARKER}${signature}`;
  try {
    const out = runLinearCli(["comments", ticket, "--json"]);
    const comments = JSON.parse(out);
    return (comments ?? []).some((row) =>
      String(row.body ?? "").includes(marker),
    );
  } catch {
    return false;
  }
}

function defaultBlockBaselineTicket({
  repo,
  ticket,
  why,
  log = null,
  baseline = null,
  fetchTicket,
}) {
  try {
    let cur = null;
    if (typeof fetchTicket === "function") {
      cur = fetchTicket(ticket);
    } else {
      const out = runLinearCli(["get", ticket, "--json"]);
      cur = JSON.parse(out);
    }
    if (!cur || cur.state?.name !== "In Progress") return false;
    if (!(cur.labels?.nodes ?? []).some((l) => l.name === "ai:in-progress"))
      return false;

    const signature = baselineFailureSignature({ why, log, baseline });
    runLinearCli([
      "state",
      ticket,
      "Blocked",
      "--unassign",
      "--add",
      "ai:blocked",
      "--remove",
      "ai:in-progress",
    ]);

    if (!hasRecordedBaselineFailureComment(ticket, signature)) {
      const marker = `${BASELINE_COMMENT_MARKER}${signature}`;
      const body = `Dispatch run blocked due pre-existing baseline red.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedir(), "~")}\`` : ""}\n\n
<!-- ${marker} -->`;
      runLinearCli(["comment", ticket, body]);
    }
    return true;
  } catch {
    return false;
  }
}

/** Active executions by runId for cooperative cancellation. */
const ACTIVE_EXECUTIONS = new Map();

/**
 * Execute one claimed attempt to a terminal state. Returns a summary
 * { runId, attempt, terminalState, reasonCode, receipt? }, or
 * { cancelled: true } when an operator moved the run under us, or
 * { fenced: true } when a newer attempt owns the run at publish time.
 */
export async function executeClaimed(
  db,
  registry,
  adapters,
  claim,
  {
    workspacesRoot,
    artifactStore = artifactsRoot(),
    now = () => Date.now(),
    policyVersion = "unknown",
    adapterOverride,
    env = {},
    dispatch,
    resolveLinearKey = resolveLinearApiKey,
    policyRoot = FACTORY_ROOT,
  } = {},
) {
  const { runId, attempt, fencingToken, spec } = claim;
  const owner =
    db
      .query(
        `SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`,
      )
      .get(runId, attempt)?.lease_owner ?? "worker";
  const retain = spec.workspace?.retainOnFailure === true;
  let workspaceDir = null;
  let checkoutPath = null;
  let checkoutBaseline;
  let worktreeRecord;
  const cleanupWorkspace = ({ retainWorkspace = false } = {}) => {
    if (!workspaceDir) return;
    const fenced = !assertCurrentToken(db, runId, fencingToken);
    if (fenced && spec.workspace?.type === "worktree") {
      // A newer attempt for this run uses the same delegated worktree. Remove
      // only the stale attempt's teardown marker so destroyWorkspace cleans its
      // wrapper directory without invoking worktree_down under the live retry.
      try {
        unlinkSync(path.join(workspaceDir, ".worktree.json"));
      } catch {
        /* intentionally ignored */
      }
    }
    destroyWorkspace(workspaceDir, {
      retain: retainWorkspace,
      checkout: fenced ? null : checkoutPath,
      repoName,
    });
  };
  const repoName = spec.input?.repoPin?.repo ?? spec.input?.repo ?? null;
  const ticketId = spec.input?.ticket ?? null;
  const isWorktree = spec.workspace?.type === "worktree";

  let leaseHeartbeat = null;
  let ticketClaimed = false;
  const ticketLeaseOwner = `${owner}:${runId}:${fencingToken}`;
  const mayMutateClaimedTicket = () =>
    ticketClaimed && assertCurrentToken(db, runId, fencingToken);
  let attemptUsage = { adapter: adapterOverride ?? spec.adapter };

  let dispatchOpts = dispatch;
  const explicitDispatchStub =
    !dispatchOpts &&
    (process.env.FACTORY_DISPATCH_STUB === "1" ||
      adapterOverride === "fake" ||
      spec.adapter === "fake");
  if (explicitDispatchStub) {
    dispatchOpts = {
      fetchTicket: () => ({
        identifier: ticketId,
        state: { name: "Todo" },
        assignee: null,
        labels: { nodes: [{ name: "ai:agent-ready" }] },
        // The claim gate fails closed on tickets whose Owned Paths do not
        // parse (owned_paths_unknown, WM-575); a stub ticket must carry a
        // parseable section or the demo stub refuses every dispatch. `**`
        // also lets the stubbed merge-fix gate (WM-582) accept any fix path.
        description: "## Owned Paths\n- **\n",
      }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
      // The stub never reaches Linear or GitHub — including the WM-718
      // handoff comment, PR hold, and ticket return.
      commentTicket: () => true,
      returnHandoffTicket: () => true,
      holdPullRequest: () => false,
    };
  }
  const linearConfigured =
    dispatchOpts || !isWorktree || !repoName || !ticketId
      ? true
      : Boolean(resolveLinearKey());

  const locksDir = dispatchOpts?.locksDir ?? defaultLocksDir();
  const leasesDir = dispatchOpts?.leasesDir ?? leaseDir();
  const lockFile = repoName ? dispatchLockPath(repoName, locksDir) : null;
  const isAliveFn = dispatchOpts?.isAlive ?? defaultIsAlive;
  const claimTicketFn =
    dispatchOpts?.claimTicket ??
    (dispatchOpts?.fetchTicket ? () => ({ ok: true }) : defaultClaimTicket);
  const unclaimTicketFn =
    dispatchOpts?.unclaimTicket ??
    ((args) =>
      defaultUnclaimTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const blockTicketFn =
    dispatchOpts?.blockBaselineTicket ??
    ((args) =>
      defaultBlockBaselineTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const fetchTicketFn = dispatchOpts?.fetchTicket ?? defaultFetchTicket;
  const commentTicketFn = dispatchOpts?.commentTicket ?? defaultCommentTicket;
  const returnHandoffTicketFn =
    dispatchOpts?.returnHandoffTicket ??
    ((args) =>
      defaultReturnHandoffTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const holdPullRequestFn =
    dispatchOpts?.holdPullRequest ?? defaultHoldPullRequest;
  let handoffContext = null;

  const nowFn = typeof now === "function" ? now : () => now ?? Date.now();

  const abortController = new AbortController();
  ACTIVE_EXECUTIONS.set(runId, {
    abort: (reason) => abortController.abort(reason),
    controller: abortController,
    runId,
    attempt,
  });
  let cancelPoll = setInterval(() => {
    try {
      const state = db
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get(runId)?.state;
      if (state === "CANCELLED" && !abortController.signal.aborted) {
        abortController.abort("db_cancelled");
      }
    } catch {
      // ignore
    }
  }, 250);
  cancelPoll?.unref?.();
  const stopCancellationMonitor = () => {
    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = null;
    ACTIVE_EXECUTIONS.delete(runId);
  };

  /** Terminal failure-shaped write: classify, finalize, and budget any retry atomically. */
  const failTerminal = (to, journalReason, reasonCode) =>
    txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      const expectFrom = db
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get(runId)?.state;
      transition(db, {
        runId,
        to,
        expectFrom,
        actor: owner,
        reason: typedFailureReason(reasonCode, journalReason),
        attempt,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        runId,
        attempt,
        to,
        reasonCode,
        currentNow,
        attemptUsage,
      );
      const decision = retryDecision(db, runId, spec, reasonCode);
      if (decision.retry) {
        transition(db, {
          runId,
          to: "QUEUED",
          expectFrom: "FAILED",
          actor: owner,
          reason: `retry:${decision.cause}`,
          attempt,
          policyVersion,
          now: nowFn(),
        });
      }
      return { ok: true, cause: decision.cause, requeued: decision.retry };
    });

  let def = null;
  try {
    def = getAgent(registry, spec.agent);
  } catch {
    /* intentionally ignored */
  }

  const refuseTerminal = (
    reasonCode,
    checks = ["dispatch_gate"],
    { causeTyped = false, detail = null } = {},
  ) =>
    txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      const journalReason = causeTyped
        ? typedFailureReason(reasonCode)
        : (detail ?? reasonCode);
      transition(db, {
        runId,
        to: "VERIFYING",
        expectFrom: "RUNNING",
        actor: owner,
        reason: journalReason,
        attempt,
        policyVersion,
        now: currentNow,
      });
      transition(db, {
        runId,
        to: "REFUSED",
        expectFrom: "VERIFYING",
        actor: owner,
        reason: journalReason,
        attempt,
        policyVersion,
        now: currentNow,
      });
      const receipt = receiptWithDeadlineExtensions(db, runId, {
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
        reasonCode,
        outputContract: spec.outputContract,
        verification: { status: "passed", checks },
        artifacts: [],
      };
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        attempt,
        canonicalJson(result),
        "none",
        null,
        canonicalJson(result.verification),
        canonicalJson(receipt),
        iso(currentNow),
      );
      finishAttempt(
        db,
        runId,
        attempt,
        "REFUSED",
        reasonCode,
        currentNow,
        attemptUsage,
      );
      return { ok: true, receipt };
    });

  try {
    const started = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      transition(db, {
        runId,
        to: "RUNNING",
        expectFrom: "LEASED",
        actor: owner,
        reason: "started",
        attempt,
        policyVersion,
        now: currentNow,
      });
      db.query(
        `UPDATE attempts SET started_at = ? WHERE run_id = ? AND attempt = ?`,
      ).run(iso(currentNow), runId, attempt);
      return { ok: true };
    });
    if (started?.fenced) {
      return { fenced: true };
    }

    if (isWorktree && repoName && ticketId) {
      if (!linearConfigured) {
        const res = failTerminal(
          "FAILED",
          "linear_unconfigured",
          "linear_unconfigured",
        );
        stopCancellationMonitor();
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "FAILED",
          reasonCode: "linear_unconfigured",
        };
      }

      const lockAcquired = acquireClaimLock(lockFile, {
        pid: process.pid,
        now: nowFn(),
        isAlive: isAliveFn,
      });
      if (!lockAcquired) {
        const deferred = deferClaimLockContention(db, {
          runId,
          attempt,
          fencingToken,
          owner,
          policyVersion,
          now: nowFn,
          maxRequeues: Number.isInteger(
            dispatchOpts?.maxClaimLockContentionRequeues,
          )
            ? Math.max(0, dispatchOpts.maxClaimLockContentionRequeues)
            : DEFAULT_MAX_CLAIM_LOCK_REQUEUES,
          random: dispatchOpts?.random ?? Math.random,
        });
        if (deferred?.fenced) {
          stopCancellationMonitor();
          return { fenced: true };
        }
        if (deferred?.requeued) {
          stopCancellationMonitor();
          return {
            runId,
            attempt,
            terminalState: "QUEUED",
            reasonCode: "claim_lock_contention",
            requeueAfterMs: deferred.backoffMs,
          };
        }
        const res = refuseTerminal("claim_lock_starvation", [
          "dispatch_claim_lock",
        ]);
        stopCancellationMonitor();
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode: "claim_lock_starvation",
          receipt: res?.receipt,
        };
      }

      const deferTransientGate = (reasonCode) => {
        releaseClaimLock(lockFile);
        const deferred = deferTransientDispatchGate(db, {
          runId,
          attempt,
          fencingToken,
          owner,
          policyVersion,
          now: nowFn,
          reasonCode,
          maxRequeues: Number.isInteger(dispatchOpts?.maxTransientGateRequeues)
            ? Math.max(0, dispatchOpts.maxTransientGateRequeues)
            : DEFAULT_MAX_TRANSIENT_GATE_REQUEUES,
          random: dispatchOpts?.random ?? Math.random,
        });
        if (deferred?.fenced) return { fenced: true };
        if (deferred?.requeued) {
          return {
            runId,
            attempt,
            terminalState: "QUEUED",
            reasonCode,
            requeueAfterMs: deferred.backoffMs,
          };
        }
        const res = refuseTerminal(reasonCode, [
          "dispatch_gate",
          "transient_retry_exhausted",
        ]);
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode,
          receipt: res?.receipt,
        };
      };

      // WM-469 de-hardcoded the merge-fix role from the kernel: the definition
      // declares `dispatchGateExempt: true` (validated by the registry) instead
      // of a `gate: "merge-fix"` literal the worker string-matched. Keep the
      // planner and worker keyed off the SAME declarative field — a legacy
      // `gate` value is still honoured so an older pinned spec cannot silently
      // fall through to the dispatch claim gate and refuse with ticket_assigned.
      const gate =
        def?.dispatchGateExempt === true
          ? "merge-fix"
          : (def?.gate ?? "dispatch");
      if (!["dispatch", "merge-fix"].includes(gate)) {
        releaseClaimLock(lockFile);
        const reasonCode = "worktree_gate_unknown";
        const res = refuseTerminal(reasonCode, ["worktree_gate"]);
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode,
          receipt: res?.receipt,
        };
      }

      let gateResult;
      try {
        if (gate === "merge-fix") {
          const fetchNonTerminalRuns =
            dispatchOpts?.fetchNonTerminalRuns ??
            (() =>
              db
                .query(
                  `SELECT run_id AS runId, state
               FROM runs
              WHERE run_id <> ?
                AND state NOT IN ('COMPLETED','REFUSED','TIMED_OUT','CANCELLED')
                AND json_extract(spec_json, '$.input.repo') = ?
                AND json_extract(spec_json, '$.input.ticket') = ?
              ORDER BY created_at, run_id`,
                )
                .all(runId, repoName, ticketId));
          gateResult = worktreeMergeFixEligibility(spec.input, {
            fetchTicket: dispatchOpts?.fetchTicket,
            fetchPullRequest: dispatchOpts?.fetchPullRequest,
            fetchNonTerminalRuns,
            now: nowFn,
          });
        } else {
          gateResult = worktreeDispatchAutoEligibility(spec.input, {
            ...(dispatchOpts ?? {}),
            claimedRetry: claimedRetryFor(db, runId, attempt),
          });
        }
      } catch (err) {
        if (
          gate === "dispatch" &&
          hasPlanTimeDispatchEvidence(spec) &&
          String(err?.message ?? err).startsWith("linear_read_failed:")
        ) {
          return deferTransientGate("linear_read_failed");
        }
        releaseClaimLock(lockFile);
        throw err;
      }

      if (!gateResult.ok) {
        const gateRefusal = gateResult.refusal;
        if (
          gate === "dispatch" &&
          gateRefusal.reason === "owned_paths_unknown" &&
          contradictsPlanTimeOwnedPaths(spec, gateResult)
        ) {
          return deferTransientGate("owned_paths_unknown");
        }
        releaseClaimLock(lockFile);
        const res = refuseTerminal(gateRefusal.reason, [`${gate}_gate`], {
          detail: gateRefusal.detail,
        });
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode: gateRefusal.reason,
          receipt: res?.receipt,
        };
      }

      if (gate === "merge-fix") {
        // The ticket is already assigned and under review by definition. The
        // merge-fix gate proved those live facts; trying the dispatch claim
        // verb here would reject the valid run as ticket_assigned.
        releaseClaimLock(lockFile);
      } else {
        // The retry gate has already re-read and authenticated the surviving
        // claim. Do not run the mutating claim command again: besides being
        // redundant, that could steal the ticket if ownership changed in the
        // narrow interval after the gate read.
        const resumedClaim =
          gateResult.evidence?.checks?.ticket_claim_retry === true;
        if (!resumedClaim) {
          let claimRes;
          try {
            claimRes = await claimTicketFn({
              repo: repoName,
              ticket: ticketId,
              harness: spec.adapter ?? "claude",
            });
          } finally {
            releaseClaimLock(lockFile);
          }

          if (!claimRes?.ok) {
            const reasonCode = claimRes?.reasonCode || "ticket_claim_lost";
            const res = refuseTerminal(reasonCode, ["dispatch_claim"]);
            if (res?.fenced) return { fenced: true };
            return {
              runId,
              attempt,
              terminalState: "REFUSED",
              reasonCode,
              receipt: res?.receipt,
            };
          }
        } else {
          releaseClaimLock(lockFile);
        }

        ticketClaimed = true;
        handoffContext = ticketHandoffContext(ticketId, fetchTicketFn);
        writeWorkerLease({
          repo: repoName,
          ticket: ticketId,
          owner: ticketLeaseOwner,
          pid: process.pid,
          dir: leasesDir,
          now: nowFn(),
        });
        leaseHeartbeat = setInterval(() => {
          try {
            renewWorkerLease({
              repo: repoName,
              ticket: ticketId,
              owner: ticketLeaseOwner,
              dir: leasesDir,
              now: Date.now(),
            });
          } catch {
            /* intentionally ignored */
          }
        }, LEASE_HEARTBEAT_MS);
        leaseHeartbeat?.unref?.();
      }
    }

    const adapterKey = adapterOverride ?? spec.adapter;
    const created = createWorkspace({
      root: workspacesRoot,
      runId,
      attempt,
      input: spec.input,
      workspace: spec.workspace,
      artifactStore,
      adapter: adapterKey,
      ticketLeaseOwner,
      workerLeasesDir: leasesDir,
    });
    workspaceDir = created.dir;
    assertSandboxWorkspaceSupported(workspaceDir, def);
    checkoutPath = created.checkout?.path ?? null;
    checkoutBaseline = checkoutPath ? repositoryStatus(checkoutPath) : null;
    worktreeRecord = created.worktree
      ? {
          ...created.worktree,
          ...(handoffContext ? { handoff: handoffContext } : {}),
        }
      : null;
    db.query(
      `UPDATE attempts SET workspace_path = ? WHERE run_id = ? AND attempt = ?`,
    ).run(workspaceDir, runId, attempt);

    const adapter = adapters[adapterKey];
    if (!adapter) {
      const res = failTerminal("FAILED", "unknown_adapter", "unknown_adapter");
      cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "FAILED",
        reasonCode: "unknown_adapter",
      };
    }
    if (!def) def = getAgent(registry, spec.agent);

    if (!verifyDefHash(spec, def)) {
      const refusedRes = refuseTerminal(
        "agent_definition_mismatch",
        ["def_hash_mismatch"],
        { causeTyped: true },
      );
      cleanupWorkspace();
      if (refusedRes?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "REFUSED",
        reasonCode: "agent_definition_mismatch",
        receipt: refusedRes.receipt,
      };
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

    const onUsage = (usage) => {
      attemptUsage = { adapter: adapterKey, ...(usage ?? {}) };
    };

    // The extension endpoint changes the durable deadline while this promise
    // is in flight. Re-read it both on a short cadence and at the timer edge:
    // an extension committed just before the old edge must win the race.
    const logicalBase = nowFn();
    const wallBase = Date.now();
    const logicalNow = () => logicalBase + (Date.now() - wallBase);
    let deadlineTimer = null;
    let deadlinePoll = null;
    let deadlineExpired = false;
    const refreshDeadline = () => {
      if (abortController.signal.aborted) return;
      const deadlineMs = attemptDeadline(db, runId, attempt, spec);
      if (!Number.isFinite(deadlineMs)) return;
      try {
        const leaseExpiresAt = new Date(
          deadlineMs + LEASE_GRACE_SECONDS * 1000,
        ).toISOString();
        db.query(
          `UPDATE attempts SET lease_expires_at = ?
            WHERE run_id = ? AND attempt = ? AND fencing_token = ?
              AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        ).run(leaseExpiresAt, runId, attempt, fencingToken, leaseExpiresAt);
      } catch {
        /* intentionally ignored */
      }
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const leftMs = deadlineMs - logicalNow();
      if (leftMs <= 0) {
        const expiry = expireRunDeadline(db, runId, attempt, fencingToken, {
          actor: owner,
          policyVersion,
          now: logicalNow(),
        });
        if (expiry.expired) {
          deadlineExpired = true;
          abortController.abort("deadline_expired");
          return;
        }
        if (Number.isFinite(expiry.deadlineMs)) {
          deadlineTimer = setTimeout(
            refreshDeadline,
            Math.max(1, expiry.deadlineMs - logicalNow()),
          );
          deadlineTimer.unref?.();
        }
        return;
      }
      deadlineTimer = setTimeout(refreshDeadline, leftMs);
      deadlineTimer.unref?.();
    };
    refreshDeadline();
    deadlinePoll = setInterval(refreshDeadline, DEADLINE_POLL_MS);
    deadlinePoll.unref?.();
    const stopDeadlineMonitor = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (deadlinePoll) clearInterval(deadlinePoll);
      deadlineTimer = null;
      deadlinePoll = null;
    };

    let outcome;
    try {
      outcome = await adapter.execute({
        spec,
        def,
        workspaceDir,
        timeoutMs: adapterExecuteTimeoutMs({
          adapterKey,
          spec,
          maxRunMinutes: policyMaxRunMinutes(policyRoot),
        }),
        env,
        onTrace,
        onUsage,
        resume: created.resume ?? null,
        abortSignal: abortController.signal,
        signal: abortController.signal,
      });
    } finally {
      stopDeadlineMonitor();
      stopCancellationMonitor();
    }

    if (outcome?.usage)
      attemptUsage = { adapter: adapterKey, ...outcome.usage };
    if (deadlineExpired) outcome = { ...(outcome ?? {}), timedOut: true };

    if (abortController.signal.aborted && !deadlineExpired) {
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: "cancelled",
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      cleanupWorkspace();
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now: currentNow,
          });
          return { fenced: true };
        }
        try {
          finishAttempt(
            db,
            runId,
            attempt,
            "CANCELLED",
            "cancelled",
            currentNow,
            attemptUsage,
          );
        } catch {
          // ignore
        }
        return { ok: true };
      });
      if (res?.fenced) return { fenced: true };
      return { cancelled: true };
    }

    const { exitCode, timedOut, policyDenials = [] } = outcome ?? {};
    let lateCompletion = false;

    if (timedOut) {
      // The adapter's stream may outlive the agent-authored artifact. Perform
      // an output-contract preflight before recording TIMED_OUT, but suppress
      // worktree command verification until after the fenced VERIFYING
      // transition below. The normal verifier then runs again in full.
      try {
        verifyResult({
          spec,
          def,
          registry,
          workspaceDir,
          attempt,
          extraArtifacts: RUNTIME_ARTIFACTS,
          worktreeRecord: {},
        });
        lateCompletion = true;
      } catch (err) {
        if (!(err instanceof ContractViolation)) throw err;
      }

      if (!lateCompletion) {
        if (mayMutateClaimedTicket()) {
          try {
            unclaimTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: "timeout",
              log: null,
            });
          } catch {
            /* intentionally ignored */
          }
        }
        const res = failTerminal("TIMED_OUT", "timeout", "timeout");
        cleanupWorkspace({ retainWorkspace: retain });
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "TIMED_OUT",
          reasonCode: "timeout",
        };
      }
    }
    const denial = policyDenials[0];
    if (!lateCompletion && denial) {
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: `policy_denied:${denial.tool}`,
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      const reasonCode = `policy_denied:${denial.tool}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }
    if (!lateCompletion && exitCode !== 0) {
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: `agent_exit_${exitCode}`,
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      const reasonCode = `agent_exit_${exitCode}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    // The settings policy is preventative; this is the independent, durable
    // check before a repository-read run's output can be accepted or emitted.
    // Mutating worktree workspaces are exempt.
    if (
      !isWorktree &&
      !def.mutating &&
      checkoutPath &&
      (checkoutBaseline === null ||
        repositoryStatus(checkoutPath) !== checkoutBaseline)
    ) {
      const reasonCode = "workspace_integrity_violation";
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      cleanupWorkspace({ retainWorkspace: true });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    const toVerifying = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      transition(db, {
        runId,
        to: "VERIFYING",
        expectFrom: "RUNNING",
        actor: owner,
        reason: lateCompletion ? "late_completion_after_timeout" : "exit_0",
        attempt,
        policyVersion,
        now: currentNow,
      });
      return { ok: true };
    });
    if (toVerifying?.fenced) {
      cleanupWorkspace();
      return { fenced: true };
    }

    let verified;
    try {
      verified = verifyResult({
        spec,
        def,
        registry,
        workspaceDir,
        attempt,
        extraArtifacts: RUNTIME_ARTIFACTS,
        worktreeRecord,
      });
    } catch (err) {
      if (!(err instanceof ContractViolation)) throw err;
      const reasonCode =
        err.reasonCode === "baseline_red" ||
        HANDOFF_REASON_CODES.has(err.reasonCode)
          ? err.reasonCode
          : "contract_violation";
      let failureReason = `${reasonCode}: ${err.violations.join(", ")}`;
      const handoff = err.handoff ?? null;
      const handoffBody = handoff
        ? `${composeHandoffVerification(handoff)}\n\n**Result:** run ${runId} FAILED \`${reasonCode}\` — ${err.violations.join("; ")}`
        : null;
      // WM-718: the PR is the agent's, already opened; the structural hold is
      // to draft it and quote the observed failure where the reviewer looks.
      if (
        HANDOFF_REASON_CODES.has(reasonCode) &&
        handoff?.prNumber &&
        mayMutateClaimedTicket()
      ) {
        try {
          holdPullRequestFn({
            repo: repoName,
            github: handoff.github,
            prNumber: handoff.prNumber,
            prUrl: handoff.prUrl,
            body: `${handoffBody}\n\nConverted to draft by the factory worker: the handoff did not verify.`,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      if (mayMutateClaimedTicket()) {
        if (HANDOFF_REASON_CODES.has(reasonCode)) {
          try {
            const returned = returnHandoffTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              body: `${handoffBody}\n\nClaim released back to Todo + ai:agent-ready.`,
              handoff,
            });
            // Surface a failed label restore in the journal/returned summary
            // too — the comment posted on the ticket is not the only place a
            // human (or the next dispatch pass) looks.
            if (returned && returned.agentReadyRestored === false) {
              failureReason = `${failureReason} (ai:agent-ready NOT restored: ${returned.warning ?? "unknown error"})`;
            }
          } catch {
            /* intentionally ignored */
          }
        } else if (reasonCode === "baseline_red") {
          try {
            blockTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              log: null,
              baseline: worktreeRecord?.baseline,
            });
          } catch {
            /* intentionally ignored */
          }
        } else {
          try {
            unclaimTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              log: null,
            });
          } catch {
            /* intentionally ignored */
          }
        }
      }
      // Invalid output is a typed contract failure and emits no completion
      // event (§15) — no results row, no outbox row. A matching pre-existing
      // red baseline is equally non-admissible, but is named separately and
      // not retried as though the agent caused an ordinary contract failure.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now: currentNow,
          });
          return { fenced: true };
        }
        transition(db, {
          runId,
          to: "FAILED",
          expectFrom: "VERIFYING",
          actor: owner,
          reason: typedFailureReason(reasonCode, failureReason),
          attempt,
          policyVersion,
          now: currentNow,
        });
        finishAttempt(
          db,
          runId,
          attempt,
          "FAILED",
          reasonCode,
          currentNow,
          attemptUsage,
        );
        const decision = retryDecision(db, runId, spec, reasonCode);
        if (decision.retry) {
          transition(db, {
            runId,
            to: "QUEUED",
            expectFrom: "FAILED",
            actor: owner,
            reason: `retry:${decision.cause}`,
            attempt,
            policyVersion,
            now: nowFn(),
          });
        }
        return { ok: true };
      });
      cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "FAILED",
        reasonCode,
        detail: failureReason,
        ...(handoff ? { handoff } : {}),
      };
    }

    if (verified.kind === "refused") {
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: `refused: ${verified.reasonCode}`,
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
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
          collected.push({
            kind: entry.kind,
            uri: `file://${abs}`,
            sha256: sha256Hex(readFileSync(abs)),
          });
        }
      }
      const artifacts = storeCollected({
        entries: collected,
        storeRoot: artifactStore,
      });
      const refusedResult = {
        ...verified.result,
        artifacts,
      };

      // Refusal is not failure (§5.3): store the typed result, publish no
      // completion event, clean the workspace normally.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now: currentNow,
          });
          return { fenced: true };
        }
        transition(db, {
          runId,
          to: "REFUSED",
          expectFrom: "VERIFYING",
          actor: owner,
          reason: verified.reasonCode,
          attempt,
          policyVersion,
          now: currentNow,
        });
        const receipt = receiptWithDeadlineExtensions(db, runId, {
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
          runId,
          attempt,
          canonicalJson(refusedResult),
          "none",
          null,
          canonicalJson(refusedResult.verification),
          canonicalJson(receipt),
          iso(currentNow),
        );
        // Best-effort projection: the inbox row must never un-record the
        // terminal REFUSED state or its result row by throwing out of this tx.
        try {
          createRefusalInboxItem(db, spec, refusedResult, { now: currentNow });
        } catch (err) {
          console.error(
            `[worker] refusal inbox item not created for ${runId}: ${err?.message ?? err}`,
          );
        }
        finishAttempt(
          db,
          runId,
          attempt,
          "REFUSED",
          verified.reasonCode,
          currentNow,
          attemptUsage,
        );
        return { ok: true, receipt };
      });
      cleanupWorkspace();
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "REFUSED",
        reasonCode: verified.reasonCode,
        receipt: res.receipt,
      };
    }

    // WM-718: the Handoff's Verification line is worker-authored. Post what
    // was observed on the ticket; the agent's claim rides below it labelled
    // agent-reported. Best effort — a comment failure never fails a verified
    // run.
    if (verified.handoff && mayMutateClaimedTicket()) {
      try {
        commentTicketFn({
          repo: repoName,
          ticket: ticketId,
          body: composeHandoffVerification(verified.handoff),
          handoff: verified.handoff,
        });
      } catch {
        /* intentionally ignored */
      }
    }

    // Copy verified artifact files into the durable content-addressed store
    // (§7) BEFORE the workspace dies and before the row referencing them
    // commits. Orphans from a failed commit are harmless; dead links are not.
    verified.result.artifacts = storeCollected({
      entries: verified.result.artifacts,
      storeRoot: artifactStore,
    });
    storeResultArtifact({
      artifact: verified.result.artifact,
      artifactHash: verified.result.artifactHash,
      storeRoot: artifactStore,
    });

    // Completed: fencing check, result, receipt, outbox event, and the
    // COMPLETED transition are one transaction.
    const published = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }

      const receipt = receiptWithDeadlineExtensions(db, runId, {
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
        runId,
        attempt,
        canonicalJson(result),
        result.artifactHash,
        result.evidenceSetHash,
        canonicalJson(result.verification),
        canonicalJson(receipt),
        iso(currentNow),
      );

      const origin = originatingEvent(db, runId);
      const envelope = {
        schemaVersion: "factory.event/v1",
        eventId: `event-runtime:${runId}:${attempt}`,
        type: origin
          ? origin.type.replace(/\.requested$/, ".completed")
          : "factory.run.completed",
        source: "event-runtime",
        subject: spec.agent,
        occurredAt: iso(currentNow),
        correlationId: origin?.correlation_id ?? null,
        causationId: origin?.causation_id ?? null,
        payload: {
          runId,
          attempt,
          artifactHash: result.artifactHash,
          outputContract: spec.outputContract,
        },
      };
      db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`).run(
        canonicalJson(envelope),
        iso(currentNow),
      );

      transition(db, {
        runId,
        to: "COMPLETED",
        expectFrom: "VERIFYING",
        actor: owner,
        reason: "ok",
        attempt,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        runId,
        attempt,
        "COMPLETED",
        "ok",
        currentNow,
        attemptUsage,
      );
      return { receipt };
    });

    if (published.fenced) {
      cleanupWorkspace();
      return { fenced: true };
    }
    cleanupWorkspace();
    return {
      runId,
      attempt,
      terminalState: "COMPLETED",
      reasonCode: "ok",
      receipt: published.receipt,
      ...(verified.handoff ? { handoff: verified.handoff } : {}),
    };
  } catch (err) {
    if (mayMutateClaimedTicket()) {
      try {
        unclaimTicketFn({
          repo: repoName,
          ticket: ticketId,
          why: err?.message ?? String(err),
          log: null,
        });
      } catch {
        /* intentionally ignored */
      }
    }
    if (err instanceof IllegalTransition) {
      // Operator moved the run under us (cancel) — stop quietly, publish nothing.
      cleanupWorkspace();
      const state = db
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get(runId)?.state;
      if (state === "CANCELLED") {
        return { cancelled: true };
      }
      if (!assertCurrentToken(db, runId, fencingToken)) {
        txImmediate(db, () => {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now,
          });
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
    const isSandboxUnsupported = err?.code === "sandbox_unsupported";
    const isWorktreeSandboxUnsupported =
      err?.code === "worktree_sandbox_unsupported";
    const isWorkspaceProvisioning =
      err?.code === "workspace_provisioning_error";
    const reasonCode = isCliNotFound
      ? "cli_not_found"
      : isSandboxUnsupported
        ? "sandbox_unsupported"
        : isWorktreeSandboxUnsupported
          ? "worktree_sandbox_unsupported"
          : isWorkspaceProvisioning
            ? "workspace_provisioning_error"
            : "adapter_error";
    const journalReason = `${reasonCode}: ${err?.message ?? String(err)}`;
    let res;
    try {
      res = failTerminal("FAILED", journalReason, reasonCode);
    } catch {
      // if failTerminal could not transition, continue
    }
    cleanupWorkspace({ retainWorkspace: retain });
    if (res?.fenced) return { fenced: true };
    return {
      runId,
      attempt,
      terminalState: "FAILED",
      reasonCode,
      error: err?.message,
    };
  } finally {
    stopCancellationMonitor();
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (ticketClaimed) {
      try {
        releaseWorkerLease({
          repo: repoName,
          ticket: ticketId,
          owner: ticketLeaseOwner,
          dir: leasesDir,
        });
      } catch {
        /* intentionally ignored */
      }
    }
  }
}

/**
 * Explicit operator recovery for a worker that stopped heartbeating while it
 * still owned a run. This mirrors the lease reaper's retry/exhaustion rules,
 * but targets exactly the selected worker/run and records an operator reason.
 */
export function releaseStalledWorkerLease(
  db,
  { workerId, runId },
  {
    now = () => Date.now(),
    policyVersion = "unknown",
    actor = "operator",
  } = {},
) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const worker = db
      .query(
        `SELECT state, current_run, last_seen FROM workers WHERE worker_id = ?`,
      )
      .get(workerId);
    if (!worker) throw new Error(`unknown worker ${workerId}`);
    const stale =
      worker.state !== "stopped" &&
      currentNow - Date.parse(worker.last_seen) > HEARTBEAT_STALE_MS;
    if (!stale || !worker.current_run)
      throw new Error(`worker ${workerId} is not stalled with an active run`);
    if (runId && worker.current_run !== runId) {
      throw new Error(
        `worker ${workerId} holds ${worker.current_run}, not ${runId}`,
      );
    }

    const heldRunId = worker.current_run;
    const run = db
      .query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`)
      .get(heldRunId);
    if (!run)
      throw new Error(`worker ${workerId} references unknown run ${heldRunId}`);
    if (!["LEASED", "RUNNING", "VERIFYING"].includes(run.state)) {
      throw new Error(`run ${heldRunId} is ${run.state}, not actively leased`);
    }
    const attempt = db
      .query(
        `SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`,
      )
      .get(heldRunId, run.attempts);
    if (!attempt) throw new Error(`run ${heldRunId} has no current attempt`);
    if (attempt.lease_owner && attempt.lease_owner !== workerId) {
      throw new Error(
        `run ${heldRunId} is leased by ${attempt.lease_owner}, not ${workerId}`,
      );
    }

    const spec = JSON.parse(run.spec_json);
    const reason = "operator_release_stalled_worker";
    db.query(
      `UPDATE attempts SET lease_expires_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(iso(currentNow - 1), heldRunId, run.attempts);
    if (run.attempts < spec.maxAttempts) {
      if (run.state === "VERIFYING") {
        transition(db, {
          runId: heldRunId,
          to: "FAILED",
          actor,
          reason,
          attempt: run.attempts,
          policyVersion,
          now: currentNow,
        });
        transition(db, {
          runId: heldRunId,
          to: "QUEUED",
          actor,
          reason: "retry_after_stalled_worker_release",
          attempt: run.attempts,
          policyVersion,
          now: currentNow,
        });
      } else {
        transition(db, {
          runId: heldRunId,
          to: "QUEUED",
          actor,
          reason,
          attempt: run.attempts,
          policyVersion,
          now: currentNow,
        });
      }
    } else {
      if (run.state === "LEASED") {
        transition(db, {
          runId: heldRunId,
          to: "RUNNING",
          actor,
          reason,
          attempt: run.attempts,
          policyVersion,
          now: currentNow,
        });
      }
      transition(db, {
        runId: heldRunId,
        to: "FAILED",
        actor,
        reason,
        attempt: run.attempts,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        heldRunId,
        run.attempts,
        "FAILED",
        "stalled_worker_released",
        currentNow,
      );
    }
    db.query(
      `UPDATE workers SET state = 'stopped', current_run = NULL, stopped_at = ? WHERE worker_id = ?`,
    ).run(iso(currentNow), workerId);
    return { released: true, runId: heldRunId };
  });
}

/**
 * Re-queue LEASED/RUNNING/VERIFYING runs whose current attempt's lease expired.
 * The stale attempt keeps its (now lower) fencing token, so a late publish from
 * it is fenced out. Lease loss spends only the dedicated environment budget.
 */
export function reapExpiredLeases(
  db,
  { now = () => Date.now(), policyVersion = "unknown" } = {},
) {
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
      const failureReason = typedFailureReason("lease_expired");

      // VERIFYING cannot transition directly to QUEUED; record its failure first.
      if (row.state === "VERIFYING") {
        transition(db, {
          runId: row.run_id,
          to: "FAILED",
          actor: "reaper",
          reason: failureReason,
          attempt: row.attempts,
          policyVersion,
          now: currentNow,
        });
      }
      finishAttempt(
        db,
        row.run_id,
        row.attempts,
        "FAILED",
        "lease_expired",
        currentNow,
      );
      const decision = retryDecision(db, row.run_id, spec, "lease_expired");

      if (decision.retry) {
        transition(db, {
          runId: row.run_id,
          to: "QUEUED",
          actor: "reaper",
          reason: `retry:${decision.cause}`,
          attempt: row.attempts,
          policyVersion,
          now: currentNow,
        });
        continue;
      }

      // LEASED has no direct FAILED edge; advance through RUNNING only when
      // the environment retry ceiling is exhausted and the run must terminate.
      if (row.state === "LEASED") {
        transition(db, {
          runId: row.run_id,
          to: "RUNNING",
          actor: "reaper",
          reason: failureReason,
          attempt: row.attempts,
          policyVersion,
          now: currentNow,
        });
      }
      if (row.state !== "VERIFYING") {
        transition(db, {
          runId: row.run_id,
          to: "FAILED",
          actor: "reaper",
          reason: failureReason,
          attempt: row.attempts,
          policyVersion,
          now: currentNow,
        });
      }
    }
    return rows.length;
  });
}

/** Claim and execute one run, or return a typed refusal/null without execution. */
export async function runOnce(db, registry, adapters, opts = {}) {
  const claim = claimNext(db, opts);
  if (!claim || claim.refused) return claim;
  return executeClaimed(db, registry, adapters, claim, opts);
}

/**
 * Operator cancel (§13): cancels runs in pre-terminal states.
 * For VERIFYING, transitions to FAILED with reason operator_cancel.
 * A still-open proposal for the run is closed in the same transaction.
 */
export function cancelRun(
  db,
  runId,
  {
    actor,
    reason = "operator_cancel",
    now = () => Date.now(),
    policyVersion,
  } = {},
) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts FROM runs WHERE run_id = ?`)
      .get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING") {
      result = transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(db, runId, run.attempts, "FAILED", "cancelled", currentNow);
    } else {
      result = transition(db, {
        runId,
        to: "CANCELLED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      if (run.state === "RUNNING" || run.state === "LEASED") {
        finishAttempt(
          db,
          runId,
          run.attempts,
          "CANCELLED",
          "cancelled",
          currentNow,
        );
      }
    }
    const proposalClose = closeOpenProposalForRun(db, runId, {
      actor,
      now: currentNow,
    });
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
export function forceFailRun(
  db,
  runId,
  {
    actor = "operator",
    reason = "operator_force_fail",
    now = () => Date.now(),
    policyVersion = "unknown",
  } = {},
) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts FROM runs WHERE run_id = ?`)
      .get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING" || run.state === "RUNNING") {
      result = transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, currentNow);
    } else if (run.state === "LEASED") {
      transition(db, {
        runId,
        to: "RUNNING",
        actor,
        reason: "force_fail_start",
        attempt: run.attempts,
        policyVersion,
        now: currentNow,
      });
      result = transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, currentNow);
    } else if (
      run.state === "QUEUED" ||
      run.state === "APPROVED" ||
      run.state === "PROPOSED"
    ) {
      result = transition(db, {
        runId,
        to: "CANCELLED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
    } else {
      throw new Error(`cannot force-fail run in terminal state ${run.state}`);
    }
    closeOpenProposalForRun(db, runId, { actor, now: currentNow });
    return result;
  });
}

/**
 * Operator retry (§13): FAILED → QUEUED, or recovery from VERIFYING. Only
 * agent-caused failures spend maxAttempts; environment attempts remain retryable.
 * Retrying past the agent budget requires the explicit force override.
 *
 * REFUSED is immutable in the lifecycle journal. Give the operator the exact
 * fresh watched-dispatch command instead of leaking an IllegalTransition.
 */
export function retryRun(
  db,
  runId,
  { actor, force = false, now = () => Date.now(), policyVersion } = {},
) {
  const currentNow = resolveNow(now);
  const row = db
    .query(`SELECT state, spec_json, attempts FROM runs WHERE run_id = ?`)
    .get(runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  const spec = JSON.parse(row.spec_json);
  if (row.state === "REFUSED") {
    const reasonCode =
      db
        .query(
          `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId)?.reason_code ?? "unknown_refusal";
    const payload = JSON.stringify({
      repo: spec.input?.repo,
      ticket: spec.input?.ticket,
    });
    const command = `factory dispatch event factory.dispatch.requested --payload '${payload}' --watch`;
    const sensitive = [
      "ticket_security",
      "ticket_escalated",
      "escalate_paths_intersect",
    ].includes(reasonCode);
    throw new Error(
      `refused_run_not_retryable: ${runId} was refused by ${reasonCode}; ` +
        `${sensitive ? "human review is required before a fresh watched dispatch; " : "submit a fresh watched dispatch with: "}` +
        command,
    );
  }
  if (
    !force &&
    (failureCount(db, runId, "agent_error") >= spec.maxAttempts ||
      failureCount(db, runId, "fatal") > 0)
  ) {
    throw new Error("attempts_exhausted");
  }
  if (row.state === "VERIFYING") {
    return txImmediate(db, () => {
      transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason: "operator_retry_verifying",
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        runId,
        row.attempts,
        "FAILED",
        "operator_retry",
        currentNow,
      );
      return transition(db, {
        runId,
        to: "QUEUED",
        actor,
        reason: force ? "operator_retry_forced" : "operator_retry",
        policyVersion,
        now: currentNow,
      });
    });
  }
  return transition(db, {
    runId,
    to: "QUEUED",
    actor,
    reason: force ? "operator_retry_forced" : "operator_retry",
    policyVersion,
    now: currentNow,
  });
}

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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LEASE_HEARTBEAT_MS, leaseDir, liveWorkerLeases, releaseWorkerLease, renewWorkerLease, writeWorkerLease } from "../../lib/worker-leases.mjs";
import { storeCollected } from "./artifacts.mjs";
import { canonicalJson, hashJson, sha256Hex } from "./canonical.mjs";
import { artifactsRoot, FACTORY_ROOT } from "./config.mjs";
import { nextCounter, recordRunUsage, tx, txImmediate } from "./db.mjs";
import { getAgent } from "./registry.mjs";
import { IllegalTransition, transition } from "./lifecycle.mjs";
import { worktreeDispatchGate } from "./planner.mjs";
import { closeOpenProposalForRun } from "./proposals.mjs";
import { computeDefHash, createReceipt, verifyDefHash } from "./receipts.mjs";
import { traceRecorder } from "./trace.mjs";
import { ContractViolation, verifyResult } from "./verify.mjs";
import { HEARTBEAT_STALE_MS, satisfiesPlacement } from "./workers.mjs";
import { createWorkspace, destroyWorkspace, PathViolation, safeJoin } from "./workspace.mjs";

/**
 * Runtime-injected artifacts: adapters that capture the agent's output write
 * it here (workspace-relative); the verifier includes it when present. The
 * agent does not have to declare its own transcript.
 */
const RUNTIME_ARTIFACTS = [{ kind: "transcript", path: ".transcript.json" }];

/** Grace added to the spec timeout before a lease is considered abandoned. */
const LEASE_GRACE_SECONDS = 120;

/** Infrastructure retries are independent from the agent-error attempt budget. */
export const DEFAULT_MAX_ENVIRONMENT_RETRIES = 3;

/** Hard ceiling for synchronous git and Linear helper processes (WM-262). */
export const DEFAULT_WORKER_SUBPROCESS_TIMEOUT_MS = 120_000;

function workerSubprocessTimeoutMs() {
  const configured = Number(process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_SUBPROCESS_TIMEOUT_MS;
}

const ENVIRONMENT_FAILURES = new Set(["adapter_error", "lease_expired"]);
const AGENT_FAILURES = new Set(["contract_violation"]);
const FATAL_FAILURES = new Set([
  "cli_not_found",
  "unknown_adapter",
  "agent_definition_mismatch",
  "workspace_integrity_violation",
]);

/** Closed failure taxonomy: unknown reasons fail safe as fatal and never retry. */
export function classifyFailureCause(reasonCode) {
  if (ENVIRONMENT_FAILURES.has(reasonCode)) return "environment";
  if (AGENT_FAILURES.has(reasonCode) || String(reasonCode).startsWith("agent_exit_")) {
    return "agent_error";
  }
  if (FATAL_FAILURES.has(reasonCode) || String(reasonCode).startsWith("policy_denied:")) {
    return "fatal";
  }
  return "fatal";
}

function maxEnvironmentRetries(spec) {
  return Number.isInteger(spec.maxEnvironmentRetries) && spec.maxEnvironmentRetries >= 0
    ? spec.maxEnvironmentRetries
    : DEFAULT_MAX_ENVIRONMENT_RETRIES;
}

function failureCount(db, runId, cause) {
  return db
    .query(`SELECT reason_code FROM attempts WHERE run_id = ? AND finished_at IS NOT NULL`)
    .all(runId)
    .filter((row) => classifyFailureCause(row.reason_code) === cause)
    .length;
}

/** Called after the current attempt is finalized, so counts include this failure. */
function retryDecision(db, runId, spec, reasonCode) {
  const cause = classifyFailureCause(reasonCode);
  if (cause === "environment") {
    return { cause, retry: failureCount(db, runId, cause) <= maxEnvironmentRetries(spec) };
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

function finishAttempt(db, runId, attempt, terminalState, reasonCode, now, usage = {}) {
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
  const result = spawnSync(gitCommand, ["-C", checkoutPath, "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], {
    encoding: "utf8",
    timeout: timeoutMs,
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

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function defaultLocksDir() {
  if (process.env.FACTORY_LOCKS_DIR) return process.env.FACTORY_LOCKS_DIR;
  if (process.env.FACTORY_EVENT_HOME) return path.join(process.env.FACTORY_EVENT_HOME, "locks");
  return path.join(homedir(), ".factory", "locks");
}

export function dispatchLockPath(repoName, root = defaultLocksDir()) {
  return path.join(root, `${repoName}.dispatch.lock`);
}

export function acquireClaimLock(lockFile, { pid = process.pid, now = Date.now(), isAlive = defaultIsAlive } = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, `${pid} ${now}\n`, { flag: "wx" });
      return true;
    } catch {
      let lockPid = 0, at = 0;
      try {
        const content = readFileSync(lockFile, "utf8").trim();
        [lockPid, at] = content.split(/\s+/).map(Number);
      } catch {
        return false;
      }
      const alive = isAlive(lockPid);
      if (alive && now - at < 120_000) return false;
      try { unlinkSync(lockFile); } catch {}
    }
  }
  return false;
}

export function releaseClaimLock(lockFile) {
  try { unlinkSync(lockFile); } catch {}
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
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkStampFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Repo-relative, sorted list of the files the stamp covers. */
export function codeStampFiles(repoRoot = codeStampRoot(), paths = CODE_STAMP_PATHS) {
  const files = [];
  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
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
export function codeStamp(repoRoot = codeStampRoot(), paths = CODE_STAMP_PATHS) {
  const hash = createHash("sha256");
  for (const rel of codeStampFiles(repoRoot, paths)) {
    hash.update(rel);
    hash.update("\0");
    try { hash.update(readFileSync(path.join(repoRoot, rel))); } catch { hash.update("<unreadable>"); }
    hash.update("\0");
  }
  return `${gitHead(repoRoot)}:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Poll-boundary reload detection. `check(inFlight)` is called by the claim
 * loop *between* claims and returns one of:
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
    check(inFlight = null) {
      if (!pending) {
        const at = now();
        if (at - lastCheck < intervalMs) return { action: "none", from, to: from };
        lastCheck = at;
        const to = stamp();
        if (to === from) return { action: "none", from, to };
        pending = to;
      }
      if (inFlight) {
        const first = !deferredSeen;
        deferredSeen = true;
        return { action: "deferred", from, to: pending, runId: inFlight, first };
      }
      return { action: "reload", from, to: pending };
    },
  };
}

const linearCli = () => path.join(FACTORY_ROOT, "tools", "linear.mjs");

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
    if (!(cur.labels?.nodes ?? []).some((l) => l.name === "ai:in-progress")) return false;

    runLinearCli(["state", ticket, "Todo", "--unassign", "--remove", "ai:in-progress"]);
    const body = `Dispatch run failed, claim released back to Todo.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedir(), "~")}\`` : ""}`;
    runLinearCli(["comment", ticket, body]);
    return true;
  } catch {
    return false;
  }
}

const BASELINE_COMMENT_MARKER = "wm:baseline:red:";

function baselineFailureSignature({ why, log = null, baseline = null }) {
  return createHash("sha256")
    .update(JSON.stringify({
      why,
      log,
      baseline: baseline && typeof baseline === "object"
        ? { check: baseline.check, exitCode: baseline.exitCode, output: baseline.output }
        : null,
    }))
    .digest("hex");
}

function hasRecordedBaselineFailureComment(ticket, signature) {
  const marker = `${BASELINE_COMMENT_MARKER}${signature}`;
  try {
    const out = runLinearCli(["comments", ticket, "--json"]);
    const comments = JSON.parse(out);
    return (comments ?? []).some((row) => String(row.body ?? "").includes(marker));
  } catch {
    return false;
  }
}

function defaultBlockBaselineTicket({ repo, ticket, why, log = null, baseline = null, fetchTicket }) {
  try {
    let cur = null;
    if (typeof fetchTicket === "function") {
      cur = fetchTicket(ticket);
    } else {
      const out = runLinearCli(["get", ticket, "--json"]);
      cur = JSON.parse(out);
    }
    if (!cur || cur.state?.name !== "In Progress") return false;
    if (!(cur.labels?.nodes ?? []).some((l) => l.name === "ai:in-progress")) return false;

    const signature = baselineFailureSignature({ why, log, baseline });
    runLinearCli(["state", ticket, "Blocked", "--unassign", "--add", "ai:blocked", "--remove", "ai:in-progress"]);

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
export async function executeClaimed(db, registry, adapters, claim, {
  workspacesRoot, artifactStore = artifactsRoot(), now = () => Date.now(), policyVersion = "unknown", adapterOverride, env = {},
  dispatch,
} = {}) {
  const { runId, attempt, fencingToken, spec } = claim;
  const owner = db
    .query(`SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`)
    .get(runId, attempt)?.lease_owner ?? "worker";
  const retain = spec.workspace?.retainOnFailure === true;
  let workspaceDir = null;
  let checkoutPath = null;
  let checkoutBaseline = null;
  let worktreeRecord = null;
  const repoName = spec.input?.repoPin?.repo ?? spec.input?.repo ?? null;
  const ticketId = spec.input?.ticket ?? null;
  const isWorktree = spec.workspace?.type === "worktree";

  let leaseHeartbeat = null;
  let ticketClaimed = false;
  let attemptUsage = { adapter: adapterOverride ?? spec.adapter };

  let dispatchOpts = dispatch;
  if (!dispatchOpts && process.env.FACTORY_EVENT_HOME && !process.env.LINEAR_API_KEY) {
    dispatchOpts = {
      fetchTicket: () => ({
        identifier: ticketId,
        state: { name: "Todo" },
        assignee: null,
        labels: { nodes: [{ name: "ai:agent-ready" }] },
      }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
    };
  }

  const locksDir = dispatchOpts?.locksDir ?? defaultLocksDir();
  const leasesDir = dispatchOpts?.leasesDir ?? leaseDir();
  const lockFile = repoName ? dispatchLockPath(repoName, locksDir) : null;
  const isAliveFn = dispatchOpts?.isAlive ?? defaultIsAlive;
  const claimTicketFn = dispatchOpts?.claimTicket ?? (dispatchOpts?.fetchTicket ? (() => ({ ok: true })) : defaultClaimTicket);
  const unclaimTicketFn = dispatchOpts?.unclaimTicket ?? ((args) => defaultUnclaimTicket({ ...args, fetchTicket: dispatchOpts?.fetchTicket }));
  const blockTicketFn = dispatchOpts?.blockBaselineTicket ?? ((args) => defaultBlockBaselineTicket({ ...args, fetchTicket: dispatchOpts?.fetchTicket }));

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

  /** Terminal failure-shaped write: classify, finalize, and budget any retry atomically. */
  const failTerminal = (to, journalReason, reasonCode) =>
    txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
        return { fenced: true };
      }
      const expectFrom = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId)?.state;
      transition(db, {
        runId, to, expectFrom,
        actor: owner, reason: typedFailureReason(reasonCode, journalReason), attempt, policyVersion, now: currentNow,
      });
      finishAttempt(db, runId, attempt, to, reasonCode, currentNow, attemptUsage);
      const decision = retryDecision(db, runId, spec, reasonCode);
      if (decision.retry) {
        transition(db, {
          runId, to: "QUEUED", expectFrom: "FAILED",
          actor: owner, reason: `retry:${decision.cause}`, attempt, policyVersion, now: nowFn(),
        });
      }
      return { ok: true, cause: decision.cause, requeued: decision.retry };
    });

  let def = null;
  try {
    def = getAgent(registry, spec.agent);
  } catch {}

  const refuseTerminal = (reasonCode, checks = ["dispatch_gate"], { causeTyped = false } = {}) =>
    txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
        return { fenced: true };
      }
      const journalReason = causeTyped ? typedFailureReason(reasonCode) : reasonCode;
      transition(db, {
        runId, to: "VERIFYING", expectFrom: "RUNNING",
        actor: owner, reason: journalReason, attempt, policyVersion, now: currentNow,
      });
      transition(db, {
        runId, to: "REFUSED", expectFrom: "VERIFYING",
        actor: owner, reason: journalReason, attempt, policyVersion, now: currentNow,
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
        reasonCode,
        outputContract: spec.outputContract,
        verification: { status: "passed", checks },
        artifacts: [],
      };
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId, attempt, canonicalJson(result), "none", null,
        canonicalJson(result.verification), canonicalJson(receipt), iso(currentNow),
      );
      finishAttempt(db, runId, attempt, "REFUSED", reasonCode, currentNow, attemptUsage);
      return { ok: true, receipt };
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

    if (isWorktree && repoName && ticketId) {
      const lockAcquired = acquireClaimLock(lockFile, { pid: process.pid, now: nowFn(), isAlive: isAliveFn });
      if (!lockAcquired) {
        const res = refuseTerminal("claim_lock_busy", ["dispatch_claim_lock"]);
        if (res?.fenced) return { fenced: true };
        return { runId, attempt, terminalState: "REFUSED", reasonCode: "claim_lock_busy", receipt: res?.receipt };
      }

      let gateRefusal = null;
      try {
        gateRefusal = worktreeDispatchGate(spec.input, dispatchOpts);
      } catch (err) {
        releaseClaimLock(lockFile);
        throw err;
      }

      if (gateRefusal) {
        releaseClaimLock(lockFile);
        const res = refuseTerminal(gateRefusal.reason, ["dispatch_gate"]);
        if (res?.fenced) return { fenced: true };
        return { runId, attempt, terminalState: "REFUSED", reasonCode: gateRefusal.reason, receipt: res?.receipt };
      }

      let claimRes;
      try {
        claimRes = await claimTicketFn({ repo: repoName, ticket: ticketId, harness: spec.adapter ?? "claude" });
      } finally {
        releaseClaimLock(lockFile);
      }

      if (!claimRes?.ok) {
        const reasonCode = claimRes?.reasonCode || "ticket_claim_lost";
        const res = refuseTerminal(reasonCode, ["dispatch_claim"]);
        if (res?.fenced) return { fenced: true };
        return { runId, attempt, terminalState: "REFUSED", reasonCode, receipt: res?.receipt };
      }

      ticketClaimed = true;
      writeWorkerLease({ repo: repoName, ticket: ticketId, owner, pid: process.pid, dir: leasesDir, now: nowFn() });
      leaseHeartbeat = setInterval(() => {
        try {
          renewWorkerLease({ repo: repoName, ticket: ticketId, owner, dir: leasesDir, now: Date.now() });
        } catch {}
      }, LEASE_HEARTBEAT_MS);
      leaseHeartbeat?.unref?.();
    }

    const created = createWorkspace({
      root: workspacesRoot, runId, attempt, input: spec.input, workspace: spec.workspace,
      artifactStore,
    });
    workspaceDir = created.dir;
    checkoutPath = created.checkout?.path ?? null;
    checkoutBaseline = checkoutPath ? repositoryStatus(checkoutPath) : null;
    worktreeRecord = created.worktree ?? null;
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
    if (!def) def = getAgent(registry, spec.agent);

    if (!verifyDefHash(spec, def)) {
      const refusedRes = refuseTerminal("agent_definition_mismatch", ["def_hash_mismatch"], { causeTyped: true });
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

    const onUsage = (usage) => {
      attemptUsage = { adapter: adapterKey, ...(usage ?? {}) };
    };
    let outcome;
    try {
      outcome = await adapter.execute({
        spec, def, workspaceDir, timeoutMs: spec.timeoutSeconds * 1000, env, onTrace, onUsage,
        abortSignal: abortController.signal, signal: abortController.signal,
      });
    } finally {
      clearInterval(cancelPoll);
      ACTIVE_EXECUTIONS.delete(runId);
    }

    if (outcome?.usage) attemptUsage = { adapter: adapterKey, ...outcome.usage };

    if (abortController.signal.aborted) {
      if (ticketClaimed) {
        try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: "cancelled", log: null }); } catch {}
      }
      if (workspaceDir) destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
          return { fenced: true };
        }
        try {
          finishAttempt(db, runId, attempt, "CANCELLED", "cancelled", currentNow, attemptUsage);
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
      if (ticketClaimed) {
        try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: "timeout", log: null }); } catch {}
      }
      const res = failTerminal("TIMED_OUT", "timeout", "timeout");
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "TIMED_OUT", reasonCode: "timeout" };
    }
    const denial = policyDenials[0];
    if (denial) {
      if (ticketClaimed) {
        try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: `policy_denied:${denial.tool}`, log: null }); } catch {}
      }
      const reasonCode = `policy_denied:${denial.tool}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }
    if (exitCode !== 0) {
      if (ticketClaimed) {
        try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: `agent_exit_${exitCode}`, log: null }); } catch {}
      }
      const reasonCode = `agent_exit_${exitCode}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    // The settings policy is preventative; this is the independent, durable
    // check before a repository-read run's output can be accepted or emitted.
    // Mutating worktree workspaces are exempt.
    if (!isWorktree && !def.mutating && checkoutPath && (checkoutBaseline === null || repositoryStatus(checkoutPath) !== checkoutBaseline)) {
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
      verified = verifyResult({
        spec, def, registry, workspaceDir, attempt, extraArtifacts: RUNTIME_ARTIFACTS, worktreeRecord,
      });
    } catch (err) {
      if (!(err instanceof ContractViolation)) throw err;
      const reasonCode = err.reasonCode === "baseline_red" ? "baseline_red" : "contract_violation";
      const failureReason = `${reasonCode}: ${err.violations.join(", ")}`;
      if (ticketClaimed) {
        if (reasonCode === "baseline_red") {
          try {
            blockTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              log: null,
              baseline: worktreeRecord?.baseline,
            });
          } catch {}
        } else {
          try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: failureReason, log: null }); } catch {}
        }
      }
      // Invalid output is a typed contract failure and emits no completion
      // event (§15) — no results row, no outbox row. A matching pre-existing
      // red baseline is equally non-admissible, but is named separately and
      // not retried as though the agent caused an ordinary contract failure.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, { runId, attempt, actor: owner, policyVersion, now: currentNow });
          return { fenced: true };
        }
        transition(db, {
          runId, to: "FAILED", expectFrom: "VERIFYING",
          actor: owner, reason: typedFailureReason(reasonCode, failureReason),
          attempt, policyVersion, now: currentNow,
        });
        finishAttempt(db, runId, attempt, "FAILED", reasonCode, currentNow, attemptUsage);
        const decision = retryDecision(db, runId, spec, reasonCode);
        if (decision.retry) {
          transition(db, {
            runId, to: "QUEUED", expectFrom: "FAILED",
            actor: owner, reason: `retry:${decision.cause}`, attempt, policyVersion, now: nowFn(),
          });
        }
        return { ok: true };
      });
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    if (verified.kind === "refused") {
      if (ticketClaimed) {
        try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: `refused: ${verified.reasonCode}`, log: null }); } catch {}
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
        finishAttempt(db, runId, attempt, "REFUSED", verified.reasonCode, currentNow, attemptUsage);
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
      finishAttempt(db, runId, attempt, "COMPLETED", "ok", currentNow, attemptUsage);
      return { receipt };
    });

    if (published.fenced) {
      destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
      return { fenced: true };
    }
    destroyWorkspace(workspaceDir, { checkout: checkoutPath, repoName });
    return { runId, attempt, terminalState: "COMPLETED", reasonCode: "ok", receipt: published.receipt };
  } catch (err) {
    if (ticketClaimed) {
      try { unclaimTicketFn({ repo: repoName, ticket: ticketId, why: err?.message ?? String(err), log: null }); } catch {}
    }
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
    const isWorkspaceProvisioning = err?.code === "workspace_provisioning_error";
    const reasonCode = isCliNotFound
      ? "cli_not_found"
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
    if (workspaceDir) {
      destroyWorkspace(workspaceDir, { retain, checkout: checkoutPath, repoName });
    }
    if (res?.fenced) return { fenced: true };
    return { runId, attempt, terminalState: "FAILED", reasonCode, error: err?.message };
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (ticketClaimed) {
      try { releaseWorkerLease({ repo: repoName, ticket: ticketId, owner, dir: leasesDir }); } catch {}
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
  { now = () => Date.now(), policyVersion = "unknown", actor = "operator" } = {},
) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const worker = db.query(`SELECT state, current_run, last_seen FROM workers WHERE worker_id = ?`).get(workerId);
    if (!worker) throw new Error(`unknown worker ${workerId}`);
    const stale = worker.state !== "stopped" && currentNow - Date.parse(worker.last_seen) > HEARTBEAT_STALE_MS;
    if (!stale || !worker.current_run) throw new Error(`worker ${workerId} is not stalled with an active run`);
    if (runId && worker.current_run !== runId) {
      throw new Error(`worker ${workerId} holds ${worker.current_run}, not ${runId}`);
    }

    const heldRunId = worker.current_run;
    const run = db.query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`).get(heldRunId);
    if (!run) throw new Error(`worker ${workerId} references unknown run ${heldRunId}`);
    if (!["LEASED", "RUNNING", "VERIFYING"].includes(run.state)) {
      throw new Error(`run ${heldRunId} is ${run.state}, not actively leased`);
    }
    const attempt = db
      .query(`SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`)
      .get(heldRunId, run.attempts);
    if (!attempt) throw new Error(`run ${heldRunId} has no current attempt`);
    if (attempt.lease_owner && attempt.lease_owner !== workerId) {
      throw new Error(`run ${heldRunId} is leased by ${attempt.lease_owner}, not ${workerId}`);
    }

    const spec = JSON.parse(run.spec_json);
    const reason = "operator_release_stalled_worker";
    db.query(`UPDATE attempts SET lease_expires_at = ? WHERE run_id = ? AND attempt = ?`)
      .run(iso(currentNow - 1), heldRunId, run.attempts);
    if (run.attempts < spec.maxAttempts) {
      if (run.state === "VERIFYING") {
        transition(db, {
          runId: heldRunId, to: "FAILED", actor, reason,
          attempt: run.attempts, policyVersion, now: currentNow,
        });
        transition(db, {
          runId: heldRunId, to: "QUEUED", actor, reason: "retry_after_stalled_worker_release",
          attempt: run.attempts, policyVersion, now: currentNow,
        });
      } else {
        transition(db, {
          runId: heldRunId, to: "QUEUED", actor, reason,
          attempt: run.attempts, policyVersion, now: currentNow,
        });
      }
    } else {
      if (run.state === "LEASED") {
        transition(db, {
          runId: heldRunId, to: "RUNNING", actor, reason,
          attempt: run.attempts, policyVersion, now: currentNow,
        });
      }
      transition(db, {
        runId: heldRunId, to: "FAILED", actor, reason,
        attempt: run.attempts, policyVersion, now: currentNow,
      });
      finishAttempt(db, heldRunId, run.attempts, "FAILED", "stalled_worker_released", currentNow);
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
      const failureReason = typedFailureReason("lease_expired");

      // VERIFYING cannot transition directly to QUEUED; record its failure first.
      if (row.state === "VERIFYING") {
        transition(db, {
          runId: row.run_id, to: "FAILED",
          actor: "reaper", reason: failureReason, attempt: row.attempts, policyVersion, now: currentNow,
        });
      }
      finishAttempt(db, row.run_id, row.attempts, "FAILED", "lease_expired", currentNow);
      const decision = retryDecision(db, row.run_id, spec, "lease_expired");

      if (decision.retry) {
        transition(db, {
          runId: row.run_id, to: "QUEUED",
          actor: "reaper", reason: `retry:${decision.cause}`, attempt: row.attempts, policyVersion, now: currentNow,
        });
        continue;
      }

      // LEASED has no direct FAILED edge; advance through RUNNING only when
      // the environment retry ceiling is exhausted and the run must terminate.
      if (row.state === "LEASED") {
        transition(db, {
          runId: row.run_id, to: "RUNNING",
          actor: "reaper", reason: failureReason, attempt: row.attempts, policyVersion, now: currentNow,
        });
      }
      if (row.state !== "VERIFYING") {
        transition(db, {
          runId: row.run_id, to: "FAILED",
          actor: "reaper", reason: failureReason, attempt: row.attempts, policyVersion, now: currentNow,
        });
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
 * Operator retry (§13): FAILED → QUEUED, or recovery from VERIFYING. Only
 * agent-caused failures spend maxAttempts; environment attempts remain retryable.
 * Retrying past the agent budget requires the explicit force override.
 */
export function retryRun(db, runId, { actor, force = false, now = () => Date.now(), policyVersion } = {}) {
  const currentNow = resolveNow(now);
  const row = db.query(`SELECT state, spec_json, attempts FROM runs WHERE run_id = ?`).get(runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  const spec = JSON.parse(row.spec_json);
  if (!force && (failureCount(db, runId, "agent_error") >= spec.maxAttempts || failureCount(db, runId, "fatal") > 0)) {
    throw new Error("attempts_exhausted");
  }
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

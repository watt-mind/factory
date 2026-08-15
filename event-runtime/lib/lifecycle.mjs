/**
 * Closed run lifecycle (docs/event-runtime.md §8).
 *
 * Every state change goes through transition(), which enforces the legal-move
 * table and appends an audited record to the journal in the same transaction
 * that updates the run row. Illegal transitions are rejected, never repaired.
 */
import { hashJson } from "./canonical.mjs";
import { tx, txImmediate } from "./db.mjs";

export const STATES = [
  "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING",
  "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
];

/** Terminal for the run. FAILED may still be re-queued while attempts remain. */
export const TERMINAL_STATES = new Set(["COMPLETED", "REFUSED", "TIMED_OUT", "CANCELLED"]);

const LEGAL = {
  PROPOSED: ["APPROVED", "CANCELLED"],
  APPROVED: ["QUEUED", "CANCELLED"],
  QUEUED: ["LEASED", "CANCELLED"],
  LEASED: ["RUNNING", "QUEUED", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "TIMED_OUT", "QUEUED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "REFUSED", "FAILED"],
  FAILED: ["QUEUED"],
  COMPLETED: [],
  REFUSED: [],
  TIMED_OUT: [],
  CANCELLED: [],
};

export class IllegalTransition extends Error {
  constructor(runId, from, to) {
    super(`illegal transition ${from ?? "(none)"} → ${to} for ${runId}`);
    this.name = "IllegalTransition";
    this.runId = runId;
    this.from = from;
    this.to = to;
  }
}

function appendJournal(db, record) {
  const record_hash = hashJson(record);
  db.query(
    `INSERT INTO lifecycle_events
       (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.runId, record.from, record.to, record.actor, record.reason ?? null,
    record.attempt ?? null, record.correlationId ?? null, record.causationId ?? null,
    record.policyVersion ?? null, record.at, record_hash,
  );
}

function resolveNow(now) {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

/**
 * Create a run in PROPOSED with its immutable spec. The idempotency key's
 * UNIQUE constraint is the §5.4 guarantee — a duplicate plan throws here and
 * the caller resolves to the existing run.
 */
export function createRun(db, { runId, idempotencyKey, spec, specJson, specHash, actor, correlationId, causationId, policyVersion, now = () => Date.now() }) {
  const at = new Date(resolveNow(now)).toISOString();
  return txImmediate(db, () => {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PROPOSED', 0, ?, ?)`,
    ).run(runId, idempotencyKey, specJson, specHash, at, at);
    appendJournal(db, {
      runId, from: null, to: "PROPOSED", actor,
      reason: "planned", correlationId, causationId, policyVersion, at,
    });
    return { runId, state: "PROPOSED" };
  });
}

/**
 * Move a run to `to`, enforcing legality against its current state. Pass
 * `expectFrom` when the caller must not race another mover (worker vs
 * operator): the transition then only applies if the state is still that one.
 */
export function transition(db, { runId, to, expectFrom, actor, reason, attempt, correlationId, causationId, policyVersion, now = () => Date.now() }) {
  const at = new Date(resolveNow(now)).toISOString();
  return txImmediate(db, () => {
    const run = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId);
    if (!run) throw new IllegalTransition(runId, undefined, to);
    const from = run.state;
    if (expectFrom && from !== expectFrom) throw new IllegalTransition(runId, from, to);
    if (!(LEGAL[from] ?? []).includes(to)) throw new IllegalTransition(runId, from, to);
    db.query(`UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?`).run(to, at, runId);
    appendJournal(db, { runId, from, to, actor, reason, attempt, correlationId, causationId, policyVersion, at });
    return { runId, from, to };
  });
}

export function runState(db, runId) {
  return db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId)?.state;
}

export function lifecycleOf(db, runId) {
  return db.query(`SELECT * FROM lifecycle_events WHERE run_id = ? ORDER BY seq`).all(runId);
}

const IDEMPOTENCY_TRIGGER_MARKER = ":trigger:";

function idempotencyFamily(db, idempotencyKey) {
  return db.query(
    `SELECT run_id, idempotency_key, state, created_at, rowid
       FROM runs
      WHERE idempotency_key = ?
         OR instr(idempotency_key, ? || ?) = 1
      ORDER BY CASE WHEN state IN ('COMPLETED', 'REFUSED', 'TIMED_OUT', 'CANCELLED') THEN 1 ELSE 0 END,
               created_at DESC, rowid DESC`,
  ).all(idempotencyKey, idempotencyKey, IDEMPOTENCY_TRIGGER_MARKER);
}

/**
 * Produce the concrete UNIQUE key for a new run in an idempotency family.
 * The first generation keeps the declared key. Later generations add the
 * triggering event identity, allowing a fresh run after the prior generation
 * is terminal without weakening the schema's per-run UNIQUE guarantee.
 */
export function idempotencyKeyForNewRun(db, { idempotencyKey, source, eventId }) {
  if (idempotencyFamily(db, idempotencyKey).length === 0) return idempotencyKey;
  return `${idempotencyKey}${IDEMPOTENCY_TRIGGER_MARKER}${hashJson({ source, eventId })}`;
}

/**
 * Resolve an existing run for an idempotency family and event context (§5.4).
 * Any non-terminal generation coalesces repeat triggers into that run. Once
 * every generation is terminal, only a redelivery of the same correlation /
 * causation resolves to the terminal run; a distinct trigger returns null so
 * the planner can create a new generation with its own concrete UNIQUE key.
 */
export function resolveIdempotency(db, { idempotencyKey, correlationId, causationId, eventId } = {}) {
  if (!idempotencyKey) return null;
  const family = idempotencyFamily(db, idempotencyKey);
  if (family.length === 0) return null;

  const active = family.find((run) => !TERMINAL_STATES.has(run.state));
  if (active) return active;

  const run = family[0];
  const correlation = correlationId ?? eventId ?? null;
  if (!correlation && !causationId) return run;

  const journal = db
    .query(`SELECT correlation_id, causation_id FROM lifecycle_events WHERE run_id = ? AND from_state IS NULL LIMIT 1`)
    .get(run.run_id);
  if (!journal) return run;

  if (correlation && journal.correlation_id !== correlation) return null;
  if (causationId && journal.causation_id !== causationId) return null;
  return run;
}

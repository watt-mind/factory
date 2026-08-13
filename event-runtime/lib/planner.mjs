/**
 * Deterministic planner (docs/event-runtime.md §4, §5.2, §5.4, §13).
 *
 * Everything here is code, not model: an admitted event maps to exactly one
 * registered agent, its payload is schema-checked, and the run's idempotency
 * key is derived from declared scope fields so the same fact can never spawn
 * two runs. Planning is idempotent — re-planning an already-planned event
 * returns the recorded outcome — and a poison event that keeps throwing is
 * dead-lettered instead of wedging the sweep or silently vanishing.
 */
import { canonicalJson, hashJson } from "./canonical.mjs";
import { DEAD_LETTER_AFTER, DEFAULT_PROPOSAL_TTL_SECONDS } from "./config.mjs";
import { tx } from "./db.mjs";
import { newProposalId, newRunId } from "./ids.mjs";
import { createRun } from "./lifecycle.mjs";
import { getAgent, getEventType } from "./registry.mjs";
import { pinRepo } from "./repository.mjs";
import { validate } from "./schema.mjs";

/**
 * §5.4 idempotency key: agent ref, output contract, then the event type's
 * declared scope fields in declared order. Unknown scope fields fail closed —
 * a typo in a mapping must not silently widen or narrow dedup.
 */
export function idempotencyKeyFor(mapping, def, envelope, inputHash) {
  const parts = mapping.idempotencyScope.map((field) => {
    switch (field) {
      case "correlationId":
        return envelope.correlationId ?? envelope.eventId;
      case "subject":
        return envelope.subject ?? "";
      case "inputHash":
        return inputHash;
      default:
        throw new Error(`unknown idempotency scope field "${field}" (docs/event-runtime.md §5.4 — fail closed)`);
    }
  });
  return `${def.ref}:${def.output_contract}:${parts.join(":")}`;
}

/**
 * Pure assembly of the §5.2 RunSpec from a registered mapping. No I/O, no
 * clock reads beyond the injected `now` — same inputs, same spec, always.
 */
export function buildRunSpec(registry, envelope, mapping, { runId, policyVersion, adapterOverride, now = Date.now() } = {}) {
  const def = getAgent(registry, mapping.agent);
  const inputHash = hashJson(envelope.payload);
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: mapping.agent,
    input: envelope.payload,
    inputHash,
    workspace: def.workspace,
    adapter: adapterOverride ?? mapping.adapter,
    promptVersion: policyVersion,
    policyVersion,
    outputContract: def.output_contract,
    capabilities: def.capabilities.services,
    timeoutSeconds: def.limits.timeout_seconds,
    maxAttempts: def.limits.attempts,
    idempotencyKey: idempotencyKeyFor(mapping, def, envelope, inputHash),
  };
}

function insertProposal(db, { id, event, runId = null, decision, specJson = null, specHash = null, idempotencyKey = null, status, reason = null, at, ttlSeconds }) {
  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
        idempotency_key, status, reason, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, event.source, event.event_id, runId, decision, specJson, specHash, idempotencyKey, status, reason, at, ttlSeconds);
  return db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
}

function setEventStatus(db, event, status) {
  db.query(`UPDATE events SET status = ? WHERE source = ? AND event_id = ?`).run(status, event.source, event.event_id);
}

function humanNeeded(db, event, reason, at, ttlSeconds) {
  const proposal = insertProposal(db, {
    id: newProposalId(), event, decision: "human_needed", status: "open", reason, at, ttlSeconds,
  });
  setEventStatus(db, event, "human_needed");
  return { decision: "human_needed", proposal, reason };
}

/** Idempotent path: the event was already planned — report what was decided. */
function existingOutcome(db, event) {
  const proposal = db
    .query(`SELECT * FROM proposals WHERE event_source = ? AND event_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(event.source, event.event_id);
  if (!proposal) return { decision: event.status, reason: event.last_plan_error ?? undefined };
  return {
    decision: proposal.decision,
    proposal,
    runId: proposal.run_id ?? undefined,
    reason: proposal.reason ?? undefined,
  };
}

/**
 * Plan one admitted event: NOOP | HUMAN_NEEDED | RUN (§4). All writes for one
 * plan happen in one transaction; re-planning is idempotent.
 *
 * @returns {{ decision: string, proposal?: object, runId?: string, reason?: string }}
 */
export function planEvent(db, registry, { source, eventId }, { now = Date.now(), policyVersion = "unknown", adapterOverride } = {}) {
  return tx(db, () => {
    const event = db.query(`SELECT * FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (!event) throw new Error(`no admitted event (${source}, ${eventId})`);
    if (event.status !== "admitted") return existingOutcome(db, event);

    const envelope = JSON.parse(event.envelope_json);
    const at = new Date(now).toISOString();

    const mapping = getEventType(registry, envelope.type);
    if (!mapping) return humanNeeded(db, event, "unregistered_event_type", at, DEFAULT_PROPOSAL_TTL_SECONDS);
    const ttlSeconds = mapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;

    const def = getAgent(registry, mapping.agent);
    const input = validate(def.inputSchema, envelope.payload);
    if (!input.valid) return humanNeeded(db, event, `invalid_input: ${input.errors[0]}`, at, ttlSeconds);

    // §7 tier 1 (OPS-228): a repository workspace resolves its ref to an
    // immutable SHA *now*, so the pin is inside the spec's input (and its
    // inputHash, and the receipt). A run therefore names the exact tree it
    // read, and dedup distinguishes "same repo, new commit".
    let payload = envelope.payload;
    if (def.workspace?.type === "repository") {
      try {
        payload = { ...payload, repoPin: pinRepo(payload.repo, payload.ref ?? undefined) };
      } catch (err) {
        return humanNeeded(db, event, `repo_pin_failed: ${err.message}`, at, ttlSeconds);
      }
    }

    const pinnedEnvelope = payload === envelope.payload ? envelope : { ...envelope, payload };
    const idempotencyKey = idempotencyKeyFor(mapping, def, pinnedEnvelope, hashJson(payload));
    const existingRun = db.query(`SELECT run_id FROM runs WHERE idempotency_key = ?`).get(idempotencyKey);
    if (existingRun) {
      const proposal = insertProposal(db, {
        id: newProposalId(), event, runId: existingRun.run_id, decision: "noop",
        idempotencyKey, status: "resolved", reason: "duplicate_run", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, runId: existingRun.run_id, reason: "duplicate_run" };
    }

    const runId = newRunId();
    const spec = buildRunSpec(registry, pinnedEnvelope, mapping, { runId, policyVersion, adapterOverride, now });
    const specJson = canonicalJson(spec);
    const specHash = hashJson(spec);
    createRun(db, {
      runId, idempotencyKey, spec, specJson, specHash,
      actor: "planner",
      correlationId: envelope.correlationId ?? null,
      causationId: envelope.causationId ?? null,
      policyVersion, now,
    });
    const proposal = insertProposal(db, {
      id: newProposalId(), event, runId, decision: "run",
      specJson, specHash, idempotencyKey, status: "open", at, ttlSeconds,
    });
    setEventStatus(db, event, "planned");
    return { decision: "run", proposal, runId };
  });
}

/**
 * Operator recovery for parked events (§13): put a dead-lettered or
 * human_needed event back through planning after the underlying problem is
 * fixed (event type registered, planner bug shipped, …). Any open
 * human_needed proposal for it is superseded so the inbox does not show a
 * stale ask next to a fresh plan.
 */
export function requeueEvent(db, { source, eventId }, { actor = "operator", now = Date.now() } = {}) {
  return tx(db, () => {
    const event = db.query(`SELECT status FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (!event) throw new Error(`unknown event (${source}, ${eventId})`);
    if (!["dead_lettered", "human_needed"].includes(event.status)) {
      throw new Error(`requeue applies to dead_lettered or human_needed events, not ${event.status}`);
    }
    db.query(
      `UPDATE proposals SET status = 'superseded', decided_at = ?, decided_by = ?, reason = 'requeued'
       WHERE event_source = ? AND event_id = ? AND status = 'open'`,
    ).run(new Date(now).toISOString(), actor, source, eventId);
    db.query(
      `UPDATE events SET status = 'admitted', plan_failures = 0, last_plan_error = NULL
       WHERE source = ? AND event_id = ?`,
    ).run(source, eventId);
    return { requeued: true };
  });
}

/**
 * Sweep every 'admitted' event through planEvent. A plan that throws rolls
 * back, increments the event's failure count, and — after DEAD_LETTER_AFTER
 * consecutive failures — parks the event as dead-lettered with its last error
 * (§13), leaving it visible in status and eligible for replay after a fix.
 *
 * @returns {{ planned: number, failed: number, deadLettered: number }}
 */
export function planAdmittedEvents(db, registry, opts = {}) {
  const rows = db.query(`SELECT source, event_id FROM events WHERE status = 'admitted' ORDER BY admitted_at, rowid`).all();
  let planned = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const { source, event_id: eventId } of rows) {
    try {
      planEvent(db, registry, { source, eventId }, opts);
      planned += 1;
    } catch (err) {
      failed += 1;
      const message = String(err?.message ?? err);
      const failures = tx(db, () => {
        db.query(
          `UPDATE events SET plan_failures = plan_failures + 1, last_plan_error = ? WHERE source = ? AND event_id = ?`,
        ).run(message, source, eventId);
        const row = db.query(`SELECT plan_failures FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
        if (row.plan_failures >= DEAD_LETTER_AFTER) {
          db.query(`UPDATE events SET status = 'dead_lettered' WHERE source = ? AND event_id = ?`).run(source, eventId);
        }
        return row.plan_failures;
      });
      if (failures >= DEAD_LETTER_AFTER) deadLettered += 1;
    }
  }
  return { planned, failed, deadLettered };
}

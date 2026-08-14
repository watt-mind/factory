/**
 * Watched approval surface (docs/event-runtime.md §12).
 *
 * The operator approves a specific immutable spec, not a summary of one — and
 * a proposal that sat past its TTL is never executed as-is. Approval after
 * expiry re-plans against current state: an identical fresh spec runs, a
 * different one supersedes the stale proposal with a new open one. Stale
 * intent can therefore never execute silently, which is the §15 exit
 * criterion this module owns.
 */
import { canonicalJson, hashJson } from "./canonical.mjs";
import { DEFAULT_PROPOSAL_TTL_SECONDS } from "./config.mjs";
import { tx } from "./db.mjs";
import { newProposalId } from "./ids.mjs";
import { runState, transition } from "./lifecycle.mjs";
import { buildRunSpec } from "./planner.mjs";
import { getEventType } from "./registry.mjs";

/**
 * The one human actor in the MVP (lib/api.mjs §14). An event type flagged
 * `humanApprovalOnly` (docs/event-runtime-dispatch.md §7, WM-111) accepts an
 * approval from this actor and no other — the ship chain's deploy-branch
 * decision is permanently the human's, and the earned-automation ratchet must
 * not be able to consume it.
 */
const HUMAN_ACTOR = "operator";

function isExpired(proposal, now) {
  return now - Date.parse(proposal.created_at) > proposal.ttl_seconds * 1000;
}

function withSpec(row) {
  return { ...row, spec: row.spec_json ? JSON.parse(row.spec_json) : null };
}

/** Open proposals, oldest first, annotated with `expired` and parsed `spec`. */
export function openProposals(db, { now = Date.now() } = {}) {
  return db
    .query(`SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at, rowid`)
    .all()
    .map((row) => ({ ...withSpec(row), expired: isExpired(row, now) }));
}

/**
 * Runs with two or more open proposals. The planner never creates this — it
 * is a defensive invariant, surfaced on the doctor view if it ever happens.
 */
export function ambiguousOpenProposalRuns(db) {
  return db
    .query(
      `SELECT run_id AS runId, COUNT(*) AS n
       FROM proposals
       WHERE status = 'open' AND run_id IS NOT NULL
       GROUP BY run_id
       HAVING n > 1
       ORDER BY run_id`,
    )
    .all()
    .map((row) => ({ runId: row.runId, count: row.n }));
}

export function getProposal(db, id) {
  const row = db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
  return row ? withSpec(row) : null;
}

function loadEnvelope(db, proposal) {
  const event = db
    .query(`SELECT envelope_json FROM events WHERE source = ? AND event_id = ?`)
    .get(proposal.event_source, proposal.event_id);
  if (!event) throw new Error(`proposal ${proposal.id} references missing event (${proposal.event_source}, ${proposal.event_id})`);
  return JSON.parse(event.envelope_json);
}

function approveRun(db, proposal, envelope, { actor, now, policyVersion, reason }) {
  const at = new Date(now).toISOString();
  const common = {
    runId: proposal.run_id,
    actor,
    reason,
    correlationId: envelope.correlationId ?? null,
    causationId: envelope.causationId ?? null,
    policyVersion,
    now,
  };
  transition(db, { ...common, to: "APPROVED", expectFrom: "PROPOSED" });
  transition(db, { ...common, to: "QUEUED", expectFrom: "APPROVED" });
  db.query(`UPDATE proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?`).run(at, actor, proposal.id);
  return { approved: true, runId: proposal.run_id };
}

/**
 * Approve an open 'run' proposal. Within TTL the recorded spec executes
 * as-is. After expiry the spec is rebuilt against current state under the
 * same runId: identical → approved (reason 'approved_after_ttl_replan');
 * different → the stale proposal is superseded, the still-PROPOSED run gets
 * the fresh spec, and a new open proposal is returned instead (§12).
 *
 * @returns {{ approved: true, runId: string }
 *         | { approved: false, replanned: true, proposal: object }}
 */
export function approveProposal(db, registry, id, { actor, now = Date.now(), policyVersion = "unknown", adapterOverride } = {}) {
  return tx(db, () => {
    const proposal = db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
    if (!proposal) throw new Error(`unknown proposal ${id}`);
    if (proposal.status !== "open") throw new Error(`proposal ${id} is '${proposal.status}', not open`);
    if (proposal.decision !== "run") throw new Error(`proposal ${id} decision is '${proposal.decision}' — only 'run' proposals are approvable`);

    const envelope = loadEnvelope(db, proposal);
    // Structural no-auto-approval (docs/event-runtime-dispatch.md §7, WM-111):
    // a humanApprovalOnly event type rejects every non-operator actor —
    // schedule auto-approval included — fail-closed, before any state moves.
    // This is the single choke point every approval path goes through
    // (operator API/CLI and autoApproveScheduled both call approveProposal),
    // so there is no code path that approves around it.
    const mapping = getEventType(registry, envelope.type);
    if (mapping?.humanApprovalOnly === true && actor !== HUMAN_ACTOR) {
      const err = new Error(
        `proposal ${id}: event type ${envelope.type} is humanApprovalOnly — actor "${actor}" cannot approve it; this watched approval IS the human deploy-branch decision (human_approval_only; docs/event-runtime-dispatch.md §7, WM-111)`,
      );
      err.code = "human_approval_only";
      throw err;
    }
    if (!isExpired(proposal, now)) {
      return approveRun(db, proposal, envelope, { actor, now, policyVersion, reason: "approved" });
    }

    // Expired: re-plan against current registry state, reusing the runId.
    if (!mapping) throw new Error(`proposal ${id} expired and event type ${envelope.type} is no longer registered`);
    const fresh = buildRunSpec(registry, envelope, mapping, {
      runId: proposal.run_id, policyVersion, adapterOverride, now,
    });
    const freshHash = hashJson(fresh);
    if (freshHash === proposal.spec_hash) {
      return approveRun(db, proposal, envelope, { actor, now, policyVersion, reason: "approved_after_ttl_replan" });
    }

    const state = runState(db, proposal.run_id);
    if (state !== "PROPOSED") throw new Error(`proposal ${id} expired but run ${proposal.run_id} is ${state}, not PROPOSED`);
    const at = new Date(now).toISOString();
    db.query(`UPDATE proposals SET status = 'superseded', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`)
      .run(at, actor, "superseded_by_ttl_replan", id);
    const freshJson = canonicalJson(fresh);
    db.query(`UPDATE runs SET spec_json = ?, spec_hash = ?, updated_at = ? WHERE run_id = ?`)
      .run(freshJson, freshHash, at, proposal.run_id);
    const newId = newProposalId();
    db.query(
      `INSERT INTO proposals
         (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
          idempotency_key, status, reason, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, ?, ?, 'open', 'replanned_after_ttl', ?, ?)`,
    ).run(
      newId, proposal.event_source, proposal.event_id, proposal.run_id,
      freshJson, freshHash, fresh.idempotencyKey, at,
      mapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS,
    );
    return { approved: false, replanned: true, proposal: getProposal(db, newId) };
  });
}

/**
 * Close the unique open proposal for a cancelled run (reason `run_cancelled`).
 *
 * Keyed on `run_id` + `status = 'open'`. Zero matches is a no-op — cancelling
 * a QUEUED/LEASED/RUNNING run whose proposal is already decided must still
 * succeed. Two or more open rows for the same run is ambiguous: leave them
 * all untouched rather than guess which one to close, and return `ambiguous`
 * so the caller can surface it (OPS-245). Caller must already hold the
 * transaction that performed the CANCELLED transition.
 *
 * @returns {{ closed: true, id: string }
 *         | { closed: false }
 *         | { closed: false, ambiguous: true, count: number }}
 */
export function closeOpenProposalForRun(db, runId, { actor, now = Date.now() } = {}) {
  const open = db
    .query(`SELECT id FROM proposals WHERE run_id = ? AND status = 'open'`)
    .all(runId);
  if (open.length === 0) return { closed: false };
  if (open.length > 1) return { closed: false, ambiguous: true, count: open.length };
  const at = new Date(now).toISOString();
  db.query(
    `UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`,
  ).run(at, actor, "run_cancelled", open[0].id);
  return { closed: true, id: open[0].id };
}

/**
 * Reject an open proposal. A run still sitting in PROPOSED is cancelled with
 * reason 'proposal_rejected' and the operator recorded as actor (§8).
 */
export function rejectProposal(db, id, { actor, reason, now = Date.now(), policyVersion = "unknown" } = {}) {
  return tx(db, () => {
    const proposal = db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
    if (!proposal) throw new Error(`unknown proposal ${id}`);
    if (proposal.status !== "open") throw new Error(`proposal ${id} is '${proposal.status}', not open`);
    const at = new Date(now).toISOString();
    db.query(`UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`)
      .run(at, actor, reason ?? proposal.reason, id);
    if (proposal.run_id && runState(db, proposal.run_id) === "PROPOSED") {
      transition(db, {
        runId: proposal.run_id, to: "CANCELLED", expectFrom: "PROPOSED",
        actor, reason: "proposal_rejected", policyVersion, now,
      });
    }
    return { rejected: true, runId: proposal.run_id ?? undefined };
  });
}

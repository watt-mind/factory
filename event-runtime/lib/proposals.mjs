/**
 * Watched approval surface (docs/event-runtime.md §12).
 *
 * The operator approves a specific immutable spec, not a summary of one — and
 * a proposal that sat past its TTL is never executed as-is. Approval after
 * expiry re-plans against current state: an identical fresh spec runs, a
 * different one supersedes the stale proposal with a new open one. The
 * re-plan carries the stored approvalPolicy, modelTier, model,
 * configSnapshot (when present), and idempotencyKey, so expiry cannot shed
 * plan-time dispatch authorization, model routing, or a run generation key.
 * Stale intent can therefore never execute silently, which is the §15 exit
 * criterion this module owns.
 */
import { canonicalJson, hashJson } from "./canonical.mjs";
import { DEFAULT_PROPOSAL_TTL_SECONDS } from "./config.mjs";
import { txImmediate } from "./db.mjs";
import { newProposalId } from "./ids.mjs";
import { runState, transition } from "./lifecycle.mjs";
import { buildRunSpec } from "./planner.mjs";
import { getAgent, getEventType } from "./registry.mjs";
import { computeDefHash } from "./receipts.mjs";

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

/** A pin that can be compared. `"unknown"` is the no-registry sentinel, not a version. */
function isKnownPolicyVersion(value) {
  return typeof value === "string" && value !== "" && value !== "unknown";
}

function recordedSpecPinsVersion(spec) {
  return (
    spec != null &&
    (isKnownPolicyVersion(spec.promptVersion) ||
      isKnownPolicyVersion(spec.policyVersion))
  );
}

function withSpec(row) {
  return { ...row, spec: row.spec_json ? JSON.parse(row.spec_json) : null };
}

/** Open proposals, oldest first, annotated with `expired` and parsed `spec`. */
export function openProposals(db, { now = Date.now() } = {}) {
  return db
    .query(
      `SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at, rowid`,
    )
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
  if (!event)
    throw new Error(
      `proposal ${proposal.id} references missing event (${proposal.event_source}, ${proposal.event_id})`,
    );
  return JSON.parse(event.envelope_json);
}

/**
 * Plan-time-only values are not recoverable from the event envelope. Keep the
 * values recorded in the approved proposal when a replan rebuilds its spec.
 */
function ttlReplanOptions(spec) {
  return {
    approvalPolicy: spec.approvalPolicy ?? null,
    ...(Object.hasOwn(spec, "modelTier")
      ? { modelTierOverride: spec.modelTier }
      : {}),
    ...(Object.hasOwn(spec, "model") ? { modelOverride: spec.model } : {}),
    ...(Object.hasOwn(spec, "configSnapshot")
      ? { configSnapshot: spec.configSnapshot }
      : {}),
  };
}

/**
 * A registry-version refresh changes the full spec hash even when the runnable
 * intent is unchanged. Compare that intent after replacing only the two
 * version pins — no authorization, routing, or other plan-time value may be
 * normalized away.
 */
function matchesAfterRegistryVersionRefresh(storedSpec, freshSpec) {
  return (
    hashJson({
      ...storedSpec,
      promptVersion: freshSpec.promptVersion,
      policyVersion: freshSpec.policyVersion,
    }) === hashJson(freshSpec)
  );
}

function approveRun(
  db,
  proposal,
  envelope,
  { actor, now, policyVersion, reason },
) {
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
  db.query(
    `UPDATE proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?`,
  ).run(at, actor, proposal.id);
  return { approved: true, runId: proposal.run_id };
}

/**
 * Approve an open 'run' proposal. Within TTL the recorded spec executes
 * as-is only while its registry-version pins still match a *known* caller
 * `policyVersion`. `"unknown"` (the parameter default) is treated as a
 * mismatch when the recorded spec pins a version, so the spec is replanned
 * rather than approved as-is. Specs that predate version pins remain
 * approvable without a known policyVersion. After expiry or a stale
 * registry pin, the spec is rebuilt against current state under the same
 * runId: equivalent → approved; different → the stale proposal is
 * superseded, the still-PROPOSED run gets the fresh spec, and a new open
 * proposal is returned instead (§12).
 *
 * @returns {{ approved: true, runId: string }
 *         | { approved: false, replanned: true, proposal: object }}
 */
export function approveProposal(
  db,
  registry,
  id,
  {
    actor,
    now = Date.now(),
    policyVersion = "unknown",
    adapterOverride,
    reason,
  } = {},
) {
  // Take the write lock before reading the proposal. A deferred transaction
  // reads first and then fails immediately when its later write must upgrade
  // behind a worker claim; BEGIN IMMEDIATE lets SQLite's busy_timeout wait for
  // that short-lived claimant transaction instead.
  return txImmediate(db, () => {
    const proposal = db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
    if (!proposal) throw new Error(`unknown proposal ${id}`);
    if (proposal.status !== "open")
      throw new Error(`proposal ${id} is '${proposal.status}', not open`);
    if (proposal.decision !== "run")
      throw new Error(
        `proposal ${id} decision is '${proposal.decision}' — only 'run' proposals are approvable`,
      );

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
    const recordedSpec = proposal.spec_json
      ? JSON.parse(proposal.spec_json)
      : null;
    // Fail-closed: an unknown/omitted caller version is *not equal* to a
    // recorded pin. Skipping the comparison here used to approve the
    // recorded spec as-is whenever a caller forwarded the default.
    const registryVersionMismatch =
      recordedSpecPinsVersion(recordedSpec) &&
      (!isKnownPolicyVersion(policyVersion) ||
        recordedSpec.promptVersion !== policyVersion ||
        recordedSpec.policyVersion !== policyVersion);
    let registryReloadMismatch = false;
    if (recordedSpec?.defHash) {
      try {
        registryReloadMismatch =
          computeDefHash(getAgent(registry, recordedSpec.agent)) !==
          recordedSpec.defHash;
      } catch {
        registryReloadMismatch = true;
      }
    }
    if (
      !registryReloadMismatch &&
      !registryVersionMismatch &&
      !isExpired(proposal, now)
    ) {
      return approveRun(db, proposal, envelope, {
        actor,
        now,
        policyVersion,
        reason: reason ?? "approved",
      });
    }

    // Expired, version-stale, or definition-stale: re-plan against current
    // registry state, reusing the runId. A defHash mismatch is checked even
    // inside the TTL: approval names an immutable definition, not merely an
    // unexpired row.
    if (!mapping)
      throw new Error(
        `proposal ${id} requires re-planning but event type ${envelope.type} is no longer registered`,
      );
    const storedSpec = recordedSpec ?? JSON.parse(proposal.spec_json);
    const built = {
      ...buildRunSpec(registry, envelope, mapping, {
        runId: proposal.run_id,
        policyVersion,
        adapterOverride,
        now,
        ...ttlReplanOptions(storedSpec),
      }),
      // configSnapshot can affect planning and is itself part of specs that
      // explicitly pin it. Keep the pin in the rebuilt spec as well as
      // supplying it to buildRunSpec above.
      ...(Object.hasOwn(storedSpec, "configSnapshot")
        ? { configSnapshot: storedSpec.configSnapshot }
        : {}),
      // A run is its existing idempotency generation, not a new family
      // member. Reapply the stored key after buildRunSpec derives its normal
      // declaration key.
      idempotencyKey: storedSpec.idempotencyKey,
    };
    // Preserve the definition-attestation generation of the recorded spec.
    // Older rows without defHash remain byte-compatible; pinned rows always
    // receive a fresh pin rather than losing the guard during re-planning.
    const fresh = storedSpec?.defHash
      ? {
          ...built,
          defHash: computeDefHash(getAgent(registry, built.agent)),
        }
      : built;
    const freshHash = hashJson(fresh);
    // Refresh-and-approve only when the caller named a real current version.
    // Replanning with `"unknown"` must not stamp that sentinel onto the
    // recorded spec and queue it.
    const versionRefreshMatches =
      registryVersionMismatch &&
      isKnownPolicyVersion(policyVersion) &&
      !registryReloadMismatch &&
      matchesAfterRegistryVersionRefresh(storedSpec, fresh);
    if (
      !registryReloadMismatch &&
      (freshHash === proposal.spec_hash || versionRefreshMatches)
    ) {
      if (versionRefreshMatches) {
        const freshJson = canonicalJson(fresh);
        db.query(
          `UPDATE runs SET spec_json = ?, spec_hash = ?, updated_at = ? WHERE run_id = ?`,
        ).run(
          freshJson,
          freshHash,
          new Date(now).toISOString(),
          proposal.run_id,
        );
        db.query(
          `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
        ).run(freshJson, freshHash, proposal.id);
      }
      return approveRun(db, proposal, envelope, {
        actor,
        now,
        policyVersion,
        reason: versionRefreshMatches
          ? "approved_after_registry_replan"
          : "approved_after_ttl_replan",
      });
    }

    const state = runState(db, proposal.run_id);
    if (state !== "PROPOSED")
      throw new Error(
        `proposal ${id} expired but run ${proposal.run_id} is ${state}, not PROPOSED`,
      );
    const at = new Date(now).toISOString();
    db.query(
      `UPDATE proposals SET status = 'superseded', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`,
    ).run(
      at,
      actor,
      registryReloadMismatch
        ? "superseded_by_registry_reload"
        : registryVersionMismatch
          ? "superseded_by_registry_replan"
          : "superseded_by_ttl_replan",
      id,
    );
    const freshJson = canonicalJson(fresh);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ?, updated_at = ? WHERE run_id = ?`,
    ).run(freshJson, freshHash, at, proposal.run_id);
    const newId = newProposalId();
    db.query(
      `INSERT INTO proposals
         (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
          idempotency_key, status, reason, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(
      newId,
      proposal.event_source,
      proposal.event_id,
      proposal.run_id,
      freshJson,
      freshHash,
      fresh.idempotencyKey,
      registryReloadMismatch
        ? "replanned_after_registry_reload"
        : registryVersionMismatch
          ? "replanned_after_registry_replan"
          : "replanned_after_ttl",
      at,
      mapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS,
    );
    return {
      approved: false,
      replanned: true,
      ...(registryReloadMismatch ? { registryReloaded: true } : {}),
      proposal: getProposal(db, newId),
    };
  });
}

/**
 * Close the unique open proposal for a run that can no longer consume it.
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
export function closeOpenProposalForRun(
  db,
  runId,
  { actor, reason = "run_cancelled", now = Date.now() } = {},
) {
  const open = db
    .query(`SELECT id FROM proposals WHERE run_id = ? AND status = 'open'`)
    .all(runId);
  if (open.length === 0) return { closed: false };
  if (open.length > 1)
    return { closed: false, ambiguous: true, count: open.length };
  const at = new Date(now).toISOString();
  db.query(
    `UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`,
  ).run(at, actor, reason, open[0].id);
  return { closed: true, id: open[0].id };
}

/**
 * Reject an open proposal. A run still sitting in PROPOSED is cancelled with
 * reason 'proposal_rejected' and the operator recorded as actor (§8).
 */
export function rejectProposal(
  db,
  id,
  { actor, reason, now = Date.now(), policyVersion = "unknown" } = {},
) {
  return txImmediate(db, () => {
    const proposal = db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
    if (!proposal) throw new Error(`unknown proposal ${id}`);
    if (proposal.status !== "open")
      throw new Error(`proposal ${id} is '${proposal.status}', not open`);
    const at = new Date(now).toISOString();
    db.query(
      `UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?`,
    ).run(at, actor, reason ?? proposal.reason, id);
    if (proposal.run_id && runState(db, proposal.run_id) === "PROPOSED") {
      transition(db, {
        runId: proposal.run_id,
        to: "CANCELLED",
        expectFrom: "PROPOSED",
        actor,
        reason: "proposal_rejected",
        policyVersion,
        now,
      });
    }
    return { rejected: true, runId: proposal.run_id ?? undefined };
  });
}

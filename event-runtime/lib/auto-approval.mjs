/**
 * Narrow, git-owned approval policy for ordinary chain work.
 *
 * This is still the normal proposal path: each candidate is revalidated before
 * approval and failures stay open with a typed reason for an operator.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { budgetExhausted } from "../../lib/spend.mjs";
import { buildChainInput } from "./chain.mjs";
import { hashJson } from "./canonical.mjs";
import { approveProposal } from "./proposals.mjs";
import { getAgent, getEventType } from "./registry.mjs";
import { reposRoot } from "./repos.mjs";
import { validate } from "./schema.mjs";

export const CHAIN_APPROVAL_SOURCE = "chain";
export const CHAIN_APPROVAL_MODE_AUTO = "auto";
export const CHAIN_APPROVAL_MODE_WATCHED = "watched";
export const CHAIN_AUTO_APPROVAL_EVENT_TYPES = new Set([
  "factory.work.requested",
  "factory.triage.requested",
  "factory.triage-apply.requested",
  "factory.dispatch.requested",
  "factory.merge.requested",
  "factory.merge-fix.requested",
  "factory.merge-apply.requested",
  "factory.merge-landed",
  "factory.merge-verify.requested",
  "factory.merge-escalate.requested",
]);

const MERGE_EVENT_TYPES = new Set([
  "factory.merge.requested",
  "factory.merge-fix.requested",
  "factory.merge-apply.requested",
  "factory.merge-landed",
  "factory.merge-verify.requested",
  "factory.merge-escalate.requested",
]);
export const CHAIN_AUTO_APPROVAL_REASON = "auto_approved:chain-policy@1";
export const CHAIN_AUTO_APPROVAL_ACTOR = "chain-auto-approval";
const NEVER_AUTO_APPROVE = new Set(["factory.ship-apply.requested"]);

function policyPath(root = reposRoot()) {
  return path.join(root, "config", "policy.yaml");
}

/** Missing or malformed policy is no approval, never an implicit default. */
export function loadChainAutoApprovalPolicy({ root = reposRoot() } = {}) {
  const file = policyPath(root);
  if (!existsSync(file))
    return { allowed: new Set(), reason: "policy_missing" };
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
    const allowed = parsed?.chain_auto_approval?.allowed_event_types;
    if (
      !Array.isArray(allowed) ||
      !allowed.every((value) => typeof value === "string")
    ) {
      return { allowed: new Set(), reason: "policy_invalid" };
    }
    if (
      allowed.some(
        (eventType) =>
          NEVER_AUTO_APPROVE.has(eventType) ||
          !CHAIN_AUTO_APPROVAL_EVENT_TYPES.has(eventType),
      )
    ) {
      return { allowed: new Set(), reason: "policy_contains_forbidden_event" };
    }
    const merge = parsed?.merge;
    const escalation = parsed?.escalation;
    const mergeAllowed = allowed.some((eventType) => MERGE_EVENT_TYPES.has(eventType));
    const maxFixRounds = merge?.max_fix_rounds ?? 0;
    const autoMergeBase = escalation?.auto_merge_base ?? [];
    const autoMergeOwners = escalation?.auto_merge_owners ?? [];
    if (
      (mergeAllowed && (!Number.isInteger(maxFixRounds) || maxFixRounds < 0)) ||
      !Array.isArray(autoMergeBase) ||
      !autoMergeBase.every((value) => typeof value === "string") ||
      !Array.isArray(autoMergeOwners) ||
      !autoMergeOwners.every((value) => typeof value === "string")
    ) {
      return {
        allowed: new Set(),
        reason: "merge_policy_invalid",
        maxFixRounds: 0,
        autoMergeBase: new Set(),
        autoMergeOwners: new Set(),
      };
    }
    return {
      allowed: new Set(allowed),
      reason: null,
      maxFixRounds,
      autoMergeBase: new Set(autoMergeBase),
      autoMergeOwners: new Set(autoMergeOwners),
    };
  } catch {
    return { allowed: new Set(), reason: "policy_invalid" };
  }
}

/** Build the immutable approval policy embedded in a chain run spec. */
export function buildChainApprovalPolicy(
  eventType,
  { source = "operator", policy = loadChainAutoApprovalPolicy() } = {},
) {
  if (source !== CHAIN_APPROVAL_SOURCE) return null;
  if (policy.allowed.has(eventType)) {
    return {
      source: CHAIN_APPROVAL_SOURCE,
      mode: CHAIN_APPROVAL_MODE_AUTO,
      eventType,
    };
  }
  return {
    source: CHAIN_APPROVAL_SOURCE,
    mode: CHAIN_APPROVAL_MODE_WATCHED,
    eventType,
    reason: policy.reason ?? "event_type_not_allowlisted",
  };
}

export function stableChainApprovalPolicyForHash(policy) {
  if (!policy) return null;
  const { checkedAt, ...dispatchEvidence } = policy.dispatchEvidence ?? {};
  return {
    source: policy.source,
    mode: policy.mode,
    eventType: policy.eventType,
    reason: policy.reason,
    dispatchEvidenceHash: policy.dispatchEvidence
      ? hashJson(dispatchEvidence)
      : null,
  };
}

const ENVIRONMENT_FAILURE_REASONS = new Set([
  "adapter_error",
  "cli_not_found",
  "unknown_adapter",
]);

function loadRuntimePolicy(root = reposRoot()) {
  const file = policyPath(root);
  if (!existsSync(file)) return null;
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Shared unattended-work guard. It is evaluated immediately before every
 * approval, so earlier approvals in the same bounded pass consume capacity.
 */
export function chainRuntimeGuard(
  db,
  {
    root = reposRoot(),
    runtimePolicy = loadRuntimePolicy(root),
    budgetCheck = budgetExhausted,
  } = {},
) {
  if (!runtimePolicy) return "runtime_policy_unavailable";

  try {
    if (budgetCheck(runtimePolicy)) return "budget_exhausted";
  } catch {
    return "budget_check_failed";
  }

  const workerCap = runtimePolicy?.workers?.max;
  if (
    typeof workerCap !== "number" ||
    !Number.isInteger(workerCap) ||
    workerCap < 1
  ) {
    return "worker_cap_policy_invalid";
  }
  const active = db
    .query(
      `SELECT COUNT(*) AS n FROM runs
       WHERE state IN ('APPROVED','QUEUED','LEASED','RUNNING','VERIFYING')`,
    )
    .get().n;
  if (active >= workerCap) return "worker_cap_full";

  const threshold = runtimePolicy?.circuit_breaker?.consecutive_env_failures;
  if (
    typeof threshold !== "number" ||
    !Number.isInteger(threshold) ||
    threshold < 1
  ) {
    return "circuit_breaker_policy_invalid";
  }
  const recent = db
    .query(
      `SELECT reason_code FROM attempts
       WHERE finished_at IS NOT NULL
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(threshold);
  const consecutive = recent.findIndex(
    (attempt) => !ENVIRONMENT_FAILURE_REASONS.has(attempt.reason_code),
  );
  const failures = consecutive === -1 ? recent.length : consecutive;
  if (failures >= threshold) return "circuit_breaker_tripped";

  return null;
}

function sameJson(left, right) {
  return hashJson(left) === hashJson(right);
}

function hasSecurityOrEscalation(labels = []) {
  return labels.some(
    (label) =>
      label === "ai:escalated" ||
      label === "type:security" ||
      /security/i.test(label),
  );
}

function closedTriagePlan(def, input) {
  if (!def?.actionRegistry || !input?.plan || !Array.isArray(input.plan))
    return false;
  return input.plan.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.action === "string" &&
      def.actionRegistry[item.action],
  );
}

function proposalIntegrity(candidate, mapping, envelope) {
  let proposalSpec;
  let runSpec;
  try {
    proposalSpec = JSON.parse(candidate.proposal_spec_json);
    runSpec = JSON.parse(candidate.run_spec_json);
  } catch {
    return "proposal_unparseable";
  }
  if (!sameJson(proposalSpec, runSpec)) return "proposal_run_spec_mismatch";
  if (
    hashJson(runSpec) !== candidate.run_spec_hash ||
    candidate.proposal_spec_hash !== candidate.run_spec_hash
  ) {
    return "proposal_hash_mismatch";
  }
  if (proposalSpec.agent !== mapping.agent) return "proposal_agent_mismatch";
  for (const [key, value] of Object.entries(envelope.payload ?? {})) {
    if (!sameJson(proposalSpec.input?.[key], value))
      return `proposal_input_mismatch:${key}`;
  }
  return null;
}

function dispatchSafe(envelope, approvalPolicy, dispatchEligibility, dispatch) {
  if (typeof dispatchEligibility !== "function")
    return "dispatch_recheck_unavailable";

  let result;
  try {
    result = dispatchEligibility(envelope.payload, dispatch);
  } catch {
    return "dispatch_recheck_failed";
  }

  if (!result?.ok)
    return `dispatch_ineligible:${result?.refusal?.reason ?? "unknown"}`;

  const expectedEvidenceHash =
    stableChainApprovalPolicyForHash(approvalPolicy)?.dispatchEvidenceHash;
  if (!expectedEvidenceHash)
    return "dispatch_ineligible:approval_policy_missing_evidence";
  const { checkedAt, ...currentEvidence } = result.evidence ?? {};
  if (expectedEvidenceHash !== hashJson(currentEvidence)) {
    return "dispatch_ineligible:evidence_changed_since_plan";
  }

  const labels = result.evidence?.ticket?.labels ?? [];
  if (hasSecurityOrEscalation(labels))
    return "dispatch_ineligible:escalated_or_security";
  if ((result.evidence?.escalatePathIntersections ?? []).length > 0)
    return "dispatch_ineligible:escalate_paths_intersect";

  return null;
}

function mergeBarrierReason(db, candidate, now) {
  const inFlight = db
    .query(
      `SELECT run_id, state, spec_json, created_at FROM runs
     WHERE run_id != ?
       AND state IN ('QUEUED','LEASED','RUNNING','VERIFYING')
       AND json_extract(spec_json, '$.agent') IN ('merge-apply@2','merge-verify@1')
     ORDER BY created_at, rowid`,
    )
    .all(candidate.run_id);
  for (const run of inFlight) {
    let timeoutSeconds;
    try {
      timeoutSeconds = JSON.parse(run.spec_json).timeoutSeconds;
    } catch {
      continue;
    }
    const createdAt = Date.parse(run.created_at);
    if (
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      !Number.isFinite(createdAt)
    ) {
      continue;
    }
    const ageSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
    if (ageSeconds >= timeoutSeconds) continue;
    return `merge_barrier_active:${run.run_id}:state=${run.state}:age=${ageSeconds}s`;
  }

  // A landed event owns the global barrier until its exact verifier completes.
  // FAILED verification intentionally remains a hold: CI/smoke red must stop
  // every later merge rather than letting the next schedule tick race ahead.
  const unverified = db
    .query(
      `SELECT e.event_id FROM events e
     WHERE e.type = 'factory.merge-landed'
       AND NOT EXISTS (
         SELECT 1 FROM proposals p JOIN runs r ON r.run_id = p.run_id
         WHERE p.event_source = e.source AND p.event_id = e.event_id
           AND json_extract(r.spec_json, '$.agent') = 'merge-verify@1'
           AND r.state = 'COMPLETED'
       )
     LIMIT 1`,
    )
    .get();
  return unverified ? `merge_barrier_unverified:${unverified.event_id}` : null;
}

const REGISTERED_COMMAND_EDGES = {
  "merge-apply@2": new Set([
    "factory.merge.requested",
    "factory.merge-landed",
  ]),
  "merge-verify@1": new Set(["factory.merge.requested"]),
};

function chainContextValue(expr, context) {
  if (typeof expr !== "string" || !expr.startsWith("$.")) return expr;
  const [root, ...segments] = expr.slice(2).split(".");
  let value = context[root];
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || !(segment in value))
      throw new Error("chain selection path unresolved");
    value = value[segment];
  }
  if (value === undefined) throw new Error("chain selection path unresolved");
  return value;
}

function chainArrayField(field, context) {
  if (typeof field === "string" && field.startsWith("$."))
    return chainContextValue(field, context);
  return context.artifact[field] ?? context.input[field];
}

/** Prove an explicitly independent sibling edge from its declared selector and payload. */
function independentlySelectedEdge(rule, spec, result, envelope) {
  if (rule?.independent !== true) return false;

  const artifactHash = {};
  for (const entry of result.artifacts ?? []) {
    if (entry.kind && entry.sha256 && artifactHash[entry.kind] === undefined)
      artifactHash[entry.kind] = entry.sha256;
  }
  const context = {
    input: spec.input ?? {},
    artifact: result.artifact ?? {},
    artifactHash,
  };

  for (const edge of Object.values(rule?.edges ?? {})) {
    if (edge?.eventType !== envelope.type) continue;
    try {
      if (edge.whenItemsField === undefined) continue;
      const selectedItems = chainArrayField(edge.whenItemsField, context);
      if (!Array.isArray(selectedItems) || selectedItems.length === 0) continue;

      const itemsField = edge.itemsField ?? rule.itemsField;
      if (itemsField !== undefined) {
        const items = chainArrayField(itemsField, context);
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const itemContext = { ...context, item };
          const payload = buildChainInput(edge.input ?? {}, itemContext);
          const itemKey = edge.itemKey ?? rule.itemKey;
          if (itemKey && payload[itemKey] === undefined) {
            const itemKeyValue =
              item && typeof item === "object"
                ? item[itemKey]
                : typeof item === "string" || typeof item === "number"
                  ? String(item)
                  : undefined;
            if (
              itemKeyValue === undefined ||
              itemKeyValue === null ||
              String(itemKeyValue).trim() === ""
            )
              continue;
            payload[itemKey] = itemKeyValue;
          }
          if (edge.perItem)
            Object.assign(payload, buildChainInput(edge.perItem, itemContext));
          if (sameJson(payload, envelope.payload ?? {})) return true;
        }
        continue;
      }

      if (
        sameJson(
          buildChainInput(edge.input ?? {}, context),
          envelope.payload ?? {},
        )
      ) {
        return true;
      }
    } catch {
      // A declared edge whose selection or payload cannot be reconstructed is
      // not approval evidence; the candidate remains watched.
    }
  }
  return false;
}

/**
 * `source=chain` is necessary provenance, not sufficient authorization. The
 * predecessor/result and registered edge are re-read from the durable ledger
 * immediately before approval so a forged row, stale proposal, or caller-made
 * causation id remains watched.
 */
function chainPredecessorReason(db, registry, candidate, envelope) {
  const causationId = envelope.causationId;
  if (typeof causationId !== "string" || causationId === "")
    return "chain_causation_missing";

  const predecessor = db
    .query(
      `SELECT r.state, r.spec_json, res.result_json
       FROM runs r
       JOIN results res ON res.run_id = r.run_id AND res.attempt = r.attempts
       WHERE r.run_id = ?
         AND EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.run_id = r.run_id AND p.decision = 'run'
         )`,
    )
    .get(causationId);
  if (!predecessor) return "chain_predecessor_or_result_missing";
  if (predecessor.state !== "COMPLETED")
    return "chain_predecessor_not_completed";

  let spec;
  let result;
  try {
    spec = JSON.parse(predecessor.spec_json);
    result = JSON.parse(predecessor.result_json);
  } catch {
    return "chain_predecessor_unparseable";
  }

  const rule = registry.edges?.[spec.agent];
  const recommendation = rule
    ? result.artifact?.[rule.recommendationField]
    : undefined;
  const declaredEdge =
    rule?.independent === true ? undefined : rule?.edges?.[recommendation];
  const independentEdge = independentlySelectedEdge(
    rule,
    spec,
    result,
    envelope,
  );
  const commandEdge = REGISTERED_COMMAND_EDGES[spec.agent]?.has(envelope.type);
  if (
    declaredEdge?.eventType !== envelope.type &&
    !independentEdge &&
    !commandEdge
  )
    return "chain_edge_not_registered";

  // Registered command edges carry immutable identity from their predecessor.
  // Recheck those pins here instead of trusting event payload text.
  if (spec.agent === "merge-apply@2") {
    const source = spec.input ?? {};
    const item = source.plan?.[0];
    if (envelope.type === "factory.merge-landed") {
      const payload = envelope.payload ?? {};
      if (
        payload.repo !== source.repo ||
        payload.github !== source.github ||
        payload.base !== source.base ||
        payload.pr !== item?.pr ||
        payload.ticket !== item?.ticket ||
        payload.headSha !== item?.headSha ||
        payload.headRef !== item?.headRef
      ) {
        return "chain_command_edge_payload_mismatch";
      }
    } else if (envelope.payload?.repo !== source.repo) {
      return "chain_command_edge_payload_mismatch";
    }
  }
  if (
    spec.agent === "merge-verify@1" &&
    envelope.payload?.repo !== spec.input?.repo
  ) {
    return "chain_command_edge_payload_mismatch";
  }
  return null;
}

function durableFixRoundReason(db, candidate, input, policy) {
  const cap = policy.maxFixRounds ?? 0;
  const rows = db
    .query(
      `SELECT event_id, envelope_json FROM events
       WHERE source = 'chain'
         AND type = 'factory.merge-fix.requested'
         AND event_id != ?`,
    )
    .all(candidate.event_id);
  const priorRounds = [];
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.envelope_json)?.payload;
    } catch {
      return "merge_fix_history_unparseable";
    }
    if (
      payload?.repo === input.repo &&
      payload?.github === input.github &&
      payload?.pr === input.pr
    ) {
      if (!Number.isInteger(payload.round) || payload.round < 1)
        return "merge_fix_history_invalid";
      priorRounds.push(payload.round);
    }
  }
  const durableRound = (priorRounds.length ? Math.max(...priorRounds) : 0) + 1;
  if (durableRound > cap || input.round !== durableRound)
    return "merge_fix_round_not_durable";
  return null;
}

function mergeEligibility(db, candidate, envelope, policy, now) {
  if (!MERGE_EVENT_TYPES.has(envelope.type)) return null;
  const input = envelope.payload ?? {};

  if (
    envelope.type === "factory.merge.requested" ||
    envelope.type === "factory.merge-escalate.requested"
  ) {
    return null;
  }
  if (envelope.type === "factory.merge-fix.requested") {
    const owner = String(input.github ?? "").split("/")[0];
    if (!policy.autoMergeOwners?.has(owner) || !policy.autoMergeBase?.has(input.base))
      return "merge_fix_repo_not_allowed";
    if (input.mechanical !== true || input.withinOwnedPaths !== true)
      return "merge_fix_not_mechanical_or_in_scope";
    if (
      !Number.isInteger(input.round) ||
      input.round < 1 ||
      input.round > (policy.maxFixRounds ?? 0)
    ) {
      return "merge_fix_round_exhausted";
    }
    if (!Array.isArray(input.ownedPaths) || input.ownedPaths.length === 0)
      return "merge_fix_owned_paths_missing";
    return durableFixRoundReason(db, candidate, input, policy);
  }

  const owner = String(input.github ?? "").split("/")[0];
  if (!policy.autoMergeOwners?.has(owner)) return "merge_owner_not_allowed";
  if (
    !policy.autoMergeBase?.has(input.base) ||
    ["main", "master", input.deployBranch].filter(Boolean).includes(input.base)
  ) {
    return "merge_base_not_allowed";
  }

  if (envelope.type === "factory.merge-apply.requested") {
    const plan = input.plan;
    if (!Array.isArray(plan) || plan.length !== 1)
      return "merge_plan_must_name_one_pr";
    const item = plan[0];
    if (
      item?.action !== "merge_pr" ||
      item.policySafe !== true ||
      item.checksGreen !== true ||
      item.mergeable !== true ||
      item.ownedPathsValid !== true ||
      item.handoffValid !== true ||
      item.testsFalsifiable !== true ||
      item.sensitive !== false ||
      item.ambiguous !== false
    )
      return "merge_review_not_policy_safe";
    return mergeBarrierReason(db, candidate, now);
  }

  // merge-landed / merge-verify are allowed only for the exact immutable
  // landing identity; schema validation checks each 40-hex pin.
  const barrierReason = mergeBarrierReason(db, candidate, now);
  return barrierReason?.startsWith("merge_barrier_active:")
    ? barrierReason
    : null;
}

function eligible(
  db,
  candidate,
  registry,
  policy,
  { dispatchEligibility, dispatch, now },
) {
  if (candidate.event_source !== CHAIN_APPROVAL_SOURCE)
    return "event_source_not_chain";

  let envelope;
  try {
    envelope = JSON.parse(candidate.envelope_json);
  } catch {
    return "event_unparseable";
  }

  let runSpec;
  try {
    runSpec = JSON.parse(candidate.run_spec_json);
  } catch {
    return "run_spec_unparseable";
  }

  const approvalPolicy = runSpec?.approvalPolicy;
  if (!approvalPolicy) return "run_approval_policy_missing";
  if (approvalPolicy.source !== CHAIN_APPROVAL_SOURCE)
    return "run_approval_policy_source_unknown";
  if (approvalPolicy.mode !== CHAIN_APPROVAL_MODE_AUTO)
    return `run_approval_policy_${approvalPolicy.mode}`;

  if (candidate.event_type !== approvalPolicy.eventType)
    return "run_approval_policy_event_mismatch";
  if (!policy.allowed.has(candidate.event_type))
    return policy.reason ?? "policy_unknown";

  const predecessorReason = chainPredecessorReason(
    db,
    registry,
    candidate,
    envelope,
  );
  if (predecessorReason) return predecessorReason;

  const mergeReason = mergeEligibility(db, candidate, envelope, policy, now);
  if (mergeReason) return mergeReason;

  const mapping = getEventType(registry, envelope.type);
  if (!mapping || mapping.humanApprovalOnly) return "event_human_approval_only";
  const integrityError = proposalIntegrity(candidate, mapping, envelope);
  if (integrityError) return integrityError;

  const def = getAgent(registry, mapping.agent);
  if (!validate(def.inputSchema, envelope.payload).valid)
    return "input_schema_invalid";
  if (
    envelope.type === "factory.triage-apply.requested" &&
    !closedTriagePlan(def, envelope.payload)
  ) {
    return "triage_action_not_closed";
  }
  if (envelope.type === "factory.dispatch.requested") {
    return dispatchSafe(
      envelope,
      approvalPolicy,
      dispatchEligibility,
      dispatch,
    );
  }
  return null;
}

function noteOpenReason(db, id, reason) {
  db.query(
    `UPDATE proposals SET reason = ? WHERE id = ? AND status = 'open'`,
  ).run(`auto_approval_ineligible:${reason}`, id);
}

/**
 * Recheck and approve the currently open, eligible chain proposals once.
 * A second pass finds no approved proposal and therefore cannot double-approve.
 */
export function autoApproveChains(
  db,
  registry,
  {
    now = Date.now(),
    policyVersion = "unknown",
    dispatchEligibility,
    dispatch = {},
    policy = loadChainAutoApprovalPolicy(),
    runtimeGuard = chainRuntimeGuard,
    runtimeGuardOptions = {},
  } = {},
) {
  const approved = [];
  const open = [];
  const errors = [];
  const rows = db
    .query(
      `SELECT p.id, p.run_id, p.event_source, p.event_id, p.spec_json AS proposal_spec_json, p.spec_hash AS proposal_spec_hash,
            p.created_at, p.ttl_seconds, e.type AS event_type, e.envelope_json,
            r.spec_json AS run_spec_json, r.spec_hash AS run_spec_hash
       FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       JOIN runs r ON r.run_id = p.run_id
      WHERE p.status = 'open' AND p.decision = 'run' AND e.source = 'chain'
      ORDER BY p.created_at, p.rowid`,
    )
    .all();

  for (const row of rows) {
    const age = now - Date.parse(row.created_at);
    const reason =
      age > row.ttl_seconds * 1000
        ? "proposal_expired"
        : eligible(db, row, registry, policy, {
            dispatchEligibility,
            dispatch,
            now,
          });
    if (reason) {
      noteOpenReason(db, row.id, reason);
      open.push({ proposalId: row.id, reason });
      continue;
    }
    let guardReason;
    try {
      guardReason = runtimeGuard(db, runtimeGuardOptions);
    } catch {
      guardReason = "runtime_guard_failed";
    }
    if (guardReason) {
      noteOpenReason(db, row.id, guardReason);
      open.push({ proposalId: row.id, reason: guardReason });
      continue;
    }
    try {
      const outcome = approveProposal(db, registry, row.id, {
        actor: CHAIN_AUTO_APPROVAL_ACTOR,
        reason: CHAIN_AUTO_APPROVAL_REASON,
        now,
        policyVersion,
      });
      if (outcome.approved)
        approved.push({ proposalId: row.id, runId: outcome.runId });
      else {
        noteOpenReason(db, row.id, "replanned");
        open.push({ proposalId: row.id, reason: "replanned" });
      }
    } catch (err) {
      const message = String(err?.message ?? err);
      noteOpenReason(db, row.id, "approval_error");
      errors.push({ proposalId: row.id, reason: "approval_error", message });
    }
  }
  return { approved, open, errors };
}

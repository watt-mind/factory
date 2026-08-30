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
import {
  policyVersion as factoryPolicyVersion,
  resolveConfigPath,
} from "./config.mjs";
import { defaultHookRegistry } from "./hooks.mjs";
import { approveProposal } from "./proposals.mjs";
import { getAgent, getEventType } from "./registry.mjs";
import { reposRoot } from "./repos.mjs";
import { validate } from "./schema.mjs";
import {
  isLinearRateLimited,
  isLinearRateLimitMessage,
} from "../../tools/linear.mjs";

export const CHAIN_APPROVAL_SOURCE = "chain";
export const HANDOFF_APPROVAL_SOURCE = "handoff";
export const CHAIN_APPROVAL_MODE_AUTO = "auto";
export const CHAIN_APPROVAL_MODE_WATCHED = "watched";
export const CHAIN_AUTO_APPROVAL_EVENT_TYPES = new Set([
  "factory.work.requested",
  "factory.triage.requested",
  "factory.triage-apply.requested",
  "factory.dispatch.requested",
  "factory.merge.requested",
  "factory.merge-review.requested",
  "factory.merge-fix.requested",
  "factory.merge-plan.requested",
  "factory.merge-apply.requested",
  "factory.merge-landed",
  "factory.merge-verify.requested",
  "factory.merge-escalate.requested",
]);

const MERGE_EVENT_TYPES = new Set([
  "factory.merge.requested",
  "factory.merge-review.requested",
  "factory.merge-fix.requested",
  "factory.merge-plan.requested",
  "factory.merge-apply.requested",
  "factory.merge-landed",
  "factory.merge-verify.requested",
  "factory.merge-escalate.requested",
]);
export const CHAIN_AUTO_APPROVAL_REASON = "auto_approved:chain-policy@1";
export const CHAIN_AUTO_APPROVAL_ACTOR = "chain-auto-approval";
export const HANDOFF_AUTO_APPROVAL_REASON =
  "auto_approved:handoff-dispatch-policy@1";
export const HANDOFF_AUTO_APPROVAL_ACTOR = "handoff-auto-approval";
// A serve tick runs every second. Keep the chain pass deliberately small so a
// backlog (especially one pinned to a retired registry) cannot monopolize the
// control plane before fresh proposals get a turn.
export const DEFAULT_MAX_CHAIN_AUTO_APPROVALS_PER_TICK = 8;
// A pending row pinned to an older registry version than the one serve runs
// with re-plans on approval (#1679). When that re-plan leaves it open, nothing
// about it changes until the registry moves again, so its verdict is held per
// (run_id, registryVersion) and only revisited this often (#1706).
export const DEFAULT_STALE_CHAIN_REVISIT_MS = 60_000;
const NEVER_AUTO_APPROVE = new Set(["factory.ship-apply.requested"]);

function policyPath(root = reposRoot()) {
  return resolveConfigPath("policy", { root });
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
    const mergeAllowed = allowed.some((eventType) =>
      MERGE_EVENT_TYPES.has(eventType),
    );
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
    const mergeBatchSize =
      Number.isInteger(merge?.batch_size) && merge.batch_size > 0
        ? merge.batch_size
        : 4;
    return {
      allowed: new Set(allowed),
      reason: null,
      maxFixRounds,
      mergeBatchSize,
      autoMergeBase: new Set(autoMergeBase),
      autoMergeOwners: new Set(autoMergeOwners),
    };
  } catch {
    return { allowed: new Set(), reason: "policy_invalid" };
  }
}

/**
 * Build the immutable unattended approval policy embedded in a run spec.
 * Chain keeps its full closed allowlist. Handoff may reuse it for exactly one
 * event type: factory.dispatch.requested.
 */
export function buildChainApprovalPolicy(
  eventType,
  { source = "operator", policy = loadChainAutoApprovalPolicy() } = {},
) {
  const chain = source === CHAIN_APPROVAL_SOURCE;
  const handoffDispatch =
    source === HANDOFF_APPROVAL_SOURCE &&
    eventType === "factory.dispatch.requested";
  if (!chain && !handoffDispatch) return null;
  if (policy.allowed.has(eventType)) {
    return {
      source,
      mode: CHAIN_APPROVAL_MODE_AUTO,
      eventType,
    };
  }
  return {
    source,
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

// Keys the planner folds into a chain event's payload after the predecessor
// emitted it: `repoPin` for repository-workspace targets and `memoPin` for
// agents that declare memos (docs/event-runtime-memos.md §4.2). They are not
// part of the edge the predecessor declared, so an independent-edge match must
// compare the payload without them — otherwise every merge-review fan-out
// (pinned checkout + decision memos) sat as chain_edge_not_registered.
const PLANNER_INJECTED_PAYLOAD_KEYS = ["repoPin", "memoPin"];

function withoutPlannerPins(payload) {
  if (!payload || typeof payload !== "object") return payload ?? {};
  const out = { ...payload };
  for (const key of PLANNER_INJECTED_PAYLOAD_KEYS) delete out[key];
  return out;
}

/** `approve.before` hook point (lib/hooks.mjs); the seam an extension gates on. */
export const APPROVE_BEFORE_HOOK = "approve.before";

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

/** Continue with `fn` after `value`, synchronously unless `value` is a thenable. */
function after(value, fn) {
  return isThenable(value) ? value.then(fn) : fn(value);
}

/**
 * Run the `approve.before` waterfall for one proposal. Hooks see a copy of
 * the proposal, its RunSpec, the dispatch recheck evidence (null for
 * non-dispatch events), the RunSpec's approvalPolicy, the repo and the clock;
 * `ctx.config` is added per hook by the registry (docs/extensions.md § Hooks).
 * A throwing registry (a persistence failure, say) is the caller's problem —
 * `autoApproveChains` turns it into a typed reason, never an approval.
 *
 * @returns {import("./hooks.mjs").HookRun | Promise<import("./hooks.mjs").HookRun>}
 */
function approveBeforeHooks(hooks, ctx, { evidence = null } = {}) {
  return hooks.run(
    APPROVE_BEFORE_HOOK,
    {
      proposal: ctx.proposal,
      spec: ctx.spec,
      evidence,
      policy: ctx.spec?.approvalPolicy ?? null,
      repo: ctx.spec?.input?.repo ?? null,
      now: ctx.now,
    },
    { db: ctx.db, timeoutMs: ctx.hookTimeoutMs, now: ctx.now },
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

function clipReason(message, max = 180) {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function dispatchSafe(
  envelope,
  approvalPolicy,
  dispatchEligibility,
  dispatch,
  hookCtx,
) {
  if (typeof dispatchEligibility !== "function")
    return "dispatch_recheck_unavailable";

  const nowMs =
    typeof hookCtx?.now === "number" && Number.isFinite(hookCtx.now)
      ? hookCtx.now
      : Date.now();
  if (
    dispatch &&
    Number.isFinite(dispatch.linearRateLimitedUntil) &&
    nowMs < dispatch.linearRateLimitedUntil
  ) {
    return "dispatch_recheck_deferred";
  }

  let result;
  try {
    result = dispatchEligibility(envelope.payload, dispatch);
  } catch (err) {
    const message = String(err?.message ?? err);
    console.error(`dispatch_recheck_failed: ${message}`);
    if (isLinearRateLimited(err) || isLinearRateLimitMessage(message)) {
      if (dispatch && typeof dispatch === "object") {
        const resetMs = Date.parse(err.resetAt);
        dispatch.linearRateLimitedUntil = Number.isFinite(resetMs)
          ? resetMs
          : nowMs + 60_000;
      }
      return "dispatch_recheck_deferred";
    }
    return `dispatch_recheck_failed:${clipReason(message)}`;
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

  // The escalated/security-label refusal ran inline here before WM-842; it is
  // now the built-in `factory:escalation-labels` hook, first in the waterfall,
  // and every hook deny keeps the `dispatch_ineligible:<reason>` shape.
  return after(
    approveBeforeHooks(hookCtx.hooks, hookCtx, { evidence: result.evidence }),
    (verdict) => {
      if (verdict.decision === "deny")
        return `dispatch_ineligible:${verdict.reason}`;
      if ((result.evidence?.escalatePathIntersections ?? []).length > 0)
        return "dispatch_ineligible:escalate_paths_intersect";
      return null;
    },
  );
}

function mergeBarrierReason(db, registry, candidate, now) {
  const applyAgent =
    registry.eventTypes["factory.merge-apply.requested"]?.agent;
  const verifyAgent = registry.eventTypes["factory.merge-landed"]?.agent;
  if (!applyAgent || !verifyAgent) return "merge_barrier_registry_incomplete";
  const inFlight = db
    .query(
      `SELECT run_id, state, spec_json, created_at FROM runs
     WHERE run_id != ?
       AND state IN ('QUEUED','LEASED','RUNNING','VERIFYING')
       AND json_extract(spec_json, '$.agent') IN (?, ?)
     ORDER BY created_at, rowid`,
    )
    .all(candidate.run_id, applyAgent, verifyAgent);
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
           AND json_extract(r.spec_json, '$.agent') = ?
           AND r.state = 'COMPLETED'
       )
     LIMIT 1`,
    )
    .get(verifyAgent);
  return unverified ? `merge_barrier_unverified:${unverified.event_id}` : null;
}

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
  const eventPayload = withoutPlannerPins(envelope.payload);

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
          if (sameJson(payload, eventPayload)) return true;
        }
        continue;
      }

      if (sameJson(buildChainInput(edge.input ?? {}, context), eventPayload)) {
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
  // A declared edge may fan out to sibling edges via `also` (e.g. dispatch@1
  // PR_OPEN → work.requested also PR_OPEN_MERGE → merge.requested). Those
  // siblings are registered edges too; without this every dispatch-chained
  // merge-scan sat as chain_edge_not_registered until an operator approved it.
  const alsoEdgeTypes = Array.isArray(declaredEdge?.also)
    ? declaredEdge.also
        .map((key) => rule?.edges?.[key]?.eventType)
        .filter((type) => typeof type === "string")
    : [];
  const independentEdge = independentlySelectedEdge(
    rule,
    spec,
    result,
    envelope,
  );
  const predecessorDef = registry.agents.get(spec.agent);
  const commandEdge = predecessorDef?.chainCommandEdges?.includes(
    envelope.type,
  );
  if (
    declaredEdge?.eventType !== envelope.type &&
    !alsoEdgeTypes.includes(envelope.type) &&
    !independentEdge &&
    !commandEdge
  )
    return "chain_edge_not_registered";

  // Registered command edges carry immutable identity from their predecessor.
  // Recheck target-required fields that originate in the source input (or its
  // selected item) instead of trusting event payload text. This preserves the
  // exact command-edge pins without keying the kernel on a pack agent id.
  if (commandEdge) {
    const source = spec.input ?? {};
    const sourceRequired = new Set(predecessorDef.inputSchema?.required ?? []);
    const itemsField = predecessorDef.itemsField;
    const item =
      typeof itemsField === "string" ? source[itemsField]?.[0] : undefined;
    const itemRequired = new Set(
      typeof itemsField === "string"
        ? (predecessorDef.inputSchema?.properties?.[itemsField]?.items
            ?.required ?? [])
        : [],
    );
    const targetAgent = registry.eventTypes[envelope.type]?.agent;
    const required =
      registry.agents.get(targetAgent)?.inputSchema?.required ?? [];
    const payload = envelope.payload ?? {};
    for (const field of required) {
      if (sourceRequired.has(field)) {
        if (payload[field] !== source[field])
          return "chain_command_edge_payload_mismatch";
      } else if (itemRequired.has(field) && payload[field] !== item?.[field]) {
        return "chain_command_edge_payload_mismatch";
      }
    }
    if (
      predecessorDef.chainRepoMustMatchInput === true &&
      payload.repo !== source.repo
    ) {
      return "chain_command_edge_payload_mismatch";
    }
  }
  return null;
}

function durableFixRoundReason(db, candidate, input, policy) {
  const cap = policy.maxFixRounds ?? 0;
  // A fix round is "spent" only when a merge-fix run for this PR actually
  // executed (or is executing). Emitted-but-never-run events (merge-scan
  // re-emits every tick), REFUSED execute-time refusals (pr moved, ticket
  // state) and CANCELLED stale-pinned runs do not consume the budget
  // (2026-08-18: counting them exhausted max_fix_rounds before any fix ran).
  const rows = db
    .query(
      `SELECT e.event_id, e.envelope_json, r.state FROM events e
       JOIN proposals p ON p.event_id = e.event_id AND p.event_source = e.source
       JOIN runs r ON r.run_id = p.run_id
       WHERE e.source = 'chain'
         AND e.type = 'factory.merge-fix.requested'
         AND p.decision = 'run'
         AND r.state IN ('QUEUED','LEASED','RUNNING','VERIFYING','COMPLETED','FAILED')
         AND e.event_id != ?`,
    )
    .all(candidate.event_id);
  let executed = 0;
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
      executed += 1;
    }
  }
  // The durable round is the count of executed rounds plus one — the runtime,
  // not the scanning model, is the source of truth. The scan may still say a
  // lower round (it does not see run history); a higher round than durable is
  // a replay/skip and is refused.
  const durableRound = executed + 1;
  if (durableRound > cap) return "merge_fix_round_not_durable";
  if (
    !Number.isInteger(input.round) ||
    input.round < 1 ||
    input.round > durableRound
  )
    return "merge_fix_round_not_durable";
  return null;
}

function mergeEligibility(db, registry, candidate, envelope, policy, now) {
  if (!MERGE_EVENT_TYPES.has(envelope.type)) return null;
  const input = envelope.payload ?? {};

  if (
    envelope.type === "factory.merge.requested" ||
    envelope.type === "factory.merge-review.requested" ||
    envelope.type === "factory.merge-plan.requested" ||
    envelope.type === "factory.merge-escalate.requested"
  ) {
    return null;
  }
  if (envelope.type === "factory.merge-fix.requested") {
    const owner = String(input.github ?? "").split("/")[0];
    if (
      !policy.autoMergeOwners?.has(owner) ||
      !policy.autoMergeBase?.has(input.base)
    )
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
    const batchSize = policy.mergeBatchSize ?? 4;
    if (!Array.isArray(plan) || plan.length < 1 || plan.length > batchSize)
      return "merge_plan_must_name_one_to_batch_prs";
    for (const item of plan) {
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
    }
    return mergeBarrierReason(db, registry, candidate, now);
  }

  // merge-landed / merge-verify are allowed only for the exact immutable
  // landing identity; schema validation checks each 40-hex pin.
  const barrierReason = mergeBarrierReason(db, registry, candidate, now);
  return barrierReason?.startsWith("merge_barrier_active:")
    ? barrierReason
    : null;
}

/**
 * @returns {string|null|Promise<string|null>} an ineligibility reason, or
 *   null; a Promise only when an `approve.before` hook answered asynchronously.
 */
function eligible(
  db,
  candidate,
  registry,
  policy,
  { dispatchEligibility, dispatch, now, hooks, hookTimeoutMs },
) {
  const isChain = candidate.event_source === CHAIN_APPROVAL_SOURCE;
  const isHandoff = candidate.event_source === HANDOFF_APPROVAL_SOURCE;
  if (!isChain && !isHandoff) return "event_source_not_unattended";
  if (isHandoff && candidate.event_type !== "factory.dispatch.requested")
    return "handoff_event_type_not_dispatch";

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
  if (approvalPolicy.source !== candidate.event_source)
    return "run_approval_policy_source_unknown";
  if (approvalPolicy.mode !== CHAIN_APPROVAL_MODE_AUTO)
    return `run_approval_policy_${approvalPolicy.mode}`;

  if (candidate.event_type !== approvalPolicy.eventType)
    return "run_approval_policy_event_mismatch";
  if (!policy.allowed.has(candidate.event_type))
    return policy.reason ?? "policy_unknown";

  if (isChain) {
    const predecessorReason = chainPredecessorReason(
      db,
      registry,
      candidate,
      envelope,
    );
    if (predecessorReason) return predecessorReason;
  }

  const mergeReason = mergeEligibility(
    db,
    registry,
    candidate,
    envelope,
    policy,
    now,
  );
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
  const hookCtx = {
    hooks,
    db,
    now,
    hookTimeoutMs,
    proposal: {
      id: candidate.id,
      runId: candidate.run_id,
      eventSource: candidate.event_source,
      eventId: candidate.event_id,
      eventType: candidate.event_type,
      createdAt: candidate.created_at,
      ttlSeconds: candidate.ttl_seconds,
    },
    spec: runSpec,
  };
  if (envelope.type === "factory.dispatch.requested") {
    return dispatchSafe(
      envelope,
      approvalPolicy,
      dispatchEligibility,
      dispatch,
      hookCtx,
    );
  }
  // Every other auto-approval runs the same hooks, with no dispatch evidence.
  return after(approveBeforeHooks(hooks, hookCtx), (verdict) =>
    verdict.decision === "deny" ? `hook_denied:${verdict.reason}` : null,
  );
}

/**
 * Bound the per-pass cost of a proposal backlog. The dispatch eligibility gate
 * reads the per-repo in-flight list (`fetchInFlight`, a slow control-plane read)
 * for every open dispatch proposal, so a backlog turned each planning pass into
 * O(open-proposals × read-latency) — stalling the serve loop and letting fresh
 * chain dispatch proposals expire before they were ever approved (#1064).
 *
 * Memoize that read by repo for the life of one pass so it is fetched at most
 * once per repo, never once-per-proposal. The wrapper is transparent otherwise:
 * every other option (including the `linearRateLimitedUntil` deferral that
 * dispatchSafe writes back) stays on the same object across the pass. A dispatch
 * bag without a `fetchInFlight` (the common non-dispatch pass) is returned
 * unchanged.
 */
function withPassInFlightCache(dispatch) {
  const base = dispatch?.fetchInFlight;
  if (typeof base !== "function") return dispatch;
  const byRepo = new Map();
  return {
    ...dispatch,
    fetchInFlight(repoConfig) {
      const key = repoConfig?.name ?? repoConfig?.team ?? repoConfig ?? "";
      if (byRepo.has(key)) return byRepo.get(key);
      const value = base(repoConfig);
      byRepo.set(key, value);
      return value;
    },
  };
}

function noteOpenReason(db, id, reason) {
  db.query(
    `UPDATE proposals SET reason = ? WHERE id = ? AND status = 'open'`,
  ).run(`auto_approval_ineligible:${reason}`, id);
}

/** One pass at a time per database: a floating pass and an awaited one must not interleave. */
const PASSES = new WeakMap();
/** Per database: `${run_id}\0${registryVersion}` → held verdict for a registry-stale row (#1706). */
const STALE_VERDICTS = new WeakMap();

function staleVerdictsFor(db) {
  let memo = STALE_VERDICTS.get(db);
  if (!memo) {
    memo = new Map();
    STALE_VERDICTS.set(db, memo);
  }
  return memo;
}

/** The registry version a recorded proposal spec pins, or null when unpinned. */
function pinnedRegistryVersion(specJson) {
  let spec;
  try {
    spec = JSON.parse(specJson);
  } catch {
    return null;
  }
  for (const value of [spec?.policyVersion, spec?.promptVersion]) {
    if (typeof value === "string" && value !== "" && value !== "unknown")
      return value;
  }
  return null;
}

/** True when the row's recorded spec pins a registry version other than serve's. */
function pinnedToOlderRegistry(row, registryVersion) {
  const pinned = pinnedRegistryVersion(row.proposal_spec_json);
  return pinned !== null && pinned !== registryVersion;
}

/**
 * Recheck and approve the currently open, eligible chain proposals once.
 * A second pass finds no approved proposal and therefore cannot double-approve.
 *
 * Returns a Promise, but does its work eagerly: with only synchronous
 * `approve.before` hooks (the built-in one) the whole pass completes before
 * the Promise is handed back, so a caller that ignores it (planAdmittedEvents)
 * still gets the pre-WM-842 behaviour. An asynchronous extension hook defers
 * the rest of the pass; `serve` awaits it. The Promise never rejects — every
 * fault is a typed reason on the proposal or an `errors` entry.
 *
 * Per tick the pass evaluates at most `maxRows` rows; the rest are counted in
 * `skipped`. A registry-stale row whose evaluation left it open is memoised per
 * (run_id, registryVersion) and skipped — without touching the control plane —
 * until `staleRevisitMs` elapses, the registry version changes, or the row is
 * re-planned into a fresh proposal (#1706). `memoised` counts those skips.
 *
 * @returns {Promise<{ approved: Array<{ proposalId: string, runId: string }>, open: Array<{ proposalId: string, reason: string }>, errors: Array<{ proposalId: string|null, reason: string, message: string }>, skipped: number, memoised: number }>}
 */
export function autoApproveChains(db, registry, options = {}) {
  const state = PASSES.get(db) ?? { tail: null };
  PASSES.set(db, state);
  // `settled` flips inside runPass's own frame, so a pass that never awaited
  // is known to be complete before this function returns and leaves no tail
  // for the next call to queue behind.
  const marker = { settled: false };
  const pass = state.tail
    ? state.tail.then(() => runPass(db, registry, options, marker))
    : runPass(db, registry, options, marker);
  if (!marker.settled) {
    state.tail = pass;
    pass.finally(() => {
      if (state.tail === pass) state.tail = null;
    });
  }
  return pass;
}

function resolvePolicyVersion(value) {
  return typeof value === "string" && value !== "" && value !== "unknown"
    ? value
    : factoryPolicyVersion();
}

/**
 * The pass itself. `marker.settled` is set in a `finally` inside this async
 * frame: if no `await` was reached (every hook answered synchronously) it is
 * true before the returned Promise even exists — the eager guarantee above.
 */
async function runPass(
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
    hooks = defaultHookRegistry(),
    hookTimeoutMs,
    maxRows = DEFAULT_MAX_CHAIN_AUTO_APPROVALS_PER_TICK,
    staleRevisitMs = DEFAULT_STALE_CHAIN_REVISIT_MS,
  } = {},
  marker = { settled: false },
) {
  const resolvedPolicyVersion = resolvePolicyVersion(policyVersion);
  try {
    const approved = [];
    const open = [];
    const errors = [];
    const limit =
      Number.isInteger(maxRows) && maxRows > 0
        ? maxRows
        : DEFAULT_MAX_CHAIN_AUTO_APPROVALS_PER_TICK;
    const revisitMs =
      Number.isFinite(staleRevisitMs) && staleRevisitMs >= 0
        ? staleRevisitMs
        : DEFAULT_STALE_CHAIN_REVISIT_MS;
    const memo = staleVerdictsFor(db);
    let skipped = 0;
    let memoised = 0;
    let evaluated = 0;
    // One in-flight read per repo for the whole pass, shared across every
    // proposal's eligibility recheck (#1064).
    const passDispatch = withPassInFlightCache(dispatch);
    let rows;
    try {
      rows = db
        .query(
          `SELECT p.id, p.run_id, p.event_source, p.event_id, p.spec_json AS proposal_spec_json, p.spec_hash AS proposal_spec_hash,
              p.created_at, p.ttl_seconds, e.type AS event_type, e.envelope_json,
              r.spec_json AS run_spec_json, r.spec_hash AS run_spec_hash
         FROM proposals p
         JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
         JOIN runs r ON r.run_id = p.run_id
        WHERE p.status = 'open' AND p.decision = 'run'
          AND e.source IN ('chain', 'handoff')
        ORDER BY p.created_at, p.rowid`,
        )
        .all();
    } catch (err) {
      errors.push({
        proposalId: null,
        reason: "pass_failed",
        message: String(err?.message ?? err),
      });
      return { approved, open, errors, skipped, memoised };
    }

    // Verdicts for rows that are no longer pending (decided, superseded,
    // re-planned under a new proposal id) or that were held under another
    // registry version are dead; drop them so the memo tracks the backlog.
    const live = new Map(
      rows.map((row) => [`${row.run_id}\0${resolvedPolicyVersion}`, row.id]),
    );
    for (const [key, held] of memo) {
      if (live.get(key) !== held.proposalId) memo.delete(key);
    }

    for (const row of rows) {
      const memoKey = `${row.run_id}\0${resolvedPolicyVersion}`;
      const stale = pinnedToOlderRegistry(row, resolvedPolicyVersion);
      const held = stale ? memo.get(memoKey) : undefined;
      if (held && held.proposalId === row.id && held.until > now) {
        skipped += 1;
        memoised += 1;
        continue;
      }
      if (evaluated >= limit) {
        skipped += 1;
        continue;
      }
      evaluated += 1;
      const hold = (reason) => {
        if (stale)
          memo.set(memoKey, {
            proposalId: row.id,
            reason,
            until: now + revisitMs,
          });
        else memo.delete(memoKey);
      };
      try {
        const age = now - Date.parse(row.created_at);
        let reason;
        if (age > row.ttl_seconds * 1000) reason = "proposal_expired";
        else {
          try {
            reason = eligible(db, row, registry, policy, {
              dispatchEligibility,
              dispatch: passDispatch,
              now,
              hooks,
              hookTimeoutMs,
            });
            if (isThenable(reason)) reason = await reason;
          } catch {
            reason = "approve_hooks_failed";
          }
        }
        if (reason) {
          noteOpenReason(db, row.id, reason);
          open.push({ proposalId: row.id, reason });
          hold(reason);
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
          // The guard is a live-capacity answer, not a property of the row.
          memo.delete(memoKey);
          continue;
        }
        try {
          const handoff = row.event_source === HANDOFF_APPROVAL_SOURCE;
          const outcome = approveProposal(db, registry, row.id, {
            actor: handoff
              ? HANDOFF_AUTO_APPROVAL_ACTOR
              : CHAIN_AUTO_APPROVAL_ACTOR,
            reason: handoff
              ? HANDOFF_AUTO_APPROVAL_REASON
              : CHAIN_AUTO_APPROVAL_REASON,
            now,
            policyVersion: resolvedPolicyVersion,
          });
          if (outcome.approved)
            approved.push({ proposalId: row.id, runId: outcome.runId });
          else {
            noteOpenReason(db, row.id, "replanned");
            open.push({ proposalId: row.id, reason: "replanned" });
          }
          // Approved, or re-planned into a fresh proposal id: nothing to hold.
          memo.delete(memoKey);
        } catch (err) {
          const message = String(err?.message ?? err);
          noteOpenReason(db, row.id, "approval_error");
          errors.push({
            proposalId: row.id,
            reason: "approval_error",
            message,
          });
          hold("approval_error");
        }
      } catch (err) {
        errors.push({
          proposalId: row.id,
          reason: "pass_row_failed",
          message: String(err?.message ?? err),
        });
        hold("pass_row_failed");
      }
    }
    return { approved, open, errors, skipped, memoised };
  } finally {
    marker.settled = true;
  }
}

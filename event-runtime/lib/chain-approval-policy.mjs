/** Git-owned policy values shared by planning and chain approval execution. */
import { existsSync, readFileSync } from "node:fs";

import { hashJson } from "./canonical.mjs";
import { resolveConfigPath } from "./config.mjs";
import { reposRoot } from "./repos.mjs";

export const CHAIN_APPROVAL_SOURCE = "chain";
export const HANDOFF_APPROVAL_SOURCE = "handoff";
export const CHAIN_APPROVAL_MODE_AUTO = "auto";
export const CHAIN_APPROVAL_MODE_WATCHED = "watched";
export const CHAIN_AUTO_APPROVAL_EVENT_TYPES = new Set([
  "factory.work.requested",
  "factory.triage.requested",
  "factory.triage-apply.requested",
  "factory.dispatch.requested",
  // ci-doctor@2 is non-mutating and gh:read-only; ci-rerun and dispatch
  // downstream edges retain their own approval gates.
  "factory.ci-diagnose.requested",
  "factory.merge.requested",
  "factory.merge-review.requested",
  "factory.merge-fix.requested",
  "factory.merge-plan.requested",
  "factory.merge-apply.requested",
  "factory.merge-landed",
  "factory.merge-verify.requested",
  "factory.merge-escalate.requested",
]);

export const MERGE_EVENT_TYPES = new Set([
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

export function chainApprovalPolicyPath(root = reposRoot()) {
  return resolveConfigPath("policy", { root });
}

export function clipReason(message, max = 180) {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Missing or malformed policy is no approval, never an implicit default. */
export function loadChainAutoApprovalPolicy({ root = reposRoot() } = {}) {
  const file = chainApprovalPolicyPath(root);
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
  } catch (err) {
    const message = String(err?.message ?? err);
    console.error(`policy_invalid: ${message}`);
    return {
      allowed: new Set(),
      reason: `policy_invalid:${clipReason(message)}`,
    };
  }
}

/** Build the immutable unattended approval policy embedded in a run spec. */
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

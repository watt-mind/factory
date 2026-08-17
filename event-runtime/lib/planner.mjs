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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  effectiveOwnedPaths,
  pathsCollide,
  parseOwnedPaths,
  readPinManifestRequirements,
  ownedPathsClosureGaps,
} from "../../orchestrator/owned-paths.mjs";
import { budgetExhausted } from "../../lib/spend.mjs";
import { liveWorkerLeases } from "../../lib/worker-leases.mjs";
import { findArtifact, pinRunArtifact } from "./artifacts.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { artifactsRoot, DEAD_LETTER_AFTER, DEFAULT_PROPOSAL_TTL_SECONDS, FACTORY_ROOT } from "./config.mjs";
import { isBusyError, tx, txImmediate } from "./db.mjs";
import { newProposalId, newRunId } from "./ids.mjs";
import { createRun, idempotencyKeyForNewRun, resolveIdempotency } from "./lifecycle.mjs";
import { getAgent, getEventType, resolveModel } from "./registry.mjs";
import { pinRepo } from "./repository.mjs";
import { RepoError, getRepo, loadRepos, reposConfigPath, reposRoot } from "./repos.mjs";
import { validate } from "./schema.mjs";
import { inFlightRunsForAgent } from "./schedules.mjs";
import { resolveInputRef } from "./workspace.mjs";
import { autoApproveChains, buildChainApprovalPolicy } from "./auto-approval.mjs";

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
 * Per-agent repo scoping (WM-64), the repo analogue of the actions adapter's
 * host allowlist: a definition that declares `repos` may only run over those
 * repos. Applies to any input carrying a `repo` field, whatever the workspace
 * or adapter. Returns the typed refusal reason, or null when in scope (no
 * `repos` declared, or no `repo` in the payload, or a member of the set).
 */
export function repoNotAllowed(def, payload) {
  if (!Array.isArray(def.repos) || typeof payload?.repo !== "string") return null;
  if (def.repos.includes(payload.repo)) return null;
  return `repo_not_allowed: ${def.ref} may not run over ${payload.repo} (allowed: ${def.repos.join(", ")})`;
}

/**
 * Pure assembly of the §5.2 RunSpec from a registered mapping. No I/O, no
 * clock reads beyond the injected `now` — same inputs, same spec, always.
 */
export function buildRunSpec(registry, envelope, mapping, { runId, policyVersion, adapterOverride, now = Date.now(), approvalPolicy = null } = {}) {
  const def = getAgent(registry, mapping.agent);
  let payload = envelope.payload;
  if (def.workspace?.type === "repository" && payload?.repo) {
    try {
      payload = { ...payload, repoPin: pinRepo(payload.repo, payload.ref ?? undefined) };
    } catch (err) {
      if (!payload?.repoPin) throw err;
    }
  }
  const inputHash = hashJson(payload);
  const placement = def.placement ?? mapping.placement ?? undefined;
  const specEnvelope = payload === envelope.payload ? envelope : { ...envelope, payload };
  let idempotencyKey = idempotencyKeyFor(mapping, def, specEnvelope, inputHash);
  const correlation = envelope.correlationId ?? envelope.eventId ?? null;
  if (correlation && !mapping.idempotencyScope.includes("correlationId") && !mapping.idempotencyScope.includes("eventId")) {
    idempotencyKey = `${idempotencyKey}:${correlation}`;
  }
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: mapping.agent,
    input: payload,
    inputHash,
    workspace: def.workspace,
    adapter: adapterOverride ?? mapping.adapter,
    promptVersion: policyVersion,
    policyVersion,
    outputContract: def.output_contract,
    capabilities: def.capabilities.services,
    // Declared repo scope (WM-64) rides in the spec so the proposal the
    // operator approves names it, same as capabilities.
    ...(def.repos ? { repos: def.repos } : {}),
    // Model-tier routing (WM-135), the house repoPin pattern: the tier is
    // resolved HERE, at plan time, and the concrete value is pinned so the
    // proposal, receipt, and inspect output all name the exact model. Fields
    // appear only when the definition declares intent — an undeclared
    // definition's spec is byte-identical to before (regression contract).
    // Resolution keys off the REGISTERED adapter (mapping.adapter), not the
    // override: `--adapter-override fake` substitutes execution, and the fake
    // ignores the model; the spec still records what was routed. A null model
    // means the routed adapter takes none (not applicable).
    ...(def.model_tier !== undefined || def.model !== undefined
      ? { modelTier: def.model_tier ?? null, model: resolveModel(def, mapping.adapter, registry.modelTiers) }
      : {}),
    timeoutSeconds: def.limits.timeout_seconds,
    maxAttempts: def.limits.attempts,
    ...(approvalPolicy ? { approvalPolicy } : {}),
    idempotencyKey,
    ...(placement ? { placement } : {}),
  };
}

/** Default cap when neither repo nor policy config supplies one. */
export const DEFAULT_MAX_IN_FLIGHT = 3;

function resolveNow(now) {
  return typeof now === "function" ? now() : now;
}

function linearCli() {
  return path.join(FACTORY_ROOT, "tools", "linear.mjs");
}

function fetchTicketDefault(ticketId) {
  try {
    return JSON.parse(execFileSync("bun", [linearCli(), "get", ticketId, "--json"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    if (stderr.includes("no such issue")) return null;
    throw new Error(`linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`);
  }
}

const IN_FLIGHT_QUERY =
  `query($t:String!,$p:String!){ issues(first:250, filter:{ team:{key:{eq:$t}}, project:{name:{eq:$p}}, state:{name:{eq:"In Progress"}} }){ nodes{ identifier description } } }`;

const OWNED_PATHS_CLOSURE_CACHE = new Map();

function ownedPathsClosureDetails(repoName, repo, ticketDescription) {
  if (!repo?.ownedPathsPolicy) return [];
  const cacheKey = `${repoName}::${repo.path}`;
  if (!OWNED_PATHS_CLOSURE_CACHE.has(cacheKey)) {
    const requirements = repo.ownedPathsPolicy.pinManifests?.length
      ? readPinManifestRequirements(repo.path, repo.ownedPathsPolicy.pinManifests)
      : [];
    OWNED_PATHS_CLOSURE_CACHE.set(cacheKey, requirements);
  }
  const requirements = OWNED_PATHS_CLOSURE_CACHE.get(cacheKey);
  const ownedPaths = parseOwnedPaths(ticketDescription ?? "");
  return ownedPathsClosureGaps({
    ownedPaths,
    ownedPathsPolicy: repo.ownedPathsPolicy,
    pinManifestRequirements: requirements,
  });
}

function fetchInFlightDefault(repoConfig) {
  try {
    const out = execFileSync("bun", [linearCli(), "raw", IN_FLIGHT_QUERY, "--var", `t=${repoConfig.team}`, "--var", `p=${repoConfig.project}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out)?.issues?.nodes ?? [];
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    throw new Error(`linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`);
  }
}

function policyMaxInFlight(root = reposRoot()) {
  const file = path.join(root, "config", "policy.yaml");
  if (!existsSync(file)) return DEFAULT_MAX_IN_FLIGHT;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.concurrency?.max_in_flight_per_repo;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_IN_FLIGHT;
  } catch {
    return DEFAULT_MAX_IN_FLIGHT;
  }
}

/** Fail-safe merge admission cap when policy is absent or malformed. */
export const DEFAULT_MAX_CONCURRENT_MERGES = 1;

export function policyMaxConcurrentMerges(root = reposRoot()) {
  const file = path.join(root, "config", "policy.yaml");
  if (!existsSync(file)) return DEFAULT_MAX_CONCURRENT_MERGES;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.concurrency?.max_concurrent_merges;
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CONCURRENT_MERGES;
  } catch {
    return DEFAULT_MAX_CONCURRENT_MERGES;
  }
}

function agentSingletonEnabled(registry, agentRef) {
  return Object.values(registry.schedules ?? {}).some((candidate) =>
    candidate.enabled &&
    candidate.singleton !== false &&
    registry.eventTypes?.[candidate.eventType]?.agent === agentRef
  );
}

function singletonApplies(registry, envelope, agentRef) {
  const loop = envelope.payload?.loop;
  const schedule = loop ? registry.schedules?.[loop] : null;
  if (schedule && registry.eventTypes?.[schedule.eventType]?.agent === agentRef) {
    return schedule.singleton !== false;
  }
  return agentSingletonEnabled(registry, agentRef);
}

function loadRepoEscalatePaths(repoName, root = reposRoot()) {
  const file = reposConfigPath(root);
  if (!existsSync(file)) {
    throw new RepoError(`${file}: cannot verify escalate_paths because repos.yaml is missing`);
  }
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RepoError(`${file}: cannot verify escalate_paths: ${err.message}`);
  }
  const entry = (parsed?.repos ?? []).find((row) => row?.name === repoName);
  if (!entry) {
    throw new RepoError(`${file}: cannot verify escalate_paths for unknown repo ${repoName}`);
  }
  const escalate = entry.escalate_paths ?? entry.escalatePaths;
  if (!Array.isArray(escalate)) {
    throw new RepoError(
      `${file}: repo ${repoName} must declare escalate_paths as an array (use [] only when deliberately empty)`,
    );
  }
  if (
    !escalate.every(
      (item) => typeof item === "string" && item.trim().length > 0,
    )
  ) {
    throw new RepoError(
      `${file}: repo ${repoName} has invalid escalate_paths (every glob must be a non-empty string)`,
    );
  }
  return [...new Set(escalate.map((item) => item.trim()))];
}

function loadRuntimePolicy(root = reposRoot()) {
  const file = path.join(root, "config", "policy.yaml");
  if (!existsSync(file)) return null;
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function defaultBudgetRefusal() {
  const policy = loadRuntimePolicy();
  if (!policy) return "budget_policy_unavailable";
  return budgetExhausted(policy) ? "budget_exhausted" : null;
}

function sortUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort();
}

function evidenceTicket(ticket, ticketId) {
  const description = ticket?.description ?? "";
  const parsed = parseOwnedPaths(description);
  return {
    id: ticketId,
    state: ticket?.state?.name ?? null,
    assigneeNull: !ticket?.assignee,
    labels: sortUnique((ticket?.labels?.nodes ?? []).map((label) => label?.name).filter(Boolean)),
    ownedPaths: effectiveOwnedPaths(description),
    ownedPathsParsed: parsed.length > 0,
    descriptionHash: hashJson(description),
  };
}

function evidenceInFlight(issue) {
  const description = issue.description ?? "";
  const parsed = parseOwnedPaths(description);
  return {
    id: issue.identifier,
    descriptionHash: hashJson(description),
    ownedPaths: effectiveOwnedPaths(description),
    ownedPathsParsed: parsed.length > 0,
  };
}

function refusal(reason, evidence, decision = "noop") {
  return { ok: false, refusal: { decision, reason }, evidence };
}

/**
 * The shared dispatch proof used at plan time and immediately before a chain
 * auto-approval. Its evidence captures every fact the latter needs to compare.
 */
export function worktreeDispatchAutoEligibility(payload, {
  fetchTicket = fetchTicketDefault,
  fetchInFlight = fetchInFlightDefault,
  countLeases = (repoName) => liveWorkerLeases(repoName).length,
  maxInFlightFallback,
  budgetRefusal = defaultBudgetRefusal,
  now = Date.now(),
} = {}) {
  const evidence = {
    checkedAt: new Date(resolveNow(now)).toISOString(),
    repo: {},
    checks: {},
    ticket: null,
    inFlight: [],
    escalatePathIntersections: [],
  };
  let repo;
  try {
    repo = getRepo(loadRepos(), payload?.repo);
  } catch (err) {
    evidence.checks.repo_found = false;
    return refusal(`repo_unknown: ${err.message}`, evidence, "human_needed");
  }
  const cap = repo.maxInFlight ?? maxInFlightFallback ?? policyMaxInFlight();
  const live = countLeases(repo.name);
  evidence.repo = {
    name: repo.name,
    team: repo.team ?? null,
    project: repo.project ?? null,
    capLimit: cap,
    capCurrent: live,
    capSource: repo.maxInFlight === null || repo.maxInFlight === undefined ? "policy.yaml: max_in_flight_per_repo" : "repo.max_in_flight",
  };
  evidence.checks.repo_found = true;
  if (repo.reportOnly) return refusal("repo_report_only", evidence, "human_needed");
  evidence.checks.repo_is_dispatchable = true;
  if (!repo.worktreeUp || !repo.worktreeDown || !repo.worktreeRoot) return refusal("no_worktree_scripts", evidence, "human_needed");
  evidence.checks.worktree_scripts_configured = true;

  let budgetReason;
  try {
    budgetReason = budgetRefusal();
  } catch {
    budgetReason = "budget_check_failed";
  }
  if (budgetReason) return refusal(budgetReason, evidence);
  evidence.checks.budget_available = true;

  if (live >= cap) return refusal("capacity_full", evidence);
  evidence.checks.cap_available = true;

  const ticket = fetchTicket(payload?.ticket);
  evidence.ticket = evidenceTicket(ticket, payload?.ticket);
  if (!ticket) return refusal("ticket_not_found", evidence, "human_needed");
  evidence.checks.ticket_found = true;
  if (ticket.assignee) return refusal("ticket_assigned", evidence);
  evidence.checks.ticket_unassigned = true;
  if (ticket.state?.name !== "Todo") return refusal("ticket_not_todo", evidence);
  evidence.checks.ticket_todo = true;
  if (!evidence.ticket.labels.includes("ai:agent-ready")) return refusal("ticket_not_agent_ready", evidence);
  evidence.checks.ticket_agent_ready = true;
  if (evidence.ticket.labels.includes("ai:escalated")) {
    return refusal("ticket_escalated", evidence);
  }

  try {
    const gaps = ownedPathsClosureDetails(repo.name, repo, ticket.description);
    if (gaps.length) {
      return refusal("owned_paths_not_closed", evidence, "human_needed");
    }
  } catch (err) {
    return refusal(`owned_paths_not_closed: ${err.message || String(err)}`, evidence, "human_needed");
  }

  evidence.checks.ticket_not_escalated = true;
  if (
    evidence.ticket.labels.includes("type:security") ||
    evidence.ticket.labels.some((label) => /security/i.test(label))
  ) {
    return refusal("ticket_security", evidence);
  }
  evidence.checks.ticket_not_security = true;
  if (!repo.team || !repo.project) return refusal("repo_unconfigured: team/project missing for the in-flight query", evidence, "human_needed");
  evidence.checks.repo_team_project = true;

  const inFlight = fetchInFlight(repo);
  evidence.inFlight = inFlight.filter((issue) => String(issue.identifier) !== String(payload?.ticket)).map(evidenceInFlight);
  if (pathsCollide(evidence.ticket.ownedPaths, evidence.inFlight.flatMap((issue) => issue.ownedPaths))) {
    evidence.checks.owned_paths_disjoint = false;
    return refusal("owned_paths_overlap", evidence);
  }
  evidence.checks.owned_paths_disjoint = true;
  try {
    evidence.repo.escalatePaths = loadRepoEscalatePaths(repo.name);
  } catch (err) {
    evidence.checks.escalate_paths = { verified: false };
    return refusal(`escalate_paths_unverifiable: ${err.message}`, evidence, "human_needed");
  }
  evidence.escalatePathIntersections = evidence.repo.escalatePaths.filter(
    (item) => pathsCollide(evidence.ticket.ownedPaths, [item]),
  );
  evidence.checks.escalate_paths = {
    verified: true,
    configured: evidence.repo.escalatePaths.length > 0,
    intersect: evidence.escalatePathIntersections,
  };
  if (evidence.escalatePathIntersections.length > 0) {
    return refusal("escalate_paths_intersect", evidence);
  }
  evidence.checks.owned_paths_parsed = evidence.ticket.ownedPathsParsed;
  return { ok: true, evidence };
}

/**
 * Plan-time dispatch refusal verdict. Existing callers retain the historical
 * null-or-refusal contract while auto-approval consumes the richer proof.
 */
export function worktreeDispatchGate(payload, options = {}) {
  const result = worktreeDispatchAutoEligibility(payload, options);
  return result.ok ? null : result.refusal;
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

function isIdempotencyKeyCollision(err) {
  return err?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed: runs\.idempotency_key/.test(String(err?.message ?? err));
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
export function planEvent(db, registry, { source, eventId }, { now = Date.now(), policyVersion = "unknown", adapterOverride, artifactStore = artifactsRoot(), dispatch = {} } = {}) {
  // Dispatch gate for tier-2 worktree agents (WM-108), evaluated BEFORE the
  // write transaction: its Linear and lease reads must never hold the SQLite
  // write lock across a network round trip. The verdict is applied inside the
  // transaction only when the event is still admitted there — a raced plan
  // simply discards it via the idempotent early return.
  let worktreeRefusal = null;
  {
    const row = db.query(`SELECT status, envelope_json FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (row?.status === "admitted") {
      const preEnvelope = JSON.parse(row.envelope_json);
      const preMapping = getEventType(registry, preEnvelope.type);
      const preDef = preMapping && preMapping.observe !== true ? registry.agents.get(preMapping.agent) : null;
      // An event already outside the definition's repo scope (WM-64) skips
      // the gate's Linear/lease reads entirely — the transaction below parks
      // it repo_not_allowed before anything else happens.
      if (
        preDef?.workspace?.type === "worktree" &&
        preDef?.ref !== "merge-fix@1" &&
        typeof preEnvelope.payload?.repo === "string" &&
        typeof preEnvelope.payload?.ticket === "string" &&
        !repoNotAllowed(preDef, preEnvelope.payload)
      ) {
        worktreeRefusal = worktreeDispatchGate(preEnvelope.payload, dispatch);
      }
    }
  }
  return txImmediate(db, () => {
    const event = db.query(`SELECT * FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (!event) throw new Error(`no admitted event (${source}, ${eventId})`);
    if (event.status !== "admitted") return existingOutcome(db, event);

    const envelope = JSON.parse(event.envelope_json);
    const at = new Date(now).toISOString();

    const mapping = getEventType(registry, envelope.type);
    if (!mapping) return humanNeeded(db, event, "unregistered_event_type", at, DEFAULT_PROPOSAL_TTL_SECONDS);
    const ttlSeconds = mapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;

    // Observe-only types (WM-75): the orchestrator reporting its own
    // lifecycle. The event is the deliverable — admitted, journaled,
    // queryable — and the plan is a typed NOOP, never an inbox ask.
    if (mapping.observe === true) {
      const proposal = insertProposal(db, {
        id: newProposalId(), event, decision: "noop", status: "resolved",
        reason: "observed", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, reason: "observed" };
    }

    const def = getAgent(registry, mapping.agent);

    // Per-agent repo scoping (WM-64): checked before anything else the plan
    // would do for the run — no repo pin, no mirror fetch, no worktree
    // materialization for a repo the definition may never touch. Same idea as
    // the actions adapter's host allowlist, enforced at plan time.
    const scopeRefusal = repoNotAllowed(def, envelope.payload);
    if (scopeRefusal) return humanNeeded(db, event, scopeRefusal, at, ttlSeconds);

    // §5 singleton is agent policy, not clock-envelope policy: operator and
    // chain origins mapped to an enabled singleton agent must not bypass it by
    // omitting payload.loop. Merge scans additionally obey the git-owned
    // global admission cap even when a concrete schedule opts out of
    // singleton behavior. PROPOSED remains excluded (OPS-436).
    const inFlight = inFlightRunsForAgent(db, mapping.agent);
    const singletonBlocked = singletonApplies(registry, envelope, mapping.agent) && inFlight.length > 0;
    const mergeCap = envelope.type === "factory.merge.requested" ? policyMaxConcurrentMerges() : null;
    const mergeCapBlocked = mergeCap !== null && inFlight.length >= mergeCap;
    if (singletonBlocked || mergeCapBlocked) {
      const blockingRun = inFlight[0];
      const proposal = insertProposal(db, {
        id: newProposalId(), event, runId: blockingRun.run_id, decision: "noop", status: "resolved",
        reason: "previous_run_in_flight", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return {
        decision: "noop",
        proposal,
        runId: blockingRun.run_id,
        reason: "previous_run_in_flight",
      };
    }

    const input = validate(def.inputSchema, envelope.payload);
    if (!input.valid) return humanNeeded(db, event, `invalid_input: ${input.errors[0]}`, at, ttlSeconds);

    // Tier-2 dispatch gate verdict (docs/event-runtime-dispatch.md §§2–5,
    // WM-108), computed above outside this transaction. Refusals are typed
    // and carry their reason; a null verdict means every check passed at the
    // moment of the read — the doc's execute-time re-check owns the TTL gap.
    if (def.workspace?.type === "worktree" && def.ref !== "merge-fix@1" && worktreeRefusal) {
      if (worktreeRefusal.decision === "human_needed") {
        return humanNeeded(db, event, worktreeRefusal.reason, at, ttlSeconds);
      }
      const proposal = insertProposal(db, {
        id: newProposalId(), event, decision: "noop", status: "resolved",
        reason: worktreeRefusal.reason, at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, reason: worktreeRefusal.reason };
    }

    // §7 tier 1 (OPS-228): a repository workspace resolves its ref to an
    // immutable SHA *now*, so the pin is inside the spec's input (and its
    // inputHash, and the receipt). A run therefore names the exact tree it
    // read, and dedup distinguishes "same repo, new commit".
    let payload = envelope.payload;
    // A run reference resolves to that run's stored transcript at plan time
    // (OPS-373): the cross-run case, where the bytes come from a run this one
    // has no chain relationship with.
    if (
      def.workspace?.type === "artifacts" &&
      (def.workspace.inputs ?? []).some((i) => typeof i.from === "string" && i.from.startsWith("$.input.runPin."))
    ) {
      try {
        payload = { ...payload, runPin: pinRunArtifact(db, payload.runId) };
      } catch (err) {
        return humanNeeded(db, event, `run_pin_failed: ${err.message}`, at, ttlSeconds);
      }
    }
    // Declared artifact inputs must exist in the store at plan time (OPS-372):
    // proposing a run whose bytes are missing wastes an approval, and the
    // operator should see the failure before deciding, not after.
    if (def.workspace?.type === "artifacts") {
      for (const entry of def.workspace.inputs ?? []) {
        try {
          const sha = resolveInputRef(payload, entry.from);
          if (!findArtifact(artifactStore, sha)) {
            return humanNeeded(db, event, `artifact_missing: ${entry.as} (${sha})`, at, ttlSeconds);
          }
        } catch (err) {
          return humanNeeded(db, event, `artifact_ref_failed: ${err.message}`, at, ttlSeconds);
        }
      }
    }
    if (def.workspace?.type === "repository") {
      try {
        payload = { ...payload, repoPin: pinRepo(payload.repo, payload.ref ?? undefined) };
      } catch (err) {
        return humanNeeded(db, event, `repo_pin_failed: ${err.message}`, at, ttlSeconds);
      }
    }

    const pinnedEnvelope = payload === envelope.payload ? envelope : { ...envelope, payload };
    if (pinnedEnvelope !== envelope) {
      db.query(`UPDATE events SET envelope_json = ? WHERE source = ? AND event_id = ?`)
        .run(canonicalJson(pinnedEnvelope), event.source, event.event_id);
    }
    let idempotencyKey = idempotencyKeyFor(mapping, def, pinnedEnvelope, hashJson(payload));
    const correlation = envelope.correlationId ?? envelope.eventId ?? null;
    if (correlation && !mapping.idempotencyScope.includes("correlationId") && !mapping.idempotencyScope.includes("eventId")) {
      idempotencyKey = `${idempotencyKey}:${correlation}`;
    }
    const existingRun = resolveIdempotency(db, {
      idempotencyKey,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      eventId: envelope.eventId,
    });
    if (existingRun) {
      const proposal = insertProposal(db, {
        id: newProposalId(), event, runId: existingRun.run_id, decision: "noop",
        idempotencyKey, status: "resolved", reason: "duplicate_run", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, runId: existingRun.run_id, reason: "duplicate_run" };
    }

    // A terminal generation releases the family for another trigger. Keep the
    // schema's concrete-key UNIQUE guarantee by deriving a generation key from
    // the admitted event; resolveIdempotency still coalesces over the family.
    idempotencyKey = idempotencyKeyForNewRun(db, {
      idempotencyKey,
      source: event.source,
      eventId: event.event_id,
    });
    const runId = newRunId();

    let approvalPolicy = null;
    if (envelope.source === "chain") {
      approvalPolicy = buildChainApprovalPolicy(envelope.type, { source: envelope.source });
      if (approvalPolicy?.mode === "auto" && envelope.type === "factory.dispatch.requested") {
        const result = worktreeDispatchAutoEligibility(pinnedEnvelope.payload, dispatch);
        if (!result?.ok) {
          return humanNeeded(db, event, `dispatch_eligibility_check_failed_at_plan: ${result?.refusal?.reason ?? "unknown"}`, at, ttlSeconds);
        }
        approvalPolicy = {
          ...approvalPolicy,
          dispatchEvidence: result.evidence,
        };
      }
    }

    const spec = {
      ...buildRunSpec(registry, pinnedEnvelope, mapping, {
        runId,
        policyVersion,
        adapterOverride,
        now,
        approvalPolicy,
      }),
      idempotencyKey,
    };
    const specJson = canonicalJson(spec);
    const specHash = hashJson(spec);
    try {
      createRun(db, {
        runId, idempotencyKey, spec, specJson, specHash,
        actor: "planner",
        correlationId: envelope.correlationId ?? null,
        causationId: envelope.causationId ?? null,
        policyVersion, now,
      });
    } catch (err) {
      if (!isIdempotencyKeyCollision(err)) throw err;
      const winner = resolveIdempotency(db, { idempotencyKey });
      if (!winner) throw err;
      const reason = `idempotency_collision:${winner.run_id}`;
      const proposal = insertProposal(db, {
        id: newProposalId(), event, runId: winner.run_id, decision: "noop",
        idempotencyKey, status: "resolved", reason, at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, runId: winner.run_id, reason };
    }
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
  return txImmediate(db, () => {
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
      `UPDATE events
       SET status = 'admitted', plan_failures = 0, last_plan_error = NULL, archived_at = NULL
       WHERE source = ? AND event_id = ?`,
    ).run(source, eventId);
    return { requeued: true };
  });
}

/**
 * Acknowledge a dead-letter without rewriting its historical status or error.
 * The archive marker removes it from the active doctor deck while preserving
 * the event in the ledger and allowing a later explicit requeue.
 */
export function archiveDeadLetteredEvent(db, { source, eventId }, { now = Date.now() } = {}) {
  return txImmediate(db, () => {
    const event = db
      .query(`SELECT status, archived_at FROM events WHERE source = ? AND event_id = ?`)
      .get(source, eventId);
    if (!event) throw new Error(`unknown event (${source}, ${eventId})`);
    if (event.status !== "dead_lettered") {
      throw new Error(`archive applies to dead_lettered events, not ${event.status}`);
    }
    if (!event.archived_at) {
      db.query(`UPDATE events SET archived_at = ? WHERE source = ? AND event_id = ?`)
        .run(new Date(now).toISOString(), source, eventId);
    }
    return { archived: true };
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
      if (isBusyError(err)) {
        continue;
      }
      failed += 1;
      const message = String(err?.message ?? err);
      try {
        const failures = txImmediate(db, () => {
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
      } catch (innerErr) {
        if (isBusyError(innerErr)) {
          failed -= 1;
          continue;
        }
        throw innerErr;
      }
    }
  }
  // A bounded pass over open chain proposals: successful decisions leave the
  // candidate set, while every failed proof remains open with a typed reason.
  // This stays after planning so no approval happens inside a planner write
  // transaction or before the proposal has a persisted immutable RunSpec.
  autoApproveChains(db, registry, {
    now: opts.now ?? Date.now(),
    policyVersion: opts.policyVersion ?? "unknown",
    dispatchEligibility: worktreeDispatchAutoEligibility,
    dispatch: opts.dispatch ?? {},
  });
  return { planned, failed, deadLettered };
}

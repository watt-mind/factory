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
  globToRegExp,
  hardPathConflicts,
  pathOverlaps,
  pathsCollide,
  parseOwnedPaths,
  readPinManifestRequirements,
  ownedPathsClosureGaps,
} from "../../orchestrator/owned-paths.mjs";
import { openBlockers } from "../../orchestrator/blockers.mjs";
import { loadForge } from "../../lib/forge/index.mjs";
import { budgetExhausted } from "../../lib/spend.mjs";
import { liveWorkerLeases } from "../../lib/worker-leases.mjs";
import { findArtifact, pinRunArtifact } from "./artifacts.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { resolveConfigPath } from "./config.mjs";
import { isTrustedAssociation } from "./triage.mjs";
import { listMemos } from "./memos.mjs";
import {
  artifactsRoot,
  DEAD_LETTER_AFTER,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_PROPOSAL_TTL_SECONDS,
  FACTORY_ROOT,
} from "./config.mjs";
import { isBusyError, tx, txImmediate } from "./db.mjs";
import { newProposalId, newRunId } from "./ids.mjs";
import {
  TERMINAL_STATES,
  createRun,
  idempotencyKeyForNewRun,
  resolveIdempotency,
} from "./lifecycle.mjs";
import {
  getAgent,
  getEventType,
  MODEL_TIERS,
  resolveModel,
} from "./registry.mjs";
import {
  knownAdapters,
  listOverrides,
  overlayForAgent,
  overlayForEventType,
  plannedDef,
} from "./runtime-overrides.mjs";
import { pinRepo } from "./repository.mjs";
import {
  RepoError,
  getRepo,
  loadRepos,
  reposConfigPath,
  reposRoot,
} from "./repos.mjs";
import { validate } from "./schema.mjs";
import { inFlightRunsForAgent } from "./schedules.mjs";
import { resolveInputRef } from "./workspace.mjs";
import {
  autoApproveChains,
  buildChainApprovalPolicy,
} from "./auto-approval.mjs";
import {
  LINEAR_RATE_LIMIT_EXIT,
  LinearRateLimitError,
  isLinearRateLimitMessage,
  isLinearRateLimited,
} from "../../tools/linear.mjs";

/** In-flight issues list is stable across one scan; 60s is the ticket cap. */
export const IN_FLIGHT_CACHE_TTL_MS = 60_000;
export { DEFAULT_MAX_IN_FLIGHT };

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
        throw new Error(
          `unknown idempotency scope field "${field}" (docs/event-runtime.md §5.4 — fail closed)`,
        );
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
  if (!Array.isArray(def.repos) || typeof payload?.repo !== "string")
    return null;
  if (def.repos.includes(payload.repo)) return null;
  return `repo_not_allowed: ${def.ref} may not run over ${payload.repo} (allowed: ${def.repos.join(", ")})`;
}

function pinEntryFromRow(row) {
  return {
    sha256: row.sha256,
    subject: row.subject,
    kind: row.kind,
    runId: row.runId,
    createdAt: row.createdAt,
  };
}

/**
 * Fold every declared memo subject into `payload.memoPin` (docs/event-runtime-memos.md
 * §4.2). Empty fold → empty `entries`. When the payload already carries a pin
 * whose entries match this fold, keep `foldedAt` so a TTL re-plan does not
 * churn `inputHash`; a new live memo changes entries and re-admits work.
 */
export function pinMemos(
  db,
  def,
  payload,
  { now = Date.now(), descriptionHash, headSha } = {},
) {
  const declarations = def?.memos;
  if (!Array.isArray(declarations) || declarations.length === 0) return payload;
  const seen = new Set();
  const entries = [];
  for (const decl of declarations) {
    let id;
    try {
      id = resolveInputRef(payload, decl.subject.id);
    } catch {
      // Optional input path absent this run: skip the subject, do not fail.
      continue;
    }
    const folded = listMemos(
      db,
      { type: decl.subject.type, id },
      {
        kinds: decl.kinds,
        max: decl.max,
        now,
        descriptionHash:
          decl.subject.type === "ticket" ? descriptionHash : undefined,
        headSha: decl.subject.type === "repo" ? headSha : undefined,
      },
    );
    for (const row of folded) {
      if (seen.has(row.sha256)) continue;
      seen.add(row.sha256);
      entries.push(pinEntryFromRow(row));
    }
  }
  const existing = payload?.memoPin;
  if (
    existing &&
    typeof existing === "object" &&
    canonicalJson(existing.entries ?? null) === canonicalJson(entries)
  ) {
    return payload;
  }
  return {
    ...payload,
    memoPin: {
      foldedAt: new Date(now).toISOString(),
      entries,
    },
  };
}

/**
 * Closed identifiers for `def.harness.{skills,commands,subagents}` (WM-851).
 * No slashes: namespaced third-party pack names wait on WM-849's catalog.
 */
export const HARNESS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const HARNESS_KINDS = Object.freeze(["skills", "commands", "subagents"]);

/**
 * Shape-check an agent definition's `harness` block. Pure: no catalog I/O —
 * unknown names are a worker refusal, not a plan-time fetch.
 * Absent field → undefined so undeclared specs stay byte-identical.
 */
export function harnessFromDef(def) {
  if (def?.harness === undefined) return undefined;
  return normalizeHarness(def.harness, def.ref ?? def.id ?? "harness");
}

export function normalizeHarness(raw, source = "harness") {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${source}: "harness" must be an object { skills?, commands?, subagents? }`,
    );
  }
  const allowed = new Set(HARNESS_KINDS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${source}: "harness" unknown key "${key}" (allowed: ${HARNESS_KINDS.join(", ")})`,
      );
    }
  }
  const out = {};
  for (const kind of HARNESS_KINDS) {
    if (raw[kind] === undefined) continue;
    const names = raw[kind];
    const wellFormed =
      Array.isArray(names) &&
      names.every((n) => typeof n === "string" && HARNESS_NAME_PATTERN.test(n));
    if (!wellFormed) {
      throw new Error(
        `${source}: "harness.${kind}" must be an array of names matching ${HARNESS_NAME_PATTERN}`,
      );
    }
    out[kind] = [...names];
  }
  return out;
}

/**
 * Pure assembly of the §5.2 RunSpec from a registered mapping. No I/O, no
 * clock reads beyond the injected `now` — same inputs, same spec, always.
 */
export function buildRunSpec(
  registry,
  envelope,
  mapping,
  {
    runId,
    policyVersion,
    adapterOverride,
    now = Date.now(),
    approvalPolicy = null,
    modelTierOverride,
    modelOverride,
  } = {},
) {
  const def = getAgent(registry, mapping.agent);
  const planned = plannedDef(def, { modelTierOverride, modelOverride });
  let payload = envelope.payload;
  if (def.workspace?.type === "repository" && payload?.repo) {
    try {
      payload = {
        ...payload,
        repoPin: pinRepo(payload.repo, payload.ref ?? undefined),
      };
    } catch (err) {
      if (!payload?.repoPin) throw err;
    }
  }
  const inputHash = hashJson(payload);
  const placement = def.placement ?? mapping.placement ?? undefined;
  const specEnvelope =
    payload === envelope.payload ? envelope : { ...envelope, payload };
  let idempotencyKey = idempotencyKeyFor(mapping, def, specEnvelope, inputHash);
  const correlation = envelope.correlationId ?? envelope.eventId ?? null;
  if (
    correlation &&
    !mapping.idempotencyScope.includes("correlationId") &&
    !mapping.idempotencyScope.includes("eventId")
  ) {
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
    // Declared harness content (WM-851): skills/commands/subagents the
    // worker materializes into the run workspace. Omitted when the
    // definition does not declare the field, so undeclared specs stay
    // byte-identical to before.
    ...(def.harness !== undefined ? { harness: harnessFromDef(def) } : {}),
    // Model-tier routing (WM-135), the house repoPin pattern: the tier is
    // resolved HERE, at plan time, and the concrete value is pinned so the
    // proposal, receipt, and inspect output all name the exact model. Fields
    // appear only when the definition declares intent — an undeclared
    // definition's spec is byte-identical to before (regression contract).
    // Resolution keys off mapping.adapter. Process-wide `--adapter-override`
    // substitutes execution only (fake still pins the registered route's
    // model). A runtime overlay (WM-887) changes mapping.adapter itself so
    // the model follows the effective harness. A null model means the routed
    // adapter takes none (not applicable).
    ...(modelTierOverride !== undefined ||
    planned.model_tier !== undefined ||
    planned.model !== undefined
      ? {
          modelTier: modelTierOverride ?? planned.model_tier ?? null,
          model: resolveModel(planned, mapping.adapter, registry.modelTiers),
        }
      : {}),
    timeoutSeconds: def.limits.timeout_seconds,
    maxAttempts: def.limits.attempts,
    ...(approvalPolicy ? { approvalPolicy } : {}),
    idempotencyKey,
    ...(placement ? { placement } : {}),
  };
}

function resolveNow(now) {
  return typeof now === "function" ? now() : now;
}

function linearCli() {
  return path.join(FACTORY_ROOT, "tools", "linear.mjs");
}

function throwIfLinearCliRateLimited(err) {
  const stderr = String(err?.stderr ?? "");
  const stdout = String(err?.stdout ?? "");
  const combined = `${stderr}\n${stdout}`;
  if (
    err?.status === LINEAR_RATE_LIMIT_EXIT ||
    isLinearRateLimitMessage(combined)
  ) {
    let resetAt = null;
    for (const line of combined.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.resetAt) resetAt = parsed.resetAt;
      } catch {
        // not the rate-limit payload
      }
    }
    throw new LinearRateLimitError(resetAt, err);
  }
}

export function createLinearReadCache() {
  return {
    tickets: new Map(),
    inFlight: new Map(),
    viewer: { value: undefined },
    rateLimitError: null,
    rateLimitedUntil: 0,
    inFlightCalls: 0,
  };
}

/**
 * One planning pass / one scan run: memoize ticket reads for the run and
 * in-flight lists by team+project for ≤60s. A rate-limit throw is remembered
 * so later candidates in the same pass do not hit Linear again.
 */
export function wrapLinearReads(dispatch = {}, cache, now) {
  const resolveNow = () => {
    const clock = now ?? Date.now;
    return typeof clock === "function" ? clock() : clock;
  };
  const throwIfLimited = () => {
    if (!cache.rateLimitError) return;
    if (resolveNow() < cache.rateLimitedUntil) throw cache.rateLimitError;
    cache.rateLimitError = null;
    cache.rateLimitedUntil = 0;
  };
  const remember = (err) => {
    if (!isLinearRateLimited(err)) return;
    cache.rateLimitError = err;
    const resetMs = Date.parse(err.resetAt);
    cache.rateLimitedUntil = Number.isFinite(resetMs)
      ? resetMs
      : resolveNow() + 60_000;
  };

  const fetchTicket = dispatch.fetchTicket ?? fetchTicketDefault;
  const fetchViewer = dispatch.fetchViewer ?? fetchViewerDefault;
  const fetchInFlight = dispatch.fetchInFlight ?? fetchInFlightDefault;

  return {
    ...dispatch,
    fetchTicket: (id) => {
      throwIfLimited();
      if (cache.tickets.has(id)) return cache.tickets.get(id);
      try {
        const value = fetchTicket(id);
        cache.tickets.set(id, value);
        return value;
      } catch (err) {
        remember(err);
        throw err;
      }
    },
    fetchViewer: () => {
      throwIfLimited();
      if (cache.viewer.value !== undefined) return cache.viewer.value;
      try {
        const value = fetchViewer();
        cache.viewer.value = value;
        return value;
      } catch (err) {
        remember(err);
        throw err;
      }
    },
    fetchInFlight: (repo) => {
      throwIfLimited();
      const key = `${repo?.team ?? ""}::${repo?.project ?? ""}`;
      const hit = cache.inFlight.get(key);
      const at = resolveNow();
      if (hit && at - hit.at < IN_FLIGHT_CACHE_TTL_MS) return hit.value;
      try {
        cache.inFlightCalls += 1;
        const value = fetchInFlight(repo);
        cache.inFlight.set(key, { value, at });
        return value;
      } catch (err) {
        remember(err);
        throw err;
      }
    },
  };
}

function fetchTicketDefault(ticketId) {
  try {
    return JSON.parse(
      execFileSync("bun", [linearCli(), "get", ticketId, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (err) {
    throwIfLinearCliRateLimited(err);
    const stderr = String(err?.stderr ?? "");
    if (stderr.includes("no such issue")) return null;
    throw new Error(
      `linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`,
      { cause: err },
    );
  }
}

function fetchViewerDefault() {
  try {
    const out = execFileSync(
      "bun",
      [linearCli(), "raw", "query{ viewer{ id name } }"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(out)?.viewer ?? null;
  } catch (err) {
    throwIfLinearCliRateLimited(err);
    const stderr = String(err?.stderr ?? "");
    throw new Error(
      `linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`,
      { cause: err },
    );
  }
}

function fetchPullRequestDefault(payload) {
  try {
    return loadForge().prView(payload?.github, payload?.pr, {
      fields: ["state", "headRefOid"],
    });
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    if (/not found|no pull request/i.test(stderr)) return null;
    throw new Error(
      `github_read_failed: ${stderr.trim().split("\n").pop() || err.message}`,
      { cause: err },
    );
  }
}

// WM-1006: in-flight tickets come from the control-plane adapter via the
// `inflight` CLI verb — never raw tracker GraphQL (plane-specific).

const OWNED_PATHS_CLOSURE_CACHE = new Map();

function ownedPathsClosureDetails(repoName, repo, ticketDescription) {
  if (!repo?.ownedPathsPolicy) return [];
  const cacheKey = `${repoName}::${repo.path}`;
  if (!OWNED_PATHS_CLOSURE_CACHE.has(cacheKey)) {
    const requirements = repo.ownedPathsPolicy.pinManifests?.length
      ? readPinManifestRequirements(
          repo.path,
          repo.ownedPathsPolicy.pinManifests,
        )
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
    const out = execFileSync(
      "bun",
      [
        linearCli(),
        "inflight",
        "--team",
        String(repoConfig.team),
        "--project",
        String(repoConfig.project),
        "--json",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const rows = JSON.parse(out);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    throwIfLinearCliRateLimited(err);
    const stderr = String(err?.stderr ?? "");
    throw new Error(
      `linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`,
      { cause: err },
    );
  }
}

function policyMaxInFlight(root = reposRoot()) {
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return DEFAULT_MAX_IN_FLIGHT;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.concurrency
      ?.max_in_flight_per_repo;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_MAX_IN_FLIGHT;
  } catch {
    return DEFAULT_MAX_IN_FLIGHT;
  }
}

/**
 * Owned Paths collision mode (WM-677). `strict` refuses dispatch on any overlap
 * with an in-flight ticket — the historical behavior, and the fail-closed
 * default when the key is absent or malformed. `advisory` records the overlap
 * on the proposal as evidence and dispatches anyway, refusing only the narrow
 * hard-conflict set (identical concrete file, or `**`): textual overlap is what
 * rebase and merge-fix already resolve, and refusing it at dispatch was
 * starving the pool for conflicts that mostly never materialized.
 */
export const DEFAULT_OWNED_PATHS_COLLISION = "strict";
export function policyOwnedPathsCollision(root = reposRoot()) {
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return DEFAULT_OWNED_PATHS_COLLISION;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.dispatch
      ?.owned_paths_collision;
    return value === "advisory" ? "advisory" : DEFAULT_OWNED_PATHS_COLLISION;
  } catch {
    return DEFAULT_OWNED_PATHS_COLLISION;
  }
}

/** Fail-safe merge admission cap when policy is absent or malformed. */
export const DEFAULT_MAX_CONCURRENT_MERGES = 1;

export function policyMaxConcurrentMerges(root = reposRoot()) {
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return DEFAULT_MAX_CONCURRENT_MERGES;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.concurrency
      ?.max_concurrent_merges;
    return Number.isInteger(value) && value > 0
      ? value
      : DEFAULT_MAX_CONCURRENT_MERGES;
  } catch {
    return DEFAULT_MAX_CONCURRENT_MERGES;
  }
}

/** How many MERGE-verdict PRs one apply batch may squash (WM-908). */
export const DEFAULT_MERGE_BATCH_SIZE = 4;

export function policyMergeBatchSize(root = reposRoot()) {
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return DEFAULT_MERGE_BATCH_SIZE;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.merge?.batch_size;
    return Number.isInteger(value) && value > 0
      ? value
      : DEFAULT_MERGE_BATCH_SIZE;
  } catch {
    return DEFAULT_MERGE_BATCH_SIZE;
  }
}

function agentSingletonEnabled(registry, agentRef) {
  return Object.values(registry.schedules ?? {}).some(
    (candidate) =>
      candidate.enabled &&
      candidate.singleton !== false &&
      registry.eventTypes?.[candidate.eventType]?.agent === agentRef,
  );
}

function singletonApplies(registry, envelope, agentRef) {
  const loop = envelope.payload?.loop;
  const schedule = loop ? registry.schedules?.[loop] : null;
  if (
    schedule &&
    registry.eventTypes?.[schedule.eventType]?.agent === agentRef
  ) {
    return schedule.singleton !== false;
  }
  return agentSingletonEnabled(registry, agentRef);
}

/**
 * Ticket-named worktrees are mutually exclusive across dispatch and merge-fix.
 * FAILED remains in flight because lifecycle retries may queue it again; only
 * the lifecycle's four terminal states release the ticket.
 */
function inFlightRunForTicket(db, agentRef, { repo, ticket }) {
  const terminalPlaceholders = [...TERMINAL_STATES].map(() => "?").join(",");
  return (
    db
      .query(
        `SELECT run_id, state, created_at FROM runs
       WHERE state NOT IN (${terminalPlaceholders})
         AND json_extract(spec_json, '$.agent') = ?
         AND json_extract(spec_json, '$.input.repo') = ?
         AND json_extract(spec_json, '$.input.ticket') = ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT 1`,
      )
      .get(...TERMINAL_STATES, agentRef, repo, ticket) ?? null
  );
}

export function inFlightDispatchForTicket(db, payload) {
  return inFlightRunForTicket(db, "dispatch@1", payload);
}

function loadRepoEscalatePaths(repoName, root = reposRoot()) {
  const file = reposConfigPath(root);
  if (!existsSync(file)) {
    throw new RepoError(
      `${file}: cannot verify escalate_paths because repos.yaml is missing`,
    );
  }
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RepoError(
      `${file}: cannot verify escalate_paths: ${err.message}`,
    );
  }
  const entry = (parsed?.repos ?? []).find((row) => row?.name === repoName);
  if (!entry) {
    throw new RepoError(
      `${file}: cannot verify escalate_paths for unknown repo ${repoName}`,
    );
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
  const file = resolveConfigPath("policy", { root });
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
  return [
    ...new Set(values.filter((value) => typeof value === "string")),
  ].sort();
}

function evidenceTicket(ticket, ticketId) {
  const description = ticket?.description ?? "";
  const parsed = parseOwnedPaths(description);
  return {
    id: ticketId,
    state: ticket?.state?.name ?? null,
    assigneeNull: !ticket?.assignee,
    labels: sortUnique(
      // WM-978: tolerate both label shapes — the WM-894 control-plane adapter
      // emits a flat [{id,name}] array; older payloads used GraphQL {nodes}.
      (Array.isArray(ticket?.labels)
        ? ticket.labels
        : (ticket?.labels?.nodes ?? [])
      )
        .map((label) => label?.name)
        .filter(Boolean),
    ),
    ownedPaths: effectiveOwnedPaths(description),
    ownedPathsParsed: parsed.length > 0,
    descriptionHash: hashJson(description),
    // WM-879: github-plane trust facts. `controlPlaneKind` is undefined for
    // every other plane (Linear, memory), which is what keeps the gates
    // below github-only without a separate repo-config lookup.
    controlPlaneKind: ticket?.controlPlaneKind ?? undefined,
    authorAssociation: ticket?.authorAssociation ?? null,
    lastEditorAssociation: ticket?.lastEditorAssociation ?? null,
    readyPinHash: ticket?.readyPinHash ?? null,
  };
}

/**
 * Parse the closed per-ticket model-tier label vocabulary. A ticket may carry
 * either no tier label or exactly one valid `tier:<MODEL_TIERS>` label. The
 * full matching label set is returned so refusal evidence explains malformed
 * and duplicate declarations without relying on a lossy first-match rule.
 */
export function ticketModelTier(labels) {
  const tierLabels = (labels ?? []).filter(
    (label) => typeof label === "string" && label.startsWith("tier:"),
  );
  if (tierLabels.length === 0) {
    return { ok: true, tier: undefined, labels: [] };
  }
  if (tierLabels.length !== 1) {
    return {
      ok: false,
      tier: undefined,
      labels: tierLabels,
      detail: `ticket has multiple tier labels: ${tierLabels.join(", ")}`,
    };
  }
  const tier = tierLabels[0].slice("tier:".length);
  if (!MODEL_TIERS.includes(tier)) {
    return {
      ok: false,
      tier: undefined,
      labels: tierLabels,
      detail: `ticket tier label ${JSON.stringify(tierLabels[0])} must be one of ${MODEL_TIERS.map((value) => `tier:${value}`).join(", ")}`,
    };
  }
  return { ok: true, tier, labels: tierLabels };
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

function refusal(reason, evidence, decision = "noop", detail = null) {
  return {
    ok: false,
    refusal: {
      decision,
      reason,
      ...(detail ? { detail } : {}),
    },
    evidence,
  };
}

/**
 * The shared dispatch proof used at plan time and immediately before a chain
 * auto-approval. Its evidence captures every fact the latter needs to compare.
 */
export function worktreeDispatchAutoEligibility(
  payload,
  {
    fetchTicket = fetchTicketDefault,
    fetchViewer = fetchViewerDefault,
    fetchInFlight = fetchInFlightDefault,
    countLeases = (repoName) => liveWorkerLeases(repoName).length,
    maxInFlightFallback,
    budgetRefusal = defaultBudgetRefusal,
    claimedRetry = null,
    now = Date.now(),
  } = {},
) {
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
    capSource:
      repo.maxInFlight === null || repo.maxInFlight === undefined
        ? "policy.yaml: max_in_flight_per_repo"
        : "repo.max_in_flight",
  };
  evidence.checks.repo_found = true;
  if (repo.reportOnly)
    return refusal("repo_report_only", evidence, "human_needed");
  evidence.checks.repo_is_dispatchable = true;
  if (!repo.worktreeUp || !repo.worktreeDown || !repo.worktreeRoot)
    return refusal("no_worktree_scripts", evidence, "human_needed");
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

  const ticketTier = ticketModelTier(evidence.ticket.labels);
  evidence.ticket.modelTierLabels = ticketTier.labels;
  evidence.ticket.modelTier = ticketTier.tier ?? null;
  if (!ticketTier.ok) {
    evidence.checks.ticket_tier_valid = false;
    evidence.checks.model_tier_source = null;
    return refusal("ticket_tier_invalid", evidence, "noop", ticketTier.detail);
  }
  evidence.checks.ticket_tier_valid = true;
  evidence.checks.model_tier_source =
    payload?.modelTier !== undefined
      ? "payload"
      : ticketTier.tier !== undefined
        ? "label"
        : "definition";

  // A lease-loss retry is the one exception to the ordinary Todo/unassigned
  // admission rule. The prior attempt already performed the Linear claim, so
  // its durable state is expected to be In Progress and assigned. Accept that
  // state only when the worker proves this is the same run's lease-expired
  // attempt and Linear still names the factory's own viewer identity.
  const canResumeClaim = Boolean(
    claimedRetry?.runId &&
    Number.isInteger(claimedRetry?.priorAttempt) &&
    claimedRetry.priorAttempt > 0 &&
    claimedRetry?.reasonCode === "lease_expired",
  );
  let retryClaimedByFactory = false;
  let resumingOwnClaim = false;
  if (ticket.assignee) {
    if (!canResumeClaim) return refusal("ticket_assigned", evidence);
    const viewer = fetchViewer();
    if (!viewer?.id || ticket.assignee.id !== viewer.id)
      return refusal("ticket_assigned", evidence);
    retryClaimedByFactory = true;
  } else {
    evidence.checks.ticket_unassigned = true;
  }

  if (ticket.state?.name !== "Todo") {
    if (!(retryClaimedByFactory && ticket.state?.name === "In Progress")) {
      return refusal("ticket_not_todo", evidence);
    }
    resumingOwnClaim = true;
    evidence.checks.ticket_claim_retry = true;
    evidence.checks.ticket_in_progress_retry = true;
    evidence.ticket.claimedRetryRunId = claimedRetry.runId;
  } else {
    // Assignment alone is not a surviving factory claim. Requiring the state
    // transition as well prevents an own-assigned Todo ticket from bypassing
    // the normal claim mutation and its read-back concurrency control.
    if (retryClaimedByFactory) return refusal("ticket_assigned", evidence);
    evidence.checks.ticket_todo = true;
  }

  if (!evidence.ticket.labels.includes("ai:agent-ready")) {
    if (!(
      resumingOwnClaim && evidence.ticket.labels.includes("ai:in-progress")
    )) {
      return refusal("ticket_not_agent_ready", evidence);
    }
    evidence.checks.ticket_in_progress_label_retry = true;
  } else {
    evidence.checks.ticket_agent_ready = true;
  }
  if (evidence.ticket.labels.includes("ai:escalated")) {
    return refusal("ticket_escalated", evidence);
  }

  // WM-879: the github control plane is a public repo — the label gate above
  // keeps stranger-created issues out only until someone with triage
  // permission labels one, and covers nothing after that label is applied.
  // These two checks close that window; every dispatch path (auto and
  // operator-injected) funnels through this one function, so there is no
  // bypass. Linear/memory tickets carry no `controlPlaneKind`, so they skip
  // both checks entirely — unaffected by construction.
  if (evidence.ticket.controlPlaneKind === "github") {
    const trustedAuthor =
      isTrustedAssociation(evidence.ticket.authorAssociation) &&
      isTrustedAssociation(evidence.ticket.lastEditorAssociation);
    evidence.checks.ticket_trusted_author = trustedAuthor;
    if (!trustedAuthor) return refusal("ticket_untrusted_author", evidence);

    // Absent pin (never labeled through a pin-aware path) is not itself a
    // refusal — only a MISMATCHED pin proves the body changed since it was
    // marked ready. Refusing on absence would strand every ticket labeled
    // before this gate shipped.
    const pinMatches =
      !evidence.ticket.readyPinHash ||
      evidence.ticket.readyPinHash === evidence.ticket.descriptionHash;
    evidence.checks.ticket_body_pin_matches = pinMatches;
    if (!pinMatches)
      return refusal("ticket_body_changed_since_ready", evidence);
  }

  const blockers = openBlockers(ticket);
  evidence.ticket.openBlockers = blockers;
  if (blockers.length > 0) {
    evidence.checks.ticket_unblocked = false;
    return refusal(`ticket_blocked_by_open:${blockers.join(",")}`, evidence);
  }
  evidence.checks.ticket_unblocked = true;

  // Never let effectiveOwnedPaths' fail-closed `**` sentinel masquerade as a
  // real path during a sensitive-path check. Unknown ticket scope is its own
  // refusal, before overlap or escalate_paths can assign a misleading cause.
  if (!evidence.ticket.ownedPathsParsed) {
    evidence.checks.owned_paths_parsed = false;
    return refusal("owned_paths_unknown", evidence);
  }
  evidence.checks.owned_paths_parsed = true;

  try {
    const gaps = ownedPathsClosureDetails(repo.name, repo, ticket.description);
    if (gaps.length) {
      return refusal("owned_paths_not_closed", evidence, "human_needed");
    }
  } catch (err) {
    return refusal(
      `owned_paths_not_closed: ${err.message || String(err)}`,
      evidence,
      "human_needed",
    );
  }

  evidence.checks.ticket_not_escalated = true;
  if (
    evidence.ticket.labels.includes("type:security") ||
    evidence.ticket.labels.some((label) => /security/i.test(label))
  ) {
    return refusal("ticket_security", evidence);
  }
  evidence.checks.ticket_not_security = true;
  if (!repo.team || !repo.project)
    return refusal(
      "repo_unconfigured: team/project missing for the in-flight query",
      evidence,
      "human_needed",
    );
  evidence.checks.repo_team_project = true;

  const inFlight = fetchInFlight(repo);
  evidence.inFlight = inFlight
    .filter((issue) => String(issue.identifier) !== String(payload?.ticket))
    .map(evidenceInFlight);
  const collisionMode = policyOwnedPathsCollision();
  evidence.checks.owned_paths_collision_mode = collisionMode;
  const inFlightPaths = evidence.inFlight.flatMap((issue) => issue.ownedPaths);
  if (pathsCollide(evidence.ticket.ownedPaths, inFlightPaths)) {
    evidence.checks.owned_paths_disjoint = false;
    if (collisionMode !== "advisory")
      return refusal("owned_paths_overlap", evidence);
    // Advisory: name every overlapping claim and who holds it, so the proposal
    // and `inspect` show what this run may have to rebase across, then only
    // refuse the pairs that cannot be reconciled by a rebase.
    evidence.ownedPathsOverlap = evidence.inFlight.flatMap((issue) =>
      pathOverlaps(evidence.ticket.ownedPaths, issue.ownedPaths).map(
        ({ a, b }) => ({
          ticket: issue.id,
          path: a,
          inFlightPath: b,
        }),
      ),
    );
    const hard = evidence.inFlight.flatMap((issue) =>
      hardPathConflicts(evidence.ticket.ownedPaths, issue.ownedPaths).map(
        ({ a, b }) => ({
          ticket: issue.id,
          path: a,
          inFlightPath: b,
        }),
      ),
    );
    if (hard.length) {
      evidence.ownedPathsHardConflicts = hard;
      return refusal("owned_paths_conflict_hard", evidence);
    }
  } else {
    evidence.checks.owned_paths_disjoint = true;
  }
  try {
    evidence.repo.escalatePaths = loadRepoEscalatePaths(repo.name);
  } catch (err) {
    evidence.checks.escalate_paths = { verified: false };
    return refusal(
      `escalate_paths_unverifiable: ${err.message}`,
      evidence,
      "human_needed",
    );
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
    return refusal(
      "escalate_paths_intersect",
      evidence,
      "noop",
      `intersecting escalate_paths globs: ${evidence.escalatePathIntersections.join(", ")}`,
    );
  }
  return { ok: true, evidence };
}

/**
 * Plan-time dispatch refusal verdict. Existing callers retain the historical
 * null-or-refusal contract while auto-approval consumes the richer proof.
 */
export function worktreeDispatchGate(payload, options = {}) {
  const result = worktreeDispatchAutoEligibility(payload, options);
  if (result.ok) return null;
  // Keep the historical gate contract stable for planner/orchestrator callers;
  // richer claim-time consumers use worktreeDispatchAutoEligibility directly
  // to retain evidence and operator-facing detail.
  return {
    decision: result.refusal.decision,
    reason: result.refusal.reason,
  };
}

function normalizedOwnedPath(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

/** Conservative containment proof for the Owned Paths syntax used by tickets. */
function ownedPathContains(ownerValue, candidateValue) {
  const owner = normalizedOwnedPath(ownerValue);
  const candidate = normalizedOwnedPath(candidateValue);
  if (!owner || !candidate) return false;
  if (owner === "**" || owner === candidate) return true;

  const candidateHasGlob = /[*?{]/.test(candidate);
  if (!candidateHasGlob) return globToRegExp(owner).test(candidate);

  // A directory (bare or /**) owns narrower globs rooted below it. Other
  // wildcard-to-wildcard containment is deliberately fail-closed unless equal.
  const broadRoot = owner.endsWith("/**")
    ? owner.slice(0, -3).replace(/\/$/, "")
    : !/[*?{]/.test(owner) && !/\.[a-z0-9]+$/i.test(owner)
      ? owner
      : null;
  if (!broadRoot) return false;
  const candidatePrefix = candidate
    .slice(0, candidate.search(/[*?{]/))
    .replace(/\/$/, "");
  return (
    candidatePrefix === broadRoot || candidatePrefix.startsWith(`${broadRoot}/`)
  );
}

/**
 * Claim-time gate for a bounded merge correction. Unlike dispatch, assignment
 * and In Review are expected facts, not refusal conditions.
 */
export function worktreeMergeFixEligibility(
  payload,
  {
    fetchTicket = fetchTicketDefault,
    fetchPullRequest = fetchPullRequestDefault,
    fetchNonTerminalRuns = () => [],
    now = Date.now(),
  } = {},
) {
  const evidence = {
    checkedAt: new Date(resolveNow(now)).toISOString(),
    ticket: null,
    pullRequest: null,
    competingRuns: [],
    checks: {},
  };

  let ticket;
  try {
    ticket = fetchTicket(payload?.ticket);
  } catch (err) {
    return refusal(
      "merge_fix_ticket_read_failed",
      evidence,
      "noop",
      err?.message ?? String(err),
    );
  }
  evidence.ticket = evidenceTicket(ticket, payload?.ticket);
  if (!ticket)
    return refusal("merge_fix_ticket_not_found", evidence, "human_needed");
  evidence.checks.ticket_found = true;

  const labels = evidence.ticket.labels;
  if (labels.includes("ai:escalated")) {
    return refusal("merge_fix_ticket_escalated", evidence, "human_needed");
  }
  if (
    labels.includes("type:security") ||
    labels.some((label) => /security/i.test(label))
  ) {
    return refusal("merge_fix_ticket_security", evidence, "human_needed");
  }
  evidence.checks.ticket_not_escalated_or_security = true;

  if (!["In Review", "In Progress"].includes(evidence.ticket.state)) {
    return refusal("merge_fix_ticket_state", evidence);
  }
  evidence.checks.ticket_state = true;

  if (!evidence.ticket.ownedPathsParsed) {
    return refusal("merge_fix_owned_paths_unknown", evidence, "human_needed");
  }
  const fixPaths = Array.isArray(payload?.ownedPaths) ? payload.ownedPaths : [];
  if (
    fixPaths.length === 0 ||
    fixPaths.some(
      (candidate) =>
        !evidence.ticket.ownedPaths.some((owner) =>
          ownedPathContains(owner, candidate),
        ),
    )
  ) {
    return refusal("merge_fix_owned_paths_moved", evidence);
  }
  evidence.checks.owned_paths_within_ticket = true;

  let pullRequest;
  try {
    pullRequest = fetchPullRequest(payload);
  } catch (err) {
    return refusal(
      "merge_fix_pr_read_failed",
      evidence,
      "noop",
      err?.message ?? String(err),
    );
  }
  evidence.pullRequest = pullRequest;
  if (!pullRequest)
    return refusal("merge_fix_pr_not_found", evidence, "human_needed");
  evidence.checks.pr_found = true;
  if (pullRequest.state !== "OPEN")
    return refusal("merge_fix_pr_not_open", evidence);
  evidence.checks.pr_open = true;
  if (pullRequest.headRefOid !== payload?.headSha)
    return refusal("merge_fix_pr_moved", evidence);
  evidence.checks.pr_head_matches = true;

  try {
    evidence.competingRuns = fetchNonTerminalRuns(payload) ?? [];
  } catch (err) {
    return refusal(
      "merge_fix_run_check_failed",
      evidence,
      "noop",
      err?.message ?? String(err),
    );
  }
  if (evidence.competingRuns.length > 0)
    return refusal("merge_fix_run_active", evidence);
  evidence.checks.no_competing_run = true;

  return { ok: true, evidence };
}

function worktreeGateFor(def) {
  if (def?.workspace?.type !== "worktree") return null;
  return def.dispatchGateExempt === true ? null : "dispatch";
}

function insertProposal(
  db,
  {
    id,
    event,
    runId = null,
    decision,
    specJson = null,
    specHash = null,
    idempotencyKey = null,
    status,
    reason = null,
    at,
    ttlSeconds,
  },
) {
  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
        idempotency_key, status, reason, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.source,
    event.event_id,
    runId,
    decision,
    specJson,
    specHash,
    idempotencyKey,
    status,
    reason,
    at,
    ttlSeconds,
  );
  return db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
}

function setEventStatus(db, event, status) {
  db.query(
    `UPDATE events SET status = ? WHERE source = ? AND event_id = ?`,
  ).run(status, event.source, event.event_id);
}

function isIdempotencyKeyCollision(err) {
  return (
    err?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    /UNIQUE constraint failed: runs\.idempotency_key/.test(
      String(err?.message ?? err),
    )
  );
}

function liveRunForInput(
  db,
  agentRef,
  { repo, ticket = null, includeFailed = false },
) {
  if (
    typeof repo !== "string" ||
    (ticket !== null && typeof ticket !== "string")
  )
    return null;
  const versionSeparator = agentRef.lastIndexOf("@");
  const agentFamily =
    versionSeparator > 0
      ? `${agentRef.slice(0, versionSeparator)}@*`
      : agentRef;
  return db
    .query(
      `SELECT run_id, state FROM runs
     WHERE state NOT IN ('COMPLETED','REFUSED','TIMED_OUT','CANCELLED')
       AND (? = 1 OR state <> 'FAILED')
       AND json_extract(spec_json, '$.agent') GLOB ?
       AND json_extract(spec_json, '$.input.repo') = ?
       AND (? IS NULL OR json_extract(spec_json, '$.input.ticket') = ?)
     ORDER BY created_at ASC, rowid ASC
     LIMIT 1`,
    )
    .get(includeFailed ? 1 : 0, agentFamily, repo, ticket, ticket);
}

function noopBehindLiveRun(db, event, blockingRun, reason, at, ttlSeconds) {
  const proposal = insertProposal(db, {
    id: newProposalId(),
    event,
    runId: blockingRun.run_id,
    decision: "noop",
    status: "resolved",
    reason,
    at,
    ttlSeconds,
  });
  setEventStatus(db, event, "noop");
  return { decision: "noop", proposal, runId: blockingRun.run_id, reason };
}

function humanNeeded(db, event, reason, at, ttlSeconds) {
  const proposal = insertProposal(db, {
    id: newProposalId(),
    event,
    decision: "human_needed",
    status: "open",
    reason,
    at,
    ttlSeconds,
  });
  setEventStatus(db, event, "human_needed");
  return { decision: "human_needed", proposal, reason };
}

/** Idempotent path: the event was already planned — report what was decided. */
function existingOutcome(db, event) {
  const proposal = db
    .query(
      `SELECT * FROM proposals WHERE event_source = ? AND event_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(event.source, event.event_id);
  if (!proposal)
    return {
      decision: event.status,
      reason: event.last_plan_error ?? undefined,
    };
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
export function planEvent(
  db,
  registry,
  { source, eventId },
  {
    now = Date.now(),
    policyVersion = "unknown",
    adapterOverride,
    artifactStore = artifactsRoot(),
    dispatch = {},
  } = {},
) {
  // Dispatch gate for tier-2 worktree agents (WM-108), evaluated BEFORE the
  // write transaction: its Linear and lease reads must never hold the SQLite
  // write lock across a network round trip. The verdict is applied inside the
  // transaction only when the event is still admitted there — a raced plan
  // simply discards it via the idempotent early return.
  let worktreeEligibility = null;
  {
    const row = db
      .query(
        `SELECT status, envelope_json FROM events WHERE source = ? AND event_id = ?`,
      )
      .get(source, eventId);
    if (row?.status === "admitted") {
      const preEnvelope = JSON.parse(row.envelope_json);
      const preMapping = getEventType(registry, preEnvelope.type);
      const preDef =
        preMapping && preMapping.observe !== true
          ? registry.agents.get(preMapping.agent)
          : null;
      // An event already outside the definition's repo scope (WM-64) skips
      // the gate's Linear/lease reads entirely — the transaction below parks
      // it repo_not_allowed before anything else happens.
      if (
        worktreeGateFor(preDef) === "dispatch" &&
        typeof preEnvelope.payload?.repo === "string" &&
        typeof preEnvelope.payload?.ticket === "string" &&
        !repoNotAllowed(preDef, preEnvelope.payload)
      ) {
        try {
          worktreeEligibility = worktreeDispatchAutoEligibility(
            preEnvelope.payload,
            dispatch,
          );
        } catch (err) {
          if (!isLinearRateLimited(err)) throw err;
          worktreeEligibility = {
            ok: false,
            rateLimited: true,
            resetAt: err.resetAt ?? null,
            refusal: {
              decision: "retry_later",
              reason: "linear_rate_limited",
              detail: err.message,
            },
          };
        }
      }
    }
  }
  if (worktreeEligibility?.rateLimited) {
    const detail = worktreeEligibility.refusal?.detail ?? "linear_rate_limited";
    try {
      db.query(
        `UPDATE events SET last_plan_error = ? WHERE source = ? AND event_id = ?`,
      ).run(detail, source, eventId);
    } catch (err) {
      if (!isBusyError(err)) throw err;
    }
    return {
      decision: "refused",
      reason: "linear_rate_limited",
      resetAt: worktreeEligibility.resetAt ?? null,
    };
  }
  return txImmediate(db, () => {
    const event = db
      .query(`SELECT * FROM events WHERE source = ? AND event_id = ?`)
      .get(source, eventId);
    if (!event) throw new Error(`no admitted event (${source}, ${eventId})`);
    if (event.status !== "admitted") return existingOutcome(db, event);

    const envelope = JSON.parse(event.envelope_json);
    const at = new Date(now).toISOString();

    const gitMapping = getEventType(registry, envelope.type);
    if (!gitMapping)
      return humanNeeded(
        db,
        event,
        "unregistered_event_type",
        at,
        DEFAULT_PROPOSAL_TTL_SECONDS,
      );
    const overrides = listOverrides(db);
    const overlayAdapter = overlayForEventType(
      overrides,
      envelope.type,
    )?.adapter;
    if (overlayAdapter && !knownAdapters(registry).has(overlayAdapter)) {
      return humanNeeded(
        db,
        event,
        `overlay_unknown_adapter:${overlayAdapter}`,
        at,
        gitMapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS,
      );
    }
    const mapping = overlayAdapter
      ? { ...gitMapping, adapter: overlayAdapter }
      : gitMapping;
    const ttlSeconds =
      mapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;

    // Observe-only types (WM-75): the orchestrator reporting its own
    // lifecycle. The event is the deliverable — admitted, journaled,
    // queryable — and the plan is a typed NOOP, never an inbox ask.
    if (mapping.observe === true) {
      const proposal = insertProposal(db, {
        id: newProposalId(),
        event,
        decision: "noop",
        status: "resolved",
        reason: "observed",
        at,
        ttlSeconds,
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
    if (scopeRefusal)
      return humanNeeded(db, event, scopeRefusal, at, ttlSeconds);

    // A work scan reserves its repo as soon as its run is PROPOSED, before the
    // expensive model read can select a ticket. This is deliberately stronger
    // than schedule singleton semantics (which exclude watched PROPOSED runs):
    // two operator/chain scans for one queue must never run concurrently. The
    // IMMEDIATE transaction makes the reservation check and run creation
    // atomic across planner connections.
    if (
      envelope.type === "factory.work.requested" &&
      typeof envelope.payload?.repo === "string"
    ) {
      const blockingScan = liveRunForInput(db, mapping.agent, {
        repo: envelope.payload.repo,
      });
      if (blockingScan) {
        return noopBehindLiveRun(
          db,
          event,
          blockingScan,
          "work_scan_already_in_flight",
          at,
          ttlSeconds,
        );
      }
    }

    // Defense in depth for stale/advisory scan results: once any dispatch for
    // this exact repo/ticket has a live run (including an unapproved PROPOSED
    // run), a second dispatch is refused here with the worktree owner named.
    // It therefore never reaches provisioning where the same deterministic
    // worktree path and port pair would masquerade as a foreign port collision.
    if (
      envelope.type === "factory.dispatch.requested" &&
      typeof envelope.payload?.repo === "string" &&
      typeof envelope.payload?.ticket === "string"
    ) {
      const blockingDispatch = liveRunForInput(db, mapping.agent, {
        repo: envelope.payload.repo,
        ticket: envelope.payload.ticket,
        // FAILED dispatches remain retryable and retain their worktree; a new
        // run for the same ticket would still collide with that owner.
        includeFailed: true,
      });
      if (blockingDispatch) {
        const reason = `ticket_dispatch_already_live:${blockingDispatch.run_id}:same_ticket_worktree_held`;
        return noopBehindLiveRun(
          db,
          event,
          blockingDispatch,
          reason,
          at,
          ttlSeconds,
        );
      }
    }

    // §5 singleton is agent policy, not clock-envelope policy: operator and
    // chain origins mapped to an enabled singleton agent must not bypass it by
    // omitting payload.loop. Merge scans additionally obey the git-owned
    // global admission cap even when a concrete schedule opts out of
    // singleton behavior. PROPOSED remains excluded here (OPS-436); the
    // repo-scoped work-scan reservation above intentionally includes it.
    const inFlight = inFlightRunsForAgent(db, mapping.agent);
    // factory.work.requested already has the stricter repo-scoped reservation
    // above. Applying the schedule's legacy agent-global singleton as well
    // would incorrectly serialize unrelated repo queues after PROPOSED.
    const singletonBlocked =
      envelope.type !== "factory.work.requested" &&
      singletonApplies(registry, envelope, mapping.agent) &&
      inFlight.length > 0;
    const mergeCap =
      envelope.type === "factory.merge.requested"
        ? policyMaxConcurrentMerges()
        : null;
    const mergeCapBlocked = mergeCap !== null && inFlight.length >= mergeCap;
    if (singletonBlocked || mergeCapBlocked) {
      const blockingRun = inFlight[0];
      const proposal = insertProposal(db, {
        id: newProposalId(),
        event,
        runId: blockingRun.run_id,
        decision: "noop",
        status: "resolved",
        reason: "previous_run_in_flight",
        at,
        ttlSeconds,
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
    if (!input.valid)
      return humanNeeded(
        db,
        event,
        `invalid_input: ${input.errors[0]}`,
        at,
        ttlSeconds,
      );

    // merge-fix and dispatch derive the same repo-owned
    // worktree_root/<ticket> path. Enforce both planning orders inside this
    // write transaction, before either side can create another RunSpec.
    const ticketWorktreeBlocker =
      def.ref === "merge-fix@1"
        ? {
            run: inFlightDispatchForTicket(db, envelope.payload),
            reason: "ticket_dispatch_in_flight",
          }
        : def.ref === "dispatch@1"
          ? {
              run: inFlightRunForTicket(db, "merge-fix@1", envelope.payload),
              reason: "ticket_merge_fix_in_flight",
            }
          : null;
    if (ticketWorktreeBlocker?.run) {
      const proposal = insertProposal(db, {
        id: newProposalId(),
        event,
        runId: ticketWorktreeBlocker.run.run_id,
        decision: "noop",
        status: "resolved",
        reason: ticketWorktreeBlocker.reason,
        at,
        ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return {
        decision: "noop",
        proposal,
        runId: ticketWorktreeBlocker.run.run_id,
        reason: ticketWorktreeBlocker.reason,
      };
    }

    // Tier-2 dispatch gate verdict (docs/event-runtime-dispatch.md §§2–5,
    // WM-108), computed above outside this transaction. Refusals are typed
    // and carry their reason; a null verdict means every check passed at the
    // moment of the read — the doc's execute-time re-check owns the TTL gap.
    const worktreeRefusal =
      worktreeEligibility?.ok === false ? worktreeEligibility.refusal : null;
    if (worktreeGateFor(def) === "dispatch" && worktreeRefusal) {
      if (worktreeRefusal.decision === "human_needed") {
        return humanNeeded(db, event, worktreeRefusal.reason, at, ttlSeconds);
      }
      const proposal = insertProposal(db, {
        id: newProposalId(),
        event,
        decision: "noop",
        status: "resolved",
        reason: worktreeRefusal.detail ?? worktreeRefusal.reason,
        at,
        ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return {
        decision: "noop",
        proposal,
        reason: worktreeRefusal.reason,
        evidence: worktreeEligibility.evidence,
      };
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
      (def.workspace.inputs ?? []).some(
        (i) =>
          typeof i.from === "string" && i.from.startsWith("$.input.runPin."),
      )
    ) {
      try {
        payload = { ...payload, runPin: pinRunArtifact(db, payload.runId) };
      } catch (err) {
        return humanNeeded(
          db,
          event,
          `run_pin_failed: ${err.message}`,
          at,
          ttlSeconds,
        );
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
            return humanNeeded(
              db,
              event,
              `artifact_missing: ${entry.as} (${sha})`,
              at,
              ttlSeconds,
            );
          }
        } catch (err) {
          return humanNeeded(
            db,
            event,
            `artifact_ref_failed: ${err.message}`,
            at,
            ttlSeconds,
          );
        }
      }
    }
    if (def.workspace?.type === "repository") {
      try {
        payload = {
          ...payload,
          repoPin: pinRepo(payload.repo, payload.ref ?? undefined),
        };
      } catch (err) {
        return humanNeeded(
          db,
          event,
          `repo_pin_failed: ${err.message}`,
          at,
          ttlSeconds,
        );
      }
    }
    // Declared memos fold at plan time into memoPin (docs/event-runtime-memos.md
    // §4.2). The pin is part of the payload, so it is in inputHash and the
    // receipt. An empty fold is empty entries, never human_needed.
    if (Array.isArray(def.memos) && def.memos.length > 0) {
      try {
        payload = pinMemos(db, def, payload, {
          now,
          descriptionHash:
            worktreeEligibility?.evidence?.ticket?.descriptionHash,
          headSha: payload.repoPin?.sha ?? null,
        });
      } catch (err) {
        return humanNeeded(
          db,
          event,
          `memo_pin_failed: ${err.message}`,
          at,
          ttlSeconds,
        );
      }
    }

    const pinnedEnvelope =
      payload === envelope.payload ? envelope : { ...envelope, payload };
    if (pinnedEnvelope !== envelope) {
      db.query(
        `UPDATE events SET envelope_json = ? WHERE source = ? AND event_id = ?`,
      ).run(canonicalJson(pinnedEnvelope), event.source, event.event_id);
    }
    let idempotencyKey = idempotencyKeyFor(
      mapping,
      def,
      pinnedEnvelope,
      hashJson(payload),
    );
    const correlation = envelope.correlationId ?? envelope.eventId ?? null;
    if (
      correlation &&
      !mapping.idempotencyScope.includes("correlationId") &&
      !mapping.idempotencyScope.includes("eventId")
    ) {
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
        id: newProposalId(),
        event,
        runId: existingRun.run_id,
        decision: "noop",
        idempotencyKey,
        status: "resolved",
        reason: "duplicate_run",
        at,
        ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return {
        decision: "noop",
        proposal,
        runId: existingRun.run_id,
        reason: "duplicate_run",
      };
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
    let dispatchEvidence = worktreeEligibility?.evidence ?? null;
    if (envelope.source === "chain") {
      approvalPolicy = buildChainApprovalPolicy(envelope.type, {
        source: envelope.source,
      });
      if (
        approvalPolicy?.mode === "auto" &&
        envelope.type === "factory.dispatch.requested"
      ) {
        const result = worktreeEligibility?.ok
          ? worktreeEligibility
          : worktreeDispatchAutoEligibility(pinnedEnvelope.payload, dispatch);
        if (!result?.ok) {
          return humanNeeded(
            db,
            event,
            `dispatch_eligibility_check_failed_at_plan: ${result?.refusal?.reason ?? "unknown"}`,
            at,
            ttlSeconds,
          );
        }
        approvalPolicy = {
          ...approvalPolicy,
          dispatchEvidence: result.evidence,
        };
        dispatchEvidence = result.evidence;
      }
    }

    // Per-ticket routing applies only to factory dispatch. The payload is
    // already schema-validated above; ticket labels were validated by the
    // dispatch gate. Overlay (WM-887) sits below those and above git.
    const agentPatch = overlayForAgent(overrides, mapping.agent) ?? {};
    const overlayTier = Object.hasOwn(agentPatch, "modelTier")
      ? agentPatch.modelTier
      : undefined;
    const overlayModel = Object.hasOwn(agentPatch, "model")
      ? agentPatch.model
      : undefined;
    const modelTierOverride =
      envelope.type === "factory.dispatch.requested"
        ? (payload.modelTier ??
          dispatchEvidence?.ticket?.modelTier ??
          overlayTier)
        : overlayTier;

    const spec = {
      ...buildRunSpec(registry, pinnedEnvelope, mapping, {
        runId,
        policyVersion,
        adapterOverride,
        now,
        approvalPolicy,
        modelTierOverride,
        modelOverride: overlayModel,
      }),
      idempotencyKey,
    };
    const specJson = canonicalJson(spec);
    const specHash = hashJson(spec);
    try {
      createRun(db, {
        runId,
        idempotencyKey,
        spec,
        specJson,
        specHash,
        actor: "planner",
        correlationId: envelope.correlationId ?? null,
        causationId: envelope.causationId ?? null,
        policyVersion,
        now,
      });
    } catch (err) {
      if (!isIdempotencyKeyCollision(err)) throw err;
      const winner = resolveIdempotency(db, { idempotencyKey });
      if (!winner) throw err;
      const reason = `idempotency_collision:${winner.run_id}`;
      const proposal = insertProposal(db, {
        id: newProposalId(),
        event,
        runId: winner.run_id,
        decision: "noop",
        idempotencyKey,
        status: "resolved",
        reason,
        at,
        ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, runId: winner.run_id, reason };
    }
    const proposal = insertProposal(db, {
      id: newProposalId(),
      event,
      runId,
      decision: "run",
      specJson,
      specHash,
      idempotencyKey,
      status: "open",
      at,
      ttlSeconds,
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
export function requeueEvent(
  db,
  { source, eventId },
  { actor = "operator", now = Date.now() } = {},
) {
  return txImmediate(db, () => {
    const event = db
      .query(`SELECT status FROM events WHERE source = ? AND event_id = ?`)
      .get(source, eventId);
    if (!event) throw new Error(`unknown event (${source}, ${eventId})`);
    if (!["dead_lettered", "human_needed"].includes(event.status)) {
      throw new Error(
        `requeue applies to dead_lettered or human_needed events, not ${event.status}`,
      );
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
export function archiveDeadLetteredEvent(
  db,
  { source, eventId },
  { now = Date.now() } = {},
) {
  return txImmediate(db, () => {
    const event = db
      .query(
        `SELECT status, archived_at FROM events WHERE source = ? AND event_id = ?`,
      )
      .get(source, eventId);
    if (!event) throw new Error(`unknown event (${source}, ${eventId})`);
    if (event.status !== "dead_lettered") {
      throw new Error(
        `archive applies to dead_lettered events, not ${event.status}`,
      );
    }
    if (!event.archived_at) {
      db.query(
        `UPDATE events SET archived_at = ? WHERE source = ? AND event_id = ?`,
      ).run(new Date(now).toISOString(), source, eventId);
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
  const rows = db
    .query(
      `SELECT source, event_id FROM events WHERE status = 'admitted' ORDER BY admitted_at, rowid`,
    )
    .all();
  const cache = opts.linearReadCache ?? createLinearReadCache();
  const dispatch = wrapLinearReads(opts.dispatch ?? {}, cache, opts.now);
  const planOpts = { ...opts, dispatch };
  let planned = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const { source, event_id: eventId } of rows) {
    try {
      const outcome = planEvent(db, registry, { source, eventId }, planOpts);
      if (outcome?.reason === "linear_rate_limited") continue;
      planned += 1;
    } catch (err) {
      if (isBusyError(err)) {
        continue;
      }
      if (isLinearRateLimited(err)) {
        try {
          db.query(
            `UPDATE events SET last_plan_error = ? WHERE source = ? AND event_id = ?`,
          ).run(String(err.message), source, eventId);
        } catch (innerErr) {
          if (!isBusyError(innerErr)) throw innerErr;
        }
        continue;
      }
      failed += 1;
      const message = String(err?.message ?? err);
      try {
        const failures = txImmediate(db, () => {
          db.query(
            `UPDATE events SET plan_failures = plan_failures + 1, last_plan_error = ? WHERE source = ? AND event_id = ?`,
          ).run(message, source, eventId);
          const row = db
            .query(
              `SELECT plan_failures FROM events WHERE source = ? AND event_id = ?`,
            )
            .get(source, eventId);
          if (row.plan_failures >= DEAD_LETTER_AFTER) {
            db.query(
              `UPDATE events SET status = 'dead_lettered' WHERE source = ? AND event_id = ?`,
            ).run(source, eventId);
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
    dispatch,
  });
  return { planned, failed, deadLettered };
}

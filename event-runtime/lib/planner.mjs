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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  effectiveOwnedPaths,
  globToRegExp,
  hardPathConflicts,
  isMatchEverythingGlob,
  pathOverlaps,
  pathsCollide,
  parseOwnedPaths,
  readPinManifestRequirements,
  ownedPathsClosureGaps,
} from "../../orchestrator/owned-paths.mjs";
import { openBlockers } from "../../orchestrator/blockers.mjs";
import { parseIssueIdentifier } from "../../lib/control-plane/github.mjs";
import { loadForge } from "../../lib/forge/index.mjs";
import { budgetExhausted } from "../../lib/spend.mjs";
import { liveWorkerLeases } from "../../lib/worker-leases.mjs";
import { findArtifact, pinRunArtifact } from "./artifacts.mjs";
import { canonicalJson, hashBytes, hashJson } from "./canonical.mjs";
import { resolveConfigPath } from "./config.mjs";
import {
  DEFAULT_DISPATCH_SECURITY,
  loadRuntimePolicy,
  policyDispatchSecurity,
} from "./runtime-policy.mjs";
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
  repoDispatchPreflightSync,
  reposConfigPath,
  reposRoot,
  toolchainHash,
} from "./repos.mjs";
import { validate } from "./schema.mjs";
import { inFlightRunsForAgent } from "./in-flight-runs.mjs";
import {
  buildRunSpec,
  idempotencyKeyFor,
  modelAdapterMismatch,
} from "./run-spec.mjs";
export {
  buildRunSpec,
  HARNESS_KINDS,
  HARNESS_NAME_PATTERN,
  harnessFromDef,
  harnessPinsForSpec,
  idempotencyKeyFor,
  modelAdapterMismatch,
  normalizeHarness,
} from "./run-spec.mjs";
import { resolveInputRef } from "./workspace.mjs";
import { HANDOFF_REASON_CODES } from "./verify.mjs";
import { buildChainApprovalPolicy } from "./chain-approval-policy.mjs";
import { autoApproveChains } from "./auto-approval.mjs";
import {
  LINEAR_RATE_LIMIT_EXIT,
  LinearRateLimitError,
  isLinearRateLimitMessage,
  isLinearRateLimited,
  linearRateLimitState,
  loadLinearBudget,
} from "../../tools/ticket.mjs";

/** In-flight issues list is stable across one scan; 60s is the ticket cap. */
export const IN_FLIGHT_CACHE_TTL_MS = 60_000;
export { DEFAULT_MAX_IN_FLIGHT };

// Readiness belongs to this planner process and a repo's declared constraints,
// not to an individual event. Cache failures too: dispatch bursts must run one
// bounded probe set per repo/toolchain declaration.
const dispatchToolchainPreflightCache = new Map();

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
  {
    now = Date.now(),
    descriptionHash,
    headSha,
    artifactStore = artifactsRoot(),
    onArtifactMissing,
  } = {},
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
        artifactStore,
        onArtifactMissing,
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

/** Build the immutable strong-tier continuation for one admitted dispatch. */
export function buildEscalatedContinuationSpec(
  registry,
  failedSpec,
  { runId, operatorAuthorized = false, handoffFailure = null } = {},
) {
  if (!runId) throw new Error("tier escalation continuation needs a runId");
  const def = getAgent(registry, failedSpec.agent);
  const planned = plannedDef(def, { modelTierOverride: "strong" });
  const rootRunId = failedSpec.rootRunId ?? failedSpec.runId;
  const input = { ...failedSpec.input, modelTier: "strong" };
  return {
    ...failedSpec,
    runId,
    input,
    inputHash: hashJson(input),
    modelTier: "strong",
    model: resolveModel(planned, failedSpec.adapter, registry.modelTiers),
    timeoutSeconds: def.limits.timeout_seconds,
    maxAttempts: def.limits.attempts,
    idempotencyKey: `${failedSpec.idempotencyKey}:tier-escalation:${rootRunId}`,
    rootRunId,
    escalatedFromRunId: failedSpec.runId,
    approvalPolicy: {
      source: "handoff",
      mode: "auto",
      eventType: "factory.dispatch.requested",
      // `operatorAuthorized` is decided by the caller from the ORIGINATING
      // event source of the failed run. It is never read back out of the
      // failed spec's own approvalPolicy: dispatchEvidence is inherited by
      // chain runs, so sourcing it there would launder an operator bypass
      // through any descendant of one operator dispatch.
      escalation: {
        rootRunId,
        failedRunId: failedSpec.runId,
        operatorAuthorized: operatorAuthorized === true,
        ...(typeof handoffFailure === "string" && handoffFailure
          ? { handoffFailure }
          : {}),
      },
      ...(failedSpec.approvalPolicy?.dispatchEvidence
        ? {
            dispatchEvidence: failedSpec.approvalPolicy.dispatchEvidence,
          }
        : {}),
    },
  };
}

function resolveNow(now) {
  return typeof now === "function" ? now() : now;
}

// Planning normally runs in the planner worker, but `serve --no-planner` still
// plans inline on the serve loop, so a stalled read can block the tick itself.
// Bound each event's Linear CLI reads so one stalled ticket cannot delay the
// next event forever; the default leaves room for normal control-plane reads
// without holding an operator's planner pass hostage. Operators may set the
// positive millisecond FACTORY_LINEAR_READ_TIMEOUT_MS environment variable to
// tune this deadline.
export const LINEAR_READ_TIMEOUT_MS = (() => {
  const n = Number(process.env.FACTORY_LINEAR_READ_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
})();

/**
 * The whole-tick Linear read budget is spent. `linearReadTimeout` raises this
 * *before* spawning the child, so it surfaces from inside the same `try` that
 * wraps the read: every such catch must rethrow it untouched. Rewrapping it as
 * `linear_read_failed` would turn a deferrable "come back next tick" into a
 * hard dead-letter on every read past the deadline (#1890).
 */
class LinearReadBudgetExceededError extends Error {
  constructor() {
    super("linear_read_budget_exhausted");
    this.name = "LinearReadBudgetExceededError";
  }
}

function createLinearReadBudget({
  now = Date.now,
  timeoutMs = LINEAR_READ_TIMEOUT_MS,
} = {}) {
  const clock = typeof now === "function" ? now : () => now;
  return { deadline: clock() + timeoutMs, now: clock };
}

function linearReadTimeout(readBudget) {
  if (!readBudget) return LINEAR_READ_TIMEOUT_MS;
  const remaining = Math.floor(readBudget.deadline - readBudget.now());
  if (remaining <= 0) throw new LinearReadBudgetExceededError();
  return Math.min(LINEAR_READ_TIMEOUT_MS, remaining);
}

function linearReadTimedOut(err) {
  return (
    err?.code === "ETIMEDOUT" ||
    (err?.signal === "SIGTERM" && err?.status == null)
  );
}

function throwIfLinearReadBudgetExhausted(err, readBudget) {
  if (
    readBudget &&
    linearReadTimedOut(err) &&
    readBudget.deadline - readBudget.now() <= 0
  )
    throw new LinearReadBudgetExceededError();
}

function isLinearReadDeferred(err) {
  return (
    isLinearRateLimited(err) || err instanceof LinearReadBudgetExceededError
  );
}

function linearReadDeferredReason(err) {
  return err instanceof LinearReadBudgetExceededError
    ? "linear_read_budget_exhausted"
    : "linear_rate_limited";
}

function linearCli() {
  // Test seam: point the planner's ticket reads at a stand-in CLI.
  return (
    process.env.FACTORY_LINEAR_CLI ||
    path.join(FACTORY_ROOT, "tools", "ticket.mjs")
  );
}

function linearReadFailureReason(err) {
  const stderr = String(err?.stderr ?? "");
  const underlyingStderr = stderr
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return (
    underlyingStderr ||
    (linearReadTimedOut(err) ? "linear read timed out" : err.message)
  );
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
    // Viewer identity is control-plane/repo specific. A Linear UUID cached
    // while planning one repo must never be compared with a GitHub assignee
    // id while planning the next repo in the same pass.
    viewers: new Map(),
    rateLimitError: null,
    rateLimitedUntil: 0,
    inFlightCalls: 0,
    linearReadBudget: null,
  };
}

/**
 * One planning pass / one scan run: memoize ticket reads for the run and
 * in-flight lists by team+project for ≤60s. A rate-limit throw is remembered
 * so later candidates in the same pass do not hit Linear again.
 */
export function wrapLinearReads(
  dispatch = {},
  cache,
  now,
  configSnapshot = null,
) {
  const resolveNow = () => {
    const clock = now ?? Date.now;
    return typeof clock === "function" ? clock() : clock;
  };
  const linearRateLimit = cache.budgetRateLimit ?? null;
  const repoUsesLinear = (repoOrName) => {
    if (repoOrName && typeof repoOrName === "object")
      return repoOrName.controlPlane !== "github";
    try {
      return (
        getRepo(snapshotRepos(configSnapshot), repoOrName).controlPlane !==
        "github"
      );
    } catch {
      // The normal eligibility proof supplies the useful unknown-repo refusal.
      return false;
    }
  };
  const throwIfLimited = (repo) => {
    if (!repoUsesLinear(repo)) return;
    if (linearRateLimit) throw linearRateLimit;
    if (!cache.rateLimitError) return;
    if (resolveNow() < cache.rateLimitedUntil) throw cache.rateLimitError;
    cache.rateLimitError = null;
    cache.rateLimitedUntil = 0;
  };
  const throwIfReadBudgetExhausted = (repo) => {
    if (!repoUsesLinear(repo)) return;
    linearReadTimeout(cache.linearReadBudget);
  };
  const remember = (err) => {
    if (!isLinearRateLimited(err)) return;
    cache.rateLimitError = err;
    const resetMs = Date.parse(err.resetAt);
    cache.rateLimitedUntil = Number.isFinite(resetMs)
      ? resetMs
      : resolveNow() + 60_000;
  };
  // The serve-loop chain pass injects awaited readers, so a rate limit arrives
  // as a rejected promise the synchronous `catch` below never sees. Latch it
  // from the promise too, and drop the memo entry so one transient failure is
  // not replayed to every later row in the pass as a cached value.
  const trackAsync = (value, forget) => {
    if (!value || typeof value.then !== "function") return value;
    value.then(undefined, (err) => {
      remember(err);
      forget();
    });
    return value;
  };

  // Bind policy dependencies into production fetchers rather than appending
  // them to every call. In particular, fetchViewer's second positional value
  // is its config snapshot, so a caller that omits it must not receive the
  // budget object in its place.
  const fetchTicket =
    dispatch.fetchTicket ??
    ((ticketId, repo) =>
      fetchTicketDefault(ticketId, repo, {
        readBudget: cache.linearReadBudget,
      }));
  const fetchViewer =
    dispatch.fetchViewer ??
    ((repoName, snapshot = configSnapshot) =>
      fetchViewerDefault(repoName, snapshot, {
        readBudget: cache.linearReadBudget,
      }));
  const fetchInFlight =
    dispatch.fetchInFlight ??
    ((repo) =>
      fetchInFlightDefault(repo, { readBudget: cache.linearReadBudget }));

  return {
    ...dispatch,
    fetchTicket: (id, repo) => {
      throwIfLimited(repo);
      // Cache per (id, repo): the same identifier read against different
      // control planes is a different lookup.
      const key = repo ? `${repo}::${id}` : id;
      if (cache.tickets.has(key)) return cache.tickets.get(key);
      throwIfReadBudgetExhausted(repo);
      try {
        const value = fetchTicket(id, repo);
        cache.tickets.set(key, value);
        return trackAsync(value, () => cache.tickets.delete(key));
      } catch (err) {
        remember(err);
        throw err;
      }
    },
    fetchViewer: (repo, ...args) => {
      throwIfLimited(repo);
      const key = repo ?? "__default__";
      if (cache.viewers.has(key)) return cache.viewers.get(key);
      throwIfReadBudgetExhausted(repo);
      try {
        const value = fetchViewer(repo, ...args);
        cache.viewers.set(key, value);
        return trackAsync(value, () => cache.viewers.delete(key));
      } catch (err) {
        remember(err);
        throw err;
      }
    },
    fetchInFlight: (repo) => {
      throwIfLimited(repo);
      const key = `${repo?.team ?? ""}::${repo?.project ?? ""}`;
      const hit = cache.inFlight.get(key);
      const at = resolveNow();
      if (hit && at - hit.at < IN_FLIGHT_CACHE_TTL_MS) return hit.value;
      throwIfReadBudgetExhausted(repo);
      try {
        cache.inFlightCalls += 1;
        const value = fetchInFlight(repo);
        cache.inFlight.set(key, { value, at });
        return trackAsync(value, () => cache.inFlight.delete(key));
      } catch (err) {
        remember(err);
        throw err;
      }
    },
  };
}

function fetchTicketDefault(ticketId, repo, { readBudget = null } = {}) {
  try {
    // Pass --repo so tools/ticket.mjs resolves the ticket's OWN control plane
    // (linear for CLNT repos, github for factory) instead of falling back to
    // the serve process's cwd repo. Without it, a Linear id like CLNT-1504
    // is read against the GitHub plane and dead-letters as "not a GitHub
    // issue identifier" — blocking all Linear-repo dispatch.
    const args = [linearCli(), "get", ticketId, "--json"];
    if (repo) args.push("--repo", repo);
    return JSON.parse(
      execFileSync("bun", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: linearReadTimeout(readBudget),
      }),
    );
  } catch (err) {
    // Budget exhaustion is deferrable, not a read failure (see the class).
    if (err instanceof LinearReadBudgetExceededError) throw err;
    throwIfLinearCliRateLimited(err);
    const stderr = String(err?.stderr ?? "");
    if (stderr.includes("no such issue")) return null;
    throwIfLinearReadBudgetExhausted(err, readBudget);
    throw new Error(`linear_read_failed: ${linearReadFailureReason(err)}`, {
      cause: err,
    });
  }
}

function fetchViewerDefault(
  repoName,
  configSnapshot = null,
  { readBudget = null } = {},
) {
  try {
    const repo = repoName
      ? getRepo(snapshotRepos(configSnapshot), repoName)
      : null;
    // GitHub App installation identities are not assignable users. The
    // GitHub control plane's claim uses the ambient `gh auth` user as the
    // lock owner, so resume checks must read that same identity via /user.
    // The ticket CLI routes the raw call through the repo's own plane.
    const rawQuery =
      repo?.controlPlane === "github" ? "/user" : "query{ viewer{ id name } }";
    const args = [linearCli(), "raw", rawQuery];
    if (repoName) args.push("--repo", repoName);
    const out = execFileSync("bun", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: linearReadTimeout(readBudget),
    });
    const parsed = JSON.parse(out);
    if (repo?.controlPlane === "github") {
      return parsed?.id == null
        ? null
        : {
            id: String(parsed.id),
            name: parsed.login ?? parsed.name ?? null,
          };
    }
    return parsed?.viewer ?? null;
  } catch (err) {
    // Budget exhaustion is deferrable, not a read failure (see the class).
    if (err instanceof LinearReadBudgetExceededError) throw err;
    throwIfLinearCliRateLimited(err);
    throwIfLinearReadBudgetExhausted(err, readBudget);
    throw new Error(`linear_read_failed: ${linearReadFailureReason(err)}`, {
      cause: err,
    });
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

function findWorkspacePullRequestDefault(payload) {
  const workspacePath = payload?.workspacePath;
  if (!workspacePath || !existsSync(workspacePath)) return null;
  const branch = execFileSync(
    "git",
    ["-C", workspacePath, "branch", "--show-current"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!branch) return null;
  return (
    loadForge()
      .prList(payload?.github, {
        cwd: workspacePath,
        state: "open",
        fields: ["number", "url", "headRefName", "isDraft", "state"],
      })
      .find((pr) => pr?.headRefName === branch) ?? null
  );
}

// WM-1006: in-flight tickets come from the control-plane adapter via the
// `inflight` CLI verb — never raw tracker GraphQL (plane-specific).

// Cache parsed manifest requirements, not the closure result. A repo can have
// many tickets planned by one long-lived daemon, but the manifest set is
// mutable while it is running. Entries are kept per repo name and refreshed
// whenever the policy or the matching manifest files change.
const OWNED_PATHS_CLOSURE_CACHE = new Map();
const MAX_OWNED_PATHS_CLOSURE_CACHE_ENTRIES = 128;

function pinManifestFreshness(repo) {
  const repoPath = path.resolve(repo.path);
  const policy = repo.ownedPathsPolicy ?? {};
  const patterns = Array.isArray(policy.pinManifests)
    ? policy.pinManifests
    : [];
  // Compiled root-free, matching `matchingManifestPaths`. Both matchers must
  // agree on which manifests a pattern covers: anchoring only one of them
  // would let a closure cache be keyed off a manifest set the other never
  // scanned, and serve a stale closure.
  const matchers = patterns.map(globToRegExp);
  const manifests = [];

  // Match the owned-paths reader's file-only traversal. Directory mtime alone
  // cannot observe a changed existing manifest, so include matched file mtime,
  // size, and content identity; the manifest list observes additions/removals.
  if (matchers.length && existsSync(repoPath)) {
    const pending = [repoPath];
    while (pending.length) {
      const dir = pending.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(filePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = path
          .relative(repoPath, filePath)
          .replace(/\\/g, "/");
        if (!matchers.some((matcher) => matcher.test(relativePath))) continue;
        const stat = statSync(filePath);
        manifests.push({
          path: relativePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          hash: hashBytes(readFileSync(filePath)),
        });
      }
    }
  }

  manifests.sort((a, b) => a.path.localeCompare(b.path));
  return canonicalJson({ repoPath, policy, manifests });
}

function cacheOwnedPathsClosureRequirements(repoName, freshness, requirements) {
  // Delete first to refresh insertion order. The small LRU bound keeps a
  // daemon that observes transient repo names from retaining requirements
  // forever, while replacement makes each per-repo entry directly evictable.
  OWNED_PATHS_CLOSURE_CACHE.delete(repoName);
  OWNED_PATHS_CLOSURE_CACHE.set(repoName, { freshness, requirements });
  if (OWNED_PATHS_CLOSURE_CACHE.size > MAX_OWNED_PATHS_CLOSURE_CACHE_ENTRIES) {
    OWNED_PATHS_CLOSURE_CACHE.delete(
      OWNED_PATHS_CLOSURE_CACHE.keys().next().value,
    );
  }
}

function ownedPathsClosureDetails(repoName, repo, ticketDescription) {
  if (!repo?.ownedPathsPolicy) return [];
  const freshness = pinManifestFreshness(repo);
  const cached = OWNED_PATHS_CLOSURE_CACHE.get(repoName);
  if (!cached || cached.freshness !== freshness) {
    const requirements = repo.ownedPathsPolicy.pinManifests?.length
      ? readPinManifestRequirements(
          repo.path,
          repo.ownedPathsPolicy.pinManifests,
        )
      : [];
    cacheOwnedPathsClosureRequirements(repoName, freshness, requirements);
  }
  const requirements = OWNED_PATHS_CLOSURE_CACHE.get(repoName).requirements;
  const ownedPaths = parseOwnedPaths(ticketDescription ?? "");
  return ownedPathsClosureGaps({
    ownedPaths,
    ownedPathsPolicy: repo.ownedPathsPolicy,
    pinManifestRequirements: requirements,
  });
}

function fetchInFlightDefault(repoConfig, { readBudget = null } = {}) {
  try {
    // --repo so ticket.mjs resolves this repo's own control plane (a Linear
    // team/project query against the GitHub plane fails as a project-title
    // mismatch, blocking the cap check for control_plane: linear repos).
    const args = [
      linearCli(),
      "inflight",
      "--team",
      String(repoConfig.team),
      "--project",
      String(repoConfig.project),
      "--json",
    ];
    if (repoConfig.name) args.push("--repo", repoConfig.name);
    const out = execFileSync("bun", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: linearReadTimeout(readBudget),
    });
    const rows = JSON.parse(out);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    // Budget exhaustion is deferrable, not a read failure (see the class).
    if (err instanceof LinearReadBudgetExceededError) throw err;
    throwIfLinearCliRateLimited(err);
    throwIfLinearReadBudgetExhausted(err, readBudget);
    throw new Error(`linear_read_failed: ${linearReadFailureReason(err)}`, {
      cause: err,
    });
  }
}

// The general planner and execute-time gate intentionally retain their
// synchronous public contract (several non-serve callers rely on it). Chain
// auto-approval runs on serve's event loop, so it uses this async reader set
// instead. Keeping the boundary explicit prevents a Promise from silently
// becoming a successful or failed synchronous eligibility verdict.
export const AUTO_APPROVAL_CONTROL_PLANE_READ_TIMEOUT_MS = (() => {
  const value = Number(process.env.FACTORY_AUTO_APPROVAL_READ_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 5_000;
})();

async function spawnRead(args, timeoutMs) {
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Backstop only: the explicit timer below owns the classification, and a
    // child that ignores SIGTERM still has to die.
    timeout: Math.max(1, timeoutMs) + 500,
    killSignal: "SIGKILL",
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited: the awaited result below is authoritative.
      }
    },
    Math.max(1, timeoutMs),
  );
  let stdout;
  let stderr;
  let exitCode;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (exitCode === 0) return stdout;
  // `linearReadTimedOut` is the only thing standing between a stalled control
  // plane and a hard `dispatch_recheck_failed: linear_read_failed` that the
  // chain memo then holds for a full stale window. It recognises a timeout by
  // `code === "ETIMEDOUT"` or by `signal === "SIGTERM" && status == null` —
  // the shape `child_process` gives a killed sync read — so reproduce exactly
  // that shape here instead of a bare non-zero exit.
  if (timedOut) {
    const err = new Error(
      `command timed out after ${timeoutMs}ms: ${args.join(" ")}`,
    );
    err.code = "ETIMEDOUT";
    err.signal = proc.signalCode ?? "SIGTERM";
    err.status = null;
    err.stderr = stderr;
    err.stdout = stdout;
    throw err;
  }
  const err = new Error(stderr.trim() || `command exited ${exitCode}`);
  err.stderr = stderr;
  err.stdout = stdout;
  err.status = exitCode;
  err.signal = proc.signalCode ?? null;
  throw err;
}

function autoApprovalReadTimeout(readBudget) {
  return Math.min(
    AUTO_APPROVAL_CONTROL_PLANE_READ_TIMEOUT_MS,
    linearReadTimeout(readBudget),
  );
}

async function fetchTicketAsync(ticketId, repo, { readBudget = null } = {}) {
  try {
    const args = [linearCli(), "get", ticketId, "--json"];
    if (repo) args.push("--repo", repo);
    return JSON.parse(
      await spawnRead(["bun", ...args], autoApprovalReadTimeout(readBudget)),
    );
  } catch (err) {
    if (err instanceof LinearReadBudgetExceededError) throw err;
    throwIfLinearCliRateLimited(err);
    const stderr = String(err?.stderr ?? "");
    if (stderr.includes("no such issue")) return null;
    throwIfLinearReadBudgetExhausted(err, readBudget);
    throw new Error(`linear_read_failed: ${linearReadFailureReason(err)}`, {
      cause: err,
    });
  }
}

async function fetchViewerAsync(
  repoName,
  configSnapshot = null,
  { readBudget = null } = {},
) {
  try {
    const repo = repoName
      ? getRepo(snapshotRepos(configSnapshot), repoName)
      : null;
    const query =
      repo?.controlPlane === "github" ? "/user" : "query{ viewer{ id name } }";
    const args = [linearCli(), "raw", query];
    if (repoName) args.push("--repo", repoName);
    const parsed = JSON.parse(
      await spawnRead(["bun", ...args], autoApprovalReadTimeout(readBudget)),
    );
    return repo?.controlPlane === "github"
      ? parsed?.id == null
        ? null
        : { id: String(parsed.id), name: parsed.login ?? parsed.name ?? null }
      : (parsed?.viewer ?? null);
  } catch (err) {
    if (err instanceof LinearReadBudgetExceededError) throw err;
    throwIfLinearCliRateLimited(err);
    throwIfLinearReadBudgetExhausted(err, readBudget);
    throw new Error(`linear_read_failed: ${linearReadFailureReason(err)}`, {
      cause: err,
    });
  }
}

async function fetchInFlightAsync(repoConfig, { readBudget = null } = {}) {
  try {
    const args = [
      linearCli(),
      "inflight",
      "--team",
      String(repoConfig.team),
      "--project",
      String(repoConfig.project),
      "--json",
    ];
    if (repoConfig.name) args.push("--repo", repoConfig.name);
    const rows = JSON.parse(
      await spawnRead(["bun", ...args], autoApprovalReadTimeout(readBudget)),
    );
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err instanceof LinearReadBudgetExceededError) throw err;
    throwIfLinearCliRateLimited(err);
    throwIfLinearReadBudgetExhausted(err, readBudget);
    throw new Error(`linear_read_failed: ${linearReadFailureReason(err)}`, {
      cause: err,
    });
  }
}

// Escalation-only forge reads. These run at most twice per escalated
// continuation (never on the ordinary dispatch path), so they reuse the forge
// client the synchronous gate already uses rather than re-deriving the REST
// shapes: `prView`'s field projection, `prList`'s `cwd: workspacePath` repo
// resolution, and the explicit `headRefName === branch` match that a bare
// `pulls[0]` would silently get wrong when the forge returns more than one row.
async function fetchPullRequestAsync(payload) {
  return fetchPullRequestDefault(payload);
}

async function findWorkspacePullRequestAsync(payload) {
  return findWorkspacePullRequestDefault(payload);
}

/**
 * The dispatch bag for serve's chain-approval pass.
 *
 * Before this existed the serve tick handed `autoApproveChains` the raw SQLite
 * handle, which is not a dispatch bag at all: `withPassInFlightCache` saw no
 * `fetchInFlight` and returned it unchanged (so #1064's per-pass in-flight
 * cache was inert under serve), the eligibility gate found no injected readers
 * and fell back to the uncached synchronous `*Default` fetchers, and
 * `wrapLinearReads` — the ticket/viewer/in-flight memo *and* the rate-limit
 * latch — never applied on this path at all. This wires all three together
 * with awaited readers and a per-row read deadline.
 *
 * `resetReadBudget` is called by the async gate at the start of every row, so a
 * stalled row cannot spend the next row's read time (the same rule
 * `planAdmittedEvents` applies per event).
 */
export function createAutoApprovalDispatch({
  now = Date.now,
  configSnapshot = null,
  cache = null,
  readTimeoutMs = AUTO_APPROVAL_CONTROL_PLANE_READ_TIMEOUT_MS,
} = {}) {
  const snapshot = configSnapshot ?? policySnapshot();
  const readCache = cache ?? createLinearReadCache();
  const newBudget = () =>
    createLinearReadBudget({ now, timeoutMs: readTimeoutMs });
  readCache.linearReadBudget = newBudget();
  const readBudget = () => readCache.linearReadBudget;
  return wrapLinearReads(
    {
      configSnapshot: snapshot,
      resetReadBudget: () => {
        readCache.linearReadBudget = newBudget();
      },
      fetchTicket: (ticketId, repo) =>
        fetchTicketAsync(ticketId, repo, { readBudget: readBudget() }),
      fetchViewer: (repoName, snap = snapshot) =>
        fetchViewerAsync(repoName, snap, { readBudget: readBudget() }),
      fetchInFlight: (repo) =>
        fetchInFlightAsync(repo, { readBudget: readBudget() }),
      fetchPullRequest: fetchPullRequestAsync,
      findWorkspacePullRequest: findWorkspacePullRequestAsync,
    },
    readCache,
    now,
    snapshot,
  );
}

/**
 * The serve loop evaluates every admitted event in one tick. Keep the mutable
 * config view consistent within that tick and avoid re-parsing both YAML files
 * for every dispatch candidate. Direct callers deliberately retain the old
 * root-default path by omitting this snapshot.
 */
export function policySnapshot(root = reposRoot()) {
  const policyFile = resolveConfigPath("policy", { root });
  let policy = null;
  if (existsSync(policyFile)) {
    try {
      const parsed = Bun.YAML.parse(readFileSync(policyFile, "utf8"));
      policy = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // Existing policy helpers fail safe on malformed policy. Preserve that
      // behavior in the shared snapshot rather than making a whole tick fail.
    }
  }

  let repos = null;
  let reposError = null;
  try {
    repos = loadRepos({ root });
  } catch (err) {
    reposError = err;
  }
  return { root, policyFile, policy, repos, reposError };
}

function snapshotRepos(snapshot) {
  if (snapshot?.reposError) throw snapshot.reposError;
  return snapshot?.repos ?? loadRepos();
}

function dispatchToolchainEligibility(
  payload,
  { configSnapshot = null, toolchain = {} } = {},
) {
  let repos;
  try {
    repos = snapshotRepos(configSnapshot);
  } catch (err) {
    // A registry failure is not an unknown-repo lookup. Avoid a toolchain
    // probe; the worktree gate records its typed refusal and evidence.
    return { registryInvalid: true, error: err };
  }
  let repo;
  try {
    repo = getRepo(repos, payload?.repo);
  } catch (err) {
    // An unknown repo is not a toolchain fact: leave it to the worktree gate,
    // which refuses it as `human_needed repo_unknown` with full evidence.
    if (err instanceof RepoError) return null;
    throw err;
  }
  // Preserve the additive path exactly: no declared tools means no probe and
  // no new dispatch behavior.
  if (!repo.toolchain?.length) return null;
  const cache = toolchain.cache ?? dispatchToolchainPreflightCache;
  const key = `${repo.name}:${toolchainHash(repo.toolchain)}`;
  if (cache.has(key)) return cache.get(key);
  const result = repoDispatchPreflightSync(repo, {
    node: toolchain.node,
    now: toolchain.now,
    which: toolchain.which,
    spawn: toolchain.spawn,
  });
  cache.set(key, result);
  return result;
}

function policyMaxInFlight(root = reposRoot(), snapshot = null) {
  const value = loadRuntimePolicy(root, snapshot)?.concurrency
    ?.max_in_flight_per_repo;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_IN_FLIGHT;
}

/**
 * Owned Paths collision mode (WM-677). `strict` refuses dispatch on any overlap
 * with an in-flight ticket — the historical behavior, and the fail-closed
 * default when the key is absent or malformed. `advisory` records the overlap
 * on the proposal as evidence and dispatches anyway, refusing only the narrow
 * hard-conflict set (a whole-repo claim): textual overlap is what rebase and
 * merge-fix already resolve, and refusing it at dispatch was starving the pool
 * for conflicts that mostly never materialized.
 */
export const DEFAULT_OWNED_PATHS_COLLISION = "strict";
export function policyOwnedPathsCollision(root = reposRoot(), snapshot = null) {
  const value = loadRuntimePolicy(root, snapshot)?.dispatch
    ?.owned_paths_collision;
  return value === "advisory" ? "advisory" : DEFAULT_OWNED_PATHS_COLLISION;
}

/** Re-exported from ./runtime-policy.mjs (single source of truth). */
export { DEFAULT_DISPATCH_SECURITY, policyDispatchSecurity };

/** Whether unattended dispatch admission is temporarily paused by an operator. */
export const DEFAULT_DISPATCH_PAUSED = false;
export function policyDispatchPaused(root = reposRoot(), snapshot = null) {
  const value = loadRuntimePolicy(root, snapshot)?.dispatch?.paused;
  return value === true ? true : DEFAULT_DISPATCH_PAUSED;
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

function loadRepoEscalatePaths(repoName, root = reposRoot(), snapshot = null) {
  let repo;
  try {
    // `loadRepos` validates the entire host registry deliberately: host-wide
    // routing, lifecycle, and capacity facts must come from one coherent
    // configuration revision. An invalid unrelated stanza therefore blocks
    // dispatch rather than letting this gate evaluate against a partial view.
    const repos = snapshot ? snapshotRepos(snapshot) : loadRepos({ root });
    repo = getRepo(repos, repoName);
  } catch (err) {
    throw new RepoError(
      `${reposConfigPath(root)}: cannot verify escalate_paths: ${err.message}`,
    );
  }
  if (!Array.isArray(repo.escalatePaths)) {
    throw new RepoError(
      `${reposConfigPath(root)}: repo ${repoName} must declare escalate_paths as an array (use [] only when deliberately empty)`,
    );
  }
  return [...new Set(repo.escalatePaths.map((item) => item.trim()))];
}

function defaultBudgetRefusal(root = reposRoot(), snapshot = null) {
  const policy = loadRuntimePolicy(root, snapshot);
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
    // A parsed `**/*` is no more bounded than the synthetic `**` used for a
    // missing section. Both must refuse before collision checks.
    ownedPathsParsed:
      parsed.length > 0 && !parsed.some((glob) => isMatchEverythingGlob(glob)),
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
 * Reject malformed dispatch candidates before asking their tracker to look
 * them up. A work-scan result is advisory input, and a legacy Linear ID on a
 * GitHub-controlled repo would otherwise throw from the adapter, retry until
 * the event is dead-lettered, and consume a chain slot each time.
 *
 * Linear's control plane deliberately accepts its opaque identifiers at
 * lookup time. GitHub is the parser-bearing plane today, so use the same
 * parser its adapter uses rather than duplicating a narrower regex here.
 */
function invalidTicketIdentifierReason(repo, ticket, snapshot = null) {
  const controlPlane =
    repo.controlPlane ??
    loadRuntimePolicy(snapshot?.root ?? reposRoot(), snapshot)?.controlPlane
      ?.kind ??
    "linear";
  if (controlPlane !== "github") return null;
  try {
    parseIssueIdentifier(ticket, repo.github ?? undefined);
    return null;
  } catch (err) {
    return `ticket_identifier_unresolvable: ${err.message}`;
  }
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
    ownedPathsParsed:
      parsed.length > 0 && !parsed.some((glob) => isMatchEverythingGlob(glob)),
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
/**
 * The tier-escalation continuation bindings, as a check map. Shared so the
 * async wrapper can decide whether an escalation prefetch is worth a forge read
 * using exactly the condition the gate itself will apply — an unauthorised
 * continuation refuses before it ever looks at a pull request.
 *
 * @returns {Record<string, boolean>|null} null when there is no continuation.
 */
function escalationContinuationChecks(payload, escalatedContinuation) {
  if (!escalatedContinuation) return null;
  return {
    ticket_escalation_failed_run_bound: Boolean(
      escalatedContinuation.failedRunId,
    ),
    ticket_escalation_continuation_run_bound: Boolean(
      escalatedContinuation.continuationRunId,
    ),
    ticket_escalation_root_run_bound: Boolean(escalatedContinuation.rootRunId),
    ticket_escalation_projection_applied:
      escalatedContinuation.projectionState === "applied",
    ticket_escalation_repo_matches:
      escalatedContinuation.repo === payload?.repo,
    ticket_escalation_ticket_matches:
      String(escalatedContinuation.ticket) === String(payload?.ticket),
    ticket_escalation_model_tier_strong: payload?.modelTier === "strong",
  };
}

export function worktreeDispatchAutoEligibility(
  payload,
  {
    fetchTicket = fetchTicketDefault,
    fetchViewer = fetchViewerDefault,
    fetchPullRequest = fetchPullRequestDefault,
    findWorkspacePullRequest = findWorkspacePullRequestDefault,
    fetchInFlight = fetchInFlightDefault,
    countLeases = (repoName) => liveWorkerLeases(repoName).length,
    hasTicketLease = (repoName, ticket) =>
      liveWorkerLeases(repoName).some(
        (lease) => String(lease.ticket) === String(ticket),
      ),
    maxInFlightFallback,
    budgetRefusal = defaultBudgetRefusal,
    claimedRetry = null,
    escalatedContinuation = null,
    operatorAuthorized = false,
    now = Date.now(),
    configSnapshot = null,
  } = {},
) {
  const configRoot = configSnapshot?.root ?? reposRoot();
  const evidence = {
    checkedAt: new Date(resolveNow(now)).toISOString(),
    repo: {},
    checks: {},
    ticket: null,
    inFlight: [],
    escalatePathIntersections: [],
  };
  // This is deliberately an explicit caller-supplied fact rather than a
  // ticket label: only the planner may derive it from an operator envelope.
  // Keep it in the proof so bypasses are auditable alongside every other
  // dispatch admission fact.
  evidence.checks.operator_authorized = operatorAuthorized === true;
  let repos;
  try {
    repos = snapshotRepos(configSnapshot);
  } catch (err) {
    evidence.checks.repo_registry_valid = false;
    return refusal(
      `repo_registry_invalid: ${err.message}`,
      evidence,
      "human_needed",
    );
  }
  evidence.checks.repo_registry_valid = true;
  let repo;
  try {
    repo = getRepo(repos, payload?.repo);
  } catch (err) {
    evidence.checks.repo_found = false;
    return refusal(`repo_unknown: ${err.message}`, evidence, "human_needed");
  }
  const cap =
    repo.maxInFlight ??
    maxInFlightFallback ??
    policyMaxInFlight(configRoot, configSnapshot);
  const live = countLeases(repo.name);
  evidence.repo = {
    name: repo.name,
    github: repo.github ?? null,
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

  const invalidTicketIdentifier = invalidTicketIdentifierReason(
    repo,
    payload?.ticket,
    configSnapshot,
  );
  if (invalidTicketIdentifier) {
    evidence.checks.ticket_identifier_parseable = false;
    return refusal(invalidTicketIdentifier, evidence);
  }
  evidence.checks.ticket_identifier_parseable = true;

  const escalationChecks = escalationContinuationChecks(
    payload,
    escalatedContinuation,
  );
  if (escalationChecks) Object.assign(evidence.checks, escalationChecks);
  const canResumeEscalation = Boolean(
    escalationChecks && Object.values(escalationChecks).every(Boolean),
  );
  const failedEscalationCheck = escalationChecks
    ? (Object.entries(escalationChecks).find(([, passed]) => !passed)?.[0] ??
      null)
    : null;

  let budgetReason;
  try {
    budgetReason = budgetRefusal(configRoot, configSnapshot);
  } catch {
    budgetReason = "budget_check_failed";
  }
  if (budgetReason) return refusal(budgetReason, evidence);
  evidence.checks.budget_available = true;

  // A tier escalation transfers one already-live ticket lease rather than
  // admitting another dispatch. At a full cap, discount only the exact
  // ticket lease authenticated by the durable continuation handoff; if the
  // failed worker has already released it, the ordinary capacity count wins.
  let transferredLease = false;
  if (live >= cap && canResumeEscalation) {
    try {
      transferredLease = hasTicketLease(repo.name, payload?.ticket) === true;
    } catch {
      transferredLease = false;
    }
  }
  const effectiveLive = live - (transferredLease ? 1 : 0);
  if (canResumeEscalation) {
    evidence.repo.capTransferred = transferredLease;
    evidence.repo.capEffective = effectiveLive;
  }
  if (effectiveLive >= cap) return refusal("capacity_full", evidence);
  evidence.checks.cap_available = true;

  const ticket = fetchTicket(payload?.ticket, payload?.repo);
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

  // A durable continuation row is not a second route to ordinary dispatch.
  // If any binding is wrong (including a projection not yet applied), fail
  // closed even when the ticket happens to be unassigned at this instant.
  if (escalatedContinuation && !canResumeEscalation) {
    return refusal(
      "ticket_assigned",
      evidence,
      "noop",
      `tier_escalation_check_failed:${failedEscalationCheck}`,
    );
  }

  const failedPrNumber = escalatedContinuation?.failedRunArtifact?.prNumber;
  if (canResumeEscalation && Number.isInteger(failedPrNumber)) {
    let failedPullRequest;
    try {
      failedPullRequest = fetchPullRequest({
        github: repo.github,
        pr: failedPrNumber,
      });
    } catch (err) {
      return refusal(
        "ticket_escalation_pr_read_failed",
        evidence,
        "noop",
        err?.message ?? String(err),
      );
    }
    evidence.escalatedPullRequest = failedPullRequest;
    evidence.checks.ticket_escalation_pr_read = true;
    if (["MERGED", "CLOSED"].includes(failedPullRequest?.state)) {
      return refusal("ticket_escalation_pr_closed", evidence);
    }
    evidence.checks.ticket_escalation_pr_active = true;
  }

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
    if (!canResumeClaim && !canResumeEscalation) {
      return refusal(
        "ticket_assigned",
        evidence,
        "noop",
        failedEscalationCheck
          ? `tier_escalation_check_failed:${failedEscalationCheck}`
          : null,
      );
    }
    const viewer = fetchViewer(payload?.repo, configSnapshot);
    const viewerOwnsClaim = Boolean(
      viewer?.id && String(ticket.assignee.id) === String(viewer.id),
    );
    evidence.checks.ticket_claim_viewer_identity = viewerOwnsClaim;
    if (!viewerOwnsClaim) {
      return refusal(
        canResumeEscalation ? "ticket_claimed_by_other" : "ticket_assigned",
        evidence,
        "noop",
        canResumeEscalation
          ? "tier_escalation_check_failed:viewer_identity"
          : null,
      );
    }
    retryClaimedByFactory = true;
  } else {
    evidence.checks.ticket_unassigned = true;
  }

  if (ticket.state?.name !== "Todo") {
    const resumableState = canResumeEscalation
      ? ["In Progress", "In Review"].includes(ticket.state?.name)
      : ticket.state?.name === "In Progress";
    if (!(retryClaimedByFactory && resumableState)) {
      return refusal("ticket_not_todo", evidence);
    }
    resumingOwnClaim = true;
    if (canResumeEscalation) {
      evidence.checks.ticket_claim_escalation = true;
      evidence.ticket.escalatedFromRunId = escalatedContinuation.failedRunId;
      evidence.ticket.escalatedContinuationRunId =
        escalatedContinuation.continuationRunId;
    } else {
      evidence.checks.ticket_claim_retry = true;
      evidence.checks.ticket_in_progress_retry = true;
      evidence.ticket.claimedRetryRunId = claimedRetry.runId;
    }
  } else {
    // Assignment alone is not a surviving factory claim. Requiring the state
    // transition as well prevents an own-assigned Todo ticket from bypassing
    // the normal claim mutation and its read-back concurrency control.
    if (retryClaimedByFactory) return refusal("ticket_assigned", evidence);
    evidence.checks.ticket_todo = true;
  }

  if (!evidence.ticket.labels.includes("ai:agent-ready")) {
    const claimedLabel =
      evidence.ticket.labels.includes("ai:in-progress") ||
      (canResumeEscalation &&
        evidence.ticket.labels.includes("ai:needs-review"));
    if (!(resumingOwnClaim && claimedLabel)) {
      return refusal("ticket_not_agent_ready", evidence);
    }
    evidence.checks.ticket_in_progress_label_retry = true;
  } else {
    evidence.checks.ticket_agent_ready = true;
  }
  // Resolve the checkout branch only after the tracker proves this continuation
  // still owns the ticket. A foreign claim is a tracker refusal and must not be
  // converted into a transient forge-read failure.
  if (canResumeEscalation && escalatedContinuation?.workspacePath) {
    let workspacePullRequest;
    try {
      workspacePullRequest = findWorkspacePullRequest({
        github: repo.github,
        workspacePath: escalatedContinuation.workspacePath,
      });
    } catch (err) {
      return refusal(
        "ticket_escalation_pr_read_failed",
        evidence,
        "noop",
        err?.message ?? String(err),
      );
    }
    evidence.escalatedWorkspacePullRequest = workspacePullRequest;
    evidence.checks.ticket_escalation_workspace_pr_read = true;
    if (workspacePullRequest && workspacePullRequest.isDraft !== true) {
      evidence.checks.ticket_escalation_workspace_pr_ready = true;
      if (HANDOFF_REASON_CODES.has(escalatedContinuation.failedRunReasonCode)) {
        evidence.checks.ticket_escalation_workspace_pr_handoff_failed = true;
        return refusal("ticket_pr_handoff_verification_failed", evidence);
      }
      return refusal("ticket_pr_already_open", evidence);
    }
    evidence.checks.ticket_escalation_workspace_pr_ready = false;
  }
  if (
    evidence.ticket.labels.includes("ai:escalated") &&
    !evidence.checks.operator_authorized
  ) {
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

    // Verification Command is executable worker input, so an absent pin is
    // not evidence. Legacy tickets must be re-labelled through the pin-aware
    // path before dispatch rather than silently retaining a rollout bypass.
    // The two refusals are kept distinct: a MISSING pin is a ticket the
    // orchestrator can simply re-stamp (relabel sweep), while a MISMATCHED
    // pin means the body actually changed after readiness and needs a human
    // to look at what changed.
    const hasPin = Boolean(evidence.ticket.readyPinHash);
    const pinMatches =
      hasPin &&
      evidence.ticket.readyPinHash === evidence.ticket.descriptionHash;
    evidence.checks.ticket_body_pin_matches = pinMatches;
    if (!hasPin) return refusal("ticket_ready_pin_missing", evidence);
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

  // Never let effectiveOwnedPaths' fail-closed whole-repo sentinel masquerade
  // as a real path during a sensitive-path check. Unknown ticket scope is its
  // own refusal, before overlap or escalate_paths can assign a misleading
  // cause.
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
  const isSecurityTicket =
    evidence.ticket.labels.includes("type:security") ||
    evidence.ticket.labels.some((label) => /security/i.test(label));
  // A security ticket may still dispatch when the operator sourced it OR when
  // policy opts the repo into `dispatch.security_tickets: auto` (WM-1060). The
  // merge lane refuses to merge a security PR (merge-plan §escalation), so this
  // only ever produces a PR held for human merge — never an auto-merge — and
  // the escalate_paths sensitive-file gate below still guards touched files.
  evidence.checks.security_dispatch_mode = policyDispatchSecurity(
    configRoot,
    configSnapshot,
  );
  if (
    isSecurityTicket &&
    !evidence.checks.operator_authorized &&
    evidence.checks.security_dispatch_mode !== "auto"
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
  const collisionMode = policyOwnedPathsCollision(configRoot, configSnapshot);
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
    // Advisory means advisory: a whole-repo (`**`) overlap — which is what a
    // missing/unparseable Owned Paths section on an in-flight ticket resolves
    // to (ownedPathsForCollision → ["**"]) — is recorded for visibility but
    // must NOT block. A single scope-unknown in-flight ticket (e.g. an epic or
    // an auto-filed issue parked "In Progress" without an Owned Paths section)
    // would otherwise claim the entire repository and freeze the whole queue,
    // stalling the factory while ready work waits. Overlaps are reconciled
    // downstream by rebase + merge-fix and the cold merge review. Strict mode
    // (owned_paths_collision != "advisory") still refuses on any overlap above.
    if (hard.length) evidence.ownedPathsHardConflicts = hard;
  } else {
    evidence.checks.owned_paths_disjoint = true;
  }
  try {
    evidence.repo.escalatePaths = loadRepoEscalatePaths(
      repo.name,
      configRoot,
      configSnapshot,
    );
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
  if (evidence.escalatePathIntersections.length > 0 && !operatorAuthorized) {
    return refusal(
      "escalate_paths_intersect",
      evidence,
      "noop",
      `intersecting escalate_paths globs: ${evidence.escalatePathIntersections.join(", ")}`,
    );
  }
  return { ok: true, evidence };
}

/** Thrown by the local-refusal prepass the first time the gate wants a read. */
const CONTROL_PLANE_READ_REQUIRED = Symbol("control_plane_read_required");

/**
 * Async counterpart for the serve-loop chain approval path. The historical
 * synchronous gate remains in place for planner and execute-time consumers
 * outside that loop; changing it would turn their established result contract
 * into Promises. All control-plane readers used here yield.
 *
 * Shape of the pass, and why:
 *
 *  1. A *local-refusal prepass* runs the gate with readers that refuse to read.
 *     Every zero-read refusal (`repo_registry_invalid`, `repo_unknown`,
 *     `repo_report_only`, `no_worktree_scripts`, a malformed ticket id, the
 *     budget refusal, `capacity_full`) is decided there, so a row that cannot
 *     dispatch never spends a control-plane read. The prepass stops at the
 *     gate's first read, well before `ownedPathsClosureDetails` walks the repo
 *     for pin manifests, so it is cheap; the lease count it needs is memoised
 *     and handed to the real pass.
 *  2. The reads the gate will actually want are then resolved once, under the
 *     gate's own conditions (viewer only for an assigned ticket, forge reads
 *     only for an authorised escalation continuation).
 *  3. The gate runs *once* more, with every reader resolved. The expensive tail
 *     — owned-paths closure, pin-manifest freshness, escalate-path globs — is
 *     therefore evaluated exactly one time per row, which is the whole point of
 *     moving this pass off the synchronous path.
 *
 * A read that throws is not swallowed: it is replayed from the throwing reader
 * inside the real pass, so the gate emits its own typed refusal with full
 * evidence rather than the wrapper inventing one (or rejecting outright).
 */
export async function worktreeDispatchAutoEligibilityAsync(
  payload,
  options = {},
) {
  // Per-row deadline: a stalled row must not consume the next row's read time.
  options.resetReadBudget?.();
  const readBudget = options.readBudget ?? null;
  const fetchTicket =
    options.fetchTicket ??
    ((ticket, repo) => fetchTicketAsync(ticket, repo, { readBudget }));
  const fetchViewer =
    options.fetchViewer ??
    ((repo, snapshot) => fetchViewerAsync(repo, snapshot, { readBudget }));
  const fetchInFlight =
    options.fetchInFlight ??
    ((repo) => fetchInFlightAsync(repo, { readBudget }));
  const fetchPullRequest = options.fetchPullRequest ?? fetchPullRequestAsync;
  const findWorkspacePullRequest =
    options.findWorkspacePullRequest ?? findWorkspacePullRequestAsync;

  // Worker leases are a filesystem scan. Memoise them across the two gate
  // passes so the prepass costs nothing the real pass then repeats.
  const baseCountLeases =
    options.countLeases ?? ((repoName) => liveWorkerLeases(repoName).length);
  const baseHasTicketLease =
    options.hasTicketLease ??
    ((repoName, ticket) =>
      liveWorkerLeases(repoName).some(
        (lease) => String(lease.ticket) === String(ticket),
      ));
  const leaseCounts = new Map();
  const ticketLeases = new Map();
  const countLeases = (repoName) => {
    const key = String(repoName ?? "");
    if (!leaseCounts.has(key)) leaseCounts.set(key, baseCountLeases(repoName));
    return leaseCounts.get(key);
  };
  const hasTicketLease = (repoName, ticket) => {
    const key = `${repoName ?? ""}\u0000${ticket ?? ""}`;
    if (!ticketLeases.has(key))
      ticketLeases.set(key, baseHasTicketLease(repoName, ticket));
    return ticketLeases.get(key);
  };
  // Same reason: the budget refusal reads policy and the ledger. The prepass
  // and the real pass are one row's evaluation, so they see one answer.
  const baseBudgetRefusal = options.budgetRefusal ?? defaultBudgetRefusal;
  let budgetRefusalMemo;
  const budgetRefusal = (...args) => {
    if (budgetRefusalMemo === undefined)
      budgetRefusalMemo = baseBudgetRefusal(...args);
    return budgetRefusalMemo;
  };
  const base = { ...options, countLeases, hasTicketLease, budgetRefusal };

  const readRefused = () => {
    throw CONTROL_PLANE_READ_REQUIRED;
  };
  let localRefusal = null;
  try {
    localRefusal = worktreeDispatchAutoEligibility(payload, {
      ...base,
      fetchTicket: readRefused,
      fetchViewer: readRefused,
      fetchInFlight: readRefused,
      fetchPullRequest: readRefused,
      findWorkspacePullRequest: readRefused,
    });
  } catch (err) {
    if (err !== CONTROL_PLANE_READ_REQUIRED) throw err;
  }
  // A verdict without a read is final either way: the gate reads nothing after
  // it has decided.
  if (localRefusal) return localRefusal;

  const ticket = await fetchTicket(payload?.ticket, payload?.repo);
  const viewer = ticket?.assignee
    ? await fetchViewer(payload?.repo, options.configSnapshot)
    : null;
  let repo = null;
  try {
    repo = getRepo(snapshotRepos(options.configSnapshot), payload?.repo);
  } catch {
    // Unreachable after the prepass, which owns the typed unknown-repo
    // refusal; stay defensive rather than turning it into a rejection.
  }
  const escalation = options.escalatedContinuation ?? null;
  const escalationChecks = escalationContinuationChecks(payload, escalation);
  // Only an escalation the gate will actually honour is worth a forge read;
  // an unauthorised continuation refuses `ticket_assigned` before it looks.
  const canResumeEscalation = Boolean(
    escalationChecks && Object.values(escalationChecks).every(Boolean),
  );
  let failedPullRequest = null;
  let failedPullRequestError = null;
  if (
    canResumeEscalation &&
    Number.isInteger(escalation?.failedRunArtifact?.prNumber)
  ) {
    try {
      failedPullRequest = await fetchPullRequest({
        github: repo?.github,
        pr: escalation.failedRunArtifact.prNumber,
      });
    } catch (err) {
      failedPullRequestError = err;
    }
  }
  let workspacePullRequest = null;
  let workspacePullRequestError = null;
  if (canResumeEscalation && escalation?.workspacePath) {
    try {
      workspacePullRequest = await findWorkspacePullRequest({
        github: repo?.github,
        workspacePath: escalation.workspacePath,
      });
    } catch (err) {
      workspacePullRequestError = err;
    }
  }
  // The in-flight list is the gate's last read and sits behind every ticket,
  // claim and owned-paths refusal — but the gate is synchronous, so resolving
  // it lazily would cost a second full pass (and a second pin-manifest walk)
  // for every healthy row. Resolve it here instead: the caller's dispatch bag
  // memoises the query per repo for the pass (#1064) and per team+project for
  // the cache TTL, so at most one query is issued for the whole pass however
  // many rows reach this point.
  const inFlight = await fetchInFlight(repo);

  return worktreeDispatchAutoEligibility(payload, {
    ...base,
    fetchTicket: () => ticket,
    fetchViewer: () => viewer,
    fetchInFlight: () => inFlight,
    fetchPullRequest: () => {
      if (failedPullRequestError) throw failedPullRequestError;
      return failedPullRequest;
    },
    findWorkspacePullRequest: () => {
      if (workspacePullRequestError) throw workspacePullRequestError;
      return workspacePullRequest;
    },
  });
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
  if (isMatchEverythingGlob(owner) || owner === candidate) return true;

  const candidateHasGlob = /[*?{]/.test(candidate);
  // Merge-fix eligibility is evaluated from the ticket payload before a
  // checkout is guaranteed to exist, so bare Owned Paths keep their broad
  // any-depth semantics here; nothing on this path stats the filesystem.
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
    ticket = fetchTicket(payload?.ticket, payload?.repo);
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

function setEventStatus(db, event, status, reason = null) {
  db.query(
    `UPDATE events
     SET status = ?,
         last_plan_error = CASE WHEN ? = 'noop' THEN ? ELSE last_plan_error END
     WHERE source = ? AND event_id = ?`,
  ).run(status, status, reason, event.source, event.event_id);
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
       AND (
         state <> 'FAILED'
         OR (
           ? = 1
           AND (
             json_extract(spec_json, '$.maxAttempts') IS NULL
             OR attempts < json_extract(spec_json, '$.maxAttempts')
           )
         )
       )
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
  setEventStatus(db, event, "noop", reason);
  return { decision: "noop", proposal, runId: blockingRun.run_id, reason };
}

const WEBHOOK_MERGE_SCAN_ALREADY_LIVE = "webhook_merge_scan_already_live";
const WEBHOOK_MERGE_SCAN_PENDING = "webhook_merge_scan_pending";
const EXECUTING_MERGE_SCAN_STATES = new Set(["LEASED", "RUNNING", "VERIFYING"]);

function queuedWebhookMergeScan(db, runId) {
  return db
    .query(
      `SELECT id, reason
         FROM proposals
         WHERE run_id = ?
           AND decision = 'noop'
           AND reason IN (?, ?)
         LIMIT 1`,
    )
    .get(runId, WEBHOOK_MERGE_SCAN_ALREADY_LIVE, WEBHOOK_MERGE_SCAN_PENDING);
}

function moveQueuedWebhookMergeScan(
  db,
  proposalId,
  event,
  reason,
  at,
  ttlSeconds,
) {
  db.query(
    `UPDATE proposals
     SET event_source = ?, event_id = ?, reason = ?,
         spec_json = NULL, spec_hash = NULL, idempotency_key = NULL,
         created_at = ?, ttl_seconds = ?
     WHERE id = ?`,
  ).run(event.source, event.event_id, reason, at, ttlSeconds, proposalId);
  setEventStatus(db, event, "noop", reason);
  return db.query(`SELECT * FROM proposals WHERE id = ?`).get(proposalId);
}

/**
 * Re-admit the single webhook delivery retained behind each finished merge
 * scan. A never-executed scan re-arms one coalesced delivery only when refused
 * or cancelled; an executed scan re-arms only deliveries received while running.
 * "Never executed" is proven by the lifecycle journal (no LEASED record) rather
 * than `runs.attempts`, which a claim-lock contention requeue resets to 0.
 */
function reAdmitQueuedWebhookMergeScans(db) {
  const queued = db
    .query(
      `SELECT e.source, e.event_id
       FROM events e
       JOIN proposals p
         ON p.event_source = e.source AND p.event_id = e.event_id
       JOIN runs r ON r.run_id = p.run_id
       WHERE e.source = 'github'
         AND e.type = 'factory.merge.requested'
         AND e.status = 'noop'
         AND p.decision = 'noop'
         AND (
           (p.reason = ?
            AND r.state IN ('COMPLETED', 'REFUSED', 'FAILED', 'TIMED_OUT', 'CANCELLED'))
           OR (p.reason = ?
               AND r.state IN ('REFUSED', 'CANCELLED')
               AND NOT EXISTS (
                 SELECT 1 FROM lifecycle_events le
                 WHERE le.run_id = r.run_id AND le.to_state = 'LEASED'
               ))
         )
       ORDER BY p.created_at, p.rowid`,
    )
    .all(WEBHOOK_MERGE_SCAN_ALREADY_LIVE, WEBHOOK_MERGE_SCAN_PENDING);
  for (const event of queued) {
    db.query(
      `UPDATE events
       SET status = 'admitted', last_plan_error = NULL
       WHERE source = ? AND event_id = ? AND status = 'noop'`,
    ).run(event.source, event.event_id);
  }
}

/**
 * GitHub sends a delivery for each CI state change. Unlike an operator or
 * schedule request, those deliveries do not each deserve an auditable
 * proposal: a PROPOSED, APPROVED, or QUEUED scan will read current GitHub
 * state when it executes, so later deliveries stay pure noops. Retain one
 * pending marker before execution in case the scan is refused or cancelled;
 * while executing, retain one delivery as the trailing-scan marker. Further
 * deliveries remain proposal-free noops.
 */
function coalesceWebhookMergeRequest(
  db,
  event,
  envelope,
  agentRef,
  at,
  ttlSeconds,
) {
  if (
    event.source !== "github" ||
    event.type !== "factory.merge.requested" ||
    typeof envelope.payload?.repo !== "string"
  ) {
    return null;
  }
  const blockingRun = liveRunForInput(db, agentRef, {
    repo: envelope.payload.repo,
  });
  if (!blockingRun) return null;

  const executing = EXECUTING_MERGE_SCAN_STATES.has(blockingRun.state);
  const marker = queuedWebhookMergeScan(db, blockingRun.run_id);
  const reason = executing
    ? WEBHOOK_MERGE_SCAN_ALREADY_LIVE
    : WEBHOOK_MERGE_SCAN_PENDING;
  if (!marker) {
    return noopBehindLiveRun(db, event, blockingRun, reason, at, ttlSeconds);
  }
  if (executing && marker.reason === WEBHOOK_MERGE_SCAN_PENDING) {
    const proposal = moveQueuedWebhookMergeScan(
      db,
      marker.id,
      event,
      reason,
      at,
      ttlSeconds,
    );
    return { decision: "noop", proposal, runId: blockingRun.run_id, reason };
  }
  setEventStatus(db, event, "noop", marker.reason);
  return {
    decision: "noop",
    runId: blockingRun.run_id,
    reason: marker.reason,
  };
}

const HUMAN_NEEDED_BODY_HASH_MARKER = /\[dispatch_ticket_body_hash:([^\]]+)\]/;

function proposalExpiredAt(proposal, at) {
  return (
    Date.parse(at) - Date.parse(proposal.created_at) >
    Number(proposal.ttl_seconds) * 1000
  );
}

function humanNeededReasonPrefix(reason) {
  return String(reason).split(":", 1)[0];
}

function ticketHumanNeededContext(payload, evidence) {
  const repo = payload?.repo;
  const ticket = payload?.ticket;
  const descriptionHash = evidence?.ticket?.descriptionHash;
  // A missing ticket has no body to compare. Its synthetic empty-description
  // hash must not make unrelated failed lookups suppress each other.
  if (
    evidence?.checks?.ticket_found !== true ||
    typeof repo !== "string" ||
    typeof ticket !== "string" ||
    typeof descriptionHash !== "string"
  ) {
    return null;
  }
  return { repo, ticket, descriptionHash };
}

function humanNeeded(
  db,
  event,
  reason,
  at,
  ttlSeconds,
  ticketContext = null,
  detail = null,
) {
  const outcomeReason = reason;
  if (ticketContext) {
    const reasonPrefix = humanNeededReasonPrefix(reason);
    const matching = db
      .query(
        `SELECT p.*
         FROM proposals p
         JOIN events e
           ON e.source = p.event_source AND e.event_id = p.event_id
         WHERE p.decision = 'human_needed'
           AND p.status = 'open'
           AND json_extract(e.envelope_json, '$.payload.repo') = ?
           AND json_extract(e.envelope_json, '$.payload.ticket') = ?
           AND substr(p.reason, 1, ?) = ?
         ORDER BY p.created_at, p.rowid`,
      )
      .all(
        ticketContext.repo,
        ticketContext.ticket,
        reasonPrefix.length,
        reasonPrefix,
      );
    const hashMarker = `[dispatch_ticket_body_hash:${ticketContext.descriptionHash}]`;
    // Expiry is derived from created_at + ttl_seconds (nothing writes
    // status='expired'), so an aged-out open row is not current: the unchanged
    // ticket must be re-proposed once its earlier question has expired.
    const current = matching.find(
      (proposal) =>
        !proposalExpiredAt(proposal, at) &&
        String(proposal.reason ?? "").includes(hashMarker),
    );
    const stale = matching.filter((proposal) => proposal.id !== current?.id);
    for (const proposal of stale) {
      const previousMarker = String(proposal.reason ?? "").match(
        HUMAN_NEEDED_BODY_HASH_MARKER,
      );
      const supersedeReason =
        previousMarker && previousMarker[1] !== ticketContext.descriptionHash
          ? "superseded_by_ticket_body_change"
          : "superseded_by_replan";
      db.query(
        `UPDATE proposals
         SET status = 'superseded', decided_at = ?, decided_by = ?,
             reason = ?
         WHERE id = ?`,
      ).run(at, "planner", supersedeReason, proposal.id);
    }
    if (current) {
      const noopReason = `human_needed_already_open:${current.id}`;
      setEventStatus(db, event, "noop", noopReason);
      return { decision: "noop", reason: noopReason };
    }
    // Proposals do not have an evidence column. Retain the body hash in the
    // operator-facing reason detail so a later scan can compare the exact
    // ticket body that produced this question without changing the schema.
    reason = `${reason}\n${hashMarker}`;
  }
  if (detail) reason = `${reason}\n${detail}`;
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
  return { decision: "human_needed", proposal, reason: outcomeReason };
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
 * Historic event rows may have bypassed intake validation. A non-object
 * (array or scalar) is rejected deliberately alongside unparsable JSON:
 * planning reads `type`/`payload`/`source` off the envelope, so a valid-JSON
 * `[]` or `"x"` is exactly as unplannable as a truncated row.
 */
function parseStoredEnvelope(json) {
  try {
    const value = JSON.parse(json);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {
    // The planner records a typed refusal below instead of poisoning its pass.
  }
  return null;
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
    toolchain = {},
    configSnapshot = null,
    log = console.log,
  } = {},
) {
  // Dispatch gate for tier-2 worktree agents (WM-108), evaluated BEFORE the
  // write transaction: its Linear and lease reads must never hold the SQLite
  // write lock across a network round trip. The verdict is applied inside the
  // transaction only when the event is still admitted there — a raced plan
  // simply discards it via the idempotent early return.
  let worktreeEligibility = null;
  let toolchainEligibility = null;
  {
    const row = db
      .query(
        `SELECT status, envelope_json FROM events WHERE source = ? AND event_id = ?`,
      )
      .get(source, eventId);
    if (row?.status === "admitted") {
      const preEnvelope = parseStoredEnvelope(row.envelope_json);
      if (!preEnvelope) {
        // The transaction below records the malformed row as human-needed.
      } else {
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
          !(
            preEnvelope.type === "factory.dispatch.requested" &&
            preEnvelope.source !== "operator" &&
            policyDispatchPaused(undefined, configSnapshot)
          ) &&
          !repoNotAllowed(preDef, preEnvelope.payload)
        ) {
          if (preEnvelope.type === "factory.dispatch.requested") {
            toolchainEligibility = dispatchToolchainEligibility(
              preEnvelope.payload,
              { configSnapshot, toolchain },
            );
          }
          if (toolchainEligibility?.ready !== false) {
            try {
              worktreeEligibility = worktreeDispatchAutoEligibility(
                preEnvelope.payload,
                {
                  ...dispatch,
                  operatorAuthorized: preEnvelope.source === "operator",
                  configSnapshot,
                },
              );
            } catch (err) {
              if (!isLinearReadDeferred(err)) throw err;
              const reason = linearReadDeferredReason(err);
              worktreeEligibility = {
                ok: false,
                linearReadDeferred: true,
                reason,
                resetAt: err.resetAt ?? null,
                refusal: {
                  decision: "retry_later",
                  reason,
                  detail: err.message,
                },
              };
            }
          }
        }
      }
    }
  }
  if (worktreeEligibility?.linearReadDeferred) {
    const reason = worktreeEligibility.reason;
    const detail = worktreeEligibility.refusal?.detail ?? reason;
    try {
      db.query(
        `UPDATE events SET last_plan_error = ? WHERE source = ? AND event_id = ?`,
      ).run(detail, source, eventId);
    } catch (err) {
      if (!isBusyError(err)) throw err;
    }
    return {
      decision: "refused",
      reason,
      resetAt: worktreeEligibility.resetAt ?? null,
    };
  }
  const missingArtifactRetirements = [];
  const outcome = txImmediate(db, () => {
    const event = db
      .query(`SELECT * FROM events WHERE source = ? AND event_id = ?`)
      .get(source, eventId);
    if (!event) throw new Error(`no admitted event (${source}, ${eventId})`);
    if (event.status !== "admitted") return existingOutcome(db, event);

    const at = new Date(now).toISOString();
    const envelope = parseStoredEnvelope(event.envelope_json);
    if (!envelope)
      return humanNeeded(
        db,
        event,
        "malformed_event_envelope",
        at,
        DEFAULT_PROPOSAL_TTL_SECONDS,
      );

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
      setEventStatus(db, event, "noop", "observed");
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

    // A pause is an operator-controlled brake on unattended admission. Keep
    // operator dispatches available so the operator can still force specific
    // work while draining, but record every other dispatch as a durable NOOP.
    if (
      envelope.type === "factory.dispatch.requested" &&
      envelope.source !== "operator" &&
      policyDispatchPaused(undefined, configSnapshot)
    ) {
      const proposal = insertProposal(db, {
        id: newProposalId(),
        event,
        decision: "noop",
        status: "resolved",
        reason: "dispatch_paused",
        at,
        ttlSeconds,
      });
      setEventStatus(db, event, "noop", "dispatch_paused");
      return { decision: "noop", proposal, reason: "dispatch_paused" };
    }

    if (
      envelope.type === "factory.dispatch.requested" &&
      toolchainEligibility?.ready === false
    ) {
      const executable =
        toolchainEligibility.reasons?.find((reason) => reason?.executable)
          ?.executable ?? "unknown";
      return humanNeeded(
        db,
        event,
        `toolchain_unsatisfied:${executable}`,
        at,
        ttlSeconds,
        null,
        JSON.stringify(toolchainEligibility.reasons ?? []),
      );
    }

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
        // A still-retryable FAILED dispatch retains its worktree; a new run for
        // the same ticket would collide with that owner, so it keeps blocking.
        // An attempts-exhausted FAILED dispatch (WM-1066) is never retried and
        // its worktree is reaped, so liveRunForInput excludes it — otherwise the
        // dead run wedges the ticket forever and work-scan re-dispatch NOOPs
        // with same_ticket_worktree_held behind a run that will never move.
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

    // CI emits a separate GitHub delivery for every check transition. A merge
    // scan is repo-wide, so a live scan already observes the final state of a
    // burst; suppress the later webhook deliveries before they can create
    // duplicate noop proposals. Schedule, operator, and chain requests retain
    // their ordinary idempotency and proposal semantics.
    const webhookMergeCoalesced = coalesceWebhookMergeRequest(
      db,
      event,
      envelope,
      mapping.agent,
      at,
      ttlSeconds,
    );
    if (webhookMergeCoalesced) return webhookMergeCoalesced;

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
      setEventStatus(db, event, "noop", "previous_run_in_flight");
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
      setEventStatus(db, event, "noop", ticketWorktreeBlocker.reason);
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
        return humanNeeded(
          db,
          event,
          worktreeRefusal.reason,
          at,
          ttlSeconds,
          ticketHumanNeededContext(
            envelope.payload,
            worktreeEligibility.evidence,
          ),
        );
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
      setEventStatus(db, event, "noop", worktreeRefusal.reason);
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
          artifactStore,
          onArtifactMissing: (memo) => missingArtifactRetirements.push(memo),
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
      setEventStatus(db, event, "noop", "duplicate_run");
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
    if (envelope.source === "chain" || envelope.source === "handoff") {
      approvalPolicy = buildChainApprovalPolicy(envelope.type, {
        source: envelope.source,
      });
      if (
        approvalPolicy?.mode === "auto" &&
        envelope.type === "factory.dispatch.requested"
      ) {
        const result = worktreeEligibility?.ok
          ? worktreeEligibility
          : worktreeDispatchAutoEligibility(pinnedEnvelope.payload, {
              ...dispatch,
              // Remote handoff is unattended. Only a durable operator event
              // may exercise the sensitive/escalate-path bypass.
              operatorAuthorized: false,
              configSnapshot,
            });
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
        approvalPolicy,
        modelTierOverride,
        modelOverride: overlayModel,
        configSnapshot,
      }),
      idempotencyKey,
    };
    const modelMismatch = modelAdapterMismatch(
      spec,
      registry.modelTiers,
      mapping.adapter,
      {
        explicitPin:
          plannedDef(getAgent(registry, mapping.agent), {
            modelOverride: overlayModel,
          }).model !== undefined,
      },
    );
    if (modelMismatch)
      return humanNeeded(db, event, modelMismatch, at, ttlSeconds);
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
      setEventStatus(db, event, "noop", reason);
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
  // Emit only after the enclosing planning transaction commits. A later
  // planning error rolls the retirement back and must not leave a false or
  // duplicate line in serve.log.
  for (const memo of missingArtifactRetirements) {
    const subject = `${memo.subject.type}:${memo.subject.id}`;
    const producer = memo.inboxItemId
      ? `inbox_item_id=${memo.inboxItemId}`
      : `run_id=${memo.runId ?? "null"}`;
    try {
      log(
        `memo retired artifact_missing sha256=${memo.sha256} subject=${subject} ${producer}`,
      );
    } catch {
      // Observability is best-effort after the durable decision is made.
    }
  }
  return outcome;
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
  reAdmitQueuedWebhookMergeScans(db);
  const rows = db
    .query(
      `SELECT source, event_id, type FROM events WHERE status = 'admitted' ORDER BY admitted_at, rowid`,
    )
    .all();
  const configSnapshot = opts.configSnapshot ?? policySnapshot();
  const cache = opts.linearReadCache ?? createLinearReadCache();
  const createEventReadBudget = () =>
    createLinearReadBudget({
      now: opts.linearReadClock ?? Date.now,
      timeoutMs: opts.linearReadTimeoutMs ?? LINEAR_READ_TIMEOUT_MS,
    });
  // Keep ticket/in-flight/rate-limit caches for the pass, but give every
  // event its own deadline. A prior stalled event must not consume later
  // candidates' read time and turn an otherwise healthy batch into a
  // retry_later livelock.
  const budget = opts.linearBudget ?? loadLinearBudget();
  const limited = linearRateLimitState(budget, resolveNow(opts.now));
  if (limited) {
    cache.budgetRateLimit = new LinearRateLimitError(limited.resetAt);
  } else {
    cache.budgetRateLimit = null;
  }
  const dispatch = wrapLinearReads(
    opts.dispatch ?? {},
    cache,
    opts.now,
    configSnapshot,
  );
  const planOpts = { ...opts, dispatch, configSnapshot };
  let planned = 0;
  let failed = 0;
  let deadLettered = 0;
  const log = opts.log ?? console.log;
  if (limited) {
    try {
      log(
        `planner: Linear rate-limited until ${limited.resetAt} — skipping Linear reads`,
      );
    } catch {
      // Logging must not turn a bounded refusal into a retryable failure.
    }
  }
  for (const { source, event_id: eventId, type } of rows) {
    cache.linearReadBudget = opts.linearReadBudget ?? createEventReadBudget();
    try {
      const outcome = planEvent(db, registry, { source, eventId }, planOpts);
      if (
        outcome?.reason === "linear_rate_limited" ||
        outcome?.reason === "linear_read_budget_exhausted"
      )
        continue;
      if (
        type === "factory.dispatch.requested" &&
        outcome?.decision === "noop" &&
        outcome.reason
      ) {
        // Planner decisions are otherwise only visible through the database.
        // Keep one compact, per-event line in serve.log for chain noops; a
        // logger fault must never turn a successfully persisted plan into a
        // retryable planning failure.
        try {
          log(`planned noop (${outcome.reason}) — ${source}:${eventId}`);
        } catch {
          // Observability is best-effort after the durable decision is made.
        }
      }
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
  // Exactly one owner per process. `serve` runs this pass itself, on its own
  // loop, with awaited readers and a per-row read deadline; letting the
  // planner (inline here, or in its worker thread) run the same pass as well
  // meant two concurrent passes over the same rows — the pass-serialising
  // WeakMap in auto-approval is per-realm and does not cross the worker
  // thread. Serve clears the flag for its process before starting the worker.
  const chainApproval =
    opts.autoApproveChains ??
    process.env.FACTORY_PLANNER_AUTO_APPROVE_CHAINS !== "0";
  if (chainApproval)
    autoApproveChains(db, registry, {
      now: opts.now ?? Date.now(),
      policyVersion: opts.policyVersion ?? "unknown",
      dispatchEligibility: worktreeDispatchAutoEligibility,
      dispatch,
    });
  return { planned, failed, deadLettered };
}

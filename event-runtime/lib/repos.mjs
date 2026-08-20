/**
 * Repo facts, read from the factory's existing config/repos.yaml (OPS-228).
 *
 * Deliberately a reader, not an owner: repos.yaml is already the single
 * source of routing truth for the dispatcher (base branch, worktree scripts,
 * verify command). A second registry inside the event runtime would drift,
 * and a drifting port or base branch is how two agents collide.
 *
 * Tier 1 uses `name`, `path`, `github`, and `base`. The `worktree_*` and
 * `verify` fields are read but unused until tier 2 (docs/event-runtime-workers.md).
 * The registry fields (`team`, `project`, `report_only`, `max_in_flight`,
 * `deploy_branch`) are what an operator needs to tell a dispatch target from a
 * report-only one, and where its worktrees live (OPS-299).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_IN_FLIGHT, FACTORY_ROOT } from "./config.mjs";

export class RepoError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepoError";
  }
}

/**
 * Which factory checkout supplies repos.yaml. Defaults to the running one;
 * FACTORY_REPOS_ROOT points elsewhere (a runtime serving another checkout —
 * and the hook that makes these tests hermetic instead of depending on
 * whichever repos happen to exist on the machine).
 */
export function reposRoot() {
  return process.env.FACTORY_REPOS_ROOT || FACTORY_ROOT;
}

export function reposConfigPath(root = reposRoot()) {
  return path.join(root, "config", "repos.yaml");
}

/** Expand a leading ~ the way the config files write paths. */
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
  return p;
}

function normalizeOwnedPathsPolicy(raw = {}, repoName, file) {
  if (raw === null || raw === undefined) {
    return { direct: [], pinManifests: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RepoError(
      `${file}: repo ${repoName} owned_paths_policy must be an object`,
    );
  }

  const unknown = Object.keys(raw).filter(
    (key) => !["direct", "pin_manifests"].includes(key),
  );
  if (unknown.length) {
    throw new RepoError(
      `${file}: repo ${repoName} owned_paths_policy has unknown keys (${unknown.join(", ")})`,
    );
  }

  const direct = [];
  if (raw.direct !== undefined) {
    if (!Array.isArray(raw.direct)) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.direct must be an array`,
      );
    }
    for (const rule of raw.direct) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct entries must be objects`,
        );
      }
      if (typeof rule.source !== "string" || !rule.source.trim()) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct.source must be a non-empty string`,
        );
      }
      if (!Array.isArray(rule.requires) || rule.requires.length === 0) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct.requires must be a non-empty array`,
        );
      }
      if (
        !rule.requires.every((req) => typeof req === "string" && req.trim())
      ) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct.requires must contain only non-empty strings`,
        );
      }
      direct.push({
        source: rule.source.trim(),
        requires: rule.requires.map((req) => req.trim()),
      });
    }
  }

  const pinManifests = [];
  if (raw.pin_manifests !== undefined) {
    if (!Array.isArray(raw.pin_manifests)) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.pin_manifests must be an array`,
      );
    }
    for (const manifest of raw.pin_manifests) {
      if (typeof manifest !== "string" || !manifest.trim()) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.pin_manifests must contain only non-empty strings`,
        );
      }
      pinManifests.push(manifest.trim());
    }
  }

  return { direct, pinManifests };
}

/**
 * @returns {Map<string, {name: string, path: string, github: string|null, base: string,
 *                        deployBranch: string|null, team: string|null, project: string|null,
 *                        reportOnly: boolean, maxInFlight: number|null, smokeDeadlineSeconds: number|null,
 *                        mergeCi: {workflow: string, requiredChecks: string[]}|null,
 *                        escalatePaths: string[]|null, smokeWorkflow: string|null, smokeUrl: string|null,
 *                        deployment: {url: string|null, branch: string|null, revisionField: string|null}|null,
 *                        security: {pythonVersion: string|null}|null,
 *                        worktreeRoot: string|null, worktreeUp: string|null, worktreeDown: string|null,
 *                        worktreeWarm: string|null, verify: string|null,
 *                        ownedPathsPolicy: { direct: Array<{source: string, requires: string[]}>, pinManifests: string[] }}>
 */
export function loadRepos({ root = reposRoot() } = {}) {
  const file = reposConfigPath(root);
  if (!existsSync(file)) throw new RepoError(`no repos config at ${file}`);
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RepoError(`${file}: invalid YAML: ${err.message}`);
  }
  const repos = new Map();
  for (const entry of parsed?.repos ?? []) {
    if (!entry?.name) throw new RepoError(`${file}: a repo entry has no name`);
    if (!entry.path)
      throw new RepoError(`${file}: repo ${entry.name} has no path`);
    let maxInFlight = null;
    if (entry.max_in_flight !== undefined && entry.max_in_flight !== null) {
      if (
        typeof entry.max_in_flight !== "number" ||
        !Number.isFinite(entry.max_in_flight) ||
        entry.max_in_flight <= 0
      ) {
        throw new RepoError(
          `${file}: repo ${entry.name} max_in_flight must be a positive number, got ${JSON.stringify(entry.max_in_flight)}`,
        );
      }
      maxInFlight = entry.max_in_flight;
    }
    let smokeDeadlineSeconds = null;
    const rawSmokeDeadline =
      entry.smoke_deadline_seconds ?? entry.deployment?.smoke_deadline_seconds;
    if (rawSmokeDeadline !== undefined && rawSmokeDeadline !== null) {
      if (
        typeof rawSmokeDeadline !== "number" ||
        !Number.isFinite(rawSmokeDeadline) ||
        rawSmokeDeadline <= 0
      ) {
        throw new RepoError(
          `${file}: repo ${entry.name} smoke_deadline_seconds must be a positive number, got ${JSON.stringify(rawSmokeDeadline)}`,
        );
      }
      smokeDeadlineSeconds = rawSmokeDeadline;
    }
    let mergeCi = null;
    if (entry.merge_ci !== undefined && entry.merge_ci !== null) {
      const workflow = entry.merge_ci?.workflow;
      const requiredChecks = entry.merge_ci?.required_checks;
      const validWorkflow =
        typeof workflow === "string" && workflow.trim().length > 0;
      const validChecks =
        Array.isArray(requiredChecks) &&
        requiredChecks.length > 0 &&
        requiredChecks.every(
          (check) => typeof check === "string" && check.trim().length > 0,
        ) &&
        new Set(requiredChecks).size === requiredChecks.length;
      if (!validWorkflow || !validChecks) {
        throw new RepoError(
          `${file}: repo ${entry.name} merge_ci requires a nonempty workflow and unique nonempty required_checks`,
        );
      }
      mergeCi = { workflow, requiredChecks: [...requiredChecks] };
    }
    // Read-only projection for the view. A malformed list is NOT a load
    // error here: one repo's bad escalate_paths must not take the whole
    // registry down (and every other repo's dispatch with it). The strict,
    // fail-closed check stays where the gate is evaluated — the planner's
    // escalate_paths reader (planner.mjs, `escalate_paths_intersect` /
    // `escalate_paths_unverifiable`), at plan time, for that repo alone. Malformed → null, i.e. "not
    // declared / cannot be evaluated", which is exactly how the gate treats it.
    let escalatePaths = null;
    if (
      Array.isArray(entry.escalate_paths) &&
      entry.escalate_paths.every(
        (glob) => typeof glob === "string" && glob.trim().length > 0,
      )
    ) {
      escalatePaths = [...entry.escalate_paths];
    }
    let deployment = null;
    if (entry.deployment !== undefined && entry.deployment !== null) {
      if (
        typeof entry.deployment !== "object" ||
        Array.isArray(entry.deployment)
      ) {
        throw new RepoError(
          `${file}: repo ${entry.name} deployment must be an object`,
        );
      }
      deployment = {
        url: entry.deployment.url ?? null,
        branch: entry.deployment.branch ?? null,
        revisionField: entry.deployment.revision_field ?? null,
      };
    }
    let security = null;
    if (entry.security !== undefined && entry.security !== null) {
      if (typeof entry.security !== "object" || Array.isArray(entry.security)) {
        throw new RepoError(
          `${file}: repo ${entry.name} security must be an object`,
        );
      }
      // Deliberate allow-list: never pass through credential-shaped additions.
      security = { pythonVersion: entry.security.python_version ?? null };
    }
    repos.set(entry.name, {
      name: entry.name,
      path: expandHome(entry.path),
      github: entry.github ?? null,
      base: entry.base ?? "main",
      deployBranch: entry.deploy_branch ?? null,
      team: entry.team ?? null,
      project: entry.project ?? null,
      // Absent means dispatchable: report_only is the guard a repo opts into,
      // so anything but an explicit `true` must read as false rather than
      // "maybe" — an operator reading "dispatch" off a null would be wrong.
      reportOnly: entry.report_only === true,
      // Null, not a default: the cap's fallback lives with the dispatcher, and
      // inventing a number here would state a limit this file never set.
      maxInFlight,
      smokeDeadlineSeconds,
      smokeWorkflow: entry.smoke_workflow ?? null,
      smokeUrl: entry.smoke_url ?? null,
      deployment,
      security,
      mergeCi,
      escalatePaths,
      worktreeRoot: entry.worktree_root
        ? expandHome(entry.worktree_root)
        : null,
      worktreeUp: entry.worktree_up ?? null,
      worktreeDown: entry.worktree_down ?? null,
      worktreeWarm: entry.worktree_warm ?? null,
      verify: entry.verify ?? null,
      ownedPathsPolicy: normalizeOwnedPathsPolicy(
        entry.owned_paths_policy,
        entry.name,
        file,
      ),
    });
  }
  return repos;
}

/**
 * The repo registry as the control API serves it (OPS-299): one row per
 * repos.yaml entry, in file order.
 *
 * An explicit allow-list, not the parsed entry: repos.yaml also carries
 * credential-bearing settings and whatever the next policy field turns out to
 * be, and a passthrough would publish each new key the moment someone adds it.
 * Nothing here reads `.env` or any credential — these are paths, branches, and
 * commands the repo already documents.
 *
 * `hasWorktree*` are booleans rather than the script paths because that is the
 * question a reader has ("can the janitor tear this repo's worktrees down?");
 * the path itself is only meaningful to the process that executes it.
 */
export function reposView(repos) {
  return [...repos.values()].map((repo) => ({
    name: repo.name,
    path: repo.path,
    github: repo.github,
    team: repo.team,
    project: repo.project,
    base: repo.base,
    deployBranch: repo.deployBranch,
    reportOnly: repo.reportOnly,
    maxInFlight: repo.maxInFlight,
    effective: {
      maxInFlight: repo.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      maxInFlightSource: repo.maxInFlight === null ? "default" : "repo",
    },
    smokeDeadlineSeconds: repo.smokeDeadlineSeconds,
    smokeWorkflow: repo.smokeWorkflow,
    smokeUrl: repo.smokeUrl,
    deployment: repo.deployment,
    security: repo.security,
    mergeCi: repo.mergeCi,
    escalatePaths: repo.escalatePaths,
    ownedPathsPolicy: repo.ownedPathsPolicy,
    worktreeRoot: repo.worktreeRoot,
    hasWorktreeUp: repo.worktreeUp !== null,
    hasWorktreeDown: repo.worktreeDown !== null,
    hasWorktreeWarm: repo.worktreeWarm !== null,
    verify: repo.verify,
  }));
}

export function getRepo(repos, name) {
  const repo = repos.get(name);
  if (!repo) {
    throw new RepoError(
      `repo "${name}" is not in config/repos.yaml (have: ${[...repos.keys()].join(", ") || "none"})`,
    );
  }
  return repo;
}

/**
 * Select the merge gate without treating an empty branch-protection response
 * as green. GitHub-owned required contexts win whenever they are nonempty;
 * the repo-owned declaration is the only permitted fallback.
 */
export function selectMergeCheckGate(repo, githubRequiredContexts) {
  if (!Array.isArray(githubRequiredContexts)) {
    throw new RepoError("GitHub required contexts are unavailable");
  }
  const valid = githubRequiredContexts.every(
    (name) => typeof name === "string" && name.trim().length > 0,
  );
  if (
    !valid ||
    new Set(githubRequiredContexts).size !== githubRequiredContexts.length
  ) {
    throw new RepoError("GitHub required contexts are malformed or ambiguous");
  }
  if (githubRequiredContexts.length > 0) {
    return {
      source: "github",
      workflow: null,
      requiredChecks: [...githubRequiredContexts],
    };
  }
  if (!repo?.mergeCi) {
    throw new RepoError(
      "GitHub required contexts are empty and no merge_ci fallback is configured",
    );
  }
  return {
    source: "config",
    workflow: repo.mergeCi.workflow,
    requiredChecks: [...repo.mergeCi.requiredChecks],
  };
}

/**
 * Prove one completed-success record for every named gate at one exact SHA.
 * Duplicate matching records are ambiguous rather than "one of them passed".
 * Unnamed extra checks are irrelevant: the selected gate is deliberately an
 * exact allow-list, not a snapshot of whatever happened to be visible first.
 */
export function proveMergeChecks({
  expectedChecks,
  actualChecks,
  expectedSha,
  workflow = null,
}) {
  if (
    !Array.isArray(expectedChecks) ||
    expectedChecks.length === 0 ||
    !Array.isArray(actualChecks) ||
    typeof expectedSha !== "string" ||
    expectedSha.length === 0
  ) {
    throw new RepoError("merge check evidence is empty or malformed");
  }
  for (const name of expectedChecks) {
    const matches = actualChecks.filter((check) => check?.name === name);
    if (matches.length !== 1) {
      throw new RepoError(
        `required check ${JSON.stringify(name)} is missing or ambiguous`,
      );
    }
    const check = matches[0];
    if (
      check.headSha !== expectedSha ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      (workflow !== null && check.workflow !== workflow)
    ) {
      throw new RepoError(
        `required check ${JSON.stringify(name)} is not green at the exact SHA`,
      );
    }
  }
  return true;
}

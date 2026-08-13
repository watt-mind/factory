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
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "./config.mjs";

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

/**
 * @returns {Map<string, {name: string, path: string, github: string|null, base: string,
 *                        worktreeUp: string|null, worktreeDown: string|null, verify: string|null}>}
 */
export function loadRepos({ root = reposRoot() } = {}) {
  const file = reposConfigPath(root);
  if (!existsSync(file)) throw new RepoError(`no repos config at ${file}`);
  const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  const repos = new Map();
  for (const entry of parsed?.repos ?? []) {
    if (!entry?.name) throw new RepoError(`${file}: a repo entry has no name`);
    if (!entry.path) throw new RepoError(`${file}: repo ${entry.name} has no path`);
    repos.set(entry.name, {
      name: entry.name,
      path: expandHome(entry.path),
      github: entry.github ?? null,
      base: entry.base ?? "main",
      worktreeUp: entry.worktree_up ?? null,
      worktreeDown: entry.worktree_down ?? null,
      verify: entry.verify ?? null,
    });
  }
  return repos;
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

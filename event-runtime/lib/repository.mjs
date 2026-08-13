/**
 * Tier-1 repository workspaces (docs/event-runtime.md §7; OPS-228).
 *
 * Read-only access to a repo's source, cheaply and reproducibly:
 *
 *   bare mirror (cached, per repo)  →  detached worktree at a pinned SHA
 *
 * No dependency install, no ports, no database — reading code does not need
 * node_modules, and that is the whole reason this tier is separate from the
 * tier-2 worktree path (which delegates to the repo's own worktree scripts).
 *
 * Why a mirror instead of the operator's checkout: the live checkout holds
 * uncommitted work an agent would read as truth, two runs would race in one
 * directory, and even a read-only run wants `git fetch`, which writes to
 * .git. The mirror is the runtime's own cache; the operator's tree is never
 * touched, never read.
 *
 * The SHA is resolved at plan time and pinned into the run's input, so a
 * result is reproducible and a stale tree can never silently make a shipped
 * feature read as unshipped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { mirrorsRoot } from "./config.mjs";
import { getRepo, loadRepos } from "./repos.mjs";

export class RepositoryWorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryWorkspaceError";
  }
}

const git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new RepositoryWorkspaceError(`git ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
};

export function mirrorPath(repoName, root = mirrorsRoot()) {
  return path.join(root, `${repoName}.git`);
}

/**
 * Create the mirror if absent, otherwise fetch it. The source is the local
 * checkout's path (fast, offline-friendly); it is only ever *read*.
 */
export function syncMirror(repo, { root = mirrorsRoot() } = {}) {
  const mirror = mirrorPath(repo.name, root);
  if (!existsSync(mirror)) {
    if (!existsSync(repo.path)) {
      throw new RepositoryWorkspaceError(`repo ${repo.name}: no checkout at ${repo.path} to mirror from`);
    }
    mkdirSync(root, { recursive: true });
    git(["clone", "--mirror", "--quiet", repo.path, mirror]);
  } else {
    git(["fetch", "--prune", "--quiet", "origin"], mirror);
  }
  return mirror;
}

/**
 * Resolve a ref to an immutable SHA in the mirror. Called at plan time so the
 * SHA lands in the RunSpec input (and therefore the inputHash and receipt).
 */
export function resolveRef(repo, ref = repo.base, { root = mirrorsRoot() } = {}) {
  const mirror = syncMirror(repo, { root });
  const sha = git(["rev-parse", `${ref}^{commit}`], mirror);
  return { mirror, sha };
}

/** Plan-time helper: repo name + optional ref → the facts a spec should pin. */
export function pinRepo(repoName, ref, { reposRoot, mirrors = mirrorsRoot() } = {}) {
  const repo = getRepo(loadRepos(reposRoot ? { root: reposRoot } : {}), repoName);
  const { sha } = resolveRef(repo, ref ?? repo.base, { root: mirrors });
  return { repo: repo.name, ref: ref ?? repo.base, sha, github: repo.github };
}

/**
 * Materialize the run's read-only source tree: a detached worktree of the
 * mirror at the pinned SHA, inside the run's workspace directory.
 *
 * @returns {{ path: string, sha: string }} absolute checkout path
 */
export function materializeCheckout({ workspaceDir, repoName, sha, subdir = "repo", mirrors = mirrorsRoot(), reposRoot }) {
  if (!sha) throw new RepositoryWorkspaceError(`repo ${repoName}: no pinned sha in the run input`);
  const repo = getRepo(loadRepos(reposRoot ? { root: reposRoot } : {}), repoName);
  const mirror = syncMirror(repo, { root: mirrors });

  // Confinement: the checkout must land inside the workspace, always.
  const target = path.resolve(workspaceDir, subdir);
  if (!target.startsWith(path.resolve(workspaceDir) + path.sep)) {
    throw new RepositoryWorkspaceError(`checkout subdir "${subdir}" escapes the workspace`);
  }

  git(["worktree", "add", "--detach", "--quiet", target, sha], mirror);
  return { path: target, sha };
}

/**
 * Remove a materialized checkout and deregister it from the mirror. The
 * mirror itself persists as cache — that is the point of the tier.
 */
export function releaseCheckout({ checkoutPath, repoName, mirrors = mirrorsRoot(), reposRoot }) {
  if (!checkoutPath || !existsSync(checkoutPath)) return false;
  try {
    const repo = getRepo(loadRepos(reposRoot ? { root: reposRoot } : {}), repoName);
    const mirror = mirrorPath(repo.name, mirrors);
    if (existsSync(mirror)) git(["worktree", "remove", "--force", checkoutPath], mirror);
    else rmSync(checkoutPath, { recursive: true, force: true });
  } catch {
    // Never let cleanup mask a run's real outcome; the directory goes either way.
    rmSync(checkoutPath, { recursive: true, force: true });
  }
  return true;
}

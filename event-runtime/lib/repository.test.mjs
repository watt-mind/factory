import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, getRepo, loadRepos, RepoError } from "./repos.mjs";
import {
  materializeCheckout,
  mirrorPath,
  releaseCheckout,
  RepositoryWorkspaceError,
  resolveRef,
  syncMirror,
} from "./repository.mjs";

const scratch = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A tiny real repo — the provider's whole job is git, so fake git proves nothing. */
function makeRepo() {
  const dir = tmp("evrt-src-");
  git(["init", "--quiet", "--initial-branch=main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(path.join(dir, "README.md"), "first\n");
  git(["add", "."], dir);
  git(["commit", "--quiet", "-m", "first"], dir);
  const first = git(["rev-parse", "HEAD"], dir);
  writeFileSync(path.join(dir, "README.md"), "second\n");
  git(["commit", "--quiet", "-am", "second"], dir);
  return { dir, first, head: git(["rev-parse", "HEAD"], dir) };
}

/** A repos.yaml pointing at it, so the loader is exercised for real too. */
function makeFactoryRoot(repoPath, name = "testrepo") {
  const root = tmp("evrt-factory-");
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n  - name: ${name}\n    path: ${repoPath}\n    github: watt-mind/${name}\n    base: main\n    worktree_up: bin/worktree-up.sh\n    verify: echo ok\n`,
  );
  return root;
}

describe("repos.yaml is read, not owned", () => {
  test("loads the fields tier 1 needs and expands ~", () => {
    const src = makeRepo();
    const repos = loadRepos({ root: makeFactoryRoot(src.dir) });
    const repo = getRepo(repos, "testrepo");
    expect(repo).toMatchObject({
      name: "testrepo",
      path: src.dir,
      github: "watt-mind/testrepo",
      base: "main",
      worktreeUp: "bin/worktree-up.sh",
      verify: "echo ok",
    });
    expect(expandHome("~/x")).toBe(path.join(process.env.HOME ?? "", "x"));
  });

  test("an unknown repo names what is configured instead of failing vaguely", () => {
    const repos = loadRepos({ root: makeFactoryRoot(makeRepo().dir) });
    expect(() => getRepo(repos, "nope")).toThrow(/not in config\/repos\.yaml \(have: testrepo\)/);
  });

  test("a missing config fails closed", () => {
    expect(() => loadRepos({ root: tmp("evrt-empty-") })).toThrow(RepoError);
  });
});

describe("mirror + pinned checkout", () => {
  test("mirrors on first use, fetches thereafter, and never writes to the source", () => {
    const src = makeRepo();
    const mirrors = tmp("evrt-mirrors-");
    const repo = getRepo(loadRepos({ root: makeFactoryRoot(src.dir) }), "testrepo");

    const mirror = syncMirror(repo, { root: mirrors });
    expect(mirror).toBe(mirrorPath("testrepo", mirrors));
    expect(existsSync(path.join(mirror, "HEAD"))).toBe(true);

    // Source stays pristine: no worktrees registered, no new refs.
    expect(git(["worktree", "list"], src.dir).split("\n")).toHaveLength(1);

    // Second call is a fetch, not a re-clone — and picks up new commits.
    writeFileSync(path.join(src.dir, "third.txt"), "third\n");
    git(["add", "."], src.dir);
    git(["commit", "--quiet", "-m", "third"], src.dir);
    syncMirror(repo, { root: mirrors });
    expect(resolveRef(repo, "main", { root: mirrors }).sha).toBe(git(["rev-parse", "HEAD"], src.dir));
  });

  test("resolves a ref to an immutable sha — the pin a run is reproducible against", () => {
    const src = makeRepo();
    const mirrors = tmp("evrt-mirrors-");
    const repo = getRepo(loadRepos({ root: makeFactoryRoot(src.dir) }), "testrepo");
    expect(resolveRef(repo, "main", { root: mirrors }).sha).toBe(src.head);
    expect(resolveRef(repo, src.first, { root: mirrors }).sha).toBe(src.first);
  });

  test("materializes the pinned tree inside the workspace, then releases it", () => {
    const src = makeRepo();
    const mirrors = tmp("evrt-mirrors-");
    const reposRoot = makeFactoryRoot(src.dir);
    const workspaceDir = tmp("evrt-ws-");

    // Pinned to the FIRST commit: the checkout must show that tree, not HEAD.
    const checkout = materializeCheckout({
      workspaceDir,
      repoName: "testrepo",
      sha: src.first,
      mirrors,
      reposRoot,
    });
    expect(checkout.path).toBe(path.join(workspaceDir, "repo"));
    expect(readFileSync(path.join(checkout.path, "README.md"), "utf8")).toBe("first\n");

    releaseCheckout({ checkoutPath: checkout.path, repoName: "testrepo", mirrors, reposRoot });
    expect(existsSync(checkout.path)).toBe(false);
    // The mirror survives as cache, with no stale worktree registration.
    expect(existsSync(mirrorPath("testrepo", mirrors))).toBe(true);
    expect(git(["worktree", "list"], mirrorPath("testrepo", mirrors))).not.toContain(workspaceDir);
  });

  test("a checkout may not escape its workspace", () => {
    const src = makeRepo();
    const mirrors = tmp("evrt-mirrors-");
    const reposRoot = makeFactoryRoot(src.dir);
    expect(() =>
      materializeCheckout({
        workspaceDir: tmp("evrt-ws-"),
        repoName: "testrepo",
        sha: src.head,
        subdir: "../escaped",
        mirrors,
        reposRoot,
      }),
    ).toThrow(RepositoryWorkspaceError);
  });

  test("an unpinned run refuses rather than guessing a ref", () => {
    expect(() =>
      materializeCheckout({ workspaceDir: tmp("evrt-ws-"), repoName: "testrepo", sha: null }),
    ).toThrow(/no pinned sha/);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PathViolation, WorktreeError, createWorkspace, destroyWorkspace, safeJoin } from "./workspace.mjs";

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "evrt-ws-"));
}

describe("safeJoin", () => {
  const ws = tmpRoot();

  test("accepts nested relative paths", () => {
    expect(safeJoin(ws, "result.json")).toBe(path.join(ws, "result.json"));
    expect(safeJoin(ws, "logs/agent/output.log")).toBe(path.join(ws, "logs", "agent", "output.log"));
  });

  test("rejects absolute paths", () => {
    expect(() => safeJoin(ws, "/etc/passwd")).toThrow(PathViolation);
  });

  test("rejects ../ escapes", () => {
    expect(() => safeJoin(ws, "../outside.txt")).toThrow(PathViolation);
    expect(() => safeJoin(ws, "logs/../../outside.txt")).toThrow(PathViolation);
  });

  test("rejects empty and non-string paths, and the workspace itself", () => {
    expect(() => safeJoin(ws, "")).toThrow(PathViolation);
    expect(() => safeJoin(ws, undefined)).toThrow(PathViolation);
    expect(() => safeJoin(ws, ".")).toThrow(PathViolation);
  });
});

describe("createWorkspace / destroyWorkspace", () => {
  test("creates <runId>-a<attempt> and writes canonical input.json", () => {
    const root = tmpRoot();
    const { dir } = createWorkspace({ root, runId: "run_x", attempt: 1, input: { b: 2, a: 1 } });
    expect(dir).toBe(path.join(root, "run_x-a1"));
    expect(readFileSync(path.join(dir, "input.json"), "utf8")).toBe('{"a":1,"b":2}\n');
  });

  test("destroy removes the directory; retain leaves it and returns false", () => {
    const root = tmpRoot();
    const { dir } = createWorkspace({ root, runId: "run_y", attempt: 1, input: {} });
    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

// Tier-2 delegation (docs/event-runtime-dispatch.md §5, WM-108): the runtime
// never implements worktrees — it shells to the scripts each repo declares in
// config/repos.yaml. These fixtures stand in fake scripts that log every call,
// so the tests prove exactly when up/down ran and when they deliberately did not.
describe("worktree workspaces (WM-108)", () => {
  let factoryRoot;
  let repoDir;
  let wtRoot;
  let callsLog;
  let previousReposRoot;

  const calls = () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n") : []);

  beforeAll(() => {
    factoryRoot = mkdtempSync(path.join(os.tmpdir(), "evrt-wt-factory-"));
    repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "evrt-wt-repo-")));
    wtRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "evrt-wt-trees-")));
    callsLog = path.join(repoDir, "calls.log");

    mkdirSync(path.join(repoDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up.sh"),
      `#!/bin/bash\nset -e\necho "up $1 cwd=$PWD" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down.sh"),
      `#!/bin/bash\nset -e\necho "down $1" >> "${callsLog}"\nrm -rf "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-broken.sh"),
      `#!/bin/bash\necho "template failed to build" >&2\nexit 7\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down-refuse.sh"),
      `#!/bin/bash\necho "refusing: dirty tree" >&2\nexit 1\n`,
    );

    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:\n` +
        `  - name: wtrepo\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo verified\n` +
        `  - name: broken-up\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-broken.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: refusing-down\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down-refuse.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: noscripts\n    path: ${repoDir}\n    base: develop\n`,
    );
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = factoryRoot;
  });

  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  const make = (repo, ticket, runId) =>
    createWorkspace({
      root: tmpRoot(),
      runId,
      attempt: 1,
      input: { repo, ticket },
      workspace: { type: "worktree" },
    });

  test("up is delegated to the repo's script; the tree is reachable at ./repo; verify rides along", () => {
    const { dir, worktree } = make("wtrepo", "WM-1", "run_wt1");
    expect(calls()).toContainEqual(`up WM-1 cwd=${repoDir}`);
    expect(worktree).toEqual({
      repo: "wtrepo",
      ticket: "WM-1",
      path: path.join(wtRoot, "WM-1"),
      repoPath: repoDir,
      down: "bin/worktree-down.sh",
      verify: "echo verified",
    });
    const link = path.join(dir, "repo");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(path.join(wtRoot, "WM-1"));
    expect(JSON.parse(readFileSync(path.join(dir, ".worktree.json"), "utf8")).ticket).toBe("WM-1");
    expect(destroyWorkspace(dir)).toBe(true);
  });

  test("destroy runs worktree_down, then removes the workspace — completion and failure teardown are the same path", () => {
    const { dir } = make("wtrepo", "WM-2", "run_wt2");
    expect(existsSync(path.join(wtRoot, "WM-2"))).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
    expect(calls()).toContain("down WM-2");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(wtRoot, "WM-2"))).toBe(false);
  });

  test("retainOnFailure: retain skips worktree_down and keeps workspace AND worktree for inspection", () => {
    const { dir } = make("wtrepo", "WM-3", "run_wt3");
    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(calls()).not.toContain("down WM-3");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(wtRoot, "WM-3"))).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true); // operator finishing the inspection
    expect(calls()).toContain("down WM-3");
  });

  test("a refusing worktree_down (dirty tree) retains everything and never forces", () => {
    const { dir } = make("refusing-down", "WM-4", "run_wt4");
    expect(destroyWorkspace(dir)).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(wtRoot, "WM-4"))).toBe(true);
  });

  test("a failing worktree_up is a typed error carrying the script's last line", () => {
    expect(() => make("broken-up", "WM-5", "run_wt5")).toThrow(WorktreeError);
    expect(() => make("broken-up", "WM-5", "run_wt5")).toThrow(/template failed to build/);
  });

  test("a repo with no declared scripts fails typed, not with a crash mid-spawn", () => {
    expect(() => make("noscripts", "WM-6", "run_wt6")).toThrow(WorktreeError);
    expect(() => make("noscripts", "WM-6", "run_wt6")).toThrow(/declares no worktree lifecycle/);
  });

  test("missing input.repo or input.ticket is a typed error", () => {
    expect(() =>
      createWorkspace({ root: tmpRoot(), runId: "run_wt7", attempt: 1, input: { repo: "wtrepo" }, workspace: { type: "worktree" } }),
    ).toThrow(/input.repo and input.ticket/);
  });
});

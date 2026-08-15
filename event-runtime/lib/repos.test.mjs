import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRepos, RepoError, reposView } from "./repos.mjs";

const scratch = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A factory checkout with a repos.yaml, so the real parser runs against real
 * YAML. Hermetic on purpose: reading the repo's own config/repos.yaml would
 * make these assertions a description of today's registry.
 */
function factoryRoot(yaml) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-repos-"));
  scratch.push(root);
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config", "repos.yaml"), yaml);
  return root;
}

// One fully configured dispatch target and one report-only repo with nothing
// but the minimum — between them they cover every field's present and absent
// case. The policy keys are here to prove the view does not publish them.
const YAML = `repos:
  - name: full
    path: ~/Develop/full
    github: watt-mind/full
    team: CLNT
    project: Full Project
    base: develop
    deploy_branch: master
    worktree_up: bin/worktree-up.sh
    worktree_down: bin/worktree-down.sh
    worktree_warm: bin/worktree-warm.sh
    worktree_root: ~/Develop/.worktrees/full
    max_in_flight: 20
    verify: npm run typecheck
    security:
      python_version: "3.12"
    escalate_paths:
      - src/auth/**

  - name: bare
    path: ~/Develop/bare
    team: OPS
    report_only: true
`;

describe("loadRepos reads the registry fields the operator surfaces need (OPS-299)", () => {
  const repos = loadRepos({ root: factoryRoot(YAML) });
  const home = process.env.HOME ?? "";

  test("a fully configured repo carries team, project, branches, cap, and worktree lifecycle", () => {
    expect(repos.get("full")).toEqual({
      name: "full",
      path: path.join(home, "Develop/full"),
      github: "watt-mind/full",
      team: "CLNT",
      project: "Full Project",
      base: "develop",
      deployBranch: "master",
      reportOnly: false,
      maxInFlight: 20,
      smokeDeadlineSeconds: null,
      worktreeRoot: path.join(home, "Develop/.worktrees/full"),
      worktreeUp: "bin/worktree-up.sh",
      worktreeDown: "bin/worktree-down.sh",
      worktreeWarm: "bin/worktree-warm.sh",
      verify: "npm run typecheck",
    });
  });

  test("absent fields are null and report_only is honoured; base still defaults to main", () => {
    expect(repos.get("bare")).toMatchObject({
      name: "bare",
      path: path.join(home, "Develop/bare"),
      github: null,
      project: null,
      base: "main",
      deployBranch: null,
      reportOnly: true,
      // Null, not a number: the dispatcher owns the fallback cap, and a
      // fabricated one here would read as a limit repos.yaml never set.
      maxInFlight: null,
      smokeDeadlineSeconds: null,
      worktreeRoot: null,
      worktreeDown: null,
      verify: null,
    });
  });

  test("report_only reads false unless it is exactly true — a guard is never 'maybe'", () => {
    const repos = loadRepos({
      root: factoryRoot(`repos:\n  - name: a\n    path: /tmp/a\n  - name: b\n    path: /tmp/b\n    report_only: false\n`),
    });
    expect(repos.get("a").reportOnly).toBe(false);
    expect(repos.get("b").reportOnly).toBe(false);
  });

  test("a missing config fails closed rather than reporting an empty registry", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "evrt-repos-empty-"));
    scratch.push(empty);
    expect(() => loadRepos({ root: empty })).toThrow(RepoError);
  });

  test("max_in_flight must be a positive number when present, or null when absent/null (OPS-347)", () => {
    const valid = loadRepos({
      root: factoryRoot(`repos:
  - name: explicit-null
    path: /tmp/a
    max_in_flight: null
  - name: positive-num
    path: /tmp/b
    max_in_flight: 5
`),
    });
    expect(valid.get("explicit-null").maxInFlight).toBeNull();
    expect(valid.get("positive-num").maxInFlight).toBe(5);

    const invalidCases = [
      `repos:\n  - name: str-cap\n    path: /tmp/c\n    max_in_flight: "20"\n`,
      `repos:\n  - name: zero-cap\n    path: /tmp/d\n    max_in_flight: 0\n`,
      `repos:\n  - name: neg-cap\n    path: /tmp/e\n    max_in_flight: -1\n`,
      `repos:\n  - name: bool-cap\n    path: /tmp/f\n    max_in_flight: true\n`,
      `repos:\n  - name: obj-cap\n    path: /tmp/g\n    max_in_flight: { cap: 5 }\n`,
    ];

    for (const yaml of invalidCases) {
      expect(() => loadRepos({ root: factoryRoot(yaml) })).toThrow(RepoError);
    }
  });

  test("smoke_deadline_seconds parses from top-level or deployment block, validating positive numbers (WM-120)", () => {
    const valid = loadRepos({
      root: factoryRoot(`repos:
  - name: top-level
    path: /tmp/a
    smoke_deadline_seconds: 300
  - name: deploy-level
    path: /tmp/b
    deployment:
      url: https://example.com
      smoke_deadline_seconds: 900
  - name: explicit-null
    path: /tmp/c
    smoke_deadline_seconds: null
`),
    });
    expect(valid.get("top-level").smokeDeadlineSeconds).toBe(300);
    expect(valid.get("deploy-level").smokeDeadlineSeconds).toBe(900);
    expect(valid.get("explicit-null").smokeDeadlineSeconds).toBeNull();

    const invalidCases = [
      `repos:\n  - name: str-sec\n    path: /tmp/d\n    smoke_deadline_seconds: "600"\n`,
      `repos:\n  - name: zero-sec\n    path: /tmp/e\n    smoke_deadline_seconds: 0\n`,
      `repos:\n  - name: neg-sec\n    path: /tmp/f\n    deployment:\n      smoke_deadline_seconds: -10\n`,
      `repos:\n  - name: bool-sec\n    path: /tmp/g\n    smoke_deadline_seconds: true\n`,
    ];

    for (const yaml of invalidCases) {
      expect(() => loadRepos({ root: factoryRoot(yaml) })).toThrow(RepoError);
    }
  });

  test("malformed YAML throws RepoError with file path and parse error message (OPS-346)", () => {
    const root = factoryRoot("repos: [ invalid: {");
    expect(() => loadRepos({ root })).toThrow(RepoError);
    expect(() => loadRepos({ root })).toThrow(/invalid YAML:/);
  });
});

describe("reposView is what the control API serves", () => {
  const rows = reposView(loadRepos({ root: factoryRoot(YAML) }));

  test("one row per entry, in file order", () => {
    expect(rows.map((r) => r.name)).toEqual(["full", "bare"]);
  });

  test("worktree scripts are reported as capability, not as paths to run", () => {
    expect(rows[0]).toMatchObject({ hasWorktreeUp: true, hasWorktreeDown: true, hasWorktreeWarm: true });
    expect(rows[1]).toMatchObject({ hasWorktreeUp: false, hasWorktreeDown: false, hasWorktreeWarm: false });
    // The script path itself is meaningless to a reader and only the janitor
    // executes it, so it stays server-side.
    expect(rows[0]).not.toHaveProperty("worktreeDown");
  });

  test("the projection is an allow-list, so policy keys cannot leak by being added", () => {
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "base", "deployBranch", "github", "hasWorktreeDown", "hasWorktreeUp", "hasWorktreeWarm",
        "maxInFlight", "name", "path", "project", "reportOnly", "smokeDeadlineSeconds", "team", "verify", "worktreeRoot",
      ]);
    }
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("escalate_paths");
    expect(serialized).not.toContain("src/auth");
    expect(serialized).not.toContain("python_version");
  });

  test("the dispatch/report-only distinction survives the wire", () => {
    expect(rows.map((r) => [r.name, r.reportOnly])).toEqual([["full", false], ["bare", true]]);
  });
});

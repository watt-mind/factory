import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-repos-test-mjs";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_IN_FLIGHT } from "./config.mjs";
import {
  loadRepos,
  proveMergeChecks,
  RepoError,
  reposView,
  selectMergeCheckGate,
} from "./repos.mjs";

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
  const root = tmpDir("evrt-repos-");
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
    smoke_workflow: smoke-prod.yml
    smoke_url: https://full.example.com/healthz
    smoke_deadline_seconds: 420
    deployment:
      url: https://full.example.com
      branch: master
      revision_field: revision
      webhook_secret: never-publish-deployment-secret
    owned_paths_policy:
      direct:
        - source: shared/**
          requires:
            - dist/**
            - plugins/core/**
      pin_manifests:
        - event-runtime/agents/*.json
    merge_ci:
      workflow: CI
      required_checks:
        - Shadow runner fleet available
        - Verify
    security:
      python_version: "3.12"
      api_token: never-publish-security-token
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
      controlPlane: null,
      base: "develop",
      deployBranch: "master",
      reportOnly: false,
      maxInFlight: 20,
      smokeDeadlineSeconds: 420,
      smokeWorkflow: "smoke-prod.yml",
      smokeUrl: "https://full.example.com/healthz",
      deployment: {
        url: "https://full.example.com",
        branch: "master",
        revisionField: "revision",
      },
      security: { pythonVersion: "3.12" },
      mergeCi: {
        workflow: "CI",
        requiredChecks: ["Shadow runner fleet available", "Verify"],
      },
      escalatePaths: ["src/auth/**"],
      worktreeRoot: path.join(home, "Develop/.worktrees/full"),
      worktreeUp: "bin/worktree-up.sh",
      worktreeDown: "bin/worktree-down.sh",
      worktreeWarm: "bin/worktree-warm.sh",
      verify: "npm run typecheck",
      ownedPathsPolicy: {
        direct: [
          { source: "shared/**", requires: ["dist/**", "plugins/core/**"] },
        ],
        pinManifests: ["event-runtime/agents/*.json"],
      },
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
      smokeWorkflow: null,
      smokeUrl: null,
      deployment: null,
      security: null,
      mergeCi: null,
      escalatePaths: null,
      worktreeRoot: null,
      worktreeDown: null,
      verify: null,
    });
  });

  test("report_only reads false unless it is exactly true — a guard is never 'maybe'", () => {
    const repos = loadRepos({
      root: factoryRoot(
        `repos:\n  - name: a\n    path: /tmp/a\n  - name: b\n    path: /tmp/b\n    report_only: false\n`,
      ),
    });
    expect(repos.get("a").reportOnly).toBe(false);
    expect(repos.get("b").reportOnly).toBe(false);
  });

  test("a missing config fails closed rather than reporting an empty registry", () => {
    const empty = tmpDir("evrt-repos-empty-");
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

  test("a malformed escalate_paths on one repo reads as null and never fails the whole registry load", () => {
    // The plan-time gate is the strict reader (fail closed for THAT repo); the
    // view must not turn one bad list into repo_unknown for every repo.
    const repos = loadRepos({
      root: factoryRoot(`repos:
  - name: good
    path: /tmp/good
    escalate_paths: [src/auth/**]
  - name: explicit-none
    path: /tmp/none
    escalate_paths: []
  - name: malformed
    path: /tmp/bad
    escalate_paths: not-a-list
  - name: undeclared
    path: /tmp/undeclared
`),
    });
    expect(repos.size).toBe(4);
    expect(repos.get("good").escalatePaths).toEqual(["src/auth/**"]);
    expect(repos.get("explicit-none").escalatePaths).toEqual([]);
    expect(repos.get("malformed").escalatePaths).toBeNull();
    expect(repos.get("undeclared").escalatePaths).toBeNull();
  });

  test("owned_paths_policy is parsed and validated, defaulting to empty when absent", () => {
    const repos = loadRepos({
      root: factoryRoot(`repos:
  - name: bare
    path: /tmp/a
    owned_paths_policy:
      direct: []
      pin_manifests: []
  - name: absent-policy
    path: /tmp/b
`),
    });
    expect(repos.get("bare").ownedPathsPolicy).toEqual({
      direct: [],
      pinManifests: [],
    });
    expect(repos.get("absent-policy").ownedPathsPolicy).toEqual({
      direct: [],
      pinManifests: [],
    });
  });

  test("owned_paths_policy must be valid schema", () => {
    const invalidCases = [
      `repos:\n  - name: bad\n    path: /tmp/a\n    owned_paths_policy: []\n`,
      `repos:\n  - name: bad\n    path: /tmp/a\n    owned_paths_policy:\n      direct: "oops"\n`,
      `repos:\n  - name: bad\n    path: /tmp/a\n    owned_paths_policy:\n      direct:\n        - source: "shared/**"\n      pin_manifests: ["x"]\n`,
      `repos:\n  - name: bad\n    path: /tmp/a\n    owned_paths_policy:\n      direct:\n        - source: "shared/**"\n          requires: []\n`,
      `repos:\n  - name: bad\n    path: /tmp/a\n    owned_paths_policy:\n      pin_manifests: [null]\n`,
      `repos:\n  - name: bad\n    path: /tmp/a\n    owned_paths_policy:\n      extra: 1\n`,
    ];
    for (const yaml of invalidCases) {
      expect(() => loadRepos({ root: factoryRoot(yaml) })).toThrow(RepoError);
    }
  });

  test("merge_ci is all-or-nothing, nonempty, string-only, and unambiguous (WM-419)", () => {
    const invalidCases = [
      `repos:\n  - name: no-workflow\n    path: /tmp/a\n    merge_ci:\n      required_checks: [Verify]\n`,
      `repos:\n  - name: no-checks\n    path: /tmp/b\n    merge_ci:\n      workflow: CI\n`,
      `repos:\n  - name: empty-workflow\n    path: /tmp/c\n    merge_ci:\n      workflow: ""\n      required_checks: [Verify]\n`,
      `repos:\n  - name: empty-checks\n    path: /tmp/d\n    merge_ci:\n      workflow: CI\n      required_checks: []\n`,
      `repos:\n  - name: duplicate\n    path: /tmp/e\n    merge_ci:\n      workflow: CI\n      required_checks: [Verify, Verify]\n`,
      `repos:\n  - name: non-string\n    path: /tmp/f\n    merge_ci:\n      workflow: CI\n      required_checks: [42]\n`,
    ];
    for (const yaml of invalidCases) {
      expect(() => loadRepos({ root: factoryRoot(yaml) })).toThrow(RepoError);
    }
  });

  test("GitHub required contexts are preferred; configured checks are the explicit empty fallback (WM-419)", () => {
    const repos = loadRepos({ root: factoryRoot(YAML) });
    const repo = repos.get("full");
    expect(selectMergeCheckGate(repo, ["Protected Verify"])).toEqual({
      source: "github",
      workflow: null,
      requiredChecks: ["Protected Verify"],
    });
    expect(selectMergeCheckGate(repo, [])).toEqual({
      source: "config",
      workflow: "CI",
      requiredChecks: ["Shadow runner fleet available", "Verify"],
    });
    expect(() => selectMergeCheckGate(repos.get("bare"), [])).toThrow(
      RepoError,
    );
    expect(() => selectMergeCheckGate(repo, ["Verify", "Verify"])).toThrow(
      RepoError,
    );
  });

  test("exact-SHA check proof rejects empty, missing, pending, red, stale, and ambiguous evidence (WM-419)", () => {
    const sha = "a".repeat(40);
    const green = (name) => ({
      name,
      headSha: sha,
      status: "completed",
      conclusion: "success",
      workflow: "CI",
    });
    const expected = ["Shadow runner fleet available", "Verify"];
    expect(
      proveMergeChecks({
        expectedChecks: expected,
        actualChecks: expected.map(green),
        expectedSha: sha,
        workflow: "CI",
      }),
    ).toBe(true);
    const invalid = [
      [],
      [green(expected[0])],
      [
        green(expected[0]),
        { ...green(expected[1]), status: "in_progress", conclusion: null },
      ],
      [green(expected[0]), { ...green(expected[1]), conclusion: "failure" }],
      [green(expected[0]), { ...green(expected[1]), headSha: "b".repeat(40) }],
      [green(expected[0]), green(expected[1]), green(expected[1])],
      [green(expected[0]), { ...green(expected[1]), workflow: "Other" }],
    ];
    for (const actualChecks of invalid) {
      expect(() =>
        proveMergeChecks({
          expectedChecks: expected,
          actualChecks,
          expectedSha: sha,
          workflow: "CI",
        }),
      ).toThrow(RepoError);
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
    expect(rows[0]).toMatchObject({
      hasWorktreeUp: true,
      hasWorktreeDown: true,
      hasWorktreeWarm: true,
    });
    expect(rows[1]).toMatchObject({
      hasWorktreeUp: false,
      hasWorktreeDown: false,
      hasWorktreeWarm: false,
    });
    // The script path itself is meaningless to a reader and only the janitor
    // executes it, so it stays server-side.
    expect(rows[0]).not.toHaveProperty("worktreeDown");
  });

  test("the projection is an allow-list containing only deliberately published config", () => {
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "base",
        "deployBranch",
        "deployment",
        "effective",
        "escalatePaths",
        "github",
        "hasWorktreeDown",
        "hasWorktreeUp",
        "hasWorktreeWarm",
        "maxInFlight",
        "mergeCi",
        "name",
        "ownedPathsPolicy",
        "path",
        "project",
        "reportOnly",
        "security",
        "smokeDeadlineSeconds",
        "smokeUrl",
        "smokeWorkflow",
        "team",
        "verify",
        "worktreeRoot",
      ]);
    }
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("escalate_paths");
    expect(serialized).not.toContain("python_version");
    expect(serialized).not.toContain("never-publish-deployment-secret");
    expect(serialized).not.toContain("never-publish-security-token");
  });

  test("policy fields preserve escalate_paths null versus empty and allow-list security", () => {
    expect(rows[0]).toMatchObject({
      escalatePaths: ["src/auth/**"],
      ownedPathsPolicy: {
        direct: [
          { source: "shared/**", requires: ["dist/**", "plugins/core/**"] },
        ],
        pinManifests: ["event-runtime/agents/*.json"],
      },
      security: { pythonVersion: "3.12" },
    });
    expect(rows[1]).toMatchObject({ escalatePaths: null, security: null });

    const explicit = reposView(
      loadRepos({
        root: factoryRoot(`repos:
  - name: none
    path: /tmp/none
    escalate_paths: []
`),
      }),
    );
    expect(explicit[0].escalatePaths).toEqual([]);
  });

  test("effective max in flight identifies repo values and the planner default", () => {
    expect(rows[0].effective).toEqual({
      maxInFlight: 20,
      maxInFlightSource: "repo",
    });
    expect(rows[1].effective).toEqual({
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      maxInFlightSource: "default",
    });
  });

  test("repos.mjs does not import planner.mjs (WM-755)", () => {
    const source = readFileSync(
      new URL("./repos.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']\.\/planner\.mjs["']/);
  });

  test("the dispatch/report-only distinction survives the wire", () => {
    expect(rows.map((r) => [r.name, r.reportOnly])).toEqual([
      ["full", false],
      ["bare", true],
    ]);
  });
});

// WM-1007: which tracker holds a repo's tickets. null means "inherit
// config/policy.yaml" — a default of "linear" here would state a choice the
// file never made, and would outrank policy for every repo that omitted it.
describe("control_plane on a repo entry", () => {
  test("absent reads as null, not a default", () => {
    const root = factoryRoot("repos:\n  - name: a\n    path: /tmp/a\n");
    expect(loadRepos({ root }).get("a").controlPlane).toBeNull();
  });

  test("each valid kind is carried through", () => {
    for (const kind of ["linear", "github", "memory"]) {
      const root = factoryRoot(
        `repos:\n  - name: a\n    path: /tmp/a\n    control_plane: ${kind}\n`,
      );
      expect(loadRepos({ root }).get("a").controlPlane).toBe(kind);
    }
  });

  test("an unknown kind is a load error naming the repo and the options", () => {
    const root = factoryRoot(
      "repos:\n  - name: a\n    path: /tmp/a\n    control_plane: jira\n",
    );
    expect(() => loadRepos({ root })).toThrow(RepoError);
    expect(() => loadRepos({ root })).toThrow(
      /repo a control_plane must be one of linear, memory, github/,
    );
  });

  test("reposView does not publish it yet (see follow-up)", () => {
    const root = factoryRoot(
      "repos:\n  - name: a\n    path: /tmp/a\n    control_plane: github\n",
    );
    expect(reposView(loadRepos({ root }))[0]).not.toHaveProperty(
      "controlPlane",
    );
  });
});

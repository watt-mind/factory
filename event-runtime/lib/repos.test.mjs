import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-repos-test-mjs";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_IN_FLIGHT } from "./config.mjs";
import {
  assertRepoReadyForClaim,
  loadRepos,
  parseToolVersion,
  preflightToolchain,
  probeToolVersion,
  proveMergeChecks,
  RepoError,
  RepoNotReadyError,
  reposView,
  selectMergeCheckGate,
  TOOLCHAIN_MISMATCH,
  TOOLCHAIN_MISSING,
  toolchainReport,
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
      toolchain: null,
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
        "controlPlane",
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
        "toolchain",
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

  test("reposView publishes controlPlane, null for inherit and explicit for a pinned repo", () => {
    const inherit = factoryRoot("repos:\n  - name: a\n    path: /tmp/a\n");
    expect(reposView(loadRepos({ root: inherit }))[0].controlPlane).toBeNull();

    const pinned = factoryRoot(
      "repos:\n  - name: a\n    path: /tmp/a\n    control_plane: github\n",
    );
    expect(reposView(loadRepos({ root: pinned }))[0].controlPlane).toBe(
      "github",
    );
  });
});

// WM-316: toolchain preflight — declare executable version constraints per repo,
// verify them before claim, and fail with a typed reason instead of mid-run.
describe("toolchain constraints parse and validate", () => {
  const TOOLCHAIN_YAML = `repos:
  - name: pinned
    path: /tmp/pinned
    toolchain:
      - executable: bun
        constraint: ">=1.2"
      - executable: node
        constraint: ">=22 <25"
  - name: none
    path: /tmp/none
`;

  test("a declared toolchain becomes an ordered list of { executable, constraint }", () => {
    const repos = loadRepos({ root: factoryRoot(TOOLCHAIN_YAML) });
    expect(repos.get("pinned").toolchain).toEqual([
      { executable: "bun", constraint: ">=1.2" },
      { executable: "node", constraint: ">=22 <25" },
    ]);
  });

  test("a repo with no toolchain block reads as null — additive, no gating", () => {
    const repos = loadRepos({ root: factoryRoot(TOOLCHAIN_YAML) });
    expect(repos.get("none").toolchain).toBeNull();
  });

  test("the constraint list is published on the wire for doctor and operators", () => {
    const rows = reposView(loadRepos({ root: factoryRoot(TOOLCHAIN_YAML) }));
    expect(rows.find((r) => r.name === "pinned").toolchain).toEqual([
      { executable: "bun", constraint: ">=1.2" },
      { executable: "node", constraint: ">=22 <25" },
    ]);
    expect(rows.find((r) => r.name === "none").toolchain).toBeNull();
  });

  test("malformed toolchain blocks fail the load with a RepoError", () => {
    const invalidCases = [
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain: "bun"\n`,
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain: []\n`,
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain:\n      - executable: bun\n`,
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain:\n      - constraint: ">=1"\n`,
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain:\n      - executable: ""\n        constraint: ">=1"\n`,
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain:\n      - executable: bun\n        constraint: ""\n`,
      `repos:\n  - name: a\n    path: /tmp/a\n    toolchain:\n      - executable: bun\n        constraint: ">=1"\n      - executable: bun\n        constraint: ">=2"\n`,
    ];
    for (const yaml of invalidCases) {
      expect(() => loadRepos({ root: factoryRoot(yaml) })).toThrow(RepoError);
    }
  });
});

describe("parseToolVersion normalizes tool banners", () => {
  test("extracts the first semver from assorted --version output", () => {
    expect(parseToolVersion("git version 2.47.3")).toBe("2.47.3");
    expect(parseToolVersion("v22.4.1")).toBe("22.4.1");
    expect(parseToolVersion("1.2.8")).toBe("1.2.8");
    expect(parseToolVersion("Python 3.12.4")).toBe("3.12.4");
    expect(parseToolVersion("no digits here")).toBeNull();
    expect(parseToolVersion(null)).toBeNull();
  });
});

describe("preflightToolchain verifies constraints before claim", () => {
  // A repo shaped like loadRepos output, minimal to the fields preflight reads.
  const repo = (toolchain) => ({ name: "sut", toolchain });
  const constraints = [
    { executable: "bun", constraint: ">=1.2" },
    { executable: "node", constraint: ">=22 <25" },
  ];

  test("all constraints satisfied → ready, one passing check per executable", () => {
    const resolve = (exe) =>
      ({
        bun: { found: true, version: "1.2.8" },
        node: { found: true, version: "22.4.1" },
      })[exe];
    const result = preflightToolchain(repo(constraints), {
      node: "runner-a",
      resolve,
    });
    expect(result.ready).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((c) => [c.executable, c.ok])).toEqual([
      ["bun", true],
      ["node", true],
    ]);
  });

  test("a missing executable fails with repo_toolchain_missing and no observed version", () => {
    const resolve = (exe) =>
      ({
        bun: { found: true, version: "1.2.8" },
        node: { found: false, version: null },
      })[exe];
    const result = preflightToolchain(repo(constraints), { resolve });
    expect(result.ready).toBe(false);
    const failure = result.failures[0];
    expect(failure).toMatchObject({
      executable: "node",
      reason: TOOLCHAIN_MISSING,
      observed: null,
    });
  });

  test("a version mismatch carries node, executable, constraint, and observed version", () => {
    const resolve = (exe) =>
      ({
        bun: { found: true, version: "1.2.8" },
        node: { found: true, version: "18.19.0" },
      })[exe];
    const result = preflightToolchain(repo(constraints), {
      node: "runner-b",
      resolve,
    });
    expect(result.ready).toBe(false);
    expect(result.node).toBe("runner-b");
    expect(result.failures[0]).toEqual({
      executable: "node",
      constraint: ">=22 <25",
      observed: "18.19.0",
      ok: false,
      reason: TOOLCHAIN_MISMATCH,
    });
  });

  test("a repo with no toolchain block is ready with zero checks (passthrough)", () => {
    const called = [];
    const resolve = (exe) => {
      called.push(exe);
      return { found: true, version: "1.0.0" };
    };
    for (const tc of [null, undefined]) {
      const result = preflightToolchain(repo(tc), { resolve });
      expect(result.ready).toBe(true);
      expect(result.checks).toEqual([]);
    }
    // Passthrough must not probe anything — additive means untouched.
    expect(called).toEqual([]);
  });
});

describe("preflight is non-mutating — it never installs or upgrades tooling", () => {
  test("probeToolVersion only ever runs `<exe> --version`", () => {
    const spawned = [];
    const spawnSync = (argv) => {
      spawned.push(argv);
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode("1.2.8"),
        stderr: new Uint8Array(),
      };
    };
    const result = probeToolVersion("bun", { spawnSync });
    expect(result).toEqual({ found: true, version: "1.2.8" });
    expect(spawned).toEqual([["bun", "--version"]]);
    // Structural guarantee: no install/add/upgrade verb is ever spawned.
    const flat = spawned.flat().join(" ");
    expect(flat).not.toMatch(/\b(install|add|upgrade|update|get)\b/);
  });

  test("a probe for an absent binary resolves to not-found, never an install", () => {
    const spawned = [];
    const spawnSync = (argv) => {
      spawned.push(argv);
      const err = new Error("spawn ENOENT");
      err.code = "ENOENT";
      throw err;
    };
    expect(probeToolVersion("ghost", { spawnSync })).toEqual({
      found: false,
      version: null,
    });
    expect(spawned).toEqual([["ghost", "--version"]]);
  });

  test("preflight drives only the injected resolver and spawns nothing itself", () => {
    const repo = {
      name: "sut",
      toolchain: [{ executable: "bun", constraint: ">=1" }],
    };
    const seen = [];
    preflightToolchain(repo, {
      resolve: (exe) => {
        seen.push(exe);
        return { found: true, version: "1.5.0" };
      },
    });
    expect(seen).toEqual(["bun"]);
  });
});

describe("dispatch consults readiness before claiming (WM-316)", () => {
  test("assertRepoReadyForClaim returns the passing result for a ready repo", () => {
    const repo = {
      name: "ready",
      toolchain: [{ executable: "bun", constraint: ">=1.2" }],
    };
    const result = assertRepoReadyForClaim(repo, {
      resolve: () => ({ found: true, version: "1.2.8" }),
    });
    expect(result.ready).toBe(true);
  });

  test("a not-ready repo is refused before claim, and the refusal names the failing constraint", () => {
    const repo = {
      name: "stale",
      toolchain: [{ executable: "node", constraint: ">=22" }],
    };
    let thrown;
    try {
      assertRepoReadyForClaim(repo, {
        node: "runner-c",
        resolve: () => ({ found: true, version: "18.19.0" }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoNotReadyError);
    expect(thrown.message).toContain("node");
    expect(thrown.message).toContain(">=22");
    expect(thrown.message).toContain("18.19.0");
    expect(thrown.message).toContain(TOOLCHAIN_MISMATCH);
    // The full preflight result rides along for diagnostics/doctor.
    expect(thrown.detail.failures[0].observed).toBe("18.19.0");
  });

  test("a missing-executable repo is refused naming the tool and constraint", () => {
    const repo = {
      name: "nobun",
      toolchain: [{ executable: "bun", constraint: ">=1.2" }],
    };
    expect(() =>
      assertRepoReadyForClaim(repo, {
        resolve: () => ({ found: false, version: null }),
      }),
    ).toThrow(/repo_toolchain_missing[\s\S]*bun/);
  });

  test("a repo with no toolchain block is never refused — nine working repos stay dispatchable", () => {
    const repo = { name: "legacy", toolchain: null };
    expect(assertRepoReadyForClaim(repo).ready).toBe(true);
  });
});

describe("toolchainReport surfaces per-repo status for factory doctor", () => {
  test("one row per repo: declared flag, readiness, and per-executable checks", () => {
    const repos = loadRepos({
      root: factoryRoot(`repos:
  - name: pinned
    path: /tmp/pinned
    toolchain:
      - executable: bun
        constraint: ">=99"
  - name: plain
    path: /tmp/plain
`),
    });
    const report = toolchainReport(repos, {
      resolve: () => ({ found: true, version: "1.2.8" }),
    });
    expect(report).toEqual([
      {
        repo: "pinned",
        declared: true,
        ready: false,
        checks: [
          {
            executable: "bun",
            constraint: ">=99",
            observed: "1.2.8",
            ok: false,
            reason: TOOLCHAIN_MISMATCH,
          },
        ],
      },
      { repo: "plain", declared: false, ready: true, checks: [] },
    ]);
  });
});

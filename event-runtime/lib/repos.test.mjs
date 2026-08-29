import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-repos-test-mjs";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_IN_FLIGHT } from "./config.mjs";
import {
  isToolchainConstraint,
  loadRepos,
  normalizeToolVersion,
  preflightToolchain,
  proveMergeChecks,
  REPO_ATTESTATION_STALE,
  REPO_TOOLCHAIN_MISMATCH,
  REPO_TOOLCHAIN_MISSING,
  RepoError,
  repoDispatchPreflight,
  repoReadiness,
  reposView,
  resolvePromotionTarget,
  selectMergeCheckGate,
  TOOLCHAIN_ATTESTATION_MAX_AGE_MS,
  toolchainAttestationCurrent,
  toolchainHash,
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
    toolchain:
      bun: ">=1.3 <2"
      node: ">=22 <25"
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
      toolchain: [
        { executable: "bun", constraint: ">=1.3 <2" },
        { executable: "node", constraint: ">=22 <25" },
      ],
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
      // No `toolchain:` block is the nine-repos-today case: null, never [].
      toolchain: null,
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

// ---------------------------------------------------------------------------
// WM-316 toolchain preflight (docs/event-runtime-repos.md §§5–6).
// ---------------------------------------------------------------------------

const CLOCK = new Date("2026-08-29T12:00:00.000Z");
const now = () => CLOCK;

/**
 * A fake node. `which`/`spawn` are injected at the level the production code
 * actually uses them, so the argv the real preflight builds is the argv these
 * assertions see — a fake at the `probe` level would only test the fake.
 */
function fakeNode({ versions = {}, missing = [], exitCodes = {} } = {}) {
  const whichCalls = [];
  const spawnCalls = [];
  return {
    whichCalls,
    spawnCalls,
    which: async (executable) => {
      whichCalls.push(executable);
      return missing.includes(executable) ? null : `/opt/bin/${executable}`;
    },
    spawn: async (argv) => {
      spawnCalls.push(argv);
      // The production probe spawns the PATH-resolved path (argv[0] is
      // `/opt/bin/<exe>`), so key the fake's canned output by basename.
      const key = argv[0].split("/").pop();
      return {
        exitCode: exitCodes[key] ?? 0,
        stdout: versions[key] ?? "",
        stderr: "",
      };
    },
  };
}

function repoWith(toolchainYaml, name = "tc") {
  return loadRepos({
    root: factoryRoot(
      `repos:\n  - name: ${name}\n    path: /tmp/${name}\n${toolchainYaml}`,
    ),
  }).get(name);
}

describe("toolchain: declaration parsing and validation", () => {
  test("the documented map form and the explicit list form normalize identically", () => {
    const mapForm = repoWith(
      `    toolchain:\n      bun: ">=1.3 <2"\n      git: ">=2.40"\n`,
    );
    const listForm = repoWith(
      `    toolchain:\n      - executable: bun\n        constraint: ">=1.3 <2"\n      - executable: git\n        constraint: ">=2.40"\n`,
    );
    const expected = [
      { executable: "bun", constraint: ">=1.3 <2" },
      { executable: "git", constraint: ">=2.40" },
    ];
    expect(mapForm.toolchain).toEqual(expected);
    expect(listForm.toolchain).toEqual(expected);
    expect(toolchainHash(mapForm.toolchain)).toBe(
      toolchainHash(listForm.toolchain),
    );
  });

  test("absent reads null and an empty block reads [] — neither is a default constraint", () => {
    expect(repoWith("").toolchain).toBeNull();
    expect(repoWith(`    toolchain: {}\n`).toolchain).toEqual([]);
    expect(repoWith(`    toolchain: []\n`).toolchain).toEqual([]);
  });

  test("an executable must be a bare command name, never a path or a shell fragment", () => {
    const invalid = [
      `    toolchain:\n      "/usr/local/bin/bun": ">=1.3"\n`,
      `    toolchain:\n      "sh -c 'brew install bun'": ">=1.3"\n`,
      `    toolchain:\n      "bun; rm -rf /": ">=1.3"\n`,
      `    toolchain:\n      "": ">=1.3"\n`,
      `    toolchain:\n      "../bun": ">=1.3"\n`,
    ];
    for (const yaml of invalid) {
      expect(() => repoWith(yaml)).toThrow(RepoError);
    }
    expect(() =>
      repoWith(`    toolchain:\n      "/usr/bin/bun": ">=1"\n`),
    ).toThrow(/bare command name/);
  });

  test("a constraint must be a semver range, because Bun.semver is fail-open on garbage", () => {
    // Guard on the real reason this validation exists: an unvalidated
    // `satisfies("1.2.3", "not a range")` returns true, so a typo'd range
    // would silently pass every version instead of gating anything.
    expect(Bun.semver.satisfies("1.2.3", "not a range")).toBe(true);
    expect(isToolchainConstraint("not a range")).toBe(false);

    for (const good of [
      ">=1.3 <2",
      ">=22",
      "^1.2.3",
      "~2.0",
      "1.x",
      "*",
      "1.2.3 || >=4.0.0",
      "1.2.3 - 2.0.0",
      ">=1.3.0-canary.1",
      // node-semver allows whitespace after an operator. Rejecting these
      // throws inside loadRepos, which takes down every command that reads
      // the registry — a false reject is louder than a missed constraint.
      ">= 1.2.3",
      "> 1.2.3 < 2.0.0",
      "^ 1.2.3",
      ">= 1.2.3 || < 1.0.0",
    ]) {
      expect([good, isToolchainConstraint(good)]).toEqual([good, true]);
    }
    for (const bad of [
      "not a range",
      "",
      "   ",
      ">=",
      "latest",
      ">=1.2; echo hi",
      "$(id)",
      ">=1.2 || ",
      42,
      null,
    ]) {
      expect([bad, isToolchainConstraint(bad)]).toEqual([bad, false]);
    }
    expect(() => repoWith(`    toolchain:\n      bun: latest\n`)).toThrow(
      /must be a semver range/,
    );
  });

  test("structural errors name the repo instead of loading a half-understood block", () => {
    const invalid = [
      `    toolchain: "bun >=1.3"\n`,
      `    toolchain:\n      - bun\n`,
      `    toolchain:\n      - executable: bun\n        constraint: ">=1"\n        install: brew install bun\n`,
      `    toolchain:\n      - executable: bun\n        constraint: ">=1"\n      - executable: bun\n        constraint: ">=2"\n`,
      `    toolchain:\n      bun: 13\n`,
    ];
    for (const yaml of invalid) {
      expect(() => repoWith(yaml)).toThrow(RepoError);
    }
    expect(() =>
      repoWith(
        `    toolchain:\n      - executable: bun\n        constraint: ">=1"\n      - executable: bun\n        constraint: ">=2"\n`,
      ),
    ).toThrow(/declares toolchain executable "bun" twice/);
  });

  test("the registry projection does not publish toolchain yet (removed by #1097)", () => {
    // Not an oversight: /repos and the config view assert this projection
    // exactly, in api-registry.test.mjs and api-config.test.mjs, both outside
    // gh-1076's Owned Paths. Issue #1097 — toolchain status in `factory
    // doctor` — publishes the field and updates those assertions in the same
    // commit, and deletes this pin.
    const rows = reposView(loadRepos({ root: factoryRoot(YAML) }));
    expect(rows[0]).not.toHaveProperty("toolchain");
  });
});

describe("normalizeToolVersion reads what real tools actually print", () => {
  test("the version formats of the tools this factory depends on", () => {
    expect(normalizeToolVersion("1.2.23\n")).toBe("1.2.23");
    expect(normalizeToolVersion("v22.1.0\n")).toBe("22.1.0");
    expect(normalizeToolVersion("git version 2.39.5 (Apple Git-154)")).toBe(
      "2.39.5",
    );
    expect(normalizeToolVersion("Python 3.12.1")).toBe("3.12.1");
    expect(normalizeToolVersion("Docker version 24.0.7, build afdd53b")).toBe(
      "24.0.7",
    );
    expect(normalizeToolVersion("1.3.0-canary.20260101")).toBe(
      "1.3.0-canary.20260101",
    );
    expect(normalizeToolVersion("GNU bash, version 5.2.15(1)-release")).toBe(
      "5.2.15",
    );
  });

  test("a version glued to its own name still reads — `go` must be usable", () => {
    // `[^\w.]`-style boundaries reject `go1.22.0`, which would give every Go
    // repo a permanent unparseable_version and make the gate undispatchable
    // for them. Fails closed, but unusable.
    expect(normalizeToolVersion("go version go1.22.0 darwin/arm64")).toBe(
      "1.22.0",
    );
    expect(normalizeToolVersion("go1.22")).toBe("1.22.0");
  });

  test("a partial version widens to x.y.z so semver can compare it", () => {
    expect(normalizeToolVersion("22")).toBe("22.0.0");
    expect(normalizeToolVersion("1.2")).toBe("1.2.0");
  });

  test("a stray integer in error output is never a version — the gate must not fail open", () => {
    // Each of these once produced a version that satisfies a loose range:
    // "Error 404: not found" became "404.0.0", and
    // satisfies("404.0.0", ">=1.3") is true. A tool that exits 0 while
    // printing a non-version line would have passed the constraint.
    for (const line of [
      "Error 404: not found",
      "Permission denied (os error 13)",
      "Segmentation fault: 11",
      "Tool (build 1234)",
      "usage: tool [-h] [--verbose]",
      "released 2024-01-15",
    ]) {
      expect([line, normalizeToolVersion(line)]).toEqual([line, null]);
    }
    expect(Bun.semver.satisfies("404.0.0", ">=1.3")).toBe(true);
  });

  test("a partial token of a longer number is not a version either", () => {
    // An IPv4 address or a four-part build must match nothing rather than
    // yielding a plausible-looking prefix like "10.0.0".
    expect(normalizeToolVersion("connect: 10.0.0.1 refused")).toBeNull();
    expect(normalizeToolVersion("1.2.3.4")).toBeNull();
  });

  test("nothing version-shaped is null, not a guess", () => {
    expect(normalizeToolVersion("command not found")).toBeNull();
    expect(normalizeToolVersion("")).toBeNull();
    expect(normalizeToolVersion(undefined)).toBeNull();
  });
});

describe("preflightToolchain verifies without mutating the host", () => {
  test("every satisfied constraint attests ok with the observed versions", async () => {
    const repo = repoWith(
      `    toolchain:\n      bun: ">=1.3 <2"\n      node: ">=22 <25"\n`,
    );
    const node = fakeNode({
      versions: { bun: "1.3.14\n", node: "v22.14.0\n" },
    });
    const attestation = await preflightToolchain(repo, {
      node: "runner",
      now,
      ...node,
    });
    expect(attestation.ok).toBe(true);
    expect(attestation.reasons).toEqual([]);
    expect(attestation.node).toBe("runner");
    expect(attestation.declared).toBe(true);
    expect(attestation.verifiedAt).toBe(CLOCK.toISOString());
    expect(
      attestation.tools.map((t) => [t.executable, t.observed, t.satisfied]),
    ).toEqual([
      ["bun", "1.3.14", true],
      ["node", "22.14.0", true],
    ]);
  });

  test("an unresolvable executable is repo_toolchain_missing, naming node and constraint", async () => {
    const repo = repoWith(`    toolchain:\n      uv: ">=0.5"\n`);
    const node = fakeNode({ missing: ["uv"] });
    const { ok, reasons } = await preflightToolchain(repo, {
      node: "runner",
      now,
      ...node,
    });
    expect(ok).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({
      reason: REPO_TOOLCHAIN_MISSING,
      node: "runner",
      repo: "tc",
      executable: "uv",
      constraint: ">=0.5",
      observed: null,
    });
    expect(reasons[0].action).toContain("uv");
    // A missing executable is never probed for a version.
    expect(node.spawnCalls).toEqual([]);
  });

  test("a version mismatch carries node, executable, constraint AND the observed version", async () => {
    const repo = repoWith(`    toolchain:\n      node: ">=22 <25"\n`);
    const node = fakeNode({ versions: { node: "v18.19.1\n" } });
    const { ok, reasons } = await preflightToolchain(repo, {
      node: "mac-mini",
      now,
      ...node,
    });
    expect(ok).toBe(false);
    expect(reasons[0]).toMatchObject({
      reason: REPO_TOOLCHAIN_MISMATCH,
      node: "mac-mini",
      repo: "tc",
      executable: "node",
      constraint: ">=22 <25",
      observed: "18.19.1",
      detail: "constraint_unsatisfied",
    });
    // The whole point of the payload: "node 18, not 22" without going to the box.
    expect(reasons[0].action).toContain("18.19.1");
  });

  test("an unreadable or failing version probe fails closed, keeping the raw output", async () => {
    const repo = repoWith(
      `    toolchain:\n      broken: ">=1"\n      garbled: ">=1"\n`,
    );
    const node = fakeNode({
      versions: { broken: "boom\n", garbled: "no version here\n" },
      exitCodes: { broken: 1 },
    });
    const { ok, reasons } = await preflightToolchain(repo, { now, ...node });
    expect(ok).toBe(false);
    expect(reasons.map((r) => [r.executable, r.reason, r.detail])).toEqual([
      ["broken", REPO_TOOLCHAIN_MISMATCH, "version_probe_failed"],
      ["garbled", REPO_TOOLCHAIN_MISMATCH, "unparseable_version"],
    ]);
    expect(reasons[1].observed).toBeNull();
    expect(reasons[1].observedRaw).toBe("no version here");
  });

  test("preflight is non-mutating: the only command spawned is `<exe> --version`", async () => {
    const repo = repoWith(
      `    toolchain:\n      bun: ">=1.3 <2"\n      node: ">=22 <25"\n      git: ">=2.40"\n`,
    );
    const node = fakeNode({
      versions: { bun: "1.3.14", node: "v22.14.0", git: "git version 2.39.5" },
    });
    await preflightToolchain(repo, { now, ...node });

    expect(node.whichCalls).toEqual(["bun", "node", "git"]);
    // The probe spawns the PATH-resolved path from `which`, not the bare name,
    // so the version reported is provably from the binary the attestation names.
    expect(node.spawnCalls).toEqual([
      ["/opt/bin/bun", "--version"],
      ["/opt/bin/node", "--version"],
      ["/opt/bin/git", "--version"],
    ]);
    // Not just "the expected commands ran" — no install/upgrade verb reached
    // the host under any name. Toolchain preflight validates; it does not
    // install or mutate host tooling (docs/event-runtime-repos.md §10).
    const mutating =
      /\b(install|upgrade|update|add|remove|uninstall|link|use|brew|apt|apt-get|yum|pacman|port|npm|pnpm|yarn|pip|pipx|corepack|nvm|fnm|asdf|volta|rustup|curl|wget|sh|bash|zsh|sudo)\b/i;
    for (const argv of node.spawnCalls) {
      expect(argv).toHaveLength(2);
      expect(argv[1]).toBe("--version");
      expect(mutating.test(argv.join(" "))).toBe(false);
    }
  });

  test("the probe spawns the resolved path, not the bare name (WM-1116)", async () => {
    // `which` and `spawn` each resolve PATH independently; if the probe spawned
    // the bare name it could run a different binary than the one attested. A
    // `which` that returns a path unrelated to the bare name proves the spawn
    // used argv[0] = the resolved path, so `resolved` and `observed` describe
    // the same binary.
    const repo = repoWith(`    toolchain:\n      bun: ">=1.3 <2"\n`);
    const spawnCalls = [];
    const resolvedPath = "/opt/homebrew/Cellar/bun/1.3.14/bin/bun";
    const node = {
      which: async () => resolvedPath,
      spawn: async (argv) => {
        spawnCalls.push(argv);
        // Only answer for the resolved path; a bare-name spawn would get "".
        return {
          exitCode: 0,
          stdout: argv[0] === resolvedPath ? "1.3.14\n" : "",
          stderr: "",
        };
      },
    };
    const attestation = await preflightToolchain(repo, { now, ...node });

    expect(spawnCalls).toEqual([[resolvedPath, "--version"]]);
    const [tool] = attestation.tools;
    expect(tool.resolved).toBe(resolvedPath);
    expect(tool.observed).toBe("1.3.14");
    expect(tool.satisfied).toBe(true);
    expect(attestation.ok).toBe(true);
  });

  test("a repo with no toolchain block is attested without touching the host", async () => {
    const repo = repoWith("");
    const node = fakeNode();
    const attestation = await preflightToolchain(repo, { now, ...node });
    expect(attestation.ok).toBe(true);
    expect(attestation.declared).toBe(false);
    expect(attestation.tools).toEqual([]);
    expect(node.whichCalls).toEqual([]);
    expect(node.spawnCalls).toEqual([]);
  });
});

describe("readiness: a repo is ready only on a current, passing attestation", () => {
  const declared = () => repoWith(`    toolchain:\n      bun: ">=1.3 <2"\n`);
  const passing = async (repo, overrides = {}) =>
    preflightToolchain(repo, {
      node: "runner",
      now,
      ...fakeNode({ versions: { bun: "1.3.14" } }),
      ...overrides,
    });

  test("no declared toolchain is ready with no attestation at all — the additive case", () => {
    // The nine repos in production today declare nothing; the upgrade must
    // not turn a single one of them not-ready.
    for (const repo of [repoWith(""), repoWith(`    toolchain: {}\n`)]) {
      expect(repoReadiness({ repo, node: "runner", now })).toEqual({
        ready: true,
        attested: false,
        reasons: [],
        refusal: null,
      });
    }
  });

  test("a current passing attestation is ready", async () => {
    const repo = declared();
    const readiness = repoReadiness({
      repo,
      attestation: await passing(repo),
      node: "runner",
      now,
    });
    expect(readiness).toEqual({
      ready: true,
      attested: true,
      reasons: [],
      refusal: null,
    });
  });

  test("absent, expired, re-declared, and wrong-node attestations are all stale", async () => {
    const repo = declared();
    const attestation = await passing(repo);
    const cases = [
      [null, "absent", { node: "runner", now }],
      [
        attestation,
        "expired",
        {
          node: "runner",
          now: () =>
            new Date(CLOCK.getTime() + TOOLCHAIN_ATTESTATION_MAX_AGE_MS + 1000),
        },
      ],
      [attestation, "node_changed", { node: "mac-mini", now }],
      [
        { ...attestation, toolchainHash: "sha256:stale" },
        "config_changed",
        { node: "runner", now },
      ],
      [
        { ...attestation, implementationVersion: 0 },
        "implementation_changed",
        { node: "runner", now },
      ],
      [
        { ...attestation, verifiedAt: "whenever" },
        "unverifiable_timestamp",
        { node: "runner", now },
      ],
    ];
    for (const [candidate, detail, opts] of cases) {
      expect(toolchainAttestationCurrent(candidate, repo, opts)).toEqual({
        current: false,
        detail,
      });
      const readiness = repoReadiness({
        repo,
        attestation: candidate,
        ...opts,
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons[0]).toMatchObject({
        reason: REPO_ATTESTATION_STALE,
        detail,
      });
    }
  });

  test("a failing attestation is not ready and the refusal names the failing constraint", async () => {
    const repo = declared();
    const attestation = await preflightToolchain(repo, {
      node: "runner",
      now,
      ...fakeNode({ versions: { bun: "1.1.45" } }),
    });
    const readiness = repoReadiness({ repo, attestation, node: "runner", now });
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons[0]).toMatchObject({
      reason: REPO_TOOLCHAIN_MISMATCH,
      observed: "1.1.45",
    });
    expect(readiness.refusal).toBe(
      "repo tc toolchain preflight failed on runner: bun >=1.3 <2 (observed 1.1.45)",
    );
  });

  test("a malformed attestation refuses instead of throwing", async () => {
    // WM-317 persists and reloads attestations, and once #1096 puts this on
    // the pre-claim path a throw stalls dispatch where a refusal only skips
    // one repo. `reasons` missing entirely must still produce a refusal.
    const repo = declared();
    const attestation = await passing(repo);
    for (const reasons of [undefined, null, "not-an-array"]) {
      const readiness = repoReadiness({
        repo,
        attestation: { ...attestation, ok: false, reasons },
        node: "runner",
        now,
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons).toEqual([]);
      expect(readiness.refusal).toBe(
        "repo tc toolchain preflight failed on runner with no recorded reason — re-run preflight",
      );
    }
  });

  test("the stale-attestation action names a command that exists", () => {
    // `bin/factory` has no `repo` subcommand; an action an operator cannot run
    // is not an action. Publishing this through `factory doctor` is #1097.
    const { reasons } = repoReadiness({
      repo: declared(),
      node: "runner",
      now,
    });
    expect(reasons[0].action).not.toContain("factory repo doctor");
    expect(reasons[0].action).toContain("factory doctor");
  });
});

describe("repoDispatchPreflight is the gate dispatch consults before claiming", () => {
  test("a repo whose preflight fails is refused, with the failing constraint named", async () => {
    const repo = repoWith(`    toolchain:\n      node: ">=22 <25"\n`);
    const node = fakeNode({ versions: { node: "v18.19.1" } });
    const gate = await repoDispatchPreflight(repo, {
      node: "mac-mini",
      now,
      ...node,
    });
    expect(gate.ready).toBe(false);
    expect(gate.refusal).toBe(
      "repo tc toolchain preflight failed on mac-mini: node >=22 <25 (observed 18.19.1)",
    );
    expect(gate.reasons[0]).toMatchObject({
      reason: REPO_TOOLCHAIN_MISMATCH,
      node: "mac-mini",
      executable: "node",
      constraint: ">=22 <25",
      observed: "18.19.1",
    });
    expect(gate.attestation.ok).toBe(false);
  });

  test("a passing repo is admitted and carries the attestation forward", async () => {
    const repo = repoWith(`    toolchain:\n      bun: ">=1.3 <2"\n`);
    const gate = await repoDispatchPreflight(repo, {
      node: "runner",
      now,
      ...fakeNode({ versions: { bun: "1.3.14" } }),
    });
    expect(gate.ready).toBe(true);
    expect(gate.refusal).toBeNull();
    expect(gate.attestation.toolchainHash).toBe(toolchainHash(repo.toolchain));
  });

  test("a current attestation is reused instead of re-probing the host", async () => {
    const repo = repoWith(`    toolchain:\n      bun: ">=1.3 <2"\n`);
    const attestation = await preflightToolchain(repo, {
      node: "runner",
      now,
      ...fakeNode({ versions: { bun: "1.3.14" } }),
    });
    const node = fakeNode({ versions: { bun: "1.3.14" } });
    const gate = await repoDispatchPreflight(repo, {
      node: "runner",
      attestation,
      now,
      ...node,
    });
    expect(gate.ready).toBe(true);
    expect(node.spawnCalls).toEqual([]);
  });

  test("an undeclared toolchain short-circuits: no probe, no gate, no latency", async () => {
    const node = fakeNode();
    const gate = await repoDispatchPreflight(repoWith(""), {
      node: "runner",
      now,
      ...node,
    });
    expect(gate).toEqual({
      ready: true,
      attested: false,
      reasons: [],
      refusal: null,
      attestation: null,
    });
    expect(node.whichCalls).toEqual([]);
    expect(node.spawnCalls).toEqual([]);
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

describe("resolvePromotionTarget requires an isolated-checkout target (gh-860)", () => {
  const repos = loadRepos({ root: factoryRoot(YAML) });

  test("a fully configured repo yields base, github, and worktree_up", () => {
    const target = resolvePromotionTarget(repos, "full");
    expect(target.base).toBe("develop");
    expect(target.github).toBe("watt-mind/full");
    expect(target.worktreeUp).toBe("bin/worktree-up.sh");
    expect(target.name).toBe("full");
  });

  test("a repo without worktree_up fails closed", () => {
    // `bare` has no worktree_up, github, and only the default base.
    expect(() => resolvePromotionTarget(repos, "bare")).toThrow(
      /no worktree_up script/,
    );
  });

  test("an unknown repo fails closed", () => {
    expect(() => resolvePromotionTarget(repos, "nope")).toThrow(RepoError);
  });

  test("a repo with worktree_up but no github fails closed", () => {
    const root = factoryRoot(
      "repos:\n  - name: a\n    path: /tmp/a\n    base: develop\n    worktree_up: bin/x.sh\n",
    );
    expect(() => resolvePromotionTarget(loadRepos({ root }), "a")).toThrow(
      /no github slug/,
    );
  });
});

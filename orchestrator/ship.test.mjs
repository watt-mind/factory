/**
 * Ship pre-flight and chain (WM-1104), driven entirely by fixtures: a fake
 * forge answering the REST paths the module reads, a fake `git` answering
 * ancestry and path-diff questions, and a fake shell for the SSH probe. No
 * network, no clock, no checkout — the point of the injected effects.
 */
import { describe, test, expect } from "bun:test";
import {
  DEFAULT_PIN_PR,
  ShipChainError,
  ShipConfigError,
  checkRunsGreen,
  checkRuntimeRole,
  classifyJobs,
  formatChain,
  formatPreflight,
  isEscalatedPr,
  isPinPr,
  loadShipConfig,
  normalizeAuthor,
  pinnedCommit,
  preflight,
  releasePrRefusal,
  selectRun,
  shipChain,
  waitFor,
} from "./ship.mjs";

const TIP = "a".repeat(40);
const MOVED_TIP = "e".repeat(40);
const PINNED = "b".repeat(40);
const LAWZ_PIN = "c".repeat(40);
const PIN_PR_HEAD = "d".repeat(40);
const REPO = "watt-mind/legalease";

const REPOS_YAML = {
  repos: [
    {
      name: "legalease",
      path: "~/Develop/legalease",
      github: REPO,
      base: "develop",
      deploy_branch: "master",
      merge_ci: { workflow: "CI" },
      advisory_jobs: ["Runtime Qualification Dispatch Decision"],
      serial_publishers: true,
      ssh_probe: "ssh runner 'test -z ... && echo clean || echo dirty'",
      post_release_checks: ["curl -fsS https://example.test/healthz"],
      runtime_roles: [
        {
          role: "case_agent",
          manifest: "legalease/config/runtime-images.json",
          publisher_workflow: "case-agent-image.yml",
          paths: ["docker/agent/**", ".github/workflows/case-agent-image.yml"],
        },
        {
          role: "research_runner",
          manifest: "legalease/config/runtime-images.json",
          publisher_workflow: "research-runner-image.yml",
          source_repo: "watt-mind/lawz",
        },
      ],
    },
  ],
};

const cfg = () => loadShipConfig("legalease", { config: REPOS_YAML });

/** The same repo with an extra key on one of its entries. */
const cfgWith = (patch, rolePatch = null) =>
  loadShipConfig("legalease", {
    config: {
      repos: [
        {
          ...REPOS_YAML.repos[0],
          ...patch,
          runtime_roles: rolePatch
            ? REPOS_YAML.repos[0].runtime_roles.map((role) =>
                role.role === rolePatch.role ? { ...role, ...rolePatch } : role,
              )
            : REPOS_YAML.repos[0].runtime_roles,
        },
      ],
    },
  });

const job = (name, conclusion, status = "completed") => ({
  name,
  status,
  conclusion,
});

const GREEN_JOBS = [
  job("Django Check", "success"),
  job("Browser E2E Tests", "success"),
  job("Deploy Production (Dokploy)", "skipped"),
  job("Runtime Qualification Dispatch Decision", "failure"), // advisory
];

const CI_RUN = {
  id: 501,
  name: "CI",
  status: "completed",
  conclusion: "success",
  run_number: 7,
};

const GREEN_CHECK_RUNS = [
  { name: "Django Check", status: "completed", conclusion: "success" },
  {
    name: "Deploy Production (Dokploy)",
    status: "completed",
    conclusion: "skipped",
  },
];

const wfKey = (repo, workflow) => `${repo}|${workflow}`;

/**
 * A forge that answers only what ship.mjs asks for. `state` is mutable so the
 * chain's second pre-flight can see the world it changed.
 */
function fakeForge(state = {}) {
  const {
    runs = [CI_RUN],
    jobs = GREEN_JOBS,
    prs = [],
    checkRuns = [],
    // { "<repo>|<workflow>": [run, ...] } — newest first, as GitHub returns.
    workflows = {},
    // Optional per-head-SHA override of `runs`, for the heads that differ from
    // the base tip (a pin PR's branch).
    runsBySha = {},
  } = state;
  const world = { runs, jobs, prs, checkRuns, workflows, runsBySha };
  const calls = [];
  const forge = {
    calls,
    world,
    apiRaw(apiPath) {
      calls.push({ op: "apiRaw", path: apiPath });
      const workflowRuns =
        /^repos\/(.+?)\/actions\/workflows\/([^/?]+)\/runs(?:\?(.*))?$/.exec(
          apiPath,
        );
      if (workflowRuns) {
        const [, repo, workflow, query = ""] = workflowRuns;
        let list =
          world.workflows[wfKey(repo, decodeURIComponent(workflow))] ?? [];
        if (query.includes("status=success"))
          list = list.filter((run) => run.conclusion === "success");
        const perPage = Number(/per_page=(\d+)/.exec(query)?.[1] ?? 30);
        return JSON.stringify({ workflow_runs: list.slice(0, perPage) });
      }
      const headSha = /\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(apiPath);
      if (headSha)
        return JSON.stringify({
          workflow_runs: world.runsBySha[headSha[1]] ?? world.runs,
        });
      if (/\/actions\/runs\/\d+\/jobs/.test(apiPath))
        return JSON.stringify({ jobs: world.jobs });
      if (/\/check-runs/.test(apiPath))
        return JSON.stringify({ check_runs: world.checkRuns });
      throw new Error(`unseeded api path ${apiPath}`);
    },
    prList() {
      calls.push({ op: "prList" });
      return world.prs;
    },
    workflowDispatch(repo, workflow, opts) {
      calls.push({ op: "workflowDispatch", repo, workflow, opts });
      const key = wfKey(repo, workflow);
      world.workflows[key] = [
        {
          id: 900,
          name: workflow,
          status: "in_progress",
          conclusion: null,
          created_at: "2026-09-15T10:00:00Z",
        },
        ...(world.workflows[key] ?? []),
      ];
    },
    prCreate(repo, opts) {
      calls.push({ op: "prCreate", repo, opts });
      world.prs = [
        ...world.prs,
        {
          number: 77,
          title: opts.title,
          baseRefName: opts.base,
          headRefName: opts.head,
          headRefOid: TIP,
          isDraft: false,
          labels: [],
          author: { login: "hdkiller" },
        },
      ];
      return `https://github.com/${repo}/pull/77`;
    },
    prMerge(repo, number, opts) {
      calls.push({ op: "prMerge", repo, number, opts });
      world.prs = world.prs.filter(
        (pr) => Number(pr.number) !== Number(number),
      );
    },
  };
  return forge;
}

/** `git` answering the three questions ship.mjs asks. */
function fakeGit({ ancestor = true, changed = [], tip = TIP } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-parse")
      return {
        status: 0,
        stdout: `${typeof tip === "function" ? tip(calls) : tip}\n`,
        stderr: "",
      };
    if (args[0] === "merge-base")
      return { status: ancestor ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "diff")
      return { status: 0, stdout: changed.join("\n"), stderr: "" };
    return {
      status: 1,
      stdout: "",
      stderr: `unexpected git ${args.join(" ")}`,
    };
  };
  git.calls = calls;
  return git;
}

const MANIFEST = {
  case_agent: { tag: PINNED, provenance: { commit_sha: PINNED } },
  research_runner: { tag: `develop-${LAWZ_PIN}` },
};

function deps(overrides = {}) {
  const notified = [];
  const d = {
    forge: overrides.forge ?? fakeForge(),
    git: overrides.git ?? fakeGit(),
    shell:
      overrides.shell ?? (() => ({ status: 0, stdout: "clean\n", stderr: "" })),
    readManifest: overrides.readManifest ?? (() => MANIFEST),
    now: overrides.now ?? (() => 0),
    sleep: overrides.sleep ?? (async () => {}),
    notify:
      overrides.notify ??
      ((message) => {
        notified.push(message);
        return { status: 0, stdout: "", stderr: "" };
      }),
  };
  d.notified = notified;
  return d;
}

const checkById = (report, id) =>
  report.checks.find((check) => check.id === id) ??
  (() => {
    throw new Error(`no check ${id} in ${report.checks.map((c) => c.id)}`);
  })();

/** A release-ready world: green checks on the tip, no PRs open. */
const releaseForge = (state = {}) =>
  fakeForge({ checkRuns: GREEN_CHECK_RUNS, ...state });

// ------------------------------------------------------------------ config

describe("loadShipConfig", () => {
  test("normalizes the repo entry and expands ~ in the path", () => {
    const config = cfg();
    expect(config.github).toBe(REPO);
    expect(config.base).toBe("develop");
    expect(config.deployBranch).toBe("master");
    expect(config.ciWorkflow).toBe("CI");
    expect(config.serialPublishers).toBe(true);
    expect(config.advisoryJobs).toEqual([
      "Runtime Qualification Dispatch Decision",
    ]);
    expect(config.pinPr).toEqual({
      author: DEFAULT_PIN_PR.author,
      titlePrefix: DEFAULT_PIN_PR.titlePrefix,
    });
    expect(config.runtimeRoles).toHaveLength(2);
    expect(config.runtimeRoles[1].sourceRepo).toBe("watt-mind/lawz");
    expect(config.runtimeRoles[1].foreignRepo).toBeNull();
    expect(config.path.startsWith("~")).toBe(false);
  });

  test("an unknown repo, or a role missing its publisher, is a config error", () => {
    expect(() => loadShipConfig("nope", { config: REPOS_YAML })).toThrow(
      ShipConfigError,
    );
    expect(() =>
      loadShipConfig("x", {
        config: {
          repos: [
            {
              name: "x",
              github: "a/b",
              base: "develop",
              runtime_roles: [{ role: "r", manifest: "m.json" }],
            },
          ],
        },
      }),
    ).toThrow(/publisher_workflow/);
  });

  // Finding 5: a misspelled `path:` used to read as a quiet SKIP on every
  // release, so the check could never fail. Refuse the config instead.
  test("a locally-built role with no paths is refused at load, by name", () => {
    const withoutPaths = () =>
      loadShipConfig("legalease", {
        config: {
          repos: [
            {
              ...REPOS_YAML.repos[0],
              runtime_roles: [
                {
                  role: "case_agent",
                  manifest: "legalease/config/runtime-images.json",
                  publisher_workflow: "case-agent-image.yml",
                  // typo: `path` instead of `paths`
                  path: ["docker/agent/**"],
                },
              ],
            },
          ],
        },
      });
    expect(withoutPaths).toThrow(ShipConfigError);
    expect(withoutPaths).toThrow(/needs a non-empty paths list/);
    expect(withoutPaths).toThrow(/case-agent-image\.yml/);
  });

  test("a foreign role needs no paths, and carries its optional foreign_repo", () => {
    const config = cfgWith(null, {
      role: "research_runner",
      foreign_repo: "watt-mind/lawz",
    });
    expect(config.runtimeRoles[1].paths).toEqual([]);
    expect(config.runtimeRoles[1].foreignRepo).toBe("watt-mind/lawz");
  });
});

// --------------------------------------------------------------- decisions

describe("pure decisions", () => {
  test("normalizeAuthor folds app/ and [bot] spellings together", () => {
    expect(normalizeAuthor("app/watt-mind-factory")).toBe("watt-mind-factory");
    expect(normalizeAuthor({ login: "watt-mind-factory[bot]" })).toBe(
      "watt-mind-factory",
    );
    expect(normalizeAuthor(undefined)).toBe("");
  });

  test("isPinPr needs both the bot author and the title prefix", () => {
    const pr = {
      author: { login: "watt-mind-factory[bot]" },
      title: "chore(runtime): adopt reviewed runtime images",
    };
    expect(isPinPr(pr)).toBe(true);
    expect(isPinPr({ ...pr, title: "fix(x): something" })).toBe(false);
    expect(isPinPr({ ...pr, author: { login: "hdkiller" } })).toBe(false);
    // A bot pin PR onto the deploy branch is not the develop chain's to merge.
    expect(
      isPinPr({ ...pr, baseRefName: "master" }, undefined, "develop"),
    ).toBe(false);
    expect(
      isPinPr({ ...pr, baseRefName: "develop" }, undefined, "develop"),
    ).toBe(true);
  });

  test("isEscalatedPr only counts PRs targeting the base", () => {
    const pr = { baseRefName: "develop", labels: [{ name: "escalated" }] };
    expect(isEscalatedPr(pr, "develop")).toBe(true);
    expect(isEscalatedPr(pr, "master")).toBe(false);
    expect(
      isEscalatedPr({ ...pr, labels: [{ name: "type:bug" }] }, "develop"),
    ).toBe(false);
  });

  // Finding 4: the release PR targets the deploy branch, so isEscalatedPr
  // structurally never looks at it.
  test("releasePrRefusal names why a release PR must not be merged", () => {
    const config = cfg();
    const ok = {
      number: 77,
      headRefName: "develop",
      baseRefName: "master",
      isDraft: false,
      labels: [],
    };
    expect(releasePrRefusal(config, ok)).toBeNull();
    expect(releasePrRefusal(config, { ...ok, isDraft: true })).toMatch(
      /is a draft/,
    );
    expect(
      releasePrRefusal(config, { ...ok, labels: [{ name: "escalated" }] }),
    ).toMatch(/escalated/);
    expect(releasePrRefusal(config, { ...ok, headRefName: "feat/x" })).toMatch(
      /head is feat\/x, not develop/,
    );
    expect(
      releasePrRefusal(config, { ...ok, baseRefName: "release/1" }),
    ).toMatch(/targets release\/1, not master/);
    expect(releasePrRefusal(config, null)).toMatch(/could not be read back/);
  });

  test("selectRun takes the newest attempt of the named workflow, not the newest run", () => {
    const runs = [
      {
        id: 1,
        name: "CI",
        run_number: 9,
        run_attempt: 1,
        conclusion: "failure",
      },
      { id: 2, name: "Security", run_number: 40 },
      {
        id: 3,
        name: "CI",
        run_number: 9,
        run_attempt: 2,
        conclusion: "success",
      },
      { id: 4, name: "CI", run_number: 8, run_attempt: 5 },
    ];
    expect(selectRun(runs, { workflow: "CI" }).id).toBe(3);
    expect(
      selectRun([{ id: 7, path: ".github/workflows/ci.yml" }], {
        workflow: "ci.yml",
      }).id,
    ).toBe(7);
    expect(selectRun(runs, { workflow: "Nope" })).toBeNull();
  });

  test("classifyJobs: skipped is not a failure, advisory is ignored, incomplete blocks", () => {
    const out = classifyJobs(
      [...GREEN_JOBS, job("Slow lane", null, "in_progress")],
      { advisoryJobs: ["Runtime Qualification Dispatch Decision"] },
    );
    expect(out.passed).toEqual(["Django Check", "Browser E2E Tests"]);
    expect(out.skipped).toEqual(["Deploy Production (Dokploy)"]);
    expect(out.advisory).toEqual(["Runtime Qualification Dispatch Decision"]);
    expect(out.failing).toEqual([]);
    expect(out.pending).toEqual(["Slow lane"]);
  });

  test("classifyJobs reports a real failure when it is not advisory", () => {
    const out = classifyJobs([job("Browser E2E Tests", "failure")], {});
    expect(out.failing).toEqual(["Browser E2E Tests (failure)"]);
  });

  test("checkRunsGreen accepts success and skipped, refuses red or pending", () => {
    expect(
      checkRunsGreen([
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "skipped" },
      ]).ok,
    ).toBe(true);
    expect(
      checkRunsGreen([
        { name: "c", status: "completed", conclusion: "failure" },
      ]),
    ).toMatchObject({ ok: false, failing: ["c (failure)"] });
    expect(
      checkRunsGreen([{ name: "d", status: "in_progress" }]),
    ).toMatchObject({ ok: false, pending: ["d"] });
  });

  // Finding 3: [].every(green) is true, so "no checks yet" used to be green.
  test("checkRunsGreen refuses an empty list, and a list that is only skips", () => {
    expect(checkRunsGreen([])).toMatchObject({ ok: false });
    expect(checkRunsGreen([]).missing).toHaveLength(1);
    expect(checkRunsGreen(undefined).ok).toBe(false);
    expect(
      checkRunsGreen([
        { name: "only-skipped", status: "completed", conclusion: "skipped" },
      ]).ok,
    ).toBe(false);
  });

  test("pinnedCommit prefers provenance, then reviewed_commit, then a suffixed tag", () => {
    expect(pinnedCommit({ provenance: { commit_sha: PINNED }, tag: "x" })).toBe(
      PINNED,
    );
    expect(pinnedCommit({ reviewed_commit: PINNED })).toBe(PINNED);
    expect(pinnedCommit({ tag: `develop-${PINNED}` })).toBe(PINNED);
    expect(pinnedCommit({ tag: "latest" })).toBeNull();
    expect(pinnedCommit(undefined)).toBeNull();
  });
});

// --------------------------------------------------------------- preflight

describe("preflight", () => {
  test("all green: every check passes and the report is ok", () => {
    const report = preflight(cfg(), deps());
    expect(report.ok).toBe(true);
    expect(report.tip).toBe(TIP);
    expect(checkById(report, "base-green").status).toBe("pass");
    expect(checkById(report, "runtime-pin:case_agent").status).toBe("pass");
    expect(checkById(report, "publishers-idle").status).toBe("pass");
    expect(checkById(report, "ssh-probe").detail).toBe("clean");
  });

  // Finding 8: a SKIP that prints nothing is indistinguishable from a check
  // that never ran.
  test("a foreign-source role is skipped, but names the pinned commit and its source", () => {
    const check = checkById(
      preflight(cfg(), deps()),
      "runtime-pin:research_runner",
    );
    expect(check.status).toBe("skip");
    expect(check.detail).toContain(`pinned ${LAWZ_PIN.slice(0, 8)}`);
    expect(check.detail).toContain("source watt-mind/lawz");
  });

  test("a foreign role with foreign_repo WARNs when the pin is behind that repo's publisher", () => {
    const config = cfgWith(null, {
      role: "research_runner",
      foreign_repo: "watt-mind/lawz",
    });
    const forge = fakeForge({
      workflows: {
        [wfKey("watt-mind/lawz", "research-runner-image.yml")]: [
          { id: 3100, conclusion: "success", head_sha: "f".repeat(40) },
        ],
      },
    });
    const report = preflight(config, deps({ forge }));
    const check = checkById(report, "runtime-pin:research_runner");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("ffffffff");
    expect(check.detail).toContain("the pin is behind it");
    expect(check.next).toContain("gh run list -R watt-mind/lawz");
    // A WARN is not a FAIL: it must not block the release on its own.
    expect(report.ok).toBe(true);
    expect(formatPreflight(report)).toContain("WARN");
  });

  test("a foreign role whose pin matches that repo's newest publisher run stays a SKIP", () => {
    const config = cfgWith(null, {
      role: "research_runner",
      foreign_repo: "watt-mind/lawz",
    });
    const forge = fakeForge({
      workflows: {
        [wfKey("watt-mind/lawz", "research-runner-image.yml")]: [
          { id: 3100, conclusion: "success", head_sha: LAWZ_PIN },
        ],
      },
    });
    const check = checkById(
      preflight(config, deps({ forge })),
      "runtime-pin:research_runner",
    );
    expect(check.status).toBe("skip");
    expect(check.detail).toContain("matches watt-mind/lawz");
  });

  test("pin stale: a publisher path changed since the pinned commit", () => {
    const report = preflight(
      cfg(),
      deps({ git: fakeGit({ changed: ["docker/agent/Dockerfile"] }) }),
    );
    const check = checkById(report, "runtime-pin:case_agent");
    expect(report.ok).toBe(false);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("docker/agent/Dockerfile");
    expect(check.next).toBe(
      `gh workflow run case-agent-image.yml --repo ${REPO} --ref develop -f commit_sha=${TIP}`,
    );
  });

  test("pin off-branch: the pinned commit is not an ancestor of the tip", () => {
    const check = checkById(
      preflight(cfg(), deps({ git: fakeGit({ ancestor: false }) })),
      "runtime-pin:case_agent",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not an ancestor");
  });

  // Finding 5, defence in depth: loadShipConfig refuses this shape, but a
  // hand-built config must still FAIL rather than SKIP.
  test("a locally-built role with no paths is a FAIL, never a SKIP", () => {
    const role = {
      role: "case_agent",
      manifest: "legalease/config/runtime-images.json",
      publisherWorkflow: "case-agent-image.yml",
      paths: [],
      sourceRepo: null,
      foreignRepo: null,
    };
    const check = checkRuntimeRole(cfg(), TIP, role, deps());
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("staleness cannot be proven");
  });

  test("base red: a blocking job failure names the job and the log command", () => {
    const forge = fakeForge({ jobs: [job("Browser E2E Tests", "failure")] });
    const check = checkById(preflight(cfg(), deps({ forge })), "base-green");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Browser E2E Tests (failure)");
    expect(check.next).toContain("--log-failed");
  });

  // Finding 2: the run's own conclusion was never read, so a run that GitHub
  // had already called red could pass on its job list.
  test("base red by conclusion: a failed run is a FAIL even when its jobs read green", () => {
    const forge = fakeForge({
      runs: [{ ...CI_RUN, conclusion: "failure" }],
      jobs: GREEN_JOBS,
    });
    const check = checkById(preflight(cfg(), deps({ forge })), "base-green");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("concluded failure");
  });

  // Finding 2: the org's documented zero-job red run — a startup_failure from
  // a bad workflow file produces a completed run with no jobs at all.
  test("base zero-job: a startup_failure run with no jobs is a FAIL, not a green tip", () => {
    const startup = fakeForge({
      runs: [{ ...CI_RUN, conclusion: "startup_failure" }],
      jobs: [],
    });
    expect(
      checkById(preflight(cfg(), deps({ forge: startup })), "base-green"),
    ).toMatchObject({ status: "fail" });

    // Even a run GitHub calls `success` with zero non-advisory jobs is not a
    // tip anything verified.
    const empty = fakeForge({ runs: [CI_RUN], jobs: [] });
    const check = checkById(
      preflight(cfg(), deps({ forge: empty })),
      "base-green",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("no non-advisory job succeeded");
  });

  test("base superseded: the newest attempt decides, so an older red run is ignored", () => {
    const forge = fakeForge({
      runs: [
        {
          id: 1,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          run_number: 9,
          run_attempt: 1,
        },
        {
          id: 2,
          name: "CI",
          status: "completed",
          conclusion: "success",
          run_number: 9,
          run_attempt: 2,
        },
      ],
    });
    expect(
      checkById(preflight(cfg(), deps({ forge })), "base-green").detail,
    ).toContain("run 2");
  });

  test("base never built: no run for the exact SHA is a failure, not a pass", () => {
    const forge = fakeForge({ runs: [] });
    expect(
      checkById(preflight(cfg(), deps({ forge })), "base-green"),
    ).toMatchObject({
      status: "fail",
    });
  });

  test("publisher running: an in-progress publisher blocks with its run id", () => {
    const forge = fakeForge({
      workflows: {
        [wfKey(REPO, "case-agent-image.yml")]: [
          {
            id: 900,
            name: "Publish Case Agent Image",
            status: "in_progress",
          },
        ],
      },
    });
    const check = checkById(
      preflight(cfg(), deps({ forge })),
      "publishers-idle",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("900");
  });

  // Finding 6: filtering the repo-wide run list by in_progress + queued missed
  // every other non-terminal status GitHub uses.
  test.each(["waiting", "requested", "pending"])(
    "a publisher run in %s status is not idle",
    (status) => {
      const forge = fakeForge({
        workflows: {
          [wfKey(REPO, "research-runner-image.yml")]: [
            { id: 901, name: "Publish Research Runner", status },
          ],
        },
      });
      const check = checkById(
        preflight(cfg(), deps({ forge })),
        "publishers-idle",
      );
      expect(check.status).toBe("fail");
      expect(check.detail).toContain(status);
    },
  );

  test("a completed publisher run leaves the publishers idle", () => {
    const forge = fakeForge({
      workflows: {
        [wfKey(REPO, "case-agent-image.yml")]: [
          { id: 900, name: "x", status: "completed", conclusion: "success" },
        ],
      },
    });
    expect(
      checkById(preflight(cfg(), deps({ forge })), "publishers-idle").status,
    ).toBe("pass");
  });

  test("bot pin PR open: blocked, with the merge command", () => {
    const forge = fakeForge({
      prs: [
        {
          number: 42,
          title: "chore(runtime): adopt reviewed runtime images",
          author: { login: "watt-mind-factory[bot]" },
          labels: [],
          baseRefName: "develop",
        },
      ],
    });
    const check = checkById(preflight(cfg(), deps({ forge })), "pin-pr");
    expect(check.status).toBe("fail");
    expect(check.next).toContain("gh pr merge 42");
  });

  test("escalated PR targeting base: blocked and handed back to a human", () => {
    const forge = fakeForge({
      prs: [
        {
          number: 43,
          title: "feat: risky",
          author: { login: "hdkiller" },
          labels: [{ name: "escalated" }],
          baseRefName: "develop",
        },
      ],
    });
    const check = checkById(preflight(cfg(), deps({ forge })), "escalated-pr");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("#43");
  });

  test("ssh probe dirty: a foreign publisher transaction blocks the release", () => {
    const check = checkById(
      preflight(
        cfg(),
        deps({ shell: () => ({ status: 0, stdout: "dirty\n", stderr: "" }) }),
      ),
      "ssh-probe",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("dirty");
  });

  test("ssh probe unconfigured is a SKIP, never a silent pass", () => {
    const bare = loadShipConfig("legalease", {
      config: {
        repos: [{ ...REPOS_YAML.repos[0], ssh_probe: null, runtime_roles: [] }],
      },
    });
    const report = preflight(bare, deps());
    expect(checkById(report, "ssh-probe").status).toBe("skip");
    expect(report.ok).toBe(true);
  });

  test("an unreachable forge fails the check instead of throwing", () => {
    const forge = fakeForge();
    forge.prList = () => {
      throw new Error("gh pr list failed (status 1)");
    };
    const report = preflight(cfg(), deps({ forge }));
    expect(report.ok).toBe(false);
    expect(checkById(report, "pin-pr").detail).toContain(
      "could not list open PRs",
    );
  });

  test("formatPreflight prints one line per check and the next command on failure", () => {
    const out = formatPreflight(
      preflight(cfg(), deps({ git: fakeGit({ changed: ["docker/agent/x"] }) })),
    );
    expect(out).toContain("FAIL");
    expect(out).toContain("next: gh workflow run case-agent-image.yml");
    expect(out).toContain("Do not open the release PR");
  });
});

// ------------------------------------------------------------------- chain

describe("waitFor", () => {
  test("returns as soon as the condition holds", async () => {
    let calls = 0;
    const hit = await waitFor(() => (++calls === 3 ? "ready" : null), {
      label: "x",
      now: () => 0,
      sleep: async () => {},
      intervalMs: 1,
    });
    expect(hit).toBe("ready");
    expect(calls).toBe(3);
  });

  test("gives up loudly rather than polling forever", async () => {
    let clock = 0;
    await expect(
      waitFor(() => null, {
        label: "never",
        now: () => (clock += 60_000),
        sleep: async () => {},
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("shipChain", () => {
  test("dry run plans the dispatch and makes no mutating call", async () => {
    const forge = fakeForge();
    const result = await shipChain(
      cfg(),
      { until: "pin" },
      deps({ forge, git: fakeGit({ changed: ["docker/agent/x"] }) }),
    );
    expect(result.plan).toEqual([
      {
        action: "dispatch-publisher",
        detail: `case-agent-image.yml --ref develop -f commit_sha=${TIP}`,
        applied: false,
      },
    ]);
    expect(forge.calls.some((call) => call.op === "workflowDispatch")).toBe(
      false,
    );
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("dry run of a release plans the PR and the post-release checks", async () => {
    const result = await shipChain(cfg(), { until: "release" }, deps());
    expect(result.plan.map((step) => step.action)).toEqual([
      "open-release-pr",
      "merge-release-pr",
      "post-release-check",
    ]);
    expect(result.plan.every((step) => step.applied === false)).toBe(true);
  });

  test("apply dispatches one publisher, waits for its run, merges the pin PR, re-checks", async () => {
    const forge = fakeForge();
    let dispatched = false;
    forge.workflowDispatch = (repo, workflow, opts) => {
      forge.calls.push({ op: "workflowDispatch", repo, workflow, opts });
      dispatched = true;
      // The publisher run appears, finishes green, and reconcile opens the
      // pin PR.
      forge.world.workflows[wfKey(repo, workflow)] = [
        {
          id: 900,
          name: workflow,
          status: "completed",
          conclusion: "success",
          created_at: "2026-09-15T10:00:00Z",
        },
      ];
      forge.world.prs = [
        {
          number: 42,
          title: "chore(runtime): adopt reviewed runtime images",
          author: { login: "watt-mind-factory[bot]" },
          labels: [],
          isDraft: false,
          baseRefName: "develop",
          headRefOid: PIN_PR_HEAD,
        },
      ];
      forge.world.checkRuns = GREEN_CHECK_RUNS;
    };
    // Stale until the publisher runs, fresh afterwards.
    const git = (args) => {
      if (args[0] === "diff")
        return {
          status: 0,
          stdout: dispatched ? "" : "docker/agent/x",
          stderr: "",
        };
      return fakeGit()(args);
    };

    const result = await shipChain(
      cfg(),
      { until: "pin", apply: true },
      deps({ forge, git }),
    );
    const ops = forge.calls.filter((call) =>
      ["workflowDispatch", "prMerge"].includes(call.op),
    );
    expect(ops.map((call) => call.op)).toEqual(["workflowDispatch", "prMerge"]);
    expect(ops[0].opts.inputs).toEqual({ commit_sha: TIP });
    // Finding 1: the pin-PR merge is pinned to the head whose checks were read.
    expect(ops[1].opts).toEqual({
      method: "merge",
      matchHeadCommit: PIN_PR_HEAD,
    });
    expect(result.plan.map((step) => step.action)).toContain(
      "publisher-succeeded",
    );
    expect(result.ok).toBe(true);
  });

  // Finding 7: the old wait was "no active run of this workflow", which the
  // world satisfies *before* the dispatched run starts.
  test("a publisher whose run never appears times out on the dispatch, not on the pin PR", async () => {
    const forge = fakeForge();
    forge.workflowDispatch = (repo, workflow, opts) => {
      forge.calls.push({ op: "workflowDispatch", repo, workflow, opts });
      // Nothing appears: GitHub accepted the request and dropped it.
    };
    let clock = 0;
    await expect(
      shipChain(
        cfg(),
        { until: "pin", apply: true, waitOpts: { appearTimeoutMs: 60_000 } },
        deps({
          forge,
          git: fakeGit({ changed: ["docker/agent/x"] }),
          now: () => (clock += 60_000),
        }),
      ),
    ).rejects.toThrow(/timed out.*dispatched case-agent-image\.yml run/s);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  // Finding 7: the publisher's conclusion was never read at all.
  test("a failed publisher run stops the chain by name instead of waiting for a pin PR", async () => {
    const forge = fakeForge();
    forge.workflowDispatch = (repo, workflow, opts) => {
      forge.calls.push({ op: "workflowDispatch", repo, workflow, opts });
      forge.world.workflows[wfKey(repo, workflow)] = [
        {
          id: 907,
          name: workflow,
          status: "completed",
          conclusion: "failure",
          created_at: "2026-09-15T10:00:00Z",
        },
      ];
    };
    await expect(
      shipChain(
        cfg(),
        { until: "pin", apply: true },
        deps({ forge, git: fakeGit({ changed: ["docker/agent/x"] }) }),
      ),
    ).rejects.toThrow(
      /publisher case-agent-image\.yml run 907 concluded failure/,
    );
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  test("a publisher still in progress is waited on before the pin PR is looked for", async () => {
    const forge = fakeForge();
    let polls = 0;
    forge.workflowDispatch = (repo, workflow, opts) => {
      forge.calls.push({ op: "workflowDispatch", repo, workflow, opts });
      forge.world.workflows[wfKey(repo, workflow)] = [
        {
          id: 908,
          name: workflow,
          status: "in_progress",
          conclusion: null,
          created_at: "2026-09-15T10:00:00Z",
        },
      ];
    };
    const forgeApi = forge.apiRaw;
    forge.apiRaw = (apiPath) => {
      if (/actions\/workflows\/case-agent-image\.yml\/runs/.test(apiPath)) {
        // Green only on the fourth read, so at least one poll of the
        // finish-wait genuinely observes `in_progress`.
        if (++polls >= 4)
          forge.world.workflows[wfKey(REPO, "case-agent-image.yml")] = [
            {
              id: 908,
              name: "case-agent-image.yml",
              status: "completed",
              conclusion: "success",
              created_at: "2026-09-15T10:00:00Z",
            },
          ];
      }
      return forgeApi(apiPath);
    };
    let dispatched = false;
    const git = (args) => {
      if (args[0] === "diff")
        return {
          status: 0,
          stdout: dispatched ? "" : "docker/agent/x",
          stderr: "",
        };
      return fakeGit()(args);
    };
    forge.world.prs = [];
    const d = deps({ forge, git });
    const originalDispatch = forge.workflowDispatch;
    forge.workflowDispatch = (repo, workflow, opts) => {
      originalDispatch(repo, workflow, opts);
      dispatched = true;
      forge.world.prs = [
        {
          number: 42,
          title: "chore(runtime): adopt reviewed runtime images",
          author: { login: "watt-mind-factory[bot]" },
          labels: [],
          isDraft: false,
          baseRefName: "develop",
          headRefOid: PIN_PR_HEAD,
        },
      ];
      forge.world.checkRuns = GREEN_CHECK_RUNS;
    };
    const result = await shipChain(cfg(), { until: "pin", apply: true }, d);
    expect(polls).toBeGreaterThanOrEqual(4);
    expect(result.ok).toBe(true);
  });

  test("a red check run refuses the merge instead of merging on a watched exit", async () => {
    const forge = fakeForge({
      prs: [
        {
          number: 42,
          title: "chore(runtime): adopt reviewed runtime images",
          author: { login: "watt-mind-factory[bot]" },
          labels: [],
          isDraft: false,
          baseRefName: "develop",
          headRefOid: PIN_PR_HEAD,
        },
      ],
      checkRuns: [
        { name: "CI", status: "completed", conclusion: "success" },
        {
          name: "Browser E2E Tests",
          status: "completed",
          conclusion: "failure",
        },
      ],
    });
    forge.workflowDispatch = (repo, workflow, opts) => {
      forge.calls.push({ op: "workflowDispatch", repo, workflow, opts });
    };
    await expect(
      shipChain(
        cfg(),
        { until: "pin", apply: true },
        deps({ forge, git: fakeGit({ changed: ["docker/agent/x"] }) }),
      ),
    ).rejects.toThrow(/red check runs: Browser E2E Tests/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  // Finding 3, the other half: "every check run is green" is only as strong as
  // the set of check runs that exists, so the CI workflow itself must have run
  // for that head. Check-run *names* are job names, so the evidence comes from
  // the Actions runs API for the same commit.
  test("green check runs on a head the CI workflow never ran for are refused", async () => {
    const forge = fakeForge({
      checkRuns: GREEN_CHECK_RUNS,
      // The base tip is green; the pin PR's own head has no CI run at all.
      runsBySha: { [PIN_PR_HEAD]: [] },
      prs: [
        {
          number: 42,
          title: "chore(runtime): adopt reviewed runtime images",
          author: { login: "watt-mind-factory[bot]" },
          labels: [],
          isDraft: false,
          baseRefName: "develop",
          headRefOid: PIN_PR_HEAD,
        },
      ],
    });
    await expect(
      shipChain(
        cfg(),
        { until: "pin", apply: true },
        deps({ forge, git: fakeGit({ changed: ["docker/agent/x"] }) }),
      ),
    ).rejects.toThrow(/no successful CI run for head dddddddd/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  test("a non-pin failure (red base) stops the chain with the next command", async () => {
    const forge = fakeForge({ jobs: [job("Django Check", "failure")] });
    await expect(
      shipChain(cfg(), { until: "pin", apply: true }, deps({ forge })),
    ).rejects.toThrow(ShipChainError);
  });

  test("--until preflight never plans anything", async () => {
    const result = await shipChain(
      cfg(),
      { until: "preflight" },
      deps({ git: fakeGit({ changed: ["docker/agent/x"] }) }),
    );
    expect(result.plan).toEqual([]);
    expect(result.ok).toBe(false);
  });

  test("an unknown --until, or a release without a deploy branch, is a config error", async () => {
    await expect(shipChain(cfg(), { until: "yolo" }, deps())).rejects.toThrow(
      ShipConfigError,
    );
    const noDeploy = loadShipConfig("legalease", {
      config: {
        repos: [{ ...REPOS_YAML.repos[0], deploy_branch: null }],
      },
    });
    await expect(
      shipChain(noDeploy, { until: "release" }, deps()),
    ).rejects.toThrow(/deploy_branch/);
  });
});

// ------------------------------------------------------- the release, applied

describe("shipChain --until release --apply", () => {
  test("happy path: opens the PR, re-runs pre-flight, merges on the verified head, runs the checks", async () => {
    const forge = releaseForge();
    const d = deps({ forge });
    const result = await shipChain(cfg(), { until: "release", apply: true }, d);
    expect(result.ok).toBe(true);
    expect(forge.calls.filter((call) => call.op === "prCreate")).toHaveLength(
      1,
    );
    const merge = forge.calls.find((call) => call.op === "prMerge");
    // Finding 1: never squash, and never merge a head GitHub has moved since.
    expect(merge.opts).toEqual({ method: "merge", matchHeadCommit: TIP });
    expect(result.plan.map((step) => step.action)).toEqual([
      "open-release-pr",
      "merge-release-pr",
      "post-release-check",
    ]);
    expect(result.postRelease).toEqual([
      {
        command: "curl -fsS https://example.test/healthz",
        ok: true,
        output: "clean",
      },
    ]);
    expect(d.notified).toEqual([]);
  });

  // Finding 1: everything above the merge was decided against a pre-flight
  // that is minutes old by the time the merge happens.
  test("TOCTOU: a tip that moved between the plan and the merge is refused", async () => {
    const forge = releaseForge();
    let reads = 0;
    // The first pre-flight sees TIP; the one taken just before the merge sees
    // a base that someone pushed to in the meantime.
    const git = fakeGit({ tip: () => (++reads <= 1 ? TIP : MOVED_TIP) });
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge, git })),
    ).rejects.toThrow(/is not the pre-flighted tip/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  test("an escalated label applied while the check runs are waited on refuses the release merge", async () => {
    const forge = releaseForge();
    const originalList = forge.prList;
    let lists = 0;
    forge.prList = (...args) => {
      lists += 1;
      const prs = originalList(...args);
      // The re-read inside mergeWhenGreen sees the operator's abort switch.
      return lists >= 4
        ? prs.map((pr) =>
            Number(pr.number) === 77
              ? { ...pr, labels: [...(pr.labels ?? []), { name: "escalated" }] }
              : pr,
          )
        : prs;
    };
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(
      /refusing to merge the release PR: #77 is labelled escalated/,
    );
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  test("a draft flip during the wait refuses the release merge", async () => {
    const forge = releaseForge();
    const originalList = forge.prList;
    let lists = 0;
    forge.prList = (...args) => {
      lists += 1;
      const prs = originalList(...args);
      return lists >= 4
        ? prs.map((pr) =>
            Number(pr.number) === 77 ? { ...pr, isDraft: true } : pr,
          )
        : prs;
    };
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(/is a draft/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  test("TOCTOU: a head that moves while the check runs are waited on is refused", async () => {
    const forge = releaseForge();
    const originalList = forge.prList;
    let lists = 0;
    forge.prList = (...args) => {
      lists += 1;
      const prs = originalList(...args);
      // The re-read inside mergeWhenGreen sees a branch that moved under it.
      return lists >= 4
        ? prs.map((pr) =>
            Number(pr.number) === 77 ? { ...pr, headRefOid: MOVED_TIP } : pr,
          )
        : prs;
    };
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(/head moved from/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  // Finding 1: pre-flight can go red between the plan and the merge too.
  test("a base that goes red between the plan and the merge stops the chain", async () => {
    const forge = releaseForge();
    const originalCreate = forge.prCreate;
    forge.prCreate = (...args) => {
      const url = originalCreate(...args);
      forge.world.jobs = [job("Django Check", "failure")];
      return url;
    };
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(/pre-flight went red between the plan and the release/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  // Finding 4: checkNoEscalatedPr only looks at PRs targeting the base.
  test("an escalated release PR is refused, not merged", async () => {
    const forge = releaseForge({
      prs: [
        {
          number: 77,
          title: "release: develop → master",
          author: { login: "hdkiller" },
          labels: [{ name: "escalated" }],
          isDraft: false,
          baseRefName: "master",
          headRefName: "develop",
          headRefOid: TIP,
        },
      ],
    });
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(
      /refusing to merge the release PR: #77 is labelled escalated/,
    );
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  test("a draft release PR is refused, not merged", async () => {
    const forge = releaseForge({
      prs: [
        {
          number: 77,
          title: "release: develop → master",
          author: { login: "hdkiller" },
          labels: [],
          isDraft: true,
          baseRefName: "master",
          headRefName: "develop",
          headRefOid: TIP,
        },
      ],
    });
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(/is a draft/);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  // Finding 3: an empty check-run list used to satisfy the merge gate at once.
  test("empty check runs never satisfy the merge gate", async () => {
    const forge = releaseForge({ checkRuns: [] });
    let clock = 0;
    await expect(
      shipChain(
        cfg(),
        { until: "release", apply: true, waitOpts: { timeoutMs: 60_000 } },
        deps({ forge, now: () => (clock += 60_000) }),
      ),
    ).rejects.toThrow(/timed out.*check runs on #77/s);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(false);
  });

  // Finding 2, through the chain: a zero-job base run must stop the release.
  test("a zero-job base run fails pre-flight and never reaches the release PR", async () => {
    const forge = releaseForge({
      runs: [{ ...CI_RUN, conclusion: "startup_failure" }],
      jobs: [],
    });
    await expect(
      shipChain(cfg(), { until: "release", apply: true }, deps({ forge })),
    ).rejects.toThrow(/concluded startup_failure/);
    expect(forge.calls.some((call) => call.op === "prCreate")).toBe(false);
  });

  // Finding 10: the release is already merged, so this is an outage.
  test("a red post-release check exits non-zero, says the release is merged, and notifies", async () => {
    const forge = releaseForge();
    const d = deps({
      forge,
      shell: (command) =>
        command.startsWith("curl")
          ? { status: 22, stdout: "", stderr: "curl: (22) 503" }
          : { status: 0, stdout: "clean\n", stderr: "" },
    });
    const result = await shipChain(cfg(), { until: "release", apply: true }, d);
    expect(result.ok).toBe(false);
    expect(forge.calls.some((call) => call.op === "prMerge")).toBe(true);
    expect(d.notified).toEqual([
      `SMOKE RED legalease: curl -fsS https://example.test/healthz failed after release ${TIP}`,
    ]);
    const out = formatChain(result, { apply: true });
    expect(out).toContain(
      "POST-RELEASE CHECK FAILED: curl -fsS https://example.test/healthz",
    );
    expect(out).toContain("the release is merged");
    expect(out).toContain("RELEASE MERGED, 1 POST-RELEASE CHECK(S) RED");
  });
});

// Finding 9: step 6 of /factory-ship had no command to run.
describe("shipChain --until post-release", () => {
  test("runs only the post-release checks — no pre-flight, no PR, no merge", async () => {
    const forge = releaseForge();
    const d = deps({ forge });
    const result = await shipChain(cfg(), { until: "post-release" }, d);
    expect(result.ok).toBe(true);
    expect(result.report).toBeNull();
    expect(result.repo).toBe("legalease");
    expect(result.plan.map((step) => step.action)).toEqual([
      "post-release-check",
    ]);
    expect(result.plan[0].applied).toBe(true);
    expect(
      forge.calls.some((call) =>
        ["prCreate", "prMerge", "workflowDispatch"].includes(call.op),
      ),
    ).toBe(false);
    expect(formatChain(result, { apply: false })).toContain(
      "ship chain: legalease",
    );
  });

  test("a red check exits non-zero, and notifies only under --apply", async () => {
    const red = () => ({ status: 1, stdout: "", stderr: "503" });
    const quiet = deps({ forge: releaseForge(), shell: red });
    const quietResult = await shipChain(
      cfg(),
      { until: "post-release" },
      quiet,
    );
    expect(quietResult.ok).toBe(false);
    expect(quiet.notified).toEqual([]);

    const loud = deps({ forge: releaseForge(), shell: red });
    const loudResult = await shipChain(
      cfg(),
      { until: "post-release", apply: true },
      loud,
    );
    expect(loudResult.ok).toBe(false);
    expect(loud.notified[0]).toContain("SMOKE RED legalease:");
  });

  test("a repo with no post_release_checks says so instead of reporting success", async () => {
    const bare = loadShipConfig("legalease", {
      config: {
        repos: [{ ...REPOS_YAML.repos[0], post_release_checks: [] }],
      },
    });
    await expect(
      shipChain(bare, { until: "post-release" }, deps()),
    ).rejects.toThrow(/no post_release_checks/);
  });
});

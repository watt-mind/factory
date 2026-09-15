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
  classifyJobs,
  formatPreflight,
  isEscalatedPr,
  isPinPr,
  loadShipConfig,
  normalizeAuthor,
  pinnedCommit,
  preflight,
  selectRun,
  shipChain,
  waitFor,
} from "./ship.mjs";

const TIP = "a".repeat(40);
const PINNED = "b".repeat(40);
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

/**
 * A forge that answers only what ship.mjs asks for. `state` is mutable so the
 * chain's second pre-flight can see the world it changed.
 */
function fakeForge(state = {}) {
  const {
    runs = [{ id: 501, name: "CI", status: "completed", run_number: 7 }],
    jobs = GREEN_JOBS,
    active = [],
    prs = [],
    checkRuns = [],
  } = state;
  const world = { runs, jobs, active, prs, checkRuns };
  const calls = [];
  const forge = {
    calls,
    world,
    apiRaw(apiPath) {
      calls.push({ op: "apiRaw", path: apiPath });
      if (/\/actions\/runs\?head_sha=/.test(apiPath))
        return JSON.stringify({ workflow_runs: world.runs });
      if (/\/actions\/runs\?status=in_progress/.test(apiPath))
        return JSON.stringify({ workflow_runs: world.active });
      if (/\/actions\/runs\?status=queued/.test(apiPath))
        return JSON.stringify({ workflow_runs: [] });
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
      world.active = [
        {
          id: 900,
          name: workflow,
          status: "in_progress",
          path: `.github/workflows/${workflow}`,
        },
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
      return { status: 0, stdout: `${tip}\n`, stderr: "" };
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
  research_runner: { tag: `develop-${"c".repeat(40)}` },
};

function deps(overrides = {}) {
  return {
    forge: overrides.forge ?? fakeForge(),
    git: overrides.git ?? fakeGit(),
    shell:
      overrides.shell ?? (() => ({ status: 0, stdout: "clean\n", stderr: "" })),
    readManifest: overrides.readManifest ?? (() => MANIFEST),
    now: overrides.now ?? (() => 0),
    sleep: overrides.sleep ?? (async () => {}),
  };
}

const checkById = (report, id) =>
  report.checks.find((check) => check.id === id) ??
  (() => {
    throw new Error(`no check ${id} in ${report.checks.map((c) => c.id)}`);
  })();

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
  });

  test("isEscalatedPr only counts PRs targeting the base", () => {
    const pr = { baseRefName: "develop", labels: [{ name: "escalated" }] };
    expect(isEscalatedPr(pr, "develop")).toBe(true);
    expect(isEscalatedPr(pr, "master")).toBe(false);
    expect(
      isEscalatedPr({ ...pr, labels: [{ name: "type:bug" }] }, "develop"),
    ).toBe(false);
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

  test("a foreign-source role is skipped with the reason, not answered", () => {
    const check = checkById(
      preflight(cfg(), deps()),
      "runtime-pin:research_runner",
    );
    expect(check.status).toBe("skip");
    expect(check.detail).toContain("watt-mind/lawz");
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

  test("base red: a blocking job failure names the job and the log command", () => {
    const forge = fakeForge({ jobs: [job("Browser E2E Tests", "failure")] });
    const check = checkById(preflight(cfg(), deps({ forge })), "base-green");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Browser E2E Tests (failure)");
    expect(check.next).toContain("--log-failed");
  });

  test("base superseded: the newest attempt decides, so an older red run is ignored", () => {
    const forge = fakeForge({
      runs: [
        {
          id: 1,
          name: "CI",
          status: "completed",
          run_number: 9,
          run_attempt: 1,
        },
        {
          id: 2,
          name: "CI",
          status: "completed",
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
      active: [
        {
          id: 900,
          name: "Publish Case Agent Image",
          status: "in_progress",
          path: ".github/workflows/case-agent-image.yml",
        },
      ],
    });
    const check = checkById(
      preflight(cfg(), deps({ forge })),
      "publishers-idle",
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("900");
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

  test("apply dispatches one publisher, waits, merges the pin PR, re-checks", async () => {
    const forge = fakeForge();
    let dispatched = false;
    forge.workflowDispatch = (repo, workflow, opts) => {
      forge.calls.push({ op: "workflowDispatch", repo, workflow, opts });
      dispatched = true;
      // The publisher finishes, and reconcile opens the pin PR.
      forge.world.active = [];
      forge.world.prs = [
        {
          number: 42,
          title: "chore(runtime): adopt reviewed runtime images",
          author: { login: "watt-mind-factory[bot]" },
          labels: [],
          baseRefName: "develop",
          headRefOid: "d".repeat(40),
        },
      ];
      forge.world.checkRuns = [
        { name: "CI", status: "completed", conclusion: "success" },
      ];
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
    expect(ops[1].opts).toEqual({ method: "merge" });
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
          baseRefName: "develop",
          headRefOid: "d".repeat(40),
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
      forge.world.active = [];
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

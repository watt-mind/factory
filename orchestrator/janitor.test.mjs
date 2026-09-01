/**
 * bun test orchestrator/janitor.test.mjs
 *
 * WM-17. On legalease, PR #261 was auto-closed by GitHub when a merge run
 * deleted `feat/CLNT-520` during PR #253's post-merge cleanup: a second agent
 * was still shipping from that branch, and its work survived only as a dangling
 * commit. The branch looked disposable to every guard the janitor had, because
 * the work was committed AND pushed — the uncommitted/unpushed refusal in
 * worktree-down.sh cannot see an open PR.
 *
 * These pin the opposite of WM-16. WM-16 is cleanup that gets skipped (stale
 * worktrees accumulate); this is cleanup that runs too eagerly (it removes what
 * someone is still using). A fix for either that ignores the other swings the
 * failure back the other way, so the holds below are deliberate keeps, not
 * misses: they release themselves as soon as the holding PR closes.
 */
import { test, expect, describe } from "bun:test";
import {
  parseWorktreeBranches,
  openPrHold,
  listOpenPrs,
  ticketBranches,
  reclaim,
  survey,
} from "./janitor.mjs";

/** A spawnSync stand-in that records every call and never touches the disk. */
function recorder(handler = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(cmd, args, opts);
  };
  run.calls = calls;
  return run;
}

describe("parseWorktreeBranches", () => {
  test("maps each worktree path to its checked-out branch", () => {
    const porcelain = [
      "worktree /Users/x/Develop/legalease",
      "HEAD aaaa",
      "branch refs/heads/develop",
      "",
      "worktree /Users/x/Develop/.worktrees/legalease/CLNT-520",
      "HEAD bbbb",
      "branch refs/heads/feat/CLNT-520",
      "",
    ].join("\n");
    expect(parseWorktreeBranches(porcelain)).toEqual({
      "/Users/x/Develop/legalease": "develop",
      "/Users/x/Develop/.worktrees/legalease/CLNT-520": "feat/CLNT-520",
    });
  });

  test("a detached worktree has no branch and simply does not appear", () => {
    const porcelain = [
      "worktree /Users/x/wt/CLNT-1",
      "HEAD cccc",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeBranches(porcelain)).toEqual({});
  });

  test("empty or garbage input yields no branches rather than throwing", () => {
    expect(parseWorktreeBranches("")).toEqual({});
    expect(parseWorktreeBranches(null)).toEqual({});
  });
});

describe("openPrHold", () => {
  const openPrs = [
    { number: 261, headRefName: "feat/CLNT-520" },
    { number: 262, headRefName: "fix/CLNT-777-other" },
  ];

  test("a branch that is still an open PR's head is held, naming the PR", () => {
    const hold = openPrHold("feat/CLNT-520", openPrs);
    expect(hold).toContain("#261");
    expect(hold).toContain("feat/CLNT-520");
  });

  test("a branch no open PR points at is free", () => {
    expect(openPrHold("feat/CLNT-999", openPrs)).toBeNull();
  });

  test("a merged PR's branch is free — `gh pr list --state open` no longer lists it", () => {
    // PR #253 (merged) had head feat/CLNT-520 too; what holds the branch is
    // #261 still being open, not #253 having existed.
    expect(openPrHold("feat/CLNT-520", [])).toBeNull();
  });

  test("several open PRs on one branch are all named", () => {
    const hold = openPrHold("feat/CLNT-520", [
      ...openPrs,
      { number: 264, headRefName: "feat/CLNT-520" },
    ]);
    expect(hold).toContain("#261");
    expect(hold).toContain("#264");
  });

  test("an unknown branch (detached worktree) is not a hold", () => {
    expect(openPrHold(undefined, openPrs)).toBeNull();
  });
});

/**
 * A `gh` fake speaking the forge's REST dialect (#1422): `repo view` names
 * the repo and the paged `api repos/o/r/pulls?state=open&...` list slices
 * `open` by page, the way GitHub does.
 */
function ghRest({ open = [] } = {}) {
  return (_cmd, args) => {
    const ok = (body) => ({
      status: 0,
      stdout: JSON.stringify(body),
      stderr: "",
    });
    if (args[0] === "repo" && args[1] === "view")
      return ok({ nameWithOwner: "o/r" });
    const list =
      /^repos\/o\/r\/pulls\?state=open&per_page=(\d+)&page=(\d+)$/.exec(
        args[0] === "api" ? args[1] : "",
      );
    if (list) {
      const perPage = Number(list[1]);
      const page = Number(list[2]);
      return ok(open.slice((page - 1) * perPage, page * perPage));
    }
    return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
  };
}

describe("listOpenPrs", () => {
  test("returns the parsed PR list", () => {
    const run = recorder(
      ghRest({ open: [{ number: 261, head: { ref: "feat/CLNT-520" } }] }),
    );
    expect(listOpenPrs("/repo", run)).toEqual([
      { number: 261, headRefName: "feat/CLNT-520" },
    ]);
    expect(run.calls[0].args).toEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ]);
    expect(run.calls[1].args).toEqual([
      "api",
      "repos/o/r/pulls?state=open&per_page=100&page=1",
    ]);
    expect(run.calls.every((call) => call.opts.cwd === "/repo")).toBe(true);
  });

  test("a failed or unparseable `gh` is null, not an empty list", () => {
    // The distinction is the whole point: empty means "no open PR", null means
    // "could not tell", and only the first one licenses a teardown.
    expect(
      listOpenPrs(
        "/repo",
        recorder(() => ({ status: 1, stderr: "gh: not authenticated" })),
      ),
    ).toBeNull();
    expect(
      listOpenPrs(
        "/repo",
        recorder(() => ({ status: 0, stdout: "not json" })),
      ),
    ).toBeNull();
  });

  test("fails closed (returns null) when hitting the fetch limit (WM-56)", () => {
    const atLimit = Array.from({ length: 200 }, (_, i) => ({
      number: i + 1,
      head: { ref: `branch-${i + 1}` },
    }));
    const run = recorder(ghRest({ open: atLimit }));
    expect(listOpenPrs("/repo", run, 200)).toBeNull();
  });

  test("returns PRs when below the fetch limit (WM-56)", () => {
    const belowLimit = Array.from({ length: 199 }, (_, i) => ({
      number: i + 1,
      head: { ref: `branch-${i + 1}` },
    }));
    const run = recorder(ghRest({ open: belowLimit }));
    expect(listOpenPrs("/repo", run, 200)).toHaveLength(199);
  });
});

describe("ticketBranches", () => {
  test("keys the branch by ticket for worktrees under the root", () => {
    const porcelain = [
      "worktree /wt/legalease/CLNT-520",
      "branch refs/heads/feat/CLNT-520",
      "",
      "worktree /wt/legalease/CLNT-600",
      "branch refs/heads/fix/CLNT-600-thing",
      "",
    ].join("\n");
    const run = recorder(() => ({ status: 0, stdout: porcelain }));
    expect(
      ticketBranches(
        "/repo",
        "/wt/legalease",
        ["CLNT-520", "CLNT-600", "CLNT-700"],
        run,
      ),
    ).toEqual({
      "CLNT-520": "feat/CLNT-520",
      "CLNT-600": "fix/CLNT-600-thing",
    });
  });

  test("a failed git worktree list is cannot-tell, not an empty map", () => {
    const run = recorder(() => ({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository\n",
    }));
    expect(
      ticketBranches("/repo", "/wt/legalease", ["CLNT-520"], run),
    ).toBeNull();
  });
});

describe("reclaim (WM-17 regression: branch A merged while a second PR still heads it)", () => {
  const scenario = {
    repoPath: "/Users/x/Develop/legalease",
    down: "bin/worktree-down.sh",
    branches: { "CLNT-520": "feat/CLNT-520", "CLNT-600": "fix/CLNT-600-thing" },
    // PR #253 merged (gone from the open list); PR #261 is another agent's,
    // still open, still pointing at the very branch cleanup is about to remove.
    openPrs: [{ number: 261, headRefName: "feat/CLNT-520" }],
  };

  test("the held worktree is never handed to worktree-down.sh", () => {
    const run = recorder();
    const out = reclaim(["CLNT-520"], { ...scenario, run });
    expect(out.removed).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(out.held.map((h) => h.id)).toEqual(["CLNT-520"]);
    expect(out.held[0].reason).toContain("#261");
  });

  test("the hold is per branch — an unrelated finished ticket is still reclaimed", () => {
    const run = recorder();
    const out = reclaim(["CLNT-520", "CLNT-600"], { ...scenario, run });
    expect(out.removed).toEqual(["CLNT-600"]);
    expect(out.held.map((h) => h.id)).toEqual(["CLNT-520"]);
    expect(run.calls.map((call) => call.args[1])).toEqual(["CLNT-600"]);
  });

  test("once PR #261 closes, the same worktree is reclaimed", () => {
    const run = recorder();
    const out = reclaim(["CLNT-520"], { ...scenario, openPrs: [], run });
    expect(out.removed).toEqual(["CLNT-520"]);
    expect(out.held).toEqual([]);
  });

  test("worktree-down.sh's own refusal (unpushed work) is still reported, not overridden", () => {
    const run = recorder(() => ({
      status: 1,
      stderr: "CLNT-600 has uncommitted changes — commit/stash them\n",
    }));
    const out = reclaim(["CLNT-600"], { ...scenario, run });
    expect(out.removed).toEqual([]);
    expect(out.refused).toEqual([
      {
        id: "CLNT-600",
        reason: "CLNT-600 has uncommitted changes — commit/stash them",
      },
    ]);
  });

  test("teardown is never invoked with --force", () => {
    const run = recorder();
    reclaim(["CLNT-600"], { ...scenario, run });
    expect(run.calls[0].args).not.toContain("--force");
  });

  test("reclaim throws if openPrs is missing, null, or not an array (WM-56)", () => {
    const run = recorder();
    expect(() =>
      reclaim(["CLNT-520"], { ...scenario, openPrs: undefined, run }),
    ).toThrow("reclaim requires openPrs array");
    expect(() =>
      reclaim(["CLNT-520"], { ...scenario, openPrs: null, run }),
    ).toThrow("reclaim requires openPrs array");
    expect(() =>
      reclaim(["CLNT-520"], { ...scenario, openPrs: "invalid", run }),
    ).toThrow("reclaim requires openPrs array");
    expect(() =>
      reclaim(["CLNT-520"], { repoPath: "/repo", down: "down.sh" }),
    ).toThrow("reclaim requires openPrs array");
  });
});

describe("survey (WM-55: hold wiring and cannot-tell exclusion)", () => {
  const repo = {
    name: "legalease",
    team: "CLNT",
    path: "/Users/x/Develop/legalease",
    worktree_root: "/Users/x/Develop/.worktrees/legalease",
    worktree_down: "bin/worktree-down.sh",
  };

  const defaultDeps = {
    readdir: () => ["CLNT-520", "CLNT-600"],
    exists: () => true,
    queryIssues: async () => [
      { identifier: "CLNT-520", state: { name: "Done", type: "completed" } },
      { identifier: "CLNT-600", state: { name: "Done", type: "completed" } },
    ],
    getBranches: () => ({
      "CLNT-520": "feat/CLNT-520",
      "CLNT-600": "fix/CLNT-600",
    }),
    getOpenPrs: () => [{ number: 261, headRefName: "feat/CLNT-520" }],
  };

  test("resolves hundreds of worktrees with a bounded tracker fan-out", async () => {
    const worktrees = Array.from({ length: 501 }, (_, i) => `CLNT-${i + 1}`);
    const asked = [];
    let active = 0;
    let maxActive = 0;
    const res = await survey(
      repo,
      { apply: false },
      {
        readdir: () => worktrees,
        exists: () => true,
        resolveControlPlane: () => ({
          kind: "linear",
          getTicket: async (identifier) => {
            asked.push(identifier);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            active -= 1;
            const number = Number(identifier.split("-")[1]);
            return {
              identifier,
              state:
                number % 2 === 0
                  ? { name: "Done", type: "completed" }
                  : { name: "In Progress", type: "started" },
            };
          },
        }),
        getBranches: () => ({}),
        getOpenPrs: () => [],
      },
    );

    expect(asked).toHaveLength(501);
    // Every worktree is resolved, but never as one 501-wide request burst.
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
    expect(res.unknown).toEqual([]);
    expect(res.reclaimable).toHaveLength(250);
    expect(res.kept).toHaveLength(251);
    expect(res.kept.at(-1)).toEqual({ id: "CLNT-501", state: "In Progress" });
  });

  test("one unresolvable ticket lands in unknown without sinking the survey", async () => {
    const res = await survey(
      repo,
      { apply: false },
      {
        readdir: () => ["CLNT-520", "CLNT-600"],
        exists: () => true,
        resolveControlPlane: () => ({
          kind: "linear",
          getTicket: async (identifier) => {
            if (identifier === "CLNT-600") throw new Error("tracker 502");
            return {
              identifier,
              state: { name: "Done", type: "completed" },
            };
          },
        }),
        getBranches: () => ({ "CLNT-520": "feat/CLNT-520" }),
        getOpenPrs: () => [],
      },
    );

    expect(res.unknown).toEqual(["CLNT-600"]);
    expect(res.reclaimable).toEqual([{ id: "CLNT-520", state: "Done" }]);
  });

  test("uses the repository's GitHub control plane for gh worktrees", async () => {
    const githubRepo = {
      ...repo,
      name: "factory",
      control_plane: "github",
      github: "watt-mind/factory",
    };
    const controlPlaneCalls = [];
    const ticketCalls = [];
    const res = await survey(
      githubRepo,
      { apply: true },
      {
        readdir: () => ["gh-2160", "release-scratch"],
        exists: () => true,
        resolveControlPlane: (opts) => {
          controlPlaneCalls.push(opts);
          return {
            kind: "github",
            getTicket: async (identifier) => {
              ticketCalls.push(identifier);
              return {
                identifier,
                state: { name: "Done", type: "completed" },
              };
            },
          };
        },
        getBranches: () => ({ "gh-2160": "fix/gh-2160" }),
        getOpenPrs: () => [],
        doReclaim: (finished) => ({
          removed: finished,
          refused: [],
          held: [],
        }),
      },
    );

    expect(controlPlaneCalls).toEqual([{ repoName: "factory" }]);
    expect(ticketCalls).toEqual(["watt-mind/factory#2160"]);
    expect(res.named).toEqual(["release-scratch"]);
    expect(res.reclaimable).toEqual([{ id: "gh-2160", state: "Done" }]);
    expect(res.removed).toEqual(["gh-2160"]);
  });

  test("a github-plane repo never treats a tracker-key worktree as a ticket", async () => {
    // `PR-516` and `WM-87` are deliberate human checkouts. They slug cleanly,
    // so a loose match would look up issues #516 and #87 in this repo, find
    // them closed years ago, and offer both directories up for deletion.
    const githubRepo = {
      ...repo,
      name: "factory",
      control_plane: "github",
      github: "watt-mind/factory",
    };
    const ticketCalls = [];
    const res = await survey(
      githubRepo,
      { apply: true },
      {
        readdir: () => ["gh-2160", "PR-516", "WM-87", "release-scratch"],
        exists: () => true,
        resolveControlPlane: () => ({
          kind: "github",
          getTicket: async (identifier) => {
            ticketCalls.push(identifier);
            return { identifier, state: { name: "Done", type: "completed" } };
          },
        }),
        getBranches: () => ({ "gh-2160": "fix/gh-2160" }),
        getOpenPrs: () => [],
        doReclaim: (finished) => ({
          removed: finished,
          refused: [],
          held: [],
        }),
      },
    );

    expect(ticketCalls).toEqual(["watt-mind/factory#2160"]);
    expect(res.named).toEqual(["PR-516", "WM-87", "release-scratch"]);
    expect(res.reclaimable).toEqual([{ id: "gh-2160", state: "Done" }]);
    expect(res.removed).toEqual(["gh-2160"]);
    for (const dir of ["PR-516", "WM-87"]) {
      expect(res.reclaimable.map((r) => r.id)).not.toContain(dir);
      expect(res.removed).not.toContain(dir);
      expect(res.unknown).not.toContain(dir);
      expect(res.kept.map((k) => k.id)).not.toContain(dir);
    }
  });

  test("a linear-plane repo never treats a gh-<n> worktree as a ticket", async () => {
    const ticketCalls = [];
    const res = await survey(
      repo,
      { apply: false },
      {
        readdir: () => ["CLNT-520", "gh-2160"],
        exists: () => true,
        resolveControlPlane: () => ({
          kind: "linear",
          getTicket: async (identifier) => {
            ticketCalls.push(identifier);
            return { identifier, state: { name: "Done", type: "completed" } };
          },
        }),
        getBranches: () => ({ "CLNT-520": "feat/CLNT-520" }),
        getOpenPrs: () => [],
      },
    );

    expect(ticketCalls).toEqual(["CLNT-520"]);
    expect(res.named).toEqual(["gh-2160"]);
    expect(res.reclaimable).toEqual([{ id: "CLNT-520", state: "Done" }]);
  });

  test("an open-PR hold populates the held array and is excluded from reclaimable (dry run)", () => {
    const res = survey(repo, { apply: false }, defaultDeps);
    return res.then((surveyRes) => {
      expect(surveyRes.held).toHaveLength(1);
      expect(surveyRes.held[0].id).toBe("CLNT-520");
      expect(surveyRes.held[0].reason).toContain("#261");
      expect(surveyRes.reclaimable).toEqual([
        { id: "CLNT-600", state: "Done" },
      ]);
      expect(surveyRes.skippedApplyReason).toBeNull();
    });
  });

  test("an open-PR hold populates the held array and is excluded from reclaimable (apply run)", async () => {
    let reclaimed = null;
    const res = await survey(
      repo,
      { apply: true },
      {
        ...defaultDeps,
        doReclaim: (finished, opts) => {
          reclaimed = finished;
          return { removed: finished, refused: [], held: [] };
        },
      },
    );
    expect(res.held).toHaveLength(1);
    expect(res.held[0].id).toBe("CLNT-520");
    expect(res.reclaimable).toEqual([{ id: "CLNT-600", state: "Done" }]);
    expect(res.removed).toEqual(["CLNT-600"]);
    expect(reclaimed).toEqual(["CLNT-600"]);
  });

  test("cannot-tell from gh (getOpenPrs returns null) yields empty reclaimable and populates skippedApplyReason (dry and apply)", async () => {
    const dry = await survey(
      repo,
      { apply: false },
      {
        ...defaultDeps,
        getOpenPrs: () => null,
      },
    );
    expect(dry.reclaimable).toEqual([]);
    expect(dry.held).toEqual([]);
    expect(dry.skippedApplyReason).toContain("could not list open PRs");

    const apply = await survey(
      repo,
      { apply: true },
      {
        ...defaultDeps,
        getOpenPrs: () => null,
      },
    );
    expect(apply.reclaimable).toEqual([]);
    expect(apply.held).toEqual([]);
    expect(apply.skippedApplyReason).toContain("could not list open PRs");
  });

  test("cannot-tell from git worktree list (getBranches returns null) yields empty reclaimable and populates skippedApplyReason (dry and apply)", async () => {
    const dry = await survey(
      repo,
      { apply: false },
      {
        ...defaultDeps,
        getBranches: () => null,
        getOpenPrs: () => [],
      },
    );
    expect(dry.reclaimable).toEqual([]);
    expect(dry.held).toEqual([]);
    expect(dry.skippedApplyReason).toContain(
      "could not list worktree branches",
    );

    const apply = await survey(
      repo,
      { apply: true },
      {
        ...defaultDeps,
        getBranches: () => null,
        getOpenPrs: () => [],
      },
    );
    expect(apply.reclaimable).toEqual([]);
    expect(apply.held).toEqual([]);
    expect(apply.skippedApplyReason).toContain(
      "could not list worktree branches",
    );
  });
});

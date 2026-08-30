/**
 * bun test orchestrator/branch-guard.test.mjs
 *
 * WM-51. Mechanical branch deletion guard tests.
 * Covers:
 *  - Held by another open PR (WM-17 regression: deleting branch while still used by another PR)
 *  - Free to delete (no other open PRs using the branch)
 *  - Protected base / deploy_branch refs (develop, master, main, repo.base, repo.deploy_branch)
 *  - gh / config failure modes (exit 3)
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXIT,
  protectedBranchesFor,
  isProtectedBranch,
  openPrHold,
  evaluateBranchGuard,
  resolveHeadBranch,
  listOpenPrs,
} from "./branch-guard.mjs";

function recorder(handler = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(cmd, args, opts);
  };
  run.calls = calls;
  return run;
}

describe("protectedBranchesFor & isProtectedBranch", () => {
  const repo = {
    name: "legalease",
    base: "staging",
    deploy_branch: "production",
  };

  test("includes repo base and deploy_branch along with defaults", () => {
    const branches = protectedBranchesFor(repo);
    expect(branches).toContain("staging");
    expect(branches).toContain("production");
    expect(branches).toContain("develop");
    expect(branches).toContain("master");
    expect(branches).toContain("main");
  });

  test("identifies protected branches correctly", () => {
    expect(isProtectedBranch("develop", repo)).toBe(true);
    expect(isProtectedBranch("master", repo)).toBe(true);
    expect(isProtectedBranch("main", repo)).toBe(true);
    expect(isProtectedBranch("staging", repo)).toBe(true);
    expect(isProtectedBranch("production", repo)).toBe(true);
    expect(isProtectedBranch("feat/CLNT-520", repo)).toBe(false);
    expect(isProtectedBranch("fix/WM-13-test", repo)).toBe(false);
  });

  test("normalizes ref prefixes and case before matching protected branches", () => {
    expect(isProtectedBranch("refs/heads/develop", repo)).toBe(true);
    expect(isProtectedBranch("origin/develop", repo)).toBe(true);
    expect(isProtectedBranch("heads/develop", repo)).toBe(true);
    expect(isProtectedBranch("Develop", repo)).toBe(true);
    expect(isProtectedBranch("MASTER", repo)).toBe(true);
    expect(isProtectedBranch("REFS/HEADS/PRODUCTION", repo)).toBe(true);
    expect(isProtectedBranch("origin/Staging", repo)).toBe(true);
    expect(isProtectedBranch("staging", { ...repo, base: "StAgInG" })).toBe(
      true,
    );
    expect(isProtectedBranch("upstream/develop", repo)).toBe(false);
    expect(isProtectedBranch("feature/origin/develop", repo)).toBe(false);
  });
});

describe("openPrHold", () => {
  const openPrs = [
    { number: 261, headRefName: "feat/CLNT-520" },
    { number: 253, headRefName: "feat/CLNT-520" },
    { number: 262, headRefName: "fix/CLNT-777" },
  ];

  test("holds when another open PR has the same headRefName", () => {
    const hold = openPrHold("feat/CLNT-520", 253, openPrs);
    expect(hold).not.toBeNull();
    expect(hold).toContain("#261");
    expect(hold).not.toContain("#253");
  });

  test("is free when no other open PR shares the branch", () => {
    const hold = openPrHold("fix/CLNT-777", 262, openPrs);
    expect(hold).toBeNull();
  });

  test("is free when branch is not in open PRs at all", () => {
    const hold = openPrHold("feat/CLNT-999", 999, openPrs);
    expect(hold).toBeNull();
  });

  test("handles empty/null openPrs safely", () => {
    expect(openPrHold("feat/CLNT-520", 253, [])).toBeNull();
    expect(openPrHold("feat/CLNT-520", 253, null)).toBeNull();
    expect(openPrHold(null, 253, openPrs)).toBeNull();
  });
});

describe("evaluateBranchGuard", () => {
  const repo = {
    name: "legalease",
    base: "develop",
    deploy_branch: "master",
  };

  const openPrs = [
    { number: 261, headRefName: "feat/CLNT-520" },
    { number: 253, headRefName: "feat/CLNT-520" },
    { number: 270, headRefName: "fix/solo-branch" },
  ];

  test("returns SAFE (0) for an unheld feature branch", () => {
    const res = evaluateBranchGuard({
      branch: "fix/solo-branch",
      repo,
      targetPr: 270,
      openPrs,
    });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(EXIT.SAFE);
  });

  test("returns REFUSED (2) for a protected branch (develop/master/main/base/deploy_branch)", () => {
    const resDevelop = evaluateBranchGuard({
      branch: "develop",
      repo,
      targetPr: 100,
      openPrs: [],
    });
    expect(resDevelop.ok).toBe(false);
    expect(resDevelop.exitCode).toBe(EXIT.REFUSED);
    expect(resDevelop.reason).toContain("protected branch");

    const resMaster = evaluateBranchGuard({
      branch: "master",
      repo,
      targetPr: 101,
      openPrs: [],
    });
    expect(resMaster.ok).toBe(false);
    expect(resMaster.exitCode).toBe(EXIT.REFUSED);

    const resMain = evaluateBranchGuard({
      branch: "main",
      repo,
      targetPr: 102,
      openPrs: [],
    });
    expect(resMain.ok).toBe(false);
    expect(resMain.exitCode).toBe(EXIT.REFUSED);
  });

  test("returns REFUSED (2) for prefixed and case-variant protected branches", () => {
    for (const branch of [
      "refs/heads/develop",
      "origin/develop",
      "heads/develop",
      "Develop",
      "Master",
      "MAIN",
    ]) {
      const res = evaluateBranchGuard({
        branch,
        repo,
        targetPr: 100,
        openPrs: [],
      });
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(EXIT.REFUSED);
      expect(res.reason).toContain("protected branch");
    }
  });

  test("returns REFUSED (2) when held by another open PR", () => {
    const res = evaluateBranchGuard({
      branch: "feat/CLNT-520",
      repo,
      targetPr: 253,
      openPrs,
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(EXIT.REFUSED);
    expect(res.reason).toContain("#261");
  });

  test("returns CANNOT_EVALUATE (3) on missing branch or repo", () => {
    expect(
      evaluateBranchGuard({ branch: "", repo, targetPr: 1, openPrs }).exitCode,
    ).toBe(EXIT.CANNOT_EVALUATE);
    expect(
      evaluateBranchGuard({
        branch: "feat/foo",
        repo: null,
        targetPr: 1,
        openPrs,
      }).exitCode,
    ).toBe(EXIT.CANNOT_EVALUATE);
  });
});

/**
 * A `gh` fake speaking the forge's REST dialect (#1422): `repo view` names
 * the repo, `api repos/o/r/pulls/{n}` returns one pull, and the paged
 * `api repos/o/r/pulls?state=open&...` list slices `open` by page.
 */
function ghRest({ open = [], ...pulls } = {}) {
  return (_cmd, args) => {
    const ok = (body) => ({
      status: 0,
      stdout: JSON.stringify(body),
      stderr: "",
    });
    if (args[0] === "repo" && args[1] === "view")
      return ok({ nameWithOwner: "o/r" });
    if (args[0] === "api") {
      const one = /^repos\/o\/r\/pulls\/(\d+)$/.exec(args[1]);
      if (one && pulls[one[1]])
        return ok({ number: Number(one[1]), ...pulls[one[1]] });
      const list =
        /^repos\/o\/r\/pulls\?state=open&per_page=(\d+)&page=(\d+)$/.exec(
          args[1],
        );
      if (list) {
        const perPage = Number(list[1]);
        const page = Number(list[2]);
        return ok(open.slice((page - 1) * perPage, page * perPage));
      }
    }
    return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
  };
}

describe("gh helper failure modes", () => {
  test("resolveHeadBranch returns null on gh error", () => {
    const run = recorder(() => ({
      status: 1,
      stdout: "",
      stderr: "not found",
    }));
    expect(resolveHeadBranch("/fake", 123, run)).toBeNull();
  });

  test("resolveHeadBranch returns branch name on success", () => {
    // The forge resolves the cwd repo once (`gh repo view`), then reads the
    // PR over REST and picks `headRefName` itself (WM-836, #1422); the fake
    // answers each spawn the way gh does, as JSON.
    const run = recorder(ghRest({ 123: { head: { ref: "feat/my-branch" } } }));
    expect(resolveHeadBranch("/fake", 123, run)).toBe("feat/my-branch");
    expect(run.calls.map((call) => call.cmd)).toEqual(["gh", "gh"]);
    expect(run.calls[0].args).toEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ]);
    expect(run.calls[1].args).toEqual(["api", "repos/o/r/pulls/123"]);
    expect(run.calls.every((call) => call.opts.cwd === "/fake")).toBe(true);
  });

  test("listOpenPrs returns null on gh failure or JSON parse error", () => {
    const runFail = recorder(() => ({
      status: 1,
      stdout: "",
      stderr: "gh error",
    }));
    expect(listOpenPrs("/fake", runFail)).toBeNull();

    const runBadJson = recorder(() => ({
      status: 0,
      stdout: "invalid json",
      stderr: "",
    }));
    expect(listOpenPrs("/fake", runBadJson)).toBeNull();
  });

  test("listOpenPrs returns array on success", () => {
    const run = recorder(
      ghRest({ open: [{ number: 10, head: { ref: "feat/x" } }] }),
    );
    expect(listOpenPrs("/fake", run)).toEqual([
      { number: 10, headRefName: "feat/x" },
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
  });
});

describe("CLI branch-guard execution", () => {
  const tmpConfig = path.join(tmpdir(), "test-repos-branch-guard.yaml");

  test("CLI returns 0 (SAFE) when branch is free and safe to delete", () => {
    const yaml = `
repos:
  - name: testrepo
    path: ${path.join(import.meta.dirname, "..")}
    base: develop
    deploy_branch: master
`;
    writeFileSync(tmpConfig, yaml, "utf8");

    const r = spawnSync(
      "bun",
      [
        path.join(import.meta.dirname, "branch-guard.mjs"),
        "--repo",
        "testrepo",
        "--pr",
        "9999",
        "--head",
        "fix/unheld-unique-branch",
      ],
      {
        env: {
          ...process.env,
          FACTORY_BRANCH_GUARD_REPOS_YAML: tmpConfig,
          FACTORY_BRANCH_GUARD_OPEN_PRS_JSON: "[]",
        },
        encoding: "utf8",
      },
    );

    try {
      unlinkSync(tmpConfig);
    } catch {
      /* intentionally ignored */
    }
    expect(r.status).toBe(EXIT.SAFE);
    expect(r.stdout).toContain("safe to delete");
  });

  test("CLI returns 2 (REFUSED) for protected develop/master branch", () => {
    const yaml = `
repos:
  - name: testrepo
    path: ${path.join(import.meta.dirname, "..")}
    base: develop
    deploy_branch: master
`;
    writeFileSync(tmpConfig, yaml, "utf8");

    const r = spawnSync(
      "bun",
      [
        path.join(import.meta.dirname, "branch-guard.mjs"),
        "--repo",
        "testrepo",
        "--pr",
        "9999",
        "--head",
        "develop",
      ],
      {
        env: {
          ...process.env,
          FACTORY_BRANCH_GUARD_REPOS_YAML: tmpConfig,
          FACTORY_BRANCH_GUARD_OPEN_PRS_JSON: "[]",
        },
        encoding: "utf8",
      },
    );

    try {
      unlinkSync(tmpConfig);
    } catch {
      /* intentionally ignored */
    }
    expect(r.status).toBe(EXIT.REFUSED);
    expect(r.stderr).toContain("protected branch");
  });

  test("CLI returns 3 (CANNOT_EVALUATE) on unknown repo or missing args", () => {
    const rNoArgs = spawnSync(
      "bun",
      [path.join(import.meta.dirname, "branch-guard.mjs")],
      { encoding: "utf8" },
    );
    expect(rNoArgs.status).toBe(EXIT.CANNOT_EVALUATE);

    const rBadRepo = spawnSync(
      "bun",
      [
        path.join(import.meta.dirname, "branch-guard.mjs"),
        "--repo",
        "nonexistent",
        "--pr",
        "123",
      ],
      { encoding: "utf8" },
    );
    expect(rBadRepo.status).toBe(EXIT.CANNOT_EVALUATE);
  });
});

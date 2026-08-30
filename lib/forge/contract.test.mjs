/**
 * Forge contract suite (WM-836): the same assertions run against the memory
 * fake and against the GitHub implementation driven by a fake `gh` that serves
 * the same seed. A verb that passes here on one and not the other is a
 * contract bug, not a test bug.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { githubForge } from "./github.mjs";
import {
  ForgeError,
  FORGE_KINDS,
  forgeKindFromPolicy,
  loadForge,
} from "./index.mjs";
import { memoryForge } from "./memory.mjs";

const REPO = "acme/widget";

function freshSeed() {
  return {
    repos: {
      [REPO]: {
        prs: [
          {
            number: 1,
            state: "OPEN",
            isDraft: false,
            labels: [],
            headRefName: "feat/a",
            headRefOid: "abc123",
            title: "feat: a",
            body: "Fixes WM-1",
            url: `https://github.com/${REPO}/pull/1`,
            files: ["src/a.js", "src/b.js"],
            checks: [
              {
                name: "Verify",
                bucket: "pass",
                state: "SUCCESS",
                required: true,
              },
              { name: "docs", bucket: "pass", state: "SUCCESS" },
            ],
          },
          {
            number: 2,
            state: "OPEN",
            isDraft: true,
            labels: [{ name: "escalated" }],
            headRefName: "fix/b",
            headRefOid: "def456",
            title: "fix: b",
            body: "",
            url: `https://github.com/${REPO}/pull/2`,
            files: [],
            checks: [
              {
                name: "Lint",
                bucket: "fail",
                state: "FAILURE",
                required: true,
              },
              { name: "Verify", bucket: "pending", state: "PENDING" },
            ],
          },
          {
            number: 3,
            state: "MERGED",
            isDraft: false,
            labels: [],
            headRefName: "chore/c",
            headRefOid: "0a0a0a",
            title: "chore: c",
            body: "",
            url: `https://github.com/${REPO}/pull/3`,
            files: ["README.md"],
          },
        ],
        runs: [
          {
            databaseId: 11,
            name: "Verify",
            workflowName: "Verify",
            status: "completed",
            conclusion: "success",
            headBranch: "main",
            createdAt: "2026-08-10T10:00:00Z",
          },
          {
            databaseId: 12,
            name: "Verify",
            workflowName: "Verify",
            status: "queued",
            conclusion: null,
            headBranch: "main",
            createdAt: "2026-08-17T10:00:00Z",
          },
          {
            databaseId: 13,
            name: "Verify",
            workflowName: "Verify",
            status: "in_progress",
            conclusion: null,
            headBranch: "develop",
            createdAt: "2026-08-17T11:00:00Z",
          },
        ],
      },
    },
    api: {
      "orgs/acme/actions/runners": ({ jq }) =>
        jq ? "2" : JSON.stringify({ runners: [{ id: 1 }, { id: 2 }] }),
    },
  };
}

/**
 * A `gh` that answers from the seed. Deliberately small: it understands only
 * the verbs the Forge interface emits, and mutates the shared seed so both
 * implementations can be asserted through the same fixture.
 */
function fakeGhExec(seed) {
  const exec = (cmd, args) => {
    exec.calls.push({ cmd, args });
    if (cmd !== "gh") return { status: 127, stdout: "", stderr: "not gh" };
    const flags = {};
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("--") || a === "-q") {
        const key = a.replace(/^-+/, "");
        if (key === "undo" || key === "name-only" || key === "required")
          flags[key] = true;
        else flags[key] = args[++i];
      } else positional.push(a);
    }
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    const fail = (stderr, status = 1) => ({ status, stdout: "", stderr });
    const repo = flags.repo;
    const data = seed.repos[repo];
    if (positional[0] !== "api" && positional[0] !== "repo" && !data)
      return fail(
        `GraphQL: Could not resolve to a Repository with the name '${repo}'.`,
      );
    const fields = flags.json?.split(",");
    const pick = (o) =>
      fields ? Object.fromEntries(fields.map((f) => [f, o[f]])) : { ...o };
    const findPr = (n) => data.prs.find((p) => String(p.number) === n);

    const restPull = (pr) => ({
      number: pr.number,
      state: pr.state === "OPEN" ? "open" : "closed",
      merged_at:
        pr.state === "MERGED" ? (pr.mergedAt ?? "2026-08-15T10:00:00Z") : null,
      draft: pr.isDraft,
      title: pr.title,
      body: pr.body,
      html_url: pr.url,
      labels: pr.labels,
      head: { ref: pr.headRefName, sha: pr.headRefOid },
      base: { ref: "main" },
      mergeable: true,
      mergeable_state: "clean",
    });
    const api = (path) => {
      const [pathname, query = ""] = path.split("?");
      const match = /^repos\/([^/]+\/[^/]+)\/(.*)$/.exec(pathname);
      const apiRepo = match?.[1];
      const rest = match?.[2];
      const apiData = seed.repos[apiRepo];
      if (!apiData) return fail("gh: Not Found (HTTP 404)");
      if (rest === "pulls") {
        const params = new URLSearchParams(query);
        const state = params.get("state") ?? "open";
        const page = Number(params.get("page") ?? 1);
        const perPage = Number(params.get("per_page") ?? 30);
        const prs = apiData.prs.filter((pr) =>
          state === "all"
            ? true
            : state === "open"
              ? pr.state === "OPEN"
              : pr.state !== "OPEN",
        );
        return ok(
          JSON.stringify(
            prs.slice((page - 1) * perPage, page * perPage).map(restPull),
          ),
        );
      }
      const pull = /^pulls\/(\d+)$/.exec(rest ?? "");
      if (pull) {
        const pr = apiData.prs.find(
          (candidate) => String(candidate.number) === pull[1],
        );
        return pr
          ? ok(JSON.stringify(restPull(pr)))
          : fail("gh: Not Found (HTTP 404)");
      }
      const checkRuns = /^commits\/([^/]+)\/check-runs$/.exec(rest ?? "");
      if (checkRuns) {
        const pr = apiData.prs.find(
          (candidate) => candidate.headRefOid === checkRuns[1],
        );
        if (!pr) return fail("gh: Not Found (HTTP 404)");
        return ok(
          JSON.stringify({
            check_runs: (pr.checks ?? []).map((check) => ({
              name: check.name,
              conclusion: check.state?.toLowerCase(),
              status: check.state === "PENDING" ? "in_progress" : "completed",
            })),
          }),
        );
      }
      const status = /^commits\/([^/]+)\/status$/.exec(rest ?? "");
      if (status) return ok(JSON.stringify({ statuses: [] }));
      const protection =
        /^branches\/([^/]+)\/protection\/required_status_checks$/.exec(
          rest ?? "",
        );
      if (protection) {
        return ok(
          JSON.stringify({
            contexts: apiData.prs.flatMap((pr) =>
              (pr.checks ?? [])
                .filter((check) => check.required)
                .map((check) => check.name),
            ),
          }),
        );
      }
      return fail("gh: Not Found (HTTP 404)");
    };

    switch (`${positional[0]} ${positional[1]}`) {
      case "repo view":
        return ok(JSON.stringify({ nameWithOwner: REPO }));
      case "pr view": {
        const pr = findPr(positional[2]);
        if (!pr)
          return fail(
            `GraphQL: Could not resolve to a PullRequest with the number of ${positional[2]}. (repository.pullRequest)`,
          );
        return ok(JSON.stringify(pick(pr)));
      }
      case "pr list": {
        let prs = data.prs.filter(
          (p) =>
            !flags.state ||
            flags.state === "all" ||
            p.state.toLowerCase() === flags.state,
        );
        if (flags.limit) prs = prs.slice(0, Number(flags.limit));
        return ok(JSON.stringify(prs.map(pick)));
      }
      case "pr diff": {
        const pr = findPr(positional[2]);
        if (!pr) return fail("no pull requests found");
        return ok(pr.files.map((f) => `${f}\n`).join(""));
      }
      case "pr ready": {
        const pr = findPr(positional[2]);
        if (!pr) return fail("no pull requests found");
        pr.isDraft = Boolean(flags.undo);
        return ok("");
      }
      case "pr comment": {
        const pr = findPr(positional[2]);
        if (!pr) return fail("no pull requests found");
        (pr.comments ??= []).push({ body: flags.body });
        return ok(
          `https://github.com/${repo}/pull/${pr.number}#issuecomment-1\n`,
        );
      }
      case "pr checks": {
        const pr = findPr(positional[2]);
        if (!pr)
          return fail(
            `GraphQL: Could not resolve to a PullRequest with the number of ${positional[2]}. (repository.pullRequest)`,
          );
        let checks = [...(pr.checks ?? [])];
        if (flags.required) {
          checks = checks.filter((c) => c.required);
          if (checks.length === 0)
            return fail(
              `no required checks reported on the '${pr.headRefName}' branch`,
            );
        } else if (checks.length === 0) {
          return fail(`no checks reported on the '${pr.headRefName}' branch`);
        }
        return ok(JSON.stringify(checks.map(pick)));
      }
      case "run list": {
        let runs = data.runs;
        if (flags.branch)
          runs = runs.filter((r) => r.headBranch === flags.branch);
        const since = /^>=?(.+)$/.exec(flags.created ?? "")?.[1];
        if (since) runs = runs.filter((r) => r.createdAt >= since);
        if (flags.limit) runs = runs.slice(0, Number(flags.limit));
        return ok(JSON.stringify(runs.map(pick)));
      }
      case `api ${positional[1]}`: {
        const hit = seed.api[positional[1]];
        if (hit !== undefined)
          return ok(typeof hit === "function" ? hit({ jq: flags.jq }) : hit);
        return api(positional[1]);
      }
      default:
        return fail(`unknown command ${args.join(" ")}`);
    }
  };
  exec.calls = [];
  return exec;
}

const IMPLEMENTATIONS = [
  [
    "memory",
    () => {
      const seed = freshSeed();
      return { forge: memoryForge(seed), seed };
    },
  ],
  [
    "github",
    () => {
      const seed = freshSeed();
      return { forge: githubForge({ exec: fakeGhExec(seed) }), seed };
    },
  ],
];

for (const [name, make] of IMPLEMENTATIONS) {
  describe(`forge contract: ${name}`, () => {
    test("kind and cli descriptor", () => {
      const { forge } = make();
      expect(FORGE_KINDS).toContain(forge.kind);
      expect(forge.kind).toBe(name);
      expect(forge.cli).toHaveProperty("bin");
      expect(forge.cli).toHaveProperty("install");
    });

    test("prView returns only the requested fields", () => {
      const { forge } = make();
      expect(
        forge.prView(REPO, 1, { fields: ["state", "isDraft", "labels"] }),
      ).toEqual({ state: "OPEN", isDraft: false, labels: [] });
      expect(forge.prView(REPO, "2", { fields: ["headRefName"] })).toEqual({
        headRefName: "fix/b",
      });
    });

    test("prView on an unknown PR throws a ForgeError whose stderr reads as not-found", () => {
      const { forge } = make();
      let err;
      try {
        forge.prView(REPO, 999, { fields: ["state"] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ForgeError);
      expect(err.status).not.toBe(0);
      expect(err.stderr).toMatch(
        /not found|no pull request|could not resolve/i,
      );
    });

    test("prView on an unknown repo throws a ForgeError", () => {
      const { forge } = make();
      expect(() => forge.prView("nope/none", 1, { fields: ["state"] })).toThrow(
        ForgeError,
      );
    });

    test("prList filters by state and honours limit + fields", () => {
      const { forge } = make();
      expect(
        forge.prList(REPO, { state: "open", fields: ["number", "isDraft"] }),
      ).toEqual([
        { number: 1, isDraft: false },
        { number: 2, isDraft: true },
      ]);
      expect(forge.prList(REPO, { state: "all", fields: ["number"] })).toEqual([
        { number: 1 },
        { number: 2 },
        { number: 3 },
      ]);
      expect(
        forge.prList(REPO, { state: "all", limit: 1, fields: ["number"] }),
      ).toEqual([{ number: 1 }]);
      expect(
        forge.prList(REPO, { state: "merged", fields: ["number"] }),
      ).toEqual([{ number: 3 }]);
    });

    test("prDiffFiles lists changed paths, one per entry, no blanks", () => {
      const { forge } = make();
      expect(forge.prDiffFiles(REPO, 1)).toEqual(["src/a.js", "src/b.js"]);
      expect(forge.prDiffFiles(REPO, 2)).toEqual([]);
      expect(() => forge.prDiffFiles(REPO, 999)).toThrow(ForgeError);
    });

    test("prSetDraft flips the draft flag both ways", () => {
      const { forge } = make();
      forge.prSetDraft(REPO, 1, true);
      expect(forge.prView(REPO, 1, { fields: ["isDraft"] })).toEqual({
        isDraft: true,
      });
      forge.prSetDraft(REPO, 1, false);
      expect(forge.prView(REPO, 1, { fields: ["isDraft"] })).toEqual({
        isDraft: false,
      });
      expect(() => forge.prSetDraft(REPO, 999, true)).toThrow(ForgeError);
    });

    test("prComment lands on the PR", () => {
      const { forge, seed } = make();
      forge.prComment(REPO, 2, "held: red handoff");
      expect(seed.repos[REPO].prs[1].comments).toEqual([
        { body: "held: red handoff" },
      ]);
      expect(() => forge.prComment(REPO, 999, "x")).toThrow(ForgeError);
    });

    test("prChecks returns the neutral name/bucket/state snapshot", () => {
      const { forge } = make();
      expect(forge.prChecks(REPO, 1)).toEqual([
        { name: "Verify", bucket: "pass", state: "SUCCESS" },
        { name: "docs", bucket: "pass", state: "SUCCESS" },
      ]);
      expect(forge.prChecks(REPO, 2, { fields: ["name", "bucket"] })).toEqual([
        { name: "Lint", bucket: "fail" },
        { name: "Verify", bucket: "pending" },
      ]);
      expect(forge.prChecks(REPO, 3)).toEqual([]);
      expect(() => forge.prChecks(REPO, 999)).toThrow(ForgeError);
      expect(() => forge.prChecks("nope/none", 1)).toThrow(ForgeError);
    });

    test("prChecks required:true returns only required checks, or []", () => {
      const { forge } = make();
      expect(forge.prChecks(REPO, 1, { required: true })).toEqual([
        { name: "Verify", bucket: "pass", state: "SUCCESS" },
      ]);
      expect(forge.prChecks(REPO, 3, { required: true })).toEqual([]);
    });

    test("runList filters by branch, created and limit; returns requested fields", () => {
      const { forge } = make();
      expect(
        forge.runList(REPO, {
          branch: "main",
          fields: ["databaseId", "status"],
        }),
      ).toEqual([
        { databaseId: 11, status: "completed" },
        { databaseId: 12, status: "queued" },
      ]);
      expect(
        forge.runList(REPO, {
          branch: "main",
          created: ">=2026-08-15",
          fields: ["databaseId"],
        }),
      ).toEqual([{ databaseId: 12 }]);
      expect(forge.runList(REPO, { limit: 1, fields: ["databaseId"] })).toEqual(
        [{ databaseId: 11 }],
      );
      expect(() => forge.runList("nope/none", {})).toThrow(ForgeError);
    });

    test("apiRaw returns the body as text; jq narrows it; unknown path throws", () => {
      const { forge } = make();
      expect(JSON.parse(forge.apiRaw("orgs/acme/actions/runners"))).toEqual({
        runners: [{ id: 1 }, { id: 2 }],
      });
      expect(
        forge.apiRaw("orgs/acme/actions/runners", { jq: ".runners | length" }),
      ).toBe("2");
      expect(() => forge.apiRaw("orgs/acme/nothing")).toThrow(ForgeError);
    });
  });
}

describe("github forge: REST PR reads", () => {
  const recorder = (result = { status: 0, stdout: "[]", stderr: "" }) => {
    const exec = (cmd, args, opts) => {
      exec.calls.push({ cmd, args, opts });
      return typeof result === "function" ? result(cmd, args, opts) : result;
    };
    exec.calls = [];
    return exec;
  };

  test("prView and prList use REST endpoints and resolve a cwd repo once", () => {
    const pull = {
      number: 7,
      state: "open",
      draft: false,
      title: "REST PR",
      body: "Fixes WM-7",
      html_url: "https://github.com/o/r/pull/7",
      labels: [{ name: "perf" }],
      head: { ref: "feat/rest", sha: "abc123" },
      base: { ref: "develop" },
      mergeable: true,
      mergeable_state: "clean",
    };
    const exec = recorder((_, args) => {
      if (args[0] === "repo")
        return {
          status: 0,
          stdout: JSON.stringify({ nameWithOwner: "o/r" }),
          stderr: "",
        };
      if (args[1] === "repos/o/r/pulls/7")
        return { status: 0, stdout: JSON.stringify(pull), stderr: "" };
      if (args[1]?.startsWith("repos/o/r/pulls?"))
        return {
          status: 0,
          stdout: JSON.stringify([
            { ...pull, mergeable: undefined, mergeable_state: undefined },
          ]),
          stderr: "",
        };
      if (args[1] === "repos/o/r/commits/abc123/check-runs?per_page=100")
        return {
          status: 0,
          stdout: JSON.stringify({
            check_runs: [
              {
                name: "Verify",
                conclusion: "success",
                status: "completed",
                started_at: "2026-08-30T02:18:51Z",
                app: { id: 15368 },
              },
              {
                name: "Verify",
                conclusion: "failure",
                status: "completed",
                started_at: "2026-08-30T02:18:31Z",
                app: { id: 15368 },
              },
              {
                name: "Verify",
                conclusion: "failure",
                status: "completed",
                started_at: "2026-08-30T02:10:00Z",
                app: { id: 999 },
              },
              { name: "Lint", conclusion: "failure", status: "completed" },
              { name: "Old", conclusion: "stale", status: "completed" },
              {
                name: "Boot",
                conclusion: "startup_failure",
                status: "completed",
              },
              {
                name: "Stopped",
                conclusion: "cancelled",
                status: "completed",
              },
            ],
          }),
          stderr: "",
        };
      if (args[1] === "repos/o/r/commits/abc123/status")
        return {
          status: 0,
          stdout: JSON.stringify({
            statuses: [{ context: "deploy", state: "success" }],
          }),
          stderr: "",
        };
      if (
        args[1] ===
        "repos/o/r/branches/develop/protection/required_status_checks"
      )
        return {
          status: 0,
          stdout: JSON.stringify({
            contexts: ["Verify", "deploy"],
            checks: [{ context: "Verify", app_id: 15368 }],
          }),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    });
    const forge = githubForge({ exec });
    expect(
      forge.prView(null, 7, { fields: ["state", "headRefName"], cwd: "/repo" }),
    ).toEqual({
      state: "OPEN",
      headRefName: "feat/rest",
    });
    expect(
      forge.prList(null, {
        state: "open",
        limit: 15,
        fields: ["number", "url"],
        cwd: "/repo",
      }),
    ).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7" }]);
    expect(
      forge.prList("o/r", {
        state: "closed",
        limit: 1,
        fields: ["number", "mergeable", "mergeStateStatus"],
      }),
    ).toEqual([
      { number: 7, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
    ]);
    expect(forge.prChecks("o/r", 7)).toEqual([
      { name: "Verify", bucket: "pass", state: "SUCCESS" },
      { name: "Verify", bucket: "fail", state: "FAILURE" },
      { name: "Lint", bucket: "fail", state: "FAILURE" },
      { name: "Old", bucket: "fail", state: "STALE" },
      { name: "Boot", bucket: "fail", state: "STARTUP_FAILURE" },
      { name: "Stopped", bucket: "cancel", state: "CANCELLED" },
      { name: "deploy", bucket: "pass", state: "SUCCESS" },
    ]);
    expect(forge.prChecks("o/r", 7, { required: true })).toEqual([
      { name: "Verify", bucket: "pass", state: "SUCCESS" },
      { name: "deploy", bucket: "pass", state: "SUCCESS" },
    ]);
    expect(exec.calls.filter((call) => call.args[0] === "repo")).toHaveLength(
      1,
    );
    expect(exec.calls.map((call) => call.args)).toContainEqual([
      "api",
      "repos/o/r/pulls/7",
    ]);
    expect(exec.calls.map((call) => call.args)).toContainEqual([
      "api",
      "repos/o/r/pulls?state=open&per_page=15&page=1",
    ]);
    expect(exec.calls.some((call) => call.args[0] === "pr")).toBe(false);
  });

  test("prDiffFiles / prSetDraft / prComment / runList / apiRaw shapes", () => {
    const exec = recorder({ status: 0, stdout: "", stderr: "" });
    const forge = githubForge({ exec });
    forge.prDiffFiles(null, "42", { cwd: "/repo" });
    forge.prSetDraft("o/r", 42, true, { timeout: 5000 });
    forge.prSetDraft("o/r", 42, false);
    forge.prComment("o/r", 42, "why");
    forge.apiRaw("orgs/acme/actions/runners", { jq: ".x" });
    forge.apiRaw("orgs/acme/actions/cache/usage-by-repository?per_page=100");
    expect(exec.calls.map((c) => c.args)).toEqual([
      ["pr", "diff", "42", "--name-only"],
      ["pr", "ready", "--undo", "42", "--repo", "o/r"],
      ["pr", "ready", "42", "--repo", "o/r"],
      ["pr", "comment", "42", "--repo", "o/r", "--body", "why"],
      ["api", "orgs/acme/actions/runners", "--jq", ".x"],
      ["api", "orgs/acme/actions/cache/usage-by-repository?per_page=100"],
    ]);
    expect(exec.calls[1].opts.timeout).toBe(5000);

    const exec2 = recorder();
    githubForge({ exec: exec2 }).runList("o/r", {
      branch: "main",
      created: ">=2026-08-01",
      limit: 200,
      fields: ["databaseId", "status"],
    });
    githubForge({ exec: exec2 }).runList("o/r", {
      limit: 10,
      fields: ["status"],
    });
    expect(exec2.calls.map((c) => c.args)).toEqual([
      [
        "run",
        "list",
        "--repo",
        "o/r",
        "--branch",
        "main",
        "--created",
        ">=2026-08-01",
        "--limit",
        "200",
        "--json",
        "databaseId,status",
      ],
      ["run", "list", "--repo", "o/r", "--limit", "10", "--json", "status"],
    ]);
  });

  test("gh spawns default to a validated timeout and preserve call overrides", () => {
    const exec = recorder({ status: 0, stdout: "", stderr: "" });
    const forge = githubForge({
      exec,
      env: { FACTORY_GH_TIMEOUT_MS: "45000" },
    });
    forge.prSetDraft("o/r", 42, false);
    forge.prSetDraft("o/r", 42, true, { timeout: 5000 });
    expect(exec.calls.map((call) => call.opts.timeout)).toEqual([45000, 5000]);
    expect(exec.calls.map((call) => call.opts.killSignal)).toEqual([
      "SIGKILL",
      "SIGKILL",
    ]);

    const defaults = recorder({ status: 0, stdout: "", stderr: "" });
    githubForge({ exec: defaults, env: {} }).prSetDraft("o/r", 42, false);
    expect(defaults.calls[0].opts.timeout).toBe(30_000);
  });

  test("invalid FACTORY_GH_TIMEOUT_MS warns and timed-out gh maps to forge_timeout", () => {
    const warnings = [];
    const exec = recorder({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    });
    const forge = githubForge({
      exec,
      env: { FACTORY_GH_TIMEOUT_MS: "not-a-number" },
      warn: (message) => warnings.push(message),
    });
    let err;
    try {
      forge.prSetDraft("o/r", 42, false);
    } catch (cause) {
      err = cause;
    }
    expect(warnings).toEqual([
      'Invalid FACTORY_GH_TIMEOUT_MS="not-a-number"; using default 30000ms',
    ]);
    expect(exec.calls[0].opts.timeout).toBe(30_000);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.code).toBe("forge_timeout");
    expect(err.message).toBe("gh pr timed out after 30000ms");
  });

  test("prChecks required:true treats 401/403 on branch protection like 404 (App token)", () => {
    const protection = (stderr) =>
      recorder((_, args) => {
        if (args[1] === "repos/o/r/pulls/7")
          return {
            status: 0,
            stdout: JSON.stringify({
              head: { sha: "abc123" },
              base: { ref: "develop" },
            }),
            stderr: "",
          };
        if (args[1]?.startsWith("repos/o/r/commits/abc123/check-runs"))
          return {
            status: 0,
            stdout: JSON.stringify({
              check_runs: [
                { name: "Verify", conclusion: "success", status: "completed" },
              ],
            }),
            stderr: "",
          };
        if (args[1] === "repos/o/r/commits/abc123/status")
          return {
            status: 0,
            stdout: JSON.stringify({ statuses: [] }),
            stderr: "",
          };
        if (args[1]?.includes("/protection/required_status_checks"))
          return { status: 1, stdout: "", stderr };
        return { status: 1, stdout: "", stderr: "unexpected endpoint" };
      });
    for (const stderr of [
      "gh: Resource not accessible by integration (HTTP 403)",
      "gh: Bad credentials (HTTP 401)",
      "gh: Branch not protected (HTTP 404)",
    ]) {
      const exec = protection(stderr);
      expect(
        githubForge({ exec }).prChecks("o/r", 7, { required: true }),
      ).toEqual([]);
      expect(
        exec.calls.some((call) =>
          call.args[1]?.includes("/protection/required_status_checks"),
        ),
      ).toBe(true);
    }
    expect(() =>
      githubForge({
        exec: protection("gh: Server Error (HTTP 500)"),
      }).prChecks("o/r", 7, { required: true }),
    ).toThrow(ForgeError);
  });

  test("prList hydrates mergeability at most once per open head SHA per TTL", () => {
    const rows = [
      { number: 1, state: "open", head: { sha: "s1" } },
      { number: 2, state: "open", head: { sha: "s2" } },
      { number: 3, state: "closed", merged_at: null, head: { sha: "s3" } },
      {
        number: 4,
        state: "closed",
        merged_at: "2026-08-30T00:00:00Z",
        head: { sha: "s4" },
      },
    ];
    let clock = 1_000;
    const exec = recorder((_, args) => {
      if (args[1]?.startsWith("repos/o/r/pulls?"))
        return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
      const detail = /^repos\/o\/r\/pulls\/(\d+)$/.exec(args[1] ?? "");
      if (detail)
        return {
          status: 0,
          stdout: JSON.stringify({
            ...rows[Number(detail[1]) - 1],
            mergeable: true,
            mergeable_state: "clean",
          }),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "unexpected endpoint" };
    });
    const detailCalls = () =>
      exec.calls.filter((call) =>
        /^repos\/o\/r\/pulls\/\d+$/.test(call.args[1]),
      ).length;
    const forge = githubForge({
      exec,
      hydrationTtlMs: 60_000,
      now: () => clock,
    });
    const list = () =>
      forge.prList("o/r", {
        state: "all",
        fields: ["number", "mergeable", "mergeStateStatus"],
      });
    expect(list()).toEqual([
      { number: 1, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
      { number: 2, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
      { number: 3, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      { number: 4, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    ]);
    // Only the open rows cost a detail call; a second scan in the same tick
    // costs none.
    expect(detailCalls()).toBe(2);
    list();
    expect(detailCalls()).toBe(2);
    // A rebase moves the head SHA: that one PR is re-hydrated.
    rows[1].head.sha = "s2-rebased";
    expect(list()[1]).toEqual({
      number: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(detailCalls()).toBe(3);
    // Past the TTL everything open is refreshed once more, and no more.
    clock += 60_000;
    list();
    list();
    expect(detailCalls()).toBe(5);
    // Bound for the reviewer's scenario: N open PRs, two scans per tick.
    expect(detailCalls()).toBeLessThanOrEqual(rows.length * 2);
  });

  test("prList does not pin an unknown (still computing) mergeability", () => {
    let known = false;
    const exec = recorder((_, args) => {
      if (args[1]?.startsWith("repos/o/r/pulls?"))
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 1, state: "open", head: { sha: "s1" } },
          ]),
          stderr: "",
        };
      if (args[1] === "repos/o/r/pulls/1")
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 1,
            state: "open",
            head: { sha: "s1" },
            mergeable: known ? false : null,
            mergeable_state: known ? "dirty" : "unknown",
          }),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "unexpected endpoint" };
    });
    const forge = githubForge({ exec });
    const list = () =>
      forge.prList("o/r", { state: "open", fields: ["mergeable"] });
    expect(list()).toEqual([{ mergeable: "UNKNOWN" }]);
    known = true;
    expect(list()).toEqual([{ mergeable: "CONFLICTING" }]);
    expect(list()).toEqual([{ mergeable: "CONFLICTING" }]);
    expect(
      exec.calls.filter((call) => call.args[1] === "repos/o/r/pulls/1"),
    ).toHaveLength(2);
  });

  test("prChecks keeps matrix siblings of the newest check suite, drops older suites", () => {
    const exec = recorder((_, args) => {
      if (args[1] === "repos/o/r/pulls/7")
        return {
          status: 0,
          stdout: JSON.stringify({ head: { sha: "abc123" } }),
          stderr: "",
        };
      if (args[1]?.startsWith("repos/o/r/commits/abc123/check-runs"))
        return {
          status: 0,
          stdout: JSON.stringify({
            check_runs: [
              {
                name: "test",
                conclusion: "success",
                status: "completed",
                started_at: "2026-08-30T02:20:00Z",
                app: { id: 15368 },
                check_suite: { id: 2 },
              },
              {
                name: "test",
                conclusion: "failure",
                status: "completed",
                started_at: "2026-08-30T02:19:00Z",
                app: { id: 15368 },
                check_suite: { id: 2 },
              },
              {
                name: "test",
                conclusion: "failure",
                status: "completed",
                started_at: "2026-08-30T02:00:00Z",
                app: { id: 15368 },
                check_suite: { id: 1 },
              },
              {
                name: "lint",
                conclusion: "success",
                status: "completed",
                started_at: "2026-08-30T02:00:00Z",
                app: { id: 15368 },
                check_suite: { id: 1 },
              },
            ],
          }),
          stderr: "",
        };
      if (args[1] === "repos/o/r/commits/abc123/status")
        return {
          status: 0,
          stdout: JSON.stringify({ statuses: [] }),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "unexpected endpoint" };
    });
    expect(githubForge({ exec }).prChecks("o/r", 7)).toEqual([
      { name: "test", bucket: "pass", state: "SUCCESS" },
      { name: "test", bucket: "fail", state: "FAILURE" },
      { name: "lint", bucket: "pass", state: "SUCCESS" },
    ]);
  });

  test("prList distinguishes REST's combined closed state from merged", () => {
    const exec = recorder((_, args) => {
      if (args[1]?.startsWith("repos/o/r/pulls?state=closed"))
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 8, state: "closed", merged_at: null },
            {
              number: 9,
              state: "closed",
              merged_at: "2026-08-30T00:00:00Z",
            },
          ]),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "unexpected endpoint" };
    });
    const forge = githubForge({ exec });
    expect(
      forge.prList("o/r", {
        state: "closed",
        fields: ["number", "state"],
      }),
    ).toEqual([{ number: 8, state: "CLOSED" }]);
    expect(
      forge.prList("o/r", { state: "merged", fields: ["number", "state"] }),
    ).toEqual([{ number: 9, state: "MERGED" }]);
  });

  test("prChecks paginates check runs and legacy statuses", () => {
    const runs = Array.from({ length: 101 }, (_, index) => ({
      name: `run-${index}`,
      status: "completed",
      conclusion: "success",
    }));
    const statuses = Array.from({ length: 31 }, (_, index) => ({
      context: `status-${index}`,
      state: "success",
    }));
    const exec = recorder((_, args) => {
      const endpoint = args[1];
      if (endpoint === "repos/o/r/pulls/7")
        return {
          status: 0,
          stdout: JSON.stringify({ head: { sha: "abc123" } }),
          stderr: "",
        };
      if (endpoint === "repos/o/r/commits/abc123/check-runs?per_page=100")
        return {
          status: 0,
          stdout: JSON.stringify({
            total_count: runs.length,
            check_runs: runs.slice(0, 100),
          }),
          stderr: "",
        };
      if (
        endpoint === "repos/o/r/commits/abc123/check-runs?per_page=100&page=2"
      )
        return {
          status: 0,
          stdout: JSON.stringify({
            total_count: runs.length,
            check_runs: runs.slice(100),
          }),
          stderr: "",
        };
      if (endpoint === "repos/o/r/commits/abc123/status")
        return {
          status: 0,
          stdout: JSON.stringify({
            total_count: statuses.length,
            statuses: statuses.slice(0, 30),
          }),
          stderr: "",
        };
      if (endpoint === "repos/o/r/commits/abc123/status?per_page=30&page=2")
        return {
          status: 0,
          stdout: JSON.stringify({
            total_count: statuses.length,
            statuses: statuses.slice(30),
          }),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "unexpected endpoint" };
    });
    const checks = githubForge({ exec }).prChecks("o/r", 7);
    expect(checks).toHaveLength(132);
    expect(checks[0]).toEqual({
      name: "run-0",
      bucket: "pass",
      state: "SUCCESS",
    });
    expect(checks.at(-1)).toEqual({
      name: "status-30",
      bucket: "pass",
      state: "SUCCESS",
    });
  });

  test("gh reads accept payloads over 1 MiB and surface ENOBUFS structurally", () => {
    const exec = recorder({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 7,
          state: "open",
          body: "x".repeat(1024 * 1024 + 1),
        },
      ]),
      stderr: "",
    });
    expect(
      githubForge({ exec }).prList("o/r", {
        fields: ["number"],
        limit: 1,
      }),
    ).toEqual([{ number: 7 }]);
    expect(exec.calls[0].opts.maxBuffer).toBe(64 * 1024 * 1024);

    const enobufs = githubForge({
      exec: recorder({
        status: null,
        stdout: null,
        stderr: null,
        error: Object.assign(new Error("spawnSync gh ENOBUFS"), {
          code: "ENOBUFS",
        }),
      }),
    });
    let err;
    try {
      enobufs.apiRaw("repos/o/r/pulls");
    } catch (cause) {
      err = cause;
    }
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.code).toBe("forge_read_failed");
    expect(err.stderr).toContain("ENOBUFS");
  });

  test("failure modes: non-zero exit, invalid JSON, spawn error, non-array list", () => {
    const failing = githubForge({
      exec: recorder({
        status: 1,
        stdout: "",
        stderr: "gh: not authenticated",
      }),
    });
    let err;
    try {
      failing.prList("o/r", { state: "open" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.status).toBe(1);
    expect(err.stderr).toBe("gh: not authenticated");

    const badJson = githubForge({
      exec: recorder({ status: 0, stdout: "not json", stderr: "" }),
    });
    expect(() => badJson.prView("o/r", 1, { fields: ["state"] })).toThrow(
      ForgeError,
    );

    const enoent = githubForge({
      exec: recorder({
        status: null,
        stdout: null,
        stderr: null,
        error: Object.assign(new Error("spawnSync gh ENOENT"), {
          code: "ENOENT",
        }),
      }),
    });
    try {
      enoent.apiRaw("x");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.status).toBeNull();
    expect(err.stderr).toContain("ENOENT");

    const notArray = githubForge({
      exec: recorder({ status: 0, stdout: "{}", stderr: "" }),
    });
    expect(() => notArray.prList("o/r", {})).toThrow(ForgeError);
    expect(() => notArray.runList("o/r", {})).toThrow(ForgeError);
    expect(() => notArray.prChecks("o/r", 1)).toThrow(ForgeError);
  });
});

describe("loadForge selection", () => {
  const withPolicy = (yaml) => {
    const root = mkdtempSync(path.join(tmpdir(), "forge-policy-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    if (yaml !== null)
      writeFileSync(path.join(root, "config", "policy.yaml"), yaml);
    return root;
  };

  test("defaults to github when the stanza is absent", () => {
    expect(
      forgeKindFromPolicy(withPolicy("merge:\n  max_fix_rounds: 2\n")),
    ).toBe("github");
  });

  test("falls back to config/policy.example.yaml, and fails closed when neither exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "forge-policy-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    expect(() => forgeKindFromPolicy(root)).toThrow(/policy\.yaml/);

    writeFileSync(
      path.join(root, "config", "policy.example.yaml"),
      "forge:\n  kind: memory\n",
    );
    expect(forgeKindFromPolicy(root)).toBe("memory");
    expect(loadForge({ root }).kind).toBe("memory");
  });

  test("selects memory from policy and passes the seed through", () => {
    const root = withPolicy("forge:\n  kind: memory\n");
    const forge = loadForge({ root, seed: freshSeed() });
    expect(forge.kind).toBe("memory");
    expect(forge.prList(REPO, { state: "open", fields: ["number"] })).toEqual([
      { number: 1 },
      { number: 2 },
    ]);
  });

  test("an unknown kind is a configuration error, not a silent github", () => {
    const root = withPolicy("forge:\n  kind: gitea\n");
    expect(() => loadForge({ root })).toThrow(/forge\.kind/);
    expect(() => loadForge({ kind: "gitea" })).toThrow(/unknown forge kind/);
  });

  test("explicit kind overrides policy; exec reaches the github impl", () => {
    const root = withPolicy("forge:\n  kind: memory\n");
    const calls = [];
    const forge = loadForge({
      root,
      kind: "github",
      exec: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });
    expect(forge.kind).toBe("github");
    forge.prList("o/r", { state: "open" });
    expect(calls).toEqual([
      ["gh", "api", "repos/o/r/pulls?state=open&per_page=30&page=1"],
    ]);
  });

  test("the repo's own policy.yaml selects github", () => {
    expect(loadForge().kind).toBe("github");
  });
});

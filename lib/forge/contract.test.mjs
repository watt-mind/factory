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
    if (positional[0] !== "api" && !data)
      return fail(
        `GraphQL: Could not resolve to a Repository with the name '${repo}'.`,
      );
    const fields = flags.json?.split(",");
    const pick = (o) =>
      fields ? Object.fromEntries(fields.map((f) => [f, o[f]])) : { ...o };
    const findPr = (n) => data.prs.find((p) => String(p.number) === n);

    switch (`${positional[0]} ${positional[1]}`) {
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
        if (hit === undefined) return fail("gh: Not Found (HTTP 404)");
        return ok(typeof hit === "function" ? hit({ jq: flags.jq }) : hit);
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

describe("github forge: gh argv shapes (byte-identical to the pre-forge call sites)", () => {
  const recorder = (result = { status: 0, stdout: "[]", stderr: "" }) => {
    const exec = (cmd, args, opts) => {
      exec.calls.push({ cmd, args, opts });
      return typeof result === "function" ? result(cmd, args, opts) : result;
    };
    exec.calls = [];
    return exec;
  };

  test("prView with and without --repo", () => {
    const exec = recorder({ status: 0, stdout: "{}", stderr: "" });
    const forge = githubForge({ exec });
    forge.prView("o/r", 7, { fields: ["state", "isDraft", "labels"] });
    forge.prView(null, 7, { fields: ["headRefName"], cwd: "/repo" });
    expect(exec.calls[0].cmd).toBe("gh");
    expect(exec.calls[0].args).toEqual([
      "pr",
      "view",
      "7",
      "--repo",
      "o/r",
      "--json",
      "state,isDraft,labels",
    ]);
    expect(exec.calls[1].args).toEqual([
      "pr",
      "view",
      "7",
      "--json",
      "headRefName",
    ]);
    expect(exec.calls[1].opts.cwd).toBe("/repo");
    expect(exec.calls[1].opts.encoding).toBe("utf8");
  });

  test("prList: janitor / stuck / queue-summary shapes", () => {
    const exec = recorder();
    const forge = githubForge({ exec });
    forge.prList(null, {
      state: "open",
      limit: 200,
      fields: ["number", "headRefName"],
      cwd: "/repo",
    });
    forge.prList("o/r", { state: "open", fields: ["number", "isDraft"] });
    forge.prList("o/r", {
      state: "all",
      limit: 250,
      fields: ["number", "url"],
    });
    expect(exec.calls.map((c) => c.args)).toEqual([
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,headRefName",
      ],
      [
        "pr",
        "list",
        "--repo",
        "o/r",
        "--state",
        "open",
        "--json",
        "number,isDraft",
      ],
      [
        "pr",
        "list",
        "--repo",
        "o/r",
        "--state",
        "all",
        "--limit",
        "250",
        "--json",
        "number,url",
      ],
    ]);
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

  test("prChecks argv, empty snapshots, and JSON-on-nonzero-exit", () => {
    const exec = recorder({
      status: 0,
      stdout: JSON.stringify([
        { name: "Verify", bucket: "pass", state: "SUCCESS" },
      ]),
      stderr: "",
    });
    const forge = githubForge({ exec });
    expect(forge.prChecks("o/r", 42)).toEqual([
      { name: "Verify", bucket: "pass", state: "SUCCESS" },
    ]);
    forge.prChecks(null, "7", {
      required: true,
      fields: ["name", "state"],
      cwd: "/repo",
    });
    expect(exec.calls.map((c) => c.args)).toEqual([
      ["pr", "checks", "42", "--repo", "o/r", "--json", "name,bucket,state"],
      ["pr", "checks", "7", "--required", "--json", "name,state"],
    ]);
    expect(exec.calls[1].opts.cwd).toBe("/repo");

    const empty = githubForge({
      exec: recorder({
        status: 1,
        stdout: "",
        stderr: "no checks reported on the 'feat/a' branch\n",
      }),
    });
    expect(empty.prChecks("o/r", 1)).toEqual([]);

    const noRequired = githubForge({
      exec: recorder({
        status: 1,
        stdout: "",
        stderr: "no required checks reported on the 'feat/a' branch\n",
      }),
    });
    expect(noRequired.prChecks("o/r", 1, { required: true })).toEqual([]);

    const red = githubForge({
      exec: recorder({
        status: 1,
        stdout: JSON.stringify([
          { name: "Lint", bucket: "fail", state: "FAILURE" },
        ]),
        stderr: "",
      }),
    });
    expect(red.prChecks("o/r", 1)).toEqual([
      { name: "Lint", bucket: "fail", state: "FAILURE" },
    ]);

    const missing = githubForge({
      exec: recorder({
        status: 1,
        stdout: "",
        stderr:
          "GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)",
      }),
    });
    expect(() => missing.prChecks("o/r", 999)).toThrow(ForgeError);
  });

  test("accepts Bun.spawnSync-shaped results (exitCode + Buffer stdout)", () => {
    const forge = githubForge({
      exec: () => ({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({ state: "OPEN" })),
      }),
    });
    expect(forge.prView("o/r", 1, { fields: ["state"] })).toEqual({
      state: "OPEN",
    });
    const failing = githubForge({
      exec: () => ({
        exitCode: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("boom"),
      }),
    });
    expect(() => failing.prView("o/r", 1)).toThrow(ForgeError);
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
      ["gh", "pr", "list", "--repo", "o/r", "--state", "open"],
    ]);
  });

  test("the repo's own policy.yaml selects github", () => {
    expect(loadForge().kind).toBe("github");
  });
});

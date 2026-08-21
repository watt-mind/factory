/**
 * GitHub Issues ControlPlane contract suite (WM-798).
 *
 * Same assertions as `event-runtime/lib/control-plane.test.mjs`, driven by a
 * fake `gh api` that serves a GitHub-shaped seed. A verb that would pass on
 * Linear/memory and fail here is an adapter bug.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlPlaneError } from "./types.mjs";
import { AGENT_READY_LABEL, IN_PROGRESS_LABEL } from "./labels.mjs";
import {
  githubControlPlane,
  githubPolicyStanza,
  parseIssueIdentifier,
  writeGithubControlPlanePolicy,
} from "./github.mjs";

const TEAM = "WM";
const REPO = "acme/widget";
const OTHER_REPO = "acme/other";
const PROJECT = "Factory";
const RAW_PING = "query { ping }";
const FACTORY = path.resolve(import.meta.dir, "../../bin/factory");
const CONFIG_EXAMPLES = path.resolve(import.meta.dir, "../../config");

const tmpDirs = [];
function tmp(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function copyConfigExamples(root) {
  const config = path.join(root, "config");
  mkdirSync(config, { recursive: true });
  for (const name of ["repos", "policy", "schedule"]) {
    copyFileSync(
      path.join(CONFIG_EXAMPLES, `${name}.example.yaml`),
      path.join(config, `${name}.example.yaml`),
    );
  }
  return config;
}

const STATUS_OPTIONS = [
  { id: "opt-triage", name: "Triage" },
  { id: "opt-todo", name: "Todo" },
  { id: "opt-progress", name: "In Progress" },
  { id: "opt-review", name: "In Review" },
  { id: "opt-done", name: "Done" },
  { id: "opt-blocked", name: "Blocked" },
];

function freshSeed() {
  return {
    viewer: { id: 1, login: "Ada", name: "Ada" },
    labels: [
      { id: 10, name: AGENT_READY_LABEL },
      { id: 11, name: IN_PROGRESS_LABEL },
      { id: 12, name: "agent:claude-code" },
      { id: 13, name: "agent:codex" },
      { id: 14, name: "type:bug" },
      { id: 15, name: "type:feature" },
      { id: 16, name: "ai:needs-review" },
      { id: 17, name: "source:agent" },
    ],
    repos: {
      [REPO]: { issues: [] },
      [OTHER_REPO]: { issues: [] },
    },
    project: {
      id: "PVT_1",
      title: PROJECT,
      field: {
        id: "FIELD_status",
        name: "Status",
        options: STATUS_OPTIONS,
      },
      items: [],
    },
    raw: { [RAW_PING]: { ping: true } },
    loseNextClaim: null,
  };
}

function addIssue(seed, repo, spec) {
  const bucket = seed.repos[repo] ?? (seed.repos[repo] = { issues: [] });
  const issue = {
    id: spec.id,
    node_id: spec.node_id,
    number: spec.number,
    title: spec.title,
    body: spec.body ?? "",
    html_url: `https://github.com/${repo}/issues/${spec.number}`,
    state: spec.state ?? "open",
    assignee: spec.assignee ?? null,
    labels: spec.labels ?? [],
    comments: spec.comments ?? [],
    pull_request: spec.pull_request,
  };
  bucket.issues.push(issue);
  if (spec.status) {
    seed.project.items.push({
      id: `PVTI_${spec.number}`,
      number: spec.number,
      repo,
      node_id: spec.node_id,
      status: spec.status,
    });
  }
  return issue;
}

function contractSeed() {
  const seed = freshSeed();
  addIssue(seed, REPO, {
    id: 101,
    node_id: "I_1",
    number: 1,
    title: "ready ticket",
    body: "## Owned Paths\n* lib/control-plane/**\n",
    labels: [{ id: 10, name: AGENT_READY_LABEL }],
    comments: [],
    status: "Todo",
  });
  addIssue(seed, REPO, {
    id: 102,
    node_id: "I_2",
    number: 2,
    title: "in progress ticket",
    assignee: { id: 99, login: "Other", name: "Other" },
    labels: [
      { id: 11, name: IN_PROGRESS_LABEL },
      { id: 12, name: "agent:claude-code" },
    ],
    comments: [
      {
        id: 201,
        body: "hello",
        created_at: "2026-08-19T10:00:00Z",
        user: { id: 99, login: "Other" },
      },
    ],
    status: "In Progress",
  });
  addIssue(seed, REPO, {
    id: 103,
    node_id: "I_3",
    number: 3,
    title: "todo but not agent-ready",
    labels: [{ id: 14, name: "type:bug" }],
    comments: [],
    status: "Todo",
  });
  addIssue(seed, OTHER_REPO, {
    id: 104,
    node_id: "I_4",
    number: 4,
    title: "other team ready",
    labels: [{ id: 10, name: AGENT_READY_LABEL }],
    comments: [],
    status: "Todo",
  });
  return seed;
}

function labelByName(seed, name) {
  return seed.labels.find((l) => l.name === name) ?? { name };
}

function projectNode(seed) {
  return {
    id: seed.project.id,
    title: seed.project.title,
    field: seed.project.field,
  };
}

function requireIssue(seed, repo, number) {
  const issue = seed.repos[repo]?.issues.find((i) => i.number === number);
  if (!issue)
    throw new ControlPlaneError("github api: Not Found", { status: 404 });
  return issue;
}

function fakeApi(seed) {
  const api = (method, pathName, { body, query } = {}) => {
    api.calls.push({ method, pathName, body, query });
    const [pathOnly, qs] = String(pathName).replace(/^\//, "").split("?");
    const q = {
      ...Object.fromEntries(new URLSearchParams(qs ?? "")),
      ...(query ?? {}),
    };

    const fail = (message, status = 400) => {
      throw new ControlPlaneError(message, { status });
    };

    if (pathOnly === "graphql") {
      const gqlQuery = body?.query ?? "";
      const variables = body?.variables ?? {};
      if (seed.raw?.[gqlQuery]) {
        const hit = seed.raw[gqlQuery];
        const data = typeof hit === "function" ? hit(variables) : hit;
        return { data };
      }
      if (gqlQuery.includes("FindRepoProject")) {
        return {
          data: {
            repository: {
              projectsV2: { nodes: [projectNode(seed)] },
            },
          },
        };
      }
      if (gqlQuery.includes("FindViewerProject")) {
        return {
          data: {
            viewer: { projectsV2: { nodes: [projectNode(seed)] } },
          },
        };
      }
      if (gqlQuery.includes("ProjectItems")) {
        return {
          data: {
            node: {
              items: {
                nodes: seed.project.items.map((it) => ({
                  id: it.id,
                  content: {
                    id: it.node_id,
                    number: it.number,
                    repository: { nameWithOwner: it.repo },
                  },
                  fieldValueByName: { name: it.status },
                })),
              },
            },
          },
        };
      }
      if (gqlQuery.includes("AddProjectItem")) {
        const contentId = variables.contentId;
        let found = null;
        for (const [repo, bucket] of Object.entries(seed.repos)) {
          const issue = bucket.issues.find((i) => i.node_id === contentId);
          if (issue) {
            found = { repo, issue };
            break;
          }
        }
        if (!found) fail(`no issue with node_id ${contentId}`);
        const item = {
          id: `PVTI_${found.issue.number}_${seed.project.items.length + 1}`,
          number: found.issue.number,
          repo: found.repo,
          node_id: found.issue.node_id,
          status: "Triage",
        };
        seed.project.items.push(item);
        return { data: { addProjectV2ItemById: { item: { id: item.id } } } };
      }
      if (gqlQuery.includes("SetProjectStatus")) {
        const item = seed.project.items.find(
          (it) => it.id === variables.itemId,
        );
        if (!item) fail(`no project item ${variables.itemId}`);
        const opt = seed.project.field.options.find(
          (o) => o.id === variables.optionId,
        );
        if (!opt) fail(`no status option ${variables.optionId}`);
        item.status = opt.name;
        return {
          data: {
            updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } },
          },
        };
      }
      fail("raw query not seeded");
    }

    if (pathOnly === "user" && method === "GET") return seed.viewer;

    const labelsMatch = pathOnly.match(/^repos\/([^/]+\/[^/]+)\/labels$/);
    if (labelsMatch && method === "GET") return seed.labels;

    const commentsMatch = pathOnly.match(
      /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/,
    );
    if (commentsMatch) {
      const issue = requireIssue(
        seed,
        commentsMatch[1],
        Number(commentsMatch[2]),
      );
      if (method === "GET") return issue.comments ?? [];
      if (method === "POST") {
        const comment = {
          id: 300 + (issue.comments?.length ?? 0),
          body: body.body,
          created_at: "2026-08-19T12:00:00Z",
          user: seed.viewer,
        };
        (issue.comments ??= []).push(comment);
        return comment;
      }
    }

    const labelsPut = pathOnly.match(
      /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/,
    );
    if (labelsPut && method === "PUT") {
      const issue = requireIssue(seed, labelsPut[1], Number(labelsPut[2]));
      const names = body.labels ?? body ?? [];
      issue.labels = names.map((n) => labelByName(seed, n));
      return issue.labels;
    }

    const oneIssue = pathOnly.match(/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
    if (oneIssue) {
      const repo = oneIssue[1];
      const number = Number(oneIssue[2]);
      if (method === "GET") return requireIssue(seed, repo, number);
      if (method === "PATCH") {
        const issue = requireIssue(seed, repo, number);
        if (body.body !== undefined) issue.body = body.body;
        if (body.state) issue.state = body.state;
        if (body.assignees) {
          if (body.assignees.length === 0) issue.assignee = null;
          else {
            const login = body.assignees[0];
            issue.assignee =
              login === seed.viewer.login
                ? { ...seed.viewer }
                : { id: 99, login, name: login };
          }
        }
        if (seed.loseNextClaim) {
          issue.assignee = { ...seed.loseNextClaim };
          seed.loseNextClaim = null;
        }
        return issue;
      }
    }

    const listOrCreate = pathOnly.match(/^repos\/([^/]+\/[^/]+)\/issues$/);
    if (listOrCreate) {
      const repo = listOrCreate[1];
      const bucket = seed.repos[repo] ?? (seed.repos[repo] = { issues: [] });
      if (method === "POST") {
        const number =
          Math.max(0, ...bucket.issues.map((i) => i.number), 0) + 1;
        const issue = {
          id: 1000 + number,
          node_id: `I_new_${number}`,
          number,
          title: body.title,
          body: body.body ?? "",
          html_url: `https://github.com/${repo}/issues/${number}`,
          state: "open",
          assignee: null,
          labels: (body.labels ?? []).map((n) => labelByName(seed, n)),
          comments: [],
        };
        bucket.issues.push(issue);
        return issue;
      }
      if (method === "GET") {
        let rows = bucket.issues.filter((i) => !i.pull_request);
        if (q.state === "open") rows = rows.filter((i) => i.state !== "closed");
        if (q.assignee === "none") rows = rows.filter((i) => !i.assignee);
        if (q.labels) {
          const needed = String(q.labels).split(",");
          rows = rows.filter((i) =>
            needed.every((n) => (i.labels ?? []).some((l) => l.name === n)),
          );
        }
        return rows;
      }
    }

    fail(`unknown github api ${method} ${pathName}`);
  };
  api.calls = [];
  return api;
}

function makePlane() {
  const seed = contractSeed();
  const cp = githubControlPlane({
    api: fakeApi(seed),
    repo: REPO,
    teams: { WM: REPO, CLNT: OTHER_REPO },
    project: PROJECT,
  });
  return { cp, seed };
}

describe("control-plane contract: github", () => {
  test("kind is github", () => {
    const { cp } = makePlane();
    expect(cp.kind).toBe("github");
  });

  test("getTicket returns the normalized ticket (flat labels, owner/repo#N)", async () => {
    const { cp } = makePlane();
    const t = await cp.getTicket(`${REPO}#1`);
    expect(t.identifier).toBe(`${REPO}#1`);
    expect(t.title).toBe("ready ticket");
    expect(t.labels).toEqual([{ id: "10", name: AGENT_READY_LABEL }]);
    expect(t.labels.nodes).toBeUndefined();
    expect(t.assignee).toBeNull();
    expect(t.state.name).toBe("Todo");
    expect(t.team.key).toBe(TEAM);
    expect(t.project.name).toBe(PROJECT);
  });

  test("getTicket on an unknown id throws ControlPlaneError", async () => {
    const { cp } = makePlane();
    let err;
    try {
      await cp.getTicket(`${REPO}#999`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.message).toMatch(/no such issue/i);
  });

  test("listComments returns the comment bodies", async () => {
    const { cp } = makePlane();
    expect(await cp.listComments(`${REPO}#2`)).toEqual([
      {
        id: "201",
        body: "hello",
        createdAt: "2026-08-19T10:00:00Z",
        user: { id: "99", name: "Other" },
      },
    ]);
    expect(await cp.listComments(`${REPO}#1`)).toEqual([]);
    await expect(cp.listComments(`${REPO}#999`)).rejects.toThrow(
      ControlPlaneError,
    );
  });

  test("listDispatchable is Todo + ai:agent-ready + unassigned, scoped to team", async () => {
    const { cp } = makePlane();
    const ready = await cp.listDispatchable({ team: TEAM });
    expect(ready.map((t) => t.identifier)).toEqual([`${REPO}#1`]);
    const factory = await cp.listDispatchable({
      team: TEAM,
      project: PROJECT,
    });
    expect(factory.map((t) => t.identifier)).toEqual([`${REPO}#1`]);
    const none = await cp.listDispatchable({
      team: TEAM,
      project: "Nope",
    });
    expect(none).toEqual([]);
    await expect(cp.listDispatchable({})).rejects.toThrow(ControlPlaneError);
  });

  test("claim moves to In Progress, assigns the viewer, swaps claim labels", async () => {
    const { cp } = makePlane();
    const result = await cp.claim(`${REPO}#1`);
    expect(result).toEqual({
      ok: true,
      identifier: `${REPO}#1`,
      assignee: "Ada",
    });
    const t = await cp.getTicket(`${REPO}#1`);
    expect(t.state.name).toBe("In Progress");
    expect(t.assignee).toEqual({ id: "1", name: "Ada" });
    const names = t.labels.map((l) => l.name).sort();
    expect(names).toContain(IN_PROGRESS_LABEL);
    expect(names).toContain("agent:claude-code");
    expect(names).not.toContain(AGENT_READY_LABEL);
  });

  test("claim reports a lost race instead of throwing", async () => {
    const { cp, seed } = makePlane();
    seed.loseNextClaim = { id: 99, login: "Other", name: "Other" };
    const result = await cp.claim(`${REPO}#1`);
    expect(result.ok).toBe(false);
    expect(result.assignee).toBe("Other");
  });

  test("comment lands on the ticket and is readable back", async () => {
    const { cp } = makePlane();
    await cp.comment(`${REPO}#1`, "working");
    const comments = await cp.listComments(`${REPO}#1`);
    expect(comments.map((c) => c.body)).toEqual(["working"]);
    await expect(cp.comment(`${REPO}#999`, "x")).rejects.toThrow(
      ControlPlaneError,
    );
    await expect(cp.comment(`${REPO}#1`, "")).rejects.toThrow(
      ControlPlaneError,
    );
  });

  test("setLabels keeps existing labels (complete-set, not a delta)", async () => {
    const { cp } = makePlane();
    await cp.setLabels(`${REPO}#1`, { add: ["type:bug"] });
    const names = (await cp.getTicket(`${REPO}#1`)).labels.map((l) => l.name);
    expect(names).toContain(AGENT_READY_LABEL);
    expect(names).toContain("type:bug");
    await cp.setLabels(`${REPO}#1`, { remove: [AGENT_READY_LABEL] });
    expect((await cp.getTicket(`${REPO}#1`)).labels.map((l) => l.name)).toEqual(
      ["type:bug"],
    );
  });

  test("setLabels rejects unknown type:* values before mutating", async () => {
    const { cp } = makePlane();
    await expect(
      cp.setLabels(`${REPO}#1`, { add: ["type:chore"] }),
    ).rejects.toThrow(/type:chore/);
    expect((await cp.getTicket(`${REPO}#1`)).labels.map((l) => l.name)).toEqual(
      [AGENT_READY_LABEL],
    );
  });

  test("transition moves Projects Status, can unassign, and rejects unknown states", async () => {
    const { cp } = makePlane();
    await cp.transition(`${REPO}#2`, "In Review", {
      add: ["ai:needs-review"],
      remove: [IN_PROGRESS_LABEL],
      unassign: true,
    });
    const t = await cp.getTicket(`${REPO}#2`);
    expect(t.state.name).toBe("In Review");
    expect(t.assignee).toBeNull();
    const names = t.labels.map((l) => l.name);
    expect(names).toContain("ai:needs-review");
    expect(names).not.toContain(IN_PROGRESS_LABEL);
    await expect(cp.transition(`${REPO}#2`, "DoesNotExist")).rejects.toThrow(
      ControlPlaneError,
    );
  });

  test("file creates a ticket in Triage with the requested labels", async () => {
    const { cp } = makePlane();
    const created = await cp.file({
      team: TEAM,
      title: "new finding",
      body: "saw this while doing WM-798",
      labels: ["type:feature", "source:agent"],
    });
    expect(created.identifier).toBe(`${REPO}#4`);
    expect(created.url).toBeTruthy();
    const t = await cp.getTicket(created.identifier);
    expect(t.title).toBe("new finding");
    expect(t.state.name).toBe("Triage");
    expect(t.labels.map((l) => l.name).sort()).toEqual([
      "source:agent",
      "type:feature",
    ]);
    await expect(cp.file({ team: TEAM })).rejects.toThrow(ControlPlaneError);
  });

  test("appendDetail is idempotent", async () => {
    const { cp } = makePlane();
    const first = await cp.appendDetail(
      `${REPO}#1`,
      "## Verification\n`bun test`",
    );
    expect(first.appended).toBe(true);
    const again = await cp.appendDetail(
      `${REPO}#1`,
      "## Verification\n`bun test`",
    );
    expect(again.appended).toBe(false);
    const t = await cp.getTicket(`${REPO}#1`);
    expect(t.description).toContain("## Owned Paths");
    expect(t.description).toContain("## Verification");
    expect(t.description.match(/## Verification/g)).toHaveLength(1);
  });

  test("raw is the escape hatch; unknown queries throw", async () => {
    const { cp } = makePlane();
    expect(await cp.raw(RAW_PING)).toEqual({ ping: true });
    await expect(cp.raw("query { nope }")).rejects.toThrow(ControlPlaneError);
  });
});

describe("github identifier and policy defaults", () => {
  test("parseIssueIdentifier accepts owner/repo#N and #N with a default repo", () => {
    expect(parseIssueIdentifier("acme/widget#42")).toEqual({
      repo: "acme/widget",
      number: 42,
    });
    expect(parseIssueIdentifier("#7", "acme/widget")).toEqual({
      repo: "acme/widget",
      number: 7,
    });
    expect(() => parseIssueIdentifier("WM-1")).toThrow(ControlPlaneError);
  });

  test("writeGithubControlPlanePolicy creates and merges policy.yaml", () => {
    const root = tmp("github-policy-");
    const created = writeGithubControlPlanePolicy(root, {
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });
    expect(created.controlPlane).toEqual(
      githubPolicyStanza({ repo: REPO, teams: { WM: REPO }, project: PROJECT }),
    );
    const parsed = Bun.YAML.parse(readFileSync(created.path, "utf8"));
    expect(parsed.controlPlane.kind).toBe("github");
    expect(parsed.controlPlane.github.repo).toBe(REPO);
    expect(parsed.controlPlane.github.project).toBe(PROJECT);

    writeFileSync(
      created.path,
      "merge:\n  max_fix_rounds: 2\ncontrolPlane:\n  kind: linear\n",
    );
    writeGithubControlPlanePolicy(root, { repo: REPO });
    const merged = Bun.YAML.parse(readFileSync(created.path, "utf8"));
    expect(merged.merge.max_fix_rounds).toBe(2);
    expect(merged.controlPlane.kind).toBe("github");
    expect(merged.controlPlane.github.repo).toBe(REPO);
  });

  test("githubControlPlane reads teams from policy.yaml", async () => {
    const root = tmp("github-root-");
    writeGithubControlPlanePolicy(root, {
      repo: REPO,
      teams: { WM: REPO },
    });
    const seed = contractSeed();
    const cp = githubControlPlane({ root, api: fakeApi(seed) });
    const ready = await cp.listDispatchable({ team: "WM" });
    expect(ready.map((t) => t.identifier)).toEqual([`${REPO}#1`]);
  });

  test("factory init --control-plane github writes policy defaults", () => {
    const root = tmp("github-init-");
    copyConfigExamples(root);
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        FACTORY,
        "init",
        "--control-plane",
        "github",
        "--root",
        root,
        "--repo",
        REPO,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("controlPlane.kind=github");
    const policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
    expect(policy.controlPlane.kind).toBe("github");
    expect(policy.controlPlane.github.repo).toBe(REPO);
    expect(policy.controlPlane.github.project).toBe("Factory");
    expect(policy.controlPlane.github.teams.DEMO).toBe(REPO);
  });

  test("factory init scaffolds tracked examples without overwriting local config", () => {
    const root = tmp("factory-init-");
    const config = copyConfigExamples(root);

    const command = ["bash", FACTORY, "init", "--root", root];
    const created = Bun.spawnSync({
      cmd: command,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(created.exitCode).toBe(0);
    expect(created.stdout.toString()).toContain("created config/repos.yaml");
    expect(created.stdout.toString()).toContain("created config/policy.yaml");
    expect(created.stdout.toString()).toContain("created config/schedule.yaml");

    const repos = path.join(config, "repos.yaml");
    writeFileSync(repos, "repos: []\n");
    const rerun = Bun.spawnSync({
      cmd: command,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout.toString()).toContain("exists  config/repos.yaml");
    expect(readFileSync(repos, "utf8")).toBe("repos: []\n");
  });
});

describe("github label write is a complete set", () => {
  test("setLabels PUT sends every remaining label, not just the add", async () => {
    const seed = contractSeed();
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
    });
    await cp.setLabels(`${REPO}#1`, { add: ["type:bug"] });
    const put = api.calls.find(
      (c) => c.method === "PUT" && String(c.pathName).includes("/labels"),
    );
    expect(put.body.labels.sort()).toEqual(
      [AGENT_READY_LABEL, "type:bug"].sort(),
    );
  });
});

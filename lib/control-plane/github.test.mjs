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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashJson } from "../../event-runtime/lib/canonical.mjs";
import { ControlPlaneError } from "./types.mjs";
import { loadControlPlane } from "./index.mjs";
import { AGENT_READY_LABEL, IN_PROGRESS_LABEL } from "./labels.mjs";
import {
  GITHUB_FACTORY_STATES,
  githubControlPlane,
  githubPolicyStanza,
  makeGhApi,
  parseIssueIdentifier,
  protocolLabelSpecs,
  provisionGithubRepo,
  writeGithubControlPlanePolicy,
} from "./github.mjs";
import { SOURCE_LABELS, TYPE_LABELS } from "./labels.mjs";

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
    collaboratorPermissions: {},
    closingPullRequests: {},
    closingPullRequestsHasNextPage: {},
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
    author_association: spec.authorAssociation,
    user: spec.authorLogin ? { login: spec.authorLogin } : undefined,
    created_at: spec.createdAt ?? "2026-08-19T09:00:00Z",
    updated_at: spec.updatedAt ?? spec.createdAt ?? "2026-08-19T09:00:00Z",
    // WM-879: chronological body-edit history, newest last. Each entry is
    // an editor login, or null to stand in for a ghost/deleted account.
    userContentEdits: spec.editedBy ?? [],
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
        const after = variables.after;
        const start = after ? Number(after) : 0;
        const page = seed.project.items.slice(start, start + 100);
        return {
          data: {
            node: {
              items: {
                nodes: page.map((it) => ({
                  id: it.id,
                  content: {
                    id: it.node_id,
                    number: it.number,
                    repository: { nameWithOwner: it.repo },
                  },
                  fieldValueByName: { name: it.status },
                })),
                pageInfo: {
                  hasNextPage: start + page.length < seed.project.items.length,
                  endCursor: String(start + page.length),
                },
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
      if (gqlQuery.includes("IssueLastEditor")) {
        const repoName = `${variables.owner}/${variables.name}`;
        const issue = seed.repos[repoName]?.issues.find(
          (i) => i.number === variables.number,
        );
        const edits = issue?.userContentEdits ?? [];
        return {
          data: {
            repository: {
              issue: {
                userContentEdits: {
                  nodes: edits.map((login) => ({
                    editor: login ? { login } : null,
                  })),
                },
              },
            },
          },
        };
      }
      if (gqlQuery.includes("IssueClosingPullRequests")) {
        const repoName = `${variables.owner}/${variables.name}`;
        requireIssue(seed, repoName, variables.number);
        return {
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes:
                    seed.closingPullRequests?.[
                      `${repoName}#${variables.number}`
                    ] ?? [],
                  pageInfo: {
                    hasNextPage: Boolean(
                      seed.closingPullRequestsHasNextPage?.[
                        `${repoName}#${variables.number}`
                      ],
                    ),
                  },
                },
              },
            },
          },
        };
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

    // Comment-by-id endpoint (no issue number): update/delete in place.
    const commentByIdMatch = pathOnly.match(
      /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/,
    );
    if (commentByIdMatch) {
      const cid = Number(commentByIdMatch[2]);
      for (const iss of seed.repos[commentByIdMatch[1]]?.issues ?? []) {
        const idx = (iss.comments ?? []).findIndex((c) => c.id === cid);
        if (idx >= 0) {
          if (method === "PATCH") {
            iss.comments[idx] = { ...iss.comments[idx], body: body.body };
            return iss.comments[idx];
          }
          if (method === "DELETE") {
            iss.comments.splice(idx, 1);
            return {};
          }
        }
      }
      return {};
    }

    const collabPerm = pathOnly.match(
      /^repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/,
    );
    if (collabPerm && method === "GET") {
      const permission =
        seed.collaboratorPermissions?.[collabPerm[1]]?.[collabPerm[2]];
      if (permission === undefined) fail("Not Found", 404);
      return { permission };
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
        const perPage = Number(q.per_page ?? 30);
        const page = Number(q.page ?? 1);
        return rows.slice((page - 1) * perPage, page * perPage);
      }
    }

    // WM-1008: issue dependencies. Seeded per issue as `blockedBy: [number]`;
    // a repo whose seed sets `noDependencies: true` answers 404, standing in
    // for a deployment where the endpoint is not available.
    const dep =
      /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(
        pathOnly,
      );
    if (dep && method === "GET") {
      const bucket = seed.repos[dep[1]] ?? { issues: [] };
      if (bucket.noDependencies) fail(`not found`, 404);
      const issue = bucket.issues.find((i) => i.number === Number(dep[2]));
      return (issue?.blockedBy ?? []).map((n) => {
        const target = bucket.issues.find((i) => i.number === n);
        return {
          number: n,
          state: target?.state ?? "open",
          repository: { full_name: dep[1] },
        };
      });
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

  test("hasOpenPullRequest uses a bounded repository-scoped closing-reference lookup", async () => {
    const { cp, seed } = makePlane();
    seed.closingPullRequests[`${REPO}#2`] = [
      { state: "OPEN", repository: { nameWithOwner: OTHER_REPO } },
      { state: "CLOSED", repository: { nameWithOwner: REPO } },
      { state: "OPEN", repository: { nameWithOwner: REPO } },
    ];
    expect(await cp.hasOpenPullRequest(`${REPO}#2`)).toBe(true);
    expect(await cp.hasOpenPullRequest(`${REPO}#1`)).toBe(false);
  });

  test("hasOpenPullRequest propagates transport failure so callers fail closed", async () => {
    const seed = contractSeed();
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      repo: REPO,
      teams: { WM: REPO },
      api(method, pathName, opts) {
        if (opts?.body?.query?.includes("IssueClosingPullRequests"))
          throw new Error("forge unavailable");
        return api(method, pathName, opts);
      },
    });
    await expect(cp.hasOpenPullRequest(`${REPO}#2`)).rejects.toThrow(
      /forge unavailable/,
    );
  });

  test("hasOpenPullRequest fails closed when the bounded edge is truncated", async () => {
    const { cp, seed } = makePlane();
    seed.closingPullRequestsHasNextPage[`${REPO}#2`] = true;
    await expect(cp.hasOpenPullRequest(`${REPO}#2`)).rejects.toThrow(
      /20-reference safety ceiling/,
    );
  });

  test("hasOpenPullRequest fails closed on an inconclusive response", async () => {
    const seed = contractSeed();
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      repo: REPO,
      teams: { WM: REPO },
      api(method, pathName, opts) {
        if (opts?.body?.query?.includes("IssueClosingPullRequests"))
          return { data: { repository: { issue: {} } } };
        return api(method, pathName, opts);
      },
    });
    await expect(cp.hasOpenPullRequest(`${REPO}#2`)).rejects.toThrow(
      /inconclusive response/,
    );
  });

  test("hasOpenPullRequest fails closed on malformed reference data", async () => {
    const seed = contractSeed();
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      repo: REPO,
      teams: { WM: REPO },
      api(method, pathName, opts) {
        if (opts?.body?.query?.includes("IssueClosingPullRequests"))
          return {
            data: {
              repository: {
                issue: {
                  closedByPullRequestsReferences: {
                    nodes: [null],
                    pageInfo: {},
                  },
                },
              },
            },
          };
        return api(method, pathName, opts);
      },
    });
    await expect(cp.hasOpenPullRequest(`${REPO}#2`)).rejects.toThrow(
      /inconclusive response/,
    );
  });

  test("loadControlPlane repoName binds GitHub to that repo entry", async () => {
    const root = tmp("github-repo-binding-");
    const config = path.join(root, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path.join(config, "policy.yaml"),
      [
        "controlPlane:",
        "  kind: linear",
        "  github:",
        `    repo: ${OTHER_REPO}`,
        "    teams:",
        `      ${TEAM}: ${OTHER_REPO}`,
        "    project: Wrong project",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(config, "repos.yaml"),
      [
        "repos:",
        "  - name: widget",
        "    path: /tmp/widget",
        `    github: ${REPO}`,
        `    team: ${TEAM}`,
        `    project: ${PROJECT}`,
        "    control_plane: github",
        "",
      ].join("\n"),
    );
    const seed = contractSeed();
    const cp = loadControlPlane({
      root,
      repoName: "widget",
      api: fakeApi(seed),
    });
    const tickets = await cp.listTickets({ team: TEAM, project: PROJECT });
    expect(tickets.map((ticket) => ticket.identifier)).toEqual([
      `${REPO}#1`,
      `${REPO}#2`,
      `${REPO}#3`,
    ]);
  });

  test("listTickets reads open issues only unless finished tickets are wanted (WM-1061)", async () => {
    const seed = contractSeed();
    // A closed issue whose board status is a stale "In Progress" — the exact
    // row the open-only read must never page in during a dispatch claim.
    addIssue(seed, REPO, {
      id: 105,
      node_id: "I_5",
      number: 5,
      title: "closed but board still says In Progress",
      state: "closed",
      labels: [{ id: 11, name: IN_PROGRESS_LABEL }],
      comments: [],
      status: "In Progress",
    });
    const inner = fakeApi(seed);
    const issueListStates = [];
    const api = (method, pathName, opts) => {
      if (method === "GET" && /\/issues$/.test(String(pathName).split("?")[0]))
        issueListStates.push(opts?.query?.state);
      return inner(method, pathName, opts);
    };
    const cp = githubControlPlane({
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
      api,
    });

    // Default (queue/in-flight) read: open only, and the closed row is absent.
    issueListStates.length = 0;
    const openTickets = await cp.listTickets({ team: TEAM, project: PROJECT });
    expect(issueListStates.every((s) => s === "open")).toBe(true);
    expect(openTickets.map((t) => t.identifier)).not.toContain(`${REPO}#5`);

    // includeFinished: pays for the closed backlog and surfaces the closed row.
    issueListStates.length = 0;
    const withFinished = await cp.listTickets({
      team: TEAM,
      project: PROJECT,
      includeFinished: true,
    });
    expect(issueListStates.every((s) => s === "all")).toBe(true);
    expect(withFinished.map((t) => t.identifier)).toContain(`${REPO}#5`);
  });

  test("loadControlPlane explicit kind does not require repo config", () => {
    const root = tmp("control-plane-explicit-kind-");
    expect(
      loadControlPlane({
        root,
        kind: "memory",
        repoName: "not-configured",
      }).kind,
    ).toBe("memory");
  });

  test("listTickets lists matching Triage and Todo items and fails closed on a project mismatch", async () => {
    const { cp } = makePlane();
    const tickets = await cp.listTickets({
      team: TEAM,
      project: PROJECT,
      states: ["Triage", "Todo"],
    });
    expect(tickets.map((t) => t.identifier)).toEqual([
      `${REPO}#1`,
      `${REPO}#3`,
    ]);
    await expect(
      cp.listTickets({ team: TEAM, project: "Nope" }),
    ).rejects.toThrow(/Project title mismatch.*Nope.*Factory/);
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
    await expect(
      cp.listDispatchable({ team: TEAM, project: "Nope" }),
    ).rejects.toThrow(/Project title mismatch.*Nope.*Factory/);
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

  // WM-1050: an open Todo issue whose closing PR already merged (the #1004 /
  // #1006 casualty) must not be claimed again. Instead the adapter reconciles
  // it to Done, drops the claim labels, leaves it unassigned, and records the
  // merged-PR evidence — and reports ok:false so the orchestrator skips it.
  test("claim reconciles an issue with a MERGED closing PR instead of dispatching it", async () => {
    const { cp, seed } = makePlane();
    seed.closingPullRequests[`${REPO}#1`] = [
      {
        state: "MERGED",
        number: 1006,
        url: `https://github.com/${REPO}/pull/1006`,
        repository: { nameWithOwner: REPO },
        mergeCommit: { oid: "2a19b48944f078ba81afef9b0d69b6b35bd23469" },
      },
    ];
    const result = await cp.claim(`${REPO}#1`);
    expect(result.ok).toBe(false);
    expect(result.identifier).toBe(`${REPO}#1`);
    expect(result.assignee).toBeNull();
    expect(result.why).toMatch(/1006/);

    const t = await cp.getTicket(`${REPO}#1`);
    expect(t.state.name).toBe("Done");
    expect(t.assignee).toBeNull();
    const names = t.labels.map((l) => l.name);
    expect(names).not.toContain(AGENT_READY_LABEL);
    expect(names).not.toContain(IN_PROGRESS_LABEL);
    expect(names.some((n) => n.startsWith("agent:"))).toBe(false);

    const comments = await cp.listComments(`${REPO}#1`);
    expect(comments.length).toBe(1);
    expect(comments[0].body).toMatch(/#1006/);
    expect(comments[0].body).toMatch(
      /2a19b48944f078ba81afef9b0d69b6b35bd23469/,
    );
  });

  test("claim proceeds normally when the closing PR is only OPEN", async () => {
    const { cp, seed } = makePlane();
    seed.closingPullRequests[`${REPO}#1`] = [
      {
        state: "OPEN",
        number: 1006,
        url: `https://github.com/${REPO}/pull/1006`,
        repository: { nameWithOwner: REPO },
        mergeCommit: null,
      },
    ];
    const result = await cp.claim(`${REPO}#1`);
    expect(result.ok).toBe(true);
    expect((await cp.getTicket(`${REPO}#1`)).state.name).toBe("In Progress");
  });

  test("claim ignores a MERGED closing PR that lives in another repository", async () => {
    const { cp, seed } = makePlane();
    seed.closingPullRequests[`${REPO}#1`] = [
      {
        state: "MERGED",
        number: 7,
        url: `https://github.com/${OTHER_REPO}/pull/7`,
        repository: { nameWithOwner: OTHER_REPO },
        mergeCommit: { oid: "deadbeef" },
      },
    ];
    const result = await cp.claim(`${REPO}#1`);
    expect(result.ok).toBe(true);
    expect((await cp.getTicket(`${REPO}#1`)).state.name).toBe("In Progress");
  });

  test("claim fails closed on a truncated closing-reference lookup and does not mutate the ticket", async () => {
    const { cp, seed } = makePlane();
    seed.closingPullRequestsHasNextPage[`${REPO}#1`] = true;
    await expect(cp.claim(`${REPO}#1`)).rejects.toThrow(
      /20-reference safety ceiling/,
    );
    const t = await cp.getTicket(`${REPO}#1`);
    expect(t.state.name).toBe("Todo");
    expect(t.assignee).toBeNull();
    expect(t.labels.map((l) => l.name)).toContain(AGENT_READY_LABEL);
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

describe("trusted-author + body-hash-pin gates (GH-879)", () => {
  test("getTicket surfaces authorAssociation; no edits means the author is the last editor", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 201,
      node_id: "I_201",
      number: 5,
      title: "never edited",
      authorAssociation: "MEMBER",
      authorLogin: "alice",
      labels: [],
      status: "Todo",
    });
    const cp = githubControlPlane({
      api: fakeApi(seed),
      repo: REPO,
      teams: { WM: REPO },
    });
    const t = await cp.getTicket(`${REPO}#5`);
    expect(t.controlPlaneKind).toBe("github");
    expect(t.authorAssociation).toBe("MEMBER");
    expect(t.lastEditorAssociation).toBe("MEMBER");
    expect(t.readyPinHash).toBeNull();
  });

  test("an edit by a different, permissioned collaborator resolves that editor's association", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 202,
      node_id: "I_202",
      number: 6,
      title: "edited by a collaborator",
      authorAssociation: "NONE",
      authorLogin: "stranger",
      editedBy: ["maintainer"],
      labels: [],
      status: "Todo",
    });
    seed.collaboratorPermissions[REPO] = { maintainer: "write" };
    const cp = githubControlPlane({
      api: fakeApi(seed),
      repo: REPO,
      teams: { WM: REPO },
    });
    const t = await cp.getTicket(`${REPO}#6`);
    expect(t.authorAssociation).toBe("NONE");
    expect(t.lastEditorAssociation).toBe("COLLABORATOR");
  });

  test("an edit by a non-collaborator, or a ghost editor, resolves to untrusted/unknown", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 203,
      node_id: "I_203",
      number: 7,
      title: "edited by an outsider",
      authorAssociation: "OWNER",
      authorLogin: "owner",
      editedBy: ["rando"],
      labels: [],
      status: "Todo",
    });
    addIssue(seed, REPO, {
      id: 204,
      node_id: "I_204",
      number: 8,
      title: "edited by a ghost",
      authorAssociation: "OWNER",
      authorLogin: "owner",
      editedBy: [null],
      labels: [],
      status: "Todo",
    });
    seed.collaboratorPermissions[REPO] = { rando: "read" };
    const cp = githubControlPlane({
      api: fakeApi(seed),
      repo: REPO,
      teams: { WM: REPO },
    });
    expect((await cp.getTicket(`${REPO}#7`)).lastEditorAssociation).toBe(
      "NONE",
    );
    expect((await cp.getTicket(`${REPO}#8`)).lastEditorAssociation).toBeNull();
  });

  test("only the LATEST edit decides the last editor", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 205,
      node_id: "I_205",
      number: 9,
      title: "edited twice",
      authorAssociation: "OWNER",
      authorLogin: "owner",
      editedBy: ["rando", "owner"],
      labels: [],
      status: "Todo",
    });
    const cp = githubControlPlane({
      api: fakeApi(seed),
      repo: REPO,
      teams: { WM: REPO },
    });
    expect((await cp.getTicket(`${REPO}#9`)).lastEditorAssociation).toBe(
      "OWNER",
    );
  });

  test("adding ai:agent-ready via transition() stamps a ready-pin comment", async () => {
    const { cp } = makePlane();
    await cp.transition(`${REPO}#3`, "Todo", { add: [AGENT_READY_LABEL] });
    const t = await cp.getTicket(`${REPO}#3`);
    expect(t.readyPinHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("adding ai:agent-ready via setLabels() stamps a ready-pin comment", async () => {
    const { cp } = makePlane();
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    const t = await cp.getTicket(`${REPO}#3`);
    expect(t.readyPinHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("adding an unrelated label does not stamp a pin", async () => {
    const { cp } = makePlane();
    await cp.setLabels(`${REPO}#3`, { add: ["type:bug"] });
    const t = await cp.getTicket(`${REPO}#3`);
    expect(t.readyPinHash).toBeNull();
  });

  test("a body edit after the pin makes readyPinHash stop matching the live description", async () => {
    const { cp, seed } = makePlane();
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    const pinned = (await cp.getTicket(`${REPO}#3`)).readyPinHash;
    requireIssue(seed, REPO, 3).body = "an attacker rewrote this body";
    const t = await cp.getTicket(`${REPO}#3`);
    expect(t.readyPinHash).toBe(pinned);
    expect(t.readyPinHash).not.toBe(hashJson(t.description));
  });

  test("re-labeling (setLabels again) refreshes the pin to match the new body", async () => {
    const { cp, seed } = makePlane();
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    requireIssue(seed, REPO, 3).body = "maintainer's legitimate edit";
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    const t = await cp.getTicket(`${REPO}#3`);
    expect(t.readyPinHash).toBe(hashJson(t.description));
  });

  test("re-labeling keeps exactly one pin comment (no blank-bubble duplicates)", async () => {
    const { cp, seed } = makePlane();
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    const pins = (requireIssue(seed, REPO, 3).comments ?? []).filter((c) =>
      /factory:ready-pin/.test(c.body),
    );
    expect(pins).toHaveLength(1);
    // The single pin carries a human-readable line, not a blank HTML comment.
    expect(pins[0].body).toContain("Queued for automated implementation");
  });

  test("prunes pre-existing duplicate pin comments down to one", async () => {
    const { cp, seed } = makePlane();
    const issue = requireIssue(seed, REPO, 3);
    issue.comments = [
      {
        id: 301,
        body: "<!-- factory:ready-pin sha256:" + "0".repeat(64) + " -->",
      },
      {
        id: 302,
        body: "<!-- factory:ready-pin sha256:" + "1".repeat(64) + " -->",
      },
    ];
    await cp.setLabels(`${REPO}#3`, { add: [AGENT_READY_LABEL] });
    const pins = (requireIssue(seed, REPO, 3).comments ?? []).filter((c) =>
      /factory:ready-pin/.test(c.body),
    );
    expect(pins).toHaveLength(1);
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

/**
 * WM-1046: `kind` in policy.yaml is the workspace DEFAULT every repo that
 * omits `control_plane:` in repos.yaml inherits. Init predates per-repo
 * selection (WM-1007) and always overwrote it — on a real multi-repo root
 * that moves every other repo's tracker, including client repos, off Linear.
 */
describe("github init on a multi-repo repos.yaml (WM-1046)", () => {
  function multiRepoFixture(root, { moveControlPlane = null } = {}) {
    const config = path.join(root, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path.join(config, "repos.yaml"),
      [
        "# Hand-maintained; every comment here must survive an init run.",
        "repos:",
        "  - name: bj29",
        "    path: ~/Develop/pets/bj29",
        "    github: watt-mind/bakonszegi-coaching",
        "    team: CLNT",
        "",
        "  - name: factory",
        "    path: ~/Develop/factory",
        `    github: ${REPO}`,
        "    icon: ph-robot",
        "    # control_plane: github",
        "    team: WM",
        "",
        "  - name: legalease",
        "    path: ~/Develop/pets/legalease",
        "    github: watt-mind/legalease",
        "    team: CLNT",
        "",
      ].join("\n"),
    );
    if (moveControlPlane) {
      writeGithubControlPlanePolicy(root, {
        repo: moveControlPlane,
        includeKind: false,
      });
    }
    return config;
  }

  test("regression: init moves the workspace default off a 3-repo root without --global", () => {
    const root = tmp("github-multi-repo-regression-");
    const config = multiRepoFixture(root);
    writeFileSync(
      path.join(config, "policy.yaml"),
      "controlPlane:\n  kind: linear\n",
    );
    const before = readFileSync(
      path.join(root, "config", "repos.yaml"),
      "utf8",
    );

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

    const policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
    // This is the regression this ticket fixes: on unfixed code, kind flips
    // to "github" here even though bj29/legalease never asked to move.
    expect(policy.controlPlane.kind).toBe("linear");
    expect(policy.controlPlane.github.repo).toBe(REPO);

    // repos.yaml only gained control_plane on the ONE matching entry — every
    // other byte, including comments, is untouched.
    const after = readFileSync(path.join(root, "config", "repos.yaml"), "utf8");
    expect(after).toBe(
      before.replace(
        "    # control_plane: github",
        "    control_plane: github",
      ),
    );
    const repos = Bun.YAML.parse(after).repos;
    expect(repos.find((r) => r.name === "factory").control_plane).toBe(
      "github",
    );
    expect(repos.find((r) => r.name === "bj29").control_plane).toBeUndefined();
    expect(
      repos.find((r) => r.name === "legalease").control_plane,
    ).toBeUndefined();
  });

  test("--global opts into moving the workspace default and prints who moves", () => {
    const root = tmp("github-multi-repo-global-");
    multiRepoFixture(root);

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
        "--global",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("bj29");
    expect(stdout).toContain("legalease");

    const policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
    expect(policy.controlPlane.kind).toBe("github");
  });

  test("a repos.yaml entry with 0-1 repos keeps today's behavior (kind still set)", () => {
    const root = tmp("github-single-repo-");
    const config = path.join(root, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path.join(config, "repos.yaml"),
      `repos:\n  - name: factory\n    path: ~/Develop/factory\n    github: ${REPO}\n`,
    );
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
    const policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
    expect(policy.controlPlane.kind).toBe("github");
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

// -------------------------------------------- init provisioning (WM-1009) ---
// The advertised quickstart is `gh auth login` + `factory init`. Before this,
// init only PRINTED the ~25 labels to create by hand, so the first file() call
// threw `label(s) do not exist` — the quickstart died on its first write.
describe("provisionGithubRepo", () => {
  const REPO2 = "acme/widget";

  /** A gh api fake with a controllable label set and project. */
  function provApi({ labels = [], project = null, failList = null } = {}) {
    const state = { labels: [...labels], created: [], calls: [] };
    const api = async (method, pathName, { body } = {}) => {
      state.calls.push({ method, pathName, body });
      if (method === "GET" && pathName === `repos/${REPO2}/labels`) {
        if (failList) throw new ControlPlaneError("Forbidden", { status: 403 });
        return state.labels.map((name) => ({ name }));
      }
      if (method === "POST" && pathName === `repos/${REPO2}/labels`) {
        if (state.labels.includes(body.name))
          throw new ControlPlaneError("already_exists", { status: 422 });
        state.labels.push(body.name);
        state.created.push(body);
        return { name: body.name };
      }
      if (pathName === "graphql") {
        return {
          repository: { projectsV2: { nodes: project ? [project] : [] } },
        };
      }
      throw new ControlPlaneError(`unexpected ${method} ${pathName}`, {
        status: 400,
      });
    };
    api.state = state;
    return api;
  }

  test("creates the full protocol label set on a fresh repo", async () => {
    const api = provApi();
    const report = await provisionGithubRepo(api, REPO2);
    const names = report.created;
    // Every label the protocol names, not a subset.
    for (const n of [
      "ai:agent-ready",
      "ai:in-progress",
      "ai:needs-review",
      "ai:blocked",
      "ai:escalated",
      "type:bug",
      "type:a11y",
      "source:agent",
      "source:client-support",
      "agent:claude-code",
      "priority:0",
      "priority:4",
    ]) {
      expect(names).toContain(n);
    }
    expect(report.existed).toEqual([]);
    // Colours and descriptions are set, not bare names.
    const created = api.state.created.find((l) => l.name === "ai:agent-ready");
    expect(created.color).toMatch(/^[0-9a-f]{6}$/);
    expect(created.description.length).toBeGreaterThan(0);
  });

  test("every type:* and source:* value the validator accepts is provisioned", () => {
    // Otherwise validateLabels() accepts a label that file() then rejects.
    const names = protocolLabelSpecs().map((s) => s.name);
    for (const t of TYPE_LABELS) expect(names).toContain(`type:${t}`);
    for (const src of SOURCE_LABELS) expect(names).toContain(`source:${src}`);
  });

  test("every literal label in an agent action-registry argv is provisioned", () => {
    // Action registries call ticket.mjs directly. A label missing here makes a
    // fresh GitHub control plane fail only when an unattended action runs.
    const agentDir = path.resolve(
      import.meta.dir,
      "../../event-runtime/agents",
    );
    const labelArgs = readdirSync(agentDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const agent = JSON.parse(
          readFileSync(path.join(agentDir, name), "utf8"),
        );
        return Object.values(agent.actionRegistry ?? {}).flatMap(
          (action) => action.argv ?? [],
        );
      })
      .filter(
        (arg) =>
          typeof arg === "string" &&
          /^(?:ai|agent|priority|source|tier|type):[a-z0-9-]+$/.test(arg),
      );
    const provisioned = new Set(protocolLabelSpecs().map((spec) => spec.name));

    for (const label of labelArgs) expect(provisioned).toContain(label);
  });

  test("is idempotent: a second run creates nothing", async () => {
    const api = provApi();
    await provisionGithubRepo(api, REPO2);
    const before = api.state.labels.length;
    const second = await provisionGithubRepo(api, REPO2);
    expect(second.created).toEqual([]);
    expect(second.existed.length).toBe(before);
    expect(api.state.labels.length).toBe(before);
  });

  test("leaves an existing label's colour and description alone", async () => {
    // A maintainer who recoloured type:bug meant it; reverting that on every
    // init would be a worse bug than the missing label this fixes.
    const api = provApi({ labels: ["type:bug"] });
    const report = await provisionGithubRepo(api, REPO2);
    expect(report.existed).toContain("type:bug");
    expect(report.created).not.toContain("type:bug");
    expect(api.state.created.some((l) => l.name === "type:bug")).toBe(false);
  });

  test("partial state: creates only what is missing", async () => {
    const api = provApi({ labels: ["ai:agent-ready", "type:bug"] });
    const report = await provisionGithubRepo(api, REPO2);
    expect(report.existed.sort()).toEqual(["ai:agent-ready", "type:bug"]);
    expect(report.created).not.toContain("ai:agent-ready");
    expect(report.created).toContain("ai:in-progress");
  });

  test("a concurrent creation (422) is success, not a failure", async () => {
    const api = provApi();
    // Simulate another init winning the race after our list, before our write.
    const original = api;
    let raced = false;
    const racing = async (method, pathName, opts) => {
      if (!raced && method === "POST" && pathName.endsWith("/labels")) {
        raced = true;
        throw new ControlPlaneError("already_exists", { status: 422 });
      }
      return original(method, pathName, opts);
    };
    await expect(provisionGithubRepo(racing, REPO2)).resolves.toBeDefined();
  });

  test("--dry-run reports the plan and writes nothing", async () => {
    const api = provApi();
    const report = await provisionGithubRepo(api, REPO2, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.created.length).toBeGreaterThan(20);
    expect(api.state.created).toEqual([]);
    expect(
      api.state.calls.some(
        (c) => c.method === "POST" && c.pathName.endsWith("/labels"),
      ),
    ).toBe(false);
  });

  test("a board with all Status options is accepted", async () => {
    const api = provApi({
      project: {
        id: "p1",
        title: "Factory",
        field: {
          id: "f1",
          name: "Status",
          options: GITHUB_FACTORY_STATES.map((name, i) => ({
            id: `o${i}`,
            name,
          })),
        },
      },
    });
    const report = await provisionGithubRepo(api, REPO2);
    expect(report.board.action).toBe("exists");
  });

  test("a board MISSING a Status option fails loudly, naming it", async () => {
    // Half-configured is the dangerous state: transition() to the missing
    // option would throw much later, inside an unattended loop, reading as a
    // tracker outage rather than a setup mistake.
    const api = provApi({
      project: {
        id: "p1",
        title: "Factory",
        field: {
          id: "f1",
          name: "Status",
          options: [
            { id: "o1", name: "Todo" },
            { id: "o2", name: "Done" },
          ],
        },
      },
    });
    await expect(provisionGithubRepo(api, REPO2)).rejects.toThrow(
      /missing option\(s\): Triage, In Progress, In Review, Blocked/,
    );
  });

  test("an absent board reports exactly what to create", async () => {
    const api = provApi();
    const report = await provisionGithubRepo(api, REPO2);
    expect(report.board.action).toBe("manual");
    for (const s of GITHUB_FACTORY_STATES)
      expect(report.board.hint).toContain(s);
  });

  test("a permission failure names the scope to add", async () => {
    const api = provApi({ failList: true });
    await expect(provisionGithubRepo(api, REPO2)).rejects.toThrow(
      /gh auth refresh -s repo/,
    );
  });

  test("the missing-label error names the command that fixes it", async () => {
    // Discoverability matters more than usual here: this fires inside
    // unattended loops, where the reader is a log, not a person at a prompt.
    const api = provApi();
    const cp = githubControlPlane({
      api: async (m, pth, o) => {
        if (m === "GET" && pth === `repos/${REPO2}/labels`) return [];
        return api(m, pth, o);
      },
      repo: REPO2,
      teams: { WM: REPO2 },
    });
    await expect(
      cp.file({ team: "WM", title: "x", labels: ["type:bug"] }),
    ).rejects.toThrow(
      /factory init --control-plane github --repo acme\/widget/,
    );
  });
});

// ------------------------------------------ request-count scaling (WM-1044) ---
// The live spike (WM-1012) measured 1 + N requests per listDispatchable — one
// dependency read for every OPEN issue, not every candidate. On the WM board
// (250+ open issues) that projects to ~251 requests per call and ~15,000/hr
// against a 5,000/hr limit: the factory would rate-limit itself within minutes
// of cutover and take merges and PR creation down with it, since they share the
// budget. Cost is the behaviour under test here, so assert the call count.
describe("GitHub issue and project-item pagination", () => {
  test("finds a ready Todo ticket and its project status beyond the first page", async () => {
    const seed = freshSeed();
    for (let number = 1; number <= 101; number += 1) {
      addIssue(seed, REPO, {
        id: 1000 + number,
        node_id: `I_${number}`,
        number,
        title: `ticket ${number}`,
        labels: number === 101 ? [{ id: 10, name: AGENT_READY_LABEL }] : [],
        status: number === 101 ? "Todo" : "Triage",
      });
    }
    // A duplicate can occur when a paginated source shifts while we read it;
    // issue numbers remain the stable identity for the adapter's output.
    seed.repos[REPO].issues.push({ ...seed.repos[REPO].issues[0] });

    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { [TEAM]: REPO },
      project: PROJECT,
    });

    const tickets = await cp.listTickets({ team: TEAM });
    expect(tickets).toHaveLength(101);
    expect(tickets.map((ticket) => ticket.identifier)).toContain(`${REPO}#101`);
    expect(
      (await cp.listDispatchable({ team: TEAM })).map(
        (ticket) => ticket.identifier,
      ),
    ).toContain(`${REPO}#101`);

    const issuePages = api.calls.filter(
      (call) =>
        call.method === "GET" && call.pathName === `repos/${REPO}/issues`,
    );
    expect(issuePages.map((call) => call.query.page)).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
    // Two pages, fetched once: the board read spans both pages (page 1 reports
    // another page, page 2 does not), and the short-TTL memo (WM-1067) lets the
    // back-to-back listDispatchable reuse that same read instead of paginating
    // the board a second time within the window.
    expect(
      api.calls.filter((call) =>
        String(call.body?.query ?? "").includes("ProjectItems"),
      ),
    ).toHaveLength(2);
  });
});

describe("listDispatchable request cost does not scale with open issues", () => {
  const REPO3 = "acme/widget";

  /** A repo with `total` open issues, of which `ready` are dispatchable. */
  function bigApi({ total, ready }) {
    const issues = [];
    for (let n = 1; n <= total; n += 1) {
      const isReady = n <= ready;
      issues.push({
        number: n,
        id: n,
        node_id: `N${n}`,
        title: `issue ${n}`,
        body: "",
        state: "open",
        assignee: null,
        created_at: "2026-01-01T00:00:00Z",
        labels: isReady ? [{ id: n, name: AGENT_READY_LABEL }] : [],
      });
    }
    const calls = [];
    const api = async (method, pathName, opts) => {
      calls.push(`${method} ${pathName}`);
      if (method === "GET" && pathName === `repos/${REPO3}/issues`) {
        const perPage = Number(opts?.query?.per_page ?? 30);
        const page = Number(opts?.query?.page ?? 1);
        return issues.slice((page - 1) * perPage, page * perPage);
      }
      if (pathName === "graphql") {
        // Two distinct GraphQL shapes: FIND_REPO_PROJECT (the board) and
        // PROJECT_ITEMS (its items, keyed off `node`).
        const q = String(opts?.body?.query ?? "");
        if (q.includes("projectsV2")) {
          return {
            repository: {
              projectsV2: {
                nodes: [
                  {
                    id: "p1",
                    title: "Factory",
                    field: {
                      id: "f1",
                      name: "Status",
                      options: GITHUB_FACTORY_STATES.map((name, i) => ({
                        id: `o${i}`,
                        name,
                      })),
                    },
                  },
                ],
              },
            },
          };
        }
        // Every issue sits in Todo.
        const start = opts?.body?.variables?.after
          ? Number(opts.body.variables.after)
          : 0;
        const page = issues.slice(start, start + 100);
        return {
          node: {
            items: {
              nodes: page.map((i) => ({
                id: `it${i.number}`,
                fieldValueByName: { name: "Todo" },
                content: {
                  number: i.number,
                  repository: { nameWithOwner: REPO3 },
                },
              })),
              pageInfo: {
                hasNextPage: start + page.length < issues.length,
                endCursor: String(start + page.length),
              },
            },
          },
        };
      }
      if (/\/dependencies\/blocked_by$/.test(pathName)) return [];
      throw new ControlPlaneError(`unexpected ${method} ${pathName}`, {
        status: 400,
      });
    };
    api.calls = calls;
    return api;
  }

  test("250 open issues with 5 ready costs a bounded number of requests", async () => {
    const api = bigApi({ total: 250, ready: 5 });
    const cp = githubControlPlane({
      api,
      repo: REPO3,
      teams: { WM: REPO3 },
      project: "Factory",
    });
    const ready = await cp.listDispatchable({ team: "WM" });
    expect(ready.length).toBe(5);

    const deps = api.calls.filter((c) => c.includes("/dependencies/"));
    // One per CANDIDATE, not one per open issue. Pre-fix this was 250.
    expect(deps.length).toBe(5);
    expect(api.calls.length).toBeLessThanOrEqual(15);
  });

  test("only issue and project pagination grow with the board", async () => {
    // Same 5 ready, 10x the issues: dependency requests stay candidate-bound.
    const small = bigApi({ total: 25, ready: 5 });
    const large = bigApi({ total: 250, ready: 5 });
    const mk = (api) =>
      githubControlPlane({
        api,
        repo: REPO3,
        teams: { WM: REPO3 },
        project: "Factory",
      });
    await mk(small).listDispatchable({ team: "WM" });
    await mk(large).listDispatchable({ team: "WM" });
    expect(large.calls.filter((c) => c.includes("/dependencies/")).length).toBe(
      small.calls.filter((c) => c.includes("/dependencies/")).length,
    );
    expect(large.calls.length).toBeGreaterThan(small.calls.length);
  });

  test("listTickets does not resolve blockers unless asked", async () => {
    const api = bigApi({ total: 50, ready: 50 });
    const cp = githubControlPlane({
      api,
      repo: REPO3,
      teams: { WM: REPO3 },
      project: "Factory",
    });
    const all = await cp.listTickets({ team: "WM" });
    expect(all.length).toBe(50);
    expect(api.calls.filter((c) => c.includes("/dependencies/")).length).toBe(
      0,
    );

    const api2 = bigApi({ total: 50, ready: 50 });
    const cp2 = githubControlPlane({
      api: api2,
      repo: REPO3,
      teams: { WM: REPO3 },
      project: "Factory",
    });
    await cp2.listTickets({ team: "WM", resolveBlockers: true });
    expect(api2.calls.filter((c) => c.includes("/dependencies/")).length).toBe(
      50,
    );
  });
});

// ------------------------------------------- Projects v2 board memo (WM-1067) -
// `projectItems` re-paginates the whole board over GraphQL and runs on the
// synchronous dispatch/queue path, so concurrent claims and status reads each
// used to pay their own full board fetch and block serve. A short-TTL memo lets
// them share ONE fetch. The behaviour under test is the underlying board read
// count, so assert it directly with an injected clock.
describe("Projects v2 board read is cached for a short TTL (WM-1067)", () => {
  const REPO4 = "acme/board";

  /** A one-issue board that counts how often the items query is issued. */
  function boardApi() {
    const issues = [
      {
        number: 1,
        id: 1,
        node_id: "N1",
        title: "issue 1",
        body: "",
        state: "open",
        assignee: null,
        created_at: "2026-01-01T00:00:00Z",
        labels: [],
      },
    ];
    const items = () => ({
      node: {
        items: {
          nodes: issues.map((i) => ({
            id: `it${i.number}`,
            fieldValueByName: { name: "Todo" },
            content: {
              number: i.number,
              repository: { nameWithOwner: REPO4 },
            },
          })),
        },
      },
    });
    const state = { boardReads: 0 };
    const calls = [];
    const api = async (method, pathName, opts) => {
      calls.push(`${method} ${pathName}`);
      if (method === "GET" && pathName === `repos/${REPO4}/issues`)
        return issues;
      if (/^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(pathName)) return issues[0];
      if (pathName === "graphql") {
        const q = String(opts?.body?.query ?? "");
        if (q.includes("projectsV2")) {
          return {
            repository: {
              projectsV2: {
                nodes: [
                  {
                    id: "p1",
                    title: "Factory",
                    field: {
                      id: "f1",
                      name: "Status",
                      options: GITHUB_FACTORY_STATES.map((name, i) => ({
                        id: `o${i}`,
                        name,
                      })),
                    },
                  },
                ],
              },
            },
          };
        }
        if (q.includes("ProjectItems")) {
          state.boardReads += 1;
          return items();
        }
        if (q.includes("SetProjectStatus"))
          return {
            updateProjectV2ItemFieldValue: { projectV2Item: { id: "it1" } },
          };
        throw new ControlPlaneError(`unexpected graphql ${q.slice(0, 24)}`);
      }
      throw new ControlPlaneError(`unexpected ${method} ${pathName}`, {
        status: 400,
      });
    };
    api.calls = calls;
    api.state = state;
    return api;
  }

  const mk = (api, now) =>
    githubControlPlane({
      api,
      now,
      repo: REPO4,
      teams: { WM: REPO4 },
      project: "Factory",
    });

  test("two board reads inside the window collapse to one fetch", async () => {
    const api = boardApi();
    const clock = { t: 1000 };
    const cp = mk(api, () => clock.t);

    await cp.listTickets({ team: "WM" });
    clock.t += 500; // still well inside the 3s window
    await cp.listTickets({ team: "WM" });

    expect(api.state.boardReads).toBe(1);
  });

  test("the board is refetched once the window has passed", async () => {
    const api = boardApi();
    const clock = { t: 1000 };
    const cp = mk(api, () => clock.t);

    await cp.listTickets({ team: "WM" });
    clock.t += 5000; // past the 3s TTL
    await cp.listTickets({ team: "WM" });

    expect(api.state.boardReads).toBe(2);
  });

  test("concurrent reads in the window share a single in-flight fetch", async () => {
    const api = boardApi();
    const clock = { t: 1000 };
    const cp = mk(api, () => clock.t);

    await Promise.all([
      cp.listTickets({ team: "WM" }),
      cp.listTickets({ team: "WM" }),
      cp.listTickets({ team: "WM" }),
    ]);

    expect(api.state.boardReads).toBe(1);
  });

  test("a status write invalidates the memo so the next read is fresh", async () => {
    const api = boardApi();
    const clock = { t: 1000 };
    const cp = mk(api, () => clock.t);

    await cp.listTickets({ team: "WM" }); // read 1, memo warm
    await cp.transition(`${REPO4}#1`, "In Progress"); // reuses memo, then writes
    await cp.listTickets({ team: "WM" }); // read 2 — must NOT serve stale memo

    // The write invalidates the memo, so the trailing list read refetches even
    // though it lands inside the TTL window. Without invalidation this would be
    // 1 (every read served from the pre-write memo).
    expect(api.state.boardReads).toBe(2);
  });
});

describe("makeGhApi GitHub App token injection (WM-1137)", () => {
  // A spawnSync-shaped fake that records the child options each `gh` call gets.
  function recordingExec() {
    const calls = [];
    const exec = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: "{}", stderr: "" };
    };
    exec.calls = calls;
    return exec;
  }

  function appEnv(dir) {
    return {
      PATH: "/usr/bin",
      FACTORY_GH_APP_ID: "42",
      FACTORY_GH_APP_INSTALLATION_ID: "9001",
      FACTORY_GH_APP_PRIVATE_KEY_PATH: "/does/not/matter.pem",
      FACTORY_GH_APP_TOKEN_FILE: path.join(dir, "gh-app-token.json"),
    };
  }

  test("with App env vars set and a fresh cached token, the gh child env gets GH_TOKEN", () => {
    const dir = tmp("gh-app-inject-");
    const env = appEnv(dir);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const exec = recordingExec();
    const api = makeGhApi(exec, { env });
    api("GET", "user");
    expect(exec.calls).toHaveLength(1);
    const childEnv = exec.calls[0].opts.env;
    expect(childEnv.GH_TOKEN).toBe("ghs_live");
    // The rest of the parent env is carried through unchanged.
    expect(childEnv.FACTORY_GH_APP_ID).toBe("42");
    expect(childEnv.PATH).toBe("/usr/bin");
  });

  test("no mint happens on the injection path — a fresh cache is read as-is", () => {
    const dir = tmp("gh-app-inject-");
    const env = appEnv(dir);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const before = readFileSync(env.FACTORY_GH_APP_TOKEN_FILE, "utf8");
    const exec = recordingExec();
    makeGhApi(exec, { env })("GET", "user");
    // The cache file is untouched — the spawn path only ever reads it.
    expect(readFileSync(env.FACTORY_GH_APP_TOKEN_FILE, "utf8")).toBe(before);
  });

  test("with App env vars ABSENT, the gh child env is unchanged (no GH_TOKEN added)", () => {
    const exec = recordingExec();
    // A parent env with no FACTORY_GH_APP_* vars: today's PAT path.
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    api("GET", "user");
    expect(exec.calls).toHaveLength(1);
    // The child options carry no `env` override at all — exec runs exactly as
    // it did before this feature.
    expect("env" in exec.calls[0].opts).toBe(false);
  });

  test("a configured-but-broken token resolution logs one warning and falls back cleanly", () => {
    const dir = tmp("gh-app-inject-");
    // Configured, but no token file written — resolution throws internally.
    const env = appEnv(dir);
    const warnings = [];
    const orig = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const exec = recordingExec();
      const api = makeGhApi(exec, { env });
      api("GET", "user"); // call 1
      api("GET", "user"); // call 2 — must not re-warn
      // Both gh calls still ran, with no GH_TOKEN injected (env untouched).
      expect(exec.calls).toHaveLength(2);
      expect("env" in exec.calls[0].opts).toBe(false);
      expect("env" in exec.calls[1].opts).toBe(false);
    } finally {
      console.warn = orig;
    }
    // Exactly one warning across both calls, and it never contains a token.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("ghs_");
  });
});

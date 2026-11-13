/**
 * GitHub Issues ControlPlane contract suite (WM-798).
 *
 * Same assertions as `event-runtime/lib/control-plane.test.mjs`, driven by a
 * fake `gh api` that serves a GitHub-shaped seed. A verb that would pass on
 * Linear/memory and fail here is an adapter bug.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
import {
  AGENT_READY_LABEL,
  clampGithubBody,
  GITHUB_BODY_MAX_LENGTH,
  IN_PROGRESS_LABEL,
} from "./labels.mjs";
import {
  GITHUB_FACTORY_STATES,
  ghSpawn,
  githubControlPlane,
  githubPolicyStanza,
  makeGhApi,
  parseIssueIdentifier,
  protocolLabelSpecs,
  provisionGithubRepo,
  writeGithubControlPlanePolicy,
} from "./github.mjs";
import {
  retryControlPlaneMutation,
  setLabelsWithRetry,
  transitionThenComment,
} from "../../tools/ticket.mjs";
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
      if (gqlQuery.includes("ViewerIdentity")) {
        if (seed.viewerIdentityFails)
          fail("github graphql timed out after 15000ms", 504);
        return {
          data: {
            // GraphQL shape: `databaseId` is the REST numeric user id, and
            // `seed.viewerIdentity` stands in for an App installation token,
            // whose viewer is the `<slug>[bot]` account.
            viewer: seed.viewerIdentity ?? {
              login: seed.viewer.login,
              databaseId: seed.viewer.id,
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

    if (pathOnly === "search/issues" && method === "GET") {
      // Honour the query the way GitHub search does: every `repo:` qualifier
      // widens the scope (so a smuggled second qualifier would leak hits from
      // another repository), and quoted `in:title` / `in:body` terms narrow
      // it to issues containing that literal text.
      const text = String(q.q ?? "");
      const unquoted = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const repos = [...unquoted.matchAll(/(?:^|\s)repo:([^\s"]+)/g)].map(
        (m) => m[1],
      );
      if (repos.length === 0) fail(`search/issues without repo: ${text}`);
      const quoted = (field) => {
        const m = new RegExp(`in:${field} "((?:[^"\\\\]|\\\\.)*)"`).exec(text);
        return m ? JSON.parse(`"${m[1]}"`) : null;
      };
      const wantTitle = quoted("title");
      const wantBody = quoted("body");
      const rows = repos.flatMap((repo) =>
        (seed.repos[repo]?.issues ?? [])
          .filter(
            (issue) =>
              !issue.pull_request &&
              (wantTitle === null || issue.title.includes(wantTitle)) &&
              (wantBody === null || issue.body.includes(wantBody)),
          )
          .map((issue) => ({
            ...issue,
            repository_url: `https://api.github.com/repos/${repo}`,
          })),
      );
      return { items: rows.slice(0, Number(q.per_page ?? 30)) };
    }

    const labelsMatch = pathOnly.match(/^repos\/([^/]+\/[^/]+)\/labels$/);
    if (labelsMatch && method === "GET") {
      const perPage = Number(q.per_page ?? 30);
      const page = Number(q.page ?? 1);
      return seed.labels.slice((page - 1) * perPage, page * perPage);
    }

    const commentsMatch = pathOnly.match(
      /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/,
    );
    if (commentsMatch) {
      const issue = requireIssue(
        seed,
        commentsMatch[1],
        Number(commentsMatch[2]),
      );
      if (method === "GET") {
        const perPage = Number(q.per_page ?? 30);
        const page = Number(q.page ?? 1);
        return (issue.comments ?? []).slice(
          (page - 1) * perPage,
          page * perPage,
        );
      }
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
  const api = fakeApi(seed);
  const cp = githubControlPlane({
    api,
    repo: REPO,
    teams: { WM: REPO, CLNT: OTHER_REPO },
    project: PROJECT,
  });
  return { api, cp, seed };
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

  test("getTicketTitle reads title and url in one REST call (#2058)", async () => {
    const { cp, api } = makePlane();
    api.calls.length = 0;
    const t = await cp.getTicketTitle(`${REPO}#1`);
    expect(t).toEqual({
      identifier: `${REPO}#1`,
      title: "ready ticket",
      url: expect.any(String),
    });
    // The whole point of the verb: no Projects status read, no edit-history
    // query, no ready-pin read -- those made getTicket cost ~8s per ticket.
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      method: "GET",
      pathName: `repos/${REPO}/issues/1`,
    });
  });

  test("getTicketTitle on an unknown id throws ControlPlaneError", async () => {
    const { cp } = makePlane();
    let err;
    try {
      await cp.getTicketTitle(`${REPO}#999`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.message).toMatch(/no such issue/i);
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

  test("actor resolves the writing credential's numeric id, once", async () => {
    const { api, cp } = makePlane();
    // The id is the REST `databaseId`, so it compares directly against the
    // `user.id` listComments reports for a comment this adapter posted.
    expect(await cp.actor()).toEqual({ id: "1", name: "Ada" });
    expect(await cp.actor()).toEqual({ id: "1", name: "Ada" });
    const identityReads = api.calls.filter((call) =>
      String(call.body?.query ?? "").includes("ViewerIdentity"),
    );
    expect(identityReads).toHaveLength(1);
  });

  test("actor under an App installation token is the bot user", async () => {
    const seed = contractSeed();
    // An installation token has no human viewer: GraphQL answers with the
    // App's own `<slug>[bot]` account, which is what authors its comments.
    seed.viewerIdentity = {
      login: "watt-mind-factory[bot]",
      databaseId: 322488792,
    };
    const cp = githubControlPlane({ api: fakeApi(seed), repo: REPO });
    expect(await cp.actor()).toEqual({
      id: "322488792",
      name: "watt-mind-factory[bot]",
    });
  });

  test("a failed actor read rejects and is not cached as unknown", async () => {
    const seed = contractSeed();
    seed.viewerIdentityFails = true;
    const cp = githubControlPlane({ api: fakeApi(seed), repo: REPO });

    await expect(cp.actor()).rejects.toThrow(ControlPlaneError);
    seed.viewerIdentityFails = false;
    expect(await cp.actor()).toMatchObject({ id: "1" });
  });

  test("listComments returns the comment bodies", async () => {
    const { api, cp } = makePlane();
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
    const commentReads = api.calls.filter(
      (call) =>
        call.method === "GET" &&
        call.pathName === `repos/${REPO}/issues/2/comments`,
    );
    expect(commentReads).toHaveLength(1);
    expect(commentReads[0].query).toEqual({ per_page: "100", page: "1" });
  });

  test("comment readers paginate and find a ready pin beyond the first page", async () => {
    const { api, cp, seed } = makePlane();
    const issue = requireIssue(seed, REPO, 1);
    const readyPin = `<!-- factory:ready-pin ${hashJson(issue.body)} -->`;
    issue.comments = Array.from({ length: 130 }, (_, i) => ({
      id: 400 + i,
      body: i === 120 ? readyPin : `comment ${i + 1}`,
      created_at: "2026-08-19T10:00:00Z",
      user: { id: 99, login: "Other" },
    }));

    expect(await cp.listComments(`${REPO}#1`)).toHaveLength(130);
    expect((await cp.getTicket(`${REPO}#1`)).readyPinHash).toBe(
      hashJson(issue.body),
    );

    await cp.setLabels(`${REPO}#1`, { add: [AGENT_READY_LABEL] });
    expect(
      api.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.pathName === `repos/${REPO}/issues/comments/520`,
      ),
    ).toBe(true);
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.pathName === `repos/${REPO}/issues/1/comments`,
      ),
    ).toBe(false);
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

  test("claim can be released back to a dispatchable Todo ticket", async () => {
    const { cp } = makePlane();
    await cp.claim(`${REPO}#1`);
    await cp.transition(`${REPO}#1`, "Todo", {
      add: [AGENT_READY_LABEL],
      remove: [IN_PROGRESS_LABEL, "agent:claude-code"],
      unassign: true,
    });

    const ticket = await cp.getTicket(`${REPO}#1`);
    expect(ticket.state.name).toBe("Todo");
    expect(ticket.assignee).toBeNull();
    expect(ticket.labels.map((label) => label.name)).toContain(
      AGENT_READY_LABEL,
    );
    expect(ticket.labels.map((label) => label.name)).not.toContain(
      IN_PROGRESS_LABEL,
    );
  });

  test("claim names the missing App permission when a mutation returns 403", async () => {
    const seed = contractSeed();
    const inner = fakeApi(seed);
    const api = (method, pathName, opts) => {
      if (method === "PUT" && pathName === `repos/${REPO}/issues/1/labels`)
        throw new ControlPlaneError(
          "github api: Resource not accessible by integration",
          { status: 403 },
        );
      return inner(method, pathName, opts);
    };
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { [TEAM]: REPO },
      project: PROJECT,
    });

    await expect(cp.claim(`${REPO}#1`)).rejects.toThrow(
      /github claim: update issue labels requires GitHub App repository permission "Issues: write"/,
    );
  });

  test("claim names the ambient-login requirement when GET user returns 401", async () => {
    const seed = contractSeed();
    const inner = fakeApi(seed);
    const api = (method, pathName, opts) => {
      if (method === "GET" && pathName === "user")
        throw new ControlPlaneError("github api: Requires authentication", {
          status: 401,
        });
      return inner(method, pathName, opts);
    };
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { [TEAM]: REPO },
      project: PROJECT,
    });

    // Fails closed, and says what to do about it — not a bare `github api: …`.
    await expect(cp.claim(`${REPO}#1`)).rejects.toThrow(
      /github claim: resolve the assignable lock owner requires ambient GitHub user authentication \(`gh auth login`\)/,
    );
    // Nothing was mutated: the ticket is still dispatchable.
    const ticket = await cp.getTicket(`${REPO}#1`);
    expect(ticket.assignee).toBeNull();
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

  test("clamps long GitHub bodies while retaining the run trailer", async () => {
    const { cp, seed } = makePlane();
    const longBody = "x".repeat(70_000);
    const previousAttribution = process.env.FACTORY_COMMENT_ATTRIBUTION;
    const previousRunId = process.env.FACTORY_RUN_ID;
    process.env.FACTORY_COMMENT_ATTRIBUTION = "1";
    process.env.FACTORY_RUN_ID = "body-clamp-test";
    try {
      await cp.comment(`${REPO}#1`, longBody);
      const comment = requireIssue(seed, REPO, 1).comments.at(-1).body;
      expect(comment.length).toBeLessThanOrEqual(GITHUB_BODY_MAX_LENGTH);
      expect(comment).toContain("… [truncated ");
      expect(comment).toEndWith("run:body-clamp-test");

      const created = await cp.file({
        team: TEAM,
        title: "long body",
        body: longBody,
      });
      const createdNumber = Number(created.identifier.split("#")[1]);
      const filed = requireIssue(seed, REPO, createdNumber).body;
      expect(filed.length).toBeLessThanOrEqual(GITHUB_BODY_MAX_LENGTH);
      expect(filed).toContain("… [truncated ");
      expect(filed).toEndWith("run:body-clamp-test");

      const appended = await cp.appendDetail(`${REPO}#1`, longBody);
      expect(appended).toEqual({ appended: true });
      const description = requireIssue(seed, REPO, 1).body;
      expect(description.length).toBeLessThanOrEqual(GITHUB_BODY_MAX_LENGTH);
      expect(description).toContain("… [truncated ");

      await cp.setLabels(`${REPO}#1`, { add: [AGENT_READY_LABEL] });
      const readyPin = requireIssue(seed, REPO, 1).comments.at(-1).body;
      expect(readyPin.length).toBeLessThanOrEqual(GITHUB_BODY_MAX_LENGTH);
      expect(readyPin).toEndWith("run:body-clamp-test");
    } finally {
      if (previousAttribution === undefined)
        delete process.env.FACTORY_COMMENT_ATTRIBUTION;
      else process.env.FACTORY_COMMENT_ATTRIBUTION = previousAttribution;
      if (previousRunId === undefined) delete process.env.FACTORY_RUN_ID;
      else process.env.FACTORY_RUN_ID = previousRunId;
    }
  });

  test("clamping keeps a fenced log and closes the fence before the marker", () => {
    const body = `intro\n\`\`\`text\n${"x".repeat(70_000)}`;
    const clamped = clampGithubBody(body);
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(
      GITHUB_BODY_MAX_LENGTH,
    );
    // The log survives up to the budget instead of being dropped wholesale.
    expect(clamped.length).toBeGreaterThan(GITHUB_BODY_MAX_LENGTH - 100);
    expect(clamped).toStartWith("intro\n```text\nxxxx");
    expect(clamped).toMatch(/x\n```\n… \[truncated \d+ chars\]$/);
    expect(clamped.split("```").length).toBe(3);

    // A closed fence followed by prose truncates in the prose as before.
    const closed = `\`\`\`\nlog\n\`\`\`\n${"p".repeat(70_000)}`;
    expect(clampGithubBody(closed)).toMatch(
      /^```\nlog\n```\np+\n\n… \[truncated/,
    );

    // A fence with no room for any content is dropped from its opening.
    expect(clampGithubBody(`~~~~\n${"z".repeat(100)}`, { max: 30 })).toBe(
      "… [truncated 105 chars]",
    );
    expect(clampGithubBody(`~~~~\nabc\n${"z".repeat(100)}`, { max: 60 })).toBe(
      `~~~~\nabc\n${"z".repeat(21)}\n~~~~\n… [truncated 79 chars]`,
    );
  });

  test("clamping budgets UTF-8 bytes and never splits a surrogate pair", () => {
    const clamped = clampGithubBody("😀".repeat(40_000));
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(
      GITHUB_BODY_MAX_LENGTH,
    );
    expect(clamped.isWellFormed()).toBe(true);
    expect(clamped).toMatch(/^(😀)+\n\n… \[truncated \d+ chars\]$/);
    // Unchanged when the byte length fits.
    expect(clampGithubBody("é".repeat(100), { max: 200 })).toBe(
      "é".repeat(100),
    );
    expect(clampGithubBody("é".repeat(100), { max: 199 })).toMatch(
      /^é+\n\n… \[/,
    );
  });

  test("clamping returns an empty string when the marker cannot fit", () => {
    expect(clampGithubBody("hello world ".repeat(10), { max: 10 })).toBe("");
    expect(clampGithubBody("hello world ".repeat(10), { max: 25 })).toBe(
      "… [truncated 120 chars]",
    );
  });

  test("the run trailer is only carved out when attribution is on", () => {
    const previousAttribution = process.env.FACTORY_COMMENT_ATTRIBUTION;
    const previousRunId = process.env.FACTORY_RUN_ID;
    const body = `${"a".repeat(70_000)}\n\nrun:trailer-test`;
    try {
      delete process.env.FACTORY_COMMENT_ATTRIBUTION;
      process.env.FACTORY_RUN_ID = "trailer-test";
      expect(clampGithubBody(body)).not.toEndWith("run:trailer-test");
      process.env.FACTORY_COMMENT_ATTRIBUTION = "1";
      expect(clampGithubBody(body)).toMatch(
        /^a+\n\n… \[truncated \d+ chars\]\n\nrun:trailer-test$/,
      );
      process.env.FACTORY_RUN_ID = "other";
      expect(clampGithubBody(body)).not.toEndWith("run:trailer-test");
    } finally {
      if (previousAttribution === undefined)
        delete process.env.FACTORY_COMMENT_ATTRIBUTION;
      else process.env.FACTORY_COMMENT_ATTRIBUTION = previousAttribution;
      if (previousRunId === undefined) delete process.env.FACTORY_RUN_ID;
      else process.env.FACTORY_RUN_ID = previousRunId;
    }
  });

  test("appendDetail reports body_full instead of patching a full issue", async () => {
    const { api, cp, seed } = makePlane();
    requireIssue(seed, REPO, 1).body = "x".repeat(GITHUB_BODY_MAX_LENGTH);
    await expect(cp.appendDetail(`${REPO}#1`, "more detail")).resolves.toEqual({
      appended: false,
      reason: "body_full",
    });
    expect(
      api.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.pathName === `repos/${REPO}/issues/1` &&
          call.body?.body !== undefined,
      ),
    ).toBe(false);
  });

  test("setLabels keeps existing labels (complete-set, not a delta)", async () => {
    const { cp } = makePlane();
    await cp.setLabels(`${REPO}#1`, { add: ["type:bug"] });
    const names = (await cp.getTicket(`${REPO}#1`)).labels.map((l) => l.name);
    expect(names).toContain(AGENT_READY_LABEL);
    expect(names).toContain("type:bug");
    await expect(
      cp.setLabels(`${REPO}#1`, { remove: [AGENT_READY_LABEL] }),
    ).rejects.toThrow(/refusing to remove ai:agent-ready/);
    expect(
      (await cp.getTicket(`${REPO}#1`)).labels.map((l) => l.name).sort(),
    ).toEqual([AGENT_READY_LABEL, "type:bug"].sort());
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

  test("demotion records its reason after removing ai:agent-ready", async () => {
    const { api, cp } = makePlane();
    await cp.transition(`${REPO}#1`, "Triage", {
      remove: [AGENT_READY_LABEL],
    });

    const ticket = await cp.getTicket(`${REPO}#1`);
    expect(ticket.state.name).toBe("Triage");
    expect(ticket.labels.map((label) => label.name)).not.toContain(
      AGENT_READY_LABEL,
    );
    expect((await cp.listComments(`${REPO}#1`)).at(-1)?.body).toContain(
      "after moving this ticket to `Triage`",
    );

    const commentIndex = api.calls.findIndex(
      (call) =>
        call.method === "POST" &&
        call.pathName === `repos/${REPO}/issues/1/comments`,
    );
    const labelIndex = api.calls.findIndex(
      (call) =>
        call.method === "PUT" &&
        call.pathName === `repos/${REPO}/issues/1/labels`,
    );
    expect(commentIndex).toBeGreaterThan(-1);
    expect(labelIndex).toBeGreaterThan(-1);
    expect(commentIndex).toBeGreaterThan(labelIndex);
  });

  test("demotion posts a caller-provided explanation exactly once", async () => {
    const { api, cp } = makePlane();
    const explanation =
      "Demoted by the template guard because Owned Paths is missing.";
    await cp.transition(`${REPO}#1`, "Triage", {
      remove: [AGENT_READY_LABEL],
      demotionComment: explanation,
    });

    const comments = api.calls.filter(
      (call) =>
        call.method === "POST" &&
        call.pathName === `repos/${REPO}/issues/1/comments`,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].body.body).toContain(explanation);
  });

  test("a failed demotion label write leaves issue state and assignees untouched", async () => {
    const seed = contractSeed();
    const baseApi = fakeApi(seed);
    const api = (method, pathName, options = {}) => {
      if (method === "PUT" && pathName === `repos/${REPO}/issues/1/labels`) {
        api.calls.push({ method, pathName, ...options });
        throw new ControlPlaneError("labels temporarily unavailable", {
          status: 503,
        });
      }
      return baseApi(method, pathName, options);
    };
    api.calls = baseApi.calls;
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });

    await expect(
      cp.transition(`${REPO}#1`, "Triage", {
        remove: [AGENT_READY_LABEL],
      }),
    ).rejects.toThrow(/labels temporarily unavailable/);

    const issue = seed.repos[REPO].issues.find(
      (candidate) => candidate.number === 1,
    );
    expect(issue.state).toBe("open");
    expect(issue.assignee).toBeNull();
    expect(issue.labels.map((label) => label.name)).toContain(
      AGENT_READY_LABEL,
    );
    expect(
      api.calls.some(
        (call) =>
          call.method === "PATCH" && call.pathName === `repos/${REPO}/issues/1`,
      ),
    ).toBe(false);
    // The project Status write comes after the label PUT too, so a failed
    // PUT never leaves the board moved while the labels still say otherwise.
    expect(
      api.calls.some(
        (call) =>
          call.pathName === "graphql" &&
          call.body?.query?.includes("SetProjectStatus"),
      ),
    ).toBe(false);
    expect((await cp.getTicket(`${REPO}#1`)).state.name).toBe("Todo");
    expect(await cp.listComments(`${REPO}#1`)).toEqual([]);
  });

  test("a caller-supplied demotionComment is not posted when the write is not a demotion", async () => {
    const { api, cp } = makePlane();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      await cp.transition(`${REPO}#3`, "Triage", {
        remove: [AGENT_READY_LABEL],
        demotionComment: "should not appear",
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.pathName === `repos/${REPO}/issues/3/comments`,
      ),
    ).toBe(false);
    expect(warnings.some((line) => line.includes("demotionComment"))).toBe(
      true,
    );
  });

  test("an unacknowledged status write leaves issue state and assignees untouched", async () => {
    const seed = contractSeed();
    const baseApi = fakeApi(seed);
    const api = (method, pathName, options = {}) => {
      if (
        pathName === "graphql" &&
        options.body?.query?.includes("SetProjectStatus")
      ) {
        api.calls.push({ method, pathName, ...options });
        return {
          data: { updateProjectV2ItemFieldValue: null },
        };
      }
      return baseApi(method, pathName, options);
    };
    api.calls = baseApi.calls;
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });

    await expect(
      cp.transition(`${REPO}#1`, "Triage", {
        remove: [AGENT_READY_LABEL],
      }),
    ).rejects.toThrow(/did not acknowledge moving/);

    // Labels are written first (#1695): the ready label is already gone and
    // the demotion reason recorded, but the board, issue state and assignees
    // are untouched, so the ticket never reads as a live claim.
    const ticket = await cp.getTicket(`${REPO}#1`);
    expect(ticket.state.name).toBe("Todo");
    expect(ticket.labels.map((label) => label.name)).not.toContain(
      AGENT_READY_LABEL,
    );
    expect(await cp.listComments(`${REPO}#1`)).toHaveLength(1);
    expect(
      api.calls.some(
        (call) =>
          call.method === "PATCH" && call.pathName === `repos/${REPO}/issues/1`,
      ),
    ).toBe(false);
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

  test("file uses the configured GitHub repository when team is omitted", async () => {
    const { cp } = makePlane();
    const created = await cp.file({
      title: "default-repo finding",
      labels: ["type:bug"],
      state: "Todo",
    });

    expect(created.identifier).toBe(`${REPO}#4`);
    const filed = await cp.getTicket(created.identifier);
    expect(filed.title).toBe("default-repo finding");
    expect(filed.state.name).toBe("Todo");
    expect(filed.labels.map((label) => label.name)).toEqual(["type:bug"]);
  });

  test("file retries through a search-index lag and reconciles missing labels", async () => {
    const seed = contractSeed();
    const api = fakeApi(seed);
    let failStatus = true;
    const cp = githubControlPlane({
      api(method, pathName, opts) {
        if (failStatus && opts?.body?.query?.includes("SetProjectStatus"))
          throw new ControlPlaneError("board unavailable");
        return api(method, pathName, opts);
      },
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });
    const opts = {
      team: TEAM,
      title: "retry-safe finding",
      dedupeKey: "run-1483",
      labels: ["type:bug"],
    };

    const first = await cp.file(opts);
    expect(first.identifier).toBe(`${REPO}#4`);
    expect(first.warnings).toEqual([
      expect.stringContaining("board unavailable"),
    ]);
    expect(
      api.calls.some(
        (call) => call.method === "GET" && call.pathName === "search/issues",
      ),
    ).toBe(true);

    failStatus = false;
    requireIssue(seed, REPO, Number(first.identifier.split("#")[1])).labels =
      [];
    const originalSearch = api;
    const lagged = githubControlPlane({
      api(method, pathName, opts) {
        if (method === "GET" && pathName === "search/issues")
          return { items: [] };
        return originalSearch(method, pathName, opts);
      },
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });
    const retried = await lagged.file(opts);
    expect(retried.identifier).toBe(first.identifier);
    expect(retried.warnings).toBeUndefined();
    expect(
      api.calls.filter(
        (call) =>
          call.method === "POST" && call.pathName === `repos/${REPO}/issues`,
      ),
    ).toHaveLength(1);
    const fallback = api.calls.find(
      (call) =>
        call.method === "GET" && call.pathName === `repos/${REPO}/issues`,
    );
    expect(fallback.query).toEqual({ state: "all", per_page: "100" });
    expect(
      (await lagged.getTicket(first.identifier)).labels.map((l) => l.name),
    ).toContain("type:bug");
  });

  test("file reuse preserves an existing board status and does not close it for Done", async () => {
    const seed = contractSeed();
    addIssue(seed, REPO, {
      id: 301,
      node_id: "I_301",
      number: 7,
      title: "todo finding",
      body: "<!-- factory:dedupe-key todo-finding -->\nearlier",
      status: "Todo",
    });
    addIssue(seed, REPO, {
      id: 302,
      node_id: "I_302",
      number: 8,
      title: "claimed finding",
      body: "<!-- factory:dedupe-key claimed-finding -->\nearlier",
      assignee: { id: 99, login: "Other", name: "Other" },
      status: "In Progress",
    });
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });

    const todo = await cp.file({
      team: TEAM,
      title: "todo finding",
      dedupeKey: "todo-finding",
      state: "Triage",
    });
    const claimed = await cp.file({
      team: TEAM,
      title: "claimed finding",
      dedupeKey: "claimed-finding",
      state: "Done",
    });

    expect(todo).toMatchObject({ reused: true, status: "Todo" });
    expect(claimed).toMatchObject({ reused: true, status: "In Progress" });
    expect(requireIssue(seed, REPO, 8).assignee.login).toBe("Other");
    expect(requireIssue(seed, REPO, 8).state).toBe("open");
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.pathName === "graphql" &&
          call.body?.query?.includes("SetProjectStatus"),
      ),
    ).toBe(false);
    expect(
      api.calls.some(
        (call) =>
          call.method === "PATCH" && call.pathName === `repos/${REPO}/issues/8`,
      ),
    ).toBe(false);
  });

  test("file reuse without a board item applies the requested state", async () => {
    const seed = contractSeed();
    addIssue(seed, REPO, {
      id: 301,
      node_id: "I_301",
      number: 7,
      title: "unboarded finding",
      body: "<!-- factory:dedupe-key unboarded-finding -->\nearlier",
    });
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });

    const reused = await cp.file({
      team: TEAM,
      title: "unboarded finding",
      dedupeKey: "unboarded-finding",
      state: "Todo",
    });

    expect(reused.reused).toBe(true);
    expect((await cp.getTicket(reused.identifier)).state.name).toBe("Todo");
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.pathName === "graphql" &&
          call.body?.query?.includes("SetProjectStatus"),
      ),
    ).toBe(true);
  });

  test("file reports reuse and warns when the dedupe key matches a closed issue", async () => {
    const seed = contractSeed();
    addIssue(seed, REPO, {
      id: 303,
      node_id: "I_303",
      number: 8,
      title: "closed finding",
      body: "<!-- factory:dedupe-key run-closed -->\noriginal body",
      state: "closed",
      labels: [{ name: "type:bug" }],
    });
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });
    const reused = await cp.file({
      team: TEAM,
      title: "closed finding",
      body: "a retry body that must not overwrite the issue",
      dedupeKey: "run-closed",
      matchTitle: true,
      labels: ["type:bug"],
    });
    expect(reused.identifier).toBe(`${REPO}#8`);
    expect(reused.reused).toBe(true);
    expect(reused.warnings).toEqual([
      expect.stringContaining("reused closed issue #8"),
    ]);
    // Reuse never rewrites the existing body, and never POSTs a second issue.
    expect(requireIssue(seed, REPO, 8).body).toBe(
      "<!-- factory:dedupe-key run-closed -->\noriginal body",
    );
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" && call.pathName === `repos/${REPO}/issues`,
      ),
    ).toBe(false);

    // A fresh filing carries neither flag.
    const fresh = await cp.file({ team: TEAM, title: "brand new" });
    expect(fresh.reused).toBeUndefined();
    expect(fresh.warnings).toBeUndefined();
  });

  test("file dedupe probe scopes search to the repo and quotes both terms", async () => {
    const seed = contractSeed();
    addIssue(seed, REPO, {
      id: 301,
      node_id: "I_301",
      number: 7,
      title: "exact title",
      body: "<!-- factory:dedupe-key run%2Fa%20b -->\nearlier",
      status: "Todo",
    });
    addIssue(seed, OTHER_REPO, {
      id: 302,
      node_id: "I_302",
      number: 7,
      title: "exact title",
      body: "<!-- factory:dedupe-key run%2Fa%20b -->\nelsewhere",
    });
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api,
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });
    const reused = await cp.file({
      team: TEAM,
      title: "exact title",
      dedupeKey: "run/a b",
      matchTitle: true,
    });
    expect(reused.identifier).toBe(`${REPO}#7`);
    const search = api.calls.find(
      (call) => call.method === "GET" && call.pathName === "search/issues",
    );
    expect(search.query.q).toBe(
      `repo:${REPO} is:issue in:body "run%2Fa%20b" in:title "exact title"`,
    );
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" && call.pathName === `repos/${REPO}/issues`,
      ),
    ).toBe(false);
  });

  test("file dedupe probe: a quote in the title cannot escape the quoted term", async () => {
    const seed = contractSeed();
    const hostile = `x" repo:${OTHER_REPO} "y`;
    addIssue(seed, OTHER_REPO, {
      id: 303,
      node_id: "I_303",
      number: 9,
      title: hostile,
      body: "unrelated issue in another repo",
    });
    const api = fakeApi(seed);
    const cp = githubControlPlane({
      api: (method, pathName, opts) => {
        const res = api(method, pathName, opts);
        // Even if search returned a hit from another repository, the
        // repository_url post-filter must ignore it.
        if (method === "GET" && pathName === "search/issues") {
          const extra = seed.repos[OTHER_REPO].issues.find(
            (i) => i.number === 9,
          );
          return {
            items: [
              {
                ...extra,
                repository_url: `https://api.github.com/repos/${OTHER_REPO}`,
              },
              ...res.items,
            ],
          };
        }
        return res;
      },
      repo: REPO,
      teams: { WM: REPO },
      project: PROJECT,
    });
    const filed = await cp.file({
      team: TEAM,
      title: hostile,
      matchTitle: true,
    });
    expect(filed.identifier).toBe(`${REPO}#4`);
    const search = api.calls.find(
      (call) => call.method === "GET" && call.pathName === "search/issues",
    );
    expect(search.query.q).toBe(
      `repo:${REPO} is:issue in:title "x repo:${OTHER_REPO} y"`,
    );
    expect(
      search.query.q.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/repo:/g),
    ).toHaveLength(1);
    // Nothing was written to the other repository's issue.
    expect(
      api.calls.some((call) =>
        call.pathName.startsWith(`repos/${OTHER_REPO}/`),
      ),
    ).toBe(false);
    expect((await cp.getTicket(`${REPO}#4`)).title).toBe(hostile);
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

  test("replaceDetail PATCHes the complete replacement body", async () => {
    const { api, cp } = makePlane();
    const body = "# Replacement\n\nPrevious text is gone.";
    await expect(cp.replaceDetail(`${REPO}#1`, body)).resolves.toBeUndefined();
    expect((await cp.getTicket(`${REPO}#1`)).description).toBe(body);
    expect(api.calls).toContainEqual({
      method: "PATCH",
      pathName: `repos/${REPO}/issues/1`,
      body: { body },
      query: undefined,
    });
  });

  test("raw is the escape hatch for GitHub GraphQL and rooted REST paths", async () => {
    const { cp } = makePlane();
    expect(await cp.raw(RAW_PING)).toEqual({ ping: true });
    expect(await cp.raw(`/repos/${REPO}/issues/1`)).toMatchObject({
      number: 1,
      title: "ready ticket",
    });
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

  test("an App-viewer CONTRIBUTOR author with repo write access reads as trusted", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 206,
      node_id: "I_206",
      number: 10,
      title: "org member seen as CONTRIBUTOR by the App installation",
      // What GitHub reports to a GitHub App installation viewer, which
      // cannot see org membership, for an org member's own issue.
      authorAssociation: "CONTRIBUTOR",
      authorLogin: "appblindmember",
      labels: [],
      status: "Todo",
    });
    seed.collaboratorPermissions[REPO] = { appblindmember: "admin" };
    const cp = githubControlPlane({
      api: fakeApi(seed),
      repo: REPO,
      teams: { WM: REPO },
    });
    const t = await cp.getTicket(`${REPO}#10`);
    expect(t.authorAssociation).toBe("COLLABORATOR");
    // No edit since creation: the author is still the last editor, and
    // carries the same upgraded association.
    expect(t.lastEditorAssociation).toBe("COLLABORATOR");
  });

  test("an untrusted author without write access stays untrusted", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 207,
      node_id: "I_207",
      number: 11,
      title: "read-only outsider",
      authorAssociation: "CONTRIBUTOR",
      authorLogin: "readonlyrando",
      labels: [],
      status: "Todo",
    });
    addIssue(seed, REPO, {
      id: 208,
      node_id: "I_208",
      number: 12,
      title: "not a collaborator at all",
      authorAssociation: "CONTRIBUTOR",
      authorLogin: "unknownrando",
      labels: [],
      status: "Todo",
    });
    seed.collaboratorPermissions[REPO] = { readonlyrando: "read" };
    const cp = githubControlPlane({
      api: fakeApi(seed),
      repo: REPO,
      teams: { WM: REPO },
    });
    expect((await cp.getTicket(`${REPO}#11`)).authorAssociation).toBe("NONE");
    // 404 on the permission endpoint is unresolvable: keep the raw
    // association, which is untrusted either way.
    expect((await cp.getTicket(`${REPO}#12`)).authorAssociation).toBe(
      "CONTRIBUTOR",
    );
  });

  test("an already-trusted author costs no permission request", async () => {
    const seed = freshSeed();
    addIssue(seed, REPO, {
      id: 209,
      node_id: "I_209",
      number: 13,
      title: "PAT-viewer member",
      authorAssociation: "MEMBER",
      authorLogin: "patmember",
      labels: [],
      status: "Todo",
    });
    const paths = [];
    const inner = fakeApi(seed);
    const cp = githubControlPlane({
      api: (method, pathName, opts) => {
        paths.push(pathName);
        return inner(method, pathName, opts);
      },
      repo: REPO,
      teams: { WM: REPO },
    });
    expect((await cp.getTicket(`${REPO}#13`)).authorAssociation).toBe("MEMBER");
    expect(paths.some((p) => p.includes("/collaborators/"))).toBe(false);
  });

  test("the permission lookup is cached per repo+login", async () => {
    const seed = freshSeed();
    for (const n of [14, 15]) {
      addIssue(seed, REPO, {
        id: 200 + n,
        node_id: `I_2${n}`,
        number: n,
        title: `cached ${n}`,
        authorAssociation: "CONTRIBUTOR",
        authorLogin: "cachedmember",
        labels: [],
        status: "Todo",
      });
    }
    seed.collaboratorPermissions[REPO] = { cachedmember: "write" };
    let permCalls = 0;
    const inner = fakeApi(seed);
    const cp = githubControlPlane({
      api: (method, pathName, opts) => {
        if (pathName.includes("/collaborators/")) permCalls++;
        return inner(method, pathName, opts);
      },
      repo: REPO,
      teams: { WM: REPO },
    });
    expect((await cp.getTicket(`${REPO}#14`)).authorAssociation).toBe(
      "COLLABORATOR",
    );
    expect((await cp.getTicket(`${REPO}#15`)).authorAssociation).toBe(
      "COLLABORATOR",
    );
    expect(permCalls).toBe(1);
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

  test("finds a page-two label and caches the paginated read across file calls", async () => {
    const seed = contractSeed();
    seed.labels = Array.from({ length: 149 }, (_, i) => ({
      id: i + 1,
      name: `label-${i + 1}`,
    }));
    seed.labels.push({ id: 150, name: "type:bug" });
    const api = fakeApi(seed);
    const cp = githubControlPlane({ api, repo: REPO, teams: { WM: REPO } });

    await expect(
      cp.file({ team: "WM", title: "page two", labels: ["type:bug"] }),
    ).resolves.toBeDefined();
    await expect(
      cp.file({ team: "WM", title: "cached", labels: ["type:bug"] }),
    ).resolves.toBeDefined();

    const labelReads = api.calls.filter(
      (call) =>
        call.method === "GET" && call.pathName === `repos/${REPO}/labels`,
    );
    expect(labelReads.map((call) => call.query.page)).toEqual(["1", "2"]);
  });

  test("a rejected label read is not memoized: the next file() retries", async () => {
    const seed = contractSeed();
    const inner = fakeApi(seed);
    let failOnce = true;
    const api = (method, pathName, opts) => {
      if (failOnce && method === "GET" && pathName === `repos/${REPO}/labels`) {
        failOnce = false;
        throw new ControlPlaneError("Forbidden", { status: 403 });
      }
      return inner(method, pathName, opts);
    };
    api.calls = inner.calls;
    const cp = githubControlPlane({ api, repo: REPO, teams: { WM: REPO } });

    await expect(
      cp.file({ team: "WM", title: "first", labels: ["type:bug"] }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      cp.file({ team: "WM", title: "retry", labels: ["type:bug"] }),
    ).resolves.toBeDefined();

    const labelReads = inner.calls.filter(
      (call) =>
        call.method === "GET" && call.pathName === `repos/${REPO}/labels`,
    );
    expect(labelReads).toHaveLength(1);
  });

  test("a label created after the memo (factory init) is found on a re-read before refusing", async () => {
    const seed = contractSeed();
    const api = fakeApi(seed);
    const cp = githubControlPlane({ api, repo: REPO, teams: { WM: REPO } });
    const labelReads = () =>
      api.calls.filter(
        (call) =>
          call.method === "GET" && call.pathName === `repos/${REPO}/labels`,
      ).length;

    await expect(
      cp.file({ team: "WM", title: "warm", labels: ["type:bug"] }),
    ).resolves.toBeDefined();
    expect(labelReads()).toBe(1);

    // Still missing: the miss triggers exactly one re-read, then refuses.
    await expect(
      cp.file({ team: "WM", title: "missing", labels: ["type:docs"] }),
    ).rejects.toThrow(/label\(s\) do not exist/);
    expect(labelReads()).toBe(2);

    // `factory init` creates the label out of band; no restart required.
    seed.labels.push({ id: 999, name: "type:docs" });
    await expect(
      cp.file({ team: "WM", title: "fresh", labels: ["type:docs"] }),
    ).resolves.toBeDefined();
    expect(labelReads()).toBe(3);
  });
});

// -------------------------------------------- init provisioning (WM-1009) ---
// The advertised quickstart is `gh auth login` + `factory init`. Before this,
// init only PRINTED the ~25 labels to create by hand, so the first file() call
// threw `label(s) do not exist` — the quickstart died on its first write.
describe("provisionGithubRepo", () => {
  const REPO2 = "acme/widget";

  /** A gh api fake with a controllable label set and project. */
  function provApi({
    labels = [],
    project = null,
    repoProject = project,
    organizationProject = null,
    organizationError = null,
    failList = null,
  } = {}) {
    const state = { labels: [...labels], created: [], calls: [], links: [] };
    const api = async (method, pathName, { body, query } = {}) => {
      state.calls.push({ method, pathName, body, query });
      if (method === "GET" && pathName === `repos/${REPO2}/labels`) {
        if (failList) throw new ControlPlaneError("Forbidden", { status: 403 });
        const perPage = Number(query?.per_page ?? 30);
        const page = Number(query?.page ?? 1);
        return state.labels
          .slice((page - 1) * perPage, page * perPage)
          .map((name) => ({ name }));
      }
      if (method === "POST" && pathName === `repos/${REPO2}/labels`) {
        if (state.labels.includes(body.name))
          throw new ControlPlaneError("already_exists", { status: 422 });
        state.labels.push(body.name);
        state.created.push(body);
        return { name: body.name };
      }
      if (pathName === "graphql") {
        const query = body?.query ?? "";
        if (query.includes("FindOrganizationProject")) {
          if (organizationError) throw organizationError;
          return {
            organization: {
              projectsV2: {
                nodes: organizationProject ? [organizationProject] : [],
              },
            },
          };
        }
        if (query.includes("LinkProjectV2ToRepository")) {
          state.links.push(body.variables);
          repoProject = organizationProject;
          return {
            linkProjectV2ToRepository: { repository: { id: "R_1" } },
          };
        }
        return {
          repository: {
            id: "R_1",
            projectsV2: { nodes: repoProject ? [repoProject] : [] },
          },
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
      "has-screenshots",
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

  test("does not recreate a protocol label found on page two", async () => {
    const api = provApi({
      labels: [
        ...Array.from({ length: 149 }, (_, i) => `label-${i + 1}`),
        "type:bug",
      ],
    });
    const report = await provisionGithubRepo(api, REPO2);
    expect(report.existed).toContain("type:bug");
    expect(api.state.created.map((label) => label.name)).not.toContain(
      "type:bug",
    );
    expect(
      api.state.calls
        .filter(
          (call) =>
            call.method === "GET" && call.pathName === `repos/${REPO2}/labels`,
        )
        .map((call) => call.query.page),
    ).toEqual(["1", "2"]);
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

  test("links a repository to the organization's existing Factory board", async () => {
    const project = {
      id: "PVT_1",
      title: "Factory",
      field: {
        id: "PVTF_1",
        name: "Status",
        options: GITHUB_FACTORY_STATES.map((name, i) => ({
          id: `o${i}`,
          name,
        })),
      },
    };
    const api = provApi({ repoProject: null, organizationProject: project });

    const report = await provisionGithubRepo(api, REPO2);

    expect(report.board.action).toBe("linked");
    expect(api.state.links).toEqual([
      { projectId: "PVT_1", repositoryId: "R_1" },
    ]);

    const second = await provisionGithubRepo(api, REPO2);
    expect(second.board.action).toBe("exists");
    expect(api.state.links).toHaveLength(1);
  });

  test("a user-owned repository (no organization) reports the board as absent, not as a failure", async () => {
    // `organization(login:)` on a user login answers null + a NOT_FOUND
    // GraphQL error; `gh api graphql` turns that into a non-zero exit. Before
    // the fold this threw and init printed "Labels/board: not provisioned"
    // even though every label had just been created.
    const notFound = new ControlPlaneError(
      "github graphql: Could not resolve to an Organization with the login of 'acme'.",
      { status: 200 },
    );
    notFound.graphqlErrors = [
      {
        type: "NOT_FOUND",
        path: ["organization"],
        message:
          "Could not resolve to an Organization with the login of 'acme'.",
      },
    ];
    const api = provApi({ repoProject: null, organizationError: notFound });

    const report = await provisionGithubRepo(api, REPO2);
    expect(report.board.action).toBe("manual");
    expect(report.created.length).toBeGreaterThan(0);
    expect(api.state.links).toEqual([]);

    const dry = await provisionGithubRepo(
      provApi({ repoProject: null, organizationError: notFound }),
      REPO2,
      { dryRun: true },
    );
    expect(dry.board.action).toBe("would-create");

    // Only the message survives some transports; that is enough.
    const bare = new ControlPlaneError(
      "Could not resolve to an Organization with the login of 'acme'.",
    );
    const viaMessage = await provisionGithubRepo(
      provApi({ repoProject: null, organizationError: bare }),
      REPO2,
    );
    expect(viaMessage.board.action).toBe("manual");

    // A real permission failure on the organization lookup still fails loudly.
    const forbidden = new ControlPlaneError("Forbidden", { status: 403 });
    await expect(
      provisionGithubRepo(
        provApi({ repoProject: null, organizationError: forbidden }),
        REPO2,
      ),
    ).rejects.toThrow(/'project' scope/);
  });

  test("dry run reports would-link without calling LinkProjectV2ToRepository", async () => {
    const project = {
      id: "PVT_1",
      title: "Factory",
      field: {
        id: "PVTF_1",
        name: "Status",
        options: GITHUB_FACTORY_STATES.map((name, i) => ({
          id: `o${i}`,
          name,
        })),
      },
    };
    const api = provApi({ repoProject: null, organizationProject: project });

    const report = await provisionGithubRepo(api, REPO2, { dryRun: true });

    expect(report.board.action).toBe("would-link");
    expect(report.board.title).toBe("Factory");
    expect(api.state.links).toEqual([]);
    expect(
      api.state.calls.some((c) =>
        String(c.body?.query ?? "").includes("LinkProjectV2ToRepository"),
      ),
    ).toBe(false);
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

describe("makeGhApi GraphQL error bodies (#1642)", () => {
  test("a non-zero `gh api graphql` exit surfaces the errors[] messages and keeps them on the error", async () => {
    const body = {
      data: { organization: null },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["organization"],
          message:
            "Could not resolve to an Organization with the login of 'acme'.",
        },
      ],
    };
    const exec = () => ({
      status: 1,
      stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`,
      stderr:
        "gh: Could not resolve to an Organization with the login of 'acme'.",
      error: null,
    });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    let caught;
    try {
      await api("POST", "graphql", { body: { query: "query { x }" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneError);
    expect(caught.message).toBe(
      "github graphql: Could not resolve to an Organization with the login of 'acme'.",
    );
    expect(caught.graphqlErrors).toEqual(body.errors);
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

  test("with App env vars set and a fresh cached token, repository calls get GH_TOKEN", () => {
    const dir = tmp("gh-app-inject-");
    const env = appEnv(dir);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const exec = recordingExec();
    const api = makeGhApi(exec, { env });
    api("GET", "repos/acme/widget/issues/1");
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
    makeGhApi(exec, { env })("GET", "repos/acme/widget/issues/1");
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

  test("GET user keeps the ambient gh credential because an App installation is not assignable", () => {
    const dir = tmp("gh-app-inject-");
    const env = { ...appEnv(dir), GH_TOKEN: "ghp_ambient_user" };
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const exec = recordingExec();
    const api = makeGhApi(exec, { env });

    api("GET", "user");
    api("GET", "repos/acme/widget/issues/1");

    expect(exec.calls[0].opts.env.GH_TOKEN).toBe("ghp_ambient_user");
    expect(exec.calls[1].opts.env.GH_TOKEN).toBe("ghs_live");
  });

  test("an EXPORTED App token is dropped for GET user so gh falls back to hosts.yml", () => {
    const dir = tmp("gh-app-inject-");
    // The operator's shell exported the App token itself
    // (`export GH_TOKEN=$(… gh-app-token.json)`). Left in place it beats the
    // ambient hosts.yml user credential and the identity read fails.
    const env = {
      ...appEnv(dir),
      GH_TOKEN: "ghs_live",
      GITHUB_TOKEN: "ghs_live",
    };
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const exec = recordingExec();
    const api = makeGhApi(exec, { env });

    api("GET", "user");
    api("GET", "repos/acme/widget/issues/1");

    expect("GH_TOKEN" in exec.calls[0].opts.env).toBe(false);
    expect("GITHUB_TOKEN" in exec.calls[0].opts.env).toBe(false);
    expect(exec.calls[0].opts.env.PATH).toBe("/usr/bin");
    // Repository calls still authenticate as the App.
    expect(exec.calls[1].opts.env.GH_TOKEN).toBe("ghs_live");
  });

  test("an exported App token is dropped for GET user even when App env is absent", () => {
    const dir = tmp("gh-app-inject-");
    const tokenFile = path.join(dir, "gh-app-token.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    // No FACTORY_GH_APP_ID/INSTALLATION/KEY: App auth is NOT configured for
    // this process, so nothing is injected — but the exported copy of the
    // installation token would still break the identity read.
    const env = {
      PATH: "/usr/bin",
      FACTORY_GH_APP_TOKEN_FILE: tokenFile,
      GH_TOKEN: "ghs_live",
    };
    const exec = recordingExec();
    makeGhApi(exec, { env })("GET", "user");
    expect("GH_TOKEN" in exec.calls[0].opts.env).toBe(false);
  });

  test("an operator's own PAT is never stripped from GET user", () => {
    const dir = tmp("gh-app-inject-");
    const env = { ...appEnv(dir), GH_TOKEN: "ghp_operator_pat" };
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const exec = recordingExec();
    makeGhApi(exec, { env })("GET", "user");
    // A different token is a real user credential — leave it alone.
    expect(exec.calls[0].opts.env.GH_TOKEN).toBe("ghp_operator_pat");
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
      api("GET", "repos/acme/widget/issues/1"); // call 1
      api("GET", "repos/acme/widget/issues/2"); // call 2 — must not re-warn
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

describe("makeGhApi async spawn is non-blocking (WM-1166)", () => {
  // The default `gh` runner is now an async, non-blocking spawn. `makeGhApi`
  // must (a) let concurrent calls overlap instead of serializing the event
  // loop, and (b) preserve EXACTLY the prior spawnSync behavior — same argv,
  // same graphql stdin, same status/stdout/stderr handling, identical error
  // strings, identical JSON parse + invalid-JSON error. These tests drive the
  // seam with async, Promise-returning stubs (the shape the real default has).

  test("two concurrent calls overlap — the event loop is not serialized", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseAll;
    const started = [];
    const gate = new Promise((resolve) => {
      releaseAll = resolve;
    });
    // A deliberately slow stub that does not resolve until BOTH calls are
    // in-flight. Under the old blocking spawnSync this could never happen:
    // the second call could not start until the first returned.
    const exec = (cmd, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(args.join(" "));
      return gate.then(() => {
        active -= 1;
        return { status: 0, stdout: "{}", stderr: "" };
      });
    };
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    const p1 = api("GET", "user");
    const p2 = api("GET", "repos/x/y/issues");
    // Both spawns registered synchronously before either resolves — proof they
    // overlap rather than run one-after-another.
    expect(maxActive).toBe(2);
    expect(started).toHaveLength(2);
    releaseAll();
    expect(await p1).toEqual({});
    expect(await p2).toEqual({});
    expect(active).toBe(0);
  });

  test("a slow first call does not block a second from making progress", async () => {
    // Order proof: a second, fast call resolves before a slow first one —
    // impossible if the runner serialized the loop.
    const order = [];
    const exec = (cmd, args) =>
      new Promise((resolve) => {
        const slow = args.includes("user");
        setTimeout(
          () => {
            order.push(slow ? "slow" : "fast");
            resolve({ status: 0, stdout: "{}", stderr: "" });
          },
          slow ? 40 : 5,
        );
      });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    await Promise.all([api("GET", "user"), api("GET", "repos/x/y/issues")]);
    expect(order).toEqual(["fast", "slow"]);
  });

  // An async, Promise-returning stub that records argv + stdin and replays a
  // scripted spawnSync-shaped result.
  function asyncExec(result) {
    const calls = [];
    const exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input, opts });
      return result;
    };
    exec.calls = calls;
    return exec;
  }

  test("REST argv, method, query string and JSON parse are unchanged", async () => {
    const exec = asyncExec({ status: 0, stdout: '{"ok":true}', stderr: "" });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    const out = await api("POST", "/repos/x/y/issues", {
      query: { state: "open", empty: "", skip: null },
    });
    expect(out).toEqual({ ok: true });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].cmd).toBe("gh");
    // Leading slash stripped, -X for non-GET, blank/null query keys dropped.
    expect(exec.calls[0].args).toEqual([
      "api",
      "--include",
      "-X",
      "POST",
      "repos/x/y/issues?state=open",
    ]);
    expect(exec.calls[0].input).toBeUndefined();
  });

  test("a body is sent on stdin via --input -", async () => {
    const exec = asyncExec({ status: 0, stdout: "{}", stderr: "" });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    await api("PATCH", "repos/x/y/issues/1", { body: { state: "closed" } });
    expect(exec.calls[0].args).toEqual([
      "api",
      "--include",
      "-X",
      "PATCH",
      "repos/x/y/issues/1",
      "--input",
      "-",
    ]);
    expect(exec.calls[0].input).toBe(JSON.stringify({ state: "closed" }));
  });

  test("graphql uses `graphql --input -` with query+variables on stdin", async () => {
    const exec = asyncExec({ status: 0, stdout: '{"data":{}}', stderr: "" });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    await api("POST", "graphql", {
      body: { query: "query{x}", variables: { a: 1 } },
    });
    expect(exec.calls[0].args).toEqual([
      "api",
      "--include",
      "graphql",
      "--input",
      "-",
    ]);
    expect(JSON.parse(exec.calls[0].input)).toEqual({
      query: "query{x}",
      variables: { a: 1 },
    });
  });

  test("a non-zero status surfaces the github api message from stdout", async () => {
    const exec = asyncExec({
      status: 1,
      stdout: '{"message":"Not Found"}',
      stderr: "",
    });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    await expect(api("GET", "repos/x/y/issues/9")).rejects.toThrow(
      "github api: Not Found",
    );
  });

  test("the HTTP status is carried through whether gh reports it as a string or a number", async () => {
    for (const reported of ["401", 401]) {
      const exec = asyncExec({
        status: 1,
        stdout: JSON.stringify({
          message: "Requires authentication",
          status: reported,
        }),
        stderr: "",
      });
      const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
      const err = await api("GET", "user").catch((e) => e);
      expect(err.status).toBe(401);
    }
  });

  test("a non-zero status with no JSON body falls back to stderr text", async () => {
    const exec = asyncExec({
      status: 2,
      stdout: "",
      stderr: "boom\n",
    });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    // The message stitches together the first two argv tokens (`api user`) —
    // the exact spawnSync-era string.
    await expect(api("GET", "user")).rejects.toThrow(
      "gh api user failed (status 2): boom",
    );
  });

  test("invalid JSON on a 0 status throws the invalid-JSON error", async () => {
    const exec = asyncExec({ status: 0, stdout: "not json", stderr: "" });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    await expect(api("GET", "user")).rejects.toThrow(
      "gh api user returned invalid JSON",
    );
  });

  test("empty stdout on a 0 status resolves to {}", async () => {
    const exec = asyncExec({ status: 0, stdout: "", stderr: "" });
    const api = makeGhApi(exec, { env: { PATH: "/usr/bin" } });
    expect(await api("DELETE", "repos/x/y/issues/comments/5")).toEqual({});
  });

  test("GH_TOKEN injection still lands on the async child env", async () => {
    const exec = asyncExec({ status: 0, stdout: "{}", stderr: "" });
    const api = makeGhApi(exec, {
      env: { PATH: "/usr/bin" },
      resolveToken: () => "ghs_async",
    });
    await api("GET", "repos/acme/widget/issues/1");
    expect(exec.calls[0].opts.env.GH_TOKEN).toBe("ghs_async");
    expect(exec.calls[0].opts.env.PATH).toBe("/usr/bin");
  });
});

describe("GitHub CLI timeout and secondary-rate-limit recovery (GH-1352)", () => {
  test("names a timed-out GraphQL call as GitHub GraphQL", async () => {
    const cp = githubControlPlane({
      repo: REPO,
      teams: { WM: REPO },
      exec: async () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("gh timed out after 15000ms"),
      }),
    });

    await expect(cp.raw("query { ping }")).rejects.toThrow(
      "github graphql timed out after 15000ms",
    );
  });

  test("retries one state or label timeout with the active control-plane endpoint", async () => {
    const calls = [];
    const github = {
      kind: "github",
      async setLabels(...args) {
        calls.push(args);
        if (calls.length === 1)
          throw new ControlPlaneError("github graphql timed out after 15000ms");
      },
    };

    await expect(
      setLabelsWithRetry(github, `${REPO}#1`, {
        add: [IN_PROGRESS_LABEL],
        remove: [AGENT_READY_LABEL],
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      [`${REPO}#1`, { add: [IN_PROGRESS_LABEL], remove: [AGENT_READY_LABEL] }],
      [`${REPO}#1`, { add: [IN_PROGRESS_LABEL], remove: [AGENT_READY_LABEL] }],
    ]);

    const linearCalls = [];
    const linear = {
      kind: "linear",
      async transition(...args) {
        linearCalls.push(args);
        if (linearCalls.length === 1)
          throw new ControlPlaneError("linear graphql timed out after 15000ms");
      },
    };
    await expect(
      transitionThenComment(
        linear,
        "CLNT-123",
        "In Review",
        { add: ["ai:needs-review"], remove: [IN_PROGRESS_LABEL] },
        "",
      ),
    ).resolves.toBeUndefined();
    expect(linearCalls).toEqual([
      [
        "CLNT-123",
        "In Review",
        { add: ["ai:needs-review"], remove: [IN_PROGRESS_LABEL] },
      ],
      [
        "CLNT-123",
        "In Review",
        { add: ["ai:needs-review"], remove: [IN_PROGRESS_LABEL] },
      ],
    ]);
  });

  test("reports a second timeout with the active control-plane endpoint", async () => {
    for (const { controlPlane, timeout, expected } of [
      {
        controlPlane: { kind: "github" },
        timeout: "github graphql timed out after 15000ms",
        expected: "github projects graphql timed out after 15000ms",
      },
      {
        controlPlane: { kind: "linear" },
        timeout: "linear graphql timed out after 15000ms",
        expected: "linear graphql timed out after 15000ms",
      },
    ]) {
      let caught;
      const pauses = [];
      try {
        await retryControlPlaneMutation(
          controlPlane,
          async () => {
            throw new ControlPlaneError(timeout);
          },
          { backoff: async (ms) => pauses.push(ms) },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ControlPlaneError);
      expect(caught.message).toBe(expected);
      expect(pauses).toEqual([250]);
    }
  });

  test("a gh process that never closes is terminated after its configured timeout", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.stdin.end = () => {};
    const signals = [];
    child.kill = (signal) => signals.push(signal);

    const timers = [];
    const result = ghSpawn(
      "gh",
      ["api", "user"],
      { timeoutMs: 25 },
      {
        spawnImpl: () => child,
        setTimeoutImpl: (callback) => {
          timers.push(callback);
          return timers.length;
        },
        clearTimeoutImpl: () => {},
        killGraceMs: 1,
      },
    );

    timers.shift()();
    await expect(result).resolves.toMatchObject({
      status: null,
      error: new Error("gh timed out after 25ms"),
    });
    expect(signals).toEqual(["SIGTERM"]);
    timers.shift()();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("retries a secondary rate limit once and uses injected retry sleep", async () => {
    const calls = [];
    const sleeps = [];
    const exec = async () => {
      calls.push("gh");
      return calls.length === 1
        ? {
            status: 1,
            stdout:
              'HTTP/2 403\r\nRetry-After: 3\r\n\r\n{"message":"You have exceeded a secondary rate limit","status":"403"}',
            stderr: "",
          }
        : { status: 0, stdout: '{"ok":true}', stderr: "" };
    };
    const api = makeGhApi(exec, {
      env: { PATH: "/usr/bin" },
      sleep: async (ms) => sleeps.push(ms),
    });

    await expect(api("GET", "repos/acme/widget/issues/1")).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  test("stops after two secondary-rate-limit retries with exponential backoff", async () => {
    const sleeps = [];
    const exec = async () => ({
      status: 1,
      stdout:
        '{"message":"You have exceeded a secondary rate limit","status":403}',
      stderr: "",
    });
    const api = makeGhApi(exec, {
      env: { PATH: "/usr/bin" },
      sleep: async (ms) => sleeps.push(ms),
    });

    await expect(api("GET", "repos/acme/widget/issues/1")).rejects.toThrow(
      "secondary rate limit",
    );
    expect(sleeps).toEqual([2000, 4000]);
  });

  function fakeChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.stdin.end = () => {};
    child.signals = [];
    child.kill = (signal) => child.signals.push(signal);
    return child;
  }

  test("ambient FACTORY_GH_TIMEOUT_MS is honoured when no child env is injected (PAT mode)", async () => {
    const previous = process.env.FACTORY_GH_TIMEOUT_MS;
    process.env.FACTORY_GH_TIMEOUT_MS = "37";
    try {
      const child = fakeChild(undefined);
      const timers = [];
      const result = ghSpawn(
        "gh",
        ["api", "user"],
        {},
        {
          spawnImpl: () => child,
          setTimeoutImpl: (callback, ms) => {
            timers.push({ callback, ms });
            return timers.length;
          },
          clearTimeoutImpl: () => {},
          killGraceMs: 1,
        },
      );
      expect(timers[0].ms).toBe(37);
      timers.shift().callback();
      await expect(result).resolves.toMatchObject({
        status: null,
        error: new Error("gh timed out after 37ms"),
      });
    } finally {
      if (previous === undefined) delete process.env.FACTORY_GH_TIMEOUT_MS;
      else process.env.FACTORY_GH_TIMEOUT_MS = previous;
    }
  });

  test("timeout kills the gh process group, falling back to the child on ESRCH", async () => {
    const run = (killImpl) => {
      const child = fakeChild(4242);
      const timers = [];
      const result = ghSpawn(
        "gh",
        ["api", "user"],
        { timeoutMs: 5 },
        {
          spawnImpl: (cmd, args, opts) => {
            child.spawnOpts = opts;
            return child;
          },
          setTimeoutImpl: (callback) => {
            timers.push(callback);
            return timers.length;
          },
          clearTimeoutImpl: () => {},
          killGraceMs: 1,
          killImpl,
        },
      );
      return { child, timers, result };
    };

    const groupKills = [];
    const ok = run((pid, signal) => groupKills.push([pid, signal]));
    expect(ok.child.spawnOpts.detached).toBe(process.platform !== "win32");
    ok.timers.shift()();
    await expect(ok.result).resolves.toMatchObject({ status: null });
    ok.timers.shift()();
    expect(groupKills).toEqual([
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
    ]);
    expect(ok.child.signals).toEqual([]);

    const gone = run(() => {
      const err = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    });
    gone.timers.shift()();
    await gone.result;
    gone.timers.shift()();
    expect(gone.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("the HTTP status line is the apiStatus fallback when the body has no status", async () => {
    const calls = [];
    const sleeps = [];
    const exec = async (cmd, args) => {
      calls.push(args);
      if (calls.length === 1)
        return {
          status: 1,
          stdout:
            'HTTP/2 429\r\nRetry-After: 2\r\n\r\n{"message":"API rate limit exceeded"}',
          stderr: "",
        };
      if (calls.length === 2)
        return {
          status: 1,
          stdout:
            'HTTP/2 403\r\nRetry-After: 1\r\n\r\n{"message":"You have exceeded a secondary rate limit. Please wait."}',
          stderr: "",
        };
      return { status: 0, stdout: '{"data":{"ok":true}}', stderr: "" };
    };
    const api = makeGhApi(exec, {
      env: { PATH: "/usr/bin" },
      sleep: async (ms) => sleeps.push(ms),
    });

    await expect(
      api("GRAPHQL", "graphql", { body: "query {}" }),
    ).resolves.toEqual({ data: { ok: true } });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 1000]);

    // Without --include (no status line) and no body status, exit code stays.
    const bare = makeGhApi(
      async () => ({
        status: 1,
        stdout: '{"message":"Not Found"}',
        stderr: "",
      }),
      { env: { PATH: "/usr/bin" }, sleep: async () => {} },
    );
    await expect(
      bare("GET", "repos/acme/widget/issues/1"),
    ).rejects.toMatchObject({ status: 1 });
    const lined = makeGhApi(
      async () => ({
        status: 1,
        stdout: 'HTTP/2 404\r\n\r\n{"message":"Not Found"}',
        stderr: "",
      }),
      { env: { PATH: "/usr/bin" }, sleep: async () => {} },
    );
    await expect(
      lined("GET", "repos/acme/widget/issues/1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("x-ratelimit-reset drives the backoff when retry-after is absent (jittered, capped)", async () => {
    const sleeps = [];
    let calls = 0;
    const soon = Math.floor(Date.now() / 1000) + 5;
    const far = Math.floor(Date.now() / 1000) + 3600;
    const exec = async () => {
      calls += 1;
      const reset = calls === 1 ? soon : far;
      return {
        status: 1,
        stdout: `HTTP/2 429\r\nX-RateLimit-Reset: ${reset}\r\n\r\n{"message":"API rate limit exceeded","status":"429"}`,
        stderr: "",
      };
    };
    const api = makeGhApi(exec, {
      env: { PATH: "/usr/bin" },
      sleep: async (ms) => sleeps.push(ms),
    });

    await expect(
      api("GET", "repos/acme/widget/issues/1"),
    ).rejects.toMatchObject({ status: 429 });
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(4_000);
    expect(sleeps[0]).toBeLessThanOrEqual(6_000);
    expect(sleeps[1]).toBe(60_000);
  });
});

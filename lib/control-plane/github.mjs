/**
 * GitHub Issues ControlPlane (WM-798).
 *
 * The same verbs as `linear.mjs` / `memory.mjs`, bound onto GitHub:
 *   - protocol labels → issue labels of the same spelling (complete set)
 *   - assignee → issue assignee; claim read-back is the concurrency control
 *   - factory states → a Projects v2 single-select (default title `Factory`,
 *     field `Status`)
 *
 * Production talks to GitHub through `gh api` / `gh api graphql` (the same
 * CLI the forge already requires). No Octokit — a Linear-account-free
 * quickstart is `gh auth login` plus `factory init --control-plane github`.
 *
 * `api` is the seam: `(method, path, { body, query }) => json`, so the
 * contract suite can drive the implementation with a fake tracker and no
 * network. When omitted, `exec` (spawnSync-shaped) wraps `gh`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ControlPlaneError } from "./types.mjs";
import {
  AGENT_READY_LABEL,
  appendIssueDetail,
  claimLabels,
  stampRun,
  validateLabels,
} from "./labels.mjs";

export const GITHUB_FACTORY_STATES = Object.freeze([
  "Triage",
  "Todo",
  "In Progress",
  "In Review",
  "Done",
  "Blocked",
]);

const DEFAULT_PROJECT = "Factory";
const DEFAULT_STATUS_FIELD = "Status";

const FIND_REPO_PROJECT = `query FindRepoProject($owner: String!, $name: String!, $title: String!, $statusField: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 20, query: $title) {
      nodes {
        id
        title
        field(name: $statusField) {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;

const FIND_VIEWER_PROJECT = `query FindViewerProject($title: String!, $statusField: String!) {
  viewer {
    projectsV2(first: 20, query: $title) {
      nodes {
        id
        title
        field(name: $statusField) {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;

const PROJECT_ITEMS = `query ProjectItems($projectId: ID!, $statusField: String!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id
          content {
            ... on Issue {
              id
              number
              repository { nameWithOwner }
            }
          }
          fieldValueByName(name: $statusField) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

const ADD_PROJECT_ITEM = `mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`;

const SET_PROJECT_STATUS = `mutation SetProjectStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) { projectV2Item { id } }
}`;

const text = (v) =>
  v == null ? "" : Buffer.isBuffer(v) ? v.toString() : String(v);

/**
 * Default `api` implementation: `gh api` / `gh api graphql` via `exec`.
 *
 * @param {(cmd: string, args: string[], opts: object) => object} exec
 */
export function makeGhApi(exec = spawnSync) {
  return function ghApi(method, pathName, { body, query } = {}) {
    const args = ["api"];
    const isGraphql =
      pathName === "graphql" || pathName === "/graphql" || method === "GRAPHQL";
    if (isGraphql) {
      args.push("graphql", "--input", "-");
      return ghJson(
        exec,
        args,
        JSON.stringify({
          query: body?.query ?? body,
          variables: body?.variables ?? query ?? {},
        }),
      );
    }
    if (method && method !== "GET") args.push("-X", method);
    let url = String(pathName).replace(/^\//, "");
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(
        Object.fromEntries(
          Object.entries(query).filter(([, v]) => v != null && v !== ""),
        ),
      ).toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    args.push(url);
    if (body !== undefined) {
      args.push("--input", "-");
      return ghJson(exec, args, JSON.stringify(body));
    }
    return ghJson(exec, args);
  };
}

function ghJson(exec, args, input) {
  const r =
    exec("gh", args, {
      encoding: "utf8",
      stdio:
        input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: input != null ? input : undefined,
    }) ?? {};
  const status = r.status ?? r.exitCode ?? null;
  const stdout = text(r.stdout);
  const stderr =
    text(r.stderr) || (r.error ? String(r.error.message ?? r.error) : "");
  if (status !== 0) {
    let message = `gh ${args.slice(0, 2).join(" ")} failed (status ${status})`;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.message) message = `github api: ${parsed.message}`;
    } catch {
      if (stderr) message = `${message}: ${stderr.trim()}`;
    }
    throw new ControlPlaneError(message, {
      status,
      cause: r.error,
    });
  }
  if (!stdout.trim()) return {};
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlPlaneError(
      `gh ${args.slice(0, 2).join(" ")} returned invalid JSON`,
      { status: 0, cause },
    );
  }
}

/** Parse `owner/repo#42`, `#42`, or `42` (the last two need a default repo). */
export function parseIssueIdentifier(identifier, defaultRepo) {
  const raw = String(identifier ?? "").trim();
  const full = raw.match(/^([^/#\s]+\/[^/#\s]+)#(\d+)$/);
  if (full) return { repo: full[1], number: Number(full[2]) };
  const num = raw.match(/^#?(\d+)$/);
  if (num && defaultRepo) return { repo: defaultRepo, number: Number(num[1]) };
  throw new ControlPlaneError(
    `not a GitHub issue identifier: ${identifier} (want owner/repo#N)`,
  );
}

export function issueIdentifier(repo, number) {
  return `${repo}#${number}`;
}

function resolveLabelNames(currentNames, { add = [], remove = [] } = {}) {
  const dropped = new Set(remove);
  const kept = currentNames.filter((n) => !dropped.has(n));
  return [...new Set([...kept, ...add])];
}

function stateType(name) {
  const n = String(name ?? "").toLowerCase();
  if (n === "done") return "completed";
  if (n === "triage" || n === "todo") return "unstarted";
  return "started";
}

export function githubPolicyStanza({
  repo = "OWNER/REPO",
  teams,
  project = DEFAULT_PROJECT,
  statusField = DEFAULT_STATUS_FIELD,
} = {}) {
  return {
    kind: "github",
    github: {
      repo,
      teams: teams ?? { DEMO: repo },
      project,
      statusField,
    },
  };
}

/** `controlPlane.github` from `<root>/config/policy.yaml`, or `{}`. */
export function readGithubPolicy(root) {
  try {
    const policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
    const gh = policy?.controlPlane?.github ?? {};
    return {
      kind: policy?.controlPlane?.kind,
      repo: gh.repo ?? null,
      teams: gh.teams ?? {},
      project: gh.project ?? DEFAULT_PROJECT,
      statusField: gh.statusField ?? DEFAULT_STATUS_FIELD,
    };
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Write / merge GitHub Issues control-plane defaults into
 * `<root>/config/policy.yaml`. Idempotent: existing keys besides
 * `controlPlane` are preserved.
 */
export function writeGithubControlPlanePolicy(root, opts = {}) {
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const policyPath = path.join(configDir, "policy.yaml");
  let existing = {};
  try {
    existing = Bun.YAML.parse(readFileSync(policyPath, "utf8")) ?? {};
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const stanza = githubPolicyStanza(opts);
  const next = { ...existing, controlPlane: stanza };
  const yaml = Bun.YAML.stringify(next);
  writeFileSync(
    policyPath,
    `# Generated by factory init --control-plane github (WM-798).\n${yaml.endsWith("\n") ? yaml : `${yaml}\n`}`,
  );
  return { path: policyPath, controlPlane: stanza };
}

/**
 * @param {{
 *   exec?: Function,
 *   api?: Function,
 *   root?: string,
 *   repo?: string,
 *   teams?: Record<string, string>,
 *   project?: string,
 *   statusField?: string,
 * }} [options]
 * @returns {import("./types.mjs").ControlPlane}
 */
export function githubControlPlane(options = {}) {
  const {
    exec = spawnSync,
    api: apiOpt,
    root,
    repo: repoOpt,
    teams: teamsOpt,
    project: projectOpt,
    statusField: statusFieldOpt,
  } = options;

  const fromPolicy = root ? readGithubPolicy(root) : {};
  const teams = { ...(fromPolicy.teams ?? {}), ...(teamsOpt ?? {}) };
  const defaultRepo =
    repoOpt ?? fromPolicy.repo ?? Object.values(teams)[0] ?? null;
  const projectTitle = projectOpt ?? fromPolicy.project ?? DEFAULT_PROJECT;
  const statusFieldName =
    statusFieldOpt ?? fromPolicy.statusField ?? DEFAULT_STATUS_FIELD;
  const api = apiOpt ?? makeGhApi(exec);

  let projectCache = null;

  async function call(method, pathName, opts) {
    try {
      const result = await Promise.resolve(api(method, pathName, opts));
      const isGraphql =
        pathName === "graphql" ||
        pathName === "/graphql" ||
        method === "GRAPHQL";
      if (isGraphql) {
        if (result?.errors?.length)
          throw new ControlPlaneError(
            result.errors[0]?.message ?? "github graphql error",
          );
        return result?.data ?? result;
      }
      return result;
    } catch (cause) {
      if (cause instanceof ControlPlaneError) throw cause;
      throw new ControlPlaneError(
        cause?.message ? String(cause.message) : "github api failed",
        { cause, status: cause?.status ?? null },
      );
    }
  }

  function repoForTeam(team) {
    if (!team) throw new ControlPlaneError("listDispatchable requires team");
    if (teams[team]) return teams[team];
    if (String(team).includes("/")) return team;
    if (defaultRepo) return defaultRepo;
    throw new ControlPlaneError(`no GitHub repo bound to team ${team}`);
  }

  function teamKeyForRepo(repoName) {
    const hit = Object.entries(teams).find(([, r]) => r === repoName);
    return { key: hit ? hit[0] : repoName };
  }

  function locate(identifier) {
    return parseIssueIdentifier(identifier, defaultRepo);
  }

  async function repoLabels(repo) {
    const rows = await call("GET", `repos/${repo}/labels`, {
      query: { per_page: "100" },
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function requireLabelsExist(repo, names) {
    const bad = validateLabels(names);
    if (bad.length)
      throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
    if (!names.length) return;
    const all = await repoLabels(repo);
    const missing = names.filter((n) => !all.some((l) => l.name === n));
    if (missing.length)
      throw new ControlPlaneError(
        `label(s) do not exist in this workspace: ${missing.join(", ")}`,
      );
  }

  async function loadProject() {
    if (projectCache) return projectCache;
    const pick = (nodes) =>
      (nodes ?? []).find((p) => p.title === projectTitle) ?? (nodes ?? [])[0];

    let node = null;
    if (defaultRepo && defaultRepo.includes("/")) {
      const [owner, name] = defaultRepo.split("/");
      const d = await call("POST", "graphql", {
        body: {
          query: FIND_REPO_PROJECT,
          variables: {
            owner,
            name,
            title: projectTitle,
            statusField: statusFieldName,
          },
        },
      });
      node = pick(d?.repository?.projectsV2?.nodes);
    }
    if (!node) {
      const d = await call("POST", "graphql", {
        body: {
          query: FIND_VIEWER_PROJECT,
          variables: { title: projectTitle, statusField: statusFieldName },
        },
      });
      node = pick(d?.viewer?.projectsV2?.nodes);
    }
    if (!node)
      throw new ControlPlaneError(`no GitHub Project titled "${projectTitle}"`);
    const field = node.field;
    if (!field?.id || !Array.isArray(field.options))
      throw new ControlPlaneError(
        `project "${projectTitle}" has no "${statusFieldName}" single-select field`,
      );
    projectCache = {
      id: node.id,
      title: node.title,
      fieldId: field.id,
      options: field.options,
    };
    return projectCache;
  }

  function optionFor(project, stateName) {
    const target = project.options.find(
      (o) => o.name.toLowerCase() === String(stateName).toLowerCase(),
    );
    if (!target)
      throw new ControlPlaneError(
        `no state "${stateName}" on team ${defaultRepo ?? project.title} — have: ${project.options.map((o) => o.name).join(", ")}`,
      );
    return target;
  }

  async function projectItems() {
    const project = await loadProject();
    const d = await call("POST", "graphql", {
      body: {
        query: PROJECT_ITEMS,
        variables: { projectId: project.id, statusField: statusFieldName },
      },
    });
    return {
      project,
      items: d?.node?.items?.nodes ?? [],
    };
  }

  async function statusOf(repo, number) {
    const { project, items } = await projectItems();
    const item = items.find(
      (it) =>
        it.content?.number === number &&
        (it.content?.repository?.nameWithOwner ?? repo) === repo,
    );
    const name = item?.fieldValueByName?.name ?? null;
    const opt = name ? project.options.find((o) => o.name === name) : null;
    return { project, item, name, opt };
  }

  async function ensureProjectItem(repo, number, contentId) {
    const { project, items } = await projectItems();
    const existing = items.find(
      (it) =>
        it.content?.number === number &&
        (it.content?.repository?.nameWithOwner ?? repo) === repo,
    );
    if (existing) return { project, item: existing };
    const added = await call("POST", "graphql", {
      body: {
        query: ADD_PROJECT_ITEM,
        variables: { projectId: project.id, contentId },
      },
    });
    const item = added?.addProjectV2ItemById?.item;
    if (!item?.id)
      throw new ControlPlaneError(
        `failed to add ${issueIdentifier(repo, number)} to project ${project.title}`,
      );
    projectCache = null;
    return { project, item };
  }

  async function setStatus(repo, number, contentId, stateName) {
    const { project, item } = await ensureProjectItem(repo, number, contentId);
    const opt = optionFor(project, stateName);
    await call("POST", "graphql", {
      body: {
        query: SET_PROJECT_STATUS,
        variables: {
          projectId: project.id,
          itemId: item.id,
          fieldId: project.fieldId,
          optionId: opt.id,
        },
      },
    });
    projectCache = null;
    return opt;
  }

  function normalizeIssue(issue, repo, status) {
    const labels = (issue.labels ?? []).map((l) => ({
      id: l.id != null ? String(l.id) : undefined,
      name: l.name,
    }));
    const assignee = issue.assignee
      ? {
          id: String(issue.assignee.id),
          name: issue.assignee.login ?? issue.assignee.name,
        }
      : null;
    const statusName =
      status?.name ?? (issue.state === "closed" ? "Done" : "Triage");
    const opt = status?.opt;
    return {
      id: issue.node_id ?? String(issue.id),
      identifier: issueIdentifier(repo, issue.number),
      title: issue.title,
      description: issue.body ?? "",
      url: issue.html_url ?? "",
      state: {
        id: opt?.id,
        name: statusName,
        type: stateType(statusName),
      },
      assignee,
      team: teamKeyForRepo(repo),
      project: { name: projectTitle },
      labels,
    };
  }

  async function fetchIssue(repo, number) {
    let issue;
    try {
      issue = await call("GET", `repos/${repo}/issues/${number}`);
    } catch (err) {
      if (
        err instanceof ControlPlaneError &&
        (err.status === 404 || /not found/i.test(err.message))
      )
        throw new ControlPlaneError(
          `no such issue: ${issueIdentifier(repo, number)}`,
        );
      throw err;
    }
    if (!issue || issue.message === "Not Found" || issue.pull_request)
      throw new ControlPlaneError(
        `no such issue: ${issueIdentifier(repo, number)}`,
      );
    const status = await statusOf(repo, number);
    return { issue, status, ticket: normalizeIssue(issue, repo, status) };
  }

  return {
    kind: "github",

    async getTicket(identifier) {
      const { repo, number } = locate(identifier);
      return (await fetchIssue(repo, number)).ticket;
    },

    async listComments(identifier) {
      const { repo, number } = locate(identifier);
      await fetchIssue(repo, number);
      const rows = await call("GET", `repos/${repo}/issues/${number}/comments`);
      return (Array.isArray(rows) ? rows : []).map((c) => ({
        id: c.id != null ? String(c.id) : undefined,
        body: c.body,
        createdAt: c.created_at ?? c.createdAt,
        user: c.user
          ? {
              id: c.user.id != null ? String(c.user.id) : undefined,
              name: c.user.login ?? c.user.name,
            }
          : null,
      }));
    },

    async listDispatchable({ team, project } = {}) {
      if (!team) throw new ControlPlaneError("listDispatchable requires team");
      if (project && project !== projectTitle) return [];
      const repo = repoForTeam(team);
      const rows = await call("GET", `repos/${repo}/issues`, {
        query: {
          state: "open",
          assignee: "none",
          labels: AGENT_READY_LABEL,
          per_page: "100",
        },
      });
      const issues = (Array.isArray(rows) ? rows : []).filter(
        (i) => !i.pull_request,
      );
      const { items } = await projectItems();
      const todo = new Set(
        items
          .filter((it) => it.fieldValueByName?.name?.toLowerCase() === "todo")
          .filter(
            (it) => (it.content?.repository?.nameWithOwner ?? repo) === repo,
          )
          .map((it) => it.content?.number),
      );
      const out = [];
      for (const issue of issues) {
        if (!todo.has(issue.number)) continue;
        if (issue.assignee) continue;
        const names = (issue.labels ?? []).map((l) => l.name);
        if (!names.includes(AGENT_READY_LABEL)) continue;
        const status = await statusOf(repo, issue.number);
        out.push(normalizeIssue(issue, repo, status));
      }
      return out;
    },

    async claim(identifier, { harness = "claude" } = {}) {
      const { repo, number } = locate(identifier);
      const { issue, ticket } = await fetchIssue(repo, number);
      const me = await call("GET", "user");
      if (!me?.id)
        throw new ControlPlaneError("github viewer is not available");
      const { add, remove } = claimLabels(
        (ticket.labels ?? []).map((l) => l.name),
        harness,
      );
      await requireLabelsExist(repo, add);
      const nextLabels = resolveLabelNames(
        (ticket.labels ?? []).map((l) => l.name),
        { add, remove },
      );
      await call("PUT", `repos/${repo}/issues/${number}/labels`, {
        body: { labels: nextLabels },
      });
      await call("PATCH", `repos/${repo}/issues/${number}`, {
        body: { assignees: [me.login], state: "open" },
      });
      await setStatus(repo, number, issue.node_id ?? ticket.id, "In Progress");

      const back = await call("GET", `repos/${repo}/issues/${number}`);
      const assigneeId =
        back?.assignee?.id != null ? String(back.assignee.id) : null;
      return {
        ok: assigneeId === String(me.id),
        identifier: issueIdentifier(repo, number),
        assignee: back?.assignee?.login ?? back?.assignee?.name ?? null,
      };
    },

    async comment(identifier, body) {
      if (!body) throw new ControlPlaneError(`comment requires a body`);
      const { repo, number } = locate(identifier);
      await fetchIssue(repo, number);
      await call("POST", `repos/${repo}/issues/${number}/comments`, {
        body: { body: stampRun(body) },
      });
    },

    async transition(
      identifier,
      state,
      { add = [], remove = [], unassign } = {},
    ) {
      if (!state && !add.length && !remove.length && !unassign)
        throw new ControlPlaneError(
          `transition requires a state name or a label change`,
        );
      const { repo, number } = locate(identifier);
      const { issue, ticket } = await fetchIssue(repo, number);
      if (state)
        await setStatus(repo, number, issue.node_id ?? ticket.id, state);
      if (add.length || remove.length) {
        await requireLabelsExist(repo, add);
        const nextLabels = resolveLabelNames(
          (ticket.labels ?? []).map((l) => l.name),
          { add, remove },
        );
        await call("PUT", `repos/${repo}/issues/${number}/labels`, {
          body: { labels: nextLabels },
        });
      }
      const patch = {};
      if (unassign) patch.assignees = [];
      if (state)
        patch.state = state.toLowerCase() === "done" ? "closed" : "open";
      if (Object.keys(patch).length)
        await call("PATCH", `repos/${repo}/issues/${number}`, { body: patch });
    },

    async setLabels(identifier, { add = [], remove = [] } = {}) {
      const { repo, number } = locate(identifier);
      const { ticket } = await fetchIssue(repo, number);
      if (!add.length && !remove.length) return;
      await requireLabelsExist(repo, add);
      const nextLabels = resolveLabelNames(
        (ticket.labels ?? []).map((l) => l.name),
        { add, remove },
      );
      await call("PUT", `repos/${repo}/issues/${number}/labels`, {
        body: { labels: nextLabels },
      });
    },

    async file({
      team,
      title,
      body = "",
      labels = [],
      state = "Triage",
      projectId: _projectId,
    } = {}) {
      if (!team || !title)
        throw new ControlPlaneError("file requires team and title");
      const repo = repoForTeam(team);
      await requireLabelsExist(repo, labels);
      const created = await call("POST", `repos/${repo}/issues`, {
        body: {
          title,
          body: stampRun(body),
          labels,
        },
      });
      if (!created?.number)
        throw new ControlPlaneError("issueCreate returned no issue");
      await setStatus(
        repo,
        created.number,
        created.node_id ?? String(created.id),
        state,
      );
      if (state.toLowerCase() === "done")
        await call("PATCH", `repos/${repo}/issues/${created.number}`, {
          body: { state: "closed" },
        });
      return {
        identifier: issueIdentifier(repo, created.number),
        url: created.html_url ?? "",
      };
    },

    async appendDetail(identifier, markdown) {
      const { repo, number } = locate(identifier);
      const { issue } = await fetchIssue(repo, number);
      const { description, appended } = appendIssueDetail(
        issue.body ?? "",
        markdown,
      );
      if (!appended) return { appended: false };
      await call("PATCH", `repos/${repo}/issues/${number}`, {
        body: { body: description },
      });
      return { appended: true };
    },

    async raw(query, variables = {}) {
      if (typeof query === "string" && query.trim().startsWith("/")) {
        return call("GET", query.trim().replace(/^\//, ""), {
          query: variables,
        });
      }
      return call("POST", "graphql", {
        body: { query, variables },
      });
    },
  };
}

function print(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/** CLI: `factory init --control-plane github [--root DIR] [--repo owner/name]`. */
export function runGithubInit(argv, { cwd = process.cwd() } = {}) {
  const args = argv[0] === "init" ? argv.slice(1) : argv;
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1 || i === args.length - 1) return fallback;
    return args[i + 1];
  };
  const controlPlane = flag("control-plane");
  if (!controlPlane) {
    fail(
      "factory init: specify --control-plane github\n" +
        "(Linear remains the default tracker; this command scaffolds GitHub Issues defaults.)",
    );
  }
  if (controlPlane !== "github") {
    fail(
      `factory init: unknown control plane ${JSON.stringify(controlPlane)} — only github is scaffolded (WM-798)`,
    );
  }
  const root = flag("root", cwd);
  const repo = flag("repo", "OWNER/REPO");
  const project = flag("project", DEFAULT_PROJECT);
  const statusField = flag("status-field", DEFAULT_STATUS_FIELD);
  const team = flag("team", "DEMO");
  const written = writeGithubControlPlanePolicy(root, {
    repo,
    teams: { [team]: repo },
    project,
    statusField,
  });
  print(`Wrote ${written.path} (controlPlane.kind=github, repo=${repo}).`);
  print(
    `Next: gh auth login, then create a GitHub Project named ${JSON.stringify(project)} with Status options:\n  ${GITHUB_FACTORY_STATES.join(", ")}`,
  );
  print(
    "Protocol labels (same spelling as Linear): ai:agent-ready, ai:in-progress, ai:needs-review, ai:blocked, agent:claude-code, type:*, source:*.",
  );
  return written;
}

if (import.meta.main) {
  runGithubInit(process.argv.slice(2));
}

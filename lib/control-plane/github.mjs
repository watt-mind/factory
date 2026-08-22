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
// Layering note: lib/ -> event-runtime/lib/ already exists (see
// lib/control-plane/index.mjs, lib/ps.mjs). hashJson is the one canonical
// sha256-description-hash convention (WM-879 reuses it rather than growing
// a second hash format for the same value).
import { hashJson } from "../../event-runtime/lib/canonical.mjs";
import { byQueueOrder, ControlPlaneError } from "./types.mjs";
import {
  agentReadyPinComment,
  AGENT_READY_LABEL,
  appendIssueDetail,
  claimLabels,
  parseAgentReadyPinHash,
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

// WM-879: who most recently edited the issue body. REST's issue payload
// carries `author_association` for the author but has no equivalent for
// edits, so the last editor's login can only come from GraphQL
// `userContentEdits`. Their association is then resolved separately (see
// `associationFromPermission`) — an edit's association is not itself part of
// this connection.
const ISSUE_LAST_EDIT = `query IssueLastEdit($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      userContentEdits(last: 1) {
        nodes { editor { login } }
      }
    }
  }
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
        `label(s) do not exist in this workspace: ${missing.join(", ")}\n` +
          `  fix: factory init --control-plane github --repo ${repo}`,
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

  /**
   * number -> identifiers of its OPEN blockers (WM-1008).
   *
   * GitHub models this as issue dependencies (`blocked_by`). That endpoint is
   * comparatively new and not present on every deployment, so a 404/403 is
   * treated as "this repo has no dependency data" — every ticket unblocked —
   * rather than as a hard failure. That is the same direction Linear's
   * `openBlockers` takes for an issue whose relations were never fetched:
   * absent data must not silently gate the entire queue to empty.
   *
   * It deliberately does NOT fall back to parsing task lists out of issue
   * bodies. A prose-derived blocker that nobody can see in the UI is worse
   * than no blocker at all, because the ticket then stalls invisibly — the
   * exact failure WM-1024 was filed for.
   */
  async function blockedByMap(repo, issues) {
    const out = new Map();
    const openNumbers = new Set(
      issues.filter((i) => i.state !== "closed").map((i) => i.number),
    );
    for (const issue of issues) {
      if (issue.state === "closed") continue;
      let deps;
      try {
        deps = await call(
          "GET",
          `repos/${repo}/issues/${issue.number}/dependencies/blocked_by`,
          { query: { per_page: "100" } },
        );
      } catch (err) {
        if (
          err instanceof ControlPlaneError &&
          (err.status === 404 || err.status === 403 || err.status === 410)
        ) {
          out.set(issue.number, []);
          continue;
        }
        throw err;
      }
      const blockers = (Array.isArray(deps) ? deps : [])
        .filter((d) =>
          d.state ? d.state !== "closed" : openNumbers.has(d.number),
        )
        .map((d) => issueIdentifier(d.repository?.full_name ?? repo, d.number));
      out.set(issue.number, blockers);
    }
    return out;
  }

  function normalizeIssue(issue, repo, status, trust) {
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
      priority: priorityFromLabels(labels),
      createdAt: issue.created_at ?? "",
      // Populated by listTickets/listDispatchable, which resolve dependency
      // state in one batch. A single-issue read leaves it empty rather than
      // firing an extra request per getTicket call.
      blockedBy: issue.__blockedBy ?? [],
      // WM-879: only `getTicket` (dispatch admission's read) computes trust —
      // omitted (not merely null) everywhere else, including listTickets, so
      // the fields stay absent-when-uncomputed rather than misleadingly
      // null. Undefined values are dropped by JSON.stringify, so a Linear
      // ticket and an un-trust-checked GitHub read look identical on the
      // wire: the presence of the key IS the "this is a GitHub getTicket
      // read" signal the planner's trust gate keys off.
      ...(trust
        ? {
            authorAssociation: trust.authorAssociation,
            lastEditor: trust.lastEditor,
            agentReadyPinHash: trust.agentReadyPinHash,
          }
        : {}),
    };
  }

  /**
   * Map a repo permission level (`GET .../collaborators/{login}/permission`)
   * onto the GitHub `authorAssociation` vocabulary, so the last-editor check
   * can be compared against the same {@link TRUSTED_ASSOCIATIONS} the author
   * check uses. `null` means "could not be determined" and the caller must
   * treat that as untrusted (fail closed, WM-879) — never default it to a
   * trusted value.
   */
  function associationFromPermission(permission) {
    switch (permission) {
      case "admin":
        return "OWNER";
      case "maintain":
      case "write":
        return "COLLABORATOR";
      case "triage":
      case "read":
        return "CONTRIBUTOR";
      case "none":
        return "NONE";
      default:
        return null;
    }
  }

  /**
   * WM-879 trust evidence for one issue: the author's `author_association`
   * (already on the REST issue payload) plus the most recent body editor and
   * their association. No edits means the editor IS the author — the common
   * case costs zero extra requests beyond the `userContentEdits` GraphQL
   * call. An edit by someone else costs one more REST call to resolve their
   * permission level; a failure there (rather than a clean "not a
   * collaborator" `none`) is `null`, so it fails closed rather than silently
   * trusting an unresolvable editor.
   */
  async function fetchTrust(repo, number, issue) {
    const authorAssociation = issue.author_association ?? null;
    const authorLogin = issue.user?.login ?? null;
    let editorLogin = authorLogin;
    try {
      const [owner, name] = repo.split("/");
      const d = await call("POST", "graphql", {
        body: {
          query: ISSUE_LAST_EDIT,
          variables: { owner, name, number },
        },
      });
      const nodes = d?.repository?.issue?.userContentEdits?.nodes ?? [];
      if (nodes.length > 0) editorLogin = nodes[0]?.editor?.login ?? null;
    } catch {
      editorLogin = null; // unresolvable edit history fails closed below
    }

    let editorAssociation;
    if (editorLogin === null) {
      editorAssociation = null;
    } else if (editorLogin === authorLogin) {
      editorAssociation = authorAssociation;
    } else {
      try {
        const perm = await call(
          "GET",
          `repos/${repo}/collaborators/${editorLogin}/permission`,
        );
        editorAssociation = associationFromPermission(perm?.permission);
      } catch {
        editorAssociation = null;
      }
    }

    const pinComments = await call(
      "GET",
      `repos/${repo}/issues/${number}/comments`,
      { query: { per_page: "100", sort: "created", direction: "desc" } },
    );
    let agentReadyPinHash = null;
    for (const c of Array.isArray(pinComments) ? pinComments : []) {
      const hash = parseAgentReadyPinHash(c?.body);
      if (hash) {
        agentReadyPinHash = hash;
        break;
      }
    }

    return {
      authorAssociation,
      lastEditor: { login: editorLogin, association: editorAssociation },
      agentReadyPinHash,
    };
  }

  /**
   * WM-879: whenever a label change applies `ai:agent-ready`, pin the
   * CURRENT description hash as a marker comment. Fires on every label
   * change that adds the label, including a re-label of a ticket that
   * already carried it — "a re-label refreshes the pin" is the intended
   * behaviour, not idempotence to avoid.
   */
  async function pinAgentReadyIfLabeling(repo, number, description, add) {
    if (!add.includes(AGENT_READY_LABEL)) return;
    const hash = hashJson(description ?? "");
    await call("POST", `repos/${repo}/issues/${number}/comments`, {
      body: { body: agentReadyPinComment(hash) },
    });
  }

  /**
   * GitHub has no priority field, so the protocol binds it to a `priority:N`
   * label (WM-1008). Absent means null, which sorts LAST — an unprovisioned
   * repo degrades to createdAt order instead of erroring or, worse, treating
   * every unlabelled ticket as most urgent.
   */
  function priorityFromLabels(labels) {
    for (const l of labels) {
      const m = /^priority:(\d+)$/.exec(l.name ?? "");
      if (m) return Number(m[1]);
    }
    return null;
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
      const { issue, status } = await fetchIssue(repo, number);
      const trust = await fetchTrust(repo, number, issue);
      return normalizeIssue(issue, repo, status, trust);
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

    /**
     * @param {{ team: string, project?: string, states?: string[],
     *           resolveBlockers?: boolean }} [opts]
     *
     * `resolveBlockers` is OFF by default and that default is load-bearing
     * (WM-1044). GitHub has no bulk dependency read, so resolving blockers
     * costs one request per issue. Doing it for every open issue made a single
     * `listDispatchable` cost `1 + N` requests — measured at 6 for 6 issues,
     * which projects to ~251 on a 250-issue board and 15,000/hr against a
     * 5,000/hr limit. The factory would rate-limit itself within minutes and
     * take merges and PR creation down with it, since they share the budget.
     *
     * Callers that need the gate ask for it, and `listDispatchable` asks only
     * AFTER narrowing to real candidates.
     */
    async listTickets({ team, project, states, resolveBlockers = false } = {}) {
      if (!team) throw new ControlPlaneError("listTickets requires team");
      if (project && project !== projectTitle) return [];
      const repo = repoForTeam(team);
      const rows = await call("GET", `repos/${repo}/issues`, {
        query: { state: "all", per_page: "100" },
      });
      const issues = (Array.isArray(rows) ? rows : []).filter(
        (i) => !i.pull_request,
      );
      const { items } = await projectItems();
      const statusByNumber = new Map(
        items
          .filter(
            (it) => (it.content?.repository?.nameWithOwner ?? repo) === repo,
          )
          .map((it) => [it.content?.number, it.fieldValueByName?.name]),
      );
      const wanted = states?.length
        ? new Set(states.map((n) => n.toLowerCase()))
        : null;
      // Narrow FIRST; only then pay per-issue costs.
      const kept = [];
      for (const issue of issues) {
        const statusName =
          statusByNumber.get(issue.number) ??
          (issue.state === "closed" ? "Done" : "Triage");
        const name = String(statusName).toLowerCase();
        if (wanted ? !wanted.has(name) : ["done", "canceled"].includes(name))
          continue;
        kept.push({ issue, statusName });
      }
      const open = resolveBlockers
        ? await blockedByMap(
            repo,
            kept.map((k) => k.issue),
          )
        : null;
      return kept
        .map(({ issue, statusName }) =>
          normalizeIssue(
            { ...issue, __blockedBy: open?.get(issue.number) ?? [] },
            repo,
            { name: statusName, opt: null },
          ),
        )
        .sort(byQueueOrder);
    },

    async listDispatchable({ team, project } = {}) {
      if (!team) throw new ControlPlaneError("listDispatchable requires team");
      // Cheap predicate first — state, labels, assignee are already in the
      // issue list response and cost nothing extra. Only the survivors are
      // worth a dependency request each.
      const candidates = (
        await this.listTickets({ team, project, states: ["Todo"] })
      ).filter(
        (t) =>
          !t.assignee &&
          (t.labels ?? []).some((l) => l.name === AGENT_READY_LABEL),
      );
      if (!candidates.length) return [];
      const repo = repoForTeam(team);
      const open = await blockedByMap(
        repo,
        candidates.map((t) => ({
          number: Number(t.identifier.split("#")[1]),
          state: "open",
        })),
      );
      return candidates
        .map((t) => ({
          ...t,
          blockedBy: open.get(Number(t.identifier.split("#")[1])) ?? [],
        }))
        .filter((t) => t.blockedBy.length === 0);
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
        await pinAgentReadyIfLabeling(repo, number, ticket.description, add);
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
      await pinAgentReadyIfLabeling(repo, number, ticket.description, add);
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
      const stampedBody = stampRun(body);
      const created = await call("POST", `repos/${repo}/issues`, {
        body: {
          title,
          body: stampedBody,
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
      // WM-879: `file --todo` can hand a ticket straight to Todo +
      // ai:agent-ready without ever calling transition/setLabels — an
      // operator-injected dispatch is exactly the case "no operator bypass"
      // covers, so it is pinned here too.
      await pinAgentReadyIfLabeling(repo, created.number, stampedBody, labels);
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

/**
 * The protocol's full label set, with colours and descriptions (WM-1009).
 *
 * GitHub labels are per-REPOSITORY, not per-org, so every managed repo needs
 * all of these. Hand-creating ~20 labels with exactly the right spelling is
 * not a quickstart; one typo surfaces much later as a runtime error inside an
 * unattended loop, which is why `factory init` provisions them.
 *
 * Colours are grouped so a human scanning the issue list can read lifecycle
 * from colour alone: ai:* blue-greys, type:* by kind, source:* muted,
 * priority:* a red-to-green ramp.
 */
export const PROTOCOL_LABELS = Object.freeze([
  ["ai:agent-ready", "1d76db", "Specified and waiting to be picked up"],
  ["ai:in-progress", "0e8a16", "An agent holds the claim"],
  ["ai:needs-review", "5319e7", "PR is up; the merge stage owns it"],
  ["ai:blocked", "b60205", "Waiting on a human"],
  ["ai:escalated", "d93f0b", "Security-relevant diff; a human must merge"],
  ["type:bug", "d73a4a", "Something is broken"],
  ["type:feature", "0075ca", "New capability"],
  ["type:ui-ux", "c5def5", "Interface or interaction change"],
  ["type:security", "b60205", "Security-relevant"],
  ["type:performance", "fbca04", "Speed or resource use"],
  ["type:maintenance", "cfd3d7", "Upkeep, refactors, dependencies"],
  ["type:docs", "0052cc", "Documentation"],
  ["type:a11y", "006b75", "Accessibility"],
  ["source:agent", "ededed", "Discovered by an agent"],
  ["source:human", "ededed", "Requested by a human"],
  ["source:sentry", "ededed", "From a Sentry issue"],
  ["source:client-support", "ededed", "From client support"],
  ["priority:0", "b60205", "Urgent"],
  ["priority:1", "d93f0b", "High"],
  ["priority:2", "fbca04", "Medium"],
  ["priority:3", "0e8a16", "Low"],
  ["priority:4", "cfd3d7", "None"],
]);

/** `agent:<harness>` labels for the harnesses the factory can dispatch to. */
export const AGENT_LABELS = Object.freeze([
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "pi",
]);

/** Every label name `factory init` provisions, in creation order. */
export function protocolLabelSpecs() {
  return [
    ...PROTOCOL_LABELS.map(([name, color, description]) => ({
      name,
      color,
      description,
    })),
    ...AGENT_LABELS.map((h) => ({
      name: `agent:${h}`,
      color: "e4e669",
      description: `Claimed by the ${h} harness`,
    })),
  ];
}

/**
 * Create the protocol labels and the Projects v2 board in `repo` (WM-1009).
 *
 * Idempotent by construction: existing labels are LEFT ALONE, never patched.
 * A maintainer who recoloured `type:bug` or rewrote a description meant it,
 * and an init that silently reverted their choice on every run would be a
 * worse bug than the missing label this fixes.
 *
 * @param {(m:string,p:string,o?:object)=>Promise<any>} call  gh api seam
 * @param {string} repo owner/name
 * @param {{ dryRun?: boolean, project?: string, statusField?: string }} opts
 */
export async function provisionGithubRepo(call, repo, opts = {}) {
  const {
    dryRun = false,
    project = DEFAULT_PROJECT,
    statusField = DEFAULT_STATUS_FIELD,
  } = opts;
  const report = { created: [], existed: [], board: null, dryRun };

  let existing;
  try {
    const rows = await call("GET", `repos/${repo}/labels`, {
      query: { per_page: "100" },
    });
    existing = Array.isArray(rows) ? rows : [];
  } catch (err) {
    throw scopeHint(err, repo, "repo");
  }
  const have = new Set(existing.map((l) => l.name));

  for (const spec of protocolLabelSpecs()) {
    if (have.has(spec.name)) {
      report.existed.push(spec.name);
      continue;
    }
    report.created.push(spec.name);
    if (dryRun) continue;
    try {
      await call("POST", `repos/${repo}/labels`, { body: spec });
    } catch (err) {
      // A concurrent init (or a human) may have created it between the list
      // and the write. That is success, not a conflict worth failing on.
      if (err instanceof ControlPlaneError && err.status === 422) continue;
      throw scopeHint(err, repo, "repo");
    }
  }

  report.board = await provisionBoard(call, repo, {
    dryRun,
    project,
    statusField,
  });
  return report;
}

/**
 * Ensure the Projects v2 board exists with exactly the factory's states.
 *
 * A board whose Status options do NOT match fails loudly rather than being
 * half-configured: a missing option means `transition()` to that state throws
 * later, inside an unattended loop, where it reads as a tracker outage rather
 * than a setup mistake.
 */
async function provisionBoard(call, repo, { dryRun, project, statusField }) {
  const [owner] = repo.split("/");
  let found;
  try {
    const d = await call("POST", "graphql", {
      body: {
        query: FIND_REPO_PROJECT,
        variables: {
          owner,
          name: repo.split("/")[1],
          title: project,
          statusField,
        },
      },
    });
    found = (d?.data ?? d)?.repository?.projectsV2?.nodes?.find(
      (p) => p.title === project,
    );
  } catch (err) {
    throw scopeHint(err, repo, "project");
  }

  if (!found) {
    return dryRun
      ? { action: "would-create", title: project }
      : {
          action: "manual",
          title: project,
          statusField,
          options: [...GITHUB_FACTORY_STATES],
          // Projects v2 creation needs an owner id and a field-definition
          // mutation per option; doing it blind against the wrong owner
          // (user vs org) creates a board in the wrong place that then has to
          // be found and deleted. Report precisely what to make instead.
          hint: `Create a Projects v2 board named ${JSON.stringify(project)} on ${owner} with a single-select field ${JSON.stringify(statusField)} whose options are exactly: ${GITHUB_FACTORY_STATES.join(", ")}`,
        };
  }

  const options = (found.field?.options ?? []).map((o) => o.name);
  const missing = GITHUB_FACTORY_STATES.filter((s) => !options.includes(s));
  if (missing.length) {
    throw new ControlPlaneError(
      `project ${JSON.stringify(project)} field ${JSON.stringify(statusField)} is missing option(s): ${missing.join(", ")} — have: ${options.join(", ") || "(none)"}`,
    );
  }
  return { action: "exists", title: project, options };
}

/** Turn a permission failure into an error that names the scope needed. */
function scopeHint(err, repo, scope) {
  if (
    err instanceof ControlPlaneError &&
    (err.status === 403 || err.status === 404)
  ) {
    return new ControlPlaneError(
      `${err.message}\n  hint: the gh token needs the '${scope}' scope for ${repo}. Run: gh auth refresh -s ${scope}`,
      { status: err.status, cause: err },
    );
  }
  return err;
}

function print(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/** CLI: `factory init --control-plane github [--root DIR] [--repo owner/name]`. */
export async function runGithubInit(argv, { cwd = process.cwd(), api } = {}) {
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

  // Nothing to provision against a placeholder — the operator has not said
  // which repo yet, so writing the policy is the whole job.
  if (repo === "OWNER/REPO") {
    print(
      `Next: re-run with --repo owner/name to create the protocol labels and check the ${JSON.stringify(project)} board.`,
    );
    return written;
  }

  const dryRun = args.includes("--dry-run");
  const call = api ?? makeGhApi();
  let report;
  try {
    report = await provisionGithubRepo(call, repo, {
      dryRun,
      project,
      statusField,
    });
  } catch (err) {
    // Writing the policy is the command's contract and it already succeeded.
    // Provisioning needs network + auth, and failing the whole command here
    // would break scaffolding a config offline — which is exactly what an
    // operator does before running `gh auth login`. Report and exit 0.
    print(`Labels/board: not provisioned — ${err.message}`);
    print(
      `  retry once authenticated: factory init --control-plane github --repo ${repo}`,
    );
    return written;
  }

  const verb = dryRun ? "would create" : "created";
  print(
    `Labels: ${verb} ${report.created.length}, already present ${report.existed.length}.`,
  );
  if (report.created.length) print(`  ${report.created.join(", ")}`);
  if (report.board?.action === "exists")
    print(`Board ${JSON.stringify(project)}: present with all Status options.`);
  else if (report.board?.action === "would-create")
    print(`Board ${JSON.stringify(project)}: missing (dry run).`);
  else if (report.board?.hint) print(`Board: ${report.board.hint}`);
  if (dryRun) print("(dry run — nothing was written to GitHub)");
  return { ...written, report };
}

if (import.meta.main) await runGithubInit(process.argv.slice(2));

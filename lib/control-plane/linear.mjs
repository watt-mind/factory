/**
 * Linear ControlPlane — wraps the existing GraphQL client (WM-797).
 *
 * A pure move of the verbs `tools/linear.mjs` already speaks. It still
 * posts to Linear's GraphQL API via `gql()` from `orchestrator/reaper.mjs`
 * (retries, backoff and key loading stay there); what changed is that
 * ticket shape, claim read-back and label-set math happen in exactly one
 * place and the caller never sees a GraphQL `nodes` wrapper.
 *
 * `gql` is the seam: `(query, variables) => Promise<data>`, so the
 * contract suite can drive the implementation with a fake tracker and no
 * network.
 */
import { gql as defaultGql } from "../../orchestrator/reaper.mjs";
import { byQueueOrder, ControlPlaneError, OPEN_STATE_TYPES } from "./types.mjs";
import {
  AGENT_READY_LABEL,
  appendIssueDetail,
  claimLabels,
  resolveLabelIds,
  stampRun,
  validateLabels,
} from "./labels.mjs";

// WM-1008: priority, createdAt and the blocker relations travel with every
// issue read, so ordering and gating never need a second round trip. For
// issue X, `inverseRelations` are the relations where X is the relatedIssue;
// on a `blocks` node the blocker is `node.issue` (plain `relations` would
// give what X blocks — the wrong direction). State `type`, not name: workflow
// names are per-team config, the types are Linear's own enum.
const BLOCKERS = `inverseRelations(first:250){ nodes{ type issue{ identifier state{ type } } } }`;
const PAGE_CAP = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ISSUE_FIELDS = `id identifier title url description createdAt startedAt updatedAt priority
  state{ id name type } assignee{ id name }
  team{ key } project{ name }
  labels(first:30){ nodes{ id name } }
  comments(last:1){ nodes{ createdAt } }
  ${BLOCKERS}`;

const teamOf = (key) => String(key).split("-")[0];

function requestTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Flatten Linear's `{ nodes }` label wrapper into the ControlPlane shape. */
export function normalizeTicket(issue) {
  if (!issue) return null;
  const labels = Array.isArray(issue.labels)
    ? issue.labels
    : (issue.labels?.nodes ?? []);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    url: issue.url ?? "",
    state: issue.state ?? null,
    assignee: issue.assignee ?? null,
    team: issue.team ?? null,
    project: issue.project ?? null,
    labels: labels.map((l) => ({ id: l.id, name: l.name })),
    // Linear encodes "no priority" as 0. Left as 0 it would sort as the MOST
    // urgent value, i.e. exactly backwards, so it becomes null and sorts last.
    priority:
      typeof issue.priority === "number" && issue.priority > 0
        ? issue.priority
        : null,
    createdAt: issue.createdAt ?? "",
    startedAt: issue.startedAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    lastCommentAt:
      issue.comments?.nodes?.[issue.comments.nodes.length - 1]?.createdAt ??
      null,
    blockedBy: openBlockerIdentifiers(issue),
  };
}

/** Identifiers of unfinished `blocks` relations. `related`/`duplicate` never gate. */
function openBlockerIdentifiers(issue) {
  return (issue?.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => r.issue)
    .filter((b) => b && !OPEN_STATE_TYPES.includes(b.state?.type))
    .map((b) => b.identifier);
}

/**
 * @param {{ gql?: (query: string, variables?: object) => Promise<object>, timeoutMs?: number }} [options]
 * @returns {import("./types.mjs").ControlPlane}
 */
export function linearControlPlane({
  gql = defaultGql,
  timeoutMs = process.env.FACTORY_LINEAR_TIMEOUT_MS,
} = {}) {
  const requestTimeout = requestTimeoutMs(timeoutMs);

  async function call(query, variables = {}) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => gql(query, variables)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ControlPlaneError(
                  `linear graphql timed out after ${requestTimeout}ms`,
                ),
              ),
            requestTimeout,
          );
        }),
      ]);
    } catch (cause) {
      if (cause instanceof ControlPlaneError) throw cause;
      throw new ControlPlaneError(
        cause?.message ? String(cause.message) : "linear graphql failed",
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function collectPages(query, variables, connectionFor, name) {
    const nodes = [];
    let after = null;
    for (;;) {
      const d = await call(query, { ...variables, after });
      const connection = connectionFor(d);
      const page = connection?.nodes ?? [];
      if (nodes.length + page.length > PAGE_CAP)
        throw new ControlPlaneError(
          `linear ${name} pagination exceeded ${PAGE_CAP} rows`,
        );
      nodes.push(...page);
      if (!connection?.pageInfo?.hasNextPage) return nodes;
      after = connection.pageInfo.endCursor;
      if (!after)
        throw new ControlPlaneError(
          `linear ${name} pagination has next page without an end cursor`,
        );
    }
  }

  async function issueByKey(key) {
    const d = await call(
      `query($k:String!){ issue(id:$k){ ${ISSUE_FIELDS} } }`,
      { k: key },
    );
    const issue = normalizeTicket(d?.issue);
    if (!issue) throw new ControlPlaneError(`no such issue: ${key}`);
    return issue;
  }

  async function statesFor(teamKey) {
    const d = await call(
      `query($t:String!){ teams(filter:{key:{eq:$t}}, first:1){ nodes{ id states(first:50){ nodes{ id name } } } } }`,
      { t: teamKey },
    );
    const team = d?.teams?.nodes?.[0];
    if (!team) throw new ControlPlaneError(`no such team: ${teamKey}`);
    return { teamId: team.id, states: team.states?.nodes ?? [] };
  }

  async function allLabels() {
    return collectPages(
      `query($after:String){ issueLabels(first:250,after:$after){ nodes{ id name } pageInfo{ hasNextPage endCursor } } }`,
      {},
      (d) => d?.issueLabels,
      "labels",
    );
  }

  async function labelIdsFor(issue, add, remove) {
    const bad = validateLabels(add);
    if (bad.length)
      throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
    let all = await allLabels();
    let missing = add.filter((n) => !all.some((l) => l.name === n));
    if (missing.length) all = await allLabels();
    missing = add.filter((n) => !all.some((l) => l.name === n));
    if (missing.length)
      throw new ControlPlaneError(
        `label(s) do not exist in this workspace: ${missing.join(", ")}`,
      );
    const current = (issue.labels ?? []).map((l) => l.name);
    return resolveLabelIds(current, { add, remove }, all);
  }

  async function issueUpdate(id, input) {
    const updated = await call(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id, in: input },
    );
    if (updated?.issueUpdate && updated.issueUpdate.success === false)
      throw new ControlPlaneError(`issueUpdate failed for ${id}`);
  }

  return {
    kind: "linear",

    async getTicket(identifier) {
      return issueByKey(identifier);
    },

    async listComments(identifier) {
      let foundIssue = false;
      const comments = await collectPages(
        `query($k:String!,$after:String){ issue(id:$k){ id comments(first:50,after:$after){ nodes{ id body createdAt user{ id name } } pageInfo{ hasNextPage endCursor } } } }`,
        { k: identifier },
        (d) => {
          foundIssue ||= Boolean(d?.issue);
          return d?.issue?.comments;
        },
        "comments",
      );
      if (!foundIssue)
        throw new ControlPlaneError(`no such issue: ${identifier}`);
      return comments;
    },

    async listTickets({ team, project, states, includeFinished = false } = {}) {
      if (!team) throw new ControlPlaneError("listTickets requires team");
      // No `states` means "everything not finished" — the dispatcher needs
      // In Progress (for Owned Paths of running work) and Todo from one read.
      const stateFilter = states?.length
        ? `state:{ name:{ in:$s } }`
        : includeFinished
          ? null
          : `state:{ type:{ nin:["completed","canceled"] } }`;
      const stateClause = stateFilter ? `${stateFilter},` : "";
      const decl = states?.length ? ", $s:[String!]" : "";
      const vars = { t: team, ...(project ? { p: project } : {}) };
      if (states?.length) vars.s = states;
      const query = project
        ? `query($t:String!,$p:String!${decl},$after:String){ issues(first:250,after:$after, filter:{ team:{key:{eq:$t}}, project:{name:{eq:$p}}, ${stateClause} }){ nodes{ ${ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`
        : `query($t:String!${decl},$after:String){ issues(first:250,after:$after, filter:{ team:{key:{eq:$t}}, ${stateClause} }){ nodes{ ${ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`;
      return (await collectPages(query, vars, (d) => d?.issues, "issues"))
        .map(normalizeTicket)
        .sort(byQueueOrder);
    },

    async listDispatchable({ team, project } = {}) {
      if (!team) throw new ControlPlaneError("listDispatchable requires team");
      const todo = await this.listTickets({ team, project, states: ["Todo"] });
      return todo.filter(
        (i) =>
          !i.assignee &&
          (i.labels ?? []).some((l) => l.name === AGENT_READY_LABEL) &&
          (i.blockedBy ?? []).length === 0,
      );
    },

    async claim(identifier, { harness = "claude" } = {}) {
      const issue = await issueByKey(identifier);
      const teamKey = issue.team?.key ?? teamOf(identifier);
      const { states } = await statesFor(teamKey);
      const inProgress = states.find(
        (s) => s.name.toLowerCase() === "in progress",
      );
      if (!inProgress)
        throw new ControlPlaneError(
          `team ${teamKey} has no "In Progress" state`,
        );

      const me = (await call(`query{ viewer{ id name } }`))?.viewer;
      if (!me?.id)
        throw new ControlPlaneError("linear viewer is not available");
      const { add, remove } = claimLabels(
        (issue.labels ?? []).map((l) => l.name),
        harness,
      );
      const labelIds = await labelIdsFor(issue, add, remove);

      await issueUpdate(issue.id, {
        stateId: inProgress.id,
        assigneeId: me.id,
        labelIds,
      });

      // Linear has no compare-and-swap; this read-back IS the concurrency control.
      const back = (
        await call(
          `query($id:String!){ issue(id:$id){ assignee{ id name } } }`,
          { id: issue.id },
        )
      )?.issue;
      return {
        ok: back?.assignee?.id === me.id,
        identifier,
        assignee: back?.assignee?.name ?? null,
      };
    },

    async comment(identifier, body) {
      if (!body) throw new ControlPlaneError(`comment requires a body`);
      const issue = await issueByKey(identifier);
      const commented = await call(
        `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
        { in: { issueId: issue.id, body: stampRun(body) } },
      );
      if (commented?.commentCreate && commented.commentCreate.success === false)
        throw new ControlPlaneError(`failed to comment on ${identifier}`);
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
      const issue = await issueByKey(identifier);
      const input = {};
      if (state) {
        const teamKey = issue.team?.key ?? teamOf(identifier);
        const { states } = await statesFor(teamKey);
        const target = states.find(
          (s) => s.name.toLowerCase() === state.toLowerCase(),
        );
        if (!target)
          throw new ControlPlaneError(
            `no state "${state}" on team ${teamKey} — have: ${states.map((s) => s.name).join(", ")}`,
          );
        input.stateId = target.id;
      }
      if (add.length || remove.length)
        input.labelIds = await labelIdsFor(issue, add, remove);
      if (unassign) input.assigneeId = null;
      await issueUpdate(issue.id, input);
    },

    async setLabels(identifier, { add = [], remove = [] } = {}) {
      const issue = await issueByKey(identifier);
      if (!add.length && !remove.length) return;
      await issueUpdate(issue.id, {
        labelIds: await labelIdsFor(issue, add, remove),
      });
    },

    // Linear-plane behaviour predates PR protection in the GitHub adapter.
    // Keep it byte-for-byte: Linear remains governed by the existing claim
    // activity predicate and does not invent a forge lookup here.
    async hasOpenPullRequest(_identifier) {
      return false;
    },

    async file({
      team,
      title,
      body = "",
      labels = [],
      state = "Triage",
      projectId,
    } = {}) {
      if (!team || !title)
        throw new ControlPlaneError("file requires team and title");
      const bad = validateLabels(labels);
      if (bad.length)
        throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
      const { teamId, states } = await statesFor(team);
      const target = states.find(
        (s) => s.name.toLowerCase() === state.toLowerCase(),
      );
      if (!target)
        throw new ControlPlaneError(`team ${team} has no "${state}" state`);
      const all = await allLabels();
      const missing = labels.filter((n) => !all.some((l) => l.name === n));
      if (missing.length)
        throw new ControlPlaneError(
          `label(s) do not exist in this workspace: ${missing.join(", ")}`,
        );
      const d = await call(
        `mutation($in:IssueCreateInput!){ issueCreate(input:$in){ success issue{ identifier url } } }`,
        {
          in: {
            teamId,
            title,
            description: stampRun(body),
            stateId: target.id,
            labelIds: resolveLabelIds([], { add: labels }, all),
            ...(projectId ? { projectId } : {}),
          },
        },
      );
      const created = d?.issueCreate?.issue;
      if (!created)
        throw new ControlPlaneError("issueCreate returned no issue");
      return { identifier: created.identifier, url: created.url };
    },

    async appendDetail(identifier, markdown) {
      const issue = await issueByKey(identifier);
      const { description, appended } = appendIssueDetail(
        issue.description,
        markdown,
      );
      if (!appended) return { appended: false };
      await issueUpdate(issue.id, { description });
      return { appended: true };
    },

    async raw(query, variables = {}) {
      return call(query, variables);
    },
  };
}

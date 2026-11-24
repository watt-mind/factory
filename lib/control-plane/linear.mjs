/**
 * Linear ControlPlane — wraps the existing GraphQL client (WM-797).
 *
 * A pure move of the verbs `tools/ticket.mjs` already speaks. It still
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
import { installLinearBudgetCapture } from "../../tools/ticket.mjs";
import { byQueueOrder, ControlPlaneError, OPEN_STATE_TYPES } from "./types.mjs";
import {
  AGENT_READY_LABEL,
  appendIssueDetail,
  classifyAgentReadyRemoval,
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
const BLOCKERS = `inverseRelations(first:250){ nodes{ type issue{ identifier state{ type } } } pageInfo{ hasNextPage endCursor } }`;
const PAGE_CAP = 2_000;
// Per-attempt GraphQL request timeout (ms). Override via the
// FACTORY_LINEAR_TIMEOUT_MS environment variable or the `timeoutMs` option.
// Raised from 15s to 30s because heavy Linear GraphQL queries frequently
// exceed 15s (GH-2323). Rate-limit and 4xx/validation replies fail fast;
// transient timeouts, 5xx responses, and network errors retry with jitter.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);
const ISSUE_FIELDS = `id identifier title url description createdAt startedAt updatedAt priority
  state{ id name type } assignee{ id name }
  team{ key } project{ name }
  labels(first:30){ nodes{ id name } pageInfo{ hasNextPage endCursor } }
  comments(last:1){ nodes{ createdAt } }
  ${BLOCKERS}`;
const LIST_ISSUE_FIELDS = `id identifier title url description createdAt startedAt updatedAt priority
  state{ id name type } assignee{ id name }
  team{ key } project{ name }
  labels(first:30){ nodes{ id name } pageInfo{ hasNextPage endCursor } }`;
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 250;

const teamOf = (key) => String(key).split("-")[0];
const LINEAR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

function normalizeMaxRetries(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_RETRIES;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RETRIES;
}

function normalizeRetryBaseDelayMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_RETRY_BASE_DELAY_MS;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampUnit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function retryDelayMs(attempt, baseDelayMs, random) {
  const exp = baseDelayMs * 2 ** attempt;
  const jitter = 0.5 + clampUnit(random()) * 0.5;
  return Math.max(0, Math.round(exp * jitter));
}

function extractHttpStatus(err) {
  if (typeof err?.status === "number" && Number.isInteger(err.status)) {
    return err.status;
  }
  const msg = typeof err?.message === "string" ? err.message : "";
  const match = msg.match(/^HTTP (\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function isRetryableError(err, isTimeout) {
  if (isTimeout) return true;
  if (!err) return false;
  if (err.rateLimited || err.cause?.rateLimited) return false;
  if (err.code === "linear_offline_guard") return false;
  if (Array.isArray(err.errors)) return false;

  const status = extractHttpStatus(err);
  if (status !== null) {
    if (status === 429 || (status >= 400 && status < 500)) return false;
    if (status >= 500 && status < 600) return true;
  }

  const msg = typeof err.message === "string" ? err.message : "";
  if (
    msg.startsWith("linear_rate_limited") ||
    msg.toUpperCase().includes("RATELIMITED")
  ) {
    return false;
  }

  if (err.name === "TimeoutError") return true;
  const code = err.code ?? err.cause?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }
  if (
    err instanceof TypeError &&
    /fetch failed|unable to connect|network|socket/i.test(msg)
  ) {
    return true;
  }
  return false;
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
 * Which ticket a GraphQL operation is about, for the request log.
 *
 * Most operations are told explicitly by their caller, because the wire
 * variables carry an opaque Linear UUID (`$id`) rather than the human key an
 * operator greps for. The variable fallbacks cover `raw()` and any future
 * query that has a key in hand but no explicit ref; team- and
 * workspace-scoped reads legitimately resolve to null.
 */
function ticketRefFor(ticket, variables = {}) {
  return (
    ticket ??
    variables.k ??
    variables.identifier ??
    variables.id ??
    variables.in?.issueId ??
    null
  );
}

/**
 * @param {{
 *   gql?: (query: string, variables?: object, signal?: AbortSignal) => Promise<object>,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   retryBaseDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 * }} [options]
 * @returns {import("./types.mjs").ControlPlane}
 */
export function linearControlPlane({
  gql = defaultGql,
  timeoutMs = process.env.FACTORY_LINEAR_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  const requestTimeout = requestTimeoutMs(timeoutMs);
  const retries = normalizeMaxRetries(maxRetries);
  const baseDelayMs = normalizeRetryBaseDelayMs(retryBaseDelayMs);
  // Installing the `fetch` capture hook is an entry-point concern, done once
  // when the plane is constructed rather than on every request, and never
  // when a fake `gql` is injected — a test must not swap the global `fetch`.
  if (gql === defaultGql) {
    try {
      installLinearBudgetCapture();
    } catch {
      // Budget/telemetry capture is best-effort; it must not block a request.
    }
  }

  /**
   * Bound one GraphQL operation per attempt, cancelling the underlying fetch
   * on timeout, and retry transient timeouts / 5xx / network errors with
   * jittered backoff. 4xx, GraphQL validation, and Linear rate-limit errors
   * fail fast without retrying.
   *
   * Override the per-attempt timeout via `FACTORY_LINEAR_TIMEOUT_MS`.
   *
   * Non-idempotent create mutations (`commentCreate`, `issueCreate`) pass
   * `{ retry: false }` because a failed or timed-out create has an unknown
   * server outcome and must not be blindly replayed (callers inspect the
   * resulting resource instead).
   */
  async function call(
    query,
    variables = {},
    ticket = null,
    { retry = true } = {},
  ) {
    const maxAttempts = retry ? 1 + retries : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let timer;
      const controller = new AbortController();
      const timeoutError = new ControlPlaneError(
        `linear graphql timed out after ${requestTimeout}ms`,
      );
      try {
        return await Promise.race([
          Promise.resolve().then(() =>
            gql === defaultGql
              ? gql(query, variables, {
                  retries: 1,
                  signal: controller.signal,
                  caller: "lib/control-plane/linear",
                  ticket: ticketRefFor(ticket, variables),
                })
              : gql(query, variables, controller.signal),
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort(timeoutError);
              reject(timeoutError);
            }, requestTimeout);
          }),
        ]);
      } catch (cause) {
        const isTimeout = cause === timeoutError;
        const retryable = isRetryableError(cause, isTimeout);
        const attempts = attempt + 1;
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(retryDelayMs(attempt, baseDelayMs, random));
          continue;
        }
        if (isTimeout) {
          const attemptSuffix =
            attempts > 1 ? ` across ${attempts} attempts` : "";
          throw new ControlPlaneError(
            `linear graphql timed out after ${requestTimeout}ms${attemptSuffix} (set FACTORY_LINEAR_TIMEOUT_MS to override)`,
          );
        }
        if (cause instanceof ControlPlaneError) throw cause;
        const status = extractHttpStatus(cause);
        const baseMessage = cause?.message
          ? String(cause.message)
          : "linear graphql failed";
        const message =
          retryable && attempts > 1
            ? `${baseMessage} (failed after ${attempts} attempts; timeout ${requestTimeout}ms, set FACTORY_LINEAR_TIMEOUT_MS to override)`
            : baseMessage;
        throw new ControlPlaneError(message, { status, cause });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function collectPages(
    query,
    variables,
    connectionFor,
    name,
    initialConnection,
    ticket = null,
  ) {
    const nodes = [...(initialConnection?.nodes ?? [])];
    if (nodes.length > PAGE_CAP)
      throw new ControlPlaneError(
        `linear ${name} pagination exceeded ${PAGE_CAP} rows`,
      );
    let after = initialConnection?.pageInfo?.endCursor ?? null;
    let hasNextPage = initialConnection
      ? Boolean(initialConnection.pageInfo?.hasNextPage)
      : true;
    while (hasNextPage) {
      if (after === null && initialConnection)
        throw new ControlPlaneError(
          `linear ${name} pagination has next page without an end cursor`,
        );
      const d = await call(query, { ...variables, after }, ticket);
      const connection = connectionFor(d);
      const page = connection?.nodes ?? [];
      if (nodes.length + page.length > PAGE_CAP)
        throw new ControlPlaneError(
          `linear ${name} pagination exceeded ${PAGE_CAP} rows`,
        );
      nodes.push(...page);
      hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
      if (!hasNextPage) return nodes;
      after = connection.pageInfo.endCursor;
      if (!after)
        throw new ControlPlaneError(
          `linear ${name} pagination has next page without an end cursor`,
        );
    }
    return nodes;
  }

  async function paginateIssueConnections(issue) {
    if (!issue?.id) return issue;
    const ticket = issue.identifier ?? null;
    const paged = { ...issue };
    if (issue.labels?.pageInfo?.hasNextPage) {
      paged.labels = {
        ...issue.labels,
        nodes: await collectPages(
          `query TicketLabelsPage($id:String!,$after:String){ issue(id:$id){ labels(first:30,after:$after){ nodes{ id name } pageInfo{ hasNextPage endCursor } } } }`,
          { id: issue.id },
          (d) => d?.issue?.labels,
          "ticket labels",
          issue.labels,
          ticket,
        ),
      };
    }
    if (issue.inverseRelations?.pageInfo?.hasNextPage) {
      paged.inverseRelations = {
        ...issue.inverseRelations,
        nodes: await collectPages(
          `query TicketRelationsPage($id:String!,$after:String){ issue(id:$id){ inverseRelations(first:250,after:$after){ nodes{ type issue{ identifier state{ type } } } pageInfo{ hasNextPage endCursor } } } }`,
          { id: issue.id },
          (d) => d?.issue?.inverseRelations,
          "ticket inverse relations",
          issue.inverseRelations,
          ticket,
        ),
      };
    }
    return paged;
  }

  async function issueByKey(key) {
    const d = await call(
      `query($k:String!){ issue(id:$k){ ${ISSUE_FIELDS} } }`,
      { k: key },
      key,
    );
    const issue = normalizeTicket(await paginateIssueConnections(d?.issue));
    if (!issue) throw new ControlPlaneError(`no such issue: ${key}`);
    return issue;
  }

  async function statesFor(teamKey, ticket = null) {
    const d = await call(
      `query($t:String!){ teams(filter:{key:{eq:$t}}, first:1){ nodes{ id states(first:50){ nodes{ id name } pageInfo{ hasNextPage endCursor } } } } }`,
      { t: teamKey },
      ticket,
    );
    const team = d?.teams?.nodes?.[0];
    if (!team) throw new ControlPlaneError(`no such team: ${teamKey}`);
    return {
      teamId: team.id,
      states: await collectPages(
        `query TeamStatesPage($id:String!,$after:String){ team(id:$id){ states(first:50,after:$after){ nodes{ id name } pageInfo{ hasNextPage endCursor } } } }`,
        { id: team.id },
        (d) => d?.team?.states,
        "states",
        team.states,
        ticket,
      ),
    };
  }

  async function allLabels(ticket = null) {
    return collectPages(
      `query($after:String){ issueLabels(first:250,after:$after){ nodes{ id name } pageInfo{ hasNextPage endCursor } } }`,
      {},
      (d) => d?.issueLabels,
      "labels",
      null,
      ticket,
    );
  }

  async function labelIdsFor(issue, add, remove, ticket = null) {
    const bad = validateLabels(add);
    if (bad.length)
      throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
    const all = await allLabels(ticket ?? issue.identifier ?? null);
    const missing = add.filter((n) => !all.some((l) => l.name === n));
    if (missing.length)
      throw new ControlPlaneError(
        `label(s) do not exist in this workspace: ${missing.join(", ")}`,
      );
    const current = (issue.labels ?? []).map((l) => l.name);
    return resolveLabelIds(current, { add, remove }, all);
  }

  async function resolveProjectId(name) {
    const trimmed = String(name).trim();
    if (!trimmed) return undefined;
    if (LINEAR_UUID.test(trimmed)) return trimmed;
    const d = await call(
      `query($name:String!){ projects(filter:{ name:{ eqIgnoreCase:$name } }, first:10){ nodes{ id name } } }`,
      { name: trimmed },
    );
    const nodes = d?.projects?.nodes ?? [];
    const match =
      nodes.find((p) => p.name === trimmed) ??
      nodes.find((p) => p.name?.toLowerCase() === trimmed.toLowerCase());
    if (!match?.id) throw new ControlPlaneError(`no such project: ${trimmed}`);
    return match.id;
  }

  async function resolveParentId(identifier) {
    const trimmed = String(identifier).trim();
    if (!trimmed) return undefined;
    const d = await call(
      `query($k:String!){ issue(id:$k){ id identifier } }`,
      { k: trimmed },
      trimmed,
    );
    const id = d?.issue?.id;
    if (!id) throw new ControlPlaneError(`no such parent issue: ${trimmed}`);
    return id;
  }

  async function viewer(ticket = null) {
    const me = (await call(`query{ viewer{ id name } }`, {}, ticket))?.viewer;
    if (!me?.id) throw new ControlPlaneError("linear viewer is not available");
    return me;
  }

  async function resolveAssigneeId(assignee, ticket = null) {
    const trimmed = String(assignee).trim();
    if (!trimmed) return undefined;
    if (LINEAR_UUID.test(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (lower === "self" || lower === "@me") {
      return (await viewer(ticket)).id;
    }
    const users = await collectPages(
      `query($after:String){ users(first:250,after:$after){ nodes{ id name displayName email } pageInfo{ hasNextPage endCursor } } }`,
      {},
      (d) => d?.users,
      "users",
      null,
      ticket,
    );
    const match =
      users.find(
        (u) =>
          u.email === trimmed ||
          u.name === trimmed ||
          u.displayName === trimmed,
      ) ??
      users.find(
        (u) =>
          u.email?.toLowerCase() === lower ||
          u.name?.toLowerCase() === lower ||
          u.displayName?.toLowerCase() === lower,
      );
    if (!match?.id) throw new ControlPlaneError(`no such user: ${trimmed}`);
    return match.id;
  }

  async function issueUpdate(id, input, ticket = null) {
    const updated = await call(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id, in: input },
      ticket,
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
        null,
        identifier,
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
      const vars = {
        t: team,
        // Linear removed IssueOrderByInput. Its live schema now exposes a
        // list of IssueSortInput values through `sort`; retain ascending
        // creation order so cursor pagination remains deterministic.
        sort: [{ createdAt: { order: "Ascending" } }],
        ...(project ? { p: project } : {}),
      };
      if (states?.length) vars.s = states;
      const query = project
        ? `query($t:String!,$p:String!${decl},$after:String,$sort:[IssueSortInput!]){ issues(first:250,after:$after,sort:$sort, filter:{ team:{key:{eq:$t}}, project:{name:{eq:$p}}, ${stateClause} }){ nodes{ ${ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`
        : `query($t:String!${decl},$after:String,$sort:[IssueSortInput!]){ issues(first:250,after:$after,sort:$sort, filter:{ team:{key:{eq:$t}}, ${stateClause} }){ nodes{ ${ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`;
      return (
        await Promise.all(
          (await collectPages(query, vars, (d) => d?.issues, "issues")).map(
            paginateIssueConnections,
          ),
        )
      )
        .map(normalizeTicket)
        .sort(byQueueOrder);
    },

    async list({
      team,
      project,
      parent,
      state,
      open,
      allStates = false,
      labels = [],
      assignee,
      query,
      limit = LIST_DEFAULT_LIMIT,
    } = {}) {
      const cap = Math.min(
        Math.max(1, Number.isInteger(limit) ? limit : LIST_DEFAULT_LIMIT),
        LIST_MAX_LIMIT,
      );
      const filter = {};
      if (team) filter.team = { key: { eq: team } };
      if (project) filter.project = { name: { eqIgnoreCase: project } };
      if (parent) {
        const parentId = await resolveParentId(parent);
        filter.parent = { id: { eq: parentId } };
      }
      if (state) {
        const lower = String(state).trim().toLowerCase();
        if (lower === "open") {
          filter.state = { type: { nin: ["completed", "canceled"] } };
        } else if (lower === "closed") {
          filter.state = { type: { in: ["completed", "canceled"] } };
        } else {
          filter.state = { name: { eqIgnoreCase: String(state).trim() } };
        }
      } else if (!allStates && open !== false) {
        filter.state = { type: { nin: ["completed", "canceled"] } };
      }
      if (assignee) {
        const assigneeId = await resolveAssigneeId(assignee);
        filter.assignee = { id: { eq: assigneeId } };
      }
      const andClauses = [];
      for (const name of labels) {
        const trimmed = String(name ?? "").trim();
        if (trimmed) {
          andClauses.push({
            labels: { some: { name: { eqIgnoreCase: trimmed } } },
          });
        }
      }
      const trimmedQuery = typeof query === "string" ? query.trim() : "";
      if (trimmedQuery) {
        andClauses.push({
          or: [
            { title: { containsIgnoreCase: trimmedQuery } },
            { description: { containsIgnoreCase: trimmedQuery } },
          ],
        });
      }
      if (andClauses.length) filter.and = andClauses;

      const gqlQuery = `query($first:Int!,$after:String,$sort:[IssueSortInput!],$filter:IssueFilter){ issues(first:$first,after:$after,sort:$sort,filter:$filter){ nodes{ ${LIST_ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`;
      const nodes = [];
      let after = null;
      let hasNextPage = true;
      while (hasNextPage && nodes.length < cap) {
        const pageSize = Math.min(cap - nodes.length, LIST_MAX_LIMIT);
        const d = await call(gqlQuery, {
          first: pageSize,
          after,
          sort: [{ createdAt: { order: "Ascending" } }],
          filter,
        });
        const connection = d?.issues;
        const page = connection?.nodes ?? [];
        nodes.push(...page);
        hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
        if (!hasNextPage || nodes.length >= cap) break;
        after = connection?.pageInfo?.endCursor;
        if (!after) break;
      }
      return (
        await Promise.all(nodes.slice(0, cap).map(paginateIssueConnections))
      )
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
      const { states } = await statesFor(teamKey, identifier);
      const inProgress = states.find(
        (s) => s.name.toLowerCase() === "in progress",
      );
      if (!inProgress)
        throw new ControlPlaneError(
          `team ${teamKey} has no "In Progress" state`,
        );

      const me = await viewer(identifier);
      const { add, remove } = claimLabels(
        (issue.labels ?? []).map((l) => l.name),
        harness,
      );
      const labelIds = await labelIdsFor(issue, add, remove, identifier);

      await issueUpdate(
        issue.id,
        {
          stateId: inProgress.id,
          assigneeId: me.id,
          labelIds,
        },
        identifier,
      );

      // Linear has no compare-and-swap; this read-back IS the concurrency control.
      const back = (
        await call(
          `query($id:String!){ issue(id:$id){ assignee{ id name } } }`,
          { id: issue.id },
          identifier,
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
        identifier,
        { retry: false },
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
      const readyRemoval = classifyAgentReadyRemoval(
        (issue.labels ?? []).map((label) => label.name),
        { add, remove, state },
      );
      if (readyRemoval === "unsafe")
        throw new ControlPlaneError(
          `refusing to remove ${AGENT_READY_LABEL} from a Todo ticket without claim labels or a move to another state`,
        );
      const input = {};
      if (state) {
        const teamKey = issue.team?.key ?? teamOf(identifier);
        const { states } = await statesFor(teamKey, identifier);
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
        input.labelIds = await labelIdsFor(issue, add, remove, identifier);
      if (unassign) input.assigneeId = null;
      await issueUpdate(issue.id, input, identifier);
    },

    async setLabels(identifier, { add = [], remove = [] } = {}) {
      const issue = await issueByKey(identifier);
      if (!add.length && !remove.length) return;
      if (
        classifyAgentReadyRemoval(
          (issue.labels ?? []).map((label) => label.name),
          { add, remove },
        ) === "unsafe"
      )
        throw new ControlPlaneError(
          `refusing to remove ${AGENT_READY_LABEL} without claim labels or a state transition`,
        );
      await issueUpdate(
        issue.id,
        { labelIds: await labelIdsFor(issue, add, remove, identifier) },
        identifier,
      );
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
      project,
      parent,
      parentId,
      priority,
      assignee,
      assigneeId,
    } = {}) {
      if (!team || !title)
        throw new ControlPlaneError("file requires team and title");
      if (priority !== undefined && priority !== null) {
        if (
          typeof priority !== "number" ||
          !Number.isInteger(priority) ||
          priority < 0 ||
          priority > 4
        ) {
          throw new ControlPlaneError(
            `invalid priority ${JSON.stringify(priority)}: expected an integer 0-4`,
          );
        }
      }
      const bad = validateLabels(labels);
      if (bad.length)
        throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
      const { teamId, states } = await statesFor(team);
      const target = states.find(
        (s) => s.name.toLowerCase() === state.toLowerCase(),
      );
      if (!target)
        throw new ControlPlaneError(`team ${team} has no "${state}" state`);
      const resolvedProjectId =
        projectId || (project ? await resolveProjectId(project) : undefined);
      const resolvedParentId =
        parentId || (parent ? await resolveParentId(parent) : undefined);
      const resolvedAssigneeId =
        assigneeId ||
        (assignee ? await resolveAssigneeId(assignee) : undefined);
      const d = await call(
        `mutation($in:IssueCreateInput!){ issueCreate(input:$in){ success issue{ identifier url } } }`,
        {
          in: {
            teamId,
            title,
            description: stampRun(body),
            stateId: target.id,
            labelIds: await labelIdsFor({ labels: [] }, labels, [], null),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            ...(resolvedParentId ? { parentId: resolvedParentId } : {}),
            ...(resolvedAssigneeId ? { assigneeId: resolvedAssigneeId } : {}),
            ...(priority !== undefined && priority !== null
              ? { priority }
              : {}),
          },
        },
        null,
        { retry: false },
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
      await issueUpdate(issue.id, { description }, identifier);
      return { appended: true };
    },

    async replaceDetail(identifier, body) {
      const issue = await issueByKey(identifier);
      if (typeof body !== "string" || body.length === 0)
        throw new ControlPlaneError(
          "replacement body must be a non-empty string",
        );
      await issueUpdate(issue.id, { description: body }, identifier);
    },

    async raw(query, variables = {}) {
      return call(query, variables);
    },
  };
}

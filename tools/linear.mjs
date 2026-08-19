#!/usr/bin/env bun
/**
 * The factory's Linear surface, as a shell command.
 *
 *   bun tools/linear.mjs get CLNT-616
 *   bun tools/linear.mjs comments CLNT-616
 *   bun tools/linear.mjs claim CLNT-616 --agent claude
 *   bun tools/linear.mjs comment CLNT-616 "verified: 42 tests pass"
 *   bun tools/linear.mjs triage CLNT-616 --comment "Owned Paths need revision"
 *   bun tools/linear.mjs answer CLNT-616 "Use the existing token cache"
 *   bun tools/linear.mjs detail CLNT-616 "## Acceptance criteria\n- [ ] ..."
 *   bun tools/linear.mjs labels CLNT-616 --add ai:needs-review --remove ai:in-progress
 *   bun tools/linear.mjs state CLNT-616 "In Review" --add ai:needs-review
 *   bun tools/linear.mjs file --team CLNT --title "..." --body "..." --type bug
 *   bun tools/linear.mjs queue --repo bj29
 *   bun tools/linear.mjs budget
 *   bun tools/linear.mjs raw '<graphql>' --var key=value
 *
 * WHY THIS EXISTS, given a perfectly good Linear MCP.
 *
 * Three reasons, in ascending order of importance.
 *
 *  1. The MCP is flaky in practice. Across 485 measured runs `list_issues`
 *     failed input validation 18 times in 12 runs and `save_issue` 10 times,
 *     and 96 runs fell through to a hand-rolled GraphQL fallback. Agents were
 *     already routing around it; this makes the route the road.
 *
 *  2. It is not declared anywhere. The MCP arrives as a claude.ai connector
 *     configured in a UI, so what the factory can reach changes when someone
 *     toggles a checkbox. Everything else the factory depends on is in git and
 *     moves by PR.
 *
 *  3. Connectors come as a bundle, and the bundle is the problem. An unattended
 *     factory session was loading 174 MCP tools: Linear (52), but also a client
 *     law firm's connector (51), Gmail (16), Drive, Calendar. Every ticket
 *     agent running unattended under bypassPermissions had personal mail and
 *     client data one tool call away, for no reason. Replacing the one
 *     connector the factory actually needs is what makes it possible to turn
 *     the rest off (--strict-mcp-config in config/mcp/claude.json).
 *
 * NOT A GENERAL LINEAR CLIENT. It covers the verbs the floor's protocol
 * actually names; anything rarer goes through `raw` with explicit GraphQL
 * rather than growing an API surface nobody maintains. It reuses gql() from
 * orchestrator/reaper.mjs — retries, backoff and key loading are solved there,
 * and a second client would be a second set of bugs.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadRepos } from "../event-runtime/lib/repos.mjs";
import { gql as gqlRaw } from "../orchestrator/reaper.mjs";
import {
  parseOwnedPaths,
  ownedPathsClosureGaps,
  readPinManifestRequirements,
  formatOwnedPathClosureGaps,
} from "../orchestrator/owned-paths.mjs";

// Every verb here is a fresh `bun` process, so nothing in module scope survives
// between calls — and the protocol calls this constantly (claim, heartbeat
// comments, state transitions, on up to 3 concurrent tickets per repo). `claim`
// alone costs 5 API calls, two of which (team states, workspace labels) are
// reference data that almost never changes. Caching them to disk with a short
// TTL is what actually cuts call volume; a same-process memo (allLabelsCache
// below) does nothing here since no verb calls allLabels() twice in one run.
const CACHE_DIR = path.join(homedir(), ".factory/cache/linear");
const CACHE_TTL_MS = 15 * 60 * 1000;
const BUDGET_FILE = "budget.json";
const LINEAR_API_HOST = "api.linear.app";

/** Distinct from generic CLI failure (exit 1) so planners can retry-later. */
export const LINEAR_RATE_LIMIT_EXIT = 3;
export const LINEAR_REQUESTS_LIMIT = 2500;
export const LINEAR_BUDGET_WARN_REMAINING = 300;

export class LinearRateLimitError extends Error {
  constructor(resetAt, cause) {
    super(`linear_rate_limited: resetAt=${resetAt ?? "unknown"}`);
    this.name = "LinearRateLimitError";
    this.rateLimited = true;
    this.resetAt = resetAt ?? null;
    if (cause) this.cause = cause;
  }
}

export function isLinearRateLimitMessage(text) {
  const s = String(text ?? "");
  return (
    /rate limit exceeded/i.test(s) ||
    /RATELIMITED/i.test(s) ||
    /HTTP 429\b/.test(s) ||
    /"rateLimited"\s*:\s*true/.test(s)
  );
}

export function isLinearRateLimited(err) {
  if (!err) return false;
  if (err instanceof LinearRateLimitError || err.rateLimited === true)
    return true;
  return String(err.message ?? "").startsWith("linear_rate_limited:");
}

function parseHeaderNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Linear's reset header is a unix timestamp; Retry-After is a small delta.
 * ISO-8601 strings pass through Date.parse.
 */
export function parseRateLimitReset(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n < 1e9) return new Date(now + n * 1000).toISOString();
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseRateLimitHeaders(headers, now = Date.now()) {
  if (!headers || typeof headers.get !== "function") return null;
  const remaining = parseHeaderNumber(
    headers.get("x-ratelimit-requests-remaining"),
  );
  const limit = parseHeaderNumber(headers.get("x-ratelimit-requests-limit"));
  const resetAt = parseRateLimitReset(
    headers.get("x-ratelimit-requests-reset") ?? headers.get("retry-after"),
    now,
  );
  const complexityRemaining = parseHeaderNumber(
    headers.get("x-ratelimit-complexity-remaining"),
  );
  const complexityLimit = parseHeaderNumber(
    headers.get("x-ratelimit-complexity-limit"),
  );
  const complexityResetAt = parseRateLimitReset(
    headers.get("x-ratelimit-complexity-reset"),
    now,
  );
  if (
    remaining == null &&
    limit == null &&
    resetAt == null &&
    complexityRemaining == null &&
    complexityLimit == null &&
    complexityResetAt == null
  ) {
    return null;
  }
  return {
    remaining: remaining ?? complexityRemaining,
    limit: limit ?? complexityLimit ?? LINEAR_REQUESTS_LIMIT,
    resetAt: resetAt ?? complexityResetAt,
  };
}

export function linearCacheDir() {
  return process.env.LINEAR_CACHE_DIR || CACHE_DIR;
}

export function loadLinearBudget() {
  try {
    return JSON.parse(
      readFileSync(path.join(linearCacheDir(), BUDGET_FILE), "utf8"),
    );
  } catch {
    return null;
  }
}

export function saveLinearBudget(budget) {
  try {
    mkdirSync(linearCacheDir(), { recursive: true });
    writeFileSync(
      path.join(linearCacheDir(), BUDGET_FILE),
      JSON.stringify({ ...budget, capturedAt: new Date().toISOString() }),
    );
  } catch {
    // Budget is an optimization / doctor line, never a dependency.
  }
}

function formatResetClock(resetAt) {
  if (!resetAt) return "unknown";
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function formatLinearBudgetLine(budget) {
  if (!budget || budget.remaining == null) {
    return "Linear budget: unknown (no recent API call)";
  }
  const limit = budget.limit ?? LINEAR_REQUESTS_LIMIT;
  return `Linear budget: ${budget.remaining}/${limit} remaining, resets ${formatResetClock(budget.resetAt)}`;
}

export function linearBudgetStatus(budget) {
  if (!budget || budget.remaining == null) return "unknown";
  if (budget.remaining < LINEAR_BUDGET_WARN_REMAINING) return "warn";
  return "pass";
}

function recordLinearBudgetFromResponse(res) {
  const parsed = parseRateLimitHeaders(res.headers);
  if (!parsed && res.status !== 400 && res.status !== 429) return;
  const prior = loadLinearBudget() ?? {};
  const rateLimited =
    res.status === 429 ||
    (res.status === 400 && parsed?.remaining === 0) ||
    parsed?.remaining === 0;
  saveLinearBudget({
    remaining:
      parsed?.remaining ?? (rateLimited ? 0 : (prior.remaining ?? null)),
    limit: parsed?.limit ?? prior.limit ?? LINEAR_REQUESTS_LIMIT,
    resetAt: parsed?.resetAt ?? prior.resetAt ?? null,
    rateLimited: Boolean(rateLimited || prior.rateLimited),
    status: res.status,
  });
}

let fetchHookInstalled = false;

export function installLinearBudgetCapture() {
  if (fetchHookInstalled) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  fetchHookInstalled = true;
  globalThis.fetch = async function linearBudgetFetch(input, init) {
    const url = String(input?.url ?? input);
    const res = await originalFetch(input, init);
    if (url.includes(LINEAR_API_HOST)) recordLinearBudgetFromResponse(res);
    return res;
  };
}

async function gql(query, variables = {}, retries) {
  try {
    return await gqlRaw(query, variables, retries);
  } catch (err) {
    if (isLinearRateLimitMessage(err?.message)) {
      const budget = loadLinearBudget() ?? {};
      const resetAt =
        budget.resetAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
      saveLinearBudget({
        remaining: 0,
        limit: budget.limit ?? LINEAR_REQUESTS_LIMIT,
        resetAt,
        rateLimited: true,
      });
      throw new LinearRateLimitError(resetAt, err);
    }
    throw err;
  }
}

function cacheGet(key) {
  if (process.env.LINEAR_NO_CACHE) return null;
  try {
    const { at, value } = JSON.parse(
      readFileSync(path.join(CACHE_DIR, `${key}.json`), "utf8"),
    );
    return Date.now() - at < CACHE_TTL_MS ? value : null;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      path.join(CACHE_DIR, `${key}.json`),
      JSON.stringify({ at: Date.now(), value }),
    );
  } catch {
    // Cache is an optimization, never a dependency — a write failure must not fail the verb.
  }
}

// The eight values that resolve; `type:chore` fails the mutation. Kept here as
// well as in the floor because a typo should fail locally with a list of the
// valid options, not as an opaque API error three seconds later.
export const TYPE_LABELS = [
  "bug",
  "feature",
  "ui-ux",
  "security",
  "performance",
  "maintenance",
  "docs",
  "a11y",
];
export const SOURCE_LABELS = ["agent", "human", "sentry", "client-support"];

/** Reject label typos before the API does, with a useful message. */
export function validateLabels(names) {
  const bad = [];
  for (const n of names) {
    if (n.startsWith("type:") && !TYPE_LABELS.includes(n.slice(5))) {
      bad.push(`${n} — type:* must be one of ${TYPE_LABELS.join(" ")}`);
    }
    if (n.startsWith("source:") && !SOURCE_LABELS.includes(n.slice(7))) {
      bad.push(`${n} — source:* must be one of ${SOURCE_LABELS.join(" ")}`);
    }
  }
  return bad;
}

/**
 * The label set after an add/remove, as ids.
 *
 * Linear's issueUpdate takes the COMPLETE label set, not a delta — passing only
 * the labels you want added silently removes every other label on the ticket.
 * That is the sharp edge this function exists to blunt.
 */
export function resolveLabelIds(
  currentNames,
  { add = [], remove = [] },
  allLabels,
) {
  const idOf = (n) => allLabels.find((l) => l.name === n)?.id;
  const dropped = new Set(remove);
  const kept = currentNames.filter((n) => !dropped.has(n));
  return [...new Set([...kept, ...add].map(idOf).filter(Boolean))];
}

/**
 * Harness name -> the `agent:*` label that exists in the workspace.
 *
 * The Claude harness is `claude` on the command line but `agent:claude-code` in
 * Linear, and nothing enforces that they agree. tick.mjs imports this rather
 * than carrying its own copy: two spellings of the same mapping is precisely
 * the drift this repo exists to prevent, and the failure is silent — tick.mjs
 * filters unresolved label ids out, so a wrong name just means the ticket never
 * says which harness holds it.
 */
export const agentLabel = (harness) =>
  `agent:${harness === "claude" ? "claude-code" : harness}`;

/**
 * Claiming drops `ai:agent-ready` and adds `ai:in-progress` + the agent label.
 * agent-ready means "waiting to be picked up" — keeping it alongside
 * ai:in-progress leaves the ticket asserting two lifecycle states at once, and
 * it then survives all the way to Done. One flag, one value.
 */
export function claimLabels(currentNames, harness) {
  const mine = agentLabel(harness);
  return {
    add: ["ai:in-progress", mine],
    remove: [
      "ai:agent-ready",
      ...currentNames.filter((n) => n.startsWith("agent:") && n !== mine),
    ],
  };
}

/** Compact ticket rendering — the fields the protocol actually acts on. */
export function formatTicket(i) {
  const labels = (i.labels?.nodes ?? []).map((l) => l.name);
  const lines = [
    `${i.identifier}  ${i.title}`,
    `  state     ${i.state?.name ?? "?"}`,
    `  assignee  ${i.assignee?.name ?? "(unassigned)"}`,
    `  labels    ${labels.join(" ") || "(none)"}`,
    `  url       ${i.url ?? ""}`,
  ];
  if (i.description) lines.push("", i.description);
  return lines.join("\n");
}

/** Compact comment rendering — author, timestamp, and body. */
export function formatComment(c) {
  const author = c.user?.name ?? "(unknown)";
  const when = c.createdAt ?? "";
  const header = when ? `${author}  ${when}` : author;
  return `${header}\n${c.body ?? ""}`;
}

export function formatComments(nodesOrIssue) {
  const nodes = Array.isArray(nodesOrIssue)
    ? nodesOrIssue
    : (nodesOrIssue?.comments?.nodes ?? []);
  if (!nodes.length) return "(no comments)";
  return nodes.map(formatComment).join("\n\n---\n\n");
}

let REPOS;
const PATH_REQUIREMENTS_CACHE = new Map();

function getRepos() {
  if (!REPOS) REPOS = loadRepos();
  return REPOS;
}

export function __resetLinearReposCache() {
  REPOS = undefined;
  PATH_REQUIREMENTS_CACHE.clear();
}

function repoForIssue(issue) {
  const repoTeam = issue?.team?.key;
  const repoProject = issue?.project?.name;
  if (!repoTeam || !repoProject) return null;
  for (const repo of getRepos().values()) {
    if (repo.team === repoTeam && repo.project === repoProject) return repo;
  }
  return null;
}

export function closureCheckMessages(issue) {
  const repo = repoForIssue(issue);
  if (!repo?.ownedPathsPolicy) return [];
  const key = `${repo.name}::${repo.ownedPathsPolicy.pinManifests?.join(",") || ""}`;
  if (!PATH_REQUIREMENTS_CACHE.has(key)) {
    const requirements = repo.ownedPathsPolicy.pinManifests?.length
      ? readPinManifestRequirements(
          repo.path,
          repo.ownedPathsPolicy.pinManifests,
        )
      : [];
    PATH_REQUIREMENTS_CACHE.set(key, requirements);
  }
  const requirements = PATH_REQUIREMENTS_CACHE.get(key);
  const gaps = ownedPathsClosureGaps({
    ownedPaths: parseOwnedPaths(issue.description ?? ""),
    ownedPathsPolicy: repo.ownedPathsPolicy,
    pinManifestRequirements: requirements,
  });
  return formatOwnedPathClosureGaps(gaps);
}

/** Build an idempotent description update for the `detail` verb. */
export function appendIssueDetail(currentDescription, rawDetail) {
  const detail = String(rawDetail ?? "").trim();
  if (!detail) throw new Error("detail must not be empty");

  const current = currentDescription ?? "";
  if (current.includes(detail))
    return { description: current, appended: false };

  const separator =
    current.length === 0 || current.endsWith("\n\n")
      ? ""
      : current.endsWith("\n")
        ? "\n"
        : "\n\n";
  return { description: `${current}${separator}${detail}\n`, appended: true };
}

// --------------------------------------------------------------- helpers ---
const ISSUE_FIELDS = `id identifier title url description
  state{ id name type } assignee{ id name }
  team{ key } project{ name }
  labels(first:30){ nodes{ id name } }`;

const COMMENTS_FIELDS = `id identifier title
  comments(first:50){ nodes{ id body createdAt user{ id name } } }`;

async function issueByKey(key) {
  const d = await gql(`query($k:String!){ issue(id:$k){ ${ISSUE_FIELDS} } }`, {
    k: key,
  });
  if (!d?.issue) throw new Error(`no such issue: ${key}`);
  return d.issue;
}

async function issueCommentsByKey(key) {
  const d = await gql(
    `query($k:String!){ issue(id:$k){ ${COMMENTS_FIELDS} } }`,
    { k: key },
  );
  if (!d?.issue) throw new Error(`no such issue: ${key}`);
  return d.issue;
}

const teamOf = (key) => key.split("-")[0];

async function statesFor(teamKey, force = false) {
  if (!force) {
    const cached = cacheGet(`states-${teamKey}`);
    if (cached) return cached;
  }
  const d = await gql(
    `query($t:String!){ teams(filter:{key:{eq:$t}}, first:1){ nodes{ id states(first:50){ nodes{ id name } } } } }`,
    { t: teamKey },
  );
  const team = d?.teams?.nodes?.[0];
  if (!team) throw new Error(`no such team: ${teamKey}`);
  const result = { teamId: team.id, states: team.states?.nodes ?? [] };
  cacheSet(`states-${teamKey}`, result);
  return result;
}

const allLabelsCache = { v: null };
async function allLabels(force = false) {
  if (!force) {
    if (allLabelsCache.v) return allLabelsCache.v;
    const cached = cacheGet("labels");
    if (cached) {
      allLabelsCache.v = cached;
      return cached;
    }
  }
  const v =
    (await gql(`query{ issueLabels(first:250){ nodes{ id name } } }`))
      ?.issueLabels?.nodes ?? [];
  allLabelsCache.v = v;
  cacheSet("labels", v);
  return v;
}

async function applyLabels(issue, add, remove) {
  const bad = validateLabels(add);
  if (bad.length) throw new Error("invalid label(s):\n  " + bad.join("\n  "));
  let all = await allLabels();
  let missing = add.filter((n) => !all.some((l) => l.name === n));
  if (missing.length) all = await allLabels(true); // stale cache? refetch once before failing
  missing = add.filter((n) => !all.some((l) => l.name === n));
  if (missing.length)
    throw new Error(
      `label(s) do not exist in this workspace: ${missing.join(", ")}`,
    );
  const current = (issue.labels?.nodes ?? []).map((l) => l.name);
  return resolveLabelIds(current, { add, remove }, all);
}

// ------------------------------------------------------------------ verbs ---
const VALUE_FLAGS = new Set([
  "add",
  "agent",
  "area",
  "body",
  "comment",
  "label",
  "project",
  "remove",
  "source",
  "team",
  "title",
  "type",
  "var",
]);

/** Return command arguments that are not flags or values consumed by flags. */
export function parsePositionalArgs(argv) {
  const positional = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg.slice(2))) i += 1;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

const argv = process.argv.slice(2);
const verb = argv[0];
const positional = parsePositionalArgs(argv);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flagAll = (name) =>
  argv
    .flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []))
    .filter(Boolean);
const has = (name) => argv.includes(`--${name}`);
const JSON_OUT = has("json");
const out = (obj, text) =>
  console.log(JSON_OUT ? JSON.stringify(obj, null, 2) : text);

// Attribution stamp (OPS-76). Factory spawns set FACTORY_RUN_ID to the
// transcript basename, and the rollup keys on the same string — so stamping it
// here makes every comment and filed issue joinable back to the exact run that
// wrote it, without trusting the agent to remember. Skipped when the id is
// already in the body (an agent that includes it deliberately shouldn't get it
// twice) and when unset (interactive human use stays clean).
const stampRun = (body) => {
  const id = process.env.FACTORY_RUN_ID;
  if (!id || !body || body.includes(`run:${id}`)) return body;
  return `${body}\n\nrun:${id}`;
};

const VERBS = {
  async get() {
    const issue = await issueByKey(positional[0]);
    out(issue, formatTicket(issue));
  },

  async comments() {
    const key = positional[0];
    if (!key) throw new Error(`usage: comments <ISSUE-ID>`);
    const issue = await issueCommentsByKey(key);
    const nodes = issue.comments?.nodes ?? [];
    out(nodes, formatComments(nodes));
  },

  async claim() {
    const key = positional[0];
    const harness = flag("agent", "claude");
    const issue = await issueByKey(key);
    const { states } = await statesFor(teamOf(key));
    const inProgress = states.find(
      (s) => s.name.toLowerCase() === "in progress",
    );
    if (!inProgress)
      throw new Error(`team ${teamOf(key)} has no "In Progress" state`);

    const me = (await gql(`query{ viewer{ id name } }`))?.viewer;
    const { add, remove } = claimLabels(
      (issue.labels?.nodes ?? []).map((l) => l.name),
      harness,
    );
    const labelIds = await applyLabels(issue, add, remove);

    await gql(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      {
        id: issue.id,
        in: { stateId: inProgress.id, assigneeId: me.id, labelIds },
      },
    );

    // Linear has no compare-and-swap, so this read-back IS the concurrency
    // control. Enforced here rather than asked of the agent in prose: a claim
    // that skips it is how two agents end up in one worktree.
    const back = (
      await gql(`query($id:String!){ issue(id:$id){ assignee{ id name } } }`, {
        id: issue.id,
      })
    )?.issue;
    const won = back?.assignee?.id === me.id;
    out(
      { ok: won, identifier: key, assignee: back?.assignee?.name ?? null },
      won
        ? `claimed ${key} as ${me.name}`
        : `LOST RACE on ${key} — now assigned to ${back?.assignee?.name ?? "someone else"}; take the next ticket`,
    );
    if (!won) process.exit(1);
  },

  async comment() {
    const key = positional[0];
    const body = positional[1];
    if (!body) throw new Error(`usage: comment <ISSUE-ID> "<text>"`);
    const issue = await issueByKey(key);
    await gql(
      `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
      { in: { issueId: issue.id, body: stampRun(body) } },
    );
    out({ ok: true, identifier: key }, `commented on ${key}`);
  },

  async triage() {
    const key = positional[0];
    const comment = flag("comment");
    if (!key || comment === null)
      throw new Error(`usage: triage <ISSUE-ID> --comment "<text>"`);
    const issue = await issueByKey(key);
    let { states } = await statesFor(teamOf(key));
    let target = states.find((s) => s.name.toLowerCase() === "triage");
    if (!target) ({ states } = await statesFor(teamOf(key), true));
    target = states.find((s) => s.name.toLowerCase() === "triage");
    if (!target) throw new Error(`team ${teamOf(key)} has no "Triage" state`);
    const labelIds = await applyLabels(issue, [], ["ai:agent-ready"]);
    const updated = await gql(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: { stateId: target.id, labelIds } },
    );
    if (!updated?.issueUpdate?.success)
      throw new Error(`failed to move ${key} to Triage`);
    if (comment.trim()) {
      const commented = await gql(
        `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
        { in: { issueId: issue.id, body: stampRun(comment) } },
      );
      if (!commented?.commentCreate?.success)
        throw new Error(`failed to comment on ${key}`);
    }
    out({ ok: true, identifier: key }, `${key} -> Triage`);
  },

  async answer() {
    const key = positional[0];
    const text = positional[1];
    if (!key || !text) throw new Error(`usage: answer <ISSUE-ID> "<text>"`);
    const issue = await issueByKey(key);
    if (issue.state?.name?.toLowerCase() === "blocked") {
      let { states } = await statesFor(teamOf(key));
      let target = states.find((s) => s.name.toLowerCase() === "todo");
      if (!target) ({ states } = await statesFor(teamOf(key), true));
      target = states.find((s) => s.name.toLowerCase() === "todo");
      if (!target) throw new Error(`team ${teamOf(key)} has no "Todo" state`);
      const updated = await gql(
        `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
        { id: issue.id, in: { stateId: target.id } },
      );
      if (!updated?.issueUpdate?.success)
        throw new Error(`failed to move ${key} to Todo`);
    }
    const commented = await gql(
      `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
      { in: { issueId: issue.id, body: stampRun(text) } },
    );
    if (!commented?.commentCreate?.success)
      throw new Error(`failed to comment on ${key}`);
    out({ ok: true, identifier: key }, `answered ${key}`);
  },

  async detail() {
    const key = positional[0];
    const rawDetail = positional[1];
    if (!key || !rawDetail)
      throw new Error(`usage: detail <ISSUE-ID> "<markdown>"`);
    const issue = await issueByKey(key);
    const { description, appended } = appendIssueDetail(
      issue.description,
      rawDetail,
    );
    if (!appended) {
      out(
        { ok: true, identifier: key, appended: false },
        `${key} detail already present`,
      );
      return;
    }
    const updated = await gql(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: { description } },
    );
    if (!updated?.issueUpdate?.success)
      throw new Error(`failed to append detail to ${key}`);
    out(
      { ok: true, identifier: key, appended: true },
      `${key} detail appended`,
    );
  },

  async labels() {
    const key = positional[0];
    if (!key)
      throw new Error(
        `usage: labels <ISSUE-ID> [--add <label>] [--remove <label>]`,
      );
    const issue = await issueByKey(key);
    const add = flagAll("add"),
      remove = flagAll("remove");
    if (!add.length && !remove.length) {
      const current = (issue.labels?.nodes ?? []).map((l) => l.name);
      out(current, current.join(" ") || "(none)");
      return;
    }
    const labelIds = await applyLabels(issue, add, remove);
    await gql(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: { labelIds } },
    );
    out(
      { ok: true, identifier: key, added: add, removed: remove },
      `${key} labels updated`,
    );
  },

  async label() {
    return VERBS.labels();
  },

  async state() {
    const key = positional[0];
    const wanted = positional[1];
    const add = flagAll("add"),
      remove = flagAll("remove");
    if (!key)
      throw new Error(
        `usage: state <ISSUE-ID> ["<State Name>"] [--add label] [--remove label]`,
      );
    if (!wanted && !add.length && !remove.length && !has("unassign")) {
      throw new Error(
        `usage: state <ISSUE-ID> "<State Name>" [--add label] [--remove label]`,
      );
    }
    const issue = await issueByKey(key);
    const input = {};
    let target = null;
    if (wanted) {
      let { states } = await statesFor(teamOf(key));
      target = states.find(
        (s) => s.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (!target) ({ states } = await statesFor(teamOf(key), true)); // stale cache? refetch once before failing
      target = states.find(
        (s) => s.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (!target)
        throw new Error(
          `no state "${wanted}" on team ${teamOf(key)} — have: ${states.map((s) => s.name).join(", ")}`,
        );
      input.stateId = target.id;
    }

    if (add.includes("ai:agent-ready")) {
      const gaps = closureCheckMessages(issue);
      if (gaps.length) {
        throw new Error(
          `Cannot add ai:agent-ready on ${key}: Owned Paths closure policy not satisfied:\n${gaps.map((g) => `- ${g}`).join("\n")}`,
        );
      }
    }

    if (add.length || remove.length)
      input.labelIds = await applyLabels(issue, add, remove);
    if (has("unassign")) input.assigneeId = null;

    await gql(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: input },
    );
    const msg = target ? `${key} -> ${target.name}` : `${key} labels updated`;
    out(
      { ok: true, identifier: key, ...(target ? { state: target.name } : {}) },
      msg,
    );
  },

  async file() {
    const team = flag("team");
    const title = flag("title");
    if (!team || !title)
      throw new Error(
        `usage: file --team CLNT --title "..." [--body "..."] [--type bug] [--area x] [--source agent] [--todo]`,
      );

    const { teamId, states } = await statesFor(team);
    // New findings land in Triage unless they already meet the agent-ready bar.
    const stateName = has("todo") ? "Todo" : "Triage";
    const target = states.find(
      (s) => s.name.toLowerCase() === stateName.toLowerCase(),
    );

    const wanted = [
      ...(flag("type") ? [`type:${flag("type")}`] : []),
      ...flagAll("area").map((a) => `area:${a}`),
      `source:${flag("source", "agent")}`,
      ...(has("todo") ? ["ai:agent-ready"] : []),
      ...flagAll("label"),
    ];
    const bad = validateLabels(wanted);
    if (bad.length) throw new Error("invalid label(s):\n  " + bad.join("\n  "));
    const all = await allLabels();
    const missing = wanted.filter((n) => !all.some((l) => l.name === n));
    if (missing.length)
      throw new Error(
        `label(s) do not exist in this workspace: ${missing.join(", ")}`,
      );

    const d = await gql(
      `mutation($in:IssueCreateInput!){ issueCreate(input:$in){ success issue{ identifier url } } }`,
      {
        in: {
          teamId,
          title,
          description: stampRun(flag("body", "")),
          stateId: target?.id,
          labelIds: resolveLabelIds([], { add: wanted }, all),
          ...(flag("project") ? { projectId: flag("project") } : {}),
        },
      },
    );
    const created = d?.issueCreate?.issue;
    if (!created) throw new Error("issueCreate returned no issue");
    out(
      { ok: true, ...created },
      `filed ${created.identifier} in ${stateName}  ${created.url}`,
    );
  },

  async queue() {
    const team = flag("team") ?? teamOf(positional[0] ?? "");
    if (!team) throw new Error(`usage: queue --team CLNT`);
    // Dispatchable == Todo + ai:agent-ready + unassigned. The same predicate
    // the dispatcher uses; agents must not invent their own.
    const d = await gql(
      `query($t:String!){ issues(first:100, filter:{ team:{key:{eq:$t}}, state:{name:{eq:"Todo"}}, assignee:{null:true} }){ nodes{ ${ISSUE_FIELDS} } } }`,
      { t: team },
    );
    const ready = (d?.issues?.nodes ?? []).filter((i) =>
      (i.labels?.nodes ?? []).some((l) => l.name === "ai:agent-ready"),
    );
    out(
      ready,
      ready.length
        ? ready.map((i) => `${i.identifier}  ${i.title}`).join("\n")
        : "no agent-ready tickets",
    );
  },

  async budget() {
    const budget = loadLinearBudget();
    out(
      budget ?? {
        remaining: null,
        limit: LINEAR_REQUESTS_LIMIT,
        resetAt: null,
      },
      formatLinearBudgetLine(budget),
    );
  },

  async raw() {
    const vars = Object.fromEntries(
      flagAll("var").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    console.log(JSON.stringify(await gql(positional[0], vars), null, 2));
  },
};

if (import.meta.main) {
  installLinearBudgetCapture();
  if (!verb || has("help") || !VERBS[verb]) {
    console.log(`verbs: ${Object.keys(VERBS).join(", ")}\n`);
    console.log(
      import.meta.file ? "see the header of tools/linear.mjs for usage" : "",
    );
    process.exit(verb && !VERBS[verb] ? 2 : 0);
  }
  try {
    await VERBS[verb]();
  } catch (e) {
    if (isLinearRateLimited(e) || isLinearRateLimitMessage(e.message)) {
      const budget = loadLinearBudget() ?? {};
      const resetAt = e.resetAt ?? budget.resetAt ?? null;
      const payload = { rateLimited: true, resetAt };
      console.error(JSON.stringify(payload));
      process.exit(LINEAR_RATE_LIMIT_EXIT);
    }
    console.error(`linear ${verb}: ${e.message}`);
    process.exit(1);
  }
}

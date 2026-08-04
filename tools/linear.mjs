#!/usr/bin/env bun
/**
 * The factory's Linear surface, as a shell command.
 *
 *   bun tools/linear.mjs get CLNT-616
 *   bun tools/linear.mjs claim CLNT-616 --agent claude
 *   bun tools/linear.mjs comment CLNT-616 "verified: 42 tests pass"
 *   bun tools/linear.mjs state CLNT-616 "In Review" --add ai:needs-review
 *   bun tools/linear.mjs file --team CLNT --title "..." --body "..." --type bug
 *   bun tools/linear.mjs queue --repo bj29
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
import { gql } from "../orchestrator/reaper.mjs";

// The eight values that resolve; `type:chore` fails the mutation. Kept here as
// well as in the floor because a typo should fail locally with a list of the
// valid options, not as an opaque API error three seconds later.
export const TYPE_LABELS = ["bug", "feature", "ui-ux", "security", "performance", "maintenance", "docs", "a11y"];
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
export function resolveLabelIds(currentNames, { add = [], remove = [] }, allLabels) {
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
export const agentLabel = (harness) => `agent:${harness === "claude" ? "claude-code" : harness}`;

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
    remove: ["ai:agent-ready", ...currentNames.filter((n) => n.startsWith("agent:") && n !== mine)],
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

// --------------------------------------------------------------- helpers ---
const ISSUE_FIELDS = `id identifier title url description
  state{ id name type } assignee{ id name }
  labels(first:30){ nodes{ id name } }`;

async function issueByKey(key) {
  const d = await gql(`query($k:String!){ issue(id:$k){ ${ISSUE_FIELDS} } }`, { k: key });
  if (!d?.issue) throw new Error(`no such issue: ${key}`);
  return d.issue;
}

const teamOf = (key) => key.split("-")[0];

async function statesFor(teamKey) {
  const d = await gql(`query($t:String!){ teams(filter:{key:{eq:$t}}, first:1){ nodes{ id states(first:50){ nodes{ id name } } } } }`, { t: teamKey });
  const team = d?.teams?.nodes?.[0];
  if (!team) throw new Error(`no such team: ${teamKey}`);
  return { teamId: team.id, states: team.states?.nodes ?? [] };
}

const allLabelsCache = { v: null };
async function allLabels() {
  if (!allLabelsCache.v) {
    allLabelsCache.v = (await gql(`query{ issueLabels(first:250){ nodes{ id name } } }`))?.issueLabels?.nodes ?? [];
  }
  return allLabelsCache.v;
}

async function applyLabels(issue, add, remove) {
  const bad = validateLabels(add);
  if (bad.length) throw new Error("invalid label(s):\n  " + bad.join("\n  "));
  const all = await allLabels();
  const missing = add.filter((n) => !all.some((l) => l.name === n));
  if (missing.length) throw new Error(`label(s) do not exist in this workspace: ${missing.join(", ")}`);
  const current = (issue.labels?.nodes ?? []).map((l) => l.name);
  return resolveLabelIds(current, { add, remove }, all);
}

// ------------------------------------------------------------------ verbs ---
const argv = process.argv.slice(2);
const verb = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flagAll = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : [])).filter(Boolean);
const has = (name) => argv.includes(`--${name}`);
const JSON_OUT = has("json");
const out = (obj, text) => console.log(JSON_OUT ? JSON.stringify(obj, null, 2) : text);

const VERBS = {
  async get() {
    const issue = await issueByKey(positional[0]);
    out(issue, formatTicket(issue));
  },

  async claim() {
    const key = positional[0];
    const harness = flag("agent", "claude");
    const issue = await issueByKey(key);
    const { states } = await statesFor(teamOf(key));
    const inProgress = states.find((s) => s.name.toLowerCase() === "in progress");
    if (!inProgress) throw new Error(`team ${teamOf(key)} has no "In Progress" state`);

    const me = (await gql(`query{ viewer{ id name } }`))?.viewer;
    const { add, remove } = claimLabels((issue.labels?.nodes ?? []).map((l) => l.name), harness);
    const labelIds = await applyLabels(issue, add, remove);

    await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: { stateId: inProgress.id, assigneeId: me.id, labelIds } });

    // Linear has no compare-and-swap, so this read-back IS the concurrency
    // control. Enforced here rather than asked of the agent in prose: a claim
    // that skips it is how two agents end up in one worktree.
    const back = (await gql(`query($id:String!){ issue(id:$id){ assignee{ id name } } }`, { id: issue.id }))?.issue;
    const won = back?.assignee?.id === me.id;
    out({ ok: won, identifier: key, assignee: back?.assignee?.name ?? null },
      won ? `claimed ${key} as ${me.name}` : `LOST RACE on ${key} — now assigned to ${back?.assignee?.name ?? "someone else"}; take the next ticket`);
    if (!won) process.exit(1);
  },

  async comment() {
    const key = positional[0];
    const body = positional[1];
    if (!body) throw new Error(`usage: comment <ISSUE-ID> "<text>"`);
    const issue = await issueByKey(key);
    await gql(`mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
      { in: { issueId: issue.id, body } });
    out({ ok: true, identifier: key }, `commented on ${key}`);
  },

  async state() {
    const key = positional[0];
    const wanted = positional[1];
    if (!wanted) throw new Error(`usage: state <ISSUE-ID> "<State Name>" [--add label] [--remove label]`);
    const issue = await issueByKey(key);
    const { states } = await statesFor(teamOf(key));
    const target = states.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
    if (!target) throw new Error(`no state "${wanted}" on team ${teamOf(key)} — have: ${states.map((s) => s.name).join(", ")}`);

    const add = flagAll("add"), remove = flagAll("remove");
    const input = { stateId: target.id };
    if (add.length || remove.length) input.labelIds = await applyLabels(issue, add, remove);
    if (has("unassign")) input.assigneeId = null;

    await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: input });
    out({ ok: true, identifier: key, state: target.name }, `${key} -> ${target.name}`);
  },

  async file() {
    const team = flag("team");
    const title = flag("title");
    if (!team || !title) throw new Error(`usage: file --team CLNT --title "..." [--body "..."] [--type bug] [--area x] [--source agent] [--todo]`);

    const { teamId, states } = await statesFor(team);
    // New findings land in Triage unless they already meet the agent-ready bar.
    const stateName = has("todo") ? "Todo" : "Triage";
    const target = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());

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
    if (missing.length) throw new Error(`label(s) do not exist in this workspace: ${missing.join(", ")}`);

    const d = await gql(
      `mutation($in:IssueCreateInput!){ issueCreate(input:$in){ success issue{ identifier url } } }`,
      { in: {
        teamId, title,
        description: flag("body", ""),
        stateId: target?.id,
        labelIds: resolveLabelIds([], { add: wanted }, all),
        ...(flag("project") ? { projectId: flag("project") } : {}),
      } });
    const created = d?.issueCreate?.issue;
    if (!created) throw new Error("issueCreate returned no issue");
    out({ ok: true, ...created }, `filed ${created.identifier} in ${stateName}  ${created.url}`);
  },

  async queue() {
    const team = flag("team") ?? teamOf(positional[0] ?? "");
    if (!team) throw new Error(`usage: queue --team CLNT`);
    // Dispatchable == Todo + ai:agent-ready + unassigned. The same predicate
    // the dispatcher uses; agents must not invent their own.
    const d = await gql(
      `query($t:String!){ issues(first:100, filter:{ team:{key:{eq:$t}}, state:{name:{eq:"Todo"}}, assignee:{null:true} }){ nodes{ ${ISSUE_FIELDS} } } }`,
      { t: team });
    const ready = (d?.issues?.nodes ?? []).filter((i) =>
      (i.labels?.nodes ?? []).some((l) => l.name === "ai:agent-ready"));
    out(ready, ready.length
      ? ready.map((i) => `${i.identifier}  ${i.title}`).join("\n")
      : "no agent-ready tickets");
  },

  async raw() {
    const vars = Object.fromEntries(flagAll("var").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
    console.log(JSON.stringify(await gql(positional[0], vars), null, 2));
  },
};

if (import.meta.main) {
  if (!verb || has("help") || !VERBS[verb]) {
    console.log(`verbs: ${Object.keys(VERBS).join(", ")}\n`);
    console.log(import.meta.file ? "see the header of tools/linear.mjs for usage" : "");
    process.exit(verb && !VERBS[verb] ? 2 : 0);
  }
  try {
    await VERBS[verb]();
  } catch (e) {
    console.error(`linear ${verb}: ${e.message}`);
    process.exit(1);
  }
}

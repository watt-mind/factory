/**
 * On-demand Linear ticket-supply snapshot for GET /tickets/supply (WM-824).
 *
 * Counts come from Linear GraphQL, not a background poll. A short in-memory
 * TTL plus in-flight coalescing keep concurrent tabs and rapid Refresh clicks
 * from turning into a request storm. `loadLinearBudget()` is the circuit
 * breaker: remaining 0 skips the network and lets the caller fall back to
 * scan artifacts.
 */
import { gql as defaultGql } from "../../orchestrator/reaper.mjs";
import {
  installLinearBudgetCapture,
  loadLinearBudget,
} from "../../tools/linear.mjs";

export const TICKET_SUPPLY_CACHE_TTL_MS = 45_000;
export const STALE_SCAN_MS = 60 * 60 * 1000;
export const AGENT_READY_LABEL = "ai:agent-ready";

const ISSUE_NODE = `state{ name } assignee{ id } labels{ nodes{ name } }`;
const TEAM_QUERY = `query($t:String!,$after:String){
  issues(first:100, after:$after, filter:{
    team:{ key:{ eq:$t } }
    state:{ type:{ nin:["completed","canceled"] } }
  }){
    pageInfo{ hasNextPage endCursor }
    nodes{ ${ISSUE_NODE} }
  }
}`;
const PROJECT_QUERY = `query($t:String!,$p:String!,$after:String){
  issues(first:100, after:$after, filter:{
    team:{ key:{ eq:$t } }
    project:{ name:{ eq:$p } }
    state:{ type:{ nin:["completed","canceled"] } }
  }){
    pageInfo{ hasNextPage endCursor }
    nodes{ ${ISSUE_NODE} }
  }
}`;

const MAX_PAGES = 8;

let cacheEntry = null;
let inFlight = null;
let injectedGql = null;
let injectedBudget = undefined;

/** Test seam: inject a GraphQL runner (no network). */
export function setLinearSupplyGql(gql) {
  injectedGql = gql ?? null;
}

/** Test seam: inject a budget snapshot. `undefined` restores disk/file. */
export function setLinearSupplyBudget(budget) {
  injectedBudget = budget;
}

export function clearLinearSupplyCache() {
  cacheEntry = null;
  inFlight = null;
}

export function emptyIssueCounts() {
  return { triage: 0, ready: 0, inFlight: 0, blocked: 0, inReview: 0 };
}

function labelNames(issue) {
  const labels = Array.isArray(issue?.labels)
    ? issue.labels
    : (issue?.labels?.nodes ?? []);
  return labels.map((label) => label?.name).filter(Boolean);
}

/**
 * Bucket an open Linear issue into the supply columns the hub shows.
 * Ready is the dispatch predicate: Todo + unassigned + `ai:agent-ready`.
 */
export function countOpenIssues(nodes) {
  const counts = emptyIssueCounts();
  for (const issue of Array.isArray(nodes) ? nodes : []) {
    const state = issue?.state?.name ?? "";
    const names = labelNames(issue);
    const assignee = issue?.assignee ?? null;
    if (state === "Triage") counts.triage += 1;
    else if (
      state === "Todo" &&
      !assignee &&
      names.includes(AGENT_READY_LABEL)
    ) {
      counts.ready += 1;
    } else if (state === "In Progress") counts.inFlight += 1;
    else if (state === "Blocked") counts.blocked += 1;
    else if (state === "In Review") counts.inReview += 1;
  }
  return counts;
}

function repoGroupKey(repo) {
  const team = typeof repo.team === "string" ? repo.team.trim() : "";
  if (!team) return null;
  const project =
    typeof repo.project === "string" && repo.project.trim()
      ? repo.project.trim()
      : "";
  return `${team}\t${project}`;
}

async function fetchOpenIssues(gql, { team, project }) {
  const nodes = [];
  let after = null;
  const query = project ? PROJECT_QUERY : TEAM_QUERY;
  for (let page = 0; page < MAX_PAGES; page++) {
    const variables = project
      ? { t: team, p: project, after }
      : { t: team, after };
    const data = await gql(query, variables);
    const conn = data?.issues ?? {};
    nodes.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor ?? null;
    if (!after) break;
  }
  return nodes;
}

function readBudget() {
  if (injectedBudget !== undefined) return injectedBudget;
  try {
    return loadLinearBudget();
  } catch {
    return null;
  }
}

function budgetPayload(budget) {
  if (!budget || typeof budget !== "object") return null;
  return {
    remaining: Number.isFinite(budget.remaining) ? budget.remaining : null,
    limit: Number.isFinite(budget.limit) ? budget.limit : null,
  };
}

async function fetchLinearSupply(repos, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const asOf = new Date(nowMs).toISOString();
  const budget = readBudget();
  if (budget?.remaining === 0) {
    return {
      ok: false,
      asOf: null,
      byRepo: {},
      budget: budgetPayload(budget),
      error: "linear_budget_exhausted",
    };
  }

  const gql = options.gql ?? injectedGql ?? defaultGql;
  if (!options.gql && !injectedGql) {
    try {
      installLinearBudgetCapture();
    } catch {
      // Capture is best-effort; a missing hook must not fail the snapshot.
    }
  }

  const configured = Array.isArray(repos)
    ? repos
    : [...(repos?.values?.() ?? [])];
  const groups = new Map();
  for (const repo of configured) {
    const key = repoGroupKey(repo);
    if (!key) continue;
    if (!groups.has(key)) {
      const [team, project] = key.split("\t");
      groups.set(key, { team, project: project || null, names: [] });
    }
    groups.get(key).names.push(repo.name);
  }

  const byRepo = {};
  try {
    for (const group of groups.values()) {
      const nodes = await fetchOpenIssues(gql, group);
      const counts = countOpenIssues(nodes);
      for (const name of group.names) byRepo[name] = { ...counts };
    }
    return {
      ok: true,
      asOf,
      byRepo,
      budget: budgetPayload(readBudget()),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      asOf: null,
      byRepo: {},
      budget: budgetPayload(readBudget()),
      error: err?.message ? String(err.message) : "linear_unavailable",
    };
  }
}

/**
 * Cached Linear snapshot. `refresh: true` bypasses TTL but still joins an
 * in-flight request so a double-click is one GraphQL round-trip.
 */
export async function loadLinearSupply(repos, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const refresh = options.refresh === true;
  if (
    !refresh &&
    cacheEntry &&
    nowMs - cacheEntry.at < TICKET_SUPPLY_CACHE_TTL_MS
  ) {
    return { ...cacheEntry.value, cached: true };
  }
  if (inFlight) return inFlight;
  const pending = fetchLinearSupply(repos, options).then((value) => {
    cacheEntry = { at: nowMs, value };
    return { ...value, cached: false };
  });
  inFlight = pending;
  try {
    return await pending;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
}

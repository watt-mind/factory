import { pad, withClient } from "./shared.mjs";
import { isDispatchClassAgent } from "../lib/proposal-subject.mjs";

/**
 * `--dispatch-only` includes only the explicit dispatch class: runs that hold
 * a ticket lease and worktree (including their tier continuation). A
 * dispatch-like name or output contract is not sufficient.
 */
/**
 * Hard limits for the cursor walk. The control API clamps a page to
 * RUN_LIST_MAX_LIMIT (200, `lib/api-runs.mjs`) and rejects anything larger,
 * so the CLI never asks for more; MAX_PAGES bounds a runaway walk (a server
 * that keeps handing out cursors) at 50 x 200 = 10,000 rows.
 */
export const RUN_LIST_PAGE_SIZE = 200;
export const RUN_LIST_MAX_PAGES = 50;

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return number;
}

export function parseRunsArgs(args) {
  const options = { excludeAgents: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (options.state !== undefined)
        throw new Error(`unexpected runs argument: ${arg}`);
      options.state = arg;
      continue;
    }
    if (arg === "--dispatch-only") {
      options.dispatchOnly = true;
      continue;
    }
    if (arg === "--count") {
      options.count = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--agent") options.agent = value;
    else if (arg === "--exclude-agent") options.excludeAgents.push(value);
    else if (arg === "--limit")
      options.limit = parsePositiveInteger(value, arg);
    else throw new Error(`unknown runs option: ${arg}`);
  }
  return options;
}

/**
 * Build the row predicate for `--dispatch-only` from the explicit
 * dispatch-class membership shared with metrics.
 */
export function dispatchOnlyPredicate(agents) {
  const refs = new Set();
  for (const def of agents ?? []) {
    if (!isDispatchClassAgent(def?.id)) continue;
    if (typeof def.ref === "string") refs.add(def.ref);
    if (typeof def.id === "string") refs.add(def.id);
  }
  return (row) => refs.has(row.agent) || isDispatchClassAgent(row.agent);
}

export async function runs(client, stateFilter, options = {}) {
  const state = stateFilter?.toUpperCase();
  const limit = options.limit ?? null;
  const pageSize = Math.min(limit ?? RUN_LIST_PAGE_SIZE, RUN_LIST_PAGE_SIZE);
  const query = {
    ...(state ? { state } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
  };
  const usesOptions = Boolean(
    options.agent ||
    options.limit ||
    options.count ||
    options.keep ||
    (options.excludeAgents?.length ?? 0) > 0,
  );
  const excluded = new Set(options.excludeAgents ?? []);
  const keep = (row) =>
    !excluded.has(row.agent) && (options.keep ? options.keep(row) : true);

  const filtered = [];
  const seenCursors = new Set();
  let before = null;
  let pages = 0;
  // True when the server still had rows we did not fetch (cap or --limit).
  let unfetched = false;
  while (true) {
    // Preserve the original string call for state-only programmatic callers.
    const request =
      before === null && !usesOptions && !options.agent && state
        ? state
        : { ...query, limit: pageSize, ...(before ? { before } : {}) };
    const page = await client.runs(request);
    pages += 1;
    filtered.push(...(page.runs ?? []).filter(keep));
    const hasNextPage = page.hasNextPage ?? Boolean(page.nextBefore);
    if (!hasNextPage) break;
    if (limit !== null && filtered.length >= limit) {
      unfetched = true;
      break;
    }
    if (pages >= RUN_LIST_MAX_PAGES) {
      console.error(
        `... stopped after ${pages} pages (${RUN_LIST_MAX_PAGES} page cap); pass --limit or a narrower filter`,
      );
      unfetched = true;
      break;
    }
    if (typeof page.nextBefore !== "string" || page.nextBefore === "") {
      throw new Error(
        "runs response has another page but no nextBefore cursor",
      );
    }
    if (seenCursors.has(page.nextBefore)) {
      console.error(
        `... stopped: runs cursor ${page.nextBefore} repeated (server paging loop)`,
      );
      unfetched = true;
      break;
    }
    seenCursors.add(page.nextBefore);
    before = page.nextBefore;
  }

  const visible = limit !== null ? filtered.slice(0, limit) : filtered;
  const truncated = filtered.length - visible.length;
  if (options.count) {
    console.log(visible.length);
    return;
  }
  if (visible.length === 0) {
    console.log(state ? `no runs with state ${state}` : "no runs");
    return;
  }
  console.log(
    `${pad("RUN ID", 42)}${pad("STATE", 12)}${pad("AGENT", 26)}${pad("ADAPTER", 12)}${pad("ATTEMPTS", 10)}${pad("ORIGIN EVENT", 24)}UPDATED`,
  );
  for (const r of visible) {
    console.log(
      `${pad(r.runId, 42)}${pad(r.state, 12)}${pad(r.agent, 26)}${pad(r.adapter, 12)}${pad(`${r.attempts}/${r.maxAttempts}`, 10)}${pad(r.eventId ?? "-", 24)}${r.updated_at}`,
    );
  }
  if (truncated > 0 || unfetched) {
    console.error(
      `... ${truncated}${unfetched ? "+" : ""} more rows (truncated)`,
    );
  }
}

export async function runsCommand(args, injectedClient = null) {
  const options = parseRunsArgs(args);
  const execute = async (client) => {
    if (options.dispatchOnly) {
      const { agents = [] } = await client.agents();
      options.keep = dispatchOnlyPredicate(agents);
    }
    await runs(client, options.state, options);
  };
  return injectedClient ? execute(injectedClient) : withClient(execute);
}

export default function runsCommandDefault(args) {
  return runsCommand(args);
}

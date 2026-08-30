import { pad, withClient } from "./shared.mjs";

const DISPATCH_AGENT_IDS = new Set(["dispatch", "worker"]);

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

function isDispatchWorkerAgent(def) {
  return DISPATCH_AGENT_IDS.has(def?.id);
}

export async function runs(client, stateFilter, options = {}) {
  const state = stateFilter?.toUpperCase();
  const query = {
    ...(state ? { state } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  };
  const usesOptions = Boolean(
    options.agent ||
    options.limit ||
    options.count ||
    (options.excludeAgents?.length ?? 0) > 0,
  );
  const rows = [];
  let before = null;
  do {
    // Preserve the original string call for state-only programmatic callers.
    const request =
      before === null &&
      !usesOptions &&
      Object.keys(query).length === 1 &&
      query.state
        ? query.state
        : { ...query, ...(before ? { before } : {}) };
    const page = await client.runs(request);
    rows.push(...(page.runs ?? []));
    const hasNextPage = page.hasNextPage ?? Boolean(page.nextBefore);
    if (!hasNextPage) break;
    if (typeof page.nextBefore !== "string" || page.nextBefore === "") {
      throw new Error(
        "runs response has another page but no nextBefore cursor",
      );
    }
    before = page.nextBefore;
  } while (before);

  const excluded = new Set(options.excludeAgents ?? []);
  const filtered = rows.filter((row) => !excluded.has(row.agent));
  const visible = options.limit ? filtered.slice(0, options.limit) : filtered;
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
  if (truncated > 0) console.error(`... ${truncated} more rows (truncated)`);
}

export async function runsCommand(args, injectedClient = null) {
  const options = parseRunsArgs(args);
  const execute = async (client) => {
    if (options.dispatchOnly) {
      const { agents = [] } = await client.agents();
      options.excludeAgents.push(
        ...agents
          .filter((agent) => !isDispatchWorkerAgent(agent))
          .map((agent) => agent.ref),
      );
    }
    await runs(client, options.state, options);
  };
  return injectedClient ? execute(injectedClient) : withClient(execute);
}

export default function runsCommandDefault(args) {
  return runsCommand(args);
}

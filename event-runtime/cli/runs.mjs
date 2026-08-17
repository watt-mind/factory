import { pad, withClient } from "./shared.mjs";

export async function runs(client, stateFilter) {
  const { runs: rows } = await client.runs(stateFilter);
  if (rows.length === 0) {
    console.log(stateFilter ? `no runs with state ${stateFilter}` : "no runs");
    return;
  }
  console.log(
    `${pad("RUN ID", 42)}${pad("STATE", 12)}${pad("AGENT", 26)}${pad("ADAPTER", 12)}${pad("ATTEMPTS", 10)}${pad("ORIGIN EVENT", 24)}UPDATED`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.runId, 42)}${pad(r.state, 12)}${pad(r.agent, 26)}${pad(r.adapter, 12)}${pad(`${r.attempts}/${r.maxAttempts}`, 10)}${pad(r.eventId ?? "-", 24)}${r.updated_at}`,
    );
  }
}

export default function runsCommand(args) {
  return withClient((client) => runs(client, args[0]));
}

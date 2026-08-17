import { pad, withClient } from "./shared.mjs";

export async function ps(client, stateFilter) {
  const { runs: rows } = await client.runs();
  const filtered = stateFilter
    ? rows.filter((r) => r.state.toUpperCase() === stateFilter.toUpperCase())
    : rows.filter((r) => r.state === "RUNNING" || r.state === "LEASED");

  if (filtered.length === 0) {
    console.log(
      stateFilter
        ? `no process runs with state ${stateFilter}`
        : "no running processes",
    );
    return;
  }
  console.log(
    `${pad("RUN ID", 42)}${pad("STATE", 12)}${pad("AGENT", 26)}${pad("ADAPTER", 12)}${pad("ATTEMPTS", 10)}${pad("ORIGIN EVENT", 24)}UPDATED`,
  );
  for (const r of filtered) {
    console.log(
      `${pad(r.runId, 42)}${pad(r.state, 12)}${pad(r.agent, 26)}${pad(r.adapter, 12)}${pad(`${r.attempts}/${r.maxAttempts}`, 10)}${pad(r.eventId ?? "-", 24)}${r.updated_at}`,
    );
  }
}

export default function psCommand(args) {
  return withClient((client) => ps(client, args[0]));
}

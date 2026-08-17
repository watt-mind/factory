import { pad, withClient } from "./shared.mjs";

export async function workers(client) {
  const { workers: rows } = await client.workers();
  if (rows.length === 0) {
    console.log(
      "no workers have registered — start one with: bun event-runtime/cli.mjs work",
    );
    return;
  }
  console.log(
    `${pad("WORKER", 26)}${pad("HOST", 18)}${pad("STATE", 10)}${pad("LABELS", 24)}${pad("CURRENT RUN", 42)}LAST SEEN`,
  );
  for (const w of rows) {
    const state = w.stale ? `${w.state}!stale` : w.state;
    const labels =
      Object.entries(w.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "-";
    console.log(
      `${pad(w.workerId, 26)}${pad(w.host, 18)}${pad(state, 10)}${pad(labels, 24)}${pad(w.currentRun ?? "-", 42)}${w.lastSeen}`,
    );
  }
}

export default function workersCommand(args) {
  return withClient((client) => workers(client));
}

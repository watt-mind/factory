import { pad, withClient } from "./shared.mjs";

export async function events(client, statusFilter) {
  const { events: rows } = await client.events(statusFilter);
  if (rows.length === 0) {
    console.log(
      statusFilter ? `no events with status ${statusFilter}` : "no events",
    );
    return;
  }
  console.log(
    `${pad("SOURCE", 16)}${pad("EVENT", 24)}${pad("TYPE", 36)}${pad("STATUS", 14)}${pad("ADMITTED", 26)}ERROR`,
  );
  for (const e of rows) {
    console.log(
      `${pad(e.source, 16)}${pad(e.eventId, 24)}${pad(e.type, 36)}${pad(e.status, 14)}${pad(e.admittedAt, 26)}${e.lastPlanError ?? "-"}`,
    );
  }
}

export default function eventsCommand(args) {
  return withClient((client) => events(client, args[0]));
}

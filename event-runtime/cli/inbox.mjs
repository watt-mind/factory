import { pad, withClient } from "./shared.mjs";

export async function inbox(client) {
  const res = await fetch(
    `http://${client.host}:${client.port}/inbox?status=open`,
  );
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (body.items.length === 0) {
    console.log("no open inbox items");
    return;
  }
  console.log(
    `${pad("ID", 44)}${pad("KIND", 18)}${pad("SEVERITY", 11)}${pad("WAITING", 10)}${pad("CREATED", 26)}TITLE`,
  );
  for (const item of body.items) {
    const waiting =
      typeof item.waitingCount === "number" && item.waitingCount > 1
        ? String(item.waitingCount)
        : "-";
    console.log(
      `${pad(item.id, 44)}${pad(item.kind, 18)}${pad(item.severity, 11)}${pad(waiting, 10)}${pad(item.createdAt, 26)}${item.title}`,
    );
  }
}

export default function inboxCommand(args) {
  return withClient((client) => inbox(client));
}

import { pad, withClient } from "./shared.mjs";
import { unauthorizedMessage } from "../lib/client.mjs";

export async function inbox(client) {
  const token = client.token ?? process.env.FACTORY_CONTROL_API_TOKEN ?? null;
  const inboxUrl = new URL("inbox?status=open", `${client.baseUrl}/`);
  const res = await fetch(inboxUrl, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(
      res.status === 401 ||
        (res.status === 503 && body?.error === "control_api_token_unset")
        ? unauthorizedMessage(Boolean(token))
        : (body?.error ?? `HTTP ${res.status}`),
    );
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

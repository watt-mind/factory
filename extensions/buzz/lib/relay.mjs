/**
 * Buzz HTTP bridge: NIP-98 + optional x-auth-tag, POST /events and POST /query.
 * User-Agent is required — the watt-mind edge rejects Python's default UA with 403
 * (WM-905); send an explicit one.
 */
import { nip98Header } from "./nostr.mjs";

export const USER_AGENT = "wattmind-factory-buzz/1.0";

export function joinUrl(relayUrl, path) {
  return `${String(relayUrl).replace(/\/$/, "")}${path}`;
}

async function signedPost({
  url,
  body,
  secretHex,
  authTagJson,
  fetchImpl = fetch,
}) {
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    authorization: nip98Header(secretHex, { url, method: "POST", body }),
  };
  if (authTagJson) headers["x-auth-tag"] = authTagJson;
  const res = await fetchImpl(url, { method: "POST", headers, body });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { ok: res.ok, status: res.status, json, text };
}

export async function postEvent(
  relayUrl,
  event,
  { secretHex, authTagJson, fetchImpl } = {},
) {
  const body = JSON.stringify(event);
  return signedPost({
    url: joinUrl(relayUrl, "/events"),
    body,
    secretHex,
    authTagJson,
    fetchImpl,
  });
}

export async function queryEvents(
  relayUrl,
  filters,
  { secretHex, authTagJson, fetchImpl } = {},
) {
  const list = Array.isArray(filters) ? filters : [filters];
  const body = JSON.stringify(list);
  return signedPost({
    url: joinUrl(relayUrl, "/query"),
    body,
    secretHex,
    authTagJson,
    fetchImpl,
  });
}

/**
 * Client for the loopback control API (docs/event-runtime.md §12).
 *
 * The CLI — and any future TUI or web app — talks to the runtime exclusively
 * through this module: one small method per endpoint, parsed JSON back, and a
 * thrown Error carrying `.status` plus the server's error message on any
 * non-2xx response. A connection failure (serve not running) surfaces as an
 * error with no `.status`, which callers use to say exactly that.
 */
import { API_HOST, DEFAULT_PORT } from "./config.mjs";

export function apiClient({ port = DEFAULT_PORT, host = API_HOST } = {}) {
  const base = `http://${host}:${port}`;

  async function call(method, path, { body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message =
        json?.error ?? (Array.isArray(json?.errors) ? json.errors.join("; ") : `HTTP ${res.status}`);
      const err = new Error(message);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    host,
    port,
    health: () => call("GET", "/health"),
    /** Webhook intake: raw body string plus the §14 signature headers. */
    postEvent: (rawBody, { signature, timestamp } = {}) => {
      const headers = {};
      if (signature !== undefined) headers["x-factory-signature"] = signature;
      if (timestamp !== undefined) headers["x-factory-timestamp"] = String(timestamp);
      return call("POST", "/events", { body: rawBody, headers });
    },
    /** Replay/inject: same admission path, no signature (loopback only, §13). */
    replay: (envelope) => call("POST", "/replay", { body: JSON.stringify(envelope) }),
    status: () => call("GET", "/status"),
    events: (status) => call("GET", `/events${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    proposals: (status) => call("GET", `/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    journal: ({ since = 0, limit = 100 } = {}) => call("GET", `/journal?since=${since}&limit=${limit}`),
    outbox: ({ limit = 50 } = {}) => call("GET", `/outbox?limit=${limit}`),
    requeue: (source, eventId) =>
      call("POST", "/events/requeue", { body: JSON.stringify({ source, eventId }) }),
    agents: () => call("GET", "/agents"),
    workers: () => call("GET", "/workers"),
    approve: (id) => call("POST", `/proposals/${encodeURIComponent(id)}/approve`, { body: "{}" }),
    reject: (id, reason) =>
      call("POST", `/proposals/${encodeURIComponent(id)}/reject`, { body: JSON.stringify({ reason }) }),
    runs: (state) => call("GET", `/runs${state ? `?state=${encodeURIComponent(state)}` : ""}`),
    run: (id) => call("GET", `/runs/${encodeURIComponent(id)}`),
    cancel: (id, reason) =>
      call("POST", `/runs/${encodeURIComponent(id)}/cancel`, {
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    retry: (id, { force = false } = {}) =>
      call("POST", `/runs/${encodeURIComponent(id)}/retry`, { body: JSON.stringify({ force }) }),
  };
}

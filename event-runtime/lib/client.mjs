/**
 * Client for the control API (docs/event-runtime.md §12) — loopback by default.
 *
 * The CLI — and any future TUI or web app — talks to the runtime exclusively
 * through this module: one small method per endpoint, parsed JSON back, and a
 * thrown Error carrying `.status` plus the server's error message on any
 * non-2xx response. A connection failure (serve not running) surfaces as an
 * error with no `.status`, which callers use to say exactly that.
 */
import { API_HOST, DEFAULT_PORT, resolveControlApiTarget } from "./config.mjs";

export { resolveControlApiTarget } from "./config.mjs";

/**
 * Actionable text for a control-API auth failure (#1132). Names the variable and the
 * file the operator has to touch, and never the credential itself — the
 * message reaches stderr, transcripts and PR bodies.
 */
export function unauthorizedMessage(tokenPresent) {
  return tokenPresent
    ? "control API rejected FACTORY_CONTROL_API_TOKEN"
    : "control API requires FACTORY_CONTROL_API_TOKEN; set it in ~/.factory/secrets.env";
}

/** The historic loopback pin: no environment, no config, no argv. */
function pinnedLoopbackTarget(port) {
  return {
    baseUrl: `http://${API_HOST}:${port}`,
    host: API_HOST,
    port,
    source: "pinned",
  };
}

export function apiClient({
  /** A complete HTTP(S) control API URL, including an optional path prefix. */
  url,
  /** Backwards-compatible host override; a bare host uses the selected port. */
  host,
  port,
  // WM-1152: bearer the control API requires when FACTORY_CONTROL_API_TOKEN is
  // set. Read from env by default so every CLI/worker caller authenticates
  // without changes; sent on every request (webhook/health ignore it). Never
  // logged. Unset means no header, matching the pre-token behavior.
  token = process.env.FACTORY_CONTROL_API_TOKEN || null,
  /**
   * Opt in to ambient target resolution — the environment and
   * ~/.factory/config.json (#2188). Left unset it is true only for a caller
   * that names no target at all (the CLI entrypoints), so every existing
   * `apiClient({ port })` caller keeps its 127.0.0.1 pin unchanged. The library
   * never reads process.argv; bin/factory turns operator flags into env.
   */
  resolveTarget,
} = {}) {
  const explicit = url ?? host ?? null;
  const shouldResolve =
    resolveTarget ??
    (url === undefined && host === undefined && port === undefined);
  const target =
    explicit || shouldResolve
      ? resolveControlApiTarget({
          target: explicit,
          ...(port === undefined ? {} : { defaultPort: port }),
        })
      : pinnedLoopbackTarget(port ?? DEFAULT_PORT);
  const base = target.baseUrl;
  const authHeader = token ? { authorization: `Bearer ${token}` } : {};

  async function call(method, path, { body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...authHeader,
        ...headers,
      },
      body,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* malformed response body: json stays null from the initializer */
    }
    if (!res.ok) {
      const message =
        res.status === 401 ||
        (res.status === 503 && json?.error === "control_api_token_unset")
          ? unauthorizedMessage(Boolean(token))
          : (json?.error ??
            (Array.isArray(json?.errors)
              ? json.errors.join("; ")
              : `HTTP ${res.status}`));
      const err = new Error(message);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    host: target.host,
    port: target.port,
    baseUrl: target.baseUrl,
    token,
    health: () => call("GET", "/health"),
    /** Webhook intake: raw body string plus the §14 signature headers. */
    postEvent: (rawBody, { signature, timestamp } = {}) => {
      const headers = {};
      if (signature !== undefined) headers["x-factory-signature"] = signature;
      if (timestamp !== undefined)
        headers["x-factory-timestamp"] = String(timestamp);
      return call("POST", "/events", { body: rawBody, headers });
    },
    /** Replay/inject: same admission path, no signature (loopback only, §13). */
    replay: (envelope) =>
      call("POST", "/replay", { body: JSON.stringify(envelope) }),
    status: () => call("GET", "/status"),
    events: (status) =>
      call(
        "GET",
        `/events${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      ),
    proposals: (status) =>
      call(
        "GET",
        `/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      ),
    journal: ({ since = 0, limit = 100 } = {}) =>
      call("GET", `/journal?since=${since}&limit=${limit}`),
    outbox: ({ limit = 50 } = {}) => call("GET", `/outbox?limit=${limit}`),
    requeue: (source, eventId) =>
      call("POST", "/events/requeue", {
        body: JSON.stringify({ source, eventId }),
      }),
    archive: (source, eventId) =>
      call("POST", "/events/archive", {
        body: JSON.stringify({ source, eventId }),
      }),
    releaseWorker: (workerId, runId) =>
      call("POST", `/workers/${encodeURIComponent(workerId)}/release`, {
        body: JSON.stringify({ runId }),
      }),
    agents: () => call("GET", "/agents"),
    /** Declarative Overview panels (WM-840): `{ panels, endpoints }`, panel data is fetched from each `source.endpoint`. */
    panels: () => call("GET", "/panels"),
    workers: () => call("GET", "/workers"),
    schedules: () => call("GET", "/schedules"),
    /** Factory repo registry from config/repos.yaml (OPS-299). */
    repos: () => call("GET", "/repos"),
    /**
     * Loopback janitor for one repos.yaml entry (OPS-301). `apply: false`
     * (the default) is a dry survey; `apply: true` tears down finished-ticket
     * worktrees via the repo's worktree_down, never `--force`.
     */
    janitor: (name, { apply = false } = {}) =>
      call("POST", `/repos/${encodeURIComponent(name)}/janitor`, {
        body: JSON.stringify({ apply: apply === true }),
      }),
    approve: (id) =>
      call("POST", `/proposals/${encodeURIComponent(id)}/approve`, {
        body: "{}",
      }),
    reject: (id, reason) =>
      call("POST", `/proposals/${encodeURIComponent(id)}/reject`, {
        body: JSON.stringify({ reason }),
      }),
    /**
     * List runs. Accept the original state string for existing callers, or an
     * options object so list clients can carry the API's cursor and filters.
     */
    runs: (stateOrOptions) => {
      const options =
        typeof stateOrOptions === "string"
          ? { state: stateOrOptions }
          : (stateOrOptions ?? {});
      const query = new URLSearchParams();
      for (const key of ["state", "agent", "limit", "before"]) {
        if (options[key] !== undefined && options[key] !== null) {
          query.set(key, String(options[key]));
        }
      }
      const suffix = query.size > 0 ? `?${query}` : "";
      return call("GET", `/runs${suffix}`);
    },
    run: (id) => call("GET", `/runs/${encodeURIComponent(id)}`),
    /**
     * Raw artifact bytes by content address (GET /artifacts/:sha). The route
     * sits behind the bearer gate like every other control route, so callers
     * must go through here rather than a bare fetch (#1132 follow-up): a demo
     * serve spawned under FACTORY_CONTROL_API_TOKEN answered a bare fetch
     * with 401 and failed every worktree-up fixture verify. Returns the
     * Response so callers can inspect status and read the body themselves.
     */
    artifact: (sha256) =>
      fetch(`${base}/artifacts/${encodeURIComponent(sha256)}`, {
        headers: { ...authHeader },
      }),
    /** Live agent trace (factory.trace/v1): pass head back as since to poll. */
    trace: (id, { since = 0, limit = 100 } = {}) =>
      call(
        "GET",
        `/runs/${encodeURIComponent(id)}/trace?since=${since}&limit=${limit}`,
      ),
    cancel: (id, reason) =>
      call("POST", `/runs/${encodeURIComponent(id)}/cancel`, {
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    retry: (id, { force = false } = {}) =>
      call("POST", `/runs/${encodeURIComponent(id)}/retry`, {
        body: JSON.stringify({ force }),
      }),
    extend: (id, seconds, { override = false } = {}) =>
      call("POST", `/runs/${encodeURIComponent(id)}/extend`, {
        body: JSON.stringify({ seconds, override }),
      }),
  };
}

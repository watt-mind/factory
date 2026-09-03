/**
 * Pluggable ingress router for celld / Cloudflare Workers.
 *
 * SECURITY: every request except the unauthenticated liveness probe must carry
 * the shared-secret bearer token from `env.CELL_AUTH_TOKEN`. The check fails
 * closed when the secret is unset, so an unconfigured worker is never an open
 * one. See the deployment warning in `cells/src/index.mjs`.
 */

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Shared-secret bearer check. Stop-gap for the loopback spike only. Returns a
 * `Response` on failure and `null` when the caller is authorized.
 */
export function checkAuth(request, env) {
  const secret = env && env.CELL_AUTH_TOKEN;
  if (!secret) {
    return jsonResponse(
      {
        error: "unauthorized",
        message:
          "CELL_AUTH_TOKEN is not configured; the cell refuses all requests",
      },
      401,
    );
  }

  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match ? match[1].trim() : null;
  if (!presented || presented.length !== secret.length) {
    return jsonResponse(
      { error: "unauthorized", message: "missing or invalid bearer token" },
      401,
    );
  }

  // Length-independent constant-time-ish compare.
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  if (diff !== 0) {
    return jsonResponse(
      { error: "unauthorized", message: "missing or invalid bearer token" },
      401,
    );
  }

  return null;
}

export class CellRouter {
  constructor() {
    this.routes = [];
  }

  register({ prefix, bindingName, test = null }) {
    this.routes.push({
      prefix,
      bindingName,
      test: test || ((cellId) => cellId.startsWith(prefix)),
    });
    return this;
  }

  resolveBinding(cellId, env, request) {
    const cellTypeHeader = request.headers.get("X-Cell-Type");

    // Header override.
    if (cellTypeHeader === "site") return env.SITE_CELL || env.GENERIC_CELL;
    if (cellTypeHeader === "article")
      return env.ARTICLE_CELL || env.GENERIC_CELL;
    if (cellTypeHeader === "generic") return env.GENERIC_CELL;

    // Route matching.
    for (const route of this.routes) {
      if (route.test(cellId)) {
        return env[route.bindingName] || env.GENERIC_CELL;
      }
    }

    return env.GENERIC_CELL;
  }

  async handle(request, env) {
    const url = new URL(request.url);

    // Health check endpoint — unauthenticated liveness probe only; it exposes
    // no cell state.
    if (url.pathname === "/health" || url.pathname === "/") {
      return jsonResponse({
        status: "healthy",
        service: "factory-cells",
        routesCount: this.routes.length,
      });
    }

    const authFailure = checkAuth(request, env);
    if (authFailure) return authFailure;

    // Route by cell id from header (`X-Cell-Id`) or path (`/cells/:cellId/...`).
    let cellId = request.headers.get("X-Cell-Id");
    let forwardUrl = url;

    const cellsPrefixMatch = url.pathname.match(/^\/cells\/([^/]+)(\/.*)?$/);
    if (cellsPrefixMatch) {
      cellId = decodeURIComponent(cellsPrefixMatch[1]);
      const subPath = cellsPrefixMatch[2] || "/";
      forwardUrl = new URL(subPath + url.search, url.origin);
    }

    if (!cellId) {
      return jsonResponse(
        {
          error: "missing_cell_id",
          message:
            "Request must specify X-Cell-Id header or /cells/:cellId/ path",
        },
        400,
      );
    }

    const targetBinding = this.resolveBinding(cellId, env, request);

    if (!targetBinding) {
      return jsonResponse(
        {
          error: "configuration_error",
          message: "Target Durable Object binding is not configured",
        },
        500,
      );
    }

    const doId = targetBinding.idFromName(cellId);
    const stub = targetBinding.get(doId);

    const forwardRequest = new Request(forwardUrl.toString(), request);
    return stub.fetch(forwardRequest);
  }
}

export const defaultRouter = new CellRouter()
  .register({ prefix: "editorial:site:", bindingName: "SITE_CELL" })
  .register({ prefix: "site:", bindingName: "SITE_CELL" })
  .register({ prefix: "editorial:article:", bindingName: "ARTICLE_CELL" })
  .register({ prefix: "article:", bindingName: "ARTICLE_CELL" })
  .register({ prefix: "generic:", bindingName: "GENERIC_CELL" })
  .register({ prefix: "infra:kv:", bindingName: "GENERIC_CELL" });

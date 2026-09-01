/**
 * Pluggable Ingress Router for celld / Cloudflare Workers.
 */
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

    // Header override
    if (cellTypeHeader === "site") return env.SITE_CELL || env.GENERIC_CELL;
    if (cellTypeHeader === "article")
      return env.ARTICLE_CELL || env.GENERIC_CELL;
    if (cellTypeHeader === "generic") return env.GENERIC_CELL;

    // Route matching
    for (const route of this.routes) {
      if (route.test(cellId)) {
        return env[route.bindingName] || env.GENERIC_CELL;
      }
    }

    return env.GENERIC_CELL;
  }

  async handle(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "factory-cells",
          routesCount: this.routes.length,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    let cellId = request.headers.get("X-Cell-Id");
    let forwardUrl = url;

    const cellsPrefixMatch = url.pathname.match(/^\/cells\/([^/]+)(\/.*)?$/);
    if (cellsPrefixMatch) {
      cellId = decodeURIComponent(cellsPrefixMatch[1]);
      const subPath = cellsPrefixMatch[2] || "/";
      forwardUrl = new URL(subPath + url.search, url.origin);
    }

    if (!cellId) {
      return new Response(
        JSON.stringify({
          error: "missing_cell_id",
          message:
            "Request must specify X-Cell-Id header or /cells/:cellId/ path",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const targetBinding = this.resolveBinding(cellId, env, request);

    if (!targetBinding) {
      return new Response(
        JSON.stringify({
          error: "binding_not_found",
          message: "Target Durable Object binding is not configured",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
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

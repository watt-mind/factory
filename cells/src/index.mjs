/**
 * factory-cells — GenericCell Durable Object (spike, ticket #2144).
 *
 * SECURITY / DEPLOYMENT WARNING:
 *   This is a loopback-only development spike. It is intended to be reached
 *   exclusively over 127.0.0.1 via `celld dev`. The only access control here is
 *   a shared-secret bearer token read from `env.CELL_AUTH_TOKEN`, which is a
 *   stop-gap, not an authentication system: there is no per-caller identity, no
 *   rotation, no rate limiting, and no authorization on which cell a caller may
 *   touch. Requests are refused outright when the secret is unset (fail closed).
 *
 *   This worker MUST NOT be deployed to a public or shared environment until
 *   real authentication and per-cell authorization are in place.
 */

export class GenericCell {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this._initTables();
  }

  _initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _cell_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _cell_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _cell_entities (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (collection, id)
      );
    `);

    // Ensure cell_version exists
    const cursor = this.sql.exec(
      "SELECT value FROM _cell_meta WHERE key = 'version'",
    );
    const rows = [...cursor];
    if (rows.length === 0) {
      this.sql.exec(
        "INSERT INTO _cell_meta (key, value) VALUES ('version', '1')",
      );
      this.sql.exec(
        "INSERT INTO _cell_meta (key, value) VALUES ('created_at', ?)",
        Date.now().toString(),
      );
    }
  }

  _getCellVersion() {
    const cursor = this.sql.exec(
      "SELECT value FROM _cell_meta WHERE key = 'version'",
    );
    const rows = [...cursor];
    return rows.length > 0 ? parseInt(rows[0].value, 10) : 1;
  }

  _bumpCellVersion() {
    const current = this._getCellVersion();
    const next = current + 1;
    this.sql.exec(
      "UPDATE _cell_meta SET value = ? WHERE key = 'version'",
      next.toString(),
    );
    return next;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    try {
      if (pathname === "/v1/info" || pathname === "/v1/schema") {
        if (method === "GET") {
          return this._handleGetSchema();
        }
      }

      if (pathname === "/v1/schema/migrate") {
        if (method === "POST") {
          const body = await request.json();
          return this._handleMigrate(body);
        }
      }

      if (pathname === "/v1/query") {
        if (method === "POST") {
          const body = await request.json();
          return this._handleQuery(body);
        }
      }

      // Entity endpoints: /v1/entities/:collection/:id or /v1/entities/:collection
      const entityMatch = pathname.match(
        /^\/v1\/entities\/([^/]+)(?:\/([^/]+))?$/,
      );
      if (entityMatch) {
        const collection = decodeURIComponent(entityMatch[1]);
        const id = entityMatch[2] ? decodeURIComponent(entityMatch[2]) : null;

        if (method === "GET") {
          if (id) {
            return this._handleGetEntity(collection, id);
          } else {
            return this._handleListEntities(collection, url.searchParams);
          }
        } else if (method === "PUT" && id) {
          const body = await request.json();
          return this._handlePutEntity(collection, id, body);
        } else if (method === "POST" && !id) {
          const body = await request.json();
          return this._handlePostEntity(collection, body);
        } else if (method === "DELETE" && id) {
          return this._handleDeleteEntity(collection, id, url.searchParams);
        }
      }

      return new Response(
        JSON.stringify({ error: "not_found", path: pathname }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (err) {
      // Log the stack locally; never leak it to the caller.
      console.error("[cell] unhandled error", err);
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message: err.message,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  _handleGetSchema() {
    const cellVersion = this._getCellVersion();
    const metaRows = [...this.sql.exec("SELECT key, value FROM _cell_meta")];
    const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));

    const migrationRows = [
      ...this.sql.exec(
        "SELECT id, applied_at, description FROM _cell_migrations ORDER BY applied_at ASC",
      ),
    ];

    // Filter out internal system tables (sqlite_*, _cf_*, _litestream_*)
    const tablesCursor = this.sql.exec(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_litestream_%'",
    );
    const tables = [...tablesCursor];

    return new Response(
      JSON.stringify({
        cellVersion,
        meta,
        migrations: migrationRows,
        tables,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  _handleMigrate(body) {
    const { migrationId, sql, description } = body;
    if (!migrationId || !sql) {
      return new Response(
        JSON.stringify({
          error: "bad_request",
          message: "migrationId and sql are required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Check if migration was already applied
    const existing = [
      ...this.sql.exec(
        "SELECT id FROM _cell_migrations WHERE id = ?",
        migrationId,
      ),
    ];
    if (existing.length > 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          alreadyApplied: true,
          migrationId,
          cellVersion: this._getCellVersion(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Apply migration inside storage transaction
    this.sql.exec(sql);
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO _cell_migrations (id, applied_at, description) VALUES (?, ?, ?)",
      migrationId,
      now,
      description || null,
    );
    const newVersion = this._bumpCellVersion();

    return new Response(
      JSON.stringify({
        ok: true,
        applied: true,
        migrationId,
        cellVersion: newVersion,
        appliedAt: now,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  _handleQuery(body) {
    const { sql, params = [] } = body;
    if (!sql || typeof sql !== "string") {
      return new Response(
        JSON.stringify({
          error: "bad_request",
          message: "sql string is required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Only a single statement may be submitted: a trailing `;` is tolerated but
    // anything after it is rejected, so `SELECT 1; DROP TABLE _cell_entities;`
    // cannot ride in behind a read-only leading keyword.
    const semicolonIndex = sql.indexOf(";");
    if (semicolonIndex !== -1 && sql.slice(semicolonIndex + 1).trim() !== "") {
      return new Response(
        JSON.stringify({
          error: "forbidden",
          message:
            "query endpoint accepts a single statement; additional statements after ';' are not permitted",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const trimmed = sql.trim().toUpperCase();
    if (
      !trimmed.startsWith("SELECT") &&
      !trimmed.startsWith("PRAGMA") &&
      !trimmed.startsWith("EXPLAIN")
    ) {
      return new Response(
        JSON.stringify({
          error: "forbidden",
          message:
            "query endpoint only permits read-only statements (SELECT/PRAGMA/EXPLAIN). Use /v1/schema/migrate or /v1/entities for mutations.",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const cursor = this.sql.exec(sql, ...params);
    const rows = [...cursor];

    return new Response(
      JSON.stringify({
        rows,
        count: rows.length,
        cellVersion: this._getCellVersion(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  _handleGetEntity(collection, id) {
    const cursor = this.sql.exec(
      "SELECT collection, id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? AND id = ?",
      collection,
      id,
    );
    const rows = [...cursor];
    if (rows.length === 0) {
      return new Response(
        JSON.stringify({
          error: "not_found",
          collection,
          id,
          cellVersion: this._getCellVersion(),
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const row = rows[0];
    let parsedData;
    try {
      parsedData = JSON.parse(row.data);
    } catch {
      parsedData = row.data;
    }

    return new Response(
      JSON.stringify({
        collection: row.collection,
        id: row.id,
        data: parsedData,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cellVersion: this._getCellVersion(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  _handleListEntities(collection, searchParams) {
    const limit = Math.min(
      parseInt(searchParams.get("limit") || "100", 10),
      1000,
    );
    const cursor = this.sql.exec(
      "SELECT collection, id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? ORDER BY updated_at DESC LIMIT ?",
      collection,
      limit,
    );
    const rows = [...cursor].map((row) => {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        data = row.data;
      }
      return {
        id: row.id,
        data,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return new Response(
      JSON.stringify({
        collection,
        entities: rows,
        count: rows.length,
        cellVersion: this._getCellVersion(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  _handlePutEntity(collection, id, body) {
    const { data, expectedVersion } = body;
    if (data === undefined) {
      return new Response(
        JSON.stringify({ error: "bad_request", message: "data is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    const now = Date.now();

    // Check existing entity
    const existingRows = [
      ...this.sql.exec(
        "SELECT version FROM _cell_entities WHERE collection = ? AND id = ?",
        collection,
        id,
      ),
    ];

    if (existingRows.length === 0) {
      // New insert
      if (
        expectedVersion !== undefined &&
        expectedVersion !== null &&
        expectedVersion !== 0
      ) {
        return new Response(
          JSON.stringify({
            error: "conflict",
            message: `Entity does not exist (expectedVersion=${expectedVersion})`,
            currentVersion: 0,
            cellVersion: this._getCellVersion(),
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      this.sql.exec(
        "INSERT INTO _cell_entities (collection, id, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        collection,
        id,
        serialized,
        now,
        now,
      );
      const newCellVersion = this._bumpCellVersion();

      return new Response(
        JSON.stringify({
          ok: true,
          created: true,
          collection,
          id,
          version: 1,
          cellVersion: newCellVersion,
          updatedAt: now,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } else {
      // Existing update
      const currentVersion = existingRows[0].version;
      if (
        expectedVersion !== undefined &&
        expectedVersion !== null &&
        expectedVersion !== currentVersion
      ) {
        return new Response(
          JSON.stringify({
            error: "conflict",
            message: `Version conflict: currentVersion is ${currentVersion}, expectedVersion was ${expectedVersion}`,
            currentVersion,
            cellVersion: this._getCellVersion(),
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const nextVersion = currentVersion + 1;
      this.sql.exec(
        "UPDATE _cell_entities SET data = ?, version = ?, updated_at = ? WHERE collection = ? AND id = ?",
        serialized,
        nextVersion,
        now,
        collection,
        id,
      );
      const newCellVersion = this._bumpCellVersion();

      return new Response(
        JSON.stringify({
          ok: true,
          updated: true,
          collection,
          id,
          version: nextVersion,
          cellVersion: newCellVersion,
          updatedAt: now,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  _handlePostEntity(collection, body) {
    const id =
      body.id ||
      (globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    return this._handlePutEntity(collection, id, {
      data: body.data,
      expectedVersion: body.expectedVersion,
    });
  }

  _handleDeleteEntity(collection, id, searchParams) {
    const expectedVersionParam = searchParams.get("expectedVersion");
    let expectedVersion = null;
    if (expectedVersionParam !== null && expectedVersionParam !== "") {
      if (!/^-?\d+$/.test(expectedVersionParam.trim())) {
        return new Response(
          JSON.stringify({
            error: "bad_request",
            message: `expectedVersion must be an integer, received ${JSON.stringify(expectedVersionParam)}`,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      expectedVersion = parseInt(expectedVersionParam.trim(), 10);
    }

    const existingRows = [
      ...this.sql.exec(
        "SELECT version FROM _cell_entities WHERE collection = ? AND id = ?",
        collection,
        id,
      ),
    ];

    if (existingRows.length === 0) {
      return new Response(
        JSON.stringify({
          error: "not_found",
          collection,
          id,
          cellVersion: this._getCellVersion(),
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const currentVersion = existingRows[0].version;
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      return new Response(
        JSON.stringify({
          error: "conflict",
          message: `Version conflict: currentVersion is ${currentVersion}, expectedVersion was ${expectedVersion}`,
          currentVersion,
          cellVersion: this._getCellVersion(),
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    this.sql.exec(
      "DELETE FROM _cell_entities WHERE collection = ? AND id = ?",
      collection,
      id,
    );
    const newCellVersion = this._bumpCellVersion();

    return new Response(
      JSON.stringify({
        ok: true,
        deleted: true,
        collection,
        id,
        cellVersion: newCellVersion,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Shared-secret bearer check. Stop-gap for the loopback spike only — see the
 * deployment warning at the top of this file. Fails closed when the secret is
 * not configured so an unconfigured worker is never an open one.
 */
function checkAuth(request, env) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check endpoint — unauthenticated liveness probe only; it exposes
    // no cell state.
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({ status: "healthy", service: "factory-cells" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const authFailure = checkAuth(request, env);
    if (authFailure) return authFailure;

    // Route by Cell ID from header or path:
    // 1. Header `X-Cell-Id`
    // 2. URL path `/cells/:cellId/...`
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

    if (!env.GENERIC_CELL) {
      return new Response(
        JSON.stringify({
          error: "configuration_error",
          message: "GENERIC_CELL Durable Object binding not configured",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const doId = env.GENERIC_CELL.idFromName(cellId);
    const stub = env.GENERIC_CELL.get(doId);

    // Forward request with rewritten URL
    const forwardRequest = new Request(forwardUrl.toString(), request);
    return stub.fetch(forwardRequest);
  },
};

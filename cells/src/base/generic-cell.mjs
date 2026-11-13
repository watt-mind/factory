/**
 * GenericCell: base actor providing schema management, versioning, entity CRUD,
 * and read-only SQL queries.
 *
 * SECURITY / DEPLOYMENT WARNING:
 *   See `cells/src/index.mjs` — this is a loopback-only development spike. The
 *   only access control is the shared-secret bearer token enforced by the
 *   ingress router plus the coarse `X-Cell-Access` tier hint below; neither is
 *   an authentication system.
 */

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Coarse access tiers, most permissive first. A caller declares its tier in
// `X-Cell-Access`; the cell only enforces what was declared.
const ACCESS_TIERS = ["malleable", "read-write", "data-only", "read-only"];

// Fail closed: a request that declares no tier gets the most restrictive one,
// so forgetting the header can never widen access.
const DEFAULT_ACCESS_TIER = "read-only";

/**
 * Resolves the declared access tier. Returns `{ access }` on success and
 * `{ error }` (a `Response`) for an unrecognised value.
 */
function resolveAccessTier(request) {
  const header = request.headers.get("X-Cell-Access");
  if (header === null || header === "") {
    return { access: DEFAULT_ACCESS_TIER };
  }
  if (!ACCESS_TIERS.includes(header)) {
    return {
      error: jsonResponse(
        {
          error: "bad_request",
          code: "unknown_access_tier",
          message: `Unknown X-Cell-Access value ${JSON.stringify(header)}; expected one of ${ACCESS_TIERS.join(", ")}`,
        },
        400,
      ),
    };
  }
  return { access: header };
}

export class GenericCell {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this._initBaseTables();
  }

  _initBaseTables() {
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

    const cursor = this.sql.exec(
      "SELECT value FROM _cell_meta WHERE key = 'version'",
    );
    if ([...cursor].length === 0) {
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

  _bumpCellVersion(nextState = null) {
    const next = this._getCellVersion() + 1;
    this.sql.exec(
      "UPDATE _cell_meta SET value = ? WHERE key = 'version'",
      next.toString(),
    );
    if (nextState) {
      this.sql.exec(
        "INSERT INTO _cell_meta (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        nextState,
      );
    }
    return next;
  }

  /**
   * Handles the routes every cell shares. Returns `null` when the path is not a
   * generic route, so subclasses can continue with their own routing table.
   */
  async _handleGenericRoutes(request, pathname, method) {
    const url = new URL(request.url);
    const tier = resolveAccessTier(request);
    if (tier.error) return tier.error;
    const access = tier.access;

    if (access === "read-only" && method !== "GET") {
      return jsonResponse(
        {
          error: "forbidden",
          code: "read_only_access",
          message: "Write operations are forbidden (access level: read-only)",
        },
        403,
      );
    }

    if (
      (access === "data-only" || access === "read-write") &&
      pathname === "/v1/schema/migrate"
    ) {
      return jsonResponse(
        {
          error: "forbidden",
          code: "schema_modifications_forbidden",
          message:
            "Schema modifications are forbidden (access level: data-only). Data operations are permitted, but table alterations require 'malleable' access.",
        },
        403,
      );
    }

    if (
      (pathname === "/v1/schema" || pathname === "/v1/info") &&
      method === "GET"
    ) {
      return this._handleGetSchema();
    }

    if (pathname === "/v1/schema/migrate" && method === "POST") {
      return this._handleMigrate(await request.json());
    }

    if (pathname === "/v1/query" && method === "POST") {
      return this._handleQuery(await request.json());
    }

    // Entity endpoints: /v1/entities/:collection[/:id]
    const entityMatch = pathname.match(
      /^\/v1\/entities\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (entityMatch) {
      const collection = decodeURIComponent(entityMatch[1]);
      const id = entityMatch[2] ? decodeURIComponent(entityMatch[2]) : null;

      if (method === "GET") {
        return id
          ? this._handleGetEntity(collection, id)
          : this._handleListEntities(collection, url.searchParams);
      }
      if (method === "PUT" && id) {
        return this._handlePutEntity(collection, id, await request.json());
      }
      if (method === "POST" && !id) {
        return this._handlePostEntity(collection, await request.json());
      }
      if (method === "DELETE" && id) {
        return this._handleDeleteEntity(collection, id, url.searchParams);
      }
    }

    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    try {
      const generic = await this._handleGenericRoutes(
        request,
        pathname,
        method,
      );
      if (generic) return generic;

      return jsonResponse({ error: "not_found", path: pathname }, 404);
    } catch (err) {
      // Log the stack locally; never leak it to the caller.
      console.error("[cell] unhandled error", err);
      return jsonResponse(
        { error: "internal_error", message: err.message },
        500,
      );
    }
  }

  _handleGetSchema() {
    const meta = Object.fromEntries(
      [...this.sql.exec("SELECT key, value FROM _cell_meta")].map((r) => [
        r.key,
        r.value,
      ]),
    );
    const migrations = [
      ...this.sql.exec(
        "SELECT id, applied_at, description FROM _cell_migrations ORDER BY applied_at ASC",
      ),
    ];
    // Filter out internal system tables (sqlite_*, _cf_*, _litestream_*).
    const tables = [
      ...this.sql.exec(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_litestream_%'",
      ),
    ];

    return jsonResponse({
      cellVersion: this._getCellVersion(),
      meta,
      migrations,
      tables,
    });
  }

  _handleMigrate(body) {
    const { migrationId, sql, description } = body;
    if (!migrationId || !sql) {
      return jsonResponse(
        {
          error: "bad_request",
          message: "migrationId and sql are required",
        },
        400,
      );
    }

    const existing = [
      ...this.sql.exec(
        "SELECT id FROM _cell_migrations WHERE id = ?",
        migrationId,
      ),
    ];
    if (existing.length > 0) {
      return jsonResponse({
        ok: true,
        applied: false,
        alreadyApplied: true,
        migrationId,
        cellVersion: this._getCellVersion(),
      });
    }

    this.sql.exec(sql);
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO _cell_migrations (id, applied_at, description) VALUES (?, ?, ?)",
      migrationId,
      now,
      description || null,
    );
    const newVersion = this._bumpCellVersion();

    return jsonResponse({
      ok: true,
      applied: true,
      migrationId,
      cellVersion: newVersion,
      appliedAt: now,
    });
  }

  _handleQuery(body) {
    const { sql, params = [] } = body;
    if (!sql || typeof sql !== "string") {
      return jsonResponse(
        { error: "bad_request", message: "sql string is required" },
        400,
      );
    }

    // Only a single statement may be submitted: a trailing `;` is tolerated but
    // anything after it is rejected, so `SELECT 1; DROP TABLE _cell_entities;`
    // cannot ride in behind a read-only leading keyword.
    const semicolonIndex = sql.indexOf(";");
    if (semicolonIndex !== -1 && sql.slice(semicolonIndex + 1).trim() !== "") {
      return jsonResponse(
        {
          error: "forbidden",
          message:
            "query endpoint accepts a single statement; additional statements after ';' are not permitted",
        },
        403,
      );
    }

    const trimmed = sql.trim().toUpperCase();
    if (
      !trimmed.startsWith("SELECT") &&
      !trimmed.startsWith("PRAGMA") &&
      !trimmed.startsWith("EXPLAIN")
    ) {
      return jsonResponse(
        {
          error: "forbidden",
          message:
            "query endpoint only permits read-only statements (SELECT/PRAGMA/EXPLAIN). Use /v1/schema/migrate or /v1/entities for mutations.",
        },
        403,
      );
    }

    const rows = [...this.sql.exec(sql, ...params)];
    return jsonResponse({
      rows,
      count: rows.length,
      cellVersion: this._getCellVersion(),
    });
  }

  _handleGetEntity(collection, id) {
    const rows = [
      ...this.sql.exec(
        "SELECT collection, id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? AND id = ?",
        collection,
        id,
      ),
    ];
    if (rows.length === 0) {
      return jsonResponse(
        {
          error: "not_found",
          collection,
          id,
          cellVersion: this._getCellVersion(),
        },
        404,
      );
    }

    const row = rows[0];
    let parsedData;
    try {
      parsedData = JSON.parse(row.data);
    } catch {
      parsedData = row.data;
    }

    return jsonResponse({
      collection: row.collection,
      id: row.id,
      data: parsedData,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      cellVersion: this._getCellVersion(),
    });
  }

  _handleListEntities(collection, searchParams) {
    const limit = Math.min(
      parseInt(searchParams.get("limit") || "100", 10) || 100,
      1000,
    );
    const rows = [
      ...this.sql.exec(
        "SELECT collection, id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? ORDER BY updated_at DESC LIMIT ?",
        collection,
        limit,
      ),
    ].map((row) => {
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

    return jsonResponse({
      collection,
      entities: rows,
      count: rows.length,
      cellVersion: this._getCellVersion(),
    });
  }

  _handlePutEntity(collection, id, body) {
    const { data, expectedVersion } = body;
    if (data === undefined) {
      return jsonResponse(
        { error: "bad_request", message: "data is required" },
        400,
      );
    }

    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    const now = Date.now();

    const existingRows = [
      ...this.sql.exec(
        "SELECT version FROM _cell_entities WHERE collection = ? AND id = ?",
        collection,
        id,
      ),
    ];

    if (existingRows.length === 0) {
      if (
        expectedVersion !== undefined &&
        expectedVersion !== null &&
        expectedVersion !== 0
      ) {
        return jsonResponse(
          {
            error: "conflict",
            message: `Entity does not exist (expectedVersion=${expectedVersion})`,
            currentVersion: 0,
            cellVersion: this._getCellVersion(),
          },
          409,
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

      return jsonResponse({
        ok: true,
        created: true,
        collection,
        id,
        version: 1,
        cellVersion: newCellVersion,
        updatedAt: now,
      });
    }

    const currentVersion = existingRows[0].version;
    if (
      expectedVersion !== undefined &&
      expectedVersion !== null &&
      expectedVersion !== currentVersion
    ) {
      return jsonResponse(
        {
          error: "conflict",
          message: `Version conflict: currentVersion is ${currentVersion}, expectedVersion was ${expectedVersion}`,
          currentVersion,
          cellVersion: this._getCellVersion(),
        },
        409,
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

    return jsonResponse({
      ok: true,
      updated: true,
      collection,
      id,
      version: nextVersion,
      cellVersion: newCellVersion,
      updatedAt: now,
    });
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
        return jsonResponse(
          {
            error: "bad_request",
            message: `expectedVersion must be an integer, received ${JSON.stringify(expectedVersionParam)}`,
          },
          400,
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
      return jsonResponse(
        {
          error: "not_found",
          collection,
          id,
          cellVersion: this._getCellVersion(),
        },
        404,
      );
    }

    const currentVersion = existingRows[0].version;
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      return jsonResponse(
        {
          error: "conflict",
          message: `Version conflict: currentVersion is ${currentVersion}, expectedVersion was ${expectedVersion}`,
          currentVersion,
          cellVersion: this._getCellVersion(),
        },
        409,
      );
    }

    this.sql.exec(
      "DELETE FROM _cell_entities WHERE collection = ? AND id = ?",
      collection,
      id,
    );
    const newCellVersion = this._bumpCellVersion();

    return jsonResponse({
      ok: true,
      deleted: true,
      collection,
      id,
      cellVersion: newCellVersion,
    });
  }
}

export { jsonResponse };

/**
 * GenericCell: Base actor providing schema management, versioning, entity CRUD, and safe SQL queries.
 */
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

  async _handleGenericRoutes(request, pathname, method) {
    const access = request.headers.get("X-Cell-Access") || "malleable";

    if (access === "read-only" && method !== "GET") {
      return new Response(
        JSON.stringify({
          error: "forbidden",
          code: "read_only_access",
          message: "Write operations are forbidden (access level: read-only)",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      (access === "data-only" || access === "read-write") &&
      pathname === "/v1/schema/migrate"
    ) {
      return new Response(
        JSON.stringify({
          error: "forbidden",
          code: "schema_modifications_forbidden",
          message:
            "Schema modifications are forbidden (access level: data-only). Data operations are permitted, but table alterations require 'malleable' access.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    if (pathname === "/v1/schema" && method === "GET") {
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
      const tables = [
        ...this.sql.exec(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        ),
      ];
      return new Response(
        JSON.stringify({
          cellVersion: this._getCellVersion(),
          meta,
          migrations,
          tables,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (pathname === "/v1/schema/migrate" && method === "POST") {
      const { migrationId, sql, description } = await request.json();
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
            applied: false,
            message: "Migration already applied",
            migrationId,
            cellVersion: this._getCellVersion(),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
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

    const collectionListMatch = pathname.match(/^\/v1\/entities\/([^/]+)$/);
    if (collectionListMatch && method === "GET") {
      const [, collection] = collectionListMatch;
      const cursor = this.sql.exec(
        "SELECT id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? ORDER BY created_at ASC",
        collection,
      );
      const entities = [...cursor].map((r) => ({
        id: r.id,
        data: JSON.parse(r.data),
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return new Response(
        JSON.stringify({
          collection,
          entities,
          count: entities.length,
          cellVersion: this._getCellVersion(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const entityMatch = pathname.match(/^\/v1\/entities\/([^/]+)\/([^/]+)$/);
    if (entityMatch) {
      const [, collection, id] = entityMatch;
      if (method === "GET") {
        const cursor = this.sql.exec(
          "SELECT data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? AND id = ?",
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
        return new Response(
          JSON.stringify({
            collection,
            id,
            data: JSON.parse(row.data),
            version: row.version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            cellVersion: this._getCellVersion(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (method === "PUT") {
        const { data, expectedVersion } = await request.json();
        if (data === undefined) {
          return new Response(
            JSON.stringify({
              error: "bad_request",
              message: "data is required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const existing = [
          ...this.sql.exec(
            "SELECT version FROM _cell_entities WHERE collection = ? AND id = ?",
            collection,
            id,
          ),
        ];
        const now = Date.now();
        if (existing.length === 0) {
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
            JSON.stringify(data),
            now,
            now,
          );
          const newVersion = this._bumpCellVersion();
          return new Response(
            JSON.stringify({
              ok: true,
              created: true,
              collection,
              id,
              version: 1,
              cellVersion: newVersion,
              updatedAt: now,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } else {
          const currentVersion = existing[0].version;
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
            JSON.stringify(data),
            nextVersion,
            now,
            collection,
            id,
          );
          const newVersion = this._bumpCellVersion();
          return new Response(
            JSON.stringify({
              ok: true,
              updated: true,
              collection,
              id,
              version: nextVersion,
              cellVersion: newVersion,
              updatedAt: now,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
    }

    if (pathname === "/v1/query" && method === "POST") {
      const { sql, params = [] } = await request.json();
      if (!sql) {
        return new Response(
          JSON.stringify({
            error: "bad_request",
            message: "sql query is required",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i.test(sql)) {
        return new Response(
          JSON.stringify({
            error: "forbidden",
            message: "Only SELECT queries are permitted on /v1/query",
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

    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    try {
      const genericResponse = await this._handleGenericRoutes(
        request,
        pathname,
        method,
      );
      if (genericResponse) return genericResponse;

      return new Response(
        JSON.stringify({ error: "not_found", path: pathname }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message: err.message,
          stack: err.stack,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }
}

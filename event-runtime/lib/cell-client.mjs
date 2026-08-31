/**
 * Lightweight client for celld-backed Durable Object cells (docs/editorial-agent-runtime.md).
 *
 * Provides typed REST/RPC access to structured cell state:
 * - Schema & DDL migrations (/v1/schema, /v1/schema/migrate)
 * - Versioned entity persistence with optimistic concurrency (/v1/entities)
 * - Parameterized read-only SQL queries (/v1/query)
 */

export class CellError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "CellError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class VersionConflictError extends CellError {
  constructor(message, { currentVersion, cellVersion, details } = {}) {
    super(message, { status: 409, code: "conflict", details });
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
    this.cellVersion = cellVersion;
  }
}

export class CellNotFoundError extends CellError {
  constructor(message, { collection, id, details } = {}) {
    super(message, { status: 404, code: "not_found", details });
    this.name = "CellNotFoundError";
    this.collection = collection;
    this.id = id;
  }
}

export class CellClient {
  constructor({
    endpoint = "http://127.0.0.1:9876",
    cellId = null,
    fetch = globalThis.fetch,
    authToken = null,
  } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.cellId = cellId;
    this._fetch = fetch;
    // Shared-secret bearer token for the loopback cell spike. Defaults to the
    // daemon's own CELL_AUTH_TOKEN so a client in the same environment works
    // without extra wiring.
    this.authToken =
      authToken ?? globalThis.process?.env?.CELL_AUTH_TOKEN ?? null;
  }

  forCell(cellId) {
    if (!cellId || typeof cellId !== "string") {
      throw new Error("cellId must be a non-empty string");
    }
    return new CellClient({
      endpoint: this.endpoint,
      cellId,
      fetch: this._fetch,
      authToken: this.authToken,
    });
  }

  _url(path) {
    if (!this.cellId) {
      throw new Error(
        "CellClient must be bound to a cellId or call forCell(cellId)",
      );
    }
    const cleanPath = path.replace(/^\/+/, "");
    return `${this.endpoint}/cells/${encodeURIComponent(this.cellId)}/${cleanPath}`;
  }

  async _request(path, { method = "GET", body = null, headers = {} } = {}) {
    const url = this._url(path);
    const reqHeaders = {
      Accept: "application/json",
      ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
      ...headers,
    };

    let reqBody = null;
    if (body !== null && body !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      reqBody = typeof body === "string" ? body : JSON.stringify(body);
    }

    let response;
    try {
      response = await this._fetch(url, {
        method,
        headers: reqHeaders,
        body: reqBody,
      });
    } catch (err) {
      throw new CellError(
        `Network error reaching cell daemon at ${url}: ${err.message}`,
        {
          code: "network_error",
          details: err,
        },
      );
    }

    const contentType = response.headers.get("content-type") || "";
    let data;
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch (err) {
        throw new CellError(
          `Invalid JSON from cell endpoint ${url}: ${err.message}`,
          {
            status: response.status,
            code: "invalid_response",
          },
        );
      }
    } else {
      const text = await response.text();
      data = { message: text };
    }

    if (!response.ok) {
      if (response.status === 409) {
        throw new VersionConflictError(data.message || "Version conflict", {
          currentVersion: data.currentVersion,
          cellVersion: data.cellVersion,
          details: data,
        });
      }
      if (response.status === 404) {
        throw new CellNotFoundError(data.message || "Not found", {
          collection: data.collection,
          id: data.id,
          details: data,
        });
      }
      throw new CellError(
        data.message || `Cell request failed with status ${response.status}`,
        {
          status: response.status,
          code: data.error || "request_failed",
          details: data,
        },
      );
    }

    return data;
  }

  async checkHealth() {
    try {
      const res = await this._fetch(`${this.endpoint}/health`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.status === "healthy";
    } catch {
      return false;
    }
  }

  async getSchema() {
    return this._request("v1/schema", { method: "GET" });
  }

  async migrate({ migrationId, sql, description = null }) {
    if (!migrationId || !sql) {
      throw new Error("migrationId and sql are required");
    }
    return this._request("v1/schema/migrate", {
      method: "POST",
      body: { migrationId, sql, description },
    });
  }

  async getEntity(collection, id) {
    if (!collection || !id) {
      throw new Error("collection and id are required");
    }
    try {
      return await this._request(
        `v1/entities/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
        {
          method: "GET",
        },
      );
    } catch (err) {
      if (err instanceof CellNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  async listEntities(collection, { limit = 100 } = {}) {
    if (!collection) {
      throw new Error("collection is required");
    }
    return this._request(
      `v1/entities/${encodeURIComponent(collection)}?limit=${encodeURIComponent(limit)}`,
      {
        method: "GET",
      },
    );
  }

  async putEntity(collection, id, data, { expectedVersion } = {}) {
    if (!collection || !id) {
      throw new Error("collection and id are required");
    }
    return this._request(
      `v1/entities/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: { data, expectedVersion },
      },
    );
  }

  async postEntity(collection, data, { id = null, expectedVersion } = {}) {
    if (!collection) {
      throw new Error("collection is required");
    }
    return this._request(`v1/entities/${encodeURIComponent(collection)}`, {
      method: "POST",
      body: { id, data, expectedVersion },
    });
  }

  async deleteEntity(collection, id, { expectedVersion } = {}) {
    if (!collection || !id) {
      throw new Error("collection and id are required");
    }
    const query =
      expectedVersion !== undefined && expectedVersion !== null
        ? `?expectedVersion=${encodeURIComponent(expectedVersion)}`
        : "";
    return this._request(
      `v1/entities/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${query}`,
      {
        method: "DELETE",
      },
    );
  }

  async query(sql, params = []) {
    if (!sql || typeof sql !== "string") {
      throw new Error("sql query must be a string");
    }
    return this._request("v1/query", {
      method: "POST",
      body: { sql, params },
    });
  }
}

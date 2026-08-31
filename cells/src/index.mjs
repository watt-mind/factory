import crypto from "node:crypto";

/**
 * BaseCell: Foundation class providing schema management, versioning, entity CRUD, and safe SQL queries.
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

    const cursor = this.sql.exec("SELECT value FROM _cell_meta WHERE key = 'version'");
    if ([...cursor].length === 0) {
      this.sql.exec("INSERT INTO _cell_meta (key, value) VALUES ('version', '1')");
      this.sql.exec("INSERT INTO _cell_meta (key, value) VALUES ('created_at', ?)", Date.now().toString());
    }
  }

  _getCellVersion() {
    const cursor = this.sql.exec("SELECT value FROM _cell_meta WHERE key = 'version'");
    const rows = [...cursor];
    return rows.length > 0 ? parseInt(rows[0].value, 10) : 1;
  }

  _bumpCellVersion(nextState = null) {
    const next = this._getCellVersion() + 1;
    this.sql.exec("UPDATE _cell_meta SET value = ? WHERE key = 'version'", next.toString());
    if (nextState) {
      this.sql.exec("INSERT INTO _cell_meta (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", nextState);
    }
    return next;
  }

  async _handleGenericRoutes(request, pathname, method) {
    const access = request.headers.get("X-Cell-Access") || "malleable";

    if (access === "read-only" && method !== "GET") {
      return new Response(JSON.stringify({
        error: "forbidden",
        code: "read_only_access",
        message: "Write operations are forbidden (access level: read-only)"
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    if ((access === "data-only" || access === "read-write") && pathname === "/v1/schema/migrate") {
      return new Response(JSON.stringify({
        error: "forbidden",
        code: "schema_modifications_forbidden",
        message: "Schema modifications are forbidden (access level: data-only). Data operations are permitted, but table alterations require 'malleable' access."
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/v1/schema" && method === "GET") {
      const meta = Object.fromEntries([...this.sql.exec("SELECT key, value FROM _cell_meta")].map(r => [r.key, r.value]));
      const migrations = [...this.sql.exec("SELECT id, applied_at, description FROM _cell_migrations ORDER BY applied_at ASC")];
      const tables = [...this.sql.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")];
      return new Response(JSON.stringify({ cellVersion: this._getCellVersion(), meta, migrations, tables }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }

    if (pathname === "/v1/schema/migrate" && method === "POST") {
      const { migrationId, sql, description } = await request.json();
      if (!migrationId || !sql) {
        return new Response(JSON.stringify({ error: "bad_request", message: "migrationId and sql are required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      const existing = [...this.sql.exec("SELECT id FROM _cell_migrations WHERE id = ?", migrationId)];
      if (existing.length > 0) {
        return new Response(JSON.stringify({ ok: true, applied: false, message: "Migration already applied", migrationId, cellVersion: this._getCellVersion() }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      this.sql.exec(sql);
      const now = Date.now();
      this.sql.exec("INSERT INTO _cell_migrations (id, applied_at, description) VALUES (?, ?, ?)", migrationId, now, description || null);
      const newVersion = this._bumpCellVersion();
      return new Response(JSON.stringify({ ok: true, applied: true, migrationId, cellVersion: newVersion, appliedAt: now }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }

    const collectionListMatch = pathname.match(/^\/v1\/entities\/([^/]+)$/);
    if (collectionListMatch && method === "GET") {
      const [, collection] = collectionListMatch;
      const cursor = this.sql.exec(
        "SELECT id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? ORDER BY created_at ASC",
        collection
      );
      const entities = [...cursor].map(r => ({
        id: r.id,
        data: JSON.parse(r.data),
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
      return new Response(JSON.stringify({
        collection,
        entities,
        count: entities.length,
        cellVersion: this._getCellVersion()
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const entityMatch = pathname.match(/^\/v1\/entities\/([^/]+)\/([^/]+)$/);
    if (entityMatch) {
      const [, collection, id] = entityMatch;
      if (method === "GET") {
        const cursor = this.sql.exec("SELECT data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? AND id = ?", collection, id);
        const rows = [...cursor];
        if (rows.length === 0) {
          return new Response(JSON.stringify({ error: "not_found", collection, id, cellVersion: this._getCellVersion() }), {
            status: 404, headers: { "Content-Type": "application/json" }
          });
        }
        const row = rows[0];
        return new Response(JSON.stringify({
          collection, id, data: JSON.parse(row.data), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, cellVersion: this._getCellVersion()
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (method === "PUT") {
        const { data, expectedVersion } = await request.json();
        if (data === undefined) {
          return new Response(JSON.stringify({ error: "bad_request", message: "data is required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        const existing = [...this.sql.exec("SELECT version FROM _cell_entities WHERE collection = ? AND id = ?", collection, id)];
        const now = Date.now();
        if (existing.length === 0) {
          if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== 0) {
            return new Response(JSON.stringify({ error: "conflict", message: `Entity does not exist (expectedVersion=${expectedVersion})`, currentVersion: 0, cellVersion: this._getCellVersion() }), {
              status: 409, headers: { "Content-Type": "application/json" }
            });
          }
          this.sql.exec("INSERT INTO _cell_entities (collection, id, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)", collection, id, JSON.stringify(data), now, now);
          const newVersion = this._bumpCellVersion();
          return new Response(JSON.stringify({ ok: true, created: true, collection, id, version: 1, cellVersion: newVersion, updatedAt: now }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        } else {
          const currentVersion = existing[0].version;
          if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== currentVersion) {
            return new Response(JSON.stringify({ error: "conflict", message: `Version conflict: currentVersion is ${currentVersion}, expectedVersion was ${expectedVersion}`, currentVersion, cellVersion: this._getCellVersion() }), {
              status: 409, headers: { "Content-Type": "application/json" }
            });
          }
          const nextVersion = currentVersion + 1;
          this.sql.exec("UPDATE _cell_entities SET data = ?, version = ?, updated_at = ? WHERE collection = ? AND id = ?", JSON.stringify(data), nextVersion, now, collection, id);
          const newVersion = this._bumpCellVersion();
          return new Response(JSON.stringify({ ok: true, updated: true, collection, id, version: nextVersion, cellVersion: newVersion, updatedAt: now }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }
      }
    }

    if (pathname === "/v1/query" && method === "POST") {
      const { sql, params = [] } = await request.json();
      if (!sql) {
        return new Response(JSON.stringify({ error: "bad_request", message: "sql query is required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i.test(sql)) {
        return new Response(JSON.stringify({ error: "forbidden", message: "Only SELECT queries are permitted on /v1/query" }), {
          status: 403, headers: { "Content-Type": "application/json" }
        });
      }
      const cursor = this.sql.exec(sql, ...params);
      const rows = [...cursor];
      return new Response(JSON.stringify({ rows, count: rows.length, cellVersion: this._getCellVersion() }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }

    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    try {
      const genericResponse = await this._handleGenericRoutes(request, pathname, method);
      if (genericResponse) return genericResponse;

      return new Response(JSON.stringify({ error: "not_found", path: pathname }), {
        status: 404, headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "internal_error", message: err.message, stack: err.stack }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }
}

/**
 * SiteCell: Inherits BaseCell and adds site-wide editorial policy and backlog.
 */
export class SiteCell extends GenericCell {
  constructor(ctx, env) {
    super(ctx, env);
    this._initSiteTables();
  }

  _initSiteTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS site_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        policy_version INTEGER NOT NULL DEFAULT 1,
        tone TEXT NOT NULL,
        audience TEXT NOT NULL,
        pillars TEXT NOT NULL,
        safety_rules TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS topic_backlog (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        angle TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'proposed',
        article_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coverage_index (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        article_id TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        url TEXT
      );
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    try {
      const genericResponse = await this._handleGenericRoutes(request, pathname, method);
      if (genericResponse) return genericResponse;

      // GET/PUT /v1/policy
      if (pathname === "/v1/policy") {
        if (method === "GET") {
          const rows = [...this.sql.exec("SELECT policy_version, tone, audience, pillars, safety_rules, updated_at FROM site_policy WHERE id = 1")];
          if (rows.length === 0) {
            return new Response(JSON.stringify({
              policyVersion: 0,
              tone: "Authoritative, practical, data-driven endurance coaching",
              audience: "Cyclists, triathletes, and endurance runners",
              pillars: ["Physiology", "Training Methodology", "Recovery & Nutrition"],
              safetyRules: ["No unreferenced medical claims", "Preserve scientific nuance"],
              cellVersion: this._getCellVersion()
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          const row = rows[0];
          return new Response(JSON.stringify({
            policyVersion: row.policy_version,
            tone: row.tone,
            audience: row.audience,
            pillars: JSON.parse(row.pillars),
            safetyRules: JSON.parse(row.safety_rules),
            updatedAt: row.updated_at,
            cellVersion: this._getCellVersion()
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        if (method === "PUT") {
          const body = await request.json();
          const now = Date.now();
          const existing = [...this.sql.exec("SELECT policy_version FROM site_policy WHERE id = 1")];
          const nextPolicyVersion = existing.length > 0 ? existing[0].policy_version + 1 : 1;
          this.sql.exec(`
            INSERT INTO site_policy (id, policy_version, tone, audience, pillars, safety_rules, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              policy_version = excluded.policy_version,
              tone = excluded.tone,
              audience = excluded.audience,
              pillars = excluded.pillars,
              safety_rules = excluded.safety_rules,
              updated_at = excluded.updated_at
          `, nextPolicyVersion, body.tone || "", body.audience || "", JSON.stringify(body.pillars || []), JSON.stringify(body.safetyRules || []), now);
          const cellVer = this._bumpCellVersion();
          return new Response(JSON.stringify({ ok: true, policyVersion: nextPolicyVersion, cellVersion: cellVer }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }
      }

      // GET /v1/snapshot
      if (pathname === "/v1/snapshot" && method === "GET") {
        const policyRows = [...this.sql.exec("SELECT policy_version, tone, audience, pillars, safety_rules FROM site_policy WHERE id = 1")];
        const policy = policyRows.length > 0 ? {
          policyVersion: policyRows[0].policy_version,
          tone: policyRows[0].tone,
          audience: policyRows[0].audience,
          pillars: JSON.parse(policyRows[0].pillars),
          safetyRules: JSON.parse(policyRows[0].safety_rules)
        } : {
          policyVersion: 1,
          tone: "Authoritative, data-driven endurance coaching",
          audience: "Cyclists and endurance athletes",
          pillars: ["Physiology", "Training Methodology", "Recovery"],
          safetyRules: ["No unreferenced claims"]
        };

        const coverage = [...this.sql.exec("SELECT slug, title, published_at FROM coverage_index ORDER BY published_at DESC LIMIT 30")];
        const openTopics = [...this.sql.exec("SELECT id, title, slug, status, priority FROM topic_backlog WHERE status != 'published' ORDER BY priority DESC LIMIT 50")];

        return new Response(JSON.stringify({
          cellVersion: this._getCellVersion(),
          policy,
          recentCoverage: coverage,
          openTopics
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // POST /v1/topics/propose
      if (pathname === "/v1/topics/propose" && method === "POST") {
        const { candidates = [] } = await request.json();
        const now = Date.now();
        const createdTopics = [];

        for (const cand of candidates) {
          const id = cand.id || `topic-${crypto.randomBytes(4).toString("hex")}`;
          this.sql.exec(`
            INSERT INTO topic_backlog (id, title, slug, angle, priority, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              slug = excluded.slug,
              angle = excluded.angle,
              priority = excluded.priority,
              updated_at = excluded.updated_at
          `, id, cand.title, cand.slug, cand.angle || "", cand.priority || 5, now, now);
          createdTopics.push(id);
        }

        const cellVer = this._bumpCellVersion();
        return new Response(JSON.stringify({ ok: true, createdCount: createdTopics.length, topicIds: createdTopics, cellVersion: cellVer }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // POST /v1/articles/create
      if (pathname === "/v1/articles/create" && method === "POST") {
        const { topicId, articleId } = await request.json();
        const now = Date.now();
        this.sql.exec("UPDATE topic_backlog SET status = 'in_progress', article_id = ?, updated_at = ? WHERE id = ?", articleId, now, topicId);
        const cellVer = this._bumpCellVersion();
        return new Response(JSON.stringify({ ok: true, topicId, articleId, cellVersion: cellVer }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // GET /v1/topics
      if (pathname === "/v1/topics" && method === "GET") {
        const status = url.searchParams.get("status");
        let query = "SELECT id, title, slug, angle, priority, status, article_id, created_at, updated_at FROM topic_backlog";
        const params = [];
        if (status) {
          query += " WHERE status = ?";
          params.push(status);
        }
        query += " ORDER BY priority DESC, created_at DESC";
        const topics = [...this.sql.exec(query, ...params)];
        return new Response(JSON.stringify({ topics, count: topics.length, cellVersion: this._getCellVersion() }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ error: "not_found", path: pathname }), {
        status: 404, headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "internal_error", message: err.message, stack: err.stack }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }
}

/**
 * ArticleCell: Inherits BaseCell and adds single-article lifecycle methods.
 */
export class ArticleCell extends GenericCell {
  constructor(ctx, env) {
    super(ctx, env);
    this._initArticleTables();
  }

  _initArticleTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_brief (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        target_audience TEXT,
        intent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        relevance_score REAL NOT NULL,
        claims TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_revisions (
        hash TEXT PRIMARY KEY,
        revision_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_reviews (
        id TEXT PRIMARY KEY,
        revision_hash TEXT NOT NULL,
        verdict TEXT NOT NULL,
        score REAL NOT NULL,
        findings TEXT NOT NULL,
        instructions TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_approvals (
        revision_hash TEXT PRIMARY KEY,
        approved_by TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        reason TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_receipts (
        id TEXT PRIMARY KEY,
        cms_post_id TEXT NOT NULL,
        cms_url TEXT NOT NULL,
        cms_status TEXT NOT NULL,
        revision_hash TEXT NOT NULL,
        published_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    try {
      const genericResponse = await this._handleGenericRoutes(request, pathname, method);
      if (genericResponse) return genericResponse;

      // GET /v1/state
      if (pathname === "/v1/state" && method === "GET") {
        const meta = Object.fromEntries([...this.sql.exec("SELECT key, value FROM _cell_meta")].map(r => [r.key, r.value]));
        const briefRows = [...this.sql.exec("SELECT title, slug, target_audience, intent FROM article_brief WHERE id = 1")];
        const brief = briefRows.length > 0 ? {
          title: briefRows[0].title,
          slug: briefRows[0].slug,
          targetAudience: briefRows[0].target_audience,
          intent: briefRows[0].intent
        } : null;

        const sources = [...this.sql.exec("SELECT id, title, url, relevance_score, claims, created_at FROM article_sources ORDER BY relevance_score DESC")].map(s => ({
          ...s, claims: JSON.parse(s.claims)
        }));

        const latestRevisionRows = [...this.sql.exec("SELECT hash, revision_number, title, body, word_count, created_at FROM article_revisions ORDER BY revision_number DESC LIMIT 1")];
        const latestRevision = latestRevisionRows.length > 0 ? latestRevisionRows[0] : null;

        const latestReviewRows = [...this.sql.exec("SELECT id, revision_hash, verdict, score, findings, instructions, created_at FROM article_reviews ORDER BY created_at DESC LIMIT 1")];
        const latestReview = latestReviewRows.length > 0 ? {
          ...latestReviewRows[0], findings: JSON.parse(latestReviewRows[0].findings)
        } : null;

        const approvalRows = [...this.sql.exec("SELECT revision_hash, approved_by, approved_at, reason FROM article_approvals LIMIT 1")];
        const approval = approvalRows.length > 0 ? approvalRows[0] : null;

        const receiptRows = [...this.sql.exec("SELECT id, cms_post_id, cms_url, cms_status, revision_hash, published_at FROM article_receipts LIMIT 1")];
        const receipt = receiptRows.length > 0 ? receiptRows[0] : null;

        return new Response(JSON.stringify({
          cellVersion: this._getCellVersion(),
          state: meta.state || "initialized",
          brief,
          sourcesCount: sources.length,
          sources,
          latestRevision,
          latestReview,
          approval,
          receipt
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // GET/PUT /v1/brief
      if (pathname === "/v1/brief") {
        if (method === "GET") {
          const rows = [...this.sql.exec("SELECT title, slug, target_audience, intent, created_at, updated_at FROM article_brief WHERE id = 1")];
          if (rows.length === 0) {
            return new Response(JSON.stringify({ error: "not_found", message: "Brief not set" }), {
              status: 404, headers: { "Content-Type": "application/json" }
            });
          }
          return new Response(JSON.stringify({ ...rows[0], cellVersion: this._getCellVersion() }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }

        if (method === "PUT") {
          const body = await request.json();
          const now = Date.now();
          this.sql.exec(`
            INSERT INTO article_brief (id, title, slug, target_audience, intent, created_at, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              slug = excluded.slug,
              target_audience = excluded.target_audience,
              intent = excluded.intent,
              updated_at = excluded.updated_at
          `, body.title, body.slug, body.targetAudience || "", body.intent || "", now, now);
          const cellVer = this._bumpCellVersion("briefed");
          return new Response(JSON.stringify({ ok: true, cellVersion: cellVer, state: "briefed" }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }
      }

      // POST /v1/sources
      if (pathname === "/v1/sources" && method === "POST") {
        const { sources = [] } = await request.json();
        const now = Date.now();
        for (const s of sources) {
          const id = s.id || `src-${crypto.randomBytes(4).toString("hex")}`;
          this.sql.exec(`
            INSERT INTO article_sources (id, title, url, relevance_score, claims, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              url = excluded.url,
              relevance_score = excluded.relevance_score,
              claims = excluded.claims
          `, id, s.title, s.url, s.relevanceScore || 1.0, JSON.stringify(s.claims || []), now);
        }
        const cellVer = this._bumpCellVersion("researched");
        return new Response(JSON.stringify({ ok: true, addedCount: sources.length, cellVersion: cellVer, state: "researched" }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // POST /v1/revisions
      if (pathname === "/v1/revisions" && method === "POST") {
        const { title, body, revisionNumber } = await request.json();
        if (!title || !body) {
          return new Response(JSON.stringify({ error: "bad_request", message: "title and body are required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
        const wordCount = body.trim().split(/\s+/).length;
        const now = Date.now();
        const revNum = revisionNumber || (([...this.sql.exec("SELECT MAX(revision_number) as max_rev FROM article_revisions")][0]?.max_rev || 0) + 1);

        this.sql.exec(`
          INSERT INTO article_revisions (hash, revision_number, title, body, word_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(hash) DO NOTHING
        `, hash, revNum, title, body, wordCount, now);

        const cellVer = this._bumpCellVersion("drafted");
        return new Response(JSON.stringify({ ok: true, revisionHash: hash, revisionNumber: revNum, wordCount, cellVersion: cellVer, state: "drafted" }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // GET /v1/revisions/latest
      if (pathname === "/v1/revisions/latest" && method === "GET") {
        const rows = [...this.sql.exec("SELECT hash, revision_number, title, body, word_count, created_at FROM article_revisions ORDER BY revision_number DESC LIMIT 1")];
        if (rows.length === 0) {
          return new Response(JSON.stringify({ error: "not_found", message: "No revisions found" }), {
            status: 404, headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ ...rows[0], cellVersion: this._getCellVersion() }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // POST /v1/reviews
      if (pathname === "/v1/reviews" && method === "POST") {
        const { revisionHash, verdict, score, findings, instructions } = await request.json();
        if (!revisionHash || !verdict) {
          return new Response(JSON.stringify({ error: "bad_request", message: "revisionHash and verdict are required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        const reviewId = `rev-${crypto.randomBytes(4).toString("hex")}`;
        const now = Date.now();
        this.sql.exec(`
          INSERT INTO article_reviews (id, revision_hash, verdict, score, findings, instructions, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, reviewId, revisionHash, verdict, score || 1.0, JSON.stringify(findings || []), instructions || "", now);

        const nextState = verdict === "APPROVE" ? "reviewed" : "needs_revision";
        const cellVer = this._bumpCellVersion(nextState);
        return new Response(JSON.stringify({ ok: true, reviewId, verdict, score, cellVersion: cellVer, state: nextState }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // POST /v1/approvals
      if (pathname === "/v1/approvals" && method === "POST") {
        const { revisionHash, approvedBy, reason } = await request.json();
        if (!revisionHash || !approvedBy) {
          return new Response(JSON.stringify({ error: "bad_request", message: "revisionHash and approvedBy are required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        const now = Date.now();
        this.sql.exec(`
          INSERT INTO article_approvals (revision_hash, approved_by, approved_at, reason)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(revision_hash) DO UPDATE SET
            approved_by = excluded.approved_by,
            approved_at = excluded.approved_at,
            reason = excluded.reason
        `, revisionHash, approvedBy, now, reason || "Approved for CMS publication");

        const cellVer = this._bumpCellVersion("approved");
        return new Response(JSON.stringify({ ok: true, revisionHash, approvedBy, cellVersion: cellVer, state: "approved" }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      // POST /v1/publication-receipt
      if (pathname === "/v1/publication-receipt" && method === "POST") {
        const { cmsPostId, cmsUrl, cmsStatus, revisionHash } = await request.json();
        const receiptId = `rcpt-${crypto.randomBytes(4).toString("hex")}`;
        const now = Date.now();
        this.sql.exec(`
          INSERT INTO article_receipts (id, cms_post_id, cms_url, cms_status, revision_hash, published_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, receiptId, cmsPostId, cmsUrl, cmsStatus || "draft", revisionHash, now);

        const cellVer = this._bumpCellVersion("published");
        return new Response(JSON.stringify({ ok: true, receiptId, cmsPostId, cmsUrl, cellVersion: cellVer, state: "published" }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ error: "not_found", path: pathname }), {
        status: 404, headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "internal_error", message: err.message, stack: err.stack }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }
}

/**
 * Main Worker Router
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "healthy",
        service: "factory-cells",
        supportedCells: ["GenericCell", "SiteCell", "ArticleCell"]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
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
      return new Response(JSON.stringify({
        error: "missing_cell_id",
        message: "Request must specify X-Cell-Id header or /cells/:cellId/ path"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Dynamic Binding Selection
    let targetBinding = env.GENERIC_CELL;
    const cellTypeHeader = request.headers.get("X-Cell-Type");
    if (cellTypeHeader === "site" || cellId.startsWith("site:")) {
      targetBinding = env.SITE_CELL || env.GENERIC_CELL;
    } else if (cellTypeHeader === "article" || cellId.startsWith("article:")) {
      targetBinding = env.ARTICLE_CELL || env.GENERIC_CELL;
    } else if (cellTypeHeader === "generic" || cellId.startsWith("generic:")) {
      targetBinding = env.GENERIC_CELL;
    }

    if (!targetBinding) {
      return new Response(JSON.stringify({
        error: "binding_not_found",
        message: "Target Durable Object binding is not configured"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const doId = targetBinding.idFromName(cellId);
    const stub = targetBinding.get(doId);

    const forwardRequest = new Request(forwardUrl.toString(), request);
    return stub.fetch(forwardRequest);
  }
};

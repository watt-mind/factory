import { Database } from "bun:sqlite";
import crypto from "node:crypto";

/**
 * Creates an in-memory fetch function simulating celld & Workers.
 * Zero child processes, zero network requests, zero port bindings.
 */
export function createMockCellFetch() {
  const cellStorage = new Map();

  function getSql(cellId) {
    if (!cellStorage.has(cellId)) {
      const db = new Database(":memory:");
      // Initialize Base / Generic Tables
      db.run(`
        CREATE TABLE IF NOT EXISTS _cell_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS _cell_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
        CREATE TABLE IF NOT EXISTS _cell_entities (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (collection, id));
        CREATE TABLE IF NOT EXISTS site_policy (id INTEGER PRIMARY KEY CHECK (id = 1), policy_version INTEGER NOT NULL DEFAULT 1, tone TEXT NOT NULL, audience TEXT NOT NULL, pillars TEXT NOT NULL, safety_rules TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS topic_backlog (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, angle TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'proposed', article_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS coverage_index (slug TEXT PRIMARY KEY, title TEXT NOT NULL, article_id TEXT NOT NULL, published_at INTEGER NOT NULL, url TEXT);
        CREATE TABLE IF NOT EXISTS article_brief (id INTEGER PRIMARY KEY CHECK (id = 1), title TEXT NOT NULL, slug TEXT NOT NULL, target_audience TEXT, intent TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS article_sources (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, relevance_score REAL NOT NULL, claims TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS article_revisions (hash TEXT PRIMARY KEY, revision_number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, word_count INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS article_reviews (id TEXT PRIMARY KEY, revision_hash TEXT NOT NULL, verdict TEXT NOT NULL, score REAL NOT NULL, findings TEXT NOT NULL, instructions TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS article_approvals (revision_hash TEXT PRIMARY KEY, approved_by TEXT NOT NULL, approved_at INTEGER NOT NULL, reason TEXT);
        CREATE TABLE IF NOT EXISTS article_receipts (id TEXT PRIMARY KEY, cms_post_id TEXT NOT NULL, cms_url TEXT NOT NULL, cms_status TEXT NOT NULL, revision_hash TEXT NOT NULL, published_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, val_type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER);
      `);
      db.run("INSERT INTO _cell_meta (key, value) VALUES ('version', '1')");
      db.run("INSERT INTO _cell_meta (key, value) VALUES ('created_at', ?)", [
        Date.now().toString(),
      ]);
      cellStorage.set(cellId, db);
    }
    return cellStorage.get(cellId);
  }

  function getCellVersion(db) {
    const row = db
      .query("SELECT value FROM _cell_meta WHERE key = 'version'")
      .get();
    return row ? parseInt(row.value, 10) : 1;
  }

  function bumpCellVersion(db, nextState = null) {
    const next = getCellVersion(db) + 1;
    db.run("UPDATE _cell_meta SET value = ? WHERE key = 'version'", [
      next.toString(),
    ]);
    if (nextState) {
      db.run(
        "INSERT INTO _cell_meta (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [nextState],
      );
    }
    return next;
  }

  return async function mockFetch(urlStr, options = {}) {
    const url = new URL(urlStr);
    const method = (options.method || "GET").toUpperCase();
    const pathname = url.pathname;
    let body = null;
    if (options.body) {
      body =
        typeof options.body === "string"
          ? JSON.parse(options.body)
          : options.body;
    }

    if (pathname === "/health" || pathname === "/") {
      return new Response(JSON.stringify({ status: "healthy", mock: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let cellId =
      options.headers?.["X-Cell-Id"] || options.headers?.["x-cell-id"];
    let subPath = pathname;
    const cellsMatch = pathname.match(/^\/cells\/([^/]+)(\/.*)?$/);
    if (cellsMatch) {
      cellId = decodeURIComponent(cellsMatch[1]);
      subPath = cellsMatch[2] || "/";
    }

    if (!cellId) {
      return new Response(JSON.stringify({ error: "missing_cell_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const db = getSql(cellId);
    const access =
      options.headers?.["X-Cell-Access"] ||
      options.headers?.["x-cell-access"] ||
      "malleable";

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
      subPath === "/v1/schema/migrate"
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

    // 1. GET /v1/schema
    if (subPath === "/v1/schema" && method === "GET") {
      const meta = Object.fromEntries(
        db
          .query("SELECT key, value FROM _cell_meta")
          .all()
          .map((r) => [r.key, r.value]),
      );
      const migrations = db
        .query(
          "SELECT id, applied_at, description FROM _cell_migrations ORDER BY applied_at ASC",
        )
        .all();
      const tables = db
        .query(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      return new Response(
        JSON.stringify({
          cellVersion: getCellVersion(db),
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

    // 2. POST /v1/schema/migrate
    if (subPath === "/v1/schema/migrate" && method === "POST") {
      const { migrationId, sql, description } = body;
      const existing = db
        .query("SELECT id FROM _cell_migrations WHERE id = ?")
        .get(migrationId);
      if (existing) {
        return new Response(
          JSON.stringify({
            ok: true,
            applied: false,
            migrationId,
            cellVersion: getCellVersion(db),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      db.run(sql);
      const now = Date.now();
      db.run(
        "INSERT INTO _cell_migrations (id, applied_at, description) VALUES (?, ?, ?)",
        [migrationId, now, description || null],
      );
      const newVer = bumpCellVersion(db);
      return new Response(
        JSON.stringify({
          ok: true,
          applied: true,
          migrationId,
          cellVersion: newVer,
          appliedAt: now,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 3. GET /v1/entities/:collection
    const collectionListMatch = subPath.match(/^\/v1\/entities\/([^/]+)$/);
    if (collectionListMatch && method === "GET") {
      const [, collection] = collectionListMatch;
      const entities = db
        .query(
          "SELECT id, data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? ORDER BY created_at ASC",
        )
        .all(collection)
        .map((r) => ({
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
          cellVersion: getCellVersion(db),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 4. GET/PUT /v1/entities/:collection/:id
    const entityMatch = subPath.match(/^\/v1\/entities\/([^/]+)\/([^/]+)$/);
    if (entityMatch) {
      const [, collection, id] = entityMatch;
      if (method === "GET") {
        const row = db
          .query(
            "SELECT data, version, created_at, updated_at FROM _cell_entities WHERE collection = ? AND id = ?",
          )
          .get(collection, id);
        if (!row) {
          return new Response(
            JSON.stringify({
              error: "not_found",
              collection,
              id,
              cellVersion: getCellVersion(db),
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            collection,
            id,
            data: JSON.parse(row.data),
            version: row.version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            cellVersion: getCellVersion(db),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (method === "PUT") {
        const { data, expectedVersion } = body;
        const existing = db
          .query(
            "SELECT version FROM _cell_entities WHERE collection = ? AND id = ?",
          )
          .get(collection, id);
        const now = Date.now();
        if (!existing) {
          if (
            expectedVersion !== undefined &&
            expectedVersion !== null &&
            expectedVersion !== 0
          ) {
            return new Response(
              JSON.stringify({
                error: "conflict",
                message: `expectedVersion was ${expectedVersion}`,
                currentVersion: 0,
                cellVersion: getCellVersion(db),
              }),
              {
                status: 409,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          db.run(
            "INSERT INTO _cell_entities (collection, id, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
            [collection, id, JSON.stringify(data), now, now],
          );
          const newVer = bumpCellVersion(db);
          return new Response(
            JSON.stringify({
              ok: true,
              created: true,
              collection,
              id,
              version: 1,
              cellVersion: newVer,
              updatedAt: now,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } else {
          const currentVersion = existing.version;
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
                cellVersion: getCellVersion(db),
              }),
              {
                status: 409,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          const nextVersion = currentVersion + 1;
          db.run(
            "UPDATE _cell_entities SET data = ?, version = ?, updated_at = ? WHERE collection = ? AND id = ?",
            [JSON.stringify(data), nextVersion, now, collection, id],
          );
          const newVer = bumpCellVersion(db);
          return new Response(
            JSON.stringify({
              ok: true,
              updated: true,
              collection,
              id,
              version: nextVersion,
              cellVersion: newVer,
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

    // 5. Site Policy / Snapshot / Topics
    if (subPath === "/v1/policy") {
      if (method === "GET") {
        const row = db
          .query(
            "SELECT policy_version, tone, audience, pillars, safety_rules, updated_at FROM site_policy WHERE id = 1",
          )
          .get();
        if (!row) {
          return new Response(
            JSON.stringify({
              policyVersion: 0,
              pillars: [],
              safetyRules: [],
              cellVersion: getCellVersion(db),
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            policyVersion: row.policy_version,
            tone: row.tone,
            audience: row.audience,
            pillars: JSON.parse(row.pillars),
            safetyRules: JSON.parse(row.safety_rules),
            updatedAt: row.updated_at,
            cellVersion: getCellVersion(db),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "PUT") {
        const now = Date.now();
        const existing = db
          .query("SELECT policy_version FROM site_policy WHERE id = 1")
          .get();
        const nextPolicyVersion = existing ? existing.policy_version + 1 : 1;
        db.run(
          `
          INSERT INTO site_policy (id, policy_version, tone, audience, pillars, safety_rules, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET policy_version = excluded.policy_version, tone = excluded.tone, audience = excluded.audience, pillars = excluded.pillars, safety_rules = excluded.safety_rules, updated_at = excluded.updated_at
        `,
          [
            nextPolicyVersion,
            body.tone || "",
            body.audience || "",
            JSON.stringify(body.pillars || []),
            JSON.stringify(body.safetyRules || []),
            now,
          ],
        );
        const cellVer = bumpCellVersion(db);
        return new Response(
          JSON.stringify({
            ok: true,
            policyVersion: nextPolicyVersion,
            cellVersion: cellVer,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (subPath === "/v1/snapshot" && method === "GET") {
      const policyRow = db
        .query(
          "SELECT policy_version, tone, audience, pillars, safety_rules FROM site_policy WHERE id = 1",
        )
        .get();
      const policy = policyRow
        ? {
            policyVersion: policyRow.policy_version,
            tone: policyRow.tone,
            audience: policyRow.audience,
            pillars: JSON.parse(policyRow.pillars),
            safetyRules: JSON.parse(policyRow.safety_rules),
          }
        : { policyVersion: 1, pillars: [], safetyRules: [] };
      const recentCoverage = db
        .query(
          "SELECT slug, title, published_at FROM coverage_index ORDER BY published_at DESC LIMIT 30",
        )
        .all();
      const openTopics = db
        .query(
          "SELECT id, title, slug, status, priority FROM topic_backlog WHERE status != 'published' ORDER BY priority DESC LIMIT 50",
        )
        .all();
      return new Response(
        JSON.stringify({
          cellVersion: getCellVersion(db),
          policy,
          recentCoverage,
          openTopics,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (subPath === "/v1/topics/propose" && method === "POST") {
      const { candidates = [] } = body;
      const now = Date.now();
      const createdTopics = [];
      for (const cand of candidates) {
        const id = cand.id || `topic-${crypto.randomBytes(4).toString("hex")}`;
        db.run(
          `
          INSERT INTO topic_backlog (id, title, slug, angle, priority, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, slug = excluded.slug, angle = excluded.angle, priority = excluded.priority, updated_at = excluded.updated_at
        `,
          [
            id,
            cand.title,
            cand.slug,
            cand.angle || "",
            cand.priority || 5,
            now,
            now,
          ],
        );
        createdTopics.push(id);
      }
      const cellVer = bumpCellVersion(db);
      return new Response(
        JSON.stringify({
          ok: true,
          createdCount: createdTopics.length,
          topicIds: createdTopics,
          cellVersion: cellVer,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (subPath === "/v1/articles/create" && method === "POST") {
      const { topicId, articleId } = body;
      const now = Date.now();
      db.run(
        "UPDATE topic_backlog SET status = 'in_progress', article_id = ?, updated_at = ? WHERE id = ?",
        [articleId, now, topicId],
      );
      const cellVer = bumpCellVersion(db);
      return new Response(
        JSON.stringify({ ok: true, topicId, articleId, cellVersion: cellVer }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (subPath === "/v1/topics" && method === "GET") {
      const statusParam = url.searchParams.get("status");
      let query =
        "SELECT id, title, slug, angle, priority, status, article_id, created_at, updated_at FROM topic_backlog";
      const params = [];
      if (statusParam) {
        query += " WHERE status = ?";
        params.push(statusParam);
      }
      query += " ORDER BY priority DESC, created_at DESC";
      const topics = db.query(query).all(...params);
      return new Response(
        JSON.stringify({
          topics,
          count: topics.length,
          cellVersion: getCellVersion(db),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 6. Article Cell Endpoints
    if (subPath === "/v1/state" && method === "GET") {
      const meta = Object.fromEntries(
        db
          .query("SELECT key, value FROM _cell_meta")
          .all()
          .map((r) => [r.key, r.value]),
      );
      const briefRow = db
        .query(
          "SELECT title, slug, target_audience, intent FROM article_brief WHERE id = 1",
        )
        .get();
      const brief = briefRow
        ? {
            title: briefRow.title,
            slug: briefRow.slug,
            targetAudience: briefRow.target_audience,
            intent: briefRow.intent,
          }
        : null;
      const sources = db
        .query(
          "SELECT id, title, url, relevance_score, claims, created_at FROM article_sources ORDER BY relevance_score DESC",
        )
        .all()
        .map((s) => ({
          ...s,
          claims: JSON.parse(s.claims),
        }));
      const latestRevision =
        db
          .query(
            "SELECT hash, revision_number, title, body, word_count, created_at FROM article_revisions ORDER BY revision_number DESC LIMIT 1",
          )
          .get() || null;
      const latestReviewRow = db
        .query(
          "SELECT id, revision_hash, verdict, score, findings, instructions, created_at FROM article_reviews ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      const latestReview = latestReviewRow
        ? { ...latestReviewRow, findings: JSON.parse(latestReviewRow.findings) }
        : null;
      const approval =
        db
          .query(
            "SELECT revision_hash, approved_by, approved_at, reason FROM article_approvals LIMIT 1",
          )
          .get() || null;
      const receipt =
        db
          .query(
            "SELECT id, cms_post_id, cms_url, cms_status, revision_hash, published_at FROM article_receipts LIMIT 1",
          )
          .get() || null;

      return new Response(
        JSON.stringify({
          cellVersion: getCellVersion(db),
          state: meta.state || "initialized",
          brief,
          sourcesCount: sources.length,
          sources,
          latestRevision,
          latestReview,
          approval,
          receipt,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (subPath === "/v1/brief") {
      if (method === "GET") {
        const row = db
          .query(
            "SELECT title, slug, target_audience, intent, created_at, updated_at FROM article_brief WHERE id = 1",
          )
          .get();
        if (!row)
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        return new Response(
          JSON.stringify({ ...row, cellVersion: getCellVersion(db) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "PUT") {
        const now = Date.now();
        db.run(
          `
          INSERT INTO article_brief (id, title, slug, target_audience, intent, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, slug = excluded.slug, target_audience = excluded.target_audience, intent = excluded.intent, updated_at = excluded.updated_at
        `,
          [
            body.title,
            body.slug,
            body.targetAudience || "",
            body.intent || "",
            now,
            now,
          ],
        );
        const cellVer = bumpCellVersion(db, "briefed");
        return new Response(
          JSON.stringify({ ok: true, cellVersion: cellVer, state: "briefed" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (subPath === "/v1/sources" && method === "POST") {
      const { sources = [] } = body;
      const now = Date.now();
      for (const s of sources) {
        const id = s.id || `src-${crypto.randomBytes(4).toString("hex")}`;
        db.run(
          `
          INSERT INTO article_sources (id, title, url, relevance_score, claims, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url, relevance_score = excluded.relevance_score, claims = excluded.claims
        `,
          [
            id,
            s.title,
            s.url,
            s.relevanceScore || 1.0,
            JSON.stringify(s.claims || []),
            now,
          ],
        );
      }
      const cellVer = bumpCellVersion(db, "researched");
      return new Response(
        JSON.stringify({
          ok: true,
          addedCount: sources.length,
          cellVersion: cellVer,
          state: "researched",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (subPath === "/v1/revisions" && method === "POST") {
      const { title, body: draftBody, revisionNumber } = body;
      const hash = crypto
        .createHash("sha256")
        .update(draftBody)
        .digest("hex")
        .slice(0, 16);
      const wordCount = draftBody.trim().split(/\s+/).length;
      const now = Date.now();
      const revNum =
        revisionNumber ||
        (db
          .query(
            "SELECT MAX(revision_number) as max_rev FROM article_revisions",
          )
          .get()?.max_rev || 0) + 1;
      db.run(
        "INSERT INTO article_revisions (hash, revision_number, title, body, word_count, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING",
        [hash, revNum, title, draftBody, wordCount, now],
      );
      const cellVer = bumpCellVersion(db, "drafted");
      return new Response(
        JSON.stringify({
          ok: true,
          revisionHash: hash,
          revisionNumber: revNum,
          wordCount,
          cellVersion: cellVer,
          state: "drafted",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (subPath === "/v1/revisions/latest" && method === "GET") {
      const row = db
        .query(
          "SELECT hash, revision_number, title, body, word_count, created_at FROM article_revisions ORDER BY revision_number DESC LIMIT 1",
        )
        .get();
      if (!row)
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      return new Response(
        JSON.stringify({ ...row, cellVersion: getCellVersion(db) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (subPath === "/v1/reviews" && method === "POST") {
      const { revisionHash, verdict, score, findings, instructions } = body;
      const reviewId = `rev-${crypto.randomBytes(4).toString("hex")}`;
      const now = Date.now();
      db.run(
        "INSERT INTO article_reviews (id, revision_hash, verdict, score, findings, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          reviewId,
          revisionHash,
          verdict,
          score || 1.0,
          JSON.stringify(findings || []),
          instructions || "",
          now,
        ],
      );
      const nextState = verdict === "APPROVE" ? "reviewed" : "needs_revision";
      const cellVer = bumpCellVersion(db, nextState);
      return new Response(
        JSON.stringify({
          ok: true,
          reviewId,
          verdict,
          score,
          cellVersion: cellVer,
          state: nextState,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (subPath === "/v1/approvals" && method === "POST") {
      const { revisionHash, approvedBy, reason } = body;
      const now = Date.now();
      db.run(
        "INSERT INTO article_approvals (revision_hash, approved_by, approved_at, reason) VALUES (?, ?, ?, ?) ON CONFLICT(revision_hash) DO UPDATE SET approved_by = excluded.approved_by, approved_at = excluded.approved_at, reason = excluded.reason",
        [revisionHash, approvedBy, now, reason || "Approved"],
      );
      const cellVer = bumpCellVersion(db, "approved");
      return new Response(
        JSON.stringify({
          ok: true,
          revisionHash,
          approvedBy,
          cellVersion: cellVer,
          state: "approved",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (subPath === "/v1/publication-receipt" && method === "POST") {
      const { cmsPostId, cmsUrl, cmsStatus, revisionHash } = body;
      const receiptId = `rcpt-${crypto.randomBytes(4).toString("hex")}`;
      const now = Date.now();
      db.run(
        "INSERT INTO article_receipts (id, cms_post_id, cms_url, cms_status, revision_hash, published_at) VALUES (?, ?, ?, ?, ?, ?)",
        [receiptId, cmsPostId, cmsUrl, cmsStatus || "draft", revisionHash, now],
      );
      const cellVer = bumpCellVersion(db, "published");
      return new Response(
        JSON.stringify({
          ok: true,
          receiptId,
          cmsPostId,
          cmsUrl,
          cellVersion: cellVer,
          state: "published",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // 7. Read-only SQL Query
    if (subPath === "/v1/query" && method === "POST") {
      const { sql, params = [] } = body;
      if (/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i.test(sql)) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      const rows = db.query(sql).all(...params);
      return new Response(
        JSON.stringify({
          rows,
          count: rows.length,
          cellVersion: getCellVersion(db),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ error: "not_found", path: subPath }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

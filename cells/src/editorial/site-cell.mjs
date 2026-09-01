import crypto from "node:crypto";
import { GenericCell } from "../base/generic-cell.mjs";

/**
 * SiteCell: Manages site-wide editorial policy, topic backlog, and coverage index.
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
      const genericResponse = await this._handleGenericRoutes(
        request,
        pathname,
        method,
      );
      if (genericResponse) return genericResponse;

      // GET/PUT /v1/policy
      if (pathname === "/v1/policy") {
        if (method === "GET") {
          const rows = [
            ...this.sql.exec(
              "SELECT policy_version, tone, audience, pillars, safety_rules, updated_at FROM site_policy WHERE id = 1",
            ),
          ];
          if (rows.length === 0) {
            return new Response(
              JSON.stringify({
                policyVersion: 0,
                tone: "Authoritative, practical, data-driven endurance coaching",
                audience: "Cyclists, triathletes, and endurance runners",
                pillars: [
                  "Physiology",
                  "Training Methodology",
                  "Recovery & Nutrition",
                ],
                safetyRules: [
                  "No unreferenced medical claims",
                  "Preserve scientific nuance",
                ],
                cellVersion: this._getCellVersion(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          const row = rows[0];
          return new Response(
            JSON.stringify({
              policyVersion: row.policy_version,
              tone: row.tone,
              audience: row.audience,
              pillars: JSON.parse(row.pillars),
              safetyRules: JSON.parse(row.safety_rules),
              updatedAt: row.updated_at,
              cellVersion: this._getCellVersion(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (method === "PUT") {
          const body = await request.json();
          const now = Date.now();
          const existing = [
            ...this.sql.exec(
              "SELECT policy_version FROM site_policy WHERE id = 1",
            ),
          ];
          const nextPolicyVersion =
            existing.length > 0 ? existing[0].policy_version + 1 : 1;
          this.sql.exec(
            `
            INSERT INTO site_policy (id, policy_version, tone, audience, pillars, safety_rules, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              policy_version = excluded.policy_version,
              tone = excluded.tone,
              audience = excluded.audience,
              pillars = excluded.pillars,
              safety_rules = excluded.safety_rules,
              updated_at = excluded.updated_at
          `,
            nextPolicyVersion,
            body.tone || "",
            body.audience || "",
            JSON.stringify(body.pillars || []),
            JSON.stringify(body.safetyRules || []),
            now,
          );
          const cellVer = this._bumpCellVersion();
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

      // GET /v1/snapshot
      if (pathname === "/v1/snapshot" && method === "GET") {
        const policyRows = [
          ...this.sql.exec(
            "SELECT policy_version, tone, audience, pillars, safety_rules FROM site_policy WHERE id = 1",
          ),
        ];
        const policy =
          policyRows.length > 0
            ? {
                policyVersion: policyRows[0].policy_version,
                tone: policyRows[0].tone,
                audience: policyRows[0].audience,
                pillars: JSON.parse(policyRows[0].pillars),
                safetyRules: JSON.parse(policyRows[0].safety_rules),
              }
            : {
                policyVersion: 1,
                tone: "Authoritative, data-driven endurance coaching",
                audience: "Cyclists and endurance athletes",
                pillars: ["Physiology", "Training Methodology", "Recovery"],
                safetyRules: ["No unreferenced claims"],
              };

        const coverage = [
          ...this.sql.exec(
            "SELECT slug, title, published_at FROM coverage_index ORDER BY published_at DESC LIMIT 30",
          ),
        ];
        const openTopics = [
          ...this.sql.exec(
            "SELECT id, title, slug, status, priority FROM topic_backlog WHERE status != 'published' ORDER BY priority DESC LIMIT 50",
          ),
        ];

        return new Response(
          JSON.stringify({
            cellVersion: this._getCellVersion(),
            policy,
            recentCoverage: coverage,
            openTopics,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // POST /v1/topics/propose
      if (pathname === "/v1/topics/propose" && method === "POST") {
        const { candidates = [] } = await request.json();
        const now = Date.now();
        const createdTopics = [];

        for (const cand of candidates) {
          const id =
            cand.id || `topic-${crypto.randomBytes(4).toString("hex")}`;
          this.sql.exec(
            `
            INSERT INTO topic_backlog (id, title, slug, angle, priority, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              slug = excluded.slug,
              angle = excluded.angle,
              priority = excluded.priority,
              updated_at = excluded.updated_at
          `,
            id,
            cand.title,
            cand.slug,
            cand.angle || "",
            cand.priority || 5,
            now,
            now,
          );
          createdTopics.push(id);
        }

        const cellVer = this._bumpCellVersion();
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

      // POST /v1/articles/create
      if (pathname === "/v1/articles/create" && method === "POST") {
        const { topicId, articleId } = await request.json();
        const now = Date.now();
        this.sql.exec(
          "UPDATE topic_backlog SET status = 'in_progress', article_id = ?, updated_at = ? WHERE id = ?",
          articleId,
          now,
          topicId,
        );
        const cellVer = this._bumpCellVersion();
        return new Response(
          JSON.stringify({
            ok: true,
            topicId,
            articleId,
            cellVersion: cellVer,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // GET /v1/topics
      if (pathname === "/v1/topics" && method === "GET") {
        const status = url.searchParams.get("status");
        let query =
          "SELECT id, title, slug, angle, priority, status, article_id, created_at, updated_at FROM topic_backlog";
        const params = [];
        if (status) {
          query += " WHERE status = ?";
          params.push(status);
        }
        query += " ORDER BY priority DESC, created_at DESC";
        const topics = [...this.sql.exec(query, ...params)];
        return new Response(
          JSON.stringify({
            topics,
            count: topics.length,
            cellVersion: this._getCellVersion(),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

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

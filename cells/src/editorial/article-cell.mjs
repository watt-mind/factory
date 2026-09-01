import crypto from "node:crypto";
import { GenericCell } from "../base/generic-cell.mjs";

/**
 * ArticleCell: Single-article lifecycle state machine and durability actor.
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

  _getState() {
    const rows = [
      ...this.sql.exec("SELECT value FROM _cell_meta WHERE key = 'state'"),
    ];
    return rows.length > 0 ? rows[0].value : "initialized";
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

      // GET /v1/state
      if (pathname === "/v1/state" && method === "GET") {
        const meta = Object.fromEntries(
          [...this.sql.exec("SELECT key, value FROM _cell_meta")].map((r) => [
            r.key,
            r.value,
          ]),
        );
        const briefRows = [
          ...this.sql.exec(
            "SELECT title, slug, target_audience, intent FROM article_brief WHERE id = 1",
          ),
        ];
        const brief =
          briefRows.length > 0
            ? {
                title: briefRows[0].title,
                slug: briefRows[0].slug,
                targetAudience: briefRows[0].target_audience,
                intent: briefRows[0].intent,
              }
            : null;

        const sources = [
          ...this.sql.exec(
            "SELECT id, title, url, relevance_score, claims, created_at FROM article_sources ORDER BY relevance_score DESC",
          ),
        ].map((s) => ({
          ...s,
          claims: JSON.parse(s.claims),
        }));

        const latestRevisionRows = [
          ...this.sql.exec(
            "SELECT hash, revision_number, title, body, word_count, created_at FROM article_revisions ORDER BY revision_number DESC LIMIT 1",
          ),
        ];
        const latestRevision =
          latestRevisionRows.length > 0 ? latestRevisionRows[0] : null;

        const latestReviewRows = [
          ...this.sql.exec(
            "SELECT id, revision_hash, verdict, score, findings, instructions, created_at FROM article_reviews ORDER BY created_at DESC LIMIT 1",
          ),
        ];
        const latestReview =
          latestReviewRows.length > 0
            ? {
                ...latestReviewRows[0],
                findings: JSON.parse(latestReviewRows[0].findings),
              }
            : null;

        const approvalRows = [
          ...this.sql.exec(
            "SELECT revision_hash, approved_by, approved_at, reason FROM article_approvals LIMIT 1",
          ),
        ];
        const approval = approvalRows.length > 0 ? approvalRows[0] : null;

        const receiptRows = [
          ...this.sql.exec(
            "SELECT id, cms_post_id, cms_url, cms_status, revision_hash, published_at FROM article_receipts LIMIT 1",
          ),
        ];
        const receipt = receiptRows.length > 0 ? receiptRows[0] : null;

        return new Response(
          JSON.stringify({
            cellVersion: this._getCellVersion(),
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

      // GET/PUT /v1/brief
      if (pathname === "/v1/brief") {
        if (method === "GET") {
          const rows = [
            ...this.sql.exec(
              "SELECT title, slug, target_audience, intent, created_at, updated_at FROM article_brief WHERE id = 1",
            ),
          ];
          if (rows.length === 0) {
            return new Response(
              JSON.stringify({ error: "not_found", message: "Brief not set" }),
              {
                status: 404,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          return new Response(
            JSON.stringify({ ...rows[0], cellVersion: this._getCellVersion() }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (method === "PUT") {
          const body = await request.json();
          const now = Date.now();
          this.sql.exec(
            `
            INSERT INTO article_brief (id, title, slug, target_audience, intent, created_at, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              slug = excluded.slug,
              target_audience = excluded.target_audience,
              intent = excluded.intent,
              updated_at = excluded.updated_at
          `,
            body.title,
            body.slug,
            body.targetAudience || "",
            body.intent || "",
            now,
            now,
          );
          const cellVer = this._bumpCellVersion("briefed");
          return new Response(
            JSON.stringify({
              ok: true,
              cellVersion: cellVer,
              state: "briefed",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      // POST /v1/sources
      if (pathname === "/v1/sources" && method === "POST") {
        const { sources = [] } = await request.json();
        const now = Date.now();
        for (const s of sources) {
          const id = s.id || `src-${crypto.randomBytes(4).toString("hex")}`;
          this.sql.exec(
            `
            INSERT INTO article_sources (id, title, url, relevance_score, claims, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              url = excluded.url,
              relevance_score = excluded.relevance_score,
              claims = excluded.claims
          `,
            id,
            s.title,
            s.url,
            s.relevanceScore || 1.0,
            JSON.stringify(s.claims || []),
            now,
          );
        }
        const cellVer = this._bumpCellVersion("researched");
        return new Response(
          JSON.stringify({
            ok: true,
            addedCount: sources.length,
            cellVersion: cellVer,
            state: "researched",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // POST /v1/revisions
      if (pathname === "/v1/revisions" && method === "POST") {
        const { title, body, revisionNumber } = await request.json();
        // A whitespace-only body is not a draft: it would otherwise hash fine
        // and be recorded with a word count of 1.
        if (
          typeof title !== "string" ||
          title.trim() === "" ||
          typeof body !== "string" ||
          body.trim() === ""
        ) {
          return new Response(
            JSON.stringify({
              error: "bad_request",
              message: "title and body are required and must be non-empty",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const hash = crypto
          .createHash("sha256")
          .update(body)
          .digest("hex")
          .slice(0, 16);
        const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
        const now = Date.now();

        // Revisions are immutable and content-addressed: an identical body is
        // the revision that already exists, not a new one. Report it as such
        // and leave the cell version alone so a replay is a true no-op.
        const existing = [
          ...this.sql.exec(
            "SELECT hash, revision_number, word_count FROM article_revisions WHERE hash = ?",
            hash,
          ),
        ];
        if (existing.length > 0) {
          return new Response(
            JSON.stringify({
              ok: true,
              created: false,
              duplicate: true,
              revisionHash: existing[0].hash,
              revisionNumber: existing[0].revision_number,
              wordCount: existing[0].word_count,
              cellVersion: this._getCellVersion(),
              state: this._getState(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const revNum =
          revisionNumber ||
          ([
            ...this.sql.exec(
              "SELECT MAX(revision_number) as max_rev FROM article_revisions",
            ),
          ][0]?.max_rev || 0) + 1;

        this.sql.exec(
          `
          INSERT INTO article_revisions (hash, revision_number, title, body, word_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          hash,
          revNum,
          title,
          body,
          wordCount,
          now,
        );

        const cellVer = this._bumpCellVersion("drafted");
        return new Response(
          JSON.stringify({
            ok: true,
            created: true,
            revisionHash: hash,
            revisionNumber: revNum,
            wordCount,
            cellVersion: cellVer,
            state: "drafted",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // GET /v1/revisions/latest
      if (pathname === "/v1/revisions/latest" && method === "GET") {
        const rows = [
          ...this.sql.exec(
            "SELECT hash, revision_number, title, body, word_count, created_at FROM article_revisions ORDER BY revision_number DESC LIMIT 1",
          ),
        ];
        if (rows.length === 0) {
          return new Response(
            JSON.stringify({
              error: "not_found",
              message: "No revisions found",
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ ...rows[0], cellVersion: this._getCellVersion() }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // POST /v1/reviews
      if (pathname === "/v1/reviews" && method === "POST") {
        const { revisionHash, verdict, score, findings, instructions } =
          await request.json();
        if (!revisionHash || !verdict) {
          return new Response(
            JSON.stringify({
              error: "bad_request",
              message: "revisionHash and verdict are required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const reviewId = `rev-${crypto.randomBytes(4).toString("hex")}`;
        const now = Date.now();
        this.sql.exec(
          `
          INSERT INTO article_reviews (id, revision_hash, verdict, score, findings, instructions, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          reviewId,
          revisionHash,
          verdict,
          score || 1.0,
          JSON.stringify(findings || []),
          instructions || "",
          now,
        );

        const nextState = verdict === "APPROVE" ? "reviewed" : "needs_revision";
        const cellVer = this._bumpCellVersion(nextState);
        return new Response(
          JSON.stringify({
            ok: true,
            reviewId,
            verdict,
            score,
            cellVersion: cellVer,
            state: nextState,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // POST /v1/approvals
      if (pathname === "/v1/approvals" && method === "POST") {
        const { revisionHash, approvedBy, reason } = await request.json();
        if (!revisionHash || !approvedBy) {
          return new Response(
            JSON.stringify({
              error: "bad_request",
              message: "revisionHash and approvedBy are required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const now = Date.now();
        this.sql.exec(
          `
          INSERT INTO article_approvals (revision_hash, approved_by, approved_at, reason)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(revision_hash) DO UPDATE SET
            approved_by = excluded.approved_by,
            approved_at = excluded.approved_at,
            reason = excluded.reason
        `,
          revisionHash,
          approvedBy,
          now,
          reason || "Approved for CMS publication",
        );

        const cellVer = this._bumpCellVersion("approved");
        return new Response(
          JSON.stringify({
            ok: true,
            revisionHash,
            approvedBy,
            cellVersion: cellVer,
            state: "approved",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // POST /v1/publication-receipt
      if (pathname === "/v1/publication-receipt" && method === "POST") {
        const { cmsPostId, cmsUrl, cmsStatus, revisionHash } =
          await request.json();
        const receiptId = `rcpt-${crypto.randomBytes(4).toString("hex")}`;
        const now = Date.now();
        this.sql.exec(
          `
          INSERT INTO article_receipts (id, cms_post_id, cms_url, cms_status, revision_hash, published_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          receiptId,
          cmsPostId,
          cmsUrl,
          cmsStatus || "draft",
          revisionHash,
          now,
        );

        const cellVer = this._bumpCellVersion("published");
        return new Response(
          JSON.stringify({
            ok: true,
            receiptId,
            cmsPostId,
            cmsUrl,
            cellVersion: cellVer,
            state: "published",
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
      // Log the stack locally; never leak it to the caller.
      console.error("[article-cell] unhandled error", err);
      return new Response(
        JSON.stringify({ error: "internal_error", message: err.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }
}

# Cells & Durable Objects Interaction Guide for Agents

This document is the standard reference for agents interacting with stateful SQLite Cells running on `celld` / Cloudflare Workers.

---

## 1. Finding Your Cell Target

Every agent provisioned with cell capabilities receives target connection details in `./input.json`:

```json
{
  "cellEndpoint": "http://100.74.142.98:8080",
  "articleId": "editorial:article:coachwatts.com:01J98ABC",
  "siteId": "editorial:site:coachwatts.com"
}
```

- `${cellEndpoint}`: Base URL of the cell daemon.
- `${cellId}`: The full 3-part URN (`domain:type:instance`).

---

## 2. Standard Cell Endpoints

The URL structure for any cell request is:

$$\mathtt{\$\{cellEndpoint\}/cells/\$\{encodeURIComponent(cellId)\}/\$\{path\}}$$

### A. Introspection & State Discovery

- **`GET /v1/state`**: Returns current high-level entity state, brief, sources, latest revision, and review findings.
- **`GET /v1/schema`**: Returns live SQLite tables, columns, constraints, and applied migrations.
- **`GET /v1/entities/:collection`**: Returns all entities in a collection.
- **`GET /v1/entities/:collection/:id`**: Returns a specific entity with version metadata.

### B. Writing Data

- **`PUT /v1/entities/:collection/:id`**: Writes or updates an entity.
  - Headers: `Content-Type: application/json`
  - Body: `{"data": { ... }, "expectedVersion": 1}`
- **`POST /v1/sources`**: Appends scientific research studies and verified claims.
  - Body: `{"sources": [{ "id": "src-1", "title": "...", "url": "...", "claims": [...] }]}`
- **`POST /v1/revisions`**: Commits an immutable draft revision.
  - Body: `{"title": "...", "body": "# Markdown...", "revisionNumber": 1}`
- **`POST /v1/reviews`**: Commits an editorial review and quality score.
  - Body: `{"revisionHash": "...", "verdict": "APPROVE" | "REVISE" | "NEEDS_HUMAN", "score": 0.95, "findings": [...]}`

### C. Read-Only SQL Queries

- **`POST /v1/query`**: Executes parameterized `SELECT` queries directly against the cell's SQLite database.
  - Body: `{"sql": "SELECT * FROM article_sources WHERE relevance_score > ? ORDER BY relevance_score DESC", "params": [0.9]}`

---

## 3. Authentication & Access Control

### Bearer token (required)

Every request except `GET /health` must carry the shared secret:

```
Authorization: Bearer ${CELL_AUTH_TOKEN}
```

The ingress router fails **closed**: it refuses all traffic when
`CELL_AUTH_TOKEN` is unset on the daemon, and answers `401` for a missing or
wrong token. The first-party clients (`CellClient`, `SiteCellClient`,
`ArticleCellClient`) read the secret from `process.env.CELL_AUTH_TOKEN` by
default, so a raw `curl` is the only place you normally set it by hand.

### Access tier

Your agent's assigned access tier is sent via the `X-Cell-Access` header:

- `read-only`: Only `GET` requests permitted.
- `data-only`: Full data read/write permitted; DDL schema migrations blocked with `403`.
- `read-write`: Same as `data-only` for schema purposes; DDL blocked with `403`.
- `malleable`: Full data read/write and DDL schema migrations permitted.

Omitting the header is **not** a way to get more access: an undeclared tier is
treated as `read-only`, and an unrecognised value is a `400`.

---

## 4. Code Snippets

### In Bash with `curl`:

```bash
ENDPOINT=$(jq -r .cellEndpoint ./input.json)
CELL_ID=$(jq -r .articleId ./input.json)

# 1. Fetch live state
curl -s -H "Authorization: Bearer ${CELL_AUTH_TOKEN}" \
  -H "X-Cell-Access: data-only" \
  "${ENDPOINT}/cells/${CELL_ID}/v1/state"

# 2. Query sources via SQL
curl -s -X POST "${ENDPOINT}/cells/${CELL_ID}/v1/query" \
  -H "Authorization: Bearer ${CELL_AUTH_TOKEN}" \
  -H "X-Cell-Access: data-only" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT id, title, relevance_score FROM article_sources;"}'
```

### In JavaScript with `fetch`:

```javascript
const input = JSON.parse(await Bun.file("./input.json").text());
const cellUrl = `${input.cellEndpoint}/cells/${encodeURIComponent(input.articleId)}`;
const auth = {
  Authorization: `Bearer ${process.env.CELL_AUTH_TOKEN}`,
  "X-Cell-Access": "data-only",
};

// Fetch state
const stateRes = await fetch(`${cellUrl}/v1/state`, { headers: auth });
const state = await stateRes.json();

// Commit draft revision
const revRes = await fetch(`${cellUrl}/v1/revisions`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({
    title: state.brief.title,
    body: "# Article Content...",
    revisionNumber: (state.latestRevision?.revision_number || 0) + 1,
  }),
});
```

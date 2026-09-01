/**
 * Generates capability-gated CELLS.md content for agent workspaces.
 */
export function renderCellsGuide({ cells = [], cellEndpoint = null } = {}) {
  const endpointDisplay = cellEndpoint || "http://100.74.142.98:8080";

  let cellBindingsSection = "";
  if (cells.length > 0) {
    cellBindingsSection =
      `## Declared Cell Capabilities\n\n` +
      cells
        .map(
          (c) =>
            `- **Binding:** \`${c.binding}\` | **Access:** \`${c.access || "data-only"}\` | **Description:** ${c.description || "N/A"}`,
        )
        .join("\n") +
      "\n\n";
  }

  return `# Cells & Durable Objects Interaction Guide (CELLS.md)

Your workspace is connected to stateful SQLite Cells running on \`celld\` / Cloudflare Workers.

${cellBindingsSection}## 1. Connection & Target URNs

Read \`./input.json\` in your workspace to get:
- \`cellEndpoint\`: Base URL of the cell daemon (default: \`${endpointDisplay}\`).
- \`articleId\` / \`siteId\` / \`cellId\`: The target 3-part URN (e.g. \`editorial:article:coachwatts.com:01J98ABC\`).

---

## 2. Standard REST API Endpoints

The full URL pattern is:
\`\${cellEndpoint}/cells/\${encodeURIComponent(cellId)}/\${path}\`

### A. Introspection & State Discovery
- \`GET /v1/state\`: Returns current high-level entity state, brief, sources, latest revision, and review findings.
- \`GET /v1/schema\`: Returns live SQLite tables, columns, constraints, and applied migrations.
- \`GET /v1/entities/:collection\`: Returns all entities in a collection.
- \`GET /v1/entities/:collection/:id\`: Returns a specific entity.

### B. Writing Data (HTTP REST)
- \`PUT /v1/entities/:collection/:id\`: Update/Create entity.
  Body: \`{"data": { ... }, "expectedVersion": 1}\`
- \`POST /v1/sources\`: Append scientific research studies.
  Body: \`{"sources": [{ "id": "src-1", "title": "...", "url": "...", "claims": [...] }]}\`
- \`POST /v1/revisions\`: Commit an immutable draft revision.
  Body: \`{"title": "...", "body": "# Markdown...", "revisionNumber": 1}\`
- \`POST /v1/reviews\`: Submit an editorial review and quality score.
  Body: \`{"revisionHash": "...", "verdict": "APPROVE" | "REVISE" | "NEEDS_HUMAN", "score": 0.95, "findings": [...]}\`

### C. SQL Queries (Read-Only)
- \`POST /v1/query\`: Run parameterized \`SELECT\` query against the cell's SQLite database.
  Body: \`{"sql": "SELECT * FROM article_sources WHERE relevance_score > ?", "params": [0.9]}\`

---

## 3. Code Snippets

### In Bash (curl):
\`\`\`bash
ENDPOINT=$(jq -r .cellEndpoint ./input.json)
CELL_ID=$(jq -r .articleId ./input.json)

# Fetch latest state
curl -s "\${ENDPOINT}/cells/\${CELL_ID}/v1/state"
\`\`\`

### In JavaScript (fetch):
\`\`\`javascript
const input = JSON.parse(await Bun.file("./input.json").text());
const res = await fetch(\`\${input.cellEndpoint}/cells/\${encodeURIComponent(input.articleId)}/v1/state\`);
const state = await res.json();
\`\`\`
`;
}

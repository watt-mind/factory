/**
 * Generates capability-gated CELLS.md content for agent workspaces.
 */

const DEFAULT_CELL_ENDPOINT = "http://100.74.142.98:8080";

/**
 * `cellEndpoint` arrives on the event payload, so it is caller-controlled, and
 * it is interpolated verbatim into the agent's prompt markdown. Accept only a
 * plain http/https URL with no characters that could close a code fence, break
 * out of a line, or smuggle control bytes into the prompt; anything else falls
 * back to the default.
 */
export function sanitizeCellEndpoint(value) {
  if (typeof value !== "string" || value === "") return DEFAULT_CELL_ENDPOINT;
  // eslint-disable-next-line no-control-regex
  if (/[`\s\u0000-\u001f\u007f]/.test(value)) return DEFAULT_CELL_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return DEFAULT_CELL_ENDPOINT;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return DEFAULT_CELL_ENDPOINT;
  }
  return value;
}

export function renderCellsGuide({ cells = [], cellEndpoint = null } = {}) {
  const endpointDisplay = sanitizeCellEndpoint(cellEndpoint);

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

## 2. Authentication & Access Tier

Every request except \`GET /health\` must carry the shared secret:

\`\`\`
Authorization: Bearer \${CELL_AUTH_TOKEN}
\`\`\`

The ingress fails closed — a missing or wrong token is a \`401\`. Read the secret
from the \`CELL_AUTH_TOKEN\` environment variable.

Declare your access tier on every request with \`X-Cell-Access\` (see the
capabilities above). Omitting it is not a shortcut: an undeclared tier is
treated as \`read-only\`, and an unknown value is a \`400\`.

---

## 3. Standard REST API Endpoints

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

## 4. Code Snippets

### In Bash (curl):
\`\`\`bash
ENDPOINT=$(jq -r .cellEndpoint ./input.json)
CELL_ID=$(jq -r .articleId ./input.json)

# Fetch latest state
curl -s -H "Authorization: Bearer \${CELL_AUTH_TOKEN}" \\
  -H "X-Cell-Access: data-only" \\
  "\${ENDPOINT}/cells/\${CELL_ID}/v1/state"
\`\`\`

### In JavaScript (fetch):
\`\`\`javascript
const input = JSON.parse(await Bun.file("./input.json").text());
const res = await fetch(
  \`\${input.cellEndpoint}/cells/\${encodeURIComponent(input.articleId)}/v1/state\`,
  {
    headers: {
      Authorization: \`Bearer \${process.env.CELL_AUTH_TOKEN}\`,
      "X-Cell-Access": "data-only",
    },
  },
);
const state = await res.json();
\`\`\`
`;
}

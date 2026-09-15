# Cells & Durable Objects Architecture

This document specifies the architecture, conventions, and operational lifecycle for **Cells** in the Factory event runtime and Watt Mind infrastructure.

---

## 1. Overview & Core Model

A **Cell** is a stateful actor backed by a private SQLite database running inside Cloudflare Workers / `celld` Durable Objects.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Host Runtime: celld Daemon (e.g. runner 100.74.142.98:8080)           │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Worker Ingress Gateway (src/index.mjs)                          │  │
│  │  - URL Matching (/cells/:cellId/...) & Header Parsing           │  │
│  │  - Routes requests to target Durable Object Stubs                │  │
│  └─────────────────────────────────┬────────────────────────────────┘  │
│                                    │                                   │
│           ┌────────────────────────┼────────────────────────┐          │
│           ▼                        ▼                        ▼          │
│  ┌─────────────────┐      ┌─────────────────┐      ┌────────────────┐  │
│  │   GenericCell   │      │    SiteCell     │      │  ArticleCell   │  │
│  │  (Entity CRUD)  │      │(Policy & Topics)│      │(Drafts/Reviews)│  │
│  │   [SQLite DB]   │      │   [SQLite DB]   │      │  [SQLite DB]   │  │
│  └────────┬────────┘      └────────┬────────┘      └────────┬───────┘  │
└───────────┼────────────────────────┼────────────────────────┼──────────┘
            ▼                        ▼                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Storage Backing: Cloudflare R2 (s3://factory-cells)                   │
│  - Log-Structured Transactions (LTX) replicated for zero-loss backup   │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Properties:

1. **Single-Writer Actor Isolation:** Each unique Cell ID corresponds to an isolated SQLite database file. Concurrent requests to the same cell are serialized safely by the Durable Object actor.
2. **Log-Structured Replication (LTX):** All database mutations are written to a local write-ahead log and replicated asynchronously to Cloudflare R2 (`s3://factory-cells`).
3. **Hot-Code Swapping:** `celld deploy` bundles worker updates with `esbuild` and updates the deployment pointer in S3. Running `celld` nodes poll this pointer and hot-swap code without terminating running actors or restarting the process.

---

## 2. Collision-Proof Cell Naming Conventions

All Cell IDs follow a **3-part URN namespace**:

$$\mathbf{\text{domain}} : \mathbf{\text{cell\_type}} : \mathbf{\text{instance\_id}}$$

### Standard Namespaces:

| Domain               | Pattern                                     | Example                                     | Purpose                                                 |
| :------------------- | :------------------------------------------ | :------------------------------------------ | :------------------------------------------------------ |
| **Editorial**        | `editorial:site:<domain>`                   | `editorial:site:coachwatts.com`             | Site-wide editorial policy, backlog, and coverage index |
| **Editorial**        | `editorial:article:<domain>:<ulid_or_slug>` | `editorial:article:coachwatts.com:01J98AB2` | Single-article brief, sources, revisions, and reviews   |
| **Infrastructure**   | `infra:kv:<scope>`                          | `infra:kv:runner-nodes`                     | Fleet node telemetry, metrics, and health state         |
| **Life-Ops**         | `lifeops:kv:<collection>`                   | `lifeops:kv:personal-crm`                   | Contacts, expenses, and personal automation cache       |
| **Client Apps**      | `client:<client_id>:<feature>`              | `client:duovill:pricing-cache`              | Client-specific transient and cached state              |
| **Agent Scratchpad** | `agent:scratch:<agent_id>:<run_id>`         | `agent:scratch:research:run_7x92a`          | Ephemeral multi-step agent scratchpad storage           |

---

## 3. Worker Ingress & Routing

The worker entry point ([`cells/src/index.mjs`](../cells/src/index.mjs)) extracts the Cell ID and routes to the appropriate Durable Object binding:

1. **Path-based extraction:** `http://.../cells/<cellId>/<action>` $\rightarrow$ parses `<cellId>`, strips prefix, forwards `<action>`.
2. **Header-based extraction:** `X-Cell-Id: <cellId>` $\rightarrow$ forwards path as-is.
3. **Dynamic Binding Selection:**
   - `editorial:site:*` or `site:*` $\rightarrow$ routes to `env.SITE_CELL`.
   - `editorial:article:*` or `article:*` $\rightarrow$ routes to `env.ARTICLE_CELL`.
   - `*:kv:*` or `generic:*` $\rightarrow$ routes to `env.GENERIC_CELL`.

---

## 4. Runtime Schema Introspection & Discovery

Agents discover and interact with cells using two discovery endpoints:

### A. SQLite Table Introspection (`GET /v1/schema`)

Returns the live SQL table definitions, columns, and migration history:

```json
{
  "cellVersion": 3,
  "tables": [
    {
      "name": "article_brief",
      "sql": "CREATE TABLE article_brief (id INTEGER PRIMARY KEY, title TEXT, slug TEXT...)"
    },
    {
      "name": "article_sources",
      "sql": "CREATE TABLE article_sources (id TEXT PRIMARY KEY, title TEXT, url TEXT...)"
    },
    {
      "name": "article_revisions",
      "sql": "CREATE TABLE article_revisions (hash TEXT PRIMARY KEY, revision_number INTEGER, title TEXT, body TEXT...)"
    }
  ],
  "migrations": [
    {
      "id": "001_init",
      "applied_at": 1788213900000,
      "description": "Initial table setup"
    }
  ]
}
```

### B. High-Level Entity State (`GET /v1/state` / `GET /v1/snapshot`)

Returns the structured domain state and lifecycle phase (`"briefed"`, `"researched"`, `"drafted"`, `"reviewed"`, `"approved"`, `"published"`).

---

## 5. Malleability Model (How Agents Evolve Cells)

Cells support two levels of modification:

### Level 1: Dynamic Runtime Schema Evolution (No Deploy Required)

Agents can apply versioned DDL migrations on-the-fly inside their cell instance:

```bash
curl -X POST http://100.74.142.98:8080/cells/editorial:article:01J.../v1/schema/migrate \
  -H "Content-Type: application/json" \
  -d '{"migrationId": "002_add_doi", "sql": "ALTER TABLE article_sources ADD COLUMN doi TEXT;", "description": "Add academic DOI"}'
```

### Level 2: Code Evolution & Hot-Deployment (`celld deploy`)

To add new Durable Object classes, endpoints, or business logic:

1. Edit the relevant module: [`cells/src/base/generic-cell.mjs`](../cells/src/base/generic-cell.mjs)
   for shared behaviour, [`cells/src/editorial/`](../cells/src/editorial/) for a domain
   cell, or [`cells/src/router.mjs`](../cells/src/router.mjs) for ingress routing;
   [`cells/src/index.mjs`](../cells/src/index.mjs) is the worker entrypoint that wires
   them together.
2. Run pure in-memory unit tests: `bun run cells:test`.
3. Deploy to the fleet bucket: `bun run cells:deploy`.
4. Running `celld` nodes detect the new version pointer in S3 and hot-swap in-place.

---

## 6. Access Control & Cell Immutability Policy

To protect cells from unauthorized modifications by untrusted, specialized, or restricted agents, the runtime supports **three granular access tiers** configured via the `X-Cell-Access` header or agent capabilities:

| Access Tier | Permitted Operations                                                              | Blocked Operations                                                                      | Intended Use Case                                                                    |
| :---------- | :-------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| `read-only` | `GET` requests (`/v1/state`, `/v1/schema`, `/v1/entities/...`, `/v1/query`)       | All `POST`, `PUT`, `DELETE` operations (returns `403 Forbidden`)                        | Auditors, topic scanners, reviewers who only inspect                                 |
| `data-only` | Full data CRUD (`PUT /v1/entities/...`, `POST /v1/sources`, `POST /v1/revisions`) | Schema alterations & DDL migrations (`POST /v1/schema/migrate`) returns `403 Forbidden` | Standard drafters, researchers, and content writers who must not alter table schemas |
| `malleable` | Full data CRUD + dynamic DDL schema migrations (`POST /v1/schema/migrate`)        | None at the cell level                                                                  | Cell engineer and autonomous architecture agents                                     |

A request that omits `X-Cell-Access` is treated as **`read-only`** — the most
restrictive tier — so a caller that forgets the header can never widen its own
access. An unrecognised tier is a `400 Bad Request` rather than a silent
fallback. Every first-party client (`CellClient`, `SiteCellClient`,
`ArticleCellClient`) declares its tier explicitly.

> The tier is still **declared by the caller**, not derived by the cell from an
> authenticated identity. Server-side derivation is future work; until then this
> is a guard rail against accidental writes, not an authorization boundary.

### Code Deployment Immutability:

- Standard agents operate in isolated sandbox workspaces without Cloudflare R2 deployment credentials.
- Only explicitly authorized CI / release workflows or designated engineering agents can execute `celld deploy`.

---

## 6a. Editorial Chaining (What the Event Graph Wires)

The editorial agents chain through [`packs/editorial/edges.json`](../packs/editorial/edges.json)
on their `outcome` (or, for the reviewer, `verdict`) field:

| Source                   | Value             | Chains to                                               |
| :----------------------- | :---------------- | :------------------------------------------------------ |
| `editorial-topic-scan@1` | `TOPICS_PROPOSED` | one `editorial.research.requested` per claimed topic    |
| `editorial-research@1`   | `RESEARCHED`      | `editorial.draft.requested`                             |
| `editorial-draft@1`      | `DRAFTED`         | `editorial.review.requested`                            |
| `editorial-review@1`     | `REVISE`          | `editorial.draft.requested` (redraft with instructions) |

`APPROVE` and `NEEDS_HUMAN` deliberately have **no** outgoing edge. Approving a
specific revision hash for publication is an operator act against the
`ArticleCell` (`POST /v1/approvals`), and publication is recorded by the CMS
adapter (`POST /v1/publication-receipt`) — neither is chained automatically.

---

## 7. Testing Strategy & Isolation Seams

Under no circumstances should automated tests touch live production `celld` or remote Cloudflare R2 buckets.

| Test Tier             | Mechanism                                                     | Subprocess / Network                    | Latency   | Target                                         |
| :-------------------- | :------------------------------------------------------------ | :-------------------------------------- | :-------- | :--------------------------------------------- |
| **Unit Tests**        | `createMockCellFetch()` in `event-runtime/lib/mock-cells.mjs` | **None** (In-process SQLite `:memory:`) | ~15ms     | Client classes, prompts, agent logic           |
| **Integration / E2E** | `celld dev <tmp_dir> --port <random>`                         | Ephemeral child process on `127.0.0.1`  | ~1.5s     | Binary lifecycle, hot-reload, file persistence |
| **Production**        | Live `celld` on `runner` (`100.74.142.98`)                    | Tailscale mesh + Cloudflare R2          | Real-time | Real autonomous agent workloads                |

---

## 8. Production Network & Security Topology

> **Bearer secret (spike stop-gap).** Every request except `GET /health` must
> carry `Authorization: Bearer $CELL_AUTH_TOKEN`. The ingress router fails
> closed when the secret is unset, so an unconfigured worker refuses all
> traffic. This is a shared secret, not an authentication system: no per-caller
> identity, no rotation, no per-cell authorization. The worker must not be
> deployed beyond the loopback/tailnet spike until real auth lands.

- **Private Tailnet Binding:** The `celld` daemon on `runner` binds exclusively to `100.74.142.98:8080` (with internal peer listen on `:8081`).
- **Unproxied DNS Pointer:** `cells.servers.hdkiller.com` $\rightarrow$ `100.74.142.98` (Cloudflare DNS-only / Grey Cloud).
- **Storage Access:** Cloudflare R2 bucket `factory-cells` requires AWS Signature Version 4 HMAC authentication using credentials in `.env`.
- **Zero Public Exposure:** 0 ports exposed to the public internet.

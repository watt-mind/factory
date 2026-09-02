# Code Context

## Files Retrieved
1. `event-runtime/lib/api-registry.mjs` (lines 23-104) — authoritative `GET /agents` response construction and event-envelope schema exposure.
2. `event-runtime/lib/api-artifacts.mjs` (lines 61-108, 137-161) — artifact inventory filters/cursor and byte-stream endpoint.
3. `event-runtime/web/src/types.ts` (lines 104-122, 381-405, 461-476, 539-572, 590-596) — web API data shapes.
4. `event-runtime/web/src/api.ts` (lines 279-298, 371-391, 412-425, 573-575) — API calls, event injection envelope, and artifact URL.
5. `event-runtime/web/src/views/Agents.tsx` (lines 263-283, 1001-1049) — existing registry query/detail routing UI.
6. `event-runtime/web/src/views/Artifacts.tsx` (lines 141-167, 312-427, 766-776, 932-1004, 1096-1100) — inventory-to-inspector routing, reference navigation, and artifact-to-agent view resolution.
7. `event-runtime/web/src/views/ArtifactFull.tsx` (lines 40-117) — full artifact fetching and producer-agent/view lookup.
8. `event-runtime/web/src/App.tsx` (lines 255-260, 585-590) — canonical hash navigation helpers.
9. `event-runtime/lib/registry.mjs` (lines 1085-1092) — kernel envelope schema location.
10. `event-runtime/lib/api-artifacts.test.mjs` (lines 48-151, 225-328) — backend inventory, validation, byte retrieval, corruption, and filename tests.
11. `event-runtime/lib/api-registry.test.mjs` (lines 48-50, 405-449) — registry view and overlay tests.

## Key Code

### Event envelope
The registered schema is `event-runtime/schemas/factory.event.v1.json`, loaded as `registry.schemas.envelope` in `event-runtime/lib/registry.mjs:1085-1092`, and exposed at:

```js
contracts: {
  "factory.event/v1": registry.schemas.envelope,
  "factory.agent-result/v1": registry.schemas.agentResult,
}
```

`event-runtime/lib/api-registry.mjs:99-102`

The web-side injection shape is concrete and already canonical:

```ts
{
  schemaVersion: "factory.event/v1",
  eventId,
  type,
  source,
  subject,
  occurredAt: new Date().toISOString(),
  correlationId: eventId,
  payload,
}
```

`event-runtime/web/src/api.ts:371-391`

Persisted/listed event rows are not strongly typed envelopes; `AdmittedEvent.envelope` is `Record<string, unknown>` (`event-runtime/web/src/types.ts:104-122`). Any new event-envelope inspector should validate/narrow this unknown object locally rather than assuming `payload` or optional causation fields.

### Agent registry
`GET /agents` already returns complete agent definitions, including prompt text, schemas, pins, optional artifact view, effective/declared models, and per-agent routes (`event-runtime/lib/api-registry.mjs:36-88`).

Critical route shape:

```ts
interface AgentEventRoute {
  type: string;
  adapter: string;
  declaredAdapter?: string;
  idempotencyScope: string;
  proposalTtlSeconds: number | null;
  resolvedModel: string | null;
}
```

`event-runtime/web/src/types.ts:461-476`

The Agents view already fetches `api.agents()` and renders selected-agent event-routing details (`event-runtime/web/src/views/Agents.tsx:263-283`, `1001-1049`). Thus registry browsing and adapter/model-overlay presentation have landed.

### Artifacts and navigation
Artifact inventory shape:

```ts
interface ArtifactInventoryItem {
  sha256: string;
  sizeBytes: number;
  mtime: string;
  referenced: boolean;
  references: ArtifactReference[];
}

interface ArtifactReference {
  runId: string;
  kind: string | null;
  agent: string | null;
  state: RunState | null;
  createdAt: string | null;
}
```

`event-runtime/web/src/types.ts:389-405`

The backend already supports:
- `GET /artifacts?kind&orphan&search&limit&before`, limit 1–500 (`event-runtime/lib/api-artifacts.mjs:61-108`);
- `GET /artifacts/:sha256`, which rehashes the file before streaming and returns 404 for missing/corrupt content (`event-runtime/lib/api-artifacts.mjs:137-161`);
- browser URL construction through `artifactUrl(sha256, name?)` (`event-runtime/web/src/api.ts:573-575`).

The artifacts view already supports hash routing to `#/artifacts/:sha` (`event-runtime/web/src/views/Artifacts.tsx:141-167`), opens a full reader, and links artifact references/consumers to their runs (`766-776`, `932-1004`). The full reader fetches inventory, raw bytes, and agents; it chooses a producing agent based on artifact references, preferring `kind === "result"`, then applies that agent’s `outputView` only when the parsed JSON satisfies it (`event-runtime/web/src/views/ArtifactFull.tsx:53-117`).

## Architecture

`GET /agents` is the source of truth for both the registry UI and schema/view metadata. The UI can use its `contracts["factory.event/v1"]` value to render or validate an event envelope without adding a new endpoint.

Artifacts are content-addressed by a bare 64-character SHA. Inventory records provide run and agent provenance; raw bytes come separately from `/api/artifacts/:sha`. Existing hash navigation is split:
- inspector/list: `#/artifacts/:sha`;
- full reader: `#/artifact/:sha` via `App.tsx:258-259`.

The distinction is intentional but a likely source of deep-link inconsistency if new links are added.

## Already Landed vs. Remaining

**Already landed**
- Registry API includes envelope schema and complete readable agent definitions.
- Agents registry has filters, details, routing display, model-tier handling, and runtime-overlay controls.
- Artifact inventory, filtering, byte retrieval, raw/formatted readers, producer-agent matching, artifact-view rendering, downloads, and run-reference navigation.
- Full-page artifact reader and app-level artifact navigation.

**Likely remaining minimal work for #856**
- Add a coherent event-envelope detail/inspection path that consumes `AdmittedEvent.envelope` and the already-exposed `AgentsView.contracts["factory.event/v1"]`.
- For an event’s `type`, join against `AgentsView.eventTypes` to show the effective route and, when available, select/open the routed `AgentDef`.
- Reuse existing `ArtifactFull`/Artifacts navigation for hashes found in the envelope or payload rather than creating a second artifact-fetching mechanism.
- Avoid backend changes unless ticket requirements demand server-side envelope normalization; all necessary data appears present.

## Likely Tests

1. `event-runtime/web/src/views/Events.test.tsx`: an event envelope with a known route shows the schema-backed envelope and navigates/selects the mapped agent.
2. `event-runtime/web/src/views/Events.test.tsx`: unknown route and malformed/non-object `envelope` are rendered safely without throwing.
3. `event-runtime/web/src/views/Events.test.tsx`: envelope artifact hashes in bare and `sha256:` form route to the existing artifact reader only when the digest is exactly lowercase 64-hex.
4. `event-runtime/web/src/views/Artifacts.test.tsx`: preserve existing run-reference navigation and regression-test correct `#/artifacts/:sha` versus `#/artifact/:sha` behavior if #856 unifies them.
5. No new backend test is needed for existing APIs; backend coverage already includes inventory filter/cursor/input validation and stream integrity in `event-runtime/lib/api-artifacts.test.mjs:48-151,225-328`, and registry exposure/overlays in `event-runtime/lib/api-registry.test.mjs:48-50,405-449`.

## Risks

- **Medium:** `AdmittedEvent.envelope` is untyped `Record<string, unknown>`; rendering must fail closed for malformed historical data.
- **Medium:** event route data represents effective runtime overlay configuration, not immutable Git configuration (`api-registry.mjs:73-85`); label it accordingly.
- **Medium:** artifact byte requests decode via `Response.text()` in existing readers; binary classification is heuristic. Reuse current behavior rather than adding a duplicate decoder.
- **Low:** two artifact hash routes already exist (`#/artifacts/:sha` and `#/artifact/:sha`); preserve query parameters and canonicalize any new deep links.
- **Scope uncertainty:** ticket body/Owned Paths were unavailable in the checkout; findings are limited to the user-named envelope/registry/artifact/navigation areas.
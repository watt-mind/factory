# Event runtime: readable agent output — artifact views and presentations

Status: **design — operator-ratified, nothing built** (Layers A–B, WM-452 /
WM-453). §4 Layer C (WM-847) is design, awaiting the same ratification before
its implementation tickets are filed. Tracking: WM-452 (epic); WM-453 (this
document); WM-847 (Layer C). Implementation lands through the ticket map in
§7. Companion to [event-runtime.md](event-runtime.md) §9 (verification — the
artifact this renders is the one that verification accepted) and to
[event-runtime-inbox.md](event-runtime-inbox.md), whose decision requests use
the same principle and, later, the same block vocabulary.

---

## 1. Problem and scope

An agent's artifact is a JSON object validated against `<agent>.output.json`.
That is exactly right for the chain — typed, hashed, verifiable, consumed by
the next agent — and exactly wrong for a person. A `triage-scan` plan is dozens
of `{issueId, action, reason, detail}` rows; a `merge-scan` result is nested
verdict arrays; `dispatch` output is `outcome / prUrl / verification /
uxCritique`. The web renders every one of them through `JsonBlock`
(`web/src/components/RunDetailBlocks.tsx`, `views/Artifacts.tsx`); the CLI
prints JSON. The operator does the rendering in their head, every time.

This is the same shape of gap the inbox had before WM-383: the **data**
contract exists, the **presentation** contract does not. It is fixed the same
way — a closed vocabulary the agent (or the schema author) fills, a generic
renderer that owns layout — but with a different split, because here the
artifact already exists and must remain the only source of truth.

Three layers, built in this order:

- **Layer A — derive the view from the output schema.** No per-run authoring,
  no tokens. A sidecar file annotates paths in the agent's output schema with
  rendering hints; a generic renderer walks artifact + schema + hints. This is
  the floor: deterministic, testable, cannot drift from the contract, and a
  new agent gets a decent view the moment someone writes twenty lines of
  hints. It probably removes most of the pain on its own.
- **Layer B — an optional agent-emitted `presentation`.** For runs where the
  _interpretation_ matters ("here is what I found and why it matters"), the
  agent may emit a bounded block document alongside the artifact. Values are
  inline text or **pointers into the artifact** — the narrative has to point
  at its evidence. Rendered by one block renderer that never sees the agent's
  name.
- **Layer C — an optional agent-emitted canvas.** For runs where the finding
  is a _shape_ (a failure's causal chain, a spend curve), the agent may emit
  one content-addressed drawing — Markdown, Mermaid, or SVG — stored beside
  the artifact, never as chain input. Layer A and B stay the evidence layer;
  the canvas is the picture. Sandboxed HTML is a later contract
  (`factory.canvas-html/v1`), not this one. §4.

Out of scope, said out loud:

- **Free-form UI.** No agent-supplied JSON Schema, layout, or components.
  Malleability comes from _composing_ a few blocks, not from an open schema —
  a renderer that draws whatever it is sent cannot be tested, and "malleable
  enough for anything" is how fifteen slightly different tables happen.
  Layer C does not reopen this: it is three media types with a sanitizer, not
  a component system.
- **Presentation or canvas as chain input.** Downstream agents keep reading
  the typed artifact. If a chain edge ever consumed the presentation or the
  drawing there would be two sources of truth, and the agent would start
  optimising the story instead of the data.
- **Replacing the raw view.** JSON stays one click away on every surface.
- **`x-ui` inside the output schema.** §2.3 says why.
- **Interactive canvas controls.** A drawing that _does_ something (approve,
  requeue, filter that mutates factory state) is a decision request, not a
  canvas — it lives in the inbox design. §4.6.

---

## 2. Layer A — `factory.artifact-view/v1`

### 2.1 Where it lives

`event-runtime/agents/<name>.view.json`, beside the agent's `.md`/`.json`.
Optional: an agent without one renders as JSON exactly as today. When the
agent sidecar is absent, the registry also looks for a **contract-keyed
fallback** at `agents/views/<output_contract>.view.json` (slashes in the
contract id become dots: `factory.command-result/v1` →
`agents/views/factory.command-result.v1.view.json`). Nine command-result
agents share that one file. The agent sidecar wins when both exist.
`GET /agents` exposes the applied view as `outputView` plus
`view.source: "agent" | "contract"` (or `view: null` when neither applied).

### 2.2 The contract

```json
{
  "schemaVersion": "factory.artifact-view/v1",
  "title": "Triage plan",
  "summary": "/summary",
  "status": {
    "path": "/recommendation",
    "tone": { "TRIAGE": "ok", "NOOP": "neutral" }
  },
  "sections": [
    {
      "path": "/plan",
      "as": "table",
      "label": "Plan",
      "columns": ["issueId", "action", "reason"],
      "groupBy": "action",
      "formats": { "issueId": "issue" },
      "tone": {
        "action": {
          "needs-human": "warn",
          "mark-duplicate": "muted",
          "label-agent-ready": "ok"
        }
      },
      "expand": [
        "detail",
        "ownedPaths",
        "verificationCommand",
        "acceptanceCriteria"
      ]
    },
    {
      "path": "/repo",
      "as": "keyvalue",
      "label": "Repo",
      "formats": { "": "repo" }
    }
  ]
}
```

| Key        | Rule                                                                                                                                                                                                                                                                                                                                                                                                    |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`    | Optional, ≤ 60 chars; falls back to the output schema's `title`.                                                                                                                                                                                                                                                                                                                                        |
| `summary`  | Optional JSON pointer (RFC 6901) to a string rendered first, as prose. Pointers on the output body resolve in the **output** schema.                                                                                                                                                                                                                                                                    |
| `status`   | Optional `{ path, tone }`: a pointer to an enum/string plus a value → tone map. Rendered as the header badge.                                                                                                                                                                                                                                                                                           |
| `sections` | Optional, 1–12 when present, rendered in order. Each has `path` (pointer; array or object or scalar), `as` from the closed set below, optional `label`, and per-`as` keys. A pointer that resolves to `undefined` in a given artifact renders nothing — optional fields are optional. A sidecar may omit `sections` entirely when it only ships `input` and/or `subject`.                               |
| `input`    | Optional view body (`title`, `summary`, `status`, `sections`, `formats`, `tone`) whose pointers resolve against the agent's **input** schema. Drawn in place of the hand-coded run-detail glance when present.                                                                                                                                                                                          |
| `subject`  | Optional template string, one line. Placeholders are `{/pointer}` into the input schema or the fixed RunSpec fields `{agent}`, `{model}`, `{adapter}`, `{repo}`. Rendered by `lib/spec-subject.mjs` and exposed as `subject` on `GET /runs/:id`, `GET /proposals`, and `GET /proposals/:id`. Example: `"Dispatch {/ticket} · {/repo} · {model}"`.                                                       |
| `as`       | `table` (array of objects: `columns` 1–8, optional `groupBy`, `expand` — columns shown only in the row's expanded state, `formats`, `tone`), `keyvalue` (object or scalar: `keys` optional subset, `formats`, `tone`), `list` (array of scalars/objects: `itemLabel` pointer relative to the item, `formats`, `tone`), `badge` (scalar: `tone`), `code` (string: `language` optional), `prose` (string) |
| `formats`  | Map of column/key (or `""` for the section value itself) → `format`, from `issue \| pr \| url \| sha \| repo \| run \| duration \| datetime \| state \| bytes \| count`. `issue`/`pr`/`run` render as jump chips using the same link builders the rest of the UI uses; `state` uses the run-state hues.                                                                                                 |
| `tone`     | Map of column/key → (value → `ok \| warn \| error \| muted \| neutral`), or a value map directly for scalars.                                                                                                                                                                                                                                                                                           |

`additionalProperties: false` throughout; unknown `as`, `format`, or tone
values fail validation. This is deliberately a hint vocabulary, not a layout
language: no widths, no colours, no nesting beyond `expand`. The renderer
decides everything else, once, for every agent.

### 2.3 Why a sidecar and not `x-ui` in the schema

`x-ui` is gone, not merely discouraged. WM-701 introduced
`x-ui: { kind: "ticket" }` as a schema annotation; `web/src/components/CustomCell.tsx`
used to read it, but no schema in the repo ever carried `x-ui`, none of the
`<CustomCell>` callers passed `ui`/`schema`, and `lib/schema.mjs` fails closed
on unknown keywords so `x-ui` cannot legally appear in an input/output
schema. CustomCell now takes the closed `formats` value from the active
artifact view (`issue` → ticket hover-card); without a view it still scans
the cell text for ticket ids.

Three reasons the rest of the vocabulary stays in a sidecar, all structural:

- `lib/schema.mjs` **fails closed on any unsupported keyword** — a contract
  with `x-ui` in it is an invalid contract today. Admitting an opaque
  keyword would weaken the one guarantee the validator makes.
- Output schemas are **pinned** (`agents/<name>.json` records their sha256).
  A view tweak — "make that column wider" — must not re-pin an agent and look
  like a contract change in the registry check.
- Views and contracts change for different reasons and at different rates.
  Keeping them in one file couples them.

The cost is drift: a sidecar can name a path the schema no longer has. That is
closed by a test, not by discipline — `lib/artifact-view.test.mjs` resolves
every `path`, `columns`, `keys`, `expand`, `itemLabel`, `summary`,
`status.path`, `input.*` pointer, and `subject` placeholder against the
matching schema (output or input) and fails on any that does not exist. The
registry runs the same check at load and refuses a view that does not fit
(a bad view is a configuration anomaly, shown in
`/status.anomalies.configuration`, never a rendering crash).

### 2.4 Rendering

#### Events use the same view contract

Event surfaces retain a fixed envelope glance — type, source, subject,
occurred time, and correlation/causation links — then offer an explicit
**View / Raw** choice. Raw is always the complete event envelope, never just
its payload. For `*.requested` events, the routed agent's existing
`outputView.input` body renders the payload; do not add parallel
`*.input.view.json` sidecars. For completed events that name a run and a
valid content hash, the result artifact uses that run agent's output view.
Missing, pruned, or non-JSON artifacts show a named unavailable state while
Raw and the envelope's own payload fields remain visible; a resolved artifact
whose run names no output view falls back to its JSON rather than being
discarded. Hashes are requested only when they are a strict lowercase
SHA-256 digest (optionally prefixed by `sha256:`), and responses are cached by
that digest so a later selection cannot paint an earlier event's result.

`web/src/components/ArtifactView.tsx` takes `{ artifact, schema, view }` and
renders §2.2. It replaces the `JsonBlock` at the artifact position in run
detail (`RunDetailBlocks.tsx`) and in `views/Artifacts.tsx` when a view exists
for the run's agent, with a **Raw** toggle that swaps back to `JsonBlock` (the
toggle state persists per user like the other display options). No view →
`JsonBlock`, unchanged. Pointer resolution and format/tone helpers live in a
pure module `web/src/lib/artifactView.ts`, unit-tested without the DOM.

The CLI gets the same for free where it is cheap: `cli.mjs inspect <runId>`
prints `summary` and the `status` badge as its first lines when a view exists.
Tables in a terminal are not worth it yet.

### 2.5 First views

`triage-scan` and `merge-scan` ship output views with the contract: they are
the two artifacts the operator reads most and the two that are hardest to
read as JSON. `dispatch` ships the combined sidecar (WM-897 input + subject,
WM-915 output sections against `schemas/dispatch.output.json` — there is no
refusal-reason field):

```json
{
  "schemaVersion": "factory.artifact-view/v1",
  "title": "Dispatch result",
  "subject": "Dispatch {/ticket} · {/repo} · {model}",
  "summary": "/summary",
  "status": {
    "path": "/outcome",
    "tone": {
      "PR_OPEN": "ok",
      "BLOCKED": "warn",
      "FAILED": "error",
      "NOT_CLAIMED": "muted"
    }
  },
  "input": {
    "sections": [
      {
        "path": "",
        "as": "keyvalue",
        "label": "Input",
        "keys": ["repo", "ticket"],
        "formats": { "repo": "repo", "ticket": "issue" }
      }
    ]
  },
  "sections": [
    {
      "path": "",
      "as": "keyvalue",
      "label": "Dispatch",
      "keys": ["repo", "ticket", "prUrl", "prNumber"],
      "formats": {
        "repo": "repo",
        "ticket": "issue",
        "prUrl": "url",
        "prNumber": "pr"
      }
    },
    {
      "path": "/verification",
      "as": "keyvalue",
      "label": "Verification",
      "keys": ["command", "passed", "output"],
      "tone": { "passed": { "true": "ok", "false": "error" } }
    },
    {
      "path": "/uxCritique",
      "as": "keyvalue",
      "label": "UX critique",
      "keys": ["status", "verdict", "rounds", "prReady", "evidence"]
    }
  ]
}
```

The nine `factory.command-result/v1` agents share
`agents/views/factory.command-result.v1.view.json`. `work-scan` and
`run-postmortem` follow in the Backlog ticket once the first two have shown
what the vocabulary is missing.

### 2.6 Panels — `factory.panel-view/v1` (WM-840)

The same vocabulary, one level up. An artifact view describes one agent's
output; a **panel** describes a dashboard tile bound to an existing loopback
API endpoint, so a pack or extension can put "open needs-me items" or "tickets
blocked > 24h" on Overview without shipping React. No client-side code is
loaded — a panel is data, validated at registry load, drawn by the same
`ArtifactView` renderer.

```json
{
  "format": "factory.panel-view/v1",
  "name": "wattmind/mobile:blocked-tickets",
  "title": "Blocked > 24h",
  "source": {
    "endpoint": "/tickets",
    "query": { "state": "blocked" },
    "path": "/tickets"
  },
  "refreshSeconds": 60,
  "view": {
    "sections": [
      {
        "path": "",
        "as": "table",
        "columns": ["identifier", "title"],
        "formats": { "identifier": "issue" }
      }
    ]
  }
}
```

| Key              | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`         | `factory.panel-view/v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `name`           | Unique across every contributor; `slug` for built-ins, `<namespace>:<slug>` for pack panels, `<publisher>/<extension>:<slug>` for extension panels. A duplicate is a configuration anomaly for the later contributor (built-in, then packs in policy order, then extensions).                                                                                                                                                                                                                                                          |
| `title`          | ≤ 60 chars, the tile heading. Optional `description` (≤ 200) is the heading's tooltip.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `source`         | `endpoint` — one of the loopback API's GET routes, **allow-listed** in `lib/api-panels.mjs` (`PANEL_ENDPOINTS`; `/agents /artifacts /chains /config /events /health /inbox /journal /metrics /metrics/breakdown /outbox /proposals /repos /runs /schedules /status /tickets /workers`) — no arbitrary URLs, no detail routes, no `/panels`; optional `query` (string values, appended as `?k=v`); optional `path`, an RFC 6901 pointer into the response selecting the node the view draws (`""`, the default, is the whole response). |
| `refreshSeconds` | 5–3600, default 60: how often the web refetches the source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `view`           | An artifact-view body (§2.2) without `schemaVersion`: `sections` (each `path` **relative to the selected node**, `""` for the node itself), optional `summary` and `status`. Same `as`, `formats` and `tone` sets, same per-`as` keys.                                                                                                                                                                                                                                                                                                 |

Validation is `lib/panel-view.mjs`: the panel schema
(`schemas/panel-view.schema.json`), the endpoint allow-list, and `view` through
the artifact-view validator's shape check (`validateArtifactViewShape` — the
schema and per-`as` key rules, minus the pointer-drift check, because an
endpoint has no published output schema). Pointers are RFC 6901 throughout, as
everywhere else in this document — not JSONPath. A panel that fails any check
is recorded under `/status.anomalies.configuration` and skipped; the rest of
its contributor still loads.

**Where panels come from.** `event-runtime/panels/*.panel.json` (built-in;
`inbox-open` ships as the proof), `<pack>/panels/*.panel.json` for a configured
pack (`lib/registry.mjs` loads them next to artifact views, origin
`pack:<namespace>`), and an extension's `contributes.panels` directories
([`extensions.md` § Panels](extensions.md#panels), origin `extension:<name>`).
`GET /panels` lists the accepted panels with `origin` and `file` plus the
endpoint allow-list; `lib/client.mjs` and `web/src/api.ts` mirror it as
`panels()`.

**Rendering.** `web/src/components/PanelGrid.tsx` reads `/panels` and mounts
one tile per panel below Overview's own content — nothing at all when there
are none. Each tile fetches its `source.endpoint` on its own TanStack Query
at `refreshSeconds`, applies `source.path`, and draws the node with
`ArtifactView`; a fetch that fails, a pointer that misses, or a render fault
shows an inline error tile (with Retry) and never takes the grid down. The
client also refuses to fetch an endpoint outside the list `/panels` returned.

---

## 3. Layer B — `factory.presentation/v1`

### 3.1 The contract

An optional `presentation` in `result.json`, beside `artifact`, exactly as
`decision` sits beside `reasonCode` (event-runtime-inbox.md §4.1):

```json
{
  "schemaVersion": "factory.presentation/v1",
  "blocks": [
    {
      "type": "heading",
      "text": "58 issues in Triage; 14 can be made agent-ready today"
    },
    {
      "type": "markdown",
      "text": "Most of the backlog is under-specified rather than wrong: 31 issues need Owned Paths, 9 need a verification command. Three need a product decision."
    },
    {
      "type": "keyvalue",
      "items": [
        {
          "label": "Recommendation",
          "value": { "$ref": "/recommendation" },
          "format": "state"
        },
        {
          "label": "Issues seen",
          "value": { "$ref": "/evidence/issuesSeen" },
          "format": "count"
        }
      ]
    },
    {
      "type": "list",
      "label": "Needs a human",
      "items": [
        {
          "text": "WM-312 — production infra; the ticket asks for two incompatible deploy paths",
          "ref": "/plan/7",
          "tone": "warn"
        },
        {
          "text": "WM-336 — tool allowlist; wants a security owner",
          "ref": "/plan/19",
          "tone": "warn"
        }
      ]
    },
    {
      "type": "table",
      "label": "Duplicates",
      "columns": ["Issue", "Duplicate of"],
      "rows": [
        [{ "$ref": "/plan/3/issueId" }, "WM-201"],
        [{ "$ref": "/plan/11/issueId" }, "WM-118"]
      ]
    },
    {
      "type": "section",
      "label": "Method",
      "collapsed": true,
      "blocks": [{ "type": "markdown", "text": "…" }]
    },
    {
      "type": "links",
      "items": [
        {
          "label": "Repo",
          "url": "https://github.com/watt-mind/factory"
        }
      ]
    }
  ]
}
```

Block vocabulary — closed, eight types:

| `type`     | Keys                                                                         | Bounds                             |
| :--------- | :--------------------------------------------------------------------------- | :--------------------------------- |
| `heading`  | `text`                                                                       | ≤ 120 chars                        |
| `markdown` | `text`                                                                       | ≤ 2 KiB; rendered, not interpreted |
| `keyvalue` | `items[]` of `{ label, value, format?, tone? }`                              | ≤ 16 items                         |
| `table`    | `label?`, `columns[]`, `rows[][]`, `formats?` (per column), `tone?`          | ≤ 6 columns × 50 rows              |
| `list`     | `label?`, `items[]` of `{ text, ref?, tone? }`                               | ≤ 30 items                         |
| `badge`    | `text`, `tone`                                                               | —                                  |
| `code`     | `text`, `language?`                                                          | ≤ 4 KiB                            |
| `section`  | `label`, `collapsed?`, `blocks[]` — one level of nesting only                | ≤ 20 child blocks                  |
| `links`    | `items[]` of `{ label, issue? \| pr? \| run? \| url? }` — exactly one target | ≤ 12 items                         |

Whole document ≤ 40 blocks, ≤ 16 KiB serialised. `format` and `tone` reuse the
Layer A vocabularies verbatim — one set of hues and formatters across both
layers.

### 3.2 Values are inline or pointers — and pointers are the point

Anywhere a value is allowed (`keyvalue.value`, `table` cells, `list.ref`,
`links` targets), the agent may write either a literal or
`{ "$ref": "<JSON pointer into artifact>" }`. Verification resolves every
pointer against the accepted artifact:

- A pointer that resolves is kept as-is; the renderer shows the resolved
  value and, on hover, the path it came from — "show source" is a first-class
  affordance, not a debug mode.
- A pointer that does not resolve is a validation error (§3.3).

This is the guard against the summary drifting from the data. A prose claim
in `markdown` is unverifiable by construction; every number, id, and verdict
the agent wants the reader to trust should be a `$ref`, and the brief says so.
Reading a presentation, the operator can tell at a glance which parts are the
agent's interpretation and which parts are the artifact talking.

### 3.3 Verification is tolerant on the ask

`verifyCompleted` and `verifyRefused` (`lib/verify.mjs`) validate
`candidate.presentation` when present:

- schema-valid, within bounds, every `$ref` resolves → `result.presentation`.
- otherwise → `result.presentationErrors[]`, `presentation` absent, and the
  run **still completes** — a run whose artifact passed must not fail because
  its summary was badly formed. The renderer shows Layer A with a one-line
  notice ("the agent's summary was dropped: 3 errors") and the errors in a
  disclosure, so a bad brief is visible and fixable rather than silent.

`presentation` is not part of the artifact hash and not part of the receipt's
evidence set. It is stored on the run result (`results.result_json`), which is
already where `decision` and `decisionErrors` go.

### 3.4 Rendering surfaces

- **Web** — `web/src/components/BlockRenderer.tsx` renders a
  `factory.presentation/v1`; it appears **above** the Layer A view in run
  detail, with its own Raw toggle. It never branches on the agent name.
- **CLI** — `cli.mjs inspect <runId>` linearises blocks to text (headings,
  bullets, `key: value`, tables as aligned columns, sections as indented) so
  the terminal reader gets the same summary. Pure function
  `lib/presentation-text.mjs`, testable.
- **Later, one vocabulary for three more surfaces** — the same blocks become
  `DecisionCard.context` (event-runtime-inbox.md §7, replacing raw markdown),
  the Telegram digest (linearised, truncated to the transport's limit), and
  factory status reports. Not in this epic; listed so nobody builds a second
  block system for those.

### 3.5 Who emits it, and the cost

Presentation is worth tokens only on **human-facing terminal outputs**: scans
(`triage-scan`, `merge-scan`, `work-scan`, `ship-scan`, `sweep-scan`,
`unblock-scan`), `dispatch`, `run-postmortem`, `factory-status-report`,
`ci-doctor`, `disk-diagnose`. The `*-apply` agents' output is read by the
chain, not by people; they do not emit one. It is optional everywhere and
opt-in per brief.

The pilot is `triage-scan` alone (§7). After a week of real runs, compare the
Layer B summary against the Layer A table on the same runs and decide whether
to roll the brief section to the other scans. The measure is blunt and
honest: does the operator open the raw view less.

### 3.6 Teaching agents to present well

A shared brief section (emitted from `shared/` like the decision section):
lead with the one-sentence finding as a `heading`; put every number, id, and
verdict you want trusted behind a `$ref`; use `list` with `tone` for the
things that need attention; put method and caveats in a collapsed `section`;
stay under the bounds; never restate the whole artifact — the table below you
already does that.

---

## 4. Layer C — canvas artifacts

The human ask: "Could we create canvas-like artifacts and render them in some
cases?" — richer, drawn output in the control tower, in the spirit of Claude
Artifacts / ChatGPT canvas.

Layers A and B are tables, badges, and bounded blocks. They are the right
shape for a triage plan and a merge verdict. They are the wrong shape for
"here is the causal chain of this failure" or "here is where the day's
context burn went." Those findings are pictures. Layer C is the picture:
one agent-produced document per result, three media types, stored
content-addressed, never consumed by the next agent, with the typed JSON
still one click away.

This section is design (WM-847). It is not operator-ratified with the rest of
this document. Implementation tickets in §7.2 wait on that ratification.

### 4.1 The contract — `factory.canvas/v1`

An optional `canvas` in `result.json`, beside `artifact`, exactly as
`presentation` sits beside `artifact` (§3.1) and `decision` sits beside
`reasonCode`. The envelope is metadata; the body is a **collected file
artifact** (`kind: "canvas"`) copied into `<home>/artifacts/<sha256>` at
publish time, the same store transcripts and reports already use
(event-runtime.md §7). Identical drawings collapse to one object; a result
row never references bytes that died with the workspace.

```json
{
  "schemaVersion": "factory.canvas/v1",
  "title": "How this run failed",
  "kind": "markdown",
  "sha256": "a1b2c3d4e5f6…",
  "bytes": 2340,
  "mediaType": "text/markdown"
}
```

The agent writes the body as a workspace file and declares it:

```json
{
  "artifacts": [{ "kind": "canvas", "path": "canvas.md" }]
}
```

Verification hashes the file and checks the envelope: it fills `sha256` /
`bytes` when omitted, and rejects (via the §4.3 tolerant path, not a failed
run) when they are present and disagree, when the envelope has no matching
`kind: "canvas"` file, or when a `kind: "canvas"` file has no envelope.

| Key             | Rule                                                                                                                                             |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `factory.canvas/v1`.                                                                                                                             |
| `title`         | Optional, ≤ 80 chars; falls back to the agent's output-schema title.                                                                             |
| `kind`          | Closed: `markdown` \| `mermaid` \| `svg`. One kind per canvas.                                                                                   |
| `sha256`        | 64 hex chars, the store key of the body bytes. Verification computes it; an agent-supplied value that does not match the file fails.             |
| `bytes`         | Byte length of the body. Must equal the file.                                                                                                    |
| `mediaType`     | Derived from `kind`, not authored: `text/markdown`, `text/vnd.mermaid`, `image/svg+xml`. An authored value that disagrees is a validation error. |

One canvas per result. Composition inside a `markdown` canvas is fences, not
a parts array: at most **four** mermaid fences and at most **two** svg
fences (info strings `mermaid` and `svg`); each fenced body is held to the
same source limits as a standalone canvas of that kind (§4.2). A `mermaid`
or `svg` canvas is the source itself — no wrapping markdown.

`canvas` is **not** part of `artifactHash`. The typed artifact remains the
chain's truth. The file is content-addressed on its own, like a transcript.
`additionalProperties: false` on the envelope.

### 4.2 Renderer constraints

The renderer is generic and never branches on the agent name. It draws three
media types. Everything else is dropped at verify.

**Markdown** (`kind: "markdown"`). CommonMark + GFM tables and strikethrough.
Headings, lists, quotes, fenced code, links whose scheme is `http`, `https`,
or `mailto` (plus the existing issue / pr / run chip matchers the rest of
the UI already uses). **No raw HTML** — today's `MarkdownView`
(`web/src/components/RunTrace.tsx`) already tokenizes to React nodes rather
than interpreting markup, and Layer C extends that parser; it does not add a
markdown-to-HTML pipeline. No images from URLs. No task lists (they look
like controls). Body ≤ 64 KiB UTF-8.

**Mermaid** (`kind: "mermaid"`, and mermaid fences inside markdown). Source
≤ 16 KiB. Allowed diagrams, closed: `flowchart`, `sequence`, `state`,
`pie`, `xychart`, `gantt`, `timeline` — the set a postmortem and an
economics chart actually need. Render with `securityLevel: "strict"` and
`htmlLabels: false`. Source must not contain `click`, `javascript:`, or
HTML tags; verification rejects the canvas rather than stripping silently,
so a brief that taught the agent to put a link-on-node is a visible
contract miss, not a quietly dead click. Mermaid runs in the web client
only (code-split, same as `@xyflow/react`); `lib/` never needs a DOM.
The rendered SVG is passed through the SVG sanitizer before it touches
the DOM, so a future mermaid that emits a `<script>` still does not run.

**SVG** (`kind: "svg"`, and svg fences inside markdown). Source ≤ 64 KiB.
`viewBox` required; rendered box ≤ 2000×2000. Element allowlist: `svg`,
`g`, `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`,
`text`, `tspan`, `title`, `desc`, `defs`, `clipPath`, `linearGradient`,
`radialGradient`, `stop`, `use` (same-document `#fragment` href only).
Attribute allowlist: geometric and paint properties (`d`, `cx`, `fill`,
`stroke`, `viewBox`, `transform`, …) plus `style` whose declarations are
themselves allow-listed (`fill`, `stroke`, `stroke-width`, `opacity`,
`font-size`, `font-family` from the UI's own stack, `transform`). Forbidden,
fail closed: `script`, `foreignObject`, `image`, `iframe`, `animate`,
`set`, `handler`, `listener`, `style` with `url(` or `expression(`, any
`on*` event attribute, `href` / `xlink:href` other than a same-document
fragment. No external fonts, images, or fetches.

**No scripts, no iframe, no network from the canvas.** That is the v1
security boundary, not a default that HTML later relaxes in place.

### 4.3 Security boundary and verification

Defense in depth, in this order:

1. **Schema and kind allowlist** at verify, before the store. Unknown
   `kind`, oversize body, mermaid source with `click` / HTML, SVG that
   fails the allowlist → `result.canvasErrors[]`, `canvas` absent. The
   run **still completes** — same tolerant path as presentation (§3.3).
   A run whose typed artifact passed must not fail because its drawing
   was badly formed. The renderer shows Layers A/B with a one-line notice
   ("the agent's canvas was dropped: N errors") and the errors in a
   disclosure.
2. **Sanitizer in `lib/`** (pure, no DOM) for SVG; mermaid source checks
   as (1). The bytes that enter the store have already passed.
3. **Store and `GET /artifacts/:hash`.** Canvas kinds are served with
   `Content-Type` matching the derived `mediaType`,
   `X-Content-Type-Options: nosniff`, and
   `Content-Security-Policy: default-src 'none'`. The web app never
   navigates to the artifact as a document; it fetches bytes and draws
   them. A browser that does open the URL gets nothing executable.
4. **Renderer.** Markdown tokenizes to React nodes. Mermaid output is
   sanitized SVG. SVG is parsed against the allowlist again, so a store
   object written before a sanitizer tightening still cannot grow a
   `<script>`.
5. **Never chain input.** `kind: "canvas"` is not a legal mapping source
   for a chain edge (registry refuses it at load, the way edges already
   refuse anything that is not the source run's `input` or `artifact`).
   Downstream agents keep reading the typed artifact. The drawing is not
   a second source of truth.

`canvas` is stored on the run result (`results.result_json`) next to
`presentation`; the file lives in the artifact store. It is not part of
the receipt's evidence set.

### 4.4 Rendering surfaces

- **Web** — a `CanvasPanel` above Layer B in run detail and on the
  Artifacts view when a canvas survived verify. Same **Raw** toggle the
  other layers have (source markdown / mermaid / SVG). The typed artifact's
  JSON remains one click away, unchanged — Raw on the canvas is the
  drawing's source, not a substitute for the artifact. The panel never
  branches on the agent name.
- **CLI** — `cli.mjs inspect <runId>` prints `title` and, for markdown /
  mermaid, the source as text. SVG prints `title` plus
  `(svg N bytes, open in web)` — a terminal is not a drawing surface.
- **Not Telegram, not DecisionCard.** Those stay on Layer B's blocks
  (§3.4). A canvas that cannot linearise honestly is not stuffed into a
  4 KiB push.

### 4.5 First adoption

Two targets, both already in the runtime's world, both whose useful output
is a shape rather than a table.

**`run-postmortem`.** The agent exists; Layer A already draws
`category` / `whatHappened` / `operatorAction` as prose and a badge
(`agents/run-postmortem.view.json`). The canvas is the causal picture the
prose is describing: a mermaid `sequence` or `flowchart` of agent → tool →
error → category, optionally wrapped in markdown whose heading is the
one-sentence finding. The typed artifact does not grow a diagram field —
the drawing is the canvas, the claims stay in `whatHappened` /
`evidenceLines`. A dropped canvas still leaves a readable Layer A view,
which is the whole point of the tolerant path. Pilot because operators
already open these runs to understand a graph, and because a bad drawing
must not fail a postmortem whose artifact passed.

**Economics.** `orchestrator/economics.mjs --json` is the data (totals,
per-harness, per-stage, context-burn, cache read:write). There is no
event-runtime agent today; the CLI stays the calculator. The canvas is not
a second calculator. The adoption path is a thin **command-result** agent
(`economics-report`) that runs that CLI, puts the JSON object in the typed
artifact (Layer A tables already know how to draw totals), and emits a
canvas of the _story_ — mermaid `xychart` or SVG of context-burn by stage,
markdown one-liner for the cache verdict ("prefix keeps invalidating").
Teaching `factory-status-report` to draw this is rejected: that agent
already has a job. A purely deterministic SVG generated from `--json`
without an agent would be Layer A (a new `as: chart` hint), not Layer C;
if the numbers-as-a-bar-chart is enough, that is a different ticket and
Layer C stays unused on economics, which is a fine outcome.

### 4.6 Deferred — `factory.canvas-html/v1`

Sandboxed HTML, later. A separate contract, not an extension of
`factory.canvas/v1`'s `kind` enum: HTML is a different trust model, and
mixing it into v1 would silently expand the v1 sanitizer's job.

The sketch, so the follow-up does not relitigate the shape:

- Body is still a collected file artifact, still content-addressed, still
  never chain input, still JSON one click away.
- Rendered in an `<iframe>` with `sandbox` **without**
  `allow-same-origin` (so even `allow-scripts`, if later granted, cannot
  touch the parent origin or the control API). `srcdoc` or a blob URL
  from the sanitized bytes — never a `src` to `/artifacts/:hash` that
  would put the artifact origin in play.
- CSP on the iframe: `default-src 'none'; img-src data:; style-src 'unsafe-inline'`
  at most. No network. No `postMessage` protocol that mutates factory
  state.
- Size cap in the same order as SVG (64 KiB). No `<script src>`, no
  inline event handlers; if scripts earn themselves they are a later
  tightening of _this_ contract, not a hole in v1.

**Why interactive controls are deferred — and stay deferred even when HTML
ships.** A control that changes factory state (approve, requeue, retry,
decide) is an inbox verb (event-runtime-inbox.md). Putting it inside a
drawing would be a second, untyped mutation surface the runtime cannot
audit. A canvas may _depict_ a decision; it may not _be_ one. The same
rule already sits in §6 for Layer B blocks. HTML does not punch through
it. The first HTML canvas that wants a button to approve a proposal is
the signal to put a `links` block or a decision request next to the
canvas, not a `postMessage` into `cli.mjs`.

HTML earns itself when an adoption target needs a drawing mermaid and SVG
cannot express (a filterable, read-only explainer). Until then the
iframe, the origin isolation, and the script question stay unbuilt.

### 4.7 Who emits it, and the cost

Canvas is worth tokens only when the finding is a shape. The two pilots
in §4.5 are the test. Scans with tabular plans stay on Layers A and B;
`*-apply` agents still emit nothing a person reads. Optional everywhere,
opt-in per brief, same as presentation.

A shared brief clause, when the pilots land: one document, one kind;
put claims you want trusted in the typed artifact, not in the drawing;
stay under the bounds; if mermaid is enough do not emit SVG; never
restate the Layer A table as a picture of the same rows.

---

## 5. Relationship to the inbox design

Same principle, different split:

|                                       | Inbox (WM-383)               | Artifact views (WM-452)                              |
| :------------------------------------ | :--------------------------- | :--------------------------------------------------- |
| What the agent authors                | the question and the options | the summary, the pointers, and (Layer C) the drawing |
| What the runtime owns                 | the effects (verbs)          | the artifact (truth), the layout, and the sanitizer  |
| Fallback when the agent's part is bad | default template per kind    | Layer A schema-derived view                          |
| Fail-closed on                        | the effect                   | the artifact, every `$ref`, and the canvas sanitizer |
| Never                                 | agent-invented effects       | presentation or canvas as chain input                |

Layer B's `format`/`tone` and, later, its blocks are shared with the inbox's
`DecisionCard`; the two designs are meant to converge on one renderer per
surface. Layer C does not join that vocabulary: a drawing is not a block,
and a block is not a drawing.

---

## 6. What is deliberately not decided here

- **Whether Layer B earns its keep at all.** The pilot decides. If the Layer A
  table plus the artifact's own `summary` string turns out to be enough, Layer
  B stays available and unused, and that is a fine outcome.
- **Whether Layer C earns its keep at all.** The two pilots in §4.5 decide.
  If postmortem prose plus Layer A is enough, and economics is happier as a
  Layer A `as: chart` (or a CLI the operator already has), Layer C stays
  available and unused.
- **Whether `factory.canvas-html/v1` ever earns itself.** §4.6 is a sketch,
  not a commitment. No HTML canvas is in the first implementation tickets.
- **Interactive blocks or canvases.** A block or drawing that _does_
  something (approve, requeue) is a decision request, not a presentation —
  it lives in the inbox design.
- **Per-agent renderers.** If a specific artifact needs a bespoke component
  (a graph, a diff), that is a `format` or a block type added to the closed
  vocabulary with a ticket, not a component keyed on the agent's name.
  Layer C's three media types are the escape hatch for "this is a picture";
  they are not a per-agent React tree.

---

## 7. Ticket map

### 7.1 Layers A and B

| Ticket | Section              | Owns                                                                                                                                                                                                                                                                  |
| :----- | :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WM-453 | all                  | this document                                                                                                                                                                                                                                                         |
| WM-454 | §2.1–2.3, §2.5       | `schemas/factory.artifact-view.v1.json`, `lib/artifact-view.mjs` (+ test: schema + path resolution), `lib/registry.mjs` (load `<name>.view.json`, refuse on drift), `lib/api.mjs` `/agents.outputView`, `agents/triage-scan.view.json`, `agents/merge-scan.view.json` |
| WM-455 | §2.4                 | `web/src/components/ArtifactView.tsx`, `web/src/lib/artifactView.ts` (+ tests), `RunDetailBlocks.tsx` + `views/Artifacts.tsx` integration, Raw toggle, `types.ts`/`api.ts`, `cli.mjs inspect` summary line                                                            |
| WM-456 | §3.1–3.3             | `schemas/factory.presentation.v1.json`, `lib/presentation.mjs` (validator + `$ref` resolution, + test), `schemas/factory.agent-result.v1.json` `presentation`, `lib/verify.mjs` tolerant path (+ test)                                                                |
| WM-457 | §3.4–3.6             | `web/src/components/BlockRenderer.tsx` (+ test), `lib/presentation-text.mjs` (+ test), `cli.mjs inspect`, shared brief section, `agents/triage-scan.md`+`.json` pilot, one-week comparison recorded on the ticket                                                     |
| WM-458 | §2.5, §3.4 (Backlog) | originally queued `agents/{dispatch,work-scan,run-postmortem}.view.json`; Layer A coverage moved to WM-898; retarget `DecisionCard.context` and the Telegram projection onto blocks after WM-392                                                                      |
| WM-897 | §2.1–2.2             | `input` / `subject` on the view contract, contract-keyed fallback `agents/views/<output_contract>.view.json`, `agents/dispatch.view.json` input+subject only                                                                                                          |
| WM-915 | §2.5                 | `agents/dispatch.view.json` output sections (`summary` `/summary`, `status` on `/outcome`, keyvalue for identity / verification / uxCritique) on the WM-897 input+subject sidecar                                                                                     |
| WM-898 | §2.1, §2.5           | Layer A sidecars for merge-apply/fix, work-scan, ship/sweep/unblock scan+apply, triage-apply, ci-doctor, run-postmortem, factory-status-report. Dispatch output sections and the shared `factory.command-result/v1` view wait on WM-897                               |
| WM-847 | §4                   | this Layer C section                                                                                                                                                                                                                                                  |

### 7.2 Layer C follow-ups (unfiled — file after §4 is ratified)

Do not implement from this document alone. File as children of WM-452 once
the operator ratifies §4; Owned Paths and verification commands belong on
those tickets, not here.

| Ticket (unfiled)         | Section    | Owns                                                                                                                                                                                                                         |
| :----------------------- | :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer C contract         | §4.1–4.3   | `schemas/factory.canvas.v1.json`, `lib/canvas.mjs` (envelope + mermaid source checks + SVG allowlist sanitizer, + test), `factory.agent-result.v1.json` `canvas` / `canvasErrors`, `lib/verify.mjs` tolerant path (+ test)   |
| Layer C store and API    | §4.1, §4.3 | collected `kind: canvas` in `lib/artifacts.mjs`, `GET /artifacts/:hash` `Content-Type` / `nosniff` / `CSP: default-src 'none'` for canvas media types, registry refusal of `kind: canvas` as a chain-edge input mapping      |
| Layer C web renderer     | §4.4       | `web/src/components/CanvasPanel.tsx` (+ test), mermaid code-split → sanitized SVG, SVG allowlist, `MarkdownView` mermaid/svg fences, Raw toggle, `RunDetailBlocks.tsx` + `views/Artifacts.tsx`, `cli.mjs inspect` title line |
| `run-postmortem` pilot   | §4.5       | brief clause, optional canvas (typed artifact unchanged), one-week comparison against Layer A-only recorded on the ticket                                                                                                    |
| `economics-report` pilot | §4.5       | command-result agent wrapping `orchestrator/economics.mjs --json`, Layer A sidecar on the JSON totals, optional canvas of context-burn / cache verdict                                                                       |

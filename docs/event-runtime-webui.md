# Event runtime web control plane

[`event-runtime/web/DESIGN.md`](../event-runtime/web/DESIGN.md) defines **why** the web UI exists—its operator, jobs, and product principles. This document defines **how** it is built and behaves: architecture, components, tokens, interaction rules, and runtime contracts.

Status: **implemented** (OPS-212) at `event-runtime/web/`. Tracking: OPS-209
(this spec), OPS-212 (implementation).

Parent: [event-runtime.md](event-runtime.md) | Roadmap: [event-runtime-webui-roadmap.md](event-runtime-webui-roadmap.md). §12 already decided the shape of
this app: the TUI/CLI is one client of the control API, and a web app is a
**second client of identical endpoints** — never a reader of the database.
This document specifies that second client: stack, decisions, view-to-endpoint
mapping, and exit criteria. Nothing here changes the runtime's contracts.

---

## 1. Decisions

Made by the operator, recorded here so nobody relitigates them mid-build:

- **Stack: Vite + React 19 + Tailwind v4 + cmdk.** The target aesthetic is
  Linear's: dense dark lists, a side detail panel, keyboard-first navigation,
  a ⌘K command palette. `cmdk` carries the palette and TanStack Query handles
  fetching and polling. This bullet originally named **shadcn/ui (Radix +
  Tailwind)** as the shortest honest path to that look; **it was never
  installed.** `package.json` declares no `shadcn` and no direct
  `@radix-ui/*` dependency, there is no `components.json`, and no module
  under `src/` imports a Radix primitive. What displaced it is §5.1: every
  surface, border, and text shade is derived from three OKLCH tokens, so
  generated components would have had to be rewritten down to those variables
  before they were usable, and the widget set this app actually needs is
  small enough to own outright. It lives hand-rolled in
  `src/components/ui.tsx` — `StateBadge`, `StatTile`, `ListPane`,
  `DetailPane`, `ListEmpty`, `FilterInput`, `Section`, `KV`, `Disclosure`,
  `JsonBlock`, `Button`, `Dialog` (with its own focus trap and Tab cycle),
  `Countdown`, `Ago`, `JumpLink`, and the toast region. Radix _primitives_
  are still in the lockfile only transitively beneath `cmdk`; the one direct
  Radix dependency is `@radix-ui/react-icons`, the attribute-icon set (§5.2
  tier 4, WM-482) — icons, not components. Two later additions round the
  stack out: `@xyflow/react` + `elkjs` for the graph canvas (§10.13,
  code-split off the entry chunk) and `@fontsource-variable/inter` for
  §5.1's typeface.
- **No authentication.** This narrows §14's "the web-app step requires real
  auth" to its actual precondition: auth is required _when approval and cancel
  become network-reachable_. They do not. The web server binds `127.0.0.1`
  only, exactly like the control API (`API_HOST` in `lib/config.mjs`), so the
  trust surface is unchanged: local user access. The actor recorded on verbs
  stays `"operator"`, same as the CLI. If this surface is ever bound beyond
  loopback — Tailscale, LAN, anything — that is the moment §14's auth
  requirement applies, as a precondition of that change, not a retrofit after
  it.
- **TypeScript, confined to `event-runtime/web/`.** The repo's plain-`.mjs`
  convention continues to govern all runtime code. The web app is leaf UI code
  with its own toolchain, never imported by the runtime. The original reason
  was that shadcn/ui generates TSX; with shadcn gone the decision stands on
  its own merit — `src/types.ts` is the typed mirror of every control-API
  response, and `bun run build` runs `tsc --noEmit` before Vite, so a field
  the API renamed fails the build instead of rendering `undefined` in a
  panel.
- **Polling, not push.** The control API has no event stream, and the worker
  fleet (OPS-233 onward — several processes may register at once) reports
  itself by heartbeat rather than by push: a worker's `lastSeen` is never
  fresher than its last beat, so the UI is polling something that is already
  polled. TanStack Query polling every 2 s on focused views is honest and
  sufficient at this scale. An SSE endpoint is a deferred follow-up, not a
  dependency.

## 2. Non-goals

- No authentication, sessions, or multi-operator identity (see above).
- No new mutation surface except the loopback janitor verb
  (`POST /repos/:name/janitor`, OPS-301): Dry and Apply, 127.0.0.1, actor
  `operator`, same trust as typing `factory janitor` on the machine. Apply
  never passes `--force`. The Projects-view buttons (typed confirm, Dry
  before Apply) shipped as OPS-362 (§10.14); this bullet records the API
  exception they use. Everything else the UI exposes is still approve,
  reject, cancel, retry, replay — including Projects' Quick Dispatch
  (OPS-369), which is an inject through `POST /replay` and therefore adds no
  surface, only a shortcut to it.
- No database access, no imports from `event-runtime/lib/`.
- No SSE/WebSocket work in the first version.
- No transcript/artifact _content_ viewer — **superseded, the non-goal no
  longer holds.** The reasoning was sound at the time: `GET /runs/:id`
  returned the retained workspace _path_, a browser cannot read local paths,
  and an artifact-fetch endpoint is new API surface. Both halves then got
  built, in the order the reasoning implies — the content-addressed store
  and `GET /artifacts/:sha256` first (§7), an **Open** link into it second,
  and finally an in-panel preview for text-shaped artifacts (OPS-277). §10.5
  is the shipped behaviour; `cli.mjs inspect` is still the deeper tool, but
  it is no longer the only one.
- No involvement in the emit pipeline or `shared/`. The control API may
  spawn `factory janitor` for the Projects verb (OPS-301); the web app still
  does not import the orchestrator.

---

## 3. Architecture

```text
browser (localhost)
   │
   ▼
web server — Bun, 127.0.0.1:7382 (FACTORY_EVENT_WEB_PORT)
   ├── serves static bundle from event-runtime/web/dist/
   └── proxies /api/* → control API 127.0.0.1:7381
                              │
                              ▼
                    existing lib/api.mjs — unchanged trust model
```

- `event-runtime/web/serve.mjs` — ~50 lines of `Bun.serve`: static files plus
  an `/api/*` proxy that strips the prefix and forwards to
  `127.0.0.1:${FACTORY_EVENT_PORT}`. A separate process, started explicitly
  (`bun event-runtime/web/serve.mjs`); stopping it affects nothing else.
  The proxy exists so the browser has one origin — it adds no headers, no
  rewriting, no logic.
- `event-runtime/web/src/` — the Vite + React app.
- `event-runtime/web/dist/` — build output, gitignored. `bunx vite build`
  produces it; `serve.mjs` refuses to start without it (with a message naming
  the build command) rather than serving a stale or empty directory.
- Dev loop needs no `serve.mjs`: `bunx vite` with a dev-server proxy entry for
  `/api` pointing at 7381.

The runtime remains startable, stoppable, and fully operable without the web
app. The CLI loses nothing.

## 4. Views

Four views were specified; nine shipped (`src/views/`). This section is the
four the spec planned — Overview, Proposals, Runs, and Inject, the last of
which shipped as a dialog reachable from anywhere rather than a view of its
own. §10 covers the rest as each arrived: Events (§10.1), Agents (§10.6),
Workers (§10.9), the full-page run view (§10.11), Graph (§10.13), and
Projects (§10.14). Eight of them own a nav-rail entry; the full-page run view
is reached from Runs, not from the rail. All nine are still thin projections
of existing endpoints.

Layout is Linear's three-zone shape: a narrow left nav rail, a dense list,
and a right-side detail panel that opens without leaving the list. The panel
is `DetailPane` in `src/components/ui.tsx` — hand-rolled, not a shadcn
`Sheet`, per §1.

### 4.1 Overview — `GET /status`, `GET /health`

The landing view. Stat tiles for event counts by status (`admitted`,
`planned`, `noop`, `human_needed`, `dead_lettered`), open/expired proposal
counts, and runs by FSM state. Below them, the **doctor panel** — the §13
anomalies rendered as a list, empty state included: expired open proposals,
ambiguous open proposals, stale leases, unpublished outbox rows, and dead-lettered
events with their `lastError`. A dead-letter row offers **replay** (`POST /replay`
with the stored envelope — which requires the UI to have the envelope body; see §7).

`GET /health` drives a connection indicator in the nav rail: green with the
reported `policyVersion`, red "runtime unreachable" when polling fails. Every
view keeps working read-only from cache when the runtime is down; verbs
disable.

### 4.2 Proposals — `GET /proposals`

The centerpiece (§12: watched approval). A dense table of open proposals:
agent, decision, TTL as a **live countdown** (computed from `created_at` +
`ttl_seconds`), and an `expired` badge once past TTL. Row click opens the
detail panel showing **the full immutable `RunSpec`, rendered raw** — agent
and version, input, `inputHash`, capabilities, timeout, attempts,
`idempotencyKey`, workspace type — plus the planner's reason. §12 is explicit
that the operator approves a specific spec, not a summary of one; the spec
JSON therefore sits in a disclosure that defaults open while the proposal is
undecided, so it is in front of the operator without being asked for. Once the
proposal is decided the panel is an audit record rather than something to act
on, and the disclosure defaults closed.

Verbs:

- **Approve** — `POST /proposals/:id/approve`. On `{approved: true, runId}`,
  navigate to the run. On `{approved: false, replanned: true, proposal}` — the
  TTL-expiry re-plan path — the UI must **stop and present the new proposal**,
  visually diffed against the one the operator just approved. It never
  auto-approves the replacement; that would silently execute intent the
  operator did not read, the exact thing §12's TTL exists to prevent.
- **Reject** — `POST /proposals/:id/reject` with `{reason}`. The UI requires
  a non-empty reason even though the API tolerates its absence: rejections
  are audit records, and "(no reason)" is a useless one.

Both verbs surface `404` (unknown proposal) and `409` (already decided) as
inline errors and refetch — a second browser tab or the CLI may have acted
first.

### 4.3 Runs — `GET /runs`, `GET /runs/:id`

List with FSM state filter tabs (the `?state=` parameter): run ID, state
badge, agent, attempts, created/updated. State badges use one fixed color
map for the closed §8 lifecycle — proposal-to-terminal — so a state is
recognizable at a glance across every view.

The detail panel shows the five blocks `GET /runs/:id` returns:

- **run** — state, attempts, `idempotencyKey`, `specHash`, and the full spec
  in a disclosure that defaults open (same raw rendering as proposals);
- **lifecycle** — the journal as a vertical timeline: state → state, actor,
  reason code, attempt, timestamp. This is the audit trail; it is the point
  of the page;
- **attempts** — per-attempt rows with lease expiry and workspace path;
- **result** — terminal state, reason code, the artifact JSON, and declared
  evidence when present;
- **receipt** — the compact §9 receipt: hashes and verification status.

Verbs: **cancel** (`POST /runs/:id/cancel`, confirm dialog, optional reason)
and **retry** (`POST /runs/:id/retry`). Retry past `maxAttempts` requires the
`{force: true}` body; the UI exposes force-retry only behind an explicit
confirmation that states it overrides the attempt budget and is recorded.
`409` (`IllegalTransition`, `attempts_exhausted`) renders as an inline
explanation, not a toast that evaporates.

### 4.4 Inject — `POST /replay` (templates: OPS-214)

Dev parity with `cli.mjs inject`: a dialog with a JSON textarea for an event
envelope, client-side-validated against the envelope shape before submitting.

**Templates are derived, never hand-maintained (OPS-214).** One chip per
registered event type; the payload skeleton is built from that event's agent
_input schema_ (required fields only; enums seed their first value, numbers
their minimum, `minItems` arrays one element, patterned strings a
recognisable placeholder). A newly registered event type therefore appears
with no UI change, and a template can never propose a payload the runtime
would reject for shape. Ids and `occurredAt` are generated per dialog
opening; the JSON stays fully editable — the template is a starting point,
not a cage. An unregistered `type` warns once (it is admissible, but parks
as `human_needed`) and injects on the second click. The Events view offers
**Trigger again**, which clones an envelope under a _fresh_ identity —
deliberately distinct from Replay, which reuses the delivery id and dedups
to a no-op.
The response distinguishes `admitted` from `duplicate` — a duplicate is a
success ("§5.1 working as designed"), displayed as such, not an error.

## 5. Keyboard and command surface

Linear's feel is keyboard-first; this is a requirement, not garnish.

- `⌘K` — cmdk palette: navigate to any view, jump to a run/proposal by ID,
  and invoke the verbs valid for the current selection.
- `i` — inject event. `?` — keyboard cheatsheet. `c` — copy the selected id.
- `/` — focus the list filter. Esc in the filter clears it, then blurs.
  From Overview or Graph (no filter), `/` opens Events and focuses there.
- `j`/`k` or arrows — move list (and Graph node) selection; `Enter`/`o` —
  open detail panel; `Esc` — close it, then clear the filter.
- `[` / `]` — previous / next status tab (Events, Proposals, Runs). Changing
  tab closes the detail so a deep-linked row cannot yank the tab back.
- `⌘↵` — confirm inject (from the envelope textarea too).
- On a selected proposal: `a` approve (opens the confirm with the spec in
  view), `x` reject (focuses the reason field).
- `g o` / `g e` / `g p` / `g r` / `g f` / `g t` / `g w` / `g g` — go to
  Overview / Events / Proposals / Runs / Projects / Agents / Workers / Graph.
  Projects took `g f` because `p` and `r` were already Proposals and Runs.
  The status bar and the `?` cheatsheet render shortcuts cleanly (with full destination mapping in `?` and dynamic `g` chord overlay); OPS-311 additionally shows the armed
  `g` on screen while it waits for its suffix.
- Context strip toolbar (`role="toolbar"`): single Tab stop with roving
  tabindex among All / open repos / In flight. `Left`/`Right` arrows (and
  `Home`/`End`) move focus within the strip; `Enter`/`Space` activates the
  focused filter. On a focused closable repo tab, `Delete` or `Backspace`
  closes that tab without using the `×` button and returns focus to the active
  tab, without stealing `[`/`]`, `g`, `j`/`k`, or list verbs.
- Every verb the palette offers checks current state first — it never shows
  "approve" on a decided proposal or "cancel" on a terminal run.

### 5.1 Design language

Grounded in what Linear published about its own 2024 redesign
([how-we-redesigned-the-linear-ui](https://linear.app/now/how-we-redesigned-the-linear-ui),
[a-design-reset](https://linear.app/now/a-design-reset)) — adopted here as
constraints, not vibes:

- **Three theme tokens, OKLCH, derived shades.** Linear replaced ~98
  hand-picked variables per theme with three — base, accent, contrast — and
  generates every surface, border, and text shade from them in a perceptually
  uniform color space. We do the same: three `oklch()` tokens as CSS
  variables (Tailwind v4 is OKLCH-native), with light, dark, and a
  high-contrast variant _computed_, never hand-tuned per theme. Dark is the
  default; the others come for free by construction, which is the whole
  point.
- **Neutral chrome, meaningful color.** Keep chroma out of the chrome: nav
  rail, headers, borders, and row hover states are near-zero-chroma grays
  derived from the base token. Hue appears only where it carries meaning —
  the FSM state badges, the connection dot, and destructive confirmations.
  If a screenshot in grayscale loses information, color was doing structure's
  job.
- **Typography: Inter, Inter Display.** Inter at 13–14 px for body and table
  text, tight row height; Inter Display for the few headings and stat-tile
  numerals. Nothing else.
- **The inverted-L is the whole chrome.** Nav rail plus view header form an
  inverted L around the content, and Linear's redesign spent most of its
  effort on pixel-level alignment inside it — icons, labels, and counts on
  one consistent grid. Every list view uses the identical skeleton (header →
  dense list → right detail panel), so hierarchy and density never reset
  between views. The two views that are not lists keep the same frame around
  a different middle: Graph swaps the list for a canvas (§10.13) and the
  full-page run view swaps it for a two-column reading layout (§10.11), both
  still built from the same `DetailPane` and the same header grid.
- **Stress-test before ship.** Linear validated against three axes —
  environment, appearance, hierarchy — rather than a formal method. The
  implementation ticket's hallmark critique pass adopts the same axes:
  window sizes and platforms; all three generated themes; and whether run
  state reads at a glance from two meters. The reset post's one transferable
  lesson is that piecemeal polish reads as disjointed because user journeys
  are unpredictable — hence tokens and the shared view skeleton are defined
  once, first, and everything renders through them.

The target is "quiet tool you live in", not "dashboard demo".

### 5.2 Iconography, glyphs, and color application (WM-133)

§5.1 gives the palette machinery; this section gives the rules for _applying_
it, plus the icon/glyph system. It exists because a 2026-08-14 audit found the
predictable drift: three syntaxes for the same hue, six ad-hoc wash strengths,
state hues borrowed for team identity, and unicode glyphs chosen locally with
no shared set. Every rule below is checkable in review.

#### Three visual tiers — use the lowest that works

1. **Text.** The default. Verbs are words ("clear", "add", "collapsed"), not
   icons. If a word fits in the space, no glyph and no icon.
2. **Approved unicode glyphs.** A _closed_ set, each with exactly one meaning:

   | Glyph     | Meaning                     | Where                                            |
   | --------- | --------------------------- | ------------------------------------------------ |
   | `▶`       | collapse/expand chevron     | `GroupHeaderRow` only — 9px, `rotate-90` on open |
   | `→`       | transition / direction      | lifecycle spans (`QUEUED → RUNNING`), feed transitions, sort orders |
   | `×`       | dismiss/remove this item    | chips and tokens only — never "failed"           |
   | `↑` / `↓` | sort direction              | `Th` header cells only                           |
   | `·`       | inline metadata separator   | footer/status lines                              |
   | `…`       | truncation / "more follows" | labels, placeholders (`add…`), loading copy      |
   | `⌘` etc.  | keyboard hints              | inside `<kbd>` or `.mono` spans only             |

   Rules: always `aria-hidden` (the control carries the accessible name);
   never a glyph as the _only_ content of an interactive element without
   `title` + `aria-label`; **no emoji anywhere** in the UI. Adding a glyph to
   this table is a spec change, not a local decision.

3. **State icons — inline SVG.** The only tier for _state_ iconography, per
   OPS-498: 14px viewBox, 1.5px stroke (matches the app's hairline weight),
   `currentColor` fill/stroke so the hue system does the coloring,
   shape-coded per lifecycle state (dashed circle = proposed, half-disc =
   running, disc+check = completed, disc+× = failed, …). Icons sit **left of
   the text label at `gap-1.5` and never replace it** — shape is redundancy
   for color-blind and peripheral reading, not a substitute for words. State
   shapes stay hand-rolled in `StateIcon` (`ui.tsx`): the set is closed and
   each shape encodes one lifecycle meaning; a library glyph would not.

4. **Attribute icons — `@radix-ui/react-icons`** (WM-482, 2026-08-17). For
   _what a thing is_, not _what state it is in_: the workspace, model tier,
   timeout, adapter, capabilities of a definition. Radix Icons is the one
   sanctioned package — 15×15 viewBox, ~1px optical weight, `currentColor`,
   tree-shaken per-icon imports (`import { TimerIcon } from
   "@radix-ui/react-icons"`). Rendered at **14px** (`size-3.5`) next to
   12–13px body text — the 15-grid glyph at 14px sits at the label's own
   optical weight, which is the point: it must not out-shout the word. Rules:

   - An attribute icon **leads its label** (`KV icon=`, `gap-1.5`) and the
     label is always present. Icon-only attribute rows do not exist.
   - It takes the label's color (`--text-faint` in `KV`), never a state hue.
     Hue still means state (below); an attribute icon in `--hue-err` is a
     state claim it cannot back.
   - **One glyph, one meaning, app-wide — resolved by label, never by hand.**
     The registry is `components/attrIcons.tsx`. A `<Section icons>` opts
     its `KV` rows in; each row looks its glyph up by normalised label
     (`modelTier` ≡ `model tier` ≡ `model-tier`; `input.<field>` ≡ `input`),
     so `adapter` wears the same icon on Runs, Workers, Agents, and Proposals
     by construction (WM-483). Views do not pass `icon=` themselves except to
     override deliberately. Current map:

     | Glyph              | Attribute(s)                                                        |
     | ------------------ | ------------------------------------------------------------------- |
     | `PersonIcon`       | agent, decided by                                                   |
     | `Component1Icon`   | adapter                                                             |
     | `Pencil1Icon`      | mutating                                                            |
     | `CubeIcon`         | workspace                                                           |
     | `LockClosedIcon`   | capabilities                                                        |
     | `DesktopIcon`      | host, hosts                                                         |
     | `CodeIcon`         | command                                                             |
     | `ListBulletIcon`   | actionRegistry                                                      |
     | `PlayIcon`         | execution, execution mode                                           |
     | `SewingPinIcon`    | placement                                                           |
     | `GearIcon`         | worker (the entity; `workerId` is an id and stays unmapped)          |
     | `TargetIcon`       | target                                                              |
     | `LightningBoltIcon`| model tier                                                          |
     | `Crosshair2Icon`   | model, model override, model (pinned) — an exact model id           |
     | `EyeOpenIcon`      | model (observed)                                                    |
     | `TimerIcon`        | timeout                                                             |
     | `ReloadIcon`       | attempts                                                            |
     | `LapTimerIcon`     | ttl, proposal ttl, cadence — an interval, not a moment              |
     | `FileTextIcon`     | input, input.*                                                      |
     | `PaperPlaneIcon`   | origin event, event type, type, planned/admitted events             |
     | `EnterIcon`        | source — where an event came in from; distinct from its type        |
     | `ChatBubbleIcon`   | reason, proposal reason, planner reason                             |
     | `CheckCircledIcon` | approval                                                            |
     | `ClockIcon`        | created, updated, occurredAt, receivedAt, admittedAt, startedAt, stoppedAt, decided at, last fire, last completed, next due — a moment |
     | `LoopIcon`         | loop, loop name                                                     |
     | `UpdateIcon`       | catch-up                                                            |
     | `ArchiveIcon`      | repository                                                          |
     | `GitHubLogoIcon`   | GitHub                                                              |
     | `CommitIcon`       | base branch, deploy branch                                          |

     Add to this table in the same PR that adds the registry row.
   - Identity rows (`id`, `run`, `version`, hashes, keys, contract) and
     state rows (`state`, `status`, `decision` — those carry a `StateBadge`)
     are **not** in the registry. Inside an iconed section they get an empty
     reserved slot, so label text starts at one x down the whole section.
   - `aria-hidden` on the slot; the label carries the name.
   - Still no icon font, and no second icon package: one library keeps the
     stroke weight and the visual language uniform.

   The nav rail stays **text-only** deliberately. An icon rail is deferred
   until the label list outgrows the 52-width rail — icons there would be
   decoration, and decoration is what §5.1 forbids.

#### Color application

- **Hue means state, never identity.** The six semantic hues — `--hue-ok`,
  `--hue-warn`, `--hue-err`, `--hue-info`, `--hue-verify`, `--hue-idle` — are
  reserved for lifecycle/status meaning. Teams, repos, environments, and
  other identities must not borrow them: green must not mean "COMPLETED" in
  one view and "CLNT team" in the next. (The Projects team map is the known
  violation; identity color, if ever needed, gets its own derivation, not
  these tokens.)
- **Hue maps live in `components/ui.tsx` only** (`STATE_HUES`,
  `EVENT_STATUS_HUES`, `PROPOSAL_STATUS_HUES`, `DECISION_HUES`). Views import
  them; a view file defining its own `Record<string, hue>` is a review flag.
- **Wash strengths are fixed, not vibes.** Backgrounds mix the hue into
  transparency at exactly these strengths:

  | Strength | Pattern                                          |
  | -------- | ------------------------------------------------ |
  | 6%       | full-row wash (`row-wash-err`/`-warn`)           |
  | 8%       | banner/callout fill (paired with hue border)     |
  | 10%      | inline error block (`VerbError`)                 |
  | 12%      | badge/chip fill (`StateBadge`)                   |
  | 15–16%   | selection and env-chip fills (accent, not state) |

  A new component picks the row of this table it belongs to; it does not
  invent 9% or 14%.

- **One syntax per situation.** Static token color uses Tailwind v4
  parenthesized form: `text-(--hue-ok)`, `bg-(--surface-2)`. Runtime-computed
  hues use inline `style={{ color: hue }}`. The bracketed legacy form
  `text-[color:var(--hue-warn)]` is banned in new code — three spellings of
  the same thing is how grep-ability dies.

#### Dot anatomy — three dots, three meanings

- `size-1.5`, no halo — the dot _inside_ `StateBadge`; part of the badge, not
  freestanding.
- `size-2` + 18% halo ring — section/group identity dot (`GroupHeaderRow`).
- `size-2` + `animate-pulse` — **liveness only** (connection indicator,
  active-attention banner). Pulse means "happening now"; a static state never
  pulses.

#### Icon placement grammar (WM-187)

Where an icon or glyph may sit, relative to the text it belongs to. Anything
not in this table is not a placement.

| Context                    | Position                  | Rule                                                                                                           |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| State badge / status label | leading, `gap-1.5`        | Icon then word. Never trailing, never alone.                                                                   |
| `KV` label (attribute icon)| leading, `gap-1.5`        | Icon then label, in the label column, label color. `<Section icons>` opts a section in; every row then resolves from `attrIcons.tsx` by label and unmapped rows keep an empty slot. |
| Button                     | leading only              | A trailing glyph is reserved for one meaning: `…` = "opens a dialog". Nothing else trails.                     |
| Table cell                 | leading, baseline-aligned | Same column as its text; a cell is never icon-only unless the header names the meaning and `title` repeats it. |
| Section / group header     | between chevron and label | Chevron → dot/icon → label → count, in that order (`GroupHeaderRow`).                                          |
| Nav rail                   | none                      | Text-only until the rail outgrows its labels; a leading icon column is the _only_ shape it may take then.      |
| Keyboard hint              | trailing                  | Style depends on container — see "Keyboard hints" under §5.3. Never inline in prose.                           |

Icons and glyphs sit **on the text baseline** and take the text color of
their label (`currentColor`); an icon lighter or brighter than its own label
is a bug.

#### Sizing scale

Icon size follows the type size next to it — it is never set independently:

| Text size        | Icon | Where                                            |
| ---------------- | ---- | ------------------------------------------------ |
| 11px (badges)    | 12px | `StateBadge`, table cells, chips                 |
| 12–13px (body)   | 14px | Default. Buttons, list rows, KV labels and values (Radix attribute icons render at 14px too) |
| 14–15px (titles) | 16px | `DetailPane` title, `Dialog` title, empty states |

Chevrons and sort arrows are the exception: 9px, because they are affordance
punctuation, not content.

#### Interactive states for icons and glyphs

Two "reveal on hover" idioms exist today; from here there is one per case:

- **Affordance that is always present** (chip `×`, palette hints): rendered
  at `--text-faint`, rises to `--text` on the parent's hover/focus via
  `group-hover:` — never hidden.
- **Affordance that is contextual** (sort arrow on an unsorted column, JSON
  copy button): `opacity-0` → `group-hover:opacity-50` → `opacity-100` when
  active. Reserved for controls that would add noise if always shown.
- **Disabled**: the whole control takes `opacity-40` + `cursor-not-allowed`
  (as `Button` does); the icon is not dimmed separately.
- **Focus**: the ring belongs to the control (`:focus-visible` outline in
  `theme.css`), never to the icon.

#### Text on hue washes

Text on a hue wash is **always the hue itself** (`color: hue` on a 12% wash
of the same hue), never `--text` or `--text-dim`. The derived hues share the
accent's lightness/chroma, so this reads on all three themes in dark and
light; in `contrast` the wash goes very faint and the hue text carries the
whole signal — that is fine, but it means **check every new hue usage in all
three themes** (the §5.1 appearance axis), not just the default.

#### Empty, loading, and error states

Text only. `ListEmpty` is the standard: one line of copy, an optional
follow-up hint, an optional single action. No illustration, no icon, no
emoji, no "sad state" art. Loading copy is `Loading <noun>…`; error copy
names the dependency that is down. A spinner is not used anywhere — the 2 s
poll (§6) makes staleness the honest signal, not motion.

- **Zero-count legends**: Zero-count items in a telemetry legend sit at `--text-faint`
  (at 60% opacity) or collapse cleanly to an honest empty line (e.g. `nothing in flight`,
  `no terminal runs`) rather than drawing empty visual noise.

#### Accessibility for icons, glyphs, and telemetry meters

- Decorative (has an adjacent visible label): `aria-hidden="true"`. This is
  the normal case and should be nearly the only case.
- Meaningful (no visible label — avoid, but if it exists): `role="img"` +
  `aria-label`, and the parent control also gets `title` for sighted hover.
- **Stacked visual meters & telemetry bars**: Visual bars (`SegmentMeter`) are
  `aria-hidden="true"`; their associated legend items are the interactive and
  accessible keyboard/screen-reader surface. Every interactive tick or item
  carries a complete `aria-label` and `title`.
- Never convey a state by icon or hue alone: the word is always present
  (`StateBadge` renders `{state}`; the group header renders `label`).
- Motion: `animate-pulse` is the only animation and it must be wrapped so
  `prefers-reduced-motion: reduce` disables it (Tailwind
  `motion-safe:animate-pulse`). Existing bare `animate-pulse` uses are debt.

#### Adding an icon or glyph — checklist

Before a PR introduces one, in this order:

1. Would a word do? Then use the word.
2. Is it in the approved glyph table? Use exactly that glyph for exactly that
   meaning. If not, and it is a state, it is an OPS-498 SVG icon. If it names
   an attribute, it comes from the tier-4 registry (`attrIcons.tsx`) via
   `<Section icons>` — add a registry row + table entry in the same PR rather
   than passing `icon=` by hand. If none of these, this section
   changes first (own PR), then the code.
3. Does it appear in at least two places, or is it a one-off decoration? A
   one-off is not added.
4. Placement matches the grammar table; size matches the scale table.
5. `aria-hidden` and a text label are present.
6. Rendered and checked in all three themes.

Reviewer version (grep-able): no emoji, no `text-[color:var(`, no
`color-mix` percentage outside the wash table, no `Record<string, "var(--hue`
outside `ui.tsx`, no `animate-pulse` without `motion-safe:`, no icon-only
control without `aria-label`.

#### Worked examples

From the codebase, so the rules are concrete:

- **Identity borrowing a state hue** — `views/Projects.tsx` `TEAM_HUES` maps
  `CLNT` → `--hue-ok`. In Runs, that green means COMPLETED. Fix: teams get a
  neutral `Pill` (or an accent-derived identity treatment that is none of the
  six state hues). WM-134.
- **Two spellings of one color** — `text-[color:var(--hue-warn)]` in
  Workers/Overview versus `text-(--hue-warn)` elsewhere. Fix: the
  parenthesized form. WM-134.
- **A wash that invented its own strength** — `color-mix(... 14% ...)` on the
  Projects "report only" pill. Fix: 12%, the badge row of the wash table.
- **A glyph reused for a second meaning** — `×` means "remove this chip". It
  must not appear as a "failed" marker in a table cell; that is
  `--hue-err` + the word (and, after OPS-498, the disc+× icon).

### 5.3 Component conventions (WM-187)

`components/ui.tsx` is the component vocabulary; a view composes it and does
not re-invent it. These are the conventions the primitives encode, written
down so a new view can be checked against them.

#### The view skeleton

Every list view is `ListPane` (pinned chrome: title, `Tabs`, `FilterInput`,
`DisplayOptions`; scrolling table below) plus an optional `DetailPane` on the
right (§5.1). The chrome padding is `px-5 pt-5 pb-3`, the table area `px-5
pb-5`; the detail pane is `border-l bg-(--surface-1)` with a pinned title
row, its actions on their **own** wrapping row beneath, and one `close` slot
top-right (WM-97). A view that needs a different frame is a spec change
(§10.11 and §10.13 are the two that exist).

#### Tables

- Structure: `<table className="w-full border-separate border-spacing-0">`,
  header via `Th` (sticky `top-0`, `h-7`, hairline as an inset shadow so the
  group headers can pin at exactly `top-7`), optional `GroupHeaderRow` bands
  under it.
- Cells: `px-3 py-1.5 border-b border-(--border)` — one row height across
  the app. (`Schedules` uses `py-2` today; that is debt, not a variant.)
  Numeric columns are `tabular-nums` and right-aligned via `Th align="right"`.
- Ids and machine values are `.mono`; prose columns are body text; secondary
  columns are `--text-dim`, tertiary `--text-faint`. Long values `truncate`
  inside a `max-w-*` with the full value in `title`; ids render through
  `shortId()` and keep the full id in `title` and on copy verbs.
- Row states: `.row-selected` (accent 16% + inset accent bar) wins over
  status washes; hover is `hover:bg-(--surface-2)`; status washes are
  `.row-wash-err`/`.row-wash-warn` at 6% and nothing else.
- Empty/loading/error rows are `ListEmpty` with `colSpan` = the column count.
- In-cell navigation is `JumpLink` (stops propagation, so it does not select
  the row). Bulk selection surfaces `BulkActionBar`, never inline buttons per
  row.

#### Filters and inputs

- The list filter is `FilterInput`: `w-56`, `/` to focus, Esc clears then
  blurs, facet autocomplete with hue dots for state values, active tokens as
  dismissible chips (the whole chip is the remove target). One filter box per
  view, in the chrome row, right of the tabs.
- Free text with suggestions is `SuggestInput`; string arrays are
  `ChipInput`. Both are `.mono` because they hold ids, repos, and paths.
- Inputs are `rounded-md border-(--border) bg-(--surface-1)` (or `-0` inside
  a `-1` panel), `text-[12px]`, `focus:border-(--accent)`, placeholder in
  `--text-faint`. No filled/underlined variants; no floating labels — a
  `<label>` above, `text-[11px] text-(--text-faint)`.

#### Tabs

`Tabs` is the segmented strip: `role="tablist"`, `text-[11px]`, active =
`bg-(--surface-3) text-(--text)`, disabled tabs stay clickable and explain
themselves via `title` (WM-76). Tabs switch _sub-views of one list_; they do
not navigate — navigation is the rail and `g` chords. `ContextTabs`
(operator-pinned runs, §10.12) is a different thing and lives above the
content, not in the chrome row.

#### Buttons and verbs

`Button` has exactly three variants: `default`, `primary`, `danger`.
`primary` is the one accent-filled action per surface (at most one visible at
a time); `danger` is text-in-`--hue-err` on a neutral fill — never a red
fill. Verb labels are verbs ("Approve", "Cancel run"), sentence case; a verb
that opens a dialog ends in `…`. Verb failure renders inline via `VerbError`
under the buttons (404/409 are normal, §6), never as a toast alone.

#### Keyboard hints (WM-209)

Visible shortcuts use two idioms; compact utility and standard dismiss
controls deliberately avoid another piece of visible text:

| Control or surface                                                                                         | Shortcut treatment                                                     | Why                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bordered, text-labeled control — especially an action `Button`, nav item, tab, or chip                    | trailing faint mono text: `mono ml-1 text-(--text-faint)`              | a box inside a box is noise; the control's border is already the container                      |
| Standalone or unbordered surface — input placeholder, ⌘K row, `?` dialog, footer legend                   | visible `<kbd>` box, 10px, `border-(--border)`                         | there is no container, so the box supplies one                                                  |
| Compact icon-only utility control — specifically `CopyActions` (WM-302)                                   | no visible text hint; put the chord in both `title` and `aria-label`   | labels or badges would turn a compact utility row back into a competing action toolbar          |
| Standard dismiss / close control                                                                          | no `Esc` badge                                                         | `Esc` is the global, standard dismissal path; the text label and accessible name remain `Close` |
| Prose or body copy                                                                                         | never                                                                  | a shortcut is surfaced by its control or callout, not described in surrounding prose            |

For a bordered text control, the visible hint is `aria-hidden` (the accessible
name is "Cancel", not "Cancel x"). For an icon-only `CopyActions` control,
the tooltip and accessible name include the shortcut instead (for example,
`title="Copy run id · c"` and `aria-label="Copy run id (c)"`). Every
nonstandard action with a single-key or explicit chord binding (including
`g …` navigation and `c …` copy chords) surfaces that binding using its row
above — no invented hints and none omitted — while the
standard `Esc` close exception remains unbadged. A verb reachable only through
⌘K shows no hint. Because hints are per-binding, grouping bound verbs together
(next rule) is what makes them read as deliberate rather than random.

#### DetailPane header actions (WM-209)

The pane header is three rows, and each row holds one kind of thing:

```
Runs / [● STATE]  run_xxxx                          [Close]
[Cancel x]                            [Expand o]  [Open in tab]
CopyActions: [id icon] · [CLI icon] · [link icon]
```

1. **Title row** — breadcrumb (`view / StateBadge id`) and the single
   `close` slot (WM-97). `Close` is not badged with `Esc`; dismissal is the
   standard global exception in the keyboard-hint table above.
2. **Verb row** — bordered `Button`s, **≤ 3**: lifecycle verbs on the left
   (`danger` leftmost, hidden — not disabled — when the state does not admit
   it), navigation verbs (Expand, Open in tab) on the right. This is where a
   lifecycle verb lives; it never floats between content sections.
3. **Utility row** — copy/share controls use the compact icon-only
   `<CopyActions />` component (WM-302), not text links or bordered buttons.
   Each icon button conveys its label and chord through `title` and
   `aria-label` (`c`, `c i`, or `c l`) rather than a visible hint. Anything
   here is also registered in ⌘K. Do not add a copy action for a value that
   `KV` already copies on click. A read-only pane may co-locate `CopyActions`
   with the identifier in the title row instead of rendering an otherwise
   empty utility row; it remains a utility control and follows the same
   tooltip/accessibility rule (as in Agents, §10.6).

Bordered buttons all carry equal visual weight, so five in a row is five
things claiming priority; the row split is what expresses hierarchy without
adding a fourth `Button` variant.

#### Dialogs (modals) and side panels

- Modal = `Dialog`: centered at `pt-[10vh]`, `w-[480px]` / `wide` 720 /
  `extraWide` 920, focus-trapped, Esc closes, backdrop click closes, title in
  `.display`. Used for **verbs that need input or confirmation** (inject,
  cancel-with-reason, shortcuts). Anything the operator reads while doing
  something else is not a modal.
- Side panel = `DetailPane`: reading surface for the selected row. There is
  no third "slide-over" pattern; if content does not fit the pane, it becomes
  the full-page run view (§10.11), not an overlay.
- Confirmations for destructive verbs use `Dialog` with the `danger` button
  and restate the target (`Cancel run run_ec9c87f9?`); no browser `confirm()`.

#### Chips, pills, badges

- `StateBadge` — lifecycle/status only, hue from the `ui.tsx` maps.
- `Pill` — read-only neutral value (`.mono`, `--surface-2`, `--text-dim`);
  identity and constants go here.
- Filter tokens / chip-input chips — dismissible, `×` trailing.
- Nav badge — count with hue wash; hidden from the accessible name and
  re-attached via `aria-describedby`.

Four things, four looks. A "badge" that is not one of these is a `Pill`.

#### Feedback

- Toasts (`notify`) are for **outcomes of verbs**: `ok`/`err`/`info`, 3 s,
  max 5, dismiss on click. `err` goes to the assertive live region. Never
  used for validation (that is `VerbError`) or for state changes the operator
  did not cause (that is the list updating).
- Banners (`Overview` attention block, `Workers` stale-heartbeat block,
  `RunFailureBanner`): hue border + 8% wash + pulsing dot, at the top of the
  content, for **conditions needing attention now**. One per view at most.
- Collapsible secondary payloads are `Disclosure` (`<details>`), label in
  `--text-faint`. Key/value facts are `KV` (copyable when a string).

### 5.4 Typography scale (WM-187)

§5.1 names the faces; this fixes the sizes. Today views use 10, 10.5, 11,
12, 13 and 15px ad hoc; from here the scale is:

| Size   | Role                                           | Face                   |
| ------ | ---------------------------------------------- | ---------------------- |
| 15px   | Dialog title                                   | `.display` semibold    |
| 14px   | View title, `DetailPane` title, brand          | `.display` semibold    |
| 13px   | Body: nav items, table body text, KV values    | Inter (`body` default) |
| 12px   | Dense body: buttons, inputs, toasts, list rows | Inter                  |
| 11.5px | Monospace values (`.mono`)                     | ui-monospace           |
| 11px   | Labels, badges, `Th`, hints, section headings  | Inter (`--text-faint`) |
| 10px   | `<kbd>` and keyboard hints only                | Inter                  |

Rules: `.display` only at 14–15px and stat-tile numerals (`text-xl`); nothing
below 10px; `10.5px` and other in-between values are debt. Table body cells
inherit 13px from `body` unless the column is `.mono` (11.5) or a
label-class column (11px `--text-dim`). Section headings are 11px uppercase
`tracking-wide --text-faint` (`Section`) — the only uppercase in the app
besides the env chip. Weights: `font-medium` for active/emphasis,
`font-semibold` for titles, nothing bolder.

#### Known debt (filed, not fixed here)

State-icon implementation is OPS-498. Syntax normalization, wash
normalization, and the Projects team-hue fix are WM-134. Table row-height
(`Schedules` `py-2`), sub-11px sizes, and bare `animate-pulse` are additional
WM-134 scope — this section is the standard they normalize _to_.

## 6. Liveness and concurrency honesty

- TanStack Query, `refetchInterval` 2 s on the focused view, paused on hidden
  tabs, single retry with backoff when the runtime is unreachable.
- Verbs invalidate affected queries on success rather than waiting for the
  next poll.
- The UI never assumes it is the only operator. The CLI, a webhook, or
  another tab can change state between poll and click; every verb therefore
  treats `404`/`409` as normal outcomes with a refetch, never as bugs. No
  optimistic updates for lifecycle transitions — a control plane that shows
  states the runtime has not confirmed is lying about the one thing it is
  for. 2 s of latency is fine; wrong state is not.

## 7. Control API additions

The web UI is a client, so anything it needs that the API lacks becomes API
surface first, UI second — implemented in `lib/api.mjs` with the same
read-only SQL discipline as `statusView`. The spec originally required
exactly one addition — `GET /events` — and the shipped surface (§10) grew
with the same rule applied each time. Additions to date, all loopback-only
and shared with the CLI:

- **`GET /events`** (`?status=`) — admitted events **with the stored envelope
  body**, plus the latest `proposalId` / `runId` for that origin (null until
  planned). Without the envelope, dead letters lack their body, the doctor
  panel's replay verb cannot work, and an inbox view is impossible; without
  the ids, an event is a dead end.
- **`GET /agents`** — the registered agent definitions and event routing
  (CLI `agents`; the registry-visibility surface, OPS-213).
- **`GET /journal`** (`?since=&limit=`) — the global lifecycle feed behind
  Overview's activity list.
- **`GET /outbox`** (`?limit=`) — emitted result events, the runtime's
  actual output.
- **`POST /events/requeue`** — re-plan a dead-lettered or `human_needed`
  event (CLI `requeue`); audited like every other verb.
- **`GET /repos`** — `config/repos.yaml` as an allow-listed registry (OPS-299).
- **`POST /repos/:name/janitor`** — loopback spawn of `factory janitor`
  `--json` for that one name (OPS-301). Body `{ apply: false | true }`;
  omitted `apply` is Dry. Apply never `--force`. Unknown name 404; Apply on
  a `report_only` repo without `worktree_down` 409. Actor `"operator"`. The
  UI confirm was OPS-362 rather than this endpoint, and shipped in the
  Projects view (§10.14).
- **`GET /artifacts/:sha256`** — content-addressed artifact/transcript bytes
  (the §8 deferral, since triggered and shipped).
- **`GET /workers`** — the worker registry the CLI `workers` command prints,
  each row carrying a `stale` flag derived from heartbeat age. The same
  projection widened `/status` with `workers.{live, busy, stale}` (live and
  busy both exclude stale) and the doctor with `stalledWorkers` and
  `noWorkers`.

Still explicitly _not_ added: pagination beyond `journal`/`outbox` limits
(volumes are tiny; first endpoint to hurt gets it) and SSE (§8).

## 8. Deferred, with triggers

| Deferred item                                     | Trigger                                                                                                                                                                   |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication + real actor identity              | Binding the web server or control API beyond loopback — precondition, not retrofit (§1, parent §14)                                                                       |
| SSE / push updates                                | Polling demonstrably too slow — e.g. watching slice-2 remediation runs live                                                                                               |
| ~~Artifact/transcript content endpoint + viewer~~ | **Shipped** — content-addressed artifact store + `GET /artifacts/:sha256` + transcript capture (§7), Open-in-tab and in-panel preview for text artifacts (OPS-277, §10.5) |
| Pagination on `/runs`, `/events`                  | First list where scrolling actually hurts                                                                                                                                 |
| Notification channel                              | Unattended stage (parent §12) — watched mode means the operator is watching                                                                                               |

## 9. Exit criteria

- Every §13 operator verb is available: status, proposals, approve, reject,
  cancel, retry, inspect-level detail (spec, lifecycle, result, receipt),
  replay/inject — each observably equivalent to its CLI counterpart, and each
  recorded by the runtime identically (actor `"operator"`).
- Approving an expired proposal surfaces the re-planned spec with a diff and
  requires a second explicit approval; it is impossible to approve a spec the
  UI has not displayed.
- Duplicate injection shows one admission (`duplicate: true`), one proposal,
  one run — the UI demonstrates §5.4 rather than obscuring it.
- Web server and app bind loopback only; stopping them affects nothing;
  `serve.mjs` imports nothing from `lib/`.
- A `409` from any verb (raced by the CLI) produces a correct, explained UI
  state, verified by acting from the CLI while the UI is open.
- Existing factory tests, emit checks, and `event-runtime` tests remain
  untouched and green; `GET /events` arrives with tests matching the other
  read endpoints' coverage in `cli.test.mjs`.

---

## 10. What shipped beyond the spec

The control API grew past §7's single addition (proposal↔event linkage,
proposal history, `GET /journal`, `GET /outbox`, `POST /events/requeue`,
environment identity on `/health`/`/status`), and the UI now consumes all of
it. Everything below follows §5's keyboard model and §5.1's design language
unchanged.

### 10.1 Events view (`#/events`, `g e`)

The event inbox is a first-class view, not just the Overview table it started
as. Status filter tabs (all / admitted / planned / noop / human_needed /
dead_lettered) over `GET /events?status=`, with counts from `/status` and a
client-side type/source/id filter. j/k selection, `#/events/:source/:eventId`
deep links, and a detail panel with identity KV rows, collapsed envelope
payload, and jumps to the latest proposal and run. Status is a badge (same
primitive as runs), not hue-only text; `human_needed` and `dead_lettered`
rows carry a status wash that yields to the selection ring. **Requeue** (`q`,
button, and ⌘K — `r` is off-limits as the `g r` navigation suffix) calls
`POST /events/requeue` for dead_lettered/human_needed events only — it
re-plans the already-admitted event and, once a new open proposal appears,
jumps to it the way Approve jumps to the queued run. **Replay through intake**
is behind a confirm: it re-injects the envelope (dedup demo), it does not
re-plan. `404`/`409` render inline per §6. Empty copy distinguishes loading,
unreachable API, and a genuinely empty inbox.

### 10.2 Proposals: origin + decision history

Each proposal shows its originating event (`eventId`/`eventSource` from the
API; the event type resolved from the shared events cache) as a jump to the
Events inbox, the agent ref as a jump to Agents, and the run id as a jump to
Runs. An **Open / History** tab pair: History is backed by
`GET /proposals?status=all` and is strictly read-only — decided proposals
with `status`, `decided_by`, `decided_at`, and the immutable spec, no verbs
ever offered on a decided row. Status and decision are badges (same primitive
as events/runs); expired and stale-run rows carry a status wash that yields
to the selection ring. Client-side filter, tab counts, Copy id, and
`#/proposals/:id` deep links (open tab first, then history). The TTL
countdown behaves as §4.2 specified.

### 10.3 Runs: enriched list + evidence

The list gains adapter, latest `reasonCode`, attempts as `n/maxAttempts`,
the origin `eventId` (a jump to the Events inbox), and the agent ref (a jump
to Agents). Failed and timed-out rows carry an error wash, refused a warning
wash; selection wins. Client-side filter (selecting a visible row keeps it;
it clears only when a deep-linked or jumped-to run is hidden by the filter,
or the status tab switches to All to surface that run), tab counts from
`/status`, Copy id, and a detail panel that opens while the run payload is
still loading. The
detail panel additionally renders the result's declared `evidence`
(collapsible pretty JSON, per §4.3's result block) and the origin event; `x`
cancels the selected run from the list, matching the proposals-view verb
convention. `#/runs/:id` deep-links to the runs view with that run selected.

### 10.4 Overview: dashboard

Stat tiles stay, and each is a jump (event status → that Events tab, open
proposals → Proposals, run state → that Runs tab). Added: (a) the **doctor panel** now links each anomaly to
its view (expired proposal → that proposal, stale leases → runs,
dead-lettered → that event's row on the Events dead_lettered tab, unpublished
outbox → scroll to the outbox feed) and offers requeue
directly on dead-letter rows — toast, poll for the new open proposal, jump to
`#/proposals/:id` (or an honest toast if none appears, same 8s budget as Events);
(b) a **live activity feed** off `GET /journal`
— first fetch seeds the latest entries, then each poll passes
`since=<last head>` and prepends only what is new, capped at 50 shown, each
entry rendered as `run · FROM → TO by actor (reason)` with a relative
timestamp, a state badge, and a jump-to-run link; empty copy distinguishes
loading, unreachable API, and a genuinely empty journal; (c) a compact **outbox feed** of the latest
result events from `GET /outbox`, unpublished rows flagged in the warning
tone, envelope behind a disclosure. Tiles, doctor, and outbox never say
"none" while the control API request is still pending.

### 10.5 Artifacts in run detail

`GET /runs/:id` result `artifacts` entries are durable
(`{kind, uri, sha256, sizeBytes}`, content-addressed store; real claude runs
include a runtime-captured `transcript` automatically). The run detail's
**Artifacts** section lists each with kind, human-readable size, short hash
(full hash on hover), and an **Open** link to `/api/artifacts/<sha256>` in a
new tab — the serve proxy forwards to the control API, which streams
`text/plain` for texty content and `octet-stream` otherwise. The trigger in
§8 ("first time opening the transcript matters from the browser") fired, and
the viewer at that point was the browser itself, not new UI. Empty state
shown when a result has no stored artifacts.

**In-panel preview (OPS-277)** finished lifting §2's non-goal, because a new
tab per artifact is the wrong shape for the thing operators actually do —
glance at a transcript while the run detail is still on screen. Rows whose
kind is text-shaped (`transcript`, `diff`, `report`, `evidence`, or a
`.txt`/`.json`/`.jsonl`/`.md`/`.log` suffix) gain a **Preview** toggle that
expands the bytes inline in a scroll-capped monospace block; every other kind
keeps **Open** alone, so a binary is never rendered as if it were text. The
fetch is lazy and happens once per row — first expand loads, subsequent
toggles are free — and loading, failure (with the HTTP status), and content
are three distinct states rather than one silent blank. Nothing is cached
beyond the panel's lifetime; the artifact store is content-addressed and the
bytes are immutable, so re-fetching is cheap and staleness is impossible.

### 10.6 Agents view (`#/agents`, `g t`)

`GET /agents` exposes the registry, fully readable, so the operator can
deep-dive what "factory-status-report@1" actually is before approving a spec
that names it. List: ref, output contract, mutating flag (error tone when
true), capabilities summary, timeout, attempts; client-side filter and
`#/agents/:ref` deep links. Detail panel, stacked
sections: **Definition** (workspace, capabilities, limits), **Prompt** (the
full markdown text in a monospace block — readable, no new dependencies —
with Copy prompt),
**Schemas** (input/output, pretty JSON behind disclosures), **Pins** (file →
hash table, captioned: content-hash pins that fail the registry closed on
drift — versions are bumped and re-pinned, never edited in place), and
**Event routing** (which event types select this agent, with adapter,
idempotency scope, and proposal TTL). The shared envelope contracts
(`factory.event/v1`, `factory.agent-result/v1`) render once at the list
level, not per agent. The selected ref in the pane title is followed by the
shared `<CopyActions />` icon controls: copy-ref (`c`) and copy-link (`c l`)
put their chord in `title` and `aria-label`, while the text-labeled `Close`
button carries no visible `Esc` badge. Strictly read-only — the registry has
no mutation surface. ⌘K jumps to an agent ref the same way it jumps to a run
or event.

Chord choice: `g t` ("what is **t**his agent?"). `o/e/p/r` were taken, and
`g a` is unusable — chord suffixes share the keydown with single-key list
verbs, and `a` is approve on the proposals view (same class of collision
that moved requeue to `q` in §10.1).

Cross-links: the agent ref in the run detail and in the proposal detail is a
link that opens the Agents view with that agent selected.

### 10.7 Environment chip

The nav rail header carries a permanent chip naming the runtime environment
from `/health`'s `env` object: `env.name`, with the serve-wide adapter
override appended when set ("dev · fake"). **live** wears the warning tone —
approvals there trigger real agent runs; every other environment is
informational. The title attribute carries `env.home` and the
`policyVersion`. When `/health` fails the chip shows **disconnected** in the
error tone, doubling as the API-down indicator alongside §4.1's connection
dot.

### 10.8 Operator chrome (OPS-230)

Follow-up to the Events-as-a-node pass (OPS-226). Same design language (§5.1);
no new API.

- **Shareable hashes.** Selection lives in the hash: `#/runs/:id`,
  `#/events/:source/:eventId`, `#/events?type=`, `#/proposals/:id`,
  `#/agents/:ref`, `#/graph/:nodeId`. Jumps write the full path; refresh
  restores the row. Nav-rail clicks still go to the view root. Overview
  status tiles remain ephemeral (tab/filter, not a URL) except Graph's
  event-type jump, which is `#/events?type=`.
- **Health banner.** When `/health` has failed (not while first pending), a
  status banner sits above every view: the factory is unreachable, lists may
  show cache, verbs stay disabled. **Retry** refetches `/health`. The nav
  chip still says `disconnected`; click it to copy `env.home`.
- **Graph on the same rails.** Selected event-type → Events filtered by type
  (`#/events?type=`); selected agent → Agents. Copy id, `j`/`k` walk nodes,
  Esc closes the panel, honest empty when `/agents` is down. `#/graph/:nodeId`.
- **Inject confirm.** Inject and Trigger again require confirm before
  `POST /replay`. Template chips are a radiogroup (arrow keys). Copy keeps
  Requeue (re-plan) / Replay (same id through intake) / Trigger again (fresh
  id) / Inject (blank or template) distinct.
- **Overview.** Expired-proposals tile lands on the Open tab with the expired
  chip on. Quiet Graph and Inject jumps in the header. Doctor Requeue jumps to
  the new open proposal like Events.
- **⌘K** includes decided proposals (`GET /proposals?status=all`). Dialogs
  expose `role=dialog` `aria-modal`. Runs state tabs scroll on one row
  (LEASED and VERIFYING included — the Overview stale-lease jump lands there).
- **Copy link** on every detail panel copies the shareable hash (`c` copies
  the id). Inject `i` admits then jumps to the event. `?` lists the keys.
  Empty Events inbox offers Inject as a button. Outbox types jump to the
  origin event when the envelope carries source+eventId. Trigger again
  selects a "this envelope" chip. `/` focuses the filter — from Overview or
  Graph it opens Events first. The empty filter shows a `/` hint. Dialog Tab
  cycles stay inside the dialog and focus returns to the opener on close.
  `[` / `]` cycle status tabs. Graph `j`/`k` pans the selected node into
  view; **Show on canvas** does the same from the panel. List title/tabs/filter
  stay pinned while the table scrolls. Detail Copy/Close stays pinned while
  the spec scrolls. `[` / `]` also scrolls the selected Runs tab into view.
  ⌘K splits This item / Go / Commands.
  Relative timestamps show the ISO instant on hover (lists, detail KV, run
  lifecycle clock, attempt start/finish). Click a string KV value to copy it. Doctor anomalies copy. A filtered
  empty list reminds that Esc clears. Selection wash is denser so j/k is
  obvious. Click a toast to dismiss it. The document title follows the hash
  (`factory · Runs · run_id`).

### 10.9 Workers view (`#/workers`, `g w`) — OPS-265, OPS-266, OPS-267, OPS-268

The fleet became plural (OPS-233), so §1's single-worker claim stopped being
true and the registry needed a view. Workers answers one question: **who could
claim the next run, and who only looks like they could.** A worker whose
heartbeat has gone stale still reports `busy` and still holds its run; that gap
is the reason the view exists.

- **Health is four disjoint tokens** — `idle`, `busy`, `stopped`, `stale` —
  rendered with the same `StateBadge` primitive as events, proposals, and runs.
  A stale heartbeat outranks whatever the row claims (`stale` beats a reported
  `busy`), and the row keeps the last self-report beside the badge as
  "reported busy" rather than discarding it. Staleness is heartbeat age past
  `HEARTBEAT_STALE_MS` (90 s, `lib/workers.mjs`); a cleanly stopped worker is
  never marked stale, which is what keeps the four disjoint. Stale rows carry
  the error wash, cleanly stopped rows dim; selection wins over both, per
  §5.1.
- **List** over `GET /workers`, polled at §6's 2 s: worker id, host, pid,
  state, placement labels, adapters, current run, last seen (relative, ISO on
  hover, error-toned when stale). One client-side filter spans id, host, pid,
  health, labels, adapters, and current run. Empty copy distinguishes loading,
  an unreachable API, and a genuinely empty registry — the last names the
  command that fixes it (`bun event-runtime/cli.mjs work`).
- **Detail panel**, stacked sections: a stale banner that says the process is
  gone whatever it last reported (and, when it still holds a run, that the run
  is reclaimed when its lease expires); **Process** (`workerId`, `host`,
  `pid`, `state`, `currentRun`, `startedAt`, `lastSeen`, and `stoppedAt` when
  present); **Adapters**, with an honest empty line when a worker claims
  nothing; and **Labels** as pretty JSON, captioned as what a run's placement
  constraints are matched against. Strictly read-only — the registry has no
  mutation surface, and the UI adds none.
- **Runs stay the run router.** `currentRun` is a jump to `#/runs/:id` from
  both the row and the panel; the fleet is a way in, not a second place runs
  live.
- **Hashes and keys.** `#/workers` and `#/workers/:id` per §10.8: selecting a
  worker writes the hash, refresh restores the row, a nav-rail click returns
  to the view root. `g w` navigates (`w` is no view's single-key list verb, so
  unlike `g a` in §10.6 the natural chord was free); `j`/`k` move, `o` opens
  the current run, `c` copies the worker id, `Esc` closes the panel then
  clears the filter, and the panel's **Copy link** copies the shareable hash.
  ⌘K lists workers in their own group (id, host, and the same
  stale-outranks-reported health) and jumps to one.
- **Nav badge.** The Workers rail entry is the one badge whose meaning flips:
  with stale workers it shows the stale count in the warning tone plus the
  word "stale", otherwise the busy count in the accent tone. The word is
  there because tone alone does not survive the high-contrast theme. Counts
  come from `/status`'s `workers` block.

The two AC items of the parent pass that shipped separately are **now on this
tree**, so the fields §7 already returned are all read by a view:

- **Overview tiles and worker anomalies (OPS-267).** The Overview stat grid
  gains `workers · live` / `busy` / `stale` from `/status`, each hued only when
  non-zero (ok, info, warn) and each a jump to `#/workers`. The Overview doctor
  panel gains a row per `stalledWorkers` entry — naming the worker, the run it
  still holds, and the heartbeat age, with a jump to both ends of that gap —
  and a row for `noWorkers` that counts the queued runs waiting on a
  registration. Anomaly rows carry a link list rather than one link, because a
  stalled worker legitimately has two destinations.
- **`lease_owner` jumps (OPS-268).** A run's attempts now render their lease
  owner, and both it and a lifecycle row's actor become a jump to
  `#/workers/:id` when the string is a worker id (`worker_<pid>_<rand>`,
  `lib/ids.mjs`). Every other actor the runtime records is a bare word
  (`operator`, `planner`, `reaper`, or the `worker` fallback for an attempt
  whose owner was lost) and stays inert text, since none of them addresses a
  row in the fleet; a missing owner reads `unclaimed`.

### 10.10 Live trace in run detail (OPS-295)

`GET /runs/:id/trace` (factory.trace/v1, `lib/trace.mjs`) answers the
question the lifecycle journal cannot: _what is the agent saying and which
tools is it calling, right now._ The run detail gains a **Trace** section
between Lifecycle and Attempts, rendering the stream chronologically:

- `assistant_text` as plain text blocks; `tool_use` as a compact "🔧 name"
  row with the input JSON behind a disclosure; `tool_result` collapsed by
  default (this is the bulky, least-read kind), error-toned when `isError`;
  `usage` as a muted summary line (turns · duration · cost, token detail
  behind a disclosure); `lifecycle` notes muted — except `trace_truncated`,
  which renders visibly in the warning tone as "trace truncated — N events
  dropped past the cap". Payloads the recorder clipped in place
  (`{truncated, preview, originalBytes}`) say so and show the preview.
- **Live behavior.** While the run is `LEASED`/`RUNNING`/`VERIFYING` the
  section polls every ~1.5 s with `since=<last received seq>` (the §10.4
  journal-feed pattern) and appends; a live badge shows, and the scroll pins
  to the newest entry. Polling stops on any other state, with one final
  catch-up read on the live→terminal transition so the tail written between
  the last poll and the terminal flip is not lost. Terminal runs fetch once
  on open — historical traces are browsable, not just live ones. The cursor
  is the last _received_ seq, never the server `head` (which would skip rows
  whenever a read filled a whole 500-row page); full pages loop until caught
  up, bounded by the recorder's 2000-row cap.
- **Multi-attempt runs** get an "Attempt #n" divider whenever the attempt
  number changes (entries are seq-ascending, so attempts are contiguous);
  single-attempt traces carry no labels.
- **Empty states** distinguish loading, an unreachable API, a live run that
  has not emitted yet, and the honest terminal case: "No trace — this
  adapter does not stream events" (fake runs seeded before this feature and
  command-adapter runs have none).

Nothing global changes: no nav entry, no chord — the trace lives inside the
run detail only, and the shared `Disclosure` label widened from `string` to
`ReactNode` to allow the error-toned tool-result summary.

### 10.11 Full-page run view (`#/run/:id`) — OPS-354

Operator verdict after living with §10.10: the panel is right for triage and
wrong for _reading_ — a trace deserves a page. `#/run/:id` is that page.

- **Route.** A distinct first segment, not a mode on `#/runs/:id`. Under
  §10.8's rules, same-view hash writes replace history and cross-view writes
  push — so `runs → run` pushes by construction: browser Back lands on
  `#/runs/:id` with the panel selection intact (the selection _is_ the
  hash), and the explicit **← Runs** control navigates to `#/runs/:id`
  directly, which also works for a pasted `#/run/:id` link with no history
  behind it. A bare `#/run` renders the Runs list. The Runs rail entry stays
  highlighted while a full run view is open.
- **Getting in and out.** From the Runs list: `Enter`/`o` on the selection
  (§5's "open detail" verb graduates — selection alone already opens the
  panel, so _open_ now means the full page). From the panel: an **Expand**
  button, clicking the run id in the panel title, the ⌘K context action, and
  the panel trace's "open full view" tail link. Out: browser Back, **←
  Runs**, or `Esc`. `x` cancel and `c` copy work on the page, same as the
  panel.
- **The `g o` collision, fixed for the class.** `o` is also the Overview
  chord suffix, and the chord listener and a view's key listener ride the
  same keydown — with listener order flipping on remount, so neither side
  can reliably win a race. `goSequence.ts` now exports a time-based
  `goPrefix` armed-timestamp (set on `g`, never cleared synchronously —
  clearing in one listener would blind the other); `useListKeys` stands down
  entirely while it is armed. This also retroactively fixes §10.9's `o`
  (open current run) double-firing on `g o` in Workers.
- **Layout.** Full-bleed two-column under a pinned header (back, state
  badge, run id, agent · adapter · attempts, copy verbs): MAIN is the trace
  at a readable measure (`max-w`-bounded, taller scroll viewport); SIDEBAR
  is the panel's blocks unchanged — verbs with the existing 409 handling,
  spec summary with the agent link, lifecycle, attempts, result + evidence,
  artifacts (open links), receipt. The sidebar stacks below the trace on
  narrow viewports. Origin event still comes from the runs-list join
  (`GET /runs/:id` does not return it); the list query's cache is shared.
- **Trace enhancements, width-earned and modest.** Kind filter chips —
  text / tool calls / tool results / usage · lifecycle (the last two share a
  chip) — filter client-side over the cached entries; polling is untouched
  and hidden-not-shown state means new kinds stay visible by default. The
  poller is the same `useTraceFeed` as §10.10, not a fork: `RunTrace` grew a
  `variant` prop (`panel` | `full`), and both surfaces share one query
  cache, so panel and page never poll the same run twice.
- **Panel trace is now tail-only** (last 20 entries) with a "showing last 20
  of N — open full view" line: triage reads the newest activity, reading the
  whole thing is what the page is for.

### 10.12 Operator context tabs (OPS-356)

Linear-style strip **above** the inverted-L. A tab is a filter context, not a
project container and not a second nav rail. Decisions: [product-decisions.md](product-decisions.md).

- **All** — default, never closable. Today's UI. Unscoped work lives here.
- **In flight** — Runs in `LEASED` or `RUNNING`, every repo. Not a fake
  project. Selecting it lands on `#/runs`.
- **A factory repo** — opened with `+` from `GET /repos`. Filters Events /
  Proposals / Runs to rows whose `repos: string[]` (from spec input /
  envelope payload: `repoPin.repo`, `repo`, `repos[]`) includes that name.
  Empty `repos` only appear under All. Closing the tab returns to All.
- **Agents / Workers / Graph / Inject** stay global. When a repo tab is
  active they caption that they are not scoped to it.
- **Hash.** View + selection stay in the path (`#/runs/:id`). Optional
  `?project=` (`inflight` reserved) restores the active filter on refresh.
  The open-repo set is `sessionStorage`. A pasted `#/runs/:id` without
  `?project=` opens All. `g e` / j/k / Esc stay inside the context; `[` / `]`
  still cycle status tabs.
- Pinning a run as a document tab on this strip is OPS-357, not this
  section. The Projects _view_ (OPS-300) is a separate registry list.

### 10.13 Graph canvas (`#/graph`, `g g`) — OPS-224

The one view that answers a question no list can: **what this runtime can do
at all**, before any event has arrived. It is the capability map, derived
from `GET /agents` alone — registry topology, never runtime state — with the
deliberate consequence that a factory which has never admitted an event still
draws a full graph.

- **The topology rules are pure and unit-tested** (`src/graph/model.ts`,
  `model.test.ts`), kept clear of React so the rendering layer could be
  swapped without touching what the map _means_. Three node kinds: an **event
  type** per registered route, carrying its adapter, idempotency scope, and
  proposal TTL; an **agent** per registry entry, carrying its execution shape
  — `model`, `command`, or `actions`, derived from whether the definition
  closes over a command template or an action registry; and a **terminal**,
  which exists because "the chain ends here" is topology rather than an
  omission — an agent whose output enum declares recommendation values that
  no edge maps anywhere gets one node summarising exactly those values. Two
  edge kinds: `routes` (event type → the agent the planner selects, solid,
  and never drawn to a ref the registry does not actually have) and
  `recommends` (agent → follow-up event type, dashed and accent-toned,
  labelled with the recommendation field and the value that fires it).
- **Rendering** is React Flow over an elkjs layered left-to-right layout,
  with a dot background, zoom controls, and a pannable minimap. Hand-rolling
  DAG layout is where views like this die, so elk does it. elk is ~1.4 MB of
  pre-minified layout engine, so it is imported dynamically and rides its own
  async chunk (OPS-255): fetched the first time there is a graph to lay out,
  never by a list view. The minimap paints into SVG, where `var()` and
  `color-mix()` do not resolve, so its nodes are styled by class from
  `theme.css` instead of inline — §5.1's tokens still govern, by a different
  route.
- **Failure states itself.** A layout import that fails — the realistic case
  being a stale `index.html` pointing at a chunk a redeploy removed — logs
  and then says the deployed build is incomplete and to reload (OPS-287,
  OPS-297). Without that the canvas sat on "Laying out…" and read as merely
  busy, which is the §6 lie in miniature. The empty copy separates loading,
  an unreachable `/agents`, a genuinely empty registry, and layout still
  running.
- **On the same rails as every list** (§10.8): `j`/`k` walk nodes in _layout_
  order — top-to-bottom then left-to-right, so the keyboard follows what the
  eye sees rather than registry order — `c` copies the node's id or agent
  ref, `Esc` closes the panel, and `#/graph/:nodeId` is shareable. Moving the
  selection pans that node into view at the current zoom rather than
  refitting the whole canvas, and **Show on canvas** does the same from the
  panel, because a selection that is off-screen is not a selection.
- **The panel is the way out of the map and back into the lists.** An
  event-type node offers **Show in Events** (`#/events?type=`); an agent node
  shows execution, output contract, mutating flag, capabilities, limits, the
  literal closed command template or action registry when it has one, and the
  full prompt, with its ref linking into Agents (§10.6); a terminal node
  explains itself in prose — these recommendation values have no registered
  edge, so a run returning one completes and chains no further.

Phase 2 — overlaying live run state onto the map, so the capability graph
lights up as work moves through it — **is not built**. Phase 1 draws
capability only, on purpose: a map that is correct with an empty database is
worth having on its own, and mixing live state into it doubles the failure
modes. The link phase 2 needs already ships (`GET /events` projects
`causationId`), so this is a matter of what was worth building next, not of
anything blocking it.

### 10.14 Projects view (`#/projects`, `g f`) — OPS-300, OPS-362, OPS-369

`GET /repos` (OPS-299) exposes `config/repos.yaml` as an allow-listed
registry, and Projects is the view of it: which repositories this factory is
configured to act on, on what terms, and what maintenance they are owed. It
is the second registry view after Agents (§10.6) and, like it, reads
configuration rather than runtime state — which is why it polls at 5 s
instead of §6's 2 s: a YAML file does not change while you watch it. Unlike
Agents it is not strictly read-only, because the janitor verb acts on the
worktrees a repo owns.

- **List** over `GET /repos`: name, team as a hued chip (`CLNT`, `WM`, `CW`,
  `LAB`, `OPS`), project or GitHub slug, execution mode, base branch with the
  deploy branch appended when one is configured, and which of the three
  worktree scripts (`up` / `down` / `warm`) the repo actually ships. Mode is
  the distinction that matters, so it is a badge and not a column of prose:
  **Dispatchable** or **Report Only**. Three mode tabs (All / Dispatchable /
  Report-Only) sit beside one client-side filter spanning name, project,
  team, and GitHub slug. `j`/`k` move, `c` copies the repo name,
  `#/projects/:name` is shareable per §10.8, and the empty state names the
  file that is empty (`config/repos.yaml`) rather than saying "no results".
- **Detail panel.** **Configuration** — path (click to copy), GitHub link,
  base and deploy branch, execution mode spelled out ("Autonomous
  Dispatchable" / "Report Only (Watched)"), max in flight, worktree root, and
  the verify command verbatim, since a paraphrased verify command is worse
  than none. **Worktree Automation Scripts** renders `up`/`down`/`warm` as
  three present-or-absent tiles: the shape of a repo's automation is
  something you check before dispatching to it, not after.
- **Janitor, Dry before Apply (OPS-362).** `POST /repos/:name/janitor` — §2's
  one mutation exception, specified in §7 — is wired as two buttons in an
  order the UI enforces rather than suggests: **Run Dry Janitor** first, and
  Apply stays disabled until a Dry result exists for the selected repo. Dry
  renders what the janitor found in four groups: reclaimable, each with its
  Linear ticket state; kept, because the ticket is still active;
  named/custom worktrees; and unknown tickets. The last two are captioned as
  kept _safe_, because the interesting thing about a janitor is what it
  declines to touch. Apply sits behind a typed confirmation — the operator
  types the repo name exactly, and the dialog states how many worktrees it
  will act on and that uncommitted work is refused rather than forced. The
  result separates removed from refused-with-reason, and a report-only repo
  with no `worktree_down` script disables Apply with that reason on screen
  instead of letting the API's 409 explain it after the click. Selecting a
  different repo clears both results: a scan is about exactly one repo, and
  stale output that still looks current is the failure mode this view could
  most easily have.
- **Quick Dispatch (OPS-369).** The same panel injects the three factory
  agent events scoped to the selected repo —
  `factory.triage.requested`, `factory.status-report.requested`,
  `factory.janitor-scan.requested` — by building an envelope and posting it
  to `POST /replay`, which is why §2 counts this as a shortcut rather than
  new surface. It then behaves like any other admitted event: planner,
  proposal, a worker lease, and a trace streaming into the run (§10.10). The
  direct janitor verb and the dispatched `janitor-scan` event coexist on
  purpose — one is synchronous and loopback, the other is a placed
  command-adapter agent run (OPS-368) — and the panel captions which button
  is which so the choice is visible rather than folklore.
- **⌘K** carries the selected repo's actions: the three dispatches, a Dry
  run, copy path, copy link, and open on GitHub.

Nothing here writes `config/repos.yaml`. The registry is edited in the file
and read by the UI, exactly as the agent registry is in §10.6.

### 10.15 Chain trace (`#/chain/:correlationId`) — WM-527

The Graph (§10.13) answers "what can happen"; the chain trace answers "what
happened to *this* one, and where did it start". A chain instance is stitched
by two ids the emitter writes on every hop (`lib/chain.mjs`): `correlationId`,
inherited unchanged from the origin event (falling back to the origin's own
`eventId` when it carried none), and `causationId`, the run id that produced
the derived event. `GET /chain/:correlationId` returns every event and run
under that key — flat lists, `causationId` intact, 404 when unknown — and the
client builds the DAG: origin event → run → emitted events → runs …, laid out
left-to-right on the same React Flow + elk canvas as the map, with tighter
layer spacing because chains are long and thin.

- **Reachable from wherever an operator is standing.** The event panel shows
  `correlationId` (a link into the chain) and `causationId` (a link to the
  run that emitted it) and has a **View chain** action; the full run page has
  the same action, keyed by the run's origin event. Both land on the chain
  with that event/run pre-selected (`#/chain/:correlationId/:nodeId`).
- **Every node is an instance.** Event nodes carry source, type, status,
  short id, age and repos; run nodes carry agent, state, adapter, attempt and
  reason code. The left border is the event status / run state hue, so a
  failed hop reads at a glance. The header sums it up: origin, event/run
  counts, hop depth, and a state tally.
- **Same chrome as the map.** `j`/`k` (and arrows) walk nodes in reading
  order, `z` / **Show on canvas** pans the selection into view, `Esc` closes,
  **Reset layout** re-runs elk. The panel links out to Events, Runs, the run
  page, Proposals and Agents, and to the parent run / origin event *inside*
  the chain. Positions are reused across the 3 s poll while node/edge
  identity is unchanged (§10.13's identity rule).

It is a drill-in like `#/run/:id`, not a nav item: you arrive from an event
or a run, never cold.

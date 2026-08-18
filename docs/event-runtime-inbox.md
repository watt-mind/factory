# Event runtime: the human decision inbox

Status: **design — operator-ratified, nothing built beyond the ledger**.
Tracking: WM-383 (epic); WM-384 (this document); implementation lands through
WM-389..WM-393 and renders into WM-286. Companion to
[event-runtime.md](event-runtime.md) §12 (approval surface), which this
extends from "approve a spec" to "answer a question", and to
[event-runtime-dispatch.md](event-runtime-dispatch.md) §5, whose escalation
gate produces most of the questions.

---

## 1. Problem and scope

The runtime already knows how to stop and wait for a human. It does so in four
places, none of which connects to the others and none of which lets the human
answer:

| Mechanism                                                | Produced by                                                                               | Operator surface today                                                   |
| :------------------------------------------------------- | :---------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- |
| Run refused with `reasonCode: "needs_human"`             | `lib/verify.mjs` `REFUSAL_REASONS`; emitted by `dispatch`, `triage-scan`, `merge-scan`, … | **None.** The run record says `REFUSED`; no inbox row, no push (WM-337). |
| Event parked `human_needed`                              | `lib/planner.mjs` `humanNeeded()` (unknown repo, ticket not found, no worktree scripts…)  | `BLOCKED …` inbox item + push; the only verb is `POST /events/requeue`.  |
| Triage plan item `action: "needs-human"`                 | `schemas/triage-scan.output.json`                                                         | A Linear comment (`triage-apply.json`).                                  |
| Merge `ESCALATE` verdict / `humanApprovalOnly` proposals | `merge-scan`, `event-types.json`, `lib/proposals.mjs`                                     | Approve/reject a proposal; the escalated PR itself has no verb.          |

The inbox ledger (WM-285, `lib/inbox.mjs`, `inbox_items`) is authoritative and
durable, but an item is free text — `title`, `body`, a fixed `refs` map — and
its two verbs, `ack` and `resolve`, both mean "I have seen this". Neither
changes anything. `resolveInboxItem` accepts a `reason` at the API and drops it.
Acking never unblocks; only `reconcileInbox` polling the referent does.

The operator's actual situation is: an agent stopped for a good reason, wrote a
good sentence about why, and the system has nowhere for the operator to say
"yes, go ahead within these bounds", "no, send it back", or "here is the fact
you were missing". Three tickets are stuck this way today (WM-312, WM-313,
WM-336); the operator approved two of them in chat, and the approval had
nowhere to live.

**This design gives every waiting-on-a-human item a typed question and a typed
answer**, and makes the answer reach the thing that asked. It does so with one
new contract pair, one new verb, and a generic renderer — not a form per kind.

In scope:

- A **decision request** attached to an inbox item, authored by the agent that
  stopped, or synthesised by the runtime from a per-kind default when the agent
  supplied none.
- A **decision response** posted by the operator, validated against the
  request, stored on the item, and applied through a closed set of runtime
  **effects**.
- The `authorise` effect end to end: re-dispatch with the decision in the run
  input, bound to the ticket description so it expires on re-scope, and a
  dispatch brief that proceeds on an authorised escalation.
- A web renderer that draws any valid decision request without knowing its
  kind, on the Inbox view (WM-286).

Out of scope, stated so nobody absorbs it by accident:

- **Free-form agent-authored UI.** No layout, no arbitrary components, no
  agent-supplied JSON Schema. The agent fills a closed vocabulary; the renderer
  owns the layout. §7 says why.
- **Agent-invented effects.** The agent chooses _which_ runtime verbs to offer
  and how to phrase them; it cannot define a new one.
- **Multi-turn conversation.** A decision is one question, one answer. If the
  answer raises a new question, the re-run raises a new item.
- **Merging an escalated PR from the inbox.** WM-287's rule stands: that
  button would defeat the gate. `authorise` re-dispatches an agent; it never
  lands a diff.
- **Acting from Telegram.** WM-288 remains a spike; the Telegram projection
  here is a deep link.

---

## 2. The shape of a decision

An inbox item gains an optional `decision` (the request) and, once answered, a
`response`. Both are versioned contracts under `event-runtime/schemas/`,
validated with the same closed-keyword `lib/schema.mjs` every other contract
uses.

### 2.1 `factory.decision-request/v1`

```json
{
  "schemaVersion": "factory.decision-request/v1",
  "question": "WM-313 changes how the pi adapter reads FACTORY_EVENT_SECRET. May I proceed?",
  "context": "The ticket moves secret handling from env to a file the worker mounts…\n\nRisk: a wrong path leaks the secret into the run journal.",
  "recommended": "authorise",
  "options": [
    {
      "id": "authorise",
      "label": "Authorise within these paths",
      "description": "Re-dispatch me with your approval bound to WM-313 as written now.",
      "effect": "authorise",
      "tone": "primary",
      "scope": {
        "paths": [
          "event-runtime/lib/adapters/pi.mjs",
          "event-runtime/lib/security-env.mjs"
        ],
        "summary": "Read the event secret from FACTORY_EVENT_SECRET_FILE when set; never log its value."
      }
    },
    {
      "id": "triage",
      "label": "Send back to Triage",
      "description": "The ticket should be re-scoped before anyone touches this.",
      "effect": "send_to_triage",
      "tone": "neutral"
    },
    {
      "id": "dismiss",
      "label": "Not now",
      "effect": "dismiss",
      "tone": "neutral"
    }
  ],
  "fields": [
    {
      "id": "insight",
      "kind": "text",
      "label": "Anything I should know before I start",
      "placeholder": "e.g. the file path convention, or a test to add",
      "required": false,
      "maxLength": 2000
    },
    {
      "id": "paths",
      "kind": "multi-choice",
      "label": "Restrict me to",
      "choices": [
        { "id": "pi", "label": "event-runtime/lib/adapters/pi.mjs" },
        { "id": "env", "label": "event-runtime/lib/security-env.mjs" }
      ],
      "required": true,
      "whenOption": ["authorise"]
    },
    {
      "id": "confirm",
      "kind": "confirm",
      "label": "I understand this changes secret handling on every worker",
      "required": true,
      "whenOption": ["authorise"]
    }
  ]
}
```

Fields, all bounded:

| Field         | Rule                                                                                                                                                                                                                                                                                                             |
| :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question`    | Required, 1–280 chars. The one thing being decided, phrased so one click answers it (the linear.md §14 "one answerable sentence" rule, made structural).                                                                                                                                                         |
| `context`     | Optional markdown, ≤ 8 KiB. Rendered, not interpreted.                                                                                                                                                                                                                                                           |
| `options`     | Required, 1–6 items, unique `id`s (`^[a-z][a-z0-9_-]{0,31}$`), exactly one is chosen. Each has `label` (1–60), optional `description` (≤ 280), `effect` from the closed set in §3, `tone` ∈ `primary \| danger \| neutral` (default `neutral`), and, only when `effect: "authorise"`, a `scope` (§3.1).          |
| `recommended` | Optional; must name an option `id`. Rendered first and marked; never pre-selected — the operator still clicks.                                                                                                                                                                                                   |
| `fields`      | Optional, 0–6 items, unique `id`s. Each has `kind` from the closed widget set (§2.3), `label`, `required` (default false), and an optional `whenOption` array naming option ids: the field is shown and enforced only when one of those options is chosen. A field with no `whenOption` applies to every option. |

Unknown keys anywhere fail validation (`additionalProperties: false`
throughout, matching every other runtime contract).

### 2.2 `factory.decision-response/v1`

```json
{
  "schemaVersion": "factory.decision-response/v1",
  "requestHash": "sha256:…",
  "optionId": "authorise",
  "fields": {
    "insight": "Use FACTORY_EVENT_SECRET_FILE; add a test that the value never appears in journal.jsonl",
    "paths": ["pi", "env"],
    "confirm": true
  },
  "decidedBy": "operator",
  "decidedAt": "2026-08-16T12:41:07.000Z"
}
```

`requestHash` is `hashJson(decision)` of the request the operator was looking
at; a response whose hash does not match the item's current request is
rejected with `409 stale_request` — the same guard the proposal path uses when
an expired proposal was re-planned. `optionId` must name an option; `fields`
must satisfy every applicable field's kind and `required` and contain no
field the request did not declare. `decidedBy` is `operator` today (the API is
single-tenant, as `resolvedBy` already is) and stays a string so a later
identity can fill it. Server sets `decidedAt`.

### 2.3 The widget vocabulary — closed

| `kind`          | Value type             | Renders as                                  | Extra keys                                                             |
| :-------------- | :--------------------- | :------------------------------------------ | :--------------------------------------------------------------------- |
| `text`          | string                 | textarea (single-line if `maxLength` ≤ 120) | `placeholder`, `maxLength` (default 2000, cap 8192)                    |
| `single-choice` | string (a `choice.id`) | radio group / select                        | `choices` 2–12 × `{ id, label, description? }`                         |
| `multi-choice`  | string[] (choice ids)  | checkbox list                               | `choices` 1–24 × `{ id, label, description? }`, `minItems`, `maxItems` |
| `confirm`       | boolean                | a single checkbox with the label            | — (`required: true` means it must be `true`)                           |
| `number`        | number                 | numeric input                               | `minimum`, `maximum`, `integer`                                        |

Five kinds. This is deliberately smaller than `lib/injectForm.ts`'s
classification (which also has `const`, `string-array`, `json`): a decision is
answered in seconds by a person, not authored as a payload. `json` in
particular is excluded — if an agent needs a structured object from the
operator, it should ask the two or three questions that object is made of.
Every `answer` and `reject_proposal` option must have an applicable required
`text` field, accounting for `whenOption` gating.
Adding a kind is a schema bump plus a renderer case; the vocabulary is
expected to grow slowly, if at all.

---

## 3. Effects — the runtime owns the verbs

Every option carries exactly one `effect` from this closed set. The renderer
does not know what an effect does; the API does, and applies it in the same
transaction that stores the response.

| Effect             | What the runtime does                                                                                                                                                                                      | Legal only when the item has            |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------- |
| `authorise`        | Records the authorisation (§3.1) and emits a `factory.dispatch.requested` envelope for `refs.issue` on `refs.repo` with `humanDecision` in the payload (§5). The item resolves as `operator:authorised`.   | `refs.issue`, `refs.repo`, `refs.runId` |
| `send_to_triage`   | Moves `refs.issue` to `Triage`, removes `ai:agent-ready`, comments the operator's fields (`tools/linear.mjs`). Resolves as `operator:triaged`.                                                             | `refs.issue`                            |
| `answer`           | Comments the operator's `text` field(s) on `refs.issue` (at least one applicable field is required), moves it `Blocked → Todo` (WM-287's "Answer" verb, unchanged). Resolves as `operator:answered`.       | `refs.issue`                            |
| `requeue`          | `POST /events/requeue` for `refs.eventSource`/`refs.eventId` (existing planner path). Resolves as `operator:requeued`.                                                                                     | `refs.eventSource`, `refs.eventId`      |
| `approve_proposal` | `approveProposal(refs.proposalId)`; an expired proposal takes the existing SpecDiff re-plan path and the item stays open until that second approval — never auto-approve. Resolves as `operator:approved`. | `refs.proposalId`                       |
| `reject_proposal`  | `rejectProposal(refs.proposalId, reason)` with the operator's applicable required `text` field as the reason. Resolves as `operator:rejected`.                                                             | `refs.proposalId`                       |
| `dismiss`          | Resolves the item as `operator:dismissed`, records the fields, touches nothing else. Every default template offers it; agents are told to offer it.                                                        | —                                       |

For both `answer` and `reject_proposal`, the applicable required `text` field
rule accounts for `whenOption` gating before the effect is offered.

Effect legality is checked when the _request_ is created, not when the
response arrives: an agent that offers `requeue` on an item with no event refs
has authored an invalid request, and the runtime falls back to the default
template (§4.3) rather than showing the operator a button that will fail.

A Linear write that fails leaves the item **open**, with the error on the
response record and shown in the UI (`response.error`) — the same rule
WM-287 sets for Answer. Nothing resolves on a failed effect. The response is
kept so the operator can retry with one click rather than re-typing.

### 3.1 Authorisation is narrower than "proceed"

An `authorise` option's `scope` is what the operator is approving:

```json
"scope": {
  "paths": ["…"],          // 1–32 repo-relative paths or globs the agent will touch
  "summary": "…"           // ≤ 500 chars: what will be done inside them
}
```

On response the runtime records an authorisation:

```json
{
  "ticket": "WM-313",
  "repo": "factory",
  "descriptionHash": "sha256:…", // of the Linear description at decision time
  "paths": ["…"], // scope.paths ∩ operator's multi-choice, if one was gated on this option
  "summary": "…",
  "insight": "…", // concatenated text fields, if any
  "refusedRunId": "run_…",
  "decidedBy": "operator",
  "decidedAt": "…"
}
```

Two bindings make it safe:

- **Bound to the ticket as written.** `descriptionHash` is taken from Linear
  at decision time. When the re-dispatched run starts, the dispatch brief
  compares it to the current description; a mismatch means the operator
  approved different work, and the agent refuses again with a new decision
  request whose context says the ticket changed. The runtime also checks at
  emit time and raises a fresh `ESCALATED` item instead of dispatching if the
  description already moved.
- **Bound to paths.** The re-dispatched agent may modify only
  `authorisation.paths` (∩ the ticket's Owned Paths); anything outside is the
  ordinary out-of-scope rule.

An authorisation is single-use: it lives in one run's input. A second refusal
raises a second item; the operator decides again. Blanket approval per ticket
or per area is deliberately not a thing.

---

## 4. Producers — who asks, and what happens when they ask badly

### 4.1 Refused runs (`needs_human`)

`factory.agent-result/v1` gains an optional `decision` property, admitted only
when `terminalState: "refused"`, holding a `factory.decision-request/v1`.
`verifyRefused` validates it:

- Valid → kept on the run result as `result.decision`.
- Invalid → the refusal still stands (a well-formed refusal must not turn into
  a `FAILED` run because the agent phrased its question badly); the errors are
  kept as `result.decisionErrors` and `result.decision` is absent.

When a run terminates `REFUSED` with `reasonCode: "needs_human"`, the worker's
termination path creates an inbox item:

- `kind: "ESCALATED"`, `source: "agent:<runId>"`, `refs` from the spec
  (`runId`, `issue`, `repo`, `pr` where known), `title` from the question or,
  absent one, `ESCALATED <ticket>: <agent's reason>`.
- `decision` = `result.decision` when present, else the default template for
  the run's agent (§4.3), with `decisionErrors` surfaced in the item body so
  a badly-authored request is visible and fixable in the brief.
- Deduplicated (§6) — a re-dispatch loop refusing the same ticket updates the
  open item's request rather than stacking items.

`REFUSED` for the other reason codes (`missing_input`, `permission_denied`,
`unsupported_capability`) does **not** raise an item: those are contract or
configuration faults that show as anomalies, not questions for a person.

### 4.2 The other three

- **Parked events.** `notify.mjs` already writes the `BLOCKED …` item for a
  `human_needed` event; it now attaches the `parked` default template
  (`requeue` / `dismiss` + an `insight` text). No new producer.
- **Triage `needs-human`.** `triage-scan.output.json` plan items with
  `action: "needs-human"` gain an optional `decision`. `triage-apply` posts an
  item to `POST /inbox` (kind **`decision_needed`** — `ESCALATED` is for work
  an agent declined to do; this is a product question — refs `issue`+`repo`)
  in addition to the comment it writes today. Default template: `answer` /
  `dismiss` with a required `text` (the issue is already in Triage, so
  `send_to_triage` is meaningless here).
- **Merge `ESCALATE`.** `merge-scan`'s `escalate[]` entries gain an optional
  `decision`; `merge-apply`'s `notify_escalate` action creates an `ESCALATED`
  item with refs `pr`+`issue`+`repo`. Default: `send_to_triage` / `answer` /
  `dismiss` — never `authorise` (§1, out of scope: nothing merges from here).
- **Proposals.** `decision_needed` / `proposal_expired` items get the
  `proposal` default (`approve_proposal` / `reject_proposal` + required
  `text` gated on reject). This replaces WM-287's hardcoded approve/reject
  buttons with the same behaviour expressed as a template.

### 4.3 Default templates

`lib/decision-templates.mjs` exports one request per producer
(`escalation`, `parked`, `triage-question`, `merge-escalation`, `proposal`),
each a plain `factory.decision-request/v1` object validated by the same test
that validates agent output. Templates are the floor, not the ceiling: an
agent that authors a valid request always wins over the template, and the
brief tells it to (§8).

---

## 5. The answer reaches the agent

`dispatch.input.json` gains an optional `humanDecision`:

```json
"humanDecision": {
  "type": "object",
  "required": ["schemaVersion", "inboxItemId", "authorisation"],
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "const": "factory.human-decision/v1" },
    "inboxItemId": { "type": "string" },
    "authorisation": { "$ref": "…the §3.1 object…" }
  }
}
```

It is part of the payload, not a planner-injected field like `repoPin`: the
operator's decision is _input_, and it should be visible in the proposal the
same way any input is. Two consequences fall out for free:

- **The pinned-ticket problem goes away.** `factory.dispatch.requested` is
  idempotent on `inputHash`; a refused or blocked-but-completed run pins the
  ticket until `develop` moves (WM-337, WM-319). A payload carrying
  `humanDecision` has a different hash — the re-dispatch is a new run by
  construction, no idempotency exception needed.
- **The decision is auditable in the run.** `cli.mjs inspect <runId>` shows
  it in the spec; the receipt covers it.

The `dispatch` brief gains one clause, in the escalation-gate paragraph:

> If the input carries `humanDecision.authorisation` for this ticket, the
> operator has already seen the escalation. Compare
> `authorisation.descriptionHash` to the ticket's current description; if it
> matches, proceed, staying inside `authorisation.paths`, and quote the
> authorisation (item id, decided-at) in the PR body. If it does not match,
> refuse with a new decision request whose `context` says the ticket changed
> after approval.

Other agents that can be re-run after a decision (`triage-scan` after
`answer`, a parked event after `requeue`) do not need the field: their
re-run reads authoritative state, and the operator's answer is already on the
Linear issue or in the requeued event.

---

## 6. Ledger changes

Migration v5 on `inbox_items`:

```sql
ALTER TABLE inbox_items ADD COLUMN decision_json  TEXT;    -- factory.decision-request/v1 or NULL
ALTER TABLE inbox_items ADD COLUMN response_json  TEXT;    -- factory.decision-response/v1 (+ effect outcome) or NULL
ALTER TABLE inbox_items ADD COLUMN decided_at     TEXT;
ALTER TABLE inbox_items ADD COLUMN decided_by     TEXT;
ALTER TABLE inbox_items ADD COLUMN dedupe_key     TEXT;
CREATE UNIQUE INDEX inbox_items_open_dedupe ON inbox_items(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
```

`dedupe_key` is `<kind>:<primary ref>` where the primary ref is, in order,
`issue`, `pr`, `proposalId`, `eventSource/eventId`, `runId`. `createInboxItem`
with a key that collides with an open item **updates** that item's `decision`,
`body`, and `refs.runId` and bumps a `supersededDecisions` counter in
`delivery_json`; it does not insert. Items created by `factory notify` (CLI,
free text) carry no key and are never deduplicated — the human typed them on
purpose.

`resolved_by` gains the `operator:<effect>` family alongside `operator` and
`auto:*`.

API:

```
GET  /inbox/:id                → the item, with decision and response
POST /inbox/:id/decide         → body: factory.decision-response/v1 minus decidedAt
                                  200 { item, effect: { kind, outcome } }
                                  400 invalid response · 404 · 409 stale_request | already_decided
POST /inbox/:id/decide/retry   → re-run a failed effect with the stored response
```

`ack` and `resolve` remain for items without a decision and for the
`factory notify` family. An item with a decision cannot be `resolve`d
without deciding — that would recreate the "seen ≠ acted" hole this closes;
`dismiss` is always offered instead. `POST /inbox` accepts an optional
`decision` and validates it, so `factory notify` and future producers can
attach one.

CLI: `cli.mjs inbox` lists; `cli.mjs decide <itemId> <optionId> [--field
k=v…]` posts through the same route. Not a second implementation.

---

## 7. Rendering — one card for every question

`event-runtime/web/src/components/DecisionCard.tsx` takes a
`factory.decision-request/v1` and an `onDecide(response)` and draws:

1. `question` as the heading; `context` as rendered markdown below it.
2. Options as buttons — `recommended` first with a "suggested" mark; `tone`
   maps to the existing hues (`primary` → accent, `danger` → the red state
   hue, `neutral` → default). Selecting an option is a click or its number
   key `1–6` (Inbox is a list view; number keys are free — the status tabs
   move to the tab bar's own bindings, as Proposals already does).
3. Fields, in declared order, filtered by `whenOption` against the selected
   option; kinds map to the five inputs in §2.3. Field classification lives in
   a pure module `web/src/lib/decisionForm.ts` beside `injectForm.ts`,
   unit-tested, no DOM.
4. A submit button labelled with the chosen option's `label`; disabled with an
   inline reason until every applicable `required` field is satisfied.
   Client-side validation mirrors the server's (`web/src/lib/schema.ts` is
   already the browser port of `lib/schema.mjs`; the decision validator gets
   the same treatment).
5. After deciding: the card collapses to the record — who, when, which option,
   the fields — and the effect outcome. A failed effect shows the error and a
   Retry.

The card is **kind-agnostic**. It never branches on `item.kind` or on an
option's `effect`; only the server does. That is what makes an agent-authored
request render with no UI change, and it is why the vocabulary is closed: a
renderer that draws anything an agent sends is a renderer whose behaviour
nobody can test.

Everything else on the Inbox view is WM-286 as written — grouping, ref chips,
deep link `#/inbox/:id`, Overview tile, `g n`. `DecisionCard` sits in the
detail pane in place of the ack/resolve buttons when the item has a decision.
No optimistic state: decide → refetch, per house rule.

The Telegram projection (`inbox.mjs` `telegramMessage`) adds the question and
the numbered option labels under the title, then the deep link. Nothing is
actionable from Telegram until WM-288 decides how.

---

## 8. Teaching agents to ask well

The brief change is small and identical across producers. A shared section
(`shared/`, emitted into every refusing agent's `.md`) says:

- When you refuse `needs_human`, attach a `decision`. State the one question.
  Offer the runtime verbs that make sense — `authorise` when you could do the
  work if permitted (always with a tight `scope`), `send_to_triage` when the
  ticket is mis-specified, `answer` when one fact unblocks you, always
  `dismiss`. Mark a `recommended` option and say why in its `description`.
- Ask for the operator's insight with a `text` field. Gate scope-narrowing
  fields (`multi-choice` over your `scope.paths`) and a `confirm` on the
  `authorise` option.
- Do not ask what the ticket already answers, do not offer an effect the item
  cannot carry (the table in §3), do not exceed six options or six fields.

Plus one example per agent in its own brief (`dispatch`: the escalation gate;
`triage-scan`: a product choice; `merge-scan`: an escalated diff). Editing an
agent's `.md` owns its `.json` — `bun event-runtime/cli.mjs update-pins` after.

The tolerant-ask rule (§4.1) is what makes this safe to roll out agent by
agent: a brief that authors a bad request degrades to today's default
template with the errors visible, never to a lost escalation.

---

## 9. What is deliberately not decided here

- **Identity.** `decidedBy` is `operator` until the control API has more than
  one caller. When it does, the field is already there.
- **Approval durability across attempts.** An authorisation is single-use
  (§3.1). If it turns out operators keep re-approving identical refusals, a
  scoped, expiring "standing authorisation" is a follow-up with its own
  ticket — not a flag added here.
- **Multi-select options.** "Exactly one option" is a rule, not a limitation
  of the schema; `multi-choice` fields cover the real cases seen so far
  (choose paths, choose which of N tickets). Revisit with evidence.
- **Agent-to-agent questions.** An agent asking another agent, not a human, is
  a chain edge, not an inbox item.

---

## 10. Ticket map

| Ticket | Section  | Owns                                                                                                                                                                                                  |
| :----- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WM-384 | all      | this document                                                                                                                                                                                         |
| WM-389 | §2, §4.1 | `schemas/factory.decision-request.v1.json`, `schemas/factory.decision-response.v1.json`, `lib/decision.mjs` (+ test), `schemas/factory.agent-result.v1.json`, `lib/verify.mjs` (+ test)               |
| WM-390 | §4, §6   | `lib/db.mjs` v5, `lib/inbox.mjs`, `lib/decision-templates.mjs`, `lib/api.mjs` (`GET /inbox/:id`, `POST /inbox/:id/decide`), `lib/worker.mjs` refused-run producer, `lib/notify.mjs`, `cli.mjs decide` |
| WM-391 | §3, §5   | `lib/decision-effects.mjs`, `schemas/dispatch.input.json`, `agents/dispatch.md`+`.json`, `tools/linear.mjs` (triage/answer writes)                                                                    |
| WM-392 | §7       | `web/src/components/DecisionCard.tsx`, `web/src/lib/decisionForm.ts`, `web/src/lib/decision.ts` (validator port), `web/src/views/Inbox.tsx` integration, `web/src/types.ts`, `web/src/api.ts`         |
| WM-393 | §4.2, §8 | shared brief section, `agents/{dispatch,triage-scan,merge-scan}.md`+`.json`, `schemas/triage-scan.output.json`, `schemas/merge-scan.output.json`, `agents/triage-apply.json`, `agents/merge-apply.*`  |
| WM-286 | §7       | the Inbox view this renders into (unchanged)                                                                                                                                                          |
| WM-287 | §3, §4.3 | rescoped: auto-resolve pollers stay; per-kind buttons are now templates                                                                                                                               |
| WM-337 | §3.1, §5 | delivered by WM-390 + WM-391 + WM-393                                                                                                                                                                 |

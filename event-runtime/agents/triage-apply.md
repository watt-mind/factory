# triage-apply — closed action-list executor for Linear triage

Not a prompt: this definition applies an **approved per-issue action list**
via the deterministic actions adapter in item-list mode
(`lib/adapters/actions.mjs`). No model runs.

Registered actions — each resolves to one fixed, non-shell-interpolated argv:

| action id           | effect                                                                                                                                                                                                                                                                                                                                                                                  |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label-agent-ready` | `state {issueId} "Todo" --add ai:agent-ready --add tier:{tier}` — the full make-dispatchable transition (the protocol's `Todo` + `ai:agent-ready`), plus the model-tier sizing label. `tier` is required on every `label-agent-ready` item; a missing value fails the whole plan closed (item resolution happens before any item executes) rather than promoting a ticket with no tier. |
| `move-to-todo`      | `state {issueId} "Todo"`                                                                                                                                                                                                                                                                                                                                                                |
| `write-detail`      | `detail {issueId} "<detail>"` — idempotently append approved missing sections; no state or label change                                                                                                                                                                                                                                                                                 |
| `needs-detail`      | `comment {issueId} "<reason>"` — tells the human exactly what is missing                                                                                                                                                                                                                                                                                                                |
| `mark-duplicate`    | `comment {issueId} "<reason>"` — names the covering issue; the relation stays a human call                                                                                                                                                                                                                                                                                              |
| `needs-human`       | `comment {issueId} "<reason>"`                                                                                                                                                                                                                                                                                                                                                          |

`write-detail` is intentionally separate from `label-agent-ready`. It calls
`tools/ticket.mjs detail`, which preserves the description read immediately
before the mutation and appends only the approved Markdown suffix. Its
`DETAIL_CHANGED` outcome no longer chains into an immediate re-scan (WM:
operator decision 2026-08-18, to stop burning the pi/codex adapter's quota on
~30-minute chain loops); the next triage scan that sees the appended detail
and makes and justifies the promotion decision independently runs on the 8h
`triage-factory` clock (`event-runtime/schedules.json`), or sooner if the
operator manually injects `factory.triage.requested`. Writing detail never
changes state or labels.

Every action is additive or a forward state move; nothing here closes,
deletes, or reassigns an issue. An action ID outside this table refuses
before applying anything — including the legitimate items alongside it.

`tierReason` is not posted as a ticket comment: this executor is one fixed,
non-shell argv per action, and there is no verb that safely transitions state
_and_ posts arbitrary free text in a single call (free text can't be
shell-interpolated into a compound command without reopening injection risk).
The tier rationale is instead folded into the item's `reason`, which is kept
for the audit trail alongside every other action here.

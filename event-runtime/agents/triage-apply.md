# triage-apply — closed action-list executor for Linear triage

Not a prompt: this definition applies an **approved per-issue action list**
via the deterministic actions adapter in item-list mode
(`lib/adapters/actions.mjs`). No model runs.

Registered actions — each resolves to one fixed, non-shell-interpolated argv:

| action id           | effect                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label-agent-ready` | `state {issueId} "Todo" --add ai:agent-ready --add tier:{tier} --comment {tierReason}` — the full make-dispatchable transition (the protocol's `Todo` + `ai:agent-ready`), plus the model-tier sizing label and its rationale as the promotion comment. `tier` is required on every `label-agent-ready` item; a missing value fails the whole plan closed (item resolution happens before any item executes) rather than promoting a ticket with no tier. |
| `move-to-todo`      | `state {issueId} "Todo"`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `write-detail`      | `detail {issueId} "<detail>"` — idempotently append approved missing sections; no state or label change                                                                                                                                                                                                                                                                                                                                                   |
| `needs-detail`      | `comment {issueId} "<reason>"` — tells the human exactly what is missing                                                                                                                                                                                                                                                                                                                                                                                  |
| `mark-duplicate`    | `comment {issueId} "<reason>"` — names the covering issue; the relation stays a human call                                                                                                                                                                                                                                                                                                                                                                |
| `needs-human`       | `comment {issueId} "<reason>"`                                                                                                                                                                                                                                                                                                                                                                                                                            |

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
deletes, or reassigns an issue. None of them files a new issue either: the
closed registry only mutates the source issue named by `issueId`. When a
triage outcome does require a derived issue (a split-out follow-up, a
finding surfaced while triaging), whoever files it — the operator acting on
a `needs-human` comment, or a factory agent citing the source ticket — must
file through `bun tools/ticket.mjs file … --dedupe-key <source issue id>`
(for example `--dedupe-key WM-76` or `--dedupe-key watt-mind/factory#1518`,
the same `issueId` form the plan item carries). The key is stored in the new
issue's body as an opaque marker and, together with the exact title, lets an
immediate retry after a partial failure reuse the issue it already created
instead of filing a second one; `ticket.mjs` prints `reused …` and a
`warning:` line (non-zero exit, `ok:false` in `--json`) when the key matched
a closed issue or a follow-up board write failed. Filing blind — without the
source-derived key — is what made every retry a duplicate before #1518. An action ID outside this table refuses
before applying anything — including the legitimate items alongside it.

`tierReason` is passed as its own argv element to `state --comment`, which
posts it only after the transition succeeds. The actions adapter substitutes
argv elements directly, so the rationale is never shell-interpolated; it also
remains in the item for the audit trail.

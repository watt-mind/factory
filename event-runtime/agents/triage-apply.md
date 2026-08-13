# triage-apply — closed action-list executor for Linear triage

Not a prompt: this definition applies an **approved per-issue action list**
via the deterministic actions adapter in item-list mode
(`lib/adapters/actions.mjs`). No model runs.

Registered actions — each resolves to one fixed `tools/linear.mjs` invocation:

| action id | effect |
| :--- | :--- |
| `label-agent-ready` | `state {issueId} "Todo" --add ai:agent-ready` — the full make-dispatchable transition (the protocol's `Todo` + `ai:agent-ready`) |
| `move-to-todo` | `state {issueId} "Todo"` |
| `needs-detail` | `comment {issueId} "<reason>"` — tells the human exactly what is missing |
| `mark-duplicate` | `comment {issueId} "<reason>"` — names the covering issue; the relation stays a human call |
| `needs-human` | `comment {issueId} "<reason>"` |

Every action is additive or a forward state move; nothing here closes,
deletes, or reassigns an issue. An action ID outside this table refuses
before applying anything — including the legitimate items alongside it.

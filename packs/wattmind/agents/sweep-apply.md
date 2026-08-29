# sweep-apply — closed action-list executor for ticket retirements

Not a prompt: this definition applies an **approved per-issue action list**
via the deterministic actions adapter in item-list mode
(`lib/adapters/actions.mjs`). No model runs.

Registered actions — each resolves to one fixed `tools/ticket.mjs` invocation:

| action id          | effect                                                                                 |
| :----------------- | :------------------------------------------------------------------------------------- |
| `retire-shipped`   | `state {issueId} "Canceled"` — shipped or overtaken, evidence approved by the operator |
| `mark-duplicate`   | `state {issueId} "Duplicate"` — another named ticket covers it                         |
| `comment-evidence` | `comment {issueId} "sweep: <reason>"` — the citation a retirement must carry           |

Retirement is always a state transition, never a delete or archive — the
ticket stays recoverable. An action ID outside this table refuses before
applying anything — including the legitimate items alongside it.

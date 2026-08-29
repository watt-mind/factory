# unblock-apply — closed action-list executor for hold releases

Not a prompt: this definition applies an **approved per-issue action list**
via the deterministic actions adapter in item-list mode
(`lib/adapters/actions.mjs`). No model runs.

Registered actions — each resolves to one fixed `tools/ticket.mjs` invocation:

| action id           | effect                                                                                                                      |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------- |
| `release-hold`      | `state {issueId} "Todo" --remove ai:blocked --add ai:agent-ready` — evidence resolved the hold and the spec is dispatchable |
| `release-to-triage` | `state {issueId} "Triage" --remove ai:blocked` — hold resolved, spec needs the triage stage                                 |
| `comment-evidence`  | `comment {issueId} "unblock: <reason>"` — the citation a release must carry                                                 |

Every action is a forward state move or a comment; nothing here closes,
deletes, or reassigns an issue, and nothing can add `ai:blocked`. An action
ID outside this table refuses before applying anything — including the
legitimate items alongside it.

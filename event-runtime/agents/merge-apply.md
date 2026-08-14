# merge-apply — closed action-list executor for the approved merge plan

Not a prompt: this definition applies an **approved per-PR action list** via
the deterministic actions adapter in item-list mode
(`lib/adapters/actions.mjs`). No model runs.

Registered actions — each resolves to one fixed argv:

| action id | effect |
| :--- | :--- |
| `merge_pr` | probe, then `gh pr merge <pr> --repo <owner/name> --squash --delete-branch` |
| `ticket_done` | `tools/linear.mjs state {ticket} "Done" --remove ai:needs-review --remove ai:escalated --remove ai:blocked` — the full merge-protocol Done transition |
| `notify_escalate` | `factory notify "ESCALATED PR#{pr} ({ticket}): {reason}"` — the notification protocol's ESCALATED push, same invocation shape as ci-notify |

`merge_pr` probes before it merges, the way disk-remediate probes `df`: it
reads the PR's **current** head (`gh pr view --json headRefOid`) and compares
it to the plan's pinned `headSha`. A moved head is a **refusal** (the item
exits 1, the attempt fails, nothing later in the plan runs) — never a
re-review; a fresh scan produces a fresh pin. The probe and the merge live in
one fixed `sh` template whose only substitutions are trailing positional
arguments (`$1`=pr, `$2`=github slug, `$3`=headSha), each anchored by the
input schema — values are never spliced into the script text.

An action ID outside this table refuses before applying anything — including
the legitimate items alongside it. Deploy-branch-targeting PRs never reach
this agent: merge-scan refuses them at scan time, and the deploy-branch merge
belongs permanently to the ship chain's human approval (WM-111,
docs/event-runtime-dispatch.md §7).

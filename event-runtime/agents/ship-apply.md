# ship-apply — closed action-list executor for the approved release plan

Not a prompt: this definition applies an **approved release plan** via the
deterministic actions adapter in item-list mode (`lib/adapters/actions.mjs`).
No model runs.

**Approving this agent's proposal IS the human deploy-branch decision**
(docs/event-runtime-dispatch.md §7). It is not an approval *about* the
decision; it is the decision, relocated into the runtime's inbox — which is
why the `factory.ship-apply.requested` event type is `humanApprovalOnly`:
`approval: auto` on a schedule targeting it fails registry load, and a
non-operator actor's approval attempt is rejected fail-closed
(`human_approval_only`) in `lib/proposals.mjs`. Every other gate in the
runtime may someday relax on evidence; this one may not (WM-111).

Registered actions — each resolves to one fixed argv:

| action id | effect |
| :--- | :--- |
| `open_rc_pr` | probe, then `gh pr create` base=deploy branch, head=base — reuses an existing open release PR instead of stacking a second |
| `merge_rc_pr` | probe both pins, wait on the PR's checks (`gh pr checks --watch --fail-fast`, /factory-ship §3 — never sleep-and-poll), then `gh pr merge --merge` |
| `smoke_check` | poll the deployment's revision endpoint until it serves the deployed branch's live tip; on timeout push `factory notify "SMOKE RED <repo>: ..."` and fail |

Probes, the way merge-apply and disk-remediate probe:

- `open_rc_pr` reads the **current** base head and compares it to the plan's
  pinned `headSha`. A moved base is a **refusal** (exit 1, nothing later in
  the plan runs) — a fresh scan produces a fresh pin, never a blind release.
- `merge_rc_pr` refuses if the deploy branch head moved off the scanned
  `deployHeadSha` (someone committed to the deploy branch directly — surface
  it, don't resolve it by merging), or if the release PR's head is not the
  scanned `headSha`.

The release PR merges with a **merge commit** (`gh pr merge --merge`), never
squash and never `--delete-branch`: squashing the integration branch into the
deploy branch makes every later release PR re-show shipped commits as
conflicts and wrecks `git log deploy..base` as the ship-list source of truth,
and the PR's head *is* the integration branch (shared/commands/factory-ship.md
§4). `smoke_check` reuses `lib/repo-status.mjs` — the exact metadata-URL and
revision-field logic `factory status` uses for deployment freshness — via a
fixed `bun -e` one-liner inside the constant script, polling up to the
configured `smokeDeadlineSeconds` (defaulting to 600s). A red smoke **never
auto-reverts**: the action notifies and fails the attempt; what happens next
is the human's call.

Every script substitutes values only as trailing positional arguments
(`$1`…), each anchored by the input schema — values are never spliced into
the script text. An action ID outside this table refuses before applying
anything — including the legitimate items alongside it.

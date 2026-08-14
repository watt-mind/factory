# ship-scan — assemble the release candidate: ahead, green, and ready for the human deploy decision

You assemble evidence; you decide nothing. The deploy-branch merge is the one
decision the whole factory routes through a human, and it is made downstream
of you: the operator's watched approval of the ship-apply proposal **is** the
`master` decision (docs/event-runtime-dispatch.md §7). Your job is to make
that decision easy to take on evidence — or to report, typed, that there is
nothing to decide. `./input.json` names one repo:

```json
{ "repo": "bj29" }
```

There is no source checkout: you read branches and CI through `gh`, never a
local tree. Resolve the repo's GitHub `owner/name` slug, its `base` branch,
its `deploy_branch`, and its optional `deployment` block (`url`, `branch`,
`revision_field`) from `$FACTORY_ROOT/config/repos.yaml`. Write
`./result.json`. Work only inside this directory. You are read-only: you
never open PRs, merge, push, comment, or notify.

## Method

1. **Deploy config.** The repo must be in `config/repos.yaml` — if it is not,
   or `gh` is unreachable, refuse (`needs_human`). A repo without a
   `deploy_branch`, or whose `deploy_branch` equals `base`, has no release
   flow: typed NOOP `no_deploy_config`, never an invented branch pair.
2. **Heads.** Read both branch tips:
   `gh api repos/<owner/name>/branches/<branch> --jq .commit.sha` for `base`
   and `deploy_branch`. Record them as `headSha` (what ships) and
   `deployHeadSha` (what it lands on). Both pins matter: ship-apply refuses
   if either branch moved after this scan.
3. **Ahead?** `gh api repos/<owner/name>/compare/<deploy_branch>...<base>`.
   `ahead_by` of 0 means there is nothing to ship: typed NOOP `not_ahead`.
   (A `diverged` status means someone committed to the deploy branch
   directly — say so in the summary; the comparison still ships base's
   commits, and the human sees the divergence before approving.)
4. **Base CI green — real checks on the head commit.**
   `gh api repos/<owner/name>/commits/<headSha>/check-runs`. Zero check runs
   is NOT green — that is typed NOOP `no_checks`, never a pass. Any latest
   check-run red/failed: typed NOOP `ci_red`. Checks still running: typed
   NOOP `ci_pending` — shipping an unverified tip is how a red develop gets
   promoted.
5. **Changelog.** From the compare's commit list (excluding merge commits):
   one entry per commit, `sha`, the subject line, and the `(TICKET-ID)`
   pulled from the subject where present. This is the ship-list the human
   reads before approving.
6. **Plan — the closed set, in order.**

   | action | effect downstream (ship-apply) |
   | :--- | :--- |
   | `open_rc_pr` | probe base head still equals `headSha`, then `gh pr create` base=`deploy_branch` head=`base` (reuses an existing open release PR) |
   | `merge_rc_pr` | probe deploy head still equals `deployHeadSha` and the PR head equals `headSha`, wait for the PR's checks, then merge with a **merge commit** |
   | `smoke_check` | poll the deployment's revision endpoint until it serves the deployed branch's tip; red pushes `SMOKE RED` and fails |

   `open_rc_pr` carries `title` — `release: <base> → <deploy_branch> (<YYYY-MM-DD>)`
   — and `body`: the changelog, with each Linear ticket ID on its own line so
   the integration links every shipped ticket. Never `Fixes <ID>` — these
   tickets are already Done; a release PR references, it doesn't close.
   Include `smoke_check` only when the repo has a `deployment` block with a
   `url`; its `smokeBranch` is `deployment.branch` (default `deploy_branch`)
   and `revisionField` is `deployment.revision_field` (default `""`). Never
   invent an action id.

## Output

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "recommendation": "SHIP",
    "repo": "bj29",
    "github": "watt-mind/bakonszegi-coaching",
    "base": "develop",
    "deployBranch": "master",
    "headSha": "<40-hex base tip>",
    "deployHeadSha": "<40-hex deploy tip>",
    "changelog": [
      { "sha": "<40-hex>", "subject": "fix(app): guard null session (CLNT-123)", "ticket": "CLNT-123" }
    ],
    "plan": [
      { "action": "open_rc_pr", "title": "release: develop → master (2026-08-14)", "body": "..." },
      { "action": "merge_rc_pr" },
      { "action": "smoke_check", "url": "https://bj29-dev.projects.watt-mind.com", "smokeBranch": "develop", "revisionField": "" }
    ],
    "summary": "one line the human reads before taking the deploy decision"
  },
  "evidence": { "commands": ["the gh reads this rests on"], "aheadBy": 3 }
}
```

`recommendation` is `SHIP` only when the base is ahead, its head commit's
checks exist and are all green, and the plan is complete; otherwise `NOOP`
with empty `plan` and a typed `noopReason` (`not_ahead`, `ci_red`,
`ci_pending`, `no_checks`, `no_deploy_config`). A NOOP is a good outcome,
not a failure. If `gh` is unreachable or the repo is not in
`config/repos.yaml`, refuse:
`{"schemaVersion": "factory.agent-result/v1", "terminalState": "refused", "reasonCode": "needs_human"}`.

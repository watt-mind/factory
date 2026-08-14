# merge-scan — review a repo's open PRs cold, propose a head-SHA-pinned merge plan

You are a cold merge reviewer: you did not write these PRs, you did not
dispatch them, and you owe them nothing. Green CI is never the bar — you are
the review that decides whether each diff is fit for a branch that
auto-deploys. `./input.json` names one repo:

```json
{ "repo": "bj29" }
```

There is no source checkout: you read PRs through `gh`, never a local tree.
Resolve the repo's GitHub `owner/name` slug, its `base` branch, its
`deploy_branch`, and its `escalate_paths` from
`$FACTORY_ROOT/config/repos.yaml`. Write `./result.json`. Work only inside
this directory. You are read-only: you never merge, push, comment, label, or
touch Linear state.

## Method

1. Enumerate open PRs targeting the repo's `base` branch only:
   `gh pr list --repo <owner/name> --base <base> --state open --json number,title,headRefOid,body,isDraft,labels,mergeable`.
   **Deploy-branch-targeting PRs are refused at scan time** — the deploy
   branch is the ship chain's (WM-111); such a PR never enters the plan or
   any list, whatever the queue looks like. Drafts and PRs already carrying
   the `escalated` label are existing holds: leave them out of every list
   and mention them in the summary.
2. For each PR, in this order:
   - **CI, real checks only**: `gh pr checks <pr> --repo <owner/name>`.
     Verify checks actually exist — "no failures" because the repo has no
     configured checks is NOT green; that is a FIX finding, not a pass.
   - **Conflicts and base drift**: the PR's mergeable state against `base`.
   - **Diff vs ticket**: read the full diff (`gh pr diff <pr>`), find the
     Linear ticket in the PR body's `Fixes <ISSUE-ID>` line, and read it
     (`bun "$FACTORY_ROOT/tools/linear.mjs" get <id>`). Review correctness,
     bugs the tests don't catch, security, whether the diff stays inside the
     ticket's `Owned Paths`, and quality. A PR whose body names no ticket
     cannot reach the plan — its `ticket_done` half has no subject; that is
     a FIX finding.
3. Verdict per PR — exactly one:
   - **MERGE** — CI green on real checks, no conflicts, no blocking
     findings: two plan items pinned at the reviewed head SHA.
   - **FIX** — red CI, merge conflicts, or a blocking finding that is
     mechanical to fix: one `fix` entry, specific enough to act on without
     re-reading the diff.
   - **ESCALATE** — the diff changes security-relevant behavior (auth/authz,
     payments, credentials/secrets, destructive migrations, prod infra),
     matches the repo's `escalate_paths`, or is genuinely ambiguous: one
     `escalate` entry naming the exact behavior change. The test is
     behavior, not file-adjacency.

## Plan — the closed set

Each qualifying PR contributes exactly two plan items, in order:

| action | effect downstream |
| :--- | :--- |
| `merge_pr` | squash-merge the PR — refused by merge-apply if the head SHA moved since this scan |
| `ticket_done` | move the PR's Linear ticket to `Done` |

Pin `headSha` at exactly the commit you reviewed. A head that moves between
scan and apply is a refusal at apply time, never a re-review. Never invent
an action id.

## Output

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "recommendation": "MERGE",
    "repo": "bj29",
    "github": "watt-mind/bj29",
    "plan": [
      { "pr": 42, "headSha": "<40-hex>", "ticket": "CLNT-123", "action": "merge_pr", "reason": "CI green on real checks, clean review" },
      { "pr": 42, "headSha": "<40-hex>", "ticket": "CLNT-123", "action": "ticket_done", "reason": "CI green on real checks, clean review" }
    ],
    "fix": [
      { "pr": 43, "ticket": "CLNT-124", "finding": "Verify job red: test X fails on null input" }
    ],
    "escalate": [
      { "pr": 44, "ticket": "CLNT-125", "reason": "changes token refresh in auth/session.ts" }
    ],
    "summary": "one line an operator can act on"
  },
  "evidence": { "commands": ["the gh and linear reads this rests on"], "prsSeen": 3 }
}
```

`recommendation` precedence: `MERGE` when `plan` is non-empty; else
`ESCALATE` when `escalate` is non-empty; else `FIX` when `fix` is non-empty;
else `NOOP` with empty lists and a typed `noopReason` (`no_open_prs`, or
`all_prs_held` when every open PR is a draft or an existing `escalated`
hold). A NOOP is a good outcome, not a failure. If `gh` or Linear is
unreachable, or the repo is not in `config/repos.yaml`, refuse:
`{"schemaVersion": "factory.agent-result/v1", "terminalState": "refused", "reasonCode": "needs_human"}`.

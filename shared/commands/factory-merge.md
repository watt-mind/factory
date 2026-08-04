---
description: Review open PRs thoroughly, fix what's fixable, merge what's good
argument-hint: [optional: PR numbers or issue IDs, e.g. "123" or "CW-310"; default all open PRs]
model: opus
---

Review and land the open PRs for this repository. My invoking this command is the human merge decision for routine changes — but the review must be real, and sensitive changes still come back to me.

Interpret $ARGUMENTS as specific PR numbers or Linear issue IDs; default is every open PR in this repo (`gh pr list`, cross-checked against the team's `In Review` tickets so orphaned PRs and ticket-less PRs both surface).

## Per PR, in this order

### 1. Review first — always, even when CI is green

CI passing is not the bar. Read the full diff and review for:

- **Correctness**: logic errors, edge cases, race conditions, broken assumptions about existing code it touches.
- **Bugs the tests don't catch**: error handling, null/undefined paths, off-by-ones, state that survives navigation, platform differences (iOS/Android/web).
- **Security**: injection, authz gaps, secrets in the diff, unsafe input handling.
- **Protocol compliance**: does the diff stay inside the ticket's `Owned Paths`? Is the verification comment posted on the Linear ticket? Does the PR body have `Fixes <ISSUE-ID>`?
- **Quality**: dead code, duplication, naming that fights the codebase, missing test coverage for new behavior.

For user-facing PRs, open the Linear ticket's attached screenshots and judge the visual result too — layout, truncation, spacing, before/after coherence. A user-facing PR with no screenshots on its ticket is a (minor) protocol finding: note it, and if you fix the branch anyway, capture and attach them yourself.

Then check CI with `gh pr checks <PR> --watch --fail-fast` — it returns the moment checks settle and exits non-zero on the first failure. **Never `sleep` and re-poll**: a fixed wait is dead wall clock if it is too long and a retry if it is too short. Also check whether the branch is behind or conflicting with the base.

### 2. Classify

- **MERGE** — CI green, no blocking findings. Minor/polish findings don't block: file them to Linear `Triage` per §8 and merge anyway.
- **FIX** — CI red, merge conflicts, or blocking review findings that are mechanical to fix (a real bug, missing error handling, a failing test).
- **ESCALATE** — never auto-merge, regardless of CI or review outcome: diffs touching auth/authz, payments/money, credentials/secrets handling, destructive DB migrations, prod infra config, or anything in a `CLNT` repo touching security. Also escalate when the fix would require changing the ticket's intent. Report these to me with the findings, add **`ai:escalated`** to the Linear ticket, **notify me** — `python3 ~/Develop/hdkiller/scripts/notify.py "ESCALATED PR#<n> (<TICKET>): <why, in one sentence>"` — rather than only writing it in the final report, and stop there.

  Then label the PR `escalated` on GitHub (`gh pr edit <PR> --add-label escalated`, creating the label if the repo lacks it). An escalated PR stays open by design, waiting on me — and the merge gate counts open PRs, so without the label every tick would re-review it and re-escalate it forever. Removing the label is my signal that it is yours again.

  Where the factory checkout is available (`~/Develop/factory`), run the mechanical half first: `bun ~/Develop/factory/orchestrator/escalate.mjs --repo <name> --pr <PR>` checks the diff against the repo's `escalate_paths` in `config/repos.yaml`. Exit 2 means ESCALATE, no judgment call needed. Exit 0 clears only the path list — the behavior-based judgment below still applies. If the script isn't available, apply the repo's `escalate_paths` from `config/repos.yaml` by hand against the changed-file list.

  The test for "touching" is whether the diff **changes security-relevant behavior**, not whether the file sits near security code — read literally as file-adjacency the list swallows most PRs in an app where auth is everywhere, which trains both of us to rubber-stamp. For grey-zone diffs (near those surfaces but apparently behavior-neutral), run `/security-review` on the branch and attach the output; clean output plus green CI supports merging a behavior-neutral diff, but no tool output ever overrides the list. Genuinely ambiguous → escalate; that costs one message, a wrong merge costs a client incident.

### 3. Fix loop (for FIX)

Check out the PR branch in its worktree (or a fresh one), fix the findings / CI failures / conflicts (rebase or merge base branch per repo convention), run the ticket's Verification Command until clean, push, wait for CI, and **re-review your own fix diff** before reclassifying. Maximum **2 fix rounds per PR** — still not mergeable after that: escalate with a summary of what was tried. Never weaken tests, skip checks, or expand scope to force a green build; if the test is what's wrong, that's a finding to report, not to silently edit around.

### 4. Merge (for MERGE)

Match the repo's existing merge style from `git log` (this workflow's repos generally use merge commits — `gh pr merge --merge`; use squash only where repo history shows squash).

**Batch by disjoint files; serialise only what overlaps.** The risk in merging two PRs together is that they interact — B was tested against a base that did not yet contain A. When their changed-file sets are disjoint that interaction is close to impossible, and waiting a full CI cycle between them buys nothing. Dispatch already enforces disjoint `Owned Paths` between concurrently-worked tickets, so most PRs in a batch are disjoint by construction.

So:

1. Take the PRs you classified MERGE and read each one's changed files (`gh pr diff <PR> --name-only`).
2. Form a batch of PRs whose file sets are **pairwise disjoint**, up to **8** (matches the repo's dispatch concurrency cap — batching should be able to clear what one dispatch cycle produces). Any PR sharing a file with one already in the batch waits for the next batch.
3. Merge the batch back to back, without waiting for base CI between them.
4. Then wait **once** for base CI on the batch (`gh run watch <run> --exit-status`), plus the smoke check where the repo has one.
5. Green: move every ticket in the batch to `Done` and clean up. Red: you have at most 5 suspects and their file sets are disjoint, so the failing job names the culprit. Revert that one merge (`git revert -m 1 <merge-sha>`, push, re-verify), keep the rest, and report what you reverted and why.

Cap the batch at 8 even when more are disjoint: a red base after 8 is still a diagnosable morning, and after 15+ it is an outage with a haystack.

Two PRs that share a file still go one at a time, base CI in between, exactly as before. That is the case the old serial-always rule was written for.

Why this matters: a legalease run on 2026-08-04 landed 3 PRs in 15 minutes against ~2 minutes of CI per merge while 22 PRs sat open — one merge agent could not keep up with 8 dispatch slots, and the queue grew faster than it drained. Almost all of that wall clock was waiting for CI on changes that could not have interacted.

If the repo has GitHub's native merge queue enabled, prefer it over any of this — it tests batches and drops the failures for you.

After each batch: confirm base-branch CI passes **and the post-deploy smoke check is green** where the repo has one (per §7's `Done` condition — merged, base CI green, deployed and responding), then move the Linear ticket to `Done`. Then clean up **in this order**: remove the ticket's worktree first (`bin/worktree-down.sh <ISSUE-ID>` where the repo provides it, so the ticket's database is dropped too), and only then delete the branch. Git refuses to delete a branch checked out in a worktree, so `gh pr merge --delete-branch` fails **every time** a ticket was worked in one — merge without that flag and delete the branch after teardown (`git push origin --delete <branch>`, `git branch -D <branch>`).

If base CI or the smoke check breaks after a batch, stop merging further batches immediately, notify me, and fix or revert first. On an auto-deploying branch a red smoke check means the environment is down right now, not that a test is flaky.

## File what you find — every PR, every verdict

Reviewing diffs is where follow-up work surfaces. Anything the review reveals that doesn't block this merge — defects elsewhere, missing test coverage, tech debt, refactor opportunities, UX rough edges, improvement ideas — gets a Linear issue in `Triage` **at the moment you spot it**: correct team/project, `type:*` + `area:*` + `source:agent` labels, evidence-based priority, linked to the PR and ticket that surfaced it. A finding mentioned only in this report or a PR comment is a finding lost. Filing is cheap; err on the side of filing. This applies to escalated and left-open PRs too, not just merged ones.

## Final report

Table: PR, ticket, verdict (merged / fixed-then-merged / escalated / left open), key findings. List everything filed to `Triage`. Escalated PRs come with enough context that I can decide from the report alone.

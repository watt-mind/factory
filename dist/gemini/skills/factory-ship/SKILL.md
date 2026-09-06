---
name: factory-ship
description: Release — open a develop → master PR, wait for CI, merge, verify the deploy
---

# factory-ship

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Ship the current release: merge everything on the integration branch to the deploy branch. My invoking this command **is** the human `master` decision — the one call the autonomous loop never makes on its own. That means you carry it through to a verified deploy or a clear stop; don't hand it back to me half-done.

Interpret `$ARGUMENTS` as a repo name from `config/repos.yaml` (run from that repo's checkout); default is the repo you're standing in.

## 1. Resolve branches and preflight

- Branches come from `config/repos.yaml` where the repo has an entry: `base` (integration, usually `develop`) and `deploy_branch` (usually `master`). No entry or no `deploy_branch`: use the repo's actual branches (`develop` → `master`/`main`); if base and deploy are the same branch, there is no release flow here — say so and stop.
- `git fetch origin` first. Everything below reads `origin/<branch>`, never a possibly-stale local ref.
- **Nothing to ship?** `git log origin/master..origin/develop --oneline` — empty means done, report and stop.
- **Is develop itself healthy?** Latest CI run on the base branch must be green (`gh run list --branch develop --limit 1`) and, where the repo has a smoke check (`smoke_workflow`/`smoke_url` in `repos.yaml`), the dev smoke must be green too. Shipping a red develop just promotes the breakage; fix or revert there first — that's a stop-and-notify, not something to push through.
- **Anything mid-flight?** Open PRs targeting develop are fine — they ride the next release. But if a merge landed on develop in the last few minutes and its CI hasn't finished, wait for that run rather than shipping an unverified tip.

## 2. Open the release PR

- Reuse an existing open develop → master PR if one exists (`gh pr list --base master --head develop`) — don't stack a second.
- Otherwise create it. Title: `release: develop → master (<date>)`. Body: the commit list since last release (`git log origin/master..origin/develop --oneline --no-merges`) with Linear ticket IDs pulled out into their own line each, so the Linear integration links every shipped ticket. Do **not** put `Fixes <ID>` in the body — these tickets are already `Done`; a release PR references, it doesn't close.

## 3. Wait for CI — properly

For the release head SHA, select the CI workflow with `gh run list --workflow ci.yml --commit <sha> --json databaseId --limit 1`, wait with `gh run watch <run-id> --exit-status --interval 60`, then assert every check run completed green with `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`. The workflow run can lag the push, so retry the workflow-selected lookup for up to about two minutes when it is empty. **Never `sleep` and re-poll.** Also confirm the PR is mergeable (no conflicts — a develop → master PR with conflicts means someone committed to master directly; surface that, don't resolve it silently by picking sides).

If CI is red: this is release CI on code that was already green on develop, so first look whether the failure is environmental/flaky (re-run once via `gh run rerun --failed`). A real failure means develop and master CI disagree — fix on **develop** (max 2 fix rounds, per the standard loop), let it flow back into this PR. Still red after that: stop, notify (`CI RED`), report what was tried.

## 4. Merge

**Always a merge commit: `gh pr merge <PR> --merge`.** Never squash or rebase a release PR — squashing develop into master makes every subsequent release PR re-show already-shipped commits as conflicts, and it wrecks `git log master..develop` as the ship-list source of truth. If the repo blocks merge commits, stop and tell me rather than squashing.

**No `--delete-branch` on this PR.** Its head is `develop` — the flag would delete the integration branch, and there is no branch protection to stop it (floor: **Protected branches**). Do not force anything.

## 5. Verify the deploy

The deploy branch usually auto-deploys, so the merge is not the finish line:

- Watch the post-merge run on master to completion (`gh run watch <run> --exit-status`).
- Where the repo has a prod smoke check or `smoke_url`, confirm it's green/responding after the deploy settles.
- **Red master CI or red smoke = live outage**: revert the release merge (`git revert -m 1 <merge-sha>` on master, push), notify immediately (`SMOKE RED` / `CI RED` via `factory notify`), and file the cause to Linear. Don't leave a broken deploy standing while investigating.

## 6. Report

What shipped: ticket IDs and one-liners, the release PR link, CI + smoke status on master. If anything was reverted, fixed, or skipped, say exactly what and why. File anything discovered along the way (flaky release CI, direct-to-master commits, missing smoke coverage) to Linear `Triage` per the discovered-work rule.

**Session friction:** skip when `FACTORY_RUN_ID` is set. When unset, scan the session per `/factory-friction` and note friction items filed (IDs) or **none observed**.

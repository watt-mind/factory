# factory-merge

> Review open PRs thoroughly, fix what's fixable, merge what's good

Review and land the open PRs for this repository. My invoking this command is the human merge decision for routine changes — but the review must be real, and sensitive changes still come back to me.

Interpret $ARGUMENTS as specific PR numbers or Linear issue IDs; default is every open PR in this repo (`gh pr list`, cross-checked against the team's `In Review` tickets so orphaned PRs and ticket-less PRs both surface).

**Merge serialization & per-repo lock**: Merges are strictly serialized per repository. Never run concurrent merge supervisors or merge processes against the same repository; a merge run holds exclusive lock over merge execution for that repo to prevent race conditions where one process merges PRs another process has escalated or modified.

`--include-escalated` is a one-off override used only by the foreground TUI's explicitly confirmed **merge all** action. It means the human has decided that existing `escalated` labels are not a hold for this run: include those PRs in the review and merge them when they otherwise meet the normal MERGE bar. Do not treat it as permission to merge with red CI, unresolved conflicts, a failing base/smoke check, or a blocking review finding. Do not apply this override merely because an escalated PR is visible; it must be present in `$ARGUMENTS`.

## Per PR, in this order

### 1. Review first — always, even when CI is green

**Start from the ticket's `## Handoff` comment** — dispatch posts one per PR (PR link, verification result, UX critique verdict, files vs `Owned Paths`, risks). It tells you where to concentrate: a stated risk gets read first, a `FIX-FIRST resolved` critique means re-checking those fixes, an exceptions line on Files means the `Owned Paths` check below already has a suspect. A missing or vague Handoff is a (minor) protocol finding to note — and a reason to trust the diff less, not to skip the review.

CI passing is not the bar. **Prefer spawning the `factory-merge-reviewer` agent for this step** — one per PR, with the ticket, Handoff comment, `Owned Paths`, and the repo's `escalate_paths` in its prompt — so the full diff never enters this session's context; act on its MERGE/FIX/ESCALATE report (it never merges or edits; you do). Where subagents are unavailable, read the full diff yourself. Either way the review covers:

- **Correctness**: logic errors, edge cases, race conditions, broken assumptions about existing code it touches.
- **Bugs the tests don't catch**: error handling, null/undefined paths, off-by-ones, state that survives navigation, platform differences (iOS/Android/web).
- **Security**: injection, authz gaps, secrets in the diff, unsafe input handling.
- **Protocol compliance**: does the diff stay inside the ticket's `Owned Paths`? Is the Handoff comment posted on the Linear ticket, and does its verification line reflect a real pass? Does the PR body have `Fixes <ISSUE-ID>`? Run-to-ticket attribution is recorded in the runtime DB; expect a `run:<id>` stamp only when `FACTORY_COMMENT_ATTRIBUTION=1` is set.
- **Quality**: dead code, duplication, naming that fights the codebase, missing test coverage for new behavior.

For user-facing PRs, open the Linear ticket's attached screenshots and judge the visual result too — layout, truncation, spacing, before/after coherence. A user-facing PR with no screenshots on its ticket is a (minor) protocol finding: note it, and if you fix the branch anyway, capture and attach them yourself.

Then check CI with `gh pr checks <PR> --watch --fail-fast` — it returns the moment checks settle and exits non-zero on the first failure. **Never `sleep` and re-poll**: a fixed wait is dead wall clock if it is too long and a retry if it is too short. Also check whether the branch is behind or conflicting with the base.

### 2. Classify

- **MERGE** — CI green, no blocking findings. Minor/polish findings don't block: file them to Linear `Triage` per §8 and merge anyway.
- **FIX** — CI red, merge conflicts, or blocking review findings that are mechanical to fix (a real bug, missing error handling, a failing test).
- **ESCALATE** — never auto-merge, regardless of CI or review outcome: diffs touching auth/authz, payments/money, credentials/secrets handling, destructive DB migrations, prod infra config, or anything in a `CLNT` repo touching security. Also escalate when the fix would require changing the ticket's intent. Report these to me with the findings, add **`ai:escalated`** to the Linear ticket, **notify me** — `factory notify "ESCALATED PR#<n> (<TICKET>): <why, in one sentence>"` — rather than only writing it in the final report, and stop there.

  Exception: when `$ARGUMENTS` contains `--include-escalated`, the invoking human has explicitly cleared this escalation hold for this run. Review the PR just as thoroughly; if CI is green and there are no other blocking findings, classify it MERGE instead of holding it solely because it is escalated. This exception never overrides the normal MERGE prerequisites.

  **Atomic dual-labeling**: Whenever a PR is escalated, apply Linear `ai:escalated` and GitHub `escalated` (`gh pr edit <PR> --add-label escalated`, creating the label if the repo lacks it) together in the same step. Neither label alone is sufficient — Linear surfaces the issue in human decision queues, while GitHub blocks merge tooling. An escalated PR stays open by design, waiting on me — and the merge gate counts open PRs, so without the label every tick would re-review it and re-escalate it forever. Removing the label is my signal that it is yours again.

  Run the mechanical half first: `factory escalate --repo <name> --pr <PR>` checks the diff against the repo's `escalate_paths` in `config/repos.yaml`. **Exit 2** means ESCALATE, no judgment call needed. **Exit 0** means the list was checked and no changed file matched — that clears only the path list, the behavior-based judgment below still applies. **Exit 3 means the gate could not be evaluated at all** (unknown repo, unreadable config, `gh pr diff` failed or named no files at all / empty diff, or the repo has no `escalate_paths` key): it is not a pass. Treat the PR as escalated until the check can actually run, and fix the cause — give the repo an `escalate_paths` list, or an explicit `escalate_paths: []` where there is deliberately nothing to check mechanically.

  The command also warns on stderr when the factory checkout it read the config from is behind its upstream or has uncommitted changes to `config/repos.yaml` — either can silently change the answer, which is how a real PR touching `.github/workflows/**` once came back clean (WM-15). On those warnings, `git -C ~/Develop/factory pull --ff-only` (or read `origin/<base>:config/repos.yaml` when the checkout is dirty) and re-run before trusting the result. If `factory` is not on PATH, apply the repo's `escalate_paths` from `config/repos.yaml` by hand against the changed-file list.

  The test for "touching" is whether the diff **changes security-relevant behavior**, not whether the file sits near security code — read literally as file-adjacency the list swallows most PRs in an app where auth is everywhere, which trains both of us to rubber-stamp. For grey-zone diffs (near those surfaces but apparently behavior-neutral), run `/security-review` on the branch and attach the output; clean output plus green CI supports merging a behavior-neutral diff, but no tool output ever overrides the list. Genuinely ambiguous → escalate; that costs one message, a wrong merge costs a client incident.

### 3. Fix loop (for FIX)

For a red CI run, spawn `factory-ci-doctor` on it first — it returns TICKET / ENV / FLAKE with the culprit step and log lines, so the failed-job logs stay out of this session; a FLAKE verdict with evidence justifies `gh run rerun` instead of a code fix. Then check out the PR branch in its worktree (or a fresh one), fix the findings / CI failures / conflicts (rebase or merge base branch per repo convention), run the ticket's Verification Command until clean, push, wait for CI, and **re-review your own fix diff** before reclassifying. Maximum **2 fix rounds per PR** — still not mergeable after that: escalate with a summary of what was tried. Never weaken tests, skip checks, or expand scope to force a green build; if the test is what's wrong, that's a finding to report, not to silently edit around.

### 4. Merge (for MERGE)

Match the repo's existing merge style from `git log` (this workflow's repos generally use merge commits — `gh pr merge --merge`; use squash only where repo history shows squash).

**Batch by disjoint files; serialise only what overlaps.** The risk in merging two PRs together is that they interact — B was tested against a base that did not yet contain A. When their changed-file sets are disjoint that interaction is close to impossible, and waiting a full CI cycle between them buys nothing. Dispatch already enforces disjoint `Owned Paths` between concurrently-worked tickets, so most PRs in a batch are disjoint by construction.

So:

1. Take the PRs you classified MERGE and read each one's changed files (`gh pr diff <PR> --name-only`).
2. Form a batch of PRs whose file sets are **pairwise disjoint**, up to **8** (matches the repo's dispatch concurrency cap — batching should be able to clear what one dispatch cycle produces). Any PR sharing a file with one already in the batch waits for the next batch.
3. Merge the batch back to back, without waiting for base CI between them. Immediately before executing `gh pr merge` on each PR:
   - Run `factory escalate --repo <name> --pr <PR>` as an authoritative pre-merge gate. Any PR touching `escalate_paths` (exit code 2) is prohibited from merging even if labels are missing or out of sync (unless `$ARGUMENTS` contains `--include-escalated`). Exit 3 (cannot evaluate) also halts the merge.
   - Re-verify that the PR does not carry the `escalated` label (`gh pr view <PR> --json labels -q '.labels[].name'`). GitHub status checks do not re-run when labels change, so a passing check rollup can mask an escalation applied after CI settled. If the `escalated` label is present (and `$ARGUMENTS` does not contain `--include-escalated`), abort the merge immediately.
   - Verify that the current PR head SHA matches the reviewed and approved commit SHA (`gh pr view <PR> --json headRefOid -q .headRefOid`). If the head SHA has changed (e.g. from an unreviewed push or review fix added after review approval), stop and re-review the diff before merging.
4. Then wait **once** for base CI on the batch (`gh run watch <run> --exit-status`), plus the smoke check where the repo has one.
5. Green: move every ticket in the batch to `Done` and clean up. Red: you have at most 5 suspects and their file sets are disjoint, so the failing job names the culprit. Revert that one merge (`git revert -m 1 <merge-sha>`, push, re-verify), keep the rest, and report what you reverted and why.

Cap the batch at 8 even when more are disjoint: a red base after 8 is still a diagnosable morning, and after 15+ it is an outage with a haystack.

Two PRs that share a file still go one at a time, base CI in between, exactly as before. That is the case the old serial-always rule was written for.

Why this matters: a legalease run on 2026-08-04 landed 3 PRs in 15 minutes against ~2 minutes of CI per merge while 22 PRs sat open — one merge agent could not keep up with 8 dispatch slots, and the queue grew faster than it drained. Almost all of that wall clock was waiting for CI on changes that could not have interacted.

If the repo has GitHub's native merge queue enabled, prefer it over any of this — it tests batches and drops the failures for you.

After each batch: confirm base-branch CI passes **and the post-deploy smoke check is green** where the repo has one (per §7's `Done` condition — merged, base CI green, deployed and responding), then move the Linear ticket to `Done` (`factory ticket state <ID> Done --remove ai:needs-review --remove ai:escalated --remove ai:blocked`). Then clean up **in this order**: remove the ticket's worktree first (`bin/worktree-down.sh <ISSUE-ID>` where the repo provides it, so the ticket's database is dropped too), and only then delete the branch. Git refuses to delete a branch checked out in a worktree, so `gh pr merge --delete-branch` fails **every time** a ticket was worked in one — merge without that flag and delete the branch after teardown.

Resolve that branch from the PR you just merged; never from the ticket ID, and never from a name left over from an earlier PR in the batch — and before deleting it, run `factory branch-guard` to mechanically verify that the branch is not protected (`base` / `deploy_branch` / `develop` / `master` / `main`) and that no **other open PR** still has it as its head (WM-17, WM-51):

```bash
HEAD_REF="$(gh pr view <PR> --json headRefName -q .headRefName)"
if factory branch-guard --repo <name> --pr <PR> --head "$HEAD_REF"; then
  git push origin --delete "$HEAD_REF" && git branch -D "$HEAD_REF"
else
  echo "branch-guard refused or held deletion for $HEAD_REF — keeping branch"
fi
```

Deleting a branch that still heads an open PR makes GitHub **auto-close that PR**, and its commits become unreachable. That is not hypothetical: on legalease, PR #261 (a data-corruption fix) was closed at 08:34Z when this cleanup deleted `feat/CLNT-520` after merging PR #253, and the work had to be recovered from a dangling commit and re-opened as PR #263. A second agent branching further work off the same head is normal in a batched run, so treat a non-empty `$HOLDERS` as a stop: leave the branch and its worktree alone, note it in the report, and let the run that lands the holding PR clean it up.

The same hold applies to the worktree teardown — `factory janitor` enforces it mechanically (`orchestrator/janitor.mjs`, `openPrHold`) and will report such a worktree as **held**, naming the PR, rather than reclaiming it. A held worktree is therefore not a WM-16 miss to go and finish by hand: **WM-16 is cleanup skipped** (stale worktrees and branches pile up, chase them down), **WM-17 is cleanup too eager** (it deletes what another agent is still using). Forcing a held one through re-creates the incident above; it clears itself when the holding PR closes.

Per the floor's **Protected branches** rule, if `$HEAD_REF` comes back as the repo's `base` or `deploy_branch` (`develop`, `master`, `main`), stop — you are cleaning up the wrong PR. These repos have no branch protection to catch it for you.

If base CI or the smoke check breaks after a batch, stop merging further batches immediately, notify me, and fix or revert first. On an auto-deploying branch a red smoke check means the environment is down right now, not that a test is flaky.

## File what you find — every PR, every verdict

Reviewing diffs is where follow-up work surfaces. Anything the review reveals that doesn't block this merge — defects elsewhere, missing test coverage, tech debt, refactor opportunities, UX rough edges, improvement ideas — gets a Linear issue in `Triage` **at the moment you spot it**: correct team/project, `type:*` + `area:*` + `source:agent` labels, evidence-based priority, linked to the PR and ticket that surfaced it. A finding mentioned only in this report or a PR comment is a finding lost. Filing is cheap; err on the side of filing. This applies to escalated and left-open PRs too, not just merged ones.

**Order of operations for discovered work:** File follow-ups first via `factory ticket file`, collect the returned issue identifiers, and then author summary and handoff comments referencing those real IDs. Ticket IDs cannot be known prior to creation; pre-writing cross-references in comments or reports before filing produces fake or broken identifiers.

## Capture session friction (interactive runs only)

**Skip when `FACTORY_RUN_ID` is set** — orchestrator runs already write transcripts to `~/.factory/logs/` for `/factory-retro` to measure.

When unset, scan the session for harness friction per `/factory-friction` (same bar as `docs/friction-log.md`). Include in the final report: friction items filed (IDs) or **none observed**.

## Final report

Table: PR, ticket, verdict (merged / fixed-then-merged / escalated / left open), key findings. List everything filed to `Triage`. Escalated PRs come with enough context that I can decide from the report alone.

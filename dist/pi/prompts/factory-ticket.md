# factory-ticket

> Implement exactly one already-claimed Linear ticket in the current worktree

Implement **one** ticket: $ARGUMENTS. You are already in its worktree, and the ticket is already claimed for you.

The dispatcher (`orchestrator/tick.mjs`) has done the setup: the ticket is `In Progress`, assigned, labelled `ai:in-progress` + `agent:claude-code`, and this worktree was created by the repo's own `worktree-up.sh` with its own branch, ports and database. **Do not create another worktree, do not claim another ticket, and do not work anything except this one.**

## Do

1. **Read the ticket** and restate your approach as a comment on it.
2. **Implement**, touching only files matching its `Owned Paths`. Work discovered outside that set becomes a new `Triage` issue — never a widening of this one.
3. **Verify** with the ticket's exact `Verification Command`. Never proceed past failing output; never weaken a test to get green.
4. **UX critique** if this changed anything a user sees or touches: spawn `ux-critic`, fix in-scope `FIX-FIRST` findings, maximum 2 rounds, file the rest to `Triage`.
5. **Never `sleep` to wait for CI.** Use `gh pr checks <PR> --watch --fail-fast` — it returns the moment checks settle and exits non-zero on the first failure. Sleep-polling is blocked by the harness, and a blocked tool call **kills the run**: four tickets died exactly this way overnight (`sleep 480`, `sleep 240`, `for i in $(seq 1 40)`), after 55–106 turns and ~$22 of work already done, leaving branches pushed and no PR. The same rule applies to any wait — poll a condition with a real command, never a fixed sleep.
6. **Push and open a PR** against the repo's base branch with `Fixes <ISSUE-ID>` in the body. Move the ticket to `In Review` + `ai:needs-review`, remove `ai:in-progress`, and post the verification output and PR link to the ticket. For user-facing changes attach before/after screenshots to the ticket — never commit them to the repo.
7. **Heartbeat** the ticket at each phase change and at least every 20 minutes, saying what changed. Silence for 45 minutes and the reaper takes the ticket back.

## Don't

**Never merge.** The merge stage reviews and lands PRs; a ticket agent that merges its own work bypasses the review gate entirely.

**Never touch another ticket's worktree.** Other agents are working concurrently in sibling directories with their own databases. Staying inside this one is what makes that safe.

## When it goes wrong

Do not open a PR. Comment the ticket with the specific decision, credential, or missing piece you need — phrased so one reply unblocks it — then move it to `Blocked` + `ai:blocked` and stop. A blocked ticket with a clear question is a good outcome; a PR built on a guess is not.

If the work turns out to touch auth/authz, payments, secrets, destructive migrations, or production infra, say so and stop rather than pushing. Those are never merged without a human, so the useful thing is the finding, not the diff.

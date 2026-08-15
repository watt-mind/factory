Implement **one** ticket: $ARGUMENTS. You are already in its worktree, and the ticket is already claimed for you.

The dispatcher (`orchestrator/tick.mjs`) has done the setup: the ticket is `In Progress`, assigned, labelled `ai:in-progress` + `agent:claude-code`, and this worktree was created by the repo's own `worktree-up.sh` with its own branch, ports and database. **Do not create another worktree, do not claim another ticket, and do not work anything except this one.** This is the dispatched path, so it is always exactly one ticket — the protocol's human-requested ticket bundles (`linear.md` §6) never arrive here.

## Do

1. **Read the ticket** and restate your approach as a comment on it.
2. **Implement**, touching only files matching its `Owned Paths`. Work discovered outside that set becomes a new `Triage` issue — never a widening of this one.
3. **Verify** with the ticket's exact `Verification Command`. Never proceed past failing output; never weaken a test to get green.
4. **UX critique** after verification and before opening the PR when this introduces or materially changes a user-completable flow, interaction, state transition, error/recovery path, responsive layout, authentication, payment, onboarding, or destructive action. Spawn `factory-ux-critic`, fix in-scope `FIX-FIRST` findings, maximum 2 rounds, and file the rest to `Triage`. Skip it for isolated styling, copy-only edits, static content, icons/assets, and internal/admin-only surfaces unless the ticket identifies UX risk. State `UX critique: required` or `UX critique: skipped — <reason>` in the PR.

   **The spawn prompt must carry the environment, spelled out** — the subagent does not inherit your working directory, and sibling worktrees for other tickets exist right now:

   - `worktree: <absolute path>` — this worktree's root, written out in full. Never "the current directory".
   - **How to launch and reach the app**: dev server command and **this worktree's** port (not the repo default — `worktree-up.sh` assigned it a non-colliding one), or simulator target / `electronAppPath`, plus `bin/dev-login.sh [role]` where the repo has it.

   A returned `VERDICT: BLOCKED - environment mismatch or unresponsive shell` is a defect in _your_ spawn prompt, not a UX finding: fix the missing or wrong path/launch details and re-spawn once. That re-spawn doesn't count against the 2-round limit — no review happened. If it blocks a second time, record `UX critique: blocked — <what the environment did>` and continue; do not keep re-spawning.

5. **Never `sleep` to wait for CI.** Use `gh pr checks <PR> --watch --fail-fast` — it returns the moment checks settle and exits non-zero on the first failure. Sleep-polling is blocked by the harness, and a blocked tool call **kills the run**: four tickets died exactly this way overnight (`sleep 480`, `sleep 240`, `for i in $(seq 1 40)`), after 55–106 turns and ~$22 of work already done, leaving branches pushed and no PR. The same rule applies to any wait — poll a condition with a real command, never a fixed sleep.
6. **Push and open a PR** against the repo's base branch with `Fixes <ISSUE-ID>` in the body (append `\n\nrun:$FACTORY_RUN_ID` to the body when `$FACTORY_RUN_ID` is set, and omit it in interactive sessions when `$FACTORY_RUN_ID` is unset). Post the mandatory structured **`## Handoff` comment** on the ticket before transitioning state:

   ```
   ## Handoff
   - PR: <url>
   - Verification: `<the ticket's exact command>` — pass, <one-line result summary>
   - UX critique: required — SHIP | required — FIX-FIRST resolved in <n> round(s) | required — NOT-ASSESSED, <what could not be driven> | blocked — <what the environment did> | skipped — <reason>
   - Files: <n> changed, all within Owned Paths   (or: exceptions listed with why)
   - Risks: <what the reviewer should look at first, or "none known">
   ```

   Then move the ticket to `In Review` + `ai:needs-review`, remove `ai:in-progress`. Posting this comment is a mandatory prerequisite before transitioning to `In Review` — the merge stage reviews directly from this comment, so a vague Handoff costs a slower review; a missing one is a protocol violation. For user-facing changes attach before/after screenshots to the ticket — never commit them to the repo. Always report your explicit terminal state (`STATE: PR_OPEN`).

7. **Heartbeat** the ticket at each phase change and at least every 20 minutes, saying what changed. Silence for 45 minutes and the reaper takes the ticket back.

## Don't

**Never merge.** The merge stage reviews and lands PRs; a ticket agent that merges its own work bypasses the review gate entirely.

**Never touch another ticket's worktree.** Other agents are working concurrently in sibling directories with their own databases. Staying inside this one is what makes that safe.

## When it goes wrong

Do not open a PR. Comment the ticket with the specific decision, credential, or missing piece you need — phrased so one reply unblocks it — then move it to `Blocked` + `ai:blocked`, report terminal state `STATE: BLOCKED` (or `STATE: FAILED`), and stop. A blocked ticket with a clear question is a good outcome; a PR built on a guess is not.

If the work turns out to touch auth/authz, payments, secrets, destructive migrations, or production infra, say so and stop rather than pushing. Those are never merged without a human, so the useful thing is the finding, not the diff.

## Capture session friction (interactive runs only)

**Skip when `FACTORY_RUN_ID` is set** — orchestrator runs already write transcripts to `~/.factory/logs/` for `/factory-retro` to measure.

When unset, scan the session for harness friction per `/factory-friction` before finishing. Report friction items filed (IDs) or **none observed** in the handoff comment or final message.

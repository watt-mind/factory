# factory-work

> Dispatch subagents to work agent-ready Linear tickets, land the PRs, report

Work the agent-dispatchable Linear queue for this repository to completion — claimed, implemented, verified, reviewed, and landed — following `$FACTORY_ROOT/docs/protocol.md` (§7 execution, §14 loops).

Interpret $ARGUMENTS as specific issue IDs, a total ticket cap, and/or an in-flight concurrency cap. Defaults: up to 6 tickets, 3 in flight. `no-merge` stops after PRs are opened.

## 1. Build the queue

Resolve the team from this repo (§1 mapping). Query `state:Todo AND label:ai:agent-ready AND assignee:none`, sorted priority asc then createdAt asc (Linear MCP; on failure retry once, then `linear_common` GraphQL). Fetch each candidate's full description and confirm it has all five §5 sections — a ticket missing one goes back to `Triage` with a comment, not into the queue.

Show me the queue (ticket, title, owned paths) before starting, then proceed without waiting for approval.

## 2. Dispatch — rolling, not batched

Keep up to the concurrency cap in flight. **Do not wait for a batch to drain before starting new work**: the moment any ticket finishes (PR opened, blocked, or claim lost), re-read the queue and start the next ticket whose `Owned Paths` don't overlap anything still running. Overlap is checked at each claim against what is actually in flight right now, not against a plan computed at the start.

For each ticket you start:

1. **Claim it yourself first** (main agent, before spawning): set `assignee = self`, state `In Progress`, add `ai:in-progress` + `agent:claude-code`; then **re-read the ticket** — if the assignee isn't us, another agent won the race: skip it and take the next queue item.
2. **Create the worktree using the repo's own script if it has one** (`bin/worktree-up.sh <ISSUE-ID>` in BJ29 and any repo following that pattern) — it assigns non-colliding ports and a per-ticket database that a hand-rolled `git worktree add` does not. Only where no script exists: `git worktree add ~/Develop/.worktrees/<repo>/<ISSUE-ID> -b <type>/<ISSUE-ID>-<slug>`. The repo's `AGENTS.md` overrides this command on anything worktree- or environment-related.
3. Spawn a subagent (general-purpose, run in background). **When the parent run uses Claude, pass `model: opus`** — implementation quality is the product while the orchestration stays on the cheaper session model. **For every other parent harness, omit the model override** so the subagent inherits that harness's configured default. Give it a **self-contained prompt** containing the full ticket (ID, description, all five sections), the worktree path and its ports/database, and these standing orders:
   - Work **only** inside the worktree and only on files matching `Owned Paths`.
   - Heartbeat the Linear ticket at each phase change and at least every 20 minutes, saying what changed since the last one.
   - Verify with the ticket's exact Verification Command; never proceed past a failing verification.
   - Run the UX critique round after verification and before opening the PR when the change introduces or materially changes a user-completable flow, interaction, state transition, error/recovery path, responsive layout, authentication, payment, onboarding, or destructive action. Spawn `factory-ux-critic`, fix in-scope `FIX-FIRST` findings, max 2 rounds, and file follow-ups to `Triage`. Skip it for isolated styling, copy-only edits, static content, icons/assets, and internal/admin-only surfaces unless the ticket identifies UX risk. In every PR, state `UX critique: required` or `UX critique: skipped — <reason>`.
     - **The critic's spawn prompt must state the environment explicitly**: `worktree: <absolute path>` written out in full (a subagent spawned from a worktree does not reliably inherit that worktree's cwd, and the sibling worktrees of concurrently-running tickets are exactly what it resolves to instead), plus how to launch and reach the app — dev server command and **this worktree's** assigned port from step 2, not the repo default, or simulator target / `electronAppPath`, plus `bin/dev-login.sh [role]` where the repo has it.
     - A returned `VERDICT: BLOCKED - environment mismatch or unresponsive shell` means the spawn prompt was wrong, not that the UX is bad: fix the path or launch details and re-spawn once (it doesn't consume a review round — no review happened). Blocked twice: record `UX critique: blocked — <what the environment did>` in the PR and Handoff and move on.
   - On success: push the branch, `gh pr create --title "..." --body "Fixes <ISSUE-ID>"` (append `\n\nrun:$FACTORY_RUN_ID` to the body when `$FACTORY_RUN_ID` is set, and omit it in interactive sessions when `$FACTORY_RUN_ID` is unset), post the mandatory structured **`## Handoff` comment** in the exact format `/factory-ticket` step 6 defines (PR link, verification command + result, UX critique verdict, files vs `Owned Paths`, risks) as a mandatory prerequisite before moving the ticket to `In Review` + `ai:needs-review` (remove `ai:in-progress`), and report terminal state `STATE: PR_OPEN`. For user-facing changes, attach before/after screenshots (reuse the critique round's captures) to the Linear ticket via the attachment upload and add "Screenshots on <ISSUE-ID>" to the PR body — do not commit screenshots into the repo.
   - On failure or blockage: do **not** open a PR; comment the ticket with the specific decision or credential needed, move it to `Blocked` + `ai:blocked`, and report terminal state `STATE: BLOCKED` (or `STATE: FAILED`) back so the orchestrator can notify.
   - The subagent never merges. Discovered out-of-scope work → new `Triage` issue per §8, not scope creep.

## 3. Land the PRs

Merging is the orchestrator's job, not the subagents'. As each PR's CI finishes — don't wait for the whole run to end — apply `/factory-merge` semantics:

- **Review the diff even when CI is green**, per `/factory-merge` step 1 — spawn `factory-merge-reviewer` (one per PR, with ticket, Handoff, `Owned Paths`, `escalate_paths`) so the diff stays out of this session's context, and act on its verdict; review the diff yourself only where subagents are unavailable. Green CI is never the bar.
- Then classify **MERGE / FIX / ESCALATE** exactly as `/factory-merge` step 2 defines. On `develop` in an `hdkiller`/`watt-mind` repo this is standing authorization from `~/.claude/CLAUDE.md` — merge without asking. Targeting `master`/`main`, or a repo we don't own: stop at review and hand it to me.
- **FIX**: fix findings/CI/conflicts in the branch, re-verify, re-review your own fix diff, max 2 rounds, then escalate rather than looping.
- **ESCALATE** (auth/authz, payments, secrets, destructive migrations, prod infra, `CLNT` security behavior): never merge, report with findings, add `ai:escalated` to the ticket, and notify me (`factory notify`, per the floor's Stop-and-ask section).
- **Merge one PR at a time.** After each: confirm base CI _and_ the post-deploy smoke check are green, move the ticket to `Done`, delete the remote branch, and remove the worktree (`bin/worktree-down.sh <ISSUE-ID>` where the repo has it). If base CI or smoke goes red, stop merging entirely, notify me, and fix or revert before anything else lands.

## 4. Keep going

When the in-flight count drops below the cap and the queue still has agent-ready tickets within the ticket cap, keep claiming — don't stop to ask whether to continue. Stop when the queue is empty, the cap is reached, or the circuit breaker trips: **two consecutive tickets failing for environment or build reasons** (not ticket-specific ones) stops dispatch immediately, with a report. When the failure surfaced as a red CI run and the cause isn't obvious, spawn `factory-ci-doctor` to make that call — its `ENV` verdict is what counts toward the breaker, its `TICKET` verdict does not — a broken worktree template will otherwise convert the whole queue into `Blocked` in minutes.

## 5. Notify and report

Notify me during the run only for exceptions (§14): a ticket blocked, a PR escalated, base CI or smoke red, the circuit breaker tripping. Not for routine claims, PRs, or clean merges.

Final report: per ticket — merged / PR open / escalated / blocked / skipped, with links; what was filed to `Triage`; and anything waiting on a decision from me, with enough context to answer from the report alone. Post a project update (§10) if the run closed a meaningful batch or hit a blocker.

## 6. Capture session friction (interactive runs only)

**Skip when `FACTORY_RUN_ID` is set** — orchestrator runs already write transcripts to `~/.factory/logs/` for `/factory-retro` to measure.

When unset (this command ran directly in Claude, Codex, Pi, or Cursor), scan the session for harness friction using the bar in `docs/friction-log.md` and file findings per `/factory-friction`. Include in the final report: friction items filed (IDs) or **none observed**.

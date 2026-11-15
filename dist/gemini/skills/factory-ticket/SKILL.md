---
name: factory-ticket
description: "Implement exactly one already-claimed Linear ticket in the current worktree. Invoke only when the user explicitly asks to run /factory-ticket or the factory-ticket workflow."
---

# factory-ticket

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Implement **one** ticket: $ARGUMENTS. You are already in its worktree, and the ticket is already claimed for you.

The dispatcher (`orchestrator/tick.mjs`) has done the setup: the ticket is `In Progress`, assigned, labelled `ai:in-progress` + `agent:claude-code`, and this worktree was created by the repo's own `worktree-up.sh` with its own branch, ports and database. **Do not create another worktree, do not claim another ticket, and do not work anything except this one.** This is the dispatched path, so it is always exactly one ticket — the protocol's human-requested ticket bundles (`docs/protocol.md` §6) never arrive here.

## Do

1. **Read the ticket** and restate your approach (plus boundary types or state invariants on `tier:strong` or cross-module work) as a comment on it. Assume the operator is AFK — never pause for confirmation; resolve open implementation details (module structure, naming, internal data/error shape, edge-case defaults consistent with acceptance criteria) from `origin/<base>` conventions, sibling modules, tests, git history, and `docs/product-decisions.md`, stating any non-obvious reversible assumption in your approach comment.
2. **Implement**, touching only files matching its `Owned Paths`. Work discovered outside that set becomes a new `Triage` issue — never a widening of this one.
   - **Fix root causes, not symptoms:** Before editing, trace why the defect or invalid state enters the system. When the ticket's `Verification Command` runs a fast local check for a bug, run or add the regression test _before_ the fix and observe it fail for the expected reason. A guard is a fix only when the state it handles is legitimate domain state — never paper over ordering, lifecycle, or state bugs with `setTimeout` / `requestAnimationFrame` delays, blind retries, clamped values, or catch-and-swallow blocks.
   - **Do not copy adjacent weeds:** If nearby code uses a deprecated helper, `any`, or an ad-hoc workaround, follow `AGENTS.md` and clean module boundaries rather than replicating local tech debt, while still matching the repo's established architecture and naming conventions.
   - **No silent suppressions or workaround-alibi comments:** Do not add `eslint-disable`, `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, `as any` / `as unknown as` type escapes, or multi-line comments excusing why a quick patch was used instead of fixing the root cause. **Boundary escape valve:** when a third-party type definition, generated file, or documented platform/runtime quirk genuinely leaves no clean in-scope alternative, an escape hatch is allowed _only_ if narrowed to the single line or expression and paired with a concrete citation (upstream bug/spec URL, external `file:line`, or a newly filed `Triage` issue ID) — never as a convenience shortcut.
   - **Explore 2–3 options on net-new UI or layout redesigns (`principle-exhaust-the-design-space`):** On net-new UI surfaces, material layout/flow redesigns, or explicit exploration requests (never routine bugfixes), articulate 2–3 distinct layout/interaction directions inside `Owned Paths`, prototype/render boundedly if helpful (`$TMPDIR/<ISSUE-ID>-*.patch`, never `git stash`), autonomously select and commit only the winner without stalling on an AFK operator, and record the explored options + winner rationale in your ticket comment and `## Handoff` (`Risks`).
   - **Render, visually self-polish (≥1 pass), and retain screenshots on any UI-affecting change (`principle-experience-first`):** Even when Step 4's multi-journey `factory-ux-critic` is skipped (isolated styling, copy-in-layout, admin views), render the live UI, capture a bounded screenshot (not just accessibility snapshots; never `Read` the image back), critique hierarchy, spacing rhythm, alignment, contrast, truncation, and states coldly, and iterate **at least once** to polish rough first-draft UI before Step 3. Retain 1–4 final post-polish screenshots outside the repo (`≤ 1 MB` each) for Step 6 / interactive output.
   - **Cold self-diff check before verification:** Read `git diff` against `origin/<base>` cold before running Step 3. Confirm every touched file matches `Owned Paths`, every new test would fail without your behavioral fix (not mock-tautological), and every added comment, timer, or suppression satisfies the rules above.
3. **Verify** on the final tree with the ticket's exact `Verification Command` (plus targeted test files only — never `bun test` or a full unit/E2E suite that CI already covers, as concurrent dispatched worktrees make full suites a load-induced flake source) and the repo's fast pre-push static gates (configured `verify` command, or fast lint/format/typecheck on touched scope when `verify` is unset) so trivial static failures never burn a CI cycle. Never proceed past failing output; never weaken a test to get green. Never background, Monitor-wait, or `sleep`-wait a ticket's own verify step — but that is not a license to trust a framing exit code: for a verify command expected to exceed ~10 minutes, use the floor's status-file idiom (`shared/floor.md` §Waiting — command writes its own exit code to a status file with output to a log file, then poll for the status file with repeated short calls), because the Bash tool auto-backgrounds any foreground command that outlives its timeout and the framing exit code is not the command's.
4. **UX critique** after verification and before opening the PR when this introduces or materially changes a user-completable flow, interaction, state transition, error/recovery path, responsive layout, authentication, payment, onboarding, or destructive action. Spawn `factory-ux-critic`, fix in-scope `FIX-FIRST` findings, maximum 2 rounds, and file the rest to `Triage`. Skip it for isolated styling, copy-only edits, static content, icons/assets, and internal/admin-only surfaces unless the ticket identifies UX risk — skipping `factory-ux-critic` never skips Step 2's own rendered visual self-polish pass and screenshot capture when UI rendering is affected. State `UX critique: required` or `UX critique: skipped — <reason>` in the PR.

   **The spawn prompt must carry the environment, spelled out** — the subagent does not inherit your working directory, and sibling worktrees for other tickets exist right now:

   - `worktree: <absolute path>` — this worktree's root, written out in full. Never "the current directory".
   - **How to launch and reach the app**: dev server command and **this worktree's** port (not the repo default — `worktree-up.sh` assigned it a non-colliding one), or simulator target / `electronAppPath`, plus `bin/dev-login.sh [role]` where the repo has it.
   - `artifactDir: <absolute path>` — a pre-created, writable directory outside the worktree (for example `ux-screenshots/` in this run's Factory workspace, or a session scratch directory interactively) where `factory-ux-critic` saves bounded `.png` captures.

   A returned `VERDICT: BLOCKED - environment mismatch or unresponsive shell` is a defect in _your_ spawn prompt, not a UX finding: fix the missing or wrong path/launch details and re-spawn once. That re-spawn doesn't count against the 2-round limit — no review happened. If it blocks a second time, record `UX critique: blocked — <what the environment did>` and continue; do not keep re-spawning.

5. **Never `sleep` to wait for CI.** For the pushed head SHA, select only the CI workflow with `gh run list --workflow ci.yml --commit <sha> --json databaseId --limit 1`, then wait with `gh run watch <run-id> --exit-status --interval 60`. The run can lag the push, so retry the workflow-selected lookup for up to about two minutes when it is empty; do not substitute another workflow's run. Before a merge, use `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` to assert every check run completed green. Sleep-polling is blocked by the harness, and a blocked tool call **kills the run**. The same rule applies to any wait — poll a condition with a real command, never a fixed sleep.
6. **Push and open a PR** against the configured `base` for this repo in `config/repos.yaml`, never GitHub's default branch: `gh pr create --base <configured-base> --title "..." --body "Fixes <ISSUE-ID>"`. Read the opened PR's `baseRefName` back and stop if it differs from the configured base. When `$FACTORY_RUN_ID` is set, append the concrete trailer with `printf 'run:%s\n' "$FACTORY_RUN_ID"`; never paste a literal variable reference. Omit it in interactive sessions when `$FACTORY_RUN_ID` is unset. Post the mandatory structured **`## Handoff` comment** on the ticket before transitioning state:

   ```
   ## Handoff
   - PR: <url>
   - Verification: `<the ticket's exact command>` — pass, <one-line result summary>
   - UX critique: required — SHIP | required — FIX-FIRST resolved in <n> round(s) | required — NOT-ASSESSED, <what could not be driven> | blocked — <what the environment did> | skipped — <reason>
   - Files: <n> changed, all within Owned Paths   (or: exceptions listed with why)
   - Risks: <what the reviewer should look at first, including any reversible engineering assumptions made without blocking, or "none known">
   ```

   Then move the ticket to `In Review` + `ai:needs-review`, remove `ai:in-progress`. Posting this comment is a mandatory prerequisite before transitioning to `In Review` — the merge stage reviews directly from this comment, so a vague Handoff costs a slower review; a missing one is a protocol violation. Any UI-affecting handoff must deliver reviewable visual evidence (or state a concrete, justified exception — a workspace path, bare hash, or claim that a screenshot was taken is not reviewable; prefer bounded mobile or element-scoped captures, do not `Read` captures back, and never commit screenshots to the repo):
   - **Dispatched runs (`$FACTORY_RUN_ID` set):** Retain 1–4 post-polish PNGs (`≤ 1 MB` each) in `ux-screenshots/` alongside the worktree, declare each in `result.json` as `{"kind":"ux-screenshot","path":"ux-screenshots/<filename>.png"}`, compute its SHA-256, and when `$FACTORY_WEB_URL` is set add a `## UX screenshots` section to the PR body/comment with plain-text `$FACTORY_WEB_URL/api/artifacts/<sha256>` links and captions (never `![…]()` embeds; when `$FACTORY_WEB_URL` is unset, state that concrete artifact-transport exception in the PR or Handoff), then label the PR `has-screenshots` and `type:ui-ux` (creating `has-screenshots` or logging a fallback if missing).
   - **Interactive sessions (`$FACTORY_RUN_ID` unset):** Save 1–3 post-polish screenshots (`≤ 1 MB` each) to the session artifact/scratch directory outside the repo and embed or link them in your response or walkthrough artifact by default, plus attach/link a reviewable screenshot (or state the transport exception) on the PR/Handoff.

   Always report your explicit terminal state (`STATE: PR_OPEN`).

7. **Heartbeat** the ticket at each phase change and at least every 20 minutes, saying what changed. Silence for 45 minutes and the reaper takes the ticket back.

## Don't

**Never merge.** The merge stage reviews and lands PRs; a ticket agent that merges its own work bypasses the review gate entirely.

**Never touch another ticket's worktree.** Other agents are working concurrently in sibling directories with their own databases. Staying inside this one is what makes that safe.

## Security-sensitive work (`Never auto-merge`)

If the diff changes security-relevant behavior in auth/authz, payments, credential or secret handling, destructive migrations, production infra, `CLNT` security behavior, or paths matching `escalate_paths` in `config/repos.yaml`, implement and verify the in-scope change and open a PR for human review. Apply `ai:escalated` on the ticket and `escalated` on the GitHub PR (`gh pr edit <PR> --add-label escalated`, creating the label if missing), document the security-relevant behavior and risks in the PR and `## Handoff`, and notify with `factory notify "ESCALATED <TICKET/PR>: <one answerable sentence>"` (unless spawned inside `/factory-work`, which notifies centrally). Never merge it automatically, and escalate ambiguous cases too. Missing product intent or missing credentials still follow `STATE: BLOCKED` below; never expose secrets in the diff or review artifacts.

## When it goes wrong

Do not open a PR when blocked or failing. Distinguish genuine human blockers from execution failures — the operator is AFK by default:

- **Genuine human blocker (`STATE: BLOCKED`):** Strictly for unrecorded user-visible product-intent forks (after checking `docs/product-decisions.md`, `docs/`, and the tracker project overview), missing credentials or external access, or inseparable edits outside `Owned Paths`. Comment the ticket with the specific question or missing piece — phrased so one reply unblocks it — move it to `Blocked` + `ai:blocked` (removing `ai:in-progress`), run `factory notify "BLOCKED <ISSUE-ID>: <one answerable sentence>"` (unless spawned inside `/factory-work`, which notifies centrally), report terminal state `STATE: BLOCKED`, and stop. A blocked ticket with one clear question is a good outcome; a PR built on a product guess is not.
- **Implementation or verification failure with no human question (`STATE: FAILED`):** When verification stays red, the environment is broken, or you cannot converge cleanly within scope without needing a human decision, unclaim the ticket back to `Todo` (`factory ticket unclaim <ISSUE-ID>`) with a concise diagnostic comment naming what failed, report terminal state `STATE: FAILED`, and stop. Never park an execution failure in `Blocked` + `ai:blocked`.

## Capture session friction (interactive runs only)

**Skip when `FACTORY_RUN_ID` is set** — orchestrator runs already write transcripts to `~/.factory/logs/` for `/factory-retro` to measure.

When unset, scan the session for harness friction per `/factory-friction` before finishing. Report friction items filed (IDs) or **none observed** in the handoff comment or final message.

---
name: factory-work
description: "Dispatch subagents to work agent-ready Linear tickets, land the PRs, report. Invoke only when the user explicitly asks to run /factory-work or the factory-work workflow."
---

# factory-work

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Work the agent-dispatchable Linear queue for this repository to completion — claimed, implemented, verified, reviewed, and landed — following `$FACTORY_ROOT/docs/protocol.md` (§7 execution, §14 loops).

Interpret $ARGUMENTS as specific issue IDs, a total ticket cap, and/or an in-flight concurrency cap. Defaults: up to 6 tickets, 3 in flight. `no-merge` stops after PRs are opened.

## 1. Check capacity and build the queue

Run `bun orchestrator/pulse.mjs` (or `factory pulse`) before building or widening dispatch. Read `CAPACITY & FLOW` (`runnerCap`, `activeRuns`, `queuedRuns`, `openReadyPrs`, `mergedLastHour`, `verdict`):

- `DRAIN_MERGES_FIRST`: stop dispatching new work and run `/factory-merge` first to drain open ready PRs.
- `HOLD_OR_BUNDLE`: do not widen single-PR concurrency while CI runners are saturated or queued (`queuedRuns > 0` or `activeRuns >= runnerCap`); hold current slots or coalesce cohesive tickets into bundles.
- `WIDEN`: runner headroom and low open-PR backlog support widening up to target slots.

Never widen based on backlog depth alone; widen only on observed `mergedLastHour` flow and runner headroom.

Resolve the repo/team from this checkout (§1 mapping). Query the ready queue via `factory ticket queue` (`state:Todo`, `ai:agent-ready`, unassigned, sorted priority asc then createdAt asc; use `factory ticket get <ID>` to read each candidate's full description, falling back to `factory ticket raw` only where documented in the floor). Confirm every candidate has all five §5 sections — a ticket missing one goes back to `Triage` with a comment, not into the queue.

Log the queue (ticket, title, owned paths) and start immediately without waiting for approval — assume the operator is AFK.

## 2. Dispatch — rolling, bundle-aware, non-blocking

Keep the main session unblocked as coordinator for steering, cross-slice seams, and queue decisions while subagents execute isolated ticket or bundle tracks. Keep up to the concurrency cap in flight. **The in-flight concurrency cap counts bundles (worktree/PR slots), NOT raw ticket count.**

**Bundling as a first-class dispatch decision:** When CI or review capacity is the binding constraint (such as `HOLD_OR_BUNDLE` or growing `openReadyPrs`), form cohesive bundles of 3–6 related low-risk tickets with disjoint `Owned Paths`. A bundle occupies one `worktree-up.sh <LEAD-ISSUE-ID>` worktree, one branch named after the lead ticket, one commit per ticket, and one `Fixes <ISSUE-ID>` line per ticket in the PR body. Claim and heartbeat _every_ ticket in the bundle; if one ticket balloons or blocks, unassign it back to `Todo` and ship the rest.

**Do not wait for a batch to drain before starting new work**: the moment any slot finishes (PR opened, blocked, or claim lost), re-check `bun orchestrator/pulse.mjs` (`CAPACITY & FLOW`) and the queue, then start the next ticket or bundle whose `Owned Paths` do not overlap anything still running. Overlap is checked at each claim against what is actually in flight right now, not against a plan computed at the start.

For each ticket or bundle you start:

1. **Claim it yourself first** (main agent, before spawning): set `assignee = self`, state `In Progress`, add `ai:in-progress` + `agent:claude-code`; then **re-read the ticket** — if the assignee isn't us, another agent won the race: skip it and take the next queue item. For a bundle, claim every ticket in the bundle before spawning.
2. **Create the worktree using the repo's own script if it has one** (`bin/worktree-up.sh <ISSUE-ID>` in BJ29 and any repo following that pattern, using the lead ticket ID for a bundle) — it assigns non-colliding ports and a per-ticket database that a hand-rolled `git worktree add` does not. Only where no script exists: `git worktree add ~/Develop/.worktrees/<repo>/<ISSUE-ID> -b <type>/<ISSUE-ID>-<slug>`. The repo's `AGENTS.md` overrides this command on anything worktree- or environment-related.
3. Spawn a subagent (general-purpose, run in background) using the **Difficulty tier × harness routing** table below (keyed by the ticket's `tier:*` label, or the highest tier in a bundle).

   | Difficulty / Role | Claude Code                                 | Codex / Cursor                  | Pi                              |
   | :---------------- | :------------------------------------------ | :------------------------------ | :------------------------------ |
   | `tier:light`      | `haiku` / `sonnet`                          | fast (`sol` / fast)             | `muse-spark`                    |
   | `tier:standard`   | `sonnet` (or `opus` for multi-module seams) | `sol` / `wonder`                | `muse` / `wonder`               |
   | `tier:strong`     | `opus`                                      | `sol` / `opus`-class            | `wonder` / `opus`-class         |
   | `reviewer`        | separate `opus` (`factory-merge-reviewer`)  | separate `wonder` / cross-model | separate `wonder` / cross-model |

   **Fallback chain:** Fall back to the harness default (`inherit`) when a tier model is unavailable or quota-limited.
   **Hard invariant (`reviewer != implementer`):** Review and critique must run in a separate agent conversation (and a separate model or harness family where available). Self-approval is forbidden.

   Give the implementer subagent a **self-contained prompt** containing the full ticket (or bundle tickets: IDs, descriptions, all five sections), the worktree path and its ports/database, and these standing orders:
   - Work **only** inside the worktree and only on files matching `Owned Paths`. Assume the operator is AFK — resolve open implementation details (module structure, naming, internal data/error shape, edge-case defaults consistent with acceptance criteria) from `origin/<base>` conventions, sibling modules, tests, git history, and `docs/product-decisions.md` without pausing, and record any non-obvious reversible engineering assumptions in `## Handoff` (`Risks`).
   - Follow `/factory-ticket` Step 2 discipline: fix root causes (no timer/retry/catch-and-swallow symptom patches), do not copy adjacent tech debt, add no unnarrowed lint/type suppressions or workaround-alibi comments (single-line boundary exceptions require a concrete upstream or `Triage` citation), explore 2–3 distinct options inside `Owned Paths` on net-new UI surfaces, material layout/flow redesigns, or explicit exploration requests (`principle-exhaust-the-design-space` — never routine bugfixes; prototype with `$TMPDIR/<ISSUE-ID>-*.patch`, never `git stash`, autonomously commit only the winner, and record explored options + winner rationale in the ticket comment and `## Handoff` `Risks`), visually render and run ≥1 cold self-polish pass on any UI-affecting change (`principle-experience-first` — retaining 1–4 post-polish PNGs `≤ 1 MB` in `ux-screenshots/` outside the worktree even when Step 4's `factory-ux-critic` is skipped on isolated styling, copy-in-layout, or admin UI, without `Read`ing captures back), and cold-read `git diff` before verification.
   - Heartbeat the Linear ticket at each phase change and at least every 20 minutes, saying what changed since the last one.
   - Verify with the ticket's exact `Verification Command` (plus targeted test files only — never `bun test`, full unit/E2E suites, or project-wide coverage thresholds covered by CI unless cross-cutting blast radius demands it) and the repo's fast pre-push static gates (configured `verify` command, or fast lint/format/typecheck on touched scope when `verify` is unset) so trivial static failures never burn a CI cycle; attribute deferred full-suite checks to CI under `Risks` in `## Handoff`, and never proceed past a failing verification or weaken a test.
   - Run the UX critique round after verification and before opening the PR when the change introduces or materially changes a user-completable flow, interaction, state transition, error/recovery path, responsive layout, authentication, payment, onboarding, or destructive action. Spawn `factory-ux-critic`, fix in-scope `FIX-FIRST` findings, max 2 rounds, and file follow-ups to `Triage`. Skip it for isolated styling, copy-only edits, static content, icons/assets, and internal/admin-only surfaces unless the ticket identifies UX risk — skipping `factory-ux-critic` never skips Step 2's rendered visual self-polish pass and `ux-screenshots/` capture when UI rendering is affected. In every PR, state `UX critique: required` or `UX critique: skipped — <reason>`.
     - **The critic's spawn prompt must state the environment explicitly**: `worktree: <absolute path>` written out in full (a subagent spawned from a worktree does not reliably inherit that worktree's cwd, and the sibling worktrees of concurrently-running tickets are exactly what it resolves to instead), plus how to launch and reach the app — dev server command and **this worktree's** assigned port from step 2, not the repo default, or simulator target / `electronAppPath`, plus `bin/dev-login.sh [role]` where the repo has it.
     - Before Step 2 visual self-polish or spawning a required critic, create an `ux-screenshots/` directory in **this run's Factory workspace**, alongside (not inside) the `repo` worktree, and pass its absolute path as `artifactDir: <absolute path>` when spawning `factory-ux-critic`. The critic is read-only on the repo. Retain 1–4 final post-polish / critic-reported screenshots (`≤ 1 MB` each); copy a backend-temporary capture into that directory when necessary. Never commit these images or attach them to Linear.
     - A returned `VERDICT: BLOCKED - environment mismatch or unresponsive shell` means the spawn prompt was wrong, not that the UX is bad: fix the path or launch details and re-spawn once (it doesn't consume a review round — no review happened). Blocked twice: record `UX critique: blocked — <what the environment did>` in the PR and Handoff and move on.
   - On success: push the branch, `gh pr create --base <configured-base> --title "..." --body "Fixes <ISSUE-ID>"` (one `Fixes <ISSUE-ID>` line per ticket in a bundle), resolving `base` from `config/repos.yaml`. Read the opened PR's `baseRefName` back and stop if it differs from the configured base; when `$FACTORY_RUN_ID` is set, append the concrete trailer with `printf 'run:%s\n' "$FACTORY_RUN_ID"` rather than pasting a literal variable reference (omit it in interactive sessions when unset). If the diff changes security-relevant behavior (`Never auto-merge` or `escalate_paths`), still open the verified PR for human review, apply `ai:escalated` on the ticket and `escalated` on the PR, and document the security risks in the PR and Handoff so Step 3 classifies it `ESCALATE` without auto-merging. Post the mandatory structured **`## Handoff` comment** in the exact format `/factory-ticket` step 6 defines (PR link, verification command + result, UX critique verdict, files vs `Owned Paths`, risks) as a mandatory prerequisite before moving the ticket to `In Review` + `ai:needs-review` (remove `ai:in-progress`), and report terminal state `STATE: PR_OPEN`.
     - Any UI-affecting handoff (including isolated styling, copy-in-layout, or admin UI where `factory-ux-critic` was skipped) requires one representative, reviewable screenshot artifact or a concrete, justified exception in the PR or Handoff. Retain **1–4** post-polish / critic screenshots, each **≤ 1 MB** (drop or re-capture element-scoped if larger); prefer mobile-viewport or element-scoped captures that prove the polished state, and do not re-read redundant images. Declare each retained workspace-relative file in the dispatch `result.json` as `{"kind":"ux-screenshot","path":"ux-screenshots/<filename>.png"}`. The `ux-screenshot` artifact kind marks a PNG capture from visual self-polish or the UX critique round: Factory hashes and publishes it through the control API's `GET /artifacts/<sha256>` endpoint (immutable, content-addressed, operator-reachable only). Compute each file's SHA-256 before writing the PR evidence.
     - **When `$FACTORY_WEB_URL` is set**, add a bounded `## UX screenshots` section to the PR body (or a comment with that heading). The artifact URL `$FACTORY_WEB_URL/api/artifacts/<sha256>` binds loopback/tailnet with no auth, so GitHub cannot render it: **never embed `![…]()` images**. List one plain-text link per retained screenshot with its sha256 and a one-line caption, for example `- [01-upload-list-mobile.png]($FACTORY_WEB_URL/api/artifacts/<sha256>) — sha256 `<sha256>` — mobile upload list after fix`, followed by the critic verdict. Do not use `file://`, a temporary browser path, a repository URL, or an unverified guessed hash. When `$FACTORY_WEB_URL` is unset, state that concrete artifact-transport exception in the PR or Handoff; the retained files and bare hashes alone are not reviewable evidence. Embedding real images is deferred until a GitHub-reachable transport exists.
     - When at least one screenshot was retained, label the PR: `gh pr edit <PR> --add-label has-screenshots --add-label type:ui-ux`. `type:ui-ux` is provisioned by `factory init --control-plane github`; `has-screenshots` may be missing — if the add fails, create it (`gh label create has-screenshots --color 1d76db --description "This pull request has UX-review screenshot evidence"`) and retry once, or fall back to `type:ui-ux` alone. Never fail the PR flow on a label error; log it in the Handoff. Apply neither label when no screenshot was captured.
   - On failure or blockage: do **not** open a PR. Distinguish genuine human blockers from execution failures: for a genuine human blocker (unrecorded user-visible product-intent fork, missing credentials/access, or inseparable edits outside `Owned Paths`), comment the ticket with one answerable question, move it to `Blocked` + `ai:blocked` (remove `ai:in-progress`), and report `STATE: BLOCKED` so the orchestrator can notify; for an implementation or verification failure that needs no human decision, unclaim the ticket back to `Todo` (`factory ticket unclaim <ISSUE-ID>`) with a concise diagnostic comment and report `STATE: FAILED` (never mark it `Blocked` + `ai:blocked`).
   - The subagent never merges. Discovered out-of-scope work → new `Triage` issue per §8, not scope creep.

## 3. Land the PRs

Merging is the orchestrator's job, not the implementer subagent's. As each PR's CI finishes — do not wait for the whole run to end — delegate classification, batching, gating, `Done` verification, and teardown to `/factory-merge` (`shared/commands/factory-merge.md`) as the single source of truth:

- **Independent review (`reviewer != implementer`):** Spawn `factory-merge-reviewer` (one per PR, in a separate conversation with the ticket including `tier:*` labels, Handoff, `Owned Paths`, and `escalate_paths`) per `/factory-merge` step 1 so the diff stays out of the coordinator's context; review the diff yourself only where subagents are unavailable. Green CI alone is never the bar.
- **Classify and route per `/factory-merge` step 2–3:** Merge `MERGE` candidates, fix mechanical `FIX` issues (max 2 rounds before escalating and continuing), and escalate `ESCALATE` PRs (`ai:escalated` + `escalated` + `factory notify "ESCALATED PR#<n> (<TICKET>): <one sentence>"`), leaving escalated PRs open while continuing to remaining non-overlapping PRs.
- **Land via `/factory-merge` step 4:** Batch pairwise-disjoint PRs (`<= 8`), run one base-CI and smoke/deploy validation after the batch, enforce `factory escalate` + `escalated` label + REST check-run gates before `gh pr merge`, perform write-read-verify `Done` (`gh pr view` `mergeCommit` SHA read-back + `factory ticket state <ISSUE-ID> Done --pr <PR> --merge-sha "$merge_sha"`), and tear down worktrees/branches under WM-17 / WM-51 `factory branch-guard` rules. On red base CI or smoke, stop merging further batches immediately, notify (`CI RED` or `SMOKE RED`), and revert or fix forward before landing anything else.

## 4. Keep going

When the in-flight slot count drops below the cap and the queue still has agent-ready tickets within the ticket cap, re-check `bun orchestrator/pulse.mjs` (`CAPACITY & FLOW`) so the widening brake holds, then keep claiming — don't stop to ask whether to continue. Stop when the queue is empty, the cap is reached, or the circuit breaker trips: **two consecutive tickets failing for environment or build reasons** (not ticket-specific ones) stops dispatch immediately, with a report. When the failure surfaced as a red CI run and the cause isn't obvious, spawn `factory-ci-doctor` to make that call — its `ENV` verdict is what counts toward the breaker, its `TICKET` verdict does not — a broken worktree template will otherwise convert the whole queue into `Blocked` in minutes.

## Standing loop prompt shape

When structuring an autonomous `/factory-work` loop prompt, keep all four named parts explicit:

1. **Claim next:** Filter eligibility (`Todo` + `ai:agent-ready` + unassigned), pull via `factory ticket queue`, claim via `factory ticket claim <ISSUE-ID>`, and enforce the real-assignee read-back check (skip on race loss).
2. **Gate list:** Enforce every cycle: `Owned Paths` isolation, `reviewer != implementer`, `escalate` + REST check-run merge gate, `--pr` / `--merge-sha` `Done` verification, and `branch-guard` before branch deletion.
3. **Transition table:**

   | Event       | Required action                                                                                                                                                        |
   | :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `claimed`   | `factory ticket claim <ISSUE-ID>` + verify assignee == self                                                                                                            |
   | `PR opened` | Post `## Handoff`, then `factory ticket state <ISSUE-ID> "In Review" --add ai:needs-review --remove ai:in-progress`                                                    |
   | `merged`    | `gh pr view <PR> --json state,mergeCommit` (`state === "MERGED"`, capture `merge_sha`), then `factory ticket state <ISSUE-ID> Done --pr <PR> --merge-sha "$merge_sha"` |
   | `blocked`   | `factory ticket state <ISSUE-ID> Blocked --add ai:blocked --remove ai:in-progress` + `factory notify "BLOCKED <ISSUE-ID>: <question>"`                                 |

4. **Feasibility valve:** Surface the binding constraint (`runnerCap`, `openReadyPrs`, disk, or quota) immediately in the loop status/report instead of silently shrinking lane concurrency below target.

## 5. Notify and report

Notify me during the run only for exceptions (§14): a ticket blocked, a PR escalated, base CI or smoke red, the circuit breaker tripping. Not for routine claims, PRs, or clean merges.

Final report: per ticket — merged / PR open / escalated / blocked / skipped, with links; what was filed to `Triage`; and anything waiting on a decision from me, with enough context to answer from the report alone. Post a project update (§10) if the run closed a meaningful batch or hit a blocker.

## 6. Capture session friction (interactive runs only)

**Skip when `FACTORY_RUN_ID` is set** — orchestrator runs already write transcripts to `~/.factory/logs/` for `/factory-retro` to measure.

When unset (this command ran directly in Claude, Codex, Pi, or Cursor), scan the session for harness friction using the bar in `docs/friction-log.md` and file findings per `/factory-friction`. Include in the final report: friction items filed (IDs) or **none observed**.

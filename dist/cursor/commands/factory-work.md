Work the agent-dispatchable Linear queue for this repository to completion — claimed, implemented, verified, reviewed, and landed — following `$FACTORY_ROOT/docs/protocol.md` (§7 execution, §14 loops).

Interpret $ARGUMENTS as specific issue IDs, a total ticket cap, and/or an in-flight concurrency cap. Defaults: up to 6 tickets, 3 in flight. `no-merge` stops after PRs are opened.

## 1. Check capacity and build the queue

Run `bun orchestrator/pulse.mjs` (or `factory pulse`) before building or widening dispatch. Read `CAPACITY & FLOW` (`runnerCap`, `activeRuns`, `queuedRuns`, `openReadyPrs`, `openMergeablePrs`, `openEscalatedPrs`, `diskFreeGb`, `worktreeCount`, `mergedLastHour`, `verdict`):

- `DRAIN_MERGES_FIRST`: stop dispatching new work and run `/factory-merge` first to drain open mergeable PRs (held `escalated` PRs do not trigger this).
- `DRAIN_OR_CLEANUP`: when `diskFreeGb < 5`, prune merged/stale worktrees (`bin/worktree-down.sh` / `git worktree prune`) before creating new worktrees.
- `HOLD_OR_BUNDLE`: do not widen single-PR concurrency while CI runners are saturated or queued (`queuedRuns > 0` or `activeRuns >= runnerCap`); **keep target implementation lanes full** (for example, 10 implementation lanes — counted separately from reviewer, merge, and triage/spec subagents which run on top) by coalescing work into 3–6 ticket bundles or staging local branches for bulk merge rather than shrinking active implementation lanes. Only `Owned Paths` overlap, disk/port/DB exhaustion, or tracker quota may reduce implementation concurrency (and must be surfaced via the Feasibility valve).
- `WIDEN`: runner headroom and low open-PR backlog support widening up to target slots.

Never widen based on backlog depth alone; widen only on observed `mergedLastHour` flow and runner headroom.

Resolve the repo/team from this checkout (§1 mapping). Query the ready queue via `factory ticket queue` (`state:Todo`, `ai:agent-ready`, unassigned, sorted priority asc then createdAt asc; use `factory ticket get <ID>` to read each candidate's full description, falling back to `factory ticket raw` only where documented in the floor). Confirm every candidate has all five §5 sections — a ticket missing one goes back to `Triage` with a comment, not into the queue.

**Triage feeder:** When `readyQueue < 2 * concurrencyCap` and `Triage` is non-empty, fan out parallel read-only spec-validation subagents (`10–15` `Triage` issues per batch) to populate `ticket-spec` sections and keep the ready queue fed.

Log the queue (ticket, title, owned paths) and start immediately without waiting for approval — assume the operator is AFK.

## 2. Dispatch — rolling, bundle-aware, non-blocking

Keep the main session unblocked as coordinator (`<30s` turns) for steering, cross-slice seams, and queue decisions while subagents execute isolated ticket or bundle tracks. **Zero local work on root:** when managing `>= 3` parallel async lanes, the coordinator session **never** edits repo files, checks out PR branches, or runs test/typecheck/build suites on the root checkout — delegate all implementation, `MERGE-FIX` rounds, and verifications to isolated worktree subagents. Keep up to the concurrency cap in flight (counted separately from reviewer, merge, and triage/spec subagents). **The in-flight concurrency cap counts bundles (worktree/PR slots), NOT raw ticket count.**

**Bundling as a first-class dispatch decision:** When CI or review capacity is the binding constraint (such as `HOLD_OR_BUNDLE` or growing `openReadyPrs`), form cohesive bundles of 3–6 related low-risk tickets with disjoint `Owned Paths`. A bundle occupies one `worktree-up.sh <LEAD-ISSUE-ID>` worktree, one branch named after the lead ticket, one commit per ticket, and one `Fixes <ISSUE-ID>` line per ticket in the PR body. Claim and heartbeat _every_ ticket in the bundle; if one ticket balloons or blocks, unassign it back to `Todo` and ship the rest.

**Do not wait for a batch to drain before starting new work**: the moment any slot finishes (PR opened, blocked, or claim lost), re-check `bun orchestrator/pulse.mjs` (`CAPACITY & FLOW`) and the queue, then start the next ticket or bundle whose `Owned Paths` do not overlap anything still running. Overlap is checked at each claim against what is actually in flight right now, not against a plan computed at the start.

For each ticket or bundle you start:

1. **Claim it yourself first** (main agent, before spawning): set `assignee = self`, state `In Progress`, add `ai:in-progress` + the active harness's `agent:*` label (or let `factory ticket claim`'s harness detection set it — never hardcode `agent:claude-code`); then **re-read the ticket** — if the assignee isn't us, another agent won the race: skip it and take the next queue item. For a bundle, claim every ticket in the bundle before spawning.
2. **Create the worktree using the repo's own script if it has one** (`bin/worktree-up.sh <ISSUE-ID>` in BJ29 and any repo following that pattern, using the lead ticket ID for a bundle) — it assigns non-colliding ports and a per-ticket database that a hand-rolled `git worktree add` does not. **Serialize `bin/worktree-up.sh` execution** (or guard `.git/config` + port allocation with `flock`) to prevent parallel startup stampedes, and prune merged worktrees before dispatch when `diskFreeGb` is tight. Only where no script exists: `git worktree add ~/Develop/.worktrees/<repo>/<ISSUE-ID> -b <type>/<ISSUE-ID>-<slug>`. The repo's `AGENTS.md` overrides this command on anything worktree- or environment-related.
3. Spawn a subagent (general-purpose, run in background) using the **Difficulty tier × harness routing** table below (keyed by the ticket's `tier:*` label, or the highest tier in a bundle).

   | Difficulty / Role | Claude Code                                 | Codex / Cursor                  | Pi                              | T3Code (`delegate_task` / `orchestrator_capabilities`) |
   | :---------------- | :------------------------------------------ | :------------------------------ | :------------------------------ | :----------------------------------------------------- |
   | `tier:light`      | `haiku` / `sonnet`                          | fast (`sol` / fast)             | `muse-spark`                    | fast model from `orchestrator_capabilities`            |
   | `tier:standard`   | `sonnet` (or `opus` for multi-module seams) | `sol` / `wonder`                | `muse` / `wonder`               | standard model (`sol` / `fable` / `carbon`)            |
   | `tier:strong`     | `opus`                                      | `sol` / `opus`-class            | `wonder` / `opus`-class         | strong model (`opus` / `gpt-sol` / `fable`)            |
   | `reviewer`        | separate `opus` (`factory-merge-reviewer`)  | separate `wonder` / cross-model | separate `wonder` / cross-model | separate cross-vendor `delegate_task` thread           |

   **Domain/risk routing floor:** High-risk domains — **RAG / retrieval / ranking / citation / evals, auth / security, and concurrency** — promote to **`tier:strong`** (`opus` / `gpt-sol`, Fast mode OFF) regardless of a `tier:light` label, while honoring any stricter repo `AGENTS.md` overrides.

   **T3Code backend & delegation lifecycle:** When T3Code Orchestrator MCP tools (`orchestrator_capabilities`, `delegate_task`, `task_cancel`, `t3_thread_wait`, `t3_thread_read`) are available:
   - Call `orchestrator_capabilities` **once per thread** before the first `delegate_task`.
   - Spawn workers and reviewers via **`delegate_task` (`mode: "async"`)** — **never** use `create_threads` or `t3_thread_launch` for worker fan-out (reserved for explicit user requests for new top-level threads).
   - Follow `delegate_task`'s `next` behavior (end turn for reactive wakeup; never poll `task_status` or loop on `t3_thread_wait`).
   - Every new review or re-check is a fresh `delegate_task`, never `t3_thread_send` to a finished child; cancel replaced/extra delegates with `task_cancel` (never `t3_thread_interrupt`).
   - `delegate_task` only accepts `isolation: "shared" | "worktree"` (no `worktreePath` param). Run `bin/worktree-up.sh <ISSUE-ID>` sequentially in the coordinator and pass `isolation: "shared"` with `worktree: <abs-path>` spelled out in `task`, or initialize per-worktree ports/DB inside an `isolation: "worktree"` checkout.

   **Fallback chain:** Fall back to the harness default (`inherit`) when a tier model is unavailable or quota-limited.
   **Hard invariant (`reviewer != implementer`):** Review and critique must run in a separate agent conversation (and a separate model or harness family where available). Self-approval is forbidden.

   Read `shared/commands/factory-ticket.md` (`plugins/core/commands/factory-ticket.md` in linked product repos) and pass its `/factory-ticket` execution contract to the subagent alongside the **full ticket bodies** (IDs, descriptions, all five sections — passing full bodies upfront conserves the 2,500/hr Linear quota) and these concrete orchestrator bindings:
   - **Environment bindings (spelled out in full, never relative):**
     - `worktree: <absolute path>` — a subagent does not reliably inherit the parent's working directory while sibling worktrees run in parallel.
     - **App launch & assigned port:** the dev server command and **this worktree's** non-colliding port from step 2 (not the repo default), or simulator target / `electronAppPath`, plus `bin/dev-login.sh [role]` where present.
     - `artifactDir: <absolute path>` — create `ux-screenshots/` in **this run's Factory workspace** alongside (not inside) the `repo` worktree before spawning, and pass its absolute path for Step 2 visual self-polish and `factory-ux-critic` captures (`1–4` PNGs `≤ 1 MB` each; never committed to git or attached to Linear).
   - **Delegated single-ticket / bundle contract (`shared/commands/factory-ticket.md`):**
     - Execute all implementation, heartbeating, targeted verification + fast pre-push static gates, UX critique, PR creation (one `Fixes <ISSUE-ID>` line per ticket in a bundle), `ux-screenshot` `result.json` publishing, and `## Handoff` steps as defined in `shared/commands/factory-ticket.md` — never merge inside the subagent.
     - Return one explicit terminal verdict to the orchestrator queue loop: `STATE: PR_OPEN`, `STATE: BLOCKED`, or `STATE: FAILED`.

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

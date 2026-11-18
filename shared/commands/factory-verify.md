---
description: Verify open PRs or a branch end-to-end as a real user — static review, live browser/CLI/API drive, in-branch auto-fix (up to 2 rounds), and verdict receipt without merging
argument-hint: "[optional: PR numbers, issue IDs, --open, --branch, --report-only, --deploy [staging|prod]]"
model: sonnet
---

Review open PRs or the current branch **and exercise the running change end-to-end as a human user would**, fix in-scope defects (up to 2 rounds unless `--report-only`), post durable verification receipts, and **stop before merging**.

## Scope and mode resolution

Interpret `$ARGUMENTS`:

- **`--deploy [staging|prod]`**: delegate immediately to `/factory-verify-deploy` (`shared/commands/factory-verify-deploy.md`) for post-deploy rollout checks.
- **Explicit PR numbers or issue IDs** (e.g. `3400 3401` or `CLNT-9693`): verify those PRs.
- **`--open`** (or bare `/factory-verify` when standing on the repo's configured `base` / `deploy_branch`): resolve all open non-draft PRs targeting configured `base` via `gh pr list --state open --json number,headRefName,headRefOid,baseRefName,isDraft,title`.
- **`--branch`** (or bare `/factory-verify` when standing on a feature branch): verify the active branch/worktree against `origin/<base>` (and its linked open PR if one exists).
- **`--report-only`**: disable Gate 3 auto-fixing; report `FIX` findings without modifying branches or pushing commits.

**Never merge:** Running `gh pr merge` is forbidden in `/factory-verify`. Landing belongs strictly to `/factory-merge`.

## Coordinator and independent verifier (`reviewer != implementer`)

- **Non-blocking coordinator:** When verifying multiple PRs (`--open` or a list), stay unblocked in the main session (`<30s` turns; never edit or run test suites on the root checkout). Spawn one isolated verifier subagent per PR using `/factory-work`'s **Difficulty tier × harness routing** table (preferring T3Code `delegate_task` with `mode: "async"` after calling `orchestrator_capabilities` once per thread, ending turn for reactive wakeup, and always honoring **`reviewer != implementer`** — never let the implementing agent verify its own PR).
- **Isolated workspaces:** Give each PR its own worktree (`bin/worktree-up.sh <ISSUE-ID>` when shipped — run sequentially in the coordinator and pass `isolation: "shared"` with `worktree: <abs-path>` in `task`, or initialize per-worktree ports/DB inside `isolation: "worktree"`; otherwise `git worktree add`). Never share a writable checkout or use `git stash` / `git rebase --autostash`.
- **`git patch-id` verdict survival:** Before booting a live instance for a PR, check its comments/reviews for a prior `## Verification Receipt` matching `Verdict: PASS (MERGE-READY)` or `PASS+NOTES`. Compare:
  - `git diff origin/<base>...<verified-sha> | git patch-id --stable`
  - `git diff origin/<base>...<current-head-sha> | git patch-id --stable`
    If the patch-id is identical (e.g. a clean rebase) and REST check-runs on `<current-head-sha>` are green, preserve the live E2E verdict without re-driving the UI; otherwise run all gates against `<current-head-sha>`.

## Per PR, run Gates 1–4 in order

### Gate 1 — Static diff, protocol, and CI check

Apply the cold `factory-merge-reviewer` rubric (`shared/agents/factory-merge-reviewer.md`) against `git fetch --quiet` + `origin/<base>`:

1. **Ticket & PR hygiene:** Check `Owned Paths`, `Fixes <ISSUE-ID>`, `## Handoff`, and targeted verification evidence.
2. **Escalation check:** Run `factory escalate --repo <name> --pr <PR>` (plus behavioral check against `Never auto-merge`). If it touches security-sensitive behavior or targets `master`/`main`, classify `ESCALATE` in Gate 4 (still complete Gate 2 live verification when safe so the human gets full runtime evidence).
3. **Code & suppression hygiene:** Flag real execution-trace bugs, missing error handling, unnarrowed lint/type suppressions without concrete citations, or timer band-aids masking state races.
4. **CI & mergeability:** Query `gh run list --workflow ci.yml --commit <head-sha> --json databaseId --limit 1` and `gh api repos/<owner>/<repo>/commits/<head-sha>/check-runs`. If the PR conflicts with `origin/<base>`, resolve the merge/rebase cleanly inside the PR's isolated worktree (when `--report-only` is unset) before Gate 2 so you test the actual integrated tree.

### Gate 2 — Live end-to-end human drive (Browser / CLI / API)

Verify the real running app rather than trusting tests or diffs (per `shared/floor.md` verification discipline).

1. **Use the repo's verification skill first:** Check the worktree for `.claude/skills/verify-*/SKILL.md` (or `.cursor/skills/verify-*/SKILL.md`) created by `/factory-verify-create`. Follow its `Launch`, `Doctor`, `Drive`, `Evidence`, and `Cleanup` sections and execute the `features/*.md` recipes touched by the PR.
2. **Fallback when no `verify-*` skill exists:**
   - Start an isolated instance from `AGENTS.md` / `package.json` using the worktree's assigned ports and DB (`bin/worktree-up.sh <ISSUE-ID>`), wait on an observable readiness probe (never `sleep N`), and run a quick health/revision check so you never drive the wrong branch or port.
   - Authenticate via `bin/dev-login.sh [role]` or seeded test credentials when present; never edit auth gates or hand-mint sessions to bypass login (report missing dev-auth tooling as a finding).
   - Note in Gate 4 that `/factory-verify-create` can codify this recipe for future PRs.
3. **Default to the active harness's browser and runtime drivers:** Use whatever browser/UI automation the running harness provides (`chrome-devtools` MCP, Pi `chrome_devtools_*`, Panerelay / configured browser skill, IDE browser tools, Playwright, or PTY/HTTP for CLI/API surfaces). Apply `factory-ux-critic`'s bounded single-resync recovery and `$FACTORY_ROOT/bin/chrome-headless.sh` headless fallback on display-less runners — never fall back to static source reads or `curl` to claim a visual pass.
4. **Human-like proof standards:**
   - Exercise real user entry points (ARIA roles, accessible labels, routes, clicks, keyboard flow, CLI invocations) — never internal state setters or test-only endpoints.
   - Drive the happy path from the ticket/PR diff **plus** at least one edge, validation, cancel, empty/error, or recovery state.
   - Check console, network, and server output (`list_console_messages`, `list_network_requests`, dev-server logs): require `0` uncaught JS exceptions, hydration mismatches, CSP/CORS errors, failed asset loads, or unexpected `4xx`/`5xx` responses.
   - Confirm persistence and real side effects after a full reload (`location.reload()`), reopened view, or secondary API/DB read — a toast alone does not prove persistence.
   - For web UIs, check desktop and mobile viewports when layout or responsive behavior changed; capture **1–4 bounded screenshots** (`≤ 1 MB` each, mobile or element-scoped preferred) saved outside the repo (`$FACTORY_ARTIFACT_DIR` or `ux-screenshots/`). Never `Read` screenshots back into context, and never commit images to git.
   - Run **Cleanup** after every drive: stop only processes/ports started by this run while leaving proof artifacts intact.

### Gate 3 — Auto-fix in-branch loop (default: max 2 rounds; skipped on `--report-only`)

When Gate 1 or Gate 2 uncovers an in-scope `FIX` defect (broken flow, console/`5xx` failure, UI layout/contrast/overlap bug, failing targeted test, or lint/type error):

- Unless `--report-only` is set:
  1. Fix the root cause cleanly inside the PR's worktree and within `Owned Paths`.
  2. Run targeted unit tests for the touched surface plus fast pre-push static gates.
  3. Re-run **Doctor** and live **Drive** on the broken journey to prove the fix against the real app (observing the repaired state and clean console/network logs).
  4. Commit (`fix(<scope>): <summary> (<ISSUE-ID>)`) and push to the PR branch.
  5. Repeat up to **2 rounds** maximum. If still failing after 2 rounds (or if fixing requires expanding `Owned Paths` or changing product intent), stop and mark `FIX (unresolved after 2 rounds)` (or `ESCALATE`).

### Gate 4 — Verification receipt and stop before merging

1. **Record proof on the PR:** Post (or update) a `## Verification Receipt` comment on the PR (and summarize on the ticket if needed) containing:
   - `Verdict:` `PASS (MERGE-READY)` | `PASS+NOTES` | `FIX` | `ESCALATE` | `NOT-ASSESSED`
   - `Verified Head:` `<branch>@<sha>` (`patch-id: <hash>`)
   - `Surface Driven:` browser/CLI/API + URL/port + whether `.claude/skills/verify-*` was used
   - `Flows Exercised:` happy path + edge/error checks + persistence verification
   - `Console / Network:` error counts observed
   - `Fix Rounds:` `0` | `1` | `2` (with commit SHAs if auto-fixed)
   - `Proof Artifacts:` paths or `$FACTORY_WEB_URL/api/artifacts/<sha256>` links (or concrete exception)
   - `Notes / Follow-ups:` any non-blocking `Triage` issues filed
2. **File out-of-scope or non-blocking findings:** Create `Triage` issues (`factory ticket file ...`) for minor/polish issues or missing `/factory-verify-create` harness setup, citing PR and commit SHA.
3. **Output the operator table and stop:** Present a concise table (`PR`, `Issue`, `Head`, `CI`, `Live Drive`, `Fix Rounds`, `Verdict`, `Action Waiting`). Do **not** merge any PR.

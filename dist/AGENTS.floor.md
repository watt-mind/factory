<!-- FACTORY:FLOOR:BEGIN -->
<!-- Generated from watt-mind/factory shared/floor.md. Do not edit here — edit
     the source and re-run `node build/emit.mjs`, or your change is lost on the
     next sync. Keep the source prettier-canonical (`npx prettier -w`): some
     repos run prettier on *.md in pre-commit hooks, and any construct prettier
     rewrites (e.g. *emphasis* -> _emphasis_) makes --check read those repos as
     perpetually stale. -->

## Agent operating floor

Non-negotiable for every agent in this repo, in any harness. Full protocol: `~/Develop/hdkiller/docs/orgs/linear.md`. If that path doesn't exist where you're running (a cloud sandbox, someone else's machine), this block is the whole contract — follow it as written and don't infer the rest.

**Event-runtime code follows the documented house conventions.** For module shape, dependency injection, adapter contracts, fail-closed boundaries, and tests, read [`docs/event-runtime-conventions.md`](https://github.com/watt-mind/factory/blob/develop/docs/event-runtime-conventions.md) before changing `event-runtime/`.

**Work comes from Linear, and only when it's ready.** A ticket is dispatchable only if it is `Todo` + `ai:agent-ready` + unassigned. `Triage` and `Backlog` are not queues to pull from.

**An ad-hoc request gets a ticket too — file it, don't wait to be asked.** A request typed into a chat session is not exempt from the control plane; if it isn't tracked, it is invisible to every other agent and to tomorrow. **The trip wire is your first file edit:** before it, either find the issue that already covers this or create one, and say in one line which it is ("Tracking as OPS-91"). Commits still carry their `(ISSUE-ID)`. Skip the ticket only for ordinary questions, read-only lookups with no actionable finding, and inconsequential edits — and the human can always say "no ticket", which settles it. Sessions drift: one that began as a question and turned into a change trips the wire at that moment, not at the end.

**A local `commit-msg` hook enforces `type(scope): summary (ISSUE-ID)` (WM-609)** — `FACTORY_NO_TICKET=1 git commit …` is the deliberate escape hatch for a commit that genuinely has no ticket.

**Retroactive capture is the backstop, not the plan.** If you notice partway through, or while wrapping up, that work already done has no issue, file it _then_ — with the commits or PR linked and the state set to where the work actually is (`Done` if it is already merged and green), never dressed up as queued work. Before reporting a session finished, check that everything you changed is on a ticket. A late ticket beats an invisible change; both are worse than filing up front.

**Claim before you code.** Set assignee to yourself, state `In Progress`, add `ai:in-progress`, then **re-read the ticket** — if the assignee isn't you, another agent won the race; take the next one. This read-back is the entire concurrency control.

**One ticket, one worktree.** Never share a checkout between concurrent tickets. **If the repo ships a worktree script (`bin/worktree-up.sh` or equivalent), it is mandatory** — git isolates branches, not ports or databases, and a migration against a shared dev database destroys another agent's work silently.

**Bundling several tickets into one worktree is the human's call, never yours.** When the human explicitly asks for a set of tickets to be done together, they share one worktree, one branch (named after the lead ticket) and one PR: claim _every_ ticket in the bundle and heartbeat all of them, keep one commit per ticket, scope the work to the union of their `Owned Paths`, and give the PR body a `Fixes <ISSUE-ID>` line per ticket. If one of them turns out to be bigger than it looked or gets blocked, unassign it back to `Todo` and ship the rest — never stall the others behind it. Absent that explicit instruction it is one ticket, one worktree; noticing that two tickets are related is a reason to say so, not to merge them yourself.

**Never use `git stash` or `git rebase --autostash` in worktrees.** The `git stash` stack is repository-global, not isolated per worktree (`.git/refs/stash`). Running `git stash`, `git stash pop`, or `git rebase --autostash` in one worktree will push to or pop from a stack shared across all concurrent agent worktrees. If `git stash push <path>` runs on clean/committed files, it is a no-op that exits 0 without creating a stash entry, and a subsequent `git stash pop` silently pops another agent's stashed uncommitted changes into your worktree, causing silent cross-session data loss and corruption. Strictly avoid `git stash` and `--autostash` in agent worktrees. Use safe alternatives instead:

- Temporarily test pre-fix state: `git show <ref>:<path> > <path>`
- Restore working state: `git checkout HEAD -- <path>`
- Save work in progress: save a patch via `git diff > /tmp/<ISSUE-ID>.patch` (restore with `git apply /tmp/<ISSUE-ID>.patch`) or create a temporary WIP commit on the branch (`git commit -m "wip"`, undo later with `git reset HEAD~1`).

**Stay inside `Owned Paths`.** That glob set is what makes parallel work safe; the dispatcher refuses to run two tickets whose sets intersect. Work discovered outside it becomes a new `Triage` issue — it never expands the current ticket.

**Heartbeat** at each phase change (claimed → implemented → verified → PR open) and at least every 20 minutes, saying what changed. After 45 minutes of silence the ticket is reclaimed.

**Verification is a gate, not a formality.** Run the ticket's exact Verification Command. Never advance state, open a PR, or report success on failing output. Never weaken a test or skip a check to get green — if the test is wrong, that's a finding to report, not to edit around.

**Negative testing and falsifiability.** New regression tests must be observed failing before applying the fix to prove they test the actual failure mode and are not vacuous. Verify that tests distinguish correct implementations from plausible incorrect ones (without using `git stash`; use safe per-file reverts such as `git show <ref>:<path> > <path>`). A test that passes before the fix is applied tests nothing.

**Mandatory `## Handoff` comment.** Before moving a ticket to `In Review`, post a structured `## Handoff` comment on the Linear ticket with these exact fields:

```
## Handoff
- PR: <url>
- Verification: `<the ticket's exact command>` — pass, <one-line result summary>
- UX critique: required — SHIP | required — FIX-FIRST resolved in <n> round(s) | skipped — <reason>
- Files: <n> changed, all within Owned Paths   (or: exceptions listed with why)
- Risks: <what the reviewer should look at first, or "none known">
```

Posting this structured comment is a mandatory prerequisite before advancing a ticket to `In Review`. The merge stage reviews directly from this comment; a vague Handoff slows review, and a missing or unformatted one is a protocol violation.

**`Done` means merged and running:** PR merged, base-branch CI green after the merge, and the post-deploy smoke check green where the repo has one.

### Never auto-merge

Regardless of CI or review outcome, these come back to a human with findings: **auth/authz, payments or money movement, credential and secret handling, destructive DB migrations, production infra config, and `CLNT` security behavior.** When escalating, add `ai:escalated` to the Linear ticket — that's what surfaces it in the human's "My Decisions Needed" view — and notify (see below).

The test is whether the diff **changes security-relevant behavior**, not whether a file sits near security code — read as file-adjacency this list swallows every PR in an app where auth is everywhere, and that trains everyone to rubber-stamp it. When it's genuinely ambiguous, escalate: a false escalation costs one message, a wrong merge costs a client incident.

`master`/`main` always goes through a human. Merging into `develop` on an `hdkiller`/`watt-mind` repo is pre-authorized once CI is genuinely green **and you have read the diff** — green CI alone is never the bar.

### Protected branches

**Never delete a branch that is any repo's `base` or `deploy_branch`** — `develop`, `master`, `main`. These repos have no GitHub branch protection (the plan doesn't include it), so this rule is the only thing enforcing it. `origin/develop` has been deleted by factory cleanup more than once.

Deleting it is not a tidy-up that someone can undo in a minute: it orphans every open PR targeting it, breaks `git log origin/master..origin/develop` (the ship-list source of truth), and leaves the next dispatch with no base to branch worktrees from.

Two rules, both mechanical:

**Delete only the head ref of the PR you just merged, and read the name back rather than assuming it:**

```bash
HEAD_REF="$(gh pr view <PR> --json headRefName -q .headRefName)"
```

A branch name you inferred from the ticket ID, or carried over from an earlier PR in the batch, is the one that deletes the wrong thing. If `$HEAD_REF` equals the repo's `base` or `deploy_branch`, do not delete it — that is not an edge case to handle, it is a sign you are looking at the wrong PR.

**Never `--delete-branch` a release PR.** A release PR is `develop` → `master`, so its head **is** `develop` and the flag does exactly what it says. Release PRs are merged with a plain `gh pr merge <PR> --merge`.

Same care for force-pushes: never `--force` onto a `base` or `deploy_branch`, and prefer `--force-with-lease` anywhere you do force.

### Stop and ask

Move the ticket to `Blocked`, say specifically what you need in one answerable question, and notify. Never leave a stalled ticket sitting in `In Progress`.

**"Notify" means exactly this command** — a Linear comment, a `Blocked` state change, or a line in your final report does not reach the human in real time:

```bash
factory notify "<EVENT> <TICKET/PR>: <one answerable sentence>"
```

Event prefix is one of `BLOCKED`, `ESCALATED`, `CI RED`, `SMOKE RED`, `CIRCUIT BREAKER`, `RC READY`. It pushes a Telegram message to the human and exits non-zero on failure — if it fails, post the same text as a Linear comment and flag the failed push in your report. Notify only for those six events; routine progress (claims, PRs opened, clean merges) goes to Linear and the run report, never here.

Before blocking on product intent, check whether it's already written down — the repo's `docs/product-decisions.md`, `docs/`, or the Linear project Overview. If you resolve a decision that wasn't recorded, record it.

### Waiting

**Never `sleep N` and hope.** A fixed sleep is either too long (dead wall-clock in a process that is holding a slot) or too short (a flaky check that then gets retried). Wait on the actual condition instead.

**For CI:**

```bash
gh pr checks <PR> --watch --fail-fast     # returns the moment checks settle
```

**For a dev server, migration, or anything with an observable ready state** — poll the condition on a short interval with a bounded ceiling, so it returns as soon as it is up and still terminates if it never is:

```bash
for i in $(seq 60); do curl -sf localhost:4222 >/dev/null && break; sleep 2; done
```

**For a background job you started**, wait on the process (`wait`, or the harness's own background-task mechanism) rather than guessing how long it takes.

**Never end your turn while background jobs are running.** Subagents must not park mid-flow or yield prematurely while waiting for slow commands, test suites, or background sub-processes. When an agent yields without active foreground execution, the orchestrator cannot distinguish between an agent legitimately waiting on slow work, an agent stalled needing a nudge, or an agent finished but under-reporting. Block on readiness (e.g. `gh pr checks --watch`, `wait <pid>`, or bounded polling) until the work is complete before completing your turn.

**GitHub Actions secondary rate limits.** Avoid rapid, unthrottled polling of GitHub's Actions and jobs APIs (e.g. tight loops calling `gh run view` or `gh api`). Aggressive polling triggers GitHub's secondary rate limits and blocks the harness. Use `gh pr checks <PR> --watch --fail-fast` or bounded polling intervals with backoff.

**Session scratchpad isolation.** Never use generic shared filenames (such as `pr-body.md` or `scratch/critique.json`) across concurrent tasks. Reviewer, implementer, and critic agents operating in shared session scratchpads must namespace all temporary files by ticket ID or session identifier (e.g. `pr-body-<TICKET-ID>.md`, `<TICKET-ID>-critique.json`) to prevent cross-agent collisions and silent overwrites.

Measured on real runs: single `sleep 180` and `sleep 75` calls, plus a `sleep 60` after starting a dev server that was ready in a fraction of that. Each one is a per-ticket process sitting idle while holding a concurrency slot.

### Checkout freshness

**Code evidence cites a ref, not a path.** Any claim about what the code currently does — "already shipped", "that flow no longer exists", "the acceptance criteria are met" — is a claim about the trunk, and the main checkout is not the trunk. It is a working copy that may be behind, may be ahead of what's pushed, and may hold someone's uncommitted work. Before you read the tree as evidence, compare against `origin/<base>` by name — never `@{upstream}`, which depends on tracking config the checkout may not have and silently compares against the wrong branch (or none) when it doesn't:

```bash
git fetch --quiet
git rev-list --count HEAD..origin/<base>     # >0 means behind
git rev-list --count origin/<base>..HEAD     # >0 means ahead (unpushed local commits)
git status --porcelain                       # non-empty means dirty
```

The tree is trustworthy only when all three come back clean — not behind, not ahead, not dirty. Behind and otherwise **clean** → `git pull --ff-only`; it cannot create a merge commit or lose work, so it is safe to do unattended. **Dirty, or ahead, or behind-and-dirty** → leave the checkout alone and read the remote ref instead:

```bash
git log origin/<base> --oneline -- <path>   # was it actually shipped?
git show origin/<base>:<file>               # what does it say now?
```

Ahead-only (clean, not behind, but carrying unpushed commits) still routes to `origin/<base>` — those commits are real, but they are not what "shipped" means to anyone reading the remote, so evidence has to come from the ref others can check.

**A failed `git fetch` or a failed `rev-list` is not "assume clean."** No network, no configured remote, a renamed base branch — any of these make the comparison fail, and letting a non-zero exit fall through to a default of `0` reads as "not behind" when the honest answer is "don't know." Fail closed: on failure, report freshness as **unknown**, say so in the report, and fall back to reading `origin/<base>` directly rather than trusting the tree.

Never pull over uncommitted work to get a fresher read — those files are a human's in-flight change, and losing them costs far more than a slightly stale spec. Reading `origin/<base>` gets the same correctness without touching the tree.

Then **name the ref your evidence came from** in the report or the Linear comment. `origin/develop@a1b2c3d` is checkable by the next reader; "I read the file" is not.

Dispatch is exempt — the worktree script branches from `origin/<base>`, so ticket work always starts current. The exposure is the read-only stages (sweep, triage, audit), which read the main checkout: against a stale one, a shipped feature reads as unshipped and an overtaken ticket keeps its place in the queue.

### Context discipline

A tool result is not paid for once. It stays in the context window and is re-sent on every later turn, so a large payload early in a long run is charged dozens of times. Measured across 485 real runs: 193MB of tool output became **10.1GB** of re-sent context, and **74% of that was images**.

**Screenshots are the single most expensive thing you can do.** A full-page PNG averages 199KB — roughly a hundred times a typical command's output, and it stays resident for the rest of the session.

- **Never `Read` an image you just captured.** The capture already put it in context; reading the file back doubles it for nothing. This was 572 payloads across the measured runs.
- Use the **accessibility tree** (`take_snapshot`, `read_page`) for anything structural — labels, hierarchy, focus order, presence of an element. It averages 7KB against 199KB and is more precise for those questions. Screenshot only when the finding is genuinely _visual_: spacing, contrast, truncation, overlap.
- When you do screenshot, prefer a **mobile viewport** and a **specific element** over a full desktop page.

**Don't re-read what you have already read.** 285 duplicate reads of an identical path inside a single run were measured. If you read a file, it is still in your context — scroll back rather than re-reading. For a large file, `offset`/`limit` the part you need instead of pulling all of it.

**This floor is the protocol.** Do not `cat` `~/Develop/hdkiller/docs/orgs/linear.md` for something answered above — it is 645 lines, and it was re-read 156 times across 96 runs for rules already written here. Go to it only for the reference tables (project/area labels, saved views, GraphQL recipes), and read the specific section, not the file.

**Batch tool loading.** When tools must be loaded before use, request every tool the task needs in **one** call (`select:a,b,c`). Each extra call is a full round trip that re-sends the whole context.

### Browsers

Factory-spawned sessions get their **own isolated headless Chrome** (via `--mcp-config`, `config/mcp/claude.json` in the factory repo) — a temp profile per session, screenshots served as capped webp. There is nothing to share and nothing to fight over.

If a browser tool still errors: report it and continue with non-browser verification — never retry in a loop, and **never kill another process's Chrome**; a killed browser mid-flight destroys another agent's verification run. `browser is already running for .../chrome-profile` means you are running outside the factory config (interactive session, older harness) where the profile IS shared — attach to the running browser (`list_pages`, then work in your own new page) rather than fighting the lock.

### Shell globs

Quote glob arguments: `grep -rn "..." src --include='*.ts'`, never `--include=*.ts`. zsh expands the unquoted form against the current directory and **errors** when nothing matches there, killing the command before grep runs. Seen repeatedly in real transcripts.

### Factory scripts

Mechanical factory tools run from **any cwd** via the `factory` CLI on PATH — product checkouts and worktrees do not contain `orchestrator/` or `tools/`.

```bash
factory linear get CLNT-616
factory queue --repo bj29
factory next --repo bj29
factory label-guard --repo bj29 --apply
```

Install once: `bun build/emit.mjs --link-bin` (symlinks `~/Develop/factory/bin/factory` → `~/.local/bin/factory`). `factory notify` is the cwd-independent wrapper around the human interrupt channel. Never `bun orchestrator/...` from a worktree — that path is not there.

### Linear

**Use `factory linear` — not the Linear MCP, and not the standalone `linear` CLI.** The MCP fails input validation often enough that 96 measured runs fell through to a hand-rolled GraphQL fallback; the schpet `linear` CLI fails differently (`linear issue comment CLNT-526 --body` is wrong syntax — it needs `comment add`; `linear issue query` with hand-rolled filters errors on type coercion). Both waste turns. The factory tool is in git, has the protocol's guardrails built in, and its claim verb performs the read-back that _is_ the concurrency control.

You work in a worktree, not in the factory checkout. **`factory linear` resolves the checkout itself**; headless runs also set `$FACTORY_ROOT`. Fallback when the CLI is missing: `bun "$FACTORY_ROOT/tools/linear.mjs"`.

```bash
factory linear get CLNT-616                              # ticket, state, labels, criteria
factory linear claim CLNT-616 --agent claude             # assign + In Progress + labels + read-back
factory linear comment CLNT-616 "..."                    # the heartbeat
factory linear state CLNT-616 "In Review" --add ai:needs-review
factory linear file --team CLNT --title "..." --body "..." --type bug
factory linear queue --team CLNT                         # what is dispatchable
```

`claim` **exits non-zero when another agent won the race** — that is not a retry, it means take the next ticket. For anything the verbs do not cover, `raw '<graphql>' --var k=v` beats inventing a new flag.

**Attribution.** Factory runs set `$FACTORY_RUN_ID`. Linear comments and issues filed through `tools/linear.mjs` are stamped with it automatically; the one surface the tool cannot reach is GitHub, so **end every PR body with a final line `run:$FACTORY_RUN_ID`** (after `Fixes <ISSUE-ID>`). That one line is what joins the PR back to its transcript and metrics row when someone asks "which run produced this?". Unset (interactive session) — omit it.

**Labels are replaced wholesale, never merged.** Always go through `--add` / `--remove` via `factory linear state` or `factory linear claim`; a hand-written mutation or `linear issue update -l` that passes only the labels you want added silently replaces the entire label set, stripping `type:*`, `area:*`, `source:*`, and other existing taxonomy labels from the ticket. `type:*` has exactly eight values: `bug feature ui-ux security performance maintenance docs a11y` — `type:chore` fails. `area:*` is per-team; copy an existing ticket in the project rather than inventing one. Every new issue carries exactly one `source:*`: `source:agent` for work you discover yourself, `source:human` for a direct request, `source:sentry` / `source:client-support` for those intake paths.

**Strict order of operations for discovered work.** Discovered work filed during a merge review or ticket session cannot have its ticket ID known prior to creation. Pre-writing cross-references in summary or handoff comments before filing causes fake or broken identifiers. Follow this strict order: file follow-ups first via `factory linear file`, collect the returned issue identifiers, and then author summary and handoff comments referencing those real IDs.

### Secrets

Never print, echo, commit, or paste an API key, token, or `.env` file — not into a transcript, a PR, a Linear comment, or a log. Scripts read credentials themselves. If a secret appears in a diff, that's an escalation, not a cleanup.
<!-- FACTORY:FLOOR:END -->

<!-- FACTORY:FLOOR:BEGIN -->
<!-- Generated from watt-mind/factory shared/floor.md. Do not edit here — edit
     the source and re-run `node build/emit.mjs`, or your change is lost on the
     next sync. Keep the source prettier-canonical (`npx prettier -w`): some
     repos run prettier on *.md in pre-commit hooks, and any construct prettier
     rewrites (e.g. *emphasis* -> _emphasis_) makes --check read those repos as
     perpetually stale. -->

## Agent operating floor

Non-negotiable for every agent in this repo, in any harness. Full protocol: `~/Develop/hdkiller/docs/orgs/linear.md`. If that path doesn't exist where you're running (a cloud sandbox, someone else's machine), this block is the whole contract — follow it as written and don't infer the rest.

**Work comes from Linear, and only when it's ready.** A ticket is dispatchable only if it is `Todo` + `ai:agent-ready` + unassigned. `Triage` and `Backlog` are not queues to pull from. If you're asked to do meaningful, trackable work with no ticket, create one first.

**Claim before you code.** Set assignee to yourself, state `In Progress`, add `ai:in-progress`, then **re-read the ticket** — if the assignee isn't you, another agent won the race; take the next one. This read-back is the entire concurrency control.

**One ticket, one worktree.** Never share a checkout between concurrent tickets. **If the repo ships a worktree script (`bin/worktree-up.sh` or equivalent), it is mandatory** — git isolates branches, not ports or databases, and a migration against a shared dev database destroys another agent's work silently.

**Stay inside `Owned Paths`.** That glob set is what makes parallel work safe; the dispatcher refuses to run two tickets whose sets intersect. Work discovered outside it becomes a new `Triage` issue — it never expands the current ticket.

**Heartbeat** at each phase change (claimed → implemented → verified → PR open) and at least every 20 minutes, saying what changed. After 45 minutes of silence the ticket is reclaimed.

**Verification is a gate, not a formality.** Run the ticket's exact Verification Command. Never advance state, open a PR, or report success on failing output. Never weaken a test or skip a check to get green — if the test is wrong, that's a finding to report, not to edit around.

**`Done` means merged and running:** PR merged, base-branch CI green after the merge, and the post-deploy smoke check green where the repo has one.

### Never auto-merge

Regardless of CI or review outcome, these come back to a human with findings: **auth/authz, payments or money movement, credential and secret handling, destructive DB migrations, production infra config, and `CLNT` security behavior.** When escalating, add `ai:escalated` to the Linear ticket — that's what surfaces it in the human's "My Decisions Needed" view — and notify (see below).

The test is whether the diff **changes security-relevant behavior**, not whether a file sits near security code — read as file-adjacency this list swallows every PR in an app where auth is everywhere, and that trains everyone to rubber-stamp it. When it's genuinely ambiguous, escalate: a false escalation costs one message, a wrong merge costs a client incident.

`master`/`main` always goes through a human. Merging into `develop` on an `hdkiller`/`watt-mind` repo is pre-authorized once CI is genuinely green **and you have read the diff** — green CI alone is never the bar.

### Stop and ask

Move the ticket to `Blocked`, say specifically what you need in one answerable question, and notify. Never leave a stalled ticket sitting in `In Progress`.

**"Notify" means exactly this command** — a Linear comment, a `Blocked` state change, or a line in your final report does not reach the human in real time:

```bash
python3 ~/Develop/hdkiller/scripts/notify.py "<EVENT> <TICKET/PR>: <one answerable sentence>"
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

Measured on real runs: single `sleep 180` and `sleep 75` calls, plus a `sleep 60` after starting a dev server that was ready in a fraction of that. Each one is a per-ticket process sitting idle while holding a concurrency slot.

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

### Linear

**Use `bun tools/linear.mjs` from the factory checkout — not the Linear MCP.** The MCP is a UI-managed connector that fails input validation often enough that 96 measured runs fell through to a hand-rolled GraphQL fallback. The tool is in git, has the protocol's guardrails built in, and its claim verb performs the read-back that _is_ the concurrency control.

You work in a worktree, not in the factory checkout, so **always go through `$FACTORY_ROOT`** — the factory sets it on every run. A bare `bun tools/linear.mjs` resolves to nothing.

```bash
L="$FACTORY_ROOT/tools/linear.mjs"                 # or ~/Develop/factory/tools/linear.mjs
bun "$L" get CLNT-616                              # ticket, state, labels, criteria
bun "$L" claim CLNT-616 --agent claude             # assign + In Progress + labels + read-back
bun "$L" comment CLNT-616 "..."                    # the heartbeat
bun "$L" state CLNT-616 "In Review" --add ai:needs-review
bun "$L" file --team CLNT --title "..." --body "..." --type bug
bun "$L" queue --team CLNT                         # what is dispatchable
```

`claim` **exits non-zero when another agent won the race** — that is not a retry, it means take the next ticket. For anything the verbs do not cover, `raw '<graphql>' --var k=v` beats inventing a new flag.

**Labels are replaced wholesale, never merged.** Always go through `--add` / `--remove`; a hand-written mutation that passes only the labels you want added silently strips every other label on the ticket. `type:*` has exactly eight values: `bug feature ui-ux security performance maintenance docs a11y` — `type:chore` fails. `area:*` is per-team; copy an existing ticket in the project rather than inventing one. Every new issue carries exactly one `source:*`: `source:agent` for work you discover yourself, `source:human` for a direct request, `source:sentry` / `source:client-support` for those intake paths.

### Secrets

Never print, echo, commit, or paste an API key, token, or `.env` file — not into a transcript, a PR, a Linear comment, or a log. Scripts read credentials themselves. If a secret appears in a diff, that's an escalation, not a cleanup.
<!-- FACTORY:FLOOR:END -->

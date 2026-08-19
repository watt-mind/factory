# factory

Runs on **bun**. The control layer of the Watt Mind agent factory: shared commands, agents, and skills packaged for every supported coding harness, plus the scheduler and dispatcher that run the standing loops.

**Linear is the control plane, GitHub is the source of truth, CI is the reward signal.** Nothing merges because an agent said it was done — it merges because the tests passed and a reviewer (agent or human) approved.

## Layout

**`shared/` is the source of truth. Everything in `plugins/` and `dist/` is generated — never edit it.**

```
shared/                           harness-neutral content, the only place to edit
  floor.md                        the non-negotiables (goes into every AGENTS.md)
  commands/                       the thirteen /factory-* commands (table below)
  skills/                         ticket-spec (SKILL.md — a format all harnesses share)
  agents/                         factory-{ux-critic,ci-doctor,infra-scout,merge-reviewer}
build/emit.mjs                    shared/ -> per-harness packaging; --check guards drift
plugins/core/                     GENERATED — the Claude Code plugin
dist/{codex,gemini,cursor,pi}/    GENERATED — the other harnesses
dist/AGENTS.floor.md              GENERATED — paste/sync into each repo's AGENTS.md
orchestrator/                     dispatch logic (owned-paths collision, tick)
orchestrator/watch.jsx            TUI: queue + in-flight tickets + live log tail, plus
                                  the keys that start a stage
event-runtime/                    the separate event-driven sidecar — intake, planner,
                                  watched approval, worker, verification, receipt
runners/run-agent.sh              one harness session against one repo
bin/factory                       the cwd-independent CLI, symlinked to ~/.local/bin
bin/worktree-{up,down}.sh         this repo's own worktree lifecycle
lib/, tools/                      shared helpers: transcripts, spend, schedule, Linear
config/repos.yaml                 per-repo routing: team, base, worktree scripts, verify
config/schedule.yaml              ONE source of truth for cadences
config/policy.yaml                budgets, concurrency, escalation
deploy/gen.mjs                    schedule.yaml -> launchd plists
evals/                            prompt regression cases (no runner yet — see SETUP.md)
```

## Multi-harness

The **content** is portable; only the **packaging** isn't. `SKILL.md` is a shared workflow format, command bodies are Markdown, and each harness gets its native custom-agent manifest.

| Harness     | Context                   | Skills              | Commands                    | Agents                |
| :---------- | :------------------------ | :------------------ | :-------------------------- | :-------------------- |
| Claude Code | `CLAUDE.md` → `AGENTS.md` | plugin `skills/`    | plugin `commands/`          | plugin `agents/`      |
| Codex       | `AGENTS.md` (native)      | `~/.agents/skills/` | — (use `@factory-*` skills) | `~/.codex/agents/`    |
| Pi          | `AGENTS.md` (native)      | `dist/pi/skills/`   | `dist/pi/prompts/`          | `~/.pi/agent/agents/` |
| Gemini CLI  | `GEMINI.md` → `AGENTS.md` | `~/.gemini/skills/` | —                           | `~/.gemini/agents/`   |
| Antigravity | shares `~/.gemini/`       | via Gemini          | —                           | via Gemini            |
| Cursor      | `.cursor/rules/`          | —                   | `~/.cursor/commands/`       | `~/.cursor/agents/`   |

```bash
bun build/emit.mjs           # regenerate everything
bun build/emit.mjs --check   # CI: fail if the tree drifted from shared/
bun build/emit.mjs --link    # symlink this machine's harnesses at shared/
bun run link-repos           # symlink plugins/core/commands/ into every repo in config/repos.yaml
```

`--link`/`--link-repos` symlink rather than copy, so a `git pull` updates every harness (or repo) at once and there is no copy to go stale. Both refuse to overwrite a real file. `link-repos` matters specifically for headless dispatch — `runners/run-agent.sh` reads commands straight from `<repo>/.claude/commands/`, not the marketplace plugin — so re-run it whenever a `/factory-*` command changes (see SETUP.md §2).

> [!IMPORTANT]
> **The plugin is a convenience layer, not the safety floor.** It reaches Claude Code only, and a cloud sandbox without GitHub auth for this private repo gets nothing — failing closed without knowing it.
>
> So the non-negotiables live in `shared/floor.md` and are committed into each repo's **`AGENTS.md`**, which every harness reads and which travels with the checkout.

## Open-core boundary

Factory's orchestration, event runtime, shared agent workflows, harness
packaging, and public extension contracts form the open core. The current
repository is licensed under Apache License 2.0 and is intended to remain
useful, buildable, and testable without private services or unpublished code.

[`ee/`](ee/README.md) reserves an explicit seam for possible enterprise-only
extensions. Core code may expose generic contracts that enterprise extensions
implement, but it must not import or depend on enterprise implementations. The
directory currently contains documentation only. If separately licensed code
is added there in the future, it must carry explicit terms; placement under
`ee/` alone does not override the repository license.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change, especially one
that may cross this boundary.

**Why `--check` is the important half.** The failure this repo exists to prevent is a rule living in one harness's file and nowhere else — coach-wattz carries "NEVER `prisma db push`" only in `GEMINI.md`, invisible to Claude. Four generated copies are only safer than four hand-written ones if CI proves they still match their source. If the check fails, move the rule into `shared/`; never edit the generated file.

## Using it from a product repo

```json
// <repo>/.claude/settings.json
{
  "extraKnownMarketplaces": {
    "factory": { "source": { "source": "github", "repo": "watt-mind/factory" } }
  },
  "enabledPlugins": ["core@factory"]
}
```

## Commands

Prefixed `factory-` so they're identifiable as ours and never collide with a repo-local or built-in command of the same name.

| Command             | Does                                                                                           |
| :------------------ | :--------------------------------------------------------------------------------------------- |
| `/factory-work`     | Claims agent-ready tickets, dispatches them rolling (not batched), lands the PRs               |
| `/factory-ticket`   | Implements exactly one already-claimed ticket in the current worktree — what `tick.mjs` spawns |
| `/factory-merge`    | Reviews open PRs, fixes what's mechanical, merges what qualifies                               |
| `/factory-ship`     | Opens the `develop` → deploy-branch PR, waits for CI, merges, verifies the deploy              |
| `/factory-triage`   | Turns `Triage` tickets into `ai:agent-ready` ones                                              |
| `/factory-unblock`  | Re-examines `ai:blocked` holds and releases the ones new evidence resolved                     |
| `/factory-sweep`    | Retires tickets overtaken by events — `Canceled`/`Duplicate` with evidence, never a delete     |
| `/factory-audit`    | Grades a repo against project-conventions `PC-01`..`PC-20`, files the gaps                     |
| `/factory-capture`  | Files a Linear issue from the conversation — capture only, never implement                     |
| `/factory-friction` | Files harness friction seen in an interactive session, where no transcript exists              |
| `/factory-retro`    | Turns measured friction into harness changes                                                   |
| `/factory-report`   | Read-only pipeline snapshot across the configured repos                                        |
| `/factory-next`     | Picks the one next stage for this repo, and runs it only when asked                            |

### `factory status` — the everyday hub

Run this from a configured repository (or choose one explicitly):

```bash
factory status
factory status --repo legalease
factory status --json
```

It is read-only and answers the immediate operational questions: which repository
and branch you are in, whether the checkout is clean, the fetched remote base
and deploy refs, deployment freshness, the live Linear pipeline counts, and the
single recommended next action. The default output explains that action in plain
English; `--json` is for scripts.

A repo may opt into deployment revision comparison in `config/repos.yaml`:

```yaml
deployment:
  url: https://app.example.com/healthz # exact endpoint, or origin -> /version.json
  branch: develop # branch represented by this environment
  revision_field: revision # optional; commit/git_sha/sha are automatic
```

The endpoint must return JSON containing a revision field, such as
`{"revision":"<git SHA>"}` or `{"commit":"<git SHA>"}`. `factory status`
labels failures to fetch or missing metadata as **unknown**—never as a stale
deploy—and distinguishes an older deploy from an unrelated revision. It also
shows when the reaper and per-repository janitor last ran.

### GitHub Actions cache storage guard

`factory actions-cache` reports the organization-wide GitHub Actions cache footprint by repository and exits non-zero once it reaches the configured warning percentage. It is read-only; it does not delete caches.

```bash
factory actions-cache
factory actions-cache --json
factory actions-cache --included-gb 73 --warning-percent 60
```

The organization, included allowance, and warning threshold live in `config/policy.yaml`. Confirm the allowance against GitHub billing when it changes; the initial 73 GB value was inferred from the August 2026 90%-used alert.

### CLI notification wrapper

`factory notify` is the cwd-independent human interrupt channel used by the factory floor:

```bash
factory notify "BLOCKED LAB-176: need approval"
echo "CI RED LAB-176: verification failed" | factory notify -
```

It delegates to `~/Develop/hdkiller/scripts/notify.py` and preserves its exit status, so callers must post the same message to Linear when it fails.

## Agents

Agents are isolated specialist contexts, not workflow entry points. Their names use `factory-<role>` so ownership is visible without repeating the resource type in every identifier.

| Agent                    | Does                                                                                                               |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `factory-ux-critic`      | Exercises a materially changed user journey and returns a read-only `SHIP` / `FIX-FIRST` critique                  |
| `factory-merge-reviewer` | Reviews one PR cold and returns `MERGE` / `FIX` / `ESCALATE`, so the diff never enters the merge session's context |
| `factory-ci-doctor`      | Diagnoses one red Actions run and classifies it `TICKET` / `ENV` / `FLAKE`, keeping the job logs out of the caller |
| `factory-infra-scout`    | Answers questions that need SSH or container output, returning a verdict rather than the dumps                     |

## Scheduling — nothing is scheduled

**Standing policy: the factory runs in the foreground, watched.** No launchd job acts on Linear, git, or CI without someone looking at it. Every job in `config/schedule.yaml` is `enabled: false`, and `deploy/launchd/` is empty.

That's deliberate at this maturity: no skill has eval coverage yet, per-agent identity doesn't exist (OPS-40) so autonomous actions can't be attributed, and the reaper already demonstrated that one wrong predicate reaches 31 tickets. Foreground-first is how each loop earns the right to run unattended.

The cost is real and worth naming: **without the reaper, a crashed agent holds its ticket until a human notices.** Acceptable while every run is watched; the first thing to re-enable when that stops being true.

## The loop

```
Triage ──①triage──▶ ai:agent-ready ──②dispatch──▶ PR ──③merge──▶ Done
                                                             │
                             reaper ◀── crashed claims ◀──────┘
```

**Commands are repo-agnostic verbs; `--repo` supplies the targets.** Adding a repo is `--repo bj29,legalease`, not a second copy of every job. Dispatch is authorized for the repos in `config/repos.yaml` that satisfy `PC-15` (industrialized worktrees) — today `bj29`, `legalease`, `cashsaas` and `wm-home` — because that isolation is what makes concurrent agents safe. Everything else in that file is `report_only`: the janitor can see its orphans, dispatch refuses it.

### Why the cadences are short

Every stage has a **`gate_command`**: one cheap Linear query that exits `0` when there's work and `1` when there isn't. Polling costs a single read; spawning an agent costs budget. So the loop checks every ~5 minutes and acts only when something is waiting.

That's what makes it continuous rather than batch — **follow-up work filed during dispatch gets triaged minutes later, not at the next 6-hour boundary.** When idle, the supervisor prints `idle  dispatch — no dispatch work in bj29` and spawns nothing.

Each gate encodes what "work exists" means for that stage:

| Stage      | Runs when                                                        |
| :--------- | :--------------------------------------------------------------- |
| `triage`   | anything is in `Triage`, or `Todo` without `ai:agent-ready`      |
| `dispatch` | a slot is free **and** a ticket is startable (Owned Paths clear) |
| `merge`    | a PR is actually in review                                       |

The dispatch gate matters most: an agent that wakes to find the cap full has burned a run to learn nothing.

### Models

On a subscription the scarce resource is the **usage window**, and Opus consumes it several times faster than Sonnet. So Opus is spent only where it changes the outcome:

| Stage               | Model                                    | Why                                                                                                             |
| :------------------ | :--------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `factory-triage`    | sonnet                                   | Structured extraction guided by a detailed skill — find the files, write tight globs, write a command that runs |
| `factory-work`      | sonnet **orchestrating opus subagents**  | Coordination is cheap; the code is the product                                                                  |
| `factory-merge`     | **opus**                                 | Review catches what tests don't, and it is the last gate before `develop` auto-deploys                          |
| `factory-audit`     | sonnet                                   | A mechanical checklist against `PC-01`..`PC-20`                                                                 |
| `factory-ux-critic` | sonnet on Claude; parent model elsewhere | Exercises the running app and reports                                                                           |

Claude reads the per-command frontmatter. `agy` is deliberately pinned to `gemini-3.6-flash-medium` in both Factory launch paths because it receives only the command body; `run-agent.sh --model X` overrides that for a one-off session.

The judgement call is triage. A bad spec burns a full dispatch run, so there's a real argument for Opus there; the counter is that `evals/` is the right place to catch spec quality dropping, and a 13-ticket triage pass on Opus is a large bite out of a five-hour window. Start on Sonnet, watch the specs, and move it up if quality slips.

### The warm cache (why worktrees are sometimes slow)

Worktree creation clones `node_modules` and the build cache from a template, which is effectively free on APFS. When the template is current a new worktree is seconds; **when it is stale the clone is worthless and every ticket pays a full compile.** Observed on bj29: a template 99 commits behind turned setup into ~3 minutes per worktree — ~9 minutes of wall clock for three tickets, competing for the same cores, before any agent wrote a line of code.

It is handled automatically. `tick.mjs` checks staleness after claiming and refreshes before building any worktree, but only when it pays:

- **2+ tickets** — warming costs one compile and saves N. From two up it always wins.
- **Single ticket** — skipped. Warming first is a wash or slightly worse, and the ticket would rather start now.
- **Cache fresh** (under 15 commits behind) — skipped.
- `--no-warm` overrides.

The ordering matters: claim → warm → build worktrees. Claiming first means the minutes spent warming can't lose a ticket to another agent, and warming before any `worktree-up` means nothing clones a template that is being rewritten underneath it.

There is also a standalone `warm` stage (every 2h, same staleness gate) so a long-idle machine is ready before the next batch, and `bun orchestrator/warm.mjs --repo bj29` to check by hand.

### Slots and parallelism

Three levels, each with a different job:

1. **Across repos — sequential.** `--repo a,b` runs repos one after another. Parallelism belongs _inside_ a repo; N concurrent sessions across repos contend for the same machine, the same Linear rate budget, and the same daily spend cap.
2. **Within a repo — `max_in_flight` slots** (20 for bj29, in `config/repos.yaml`; 3 is the fallback in `config/policy.yaml` for a repo that names no number of its own). One ticket = one worktree = one agent. The gate reports `slotsFree` and refuses to dispatch at zero.
3. **Between tickets — `Owned Paths`.** Two tickets run together only if their glob sets are disjoint. This is the real safety property; slots just cap resource use.

**Merging is never parallel**, at any level.

### Where repo-specific instructions go

Not in the command. The layering:

| Knowledge                                                                           | Lives in                                                |
| :---------------------------------------------------------------------------------- | :------------------------------------------------------ |
| How to triage / dispatch / merge — universal                                        | `shared/commands/factory-*.md`                          |
| Routing facts: team, base branch, worktree script, verify command, escalation paths | `config/repos.yaml`                                     |
| Stack rules, product decisions, gotchas                                             | the repo's own `AGENTS.md`, `docs/product-decisions.md` |

The agent runs with `cwd` set to the repo, so it reads that repo's `AGENTS.md` naturally — repo specifics arrive as _context_, not as forked commands. For genuinely stage-specific repo guidance, `run-agent.sh --args` appends to the prompt. Resist adding config surface before a real case demands it.

### Where the work happens

| What                  | Where                                                                | Why                                                            |
| :-------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------- |
| The repo itself       | `~/Develop/pets/bj29` (`repos.yaml: path`)                           | Triage reads it; worktrees are created _from_ it               |
| Per-ticket worktrees  | `~/Develop/.worktrees/<repo>/<TICKET>` (`repos.yaml: worktree_root`) | One ticket, one checkout, own branch/ports/database            |
| Factory runtime state | `~/.factory/`                                                        | Session ids, budget ledger, logs, stage journal — never in git |
| This repo             | `~/Develop/factory`                                                  | Control plane only. **No work happens here.**                  |

**Worktrees must not live inside `~/Develop/factory/`.** It's a git repo, so nesting checkouts under it means `git status` noise, a real chance of `git add -A` sweeping an entire worktree into a commit, and the drift check walking trees it has no business in. A control plane that can accidentally commit its own workload is a bad control plane.

A sibling like `~/Develop/factory-workspace/` would work, but it buys nothing and costs a migration: `bin/worktree-up.sh` in each repo already writes to `~/Develop/.worktrees/<repo>/`, [linear.md §6](file:///Users/hdkiller/Develop/hdkiller/docs/orgs/linear.md) documents that path, and fourteen repos' worktrees already live there. Changing it means editing every repo's script plus the docs, and orphaning what's already on disk.

The existing convention already has the properties you'd want: outside any repo, namespaced per repo, dot-prefixed so it stays out of `~/Develop` listings, and pointed at by `worktree_root` in `config/repos.yaml` — so it's a config change, not a code change, if it ever needs to move.

**The one good reason to move it: disk.** This machine is at 96%, and worktrees are the bulk of it. If you relocate them to another volume, change `worktree_root` here _and_ the corresponding path in the repo's `worktree-up.sh` — those two must agree, or the janitor cleans a directory the scripts aren't using.

### Lifecycle

```
triage    main checkout, read-only (edit tools disabled), no worktree
dispatch  bin/worktree-up.sh <TICKET>   → own branch, ports, per-ticket database
merge     bin/worktree-down.sh <TICKET> → drops the database, removes the worktree
janitor   hourly sweep for whatever the above missed
```

The janitor exists because that third step is the one that gets skipped — a crashed run, a hand-merge, or a ticket closed directly in Linear all leave an orphan, and an orphan looks exactly like live work.

### Checkout freshness

Stages read the repo to write file pointers and verification commands, so `run-agent.sh` **always fetches, and fast-forwards only when the tree is clean** — `--ff-only` cannot create a merge commit or lose work, so it is safe unattended. When the tree is dirty it pulls nothing and says so, in the log _and_ in the prompt: the main checkout routinely holds someone's uncommitted work, and silently rebasing under them is a worse failure than a slightly stale spec. A checkout that is behind, ahead, or dirty is announced to the agent as unreliable evidence, with instructions to take code from `origin/<base>` instead. Triage is read-only and needs no worktree; only dispatch creates them.

## Testing the loop

Don't start the supervisor and watch it work fourteen tickets. Walk one ticket through all four stages by hand first, checking Linear between each — a bad spec caught on ticket one costs a few minutes; caught on ticket fourteen it costs a backlog.

**0. Is the machine ready?**

```bash
bun orchestrator/doctor.mjs --repo bj29
bun orchestrator/queue.mjs  --repo bj29
```

**1. Triage exactly one ticket.** Name it explicitly — `--args` is passed straight through to the command, which accepts issue IDs, a count, or `all`:

```bash
runners/run-agent.sh --repo bj29 --command factory-triage --read-only --args "CLNT-616" --budget 2
```

Then read the ticket in Linear. Did it get all five sections? **Are the `Owned Paths` tight** (`app/src/landing/Hero.tsx`, not `app/**`)? Does the `Verification Command` actually run? A spec that looks complete but whose command errors costs a full agent run to discover.

**2. Dispatch that one ticket.**

```bash
runners/run-agent.sh --repo bj29 --command factory-work --args "CLNT-616" --budget 8
```

Watch for the worktree appearing at `~/Develop/.worktrees/bj29/CLNT-616` with its own port and database, verification running clean, and a PR opening against `develop`.

**3. Merge it.**

```bash
runners/run-agent.sh --repo bj29 --command factory-merge --args "CLNT-616" --budget 5
```

**4. Clean up.**

```bash
bun orchestrator/janitor.mjs --repo bj29          # dry
bun orchestrator/janitor.mjs --repo bj29 --apply
```

Only then start the supervisor on a cadence.

### Limits

| Limit              | Where                                                            | Default                                                               |
| :----------------- | :--------------------------------------------------------------- | :-------------------------------------------------------------------- |
| Tickets per tick   | `--args` in `config/schedule.yaml`                               | triage 5, unblock 10                                                  |
| Concurrent tickets | `max_in_flight` in `config/repos.yaml`                           | 20 for bj29, legalease and cashsaas; 3 where a repo names nothing     |
| Spend per run      | `--budget`, else `budget.per_ticket_usd` in `config/policy.yaml` | $15 (`merge_usd`: $40 — a merge pass reviews a backlog, not one diff) |
| Daily spend        | `budget.per_day_usd`                                             | $2000                                                                 |
| Which repos        | `--repo` on each job, else `defaults.repo`                       | `bj29`                                                                |

### Auth and "budget" on a subscription

Runs use the **claude.ai subscription**, not the API. `run-agent.sh` unsets `ANTHROPIC_API_KEY` for the child unless you pass `--use-api` — with it set, every run bills per token _and_ claude.ai connectors (including the Linear MCP) are disabled.

So `--max-budget-usd` is **not money**. Claude still reports `costUSD` per model — a trivial one-turn run shows ~$0.14 notional, mostly cache creation — and the flag caps against that figure. Treat it as a **runaway guard in notional API-equivalent units**: it stops a session going in circles; it does not protect a wallet. `$2` is too tight for a triage run that has to explore a codebase.

The real constraint on a subscription is the **usage window**, and nothing here can see it. That is what per-tick ticket caps are for — they bound how much of a window one tick can consume. If you hit a limit, the answer is smaller `--args`, not a smaller budget number.

**Per-tick caps are what keep a 5-minute loop honest.** Without `--args`, a triage tick would turn all 14 Triage tickets into specs in one unattended run, and you'd review the results after the fact instead of before. Small ticks also fail small.

A good first candidate is tiny, user-facing and unambiguous — the missing `aria-label` (`CLNT-616`) and the broken blog banner image (`CLNT-611`) this walkthrough was written against are both long since `Done`, but that is the shape to look for. **Avoid anything on the never-auto-merge list for a first test**: `CLNT-612` was a unique-index migration, and a ticket like that will correctly escalate rather than complete, which tells you nothing about whether the loop works.

### The supervisor — a scheduler you watch

`orchestrator/run.mjs` runs the same jobs in the foreground: it prints every command before running it, streams output live, and dies with Ctrl-C. When it isn't running, nothing is running.

```bash
bun orchestrator/run.mjs --list                          # what exists
bun orchestrator/run.mjs --only linear-reaper --once     # dry run, one pass
bun orchestrator/run.mjs --only linear-reaper --apply    # for real, on its cadence
bun orchestrator/run.mjs --all --apply
```

Three properties, in order of how much they matter:

1. **Dry by default.** A job declares `dry_command` next to `command`; without `--apply` you get the dry one. The reaper's first real run would have unassigned 31 tickets, so _what would this do_ is the default question.
2. **Explicit selection.** Always `--only` or `--all`. There is no "run whatever is enabled" mode — `enabled:` means _may be installed as an unattended timer_, which is a different decision from _run it now_.
3. **No overlap.** A job still running when its next tick arrives is skipped, not stacked. Two reapers racing is precisely the failure the reaper exists to clean up.

`config/schedule.yaml` stays the single source of truth for cadences — the supervisor and the launchd generator read it through the same `lib/schedule.mjs`, so the watched and unattended modes can't disagree about what the jobs are. When a loop does earn promotion it's one flag and a regeneration, not a plist someone writes by hand at 1am.

```bash
bun deploy/gen.mjs             # render enabled jobs (currently: none)
bun deploy/gen.mjs --install   # copy to ~/Library/LaunchAgents and load
```

### The monitor — a bird's-eye view across repos

`orchestrator/run.mjs` shows you one job's full output; `orchestrator/watch.jsx` shows you the state across every repo at once — queue depth, which tickets are in flight or in review, and a live tail of the selected ticket's session log. The view itself only re-reads what `queue.mjs` and `~/.factory/logs/*.jsonl` already expose, but it also carries keys that **launch** a stage against the selected repo — `t` triage, `d` dispatch the selected ticket, `m` merge, `u` unblock, `x` the reaper (dry first, then a confirmation) — so a keystroke here is the same decision as typing the command.

```bash
bun run watch                  # or: bun orchestrator/watch.jsx
bun orchestrator/watch.jsx --repo bj29
```

`↑`/`↓` selects a ticket, `←`/`→` switches repo, `?` lists every key, `q` quits.

Never hand-edit a generated plist — the next regeneration silently reverts it.

### Measuring the runs — friction and economics

The transcripts under `~/.factory/logs/*.jsonl` are the record of what agents _actually did_, which is why both of these measure rather than ask. An agent that fought a broken tool for ten minutes will not reliably write that down; its transcript shows the same failing call three runs running.

```bash
bun orchestrator/friction.mjs                # what wasted the agents' TIME
bun orchestrator/economics.mjs               # what consumed CONTEXT and the usage window
bun orchestrator/economics.mjs --since 2d --top 20
bun orchestrator/economics.mjs --json        # for a dashboard
bun orchestrator/economics.mjs --roll        # append to the permanent rollup
```

`economics.mjs` exists because a per-run cost figure hides the three things that actually decide how much work fits in a day:

- **Context burn.** A tool result is not paid for once — it stays in the window and is re-sent on every later turn. A 600KB screenshot taken at turn 5 of a 40-turn run costs roughly 35 times its size in cache traffic. The report weights every payload by the turns that followed it, which ranks tools very differently than raw payload does.
- **Cache reuse.** `cache_read` is 0.1x and `cache_write` is 1.25x, so a session that keeps invalidating its prefix costs an order of magnitude more than one that appends. The read:write ratio is the single best health number; below 1:8 something is thrashing.
- **Waste.** Runs that returned nothing still held a dispatch slot and real minutes, and appear in no cost field at all.

**`--roll` is the half that matters over time.** Transcripts are large (350MB for two days) and will eventually be pruned; the rollup at `~/.factory/metrics/runs.jsonl` is the small permanent record — one line per run, append-only, keyed by log filename so re-running is idempotent. It carries the per-run tool mix and failure shapes, so it still answers questions after the transcripts behind it are gone. Run it after each batch and the history accumulates on its own.

> [!IMPORTANT]
> **Every harness streams a different schema, and a parser that only knows Claude fails silently.** codex, agy and pi report no cost field, so summing `total_cost_usd` scored them as `$0 / 0 turns / no result` — indistinguishable from a harness that genuinely did nothing. On 2026-08-04 that hid 109 codex and 50 agy runs (35% of all runs) from `lib/spend.mjs`, and the per-day gate was measuring two thirds of the factory while reporting it as the whole.
>
> So all four schemas normalise into one `Run` record in `lib/transcript.mjs`, the budget gate imports the same parser, and harnesses that report no cost get priced from their token counts and labelled as the estimate they are. Being wrong by a constant factor is fine; being blind to a whole harness is not. Tests: `bun test lib/transcript.test.mjs` — the fixture per harness is the point.

### Browser isolation — one Chrome per agent, from git

Concurrent Claude agents used to share one chrome-devtools-mcp profile: ten tickets dispatched in the same second all raced for one `SingletonLock`, first Chrome won, and everyone else burned turns on `browser is already running` — 95 errors across 26 runs. The fix is structural, not prompt-level, and it lives in this repo:

- **`config/mcp/claude.json`** defines the browser server the factory passes to every Claude spawn via `--mcp-config`: `--isolated` (temp profile per session, auto-cleaned — collisions become impossible), `--headless`, and webp screenshot caps (`--screenshotFormat=webp --screenshotQuality=70 --screenshotMaxWidth=1280`) that shrink the factory's single biggest context cost 4–6x at the source, while an agent that truly needs a pixel-perfect PNG can still request one per-call.
- **Deliberately NOT `--strict-mcp-config`.** Strict mode also drops the claude.ai connectors, and losing the Linear MCP severs the control plane — verified empirically on 2026-08-04: 0 Linear tools under strict, 52 without it. The global chrome-devtools _plugin_ is disabled in `~/.claude/settings.json` instead, so exactly one browser server loads.
- **`orchestrator/chrome-sweep.mjs`** cleans up what the wall-clock cap leaves behind: a killed run's MCP server dies without closing its Chrome, which reparents to launchd and keeps running. The sweep kills only processes that pass three fences (agent profile dir in the command line, browser main process, reparented to PID 1 — a live agent's Chrome still has its MCP server as parent) and clears stale `Singleton*` locks nobody holds. Dry-run by default; `--apply` to act. The one unforgivable failure — killing the human's actual Chrome — has a test per fence.

Verified end to end: two parallel headless sessions each launched their own Chrome and navigated with zero contention. After the next batch, `bun run economics -- --since 1d` should show browser-collision errors at zero and `take_screenshot` payloads down ~4–6x.

## Why `Owned Paths` and not keyword matching

`orchestrator/owned-paths.mjs` decides whether two tickets can run at once by intersecting their `Owned Paths` globs. Every `ai:agent-ready` ticket already carries that section, so the machine-readable answer exists — guessing from title keywords both over-fires ("Fix login button copy" vs "Rewrite auth middleware" share vocabulary but no files) and under-fires ("Onboarding wizard polish" vs "Profile page spacing" share files but no words).

Where the glob algebra is ambiguous it errs toward _collision_: a false positive serializes two tickets, a false negative puts two agents in one file. Tests: `bun test`.

## What stays out of git

Secrets (injected via launchd env or `op run`), worktrees, agent session logs, and the dispatcher's state — all under `~/.factory/`.

## Where things stand

**Automated dispatch is authorized for the four repos in `config/repos.yaml` that ship the worktree lifecycle:** `bj29`, `legalease`, `cashsaas` and `wm-home`. coach-wattz's teardown script landed in [CW-363](https://linear.app/watt-mind/issue/CW-363), so the janitor can safely reclaim its finished worktrees through that repo-owned script, but it stays `report_only` for dispatch — as do watts-mobile, proxies, hdkiller, eslint-config and this repo.

| Stage                       | State                                                                                                |
| :-------------------------- | :--------------------------------------------------------------------------------------------------- |
| `triage`                    | works on Claude **and** agy; claims tickets so they show in Agents In Flight                         |
| `dispatch`                  | `tick.mjs` — one process per ticket, rolling refill, auto-warm                                       |
| `merge`                     | exercised end to end across bj29, legalease and cashsaas; still the one stage that is never parallel |
| `janitor`, `warm`, `reaper` | work; reaper cleaned 50 stale markers                                                                |

**Nothing is scheduled.** All jobs are `enabled: false`; run through `orchestrator/run.mjs`.

The event runtime under `event-runtime/` is a second, deliberately isolated track — intake, planner, watched approval, workers, verification and receipts all run, behind their own control API, CLI and web UI. It touches nothing above and carries its own documents; see Related.

### Immediate next steps

1. **CI is the gate that makes autonomous merging into `develop` safe, and it is unreliable on two repos** — bj29's E2E and smoke checks (F-14, [CLNT-1346](https://linear.app/watt-mind/issue/CLNT-1346)) and legalease's CI (F-13, [CLNT-1345](https://linear.app/watt-mind/issue/CLNT-1345)). Both are filed and still sitting in `Triage`, so the gate protects less than it looks like it does.
2. **F-9** in the [friction log](docs/friction-log.md) is open and document-only — agents still guess at fixed sleeps waiting for a dev server to boot, and the stronger fix is a repo-level `bin/wait-for-dev.sh` rather than another rule.
3. **Warm cache is 26 commits behind.** `cd ~/Develop/pets/bj29 && bin/worktree-warm.sh` once, or let a 2+ ticket dispatch trigger it.
4. **`evals/run.mjs` does not exist** — cases are written, the runner is not. Spec quality has no regression test, which is what would justify keeping triage on sonnet.

## Related

- [`docs/architecture.md`](docs/architecture.md) — **why** it is shaped this way: the decisions, their reasons, and the ones that were wrong first
- [`docs/event-runtime.md`](docs/event-runtime.md) — the event runtime's architecture, with [`event-runtime/README.md`](event-runtime/README.md) for how to run it
- [`docs/event-runtime-workers.md`](docs/event-runtime-workers.md), [`docs/event-runtime-schedules.md`](docs/event-runtime-schedules.md), [`docs/event-runtime-webui.md`](docs/event-runtime-webui.md) — placement and chaining, clock events, and the web control plane
- [`docs/friction-log.md`](docs/friction-log.md) — what has actually wasted agents' time, and what was done about it
- `~/Develop/hdkiller/docs/orgs/linear.md` — the execution protocol (SoT)
- `~/Develop/hdkiller/docs/guides/project-conventions.md` — the quality baseline and `PC-*` audit
- `~/Develop/hdkiller/docs/servers/workstations/hdkiller-macbook-pro.md` — the host these jobs run on

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.

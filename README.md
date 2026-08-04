# factory

Runs on **bun**. The control layer of the Watt Mind agent factory: shared commands, agents, and skills distributed to every repo as a Claude Code plugin, plus the scheduler and dispatcher that run the standing loops.

**Linear is the control plane, GitHub is the source of truth, CI is the reward signal.** Nothing merges because an agent said it was done — it merges because the tests passed and a reviewer (agent or human) approved.

## Layout

**`shared/` is the source of truth. Everything in `plugins/` and `dist/` is generated — never edit it.**

```
shared/                           harness-neutral content, the only place to edit
  floor.md                        the non-negotiables (goes into every AGENTS.md)
  commands/                       factory-work, factory-merge, factory-triage, factory-audit
  skills/                         ticket-spec (SKILL.md — a format all harnesses share)
  agents/                         ux-critic (Claude-only: needs its Task tool)
build/emit.mjs                    shared/ -> per-harness packaging; --check guards drift
plugins/core/                     GENERATED — the Claude Code plugin
dist/{codex,gemini,cursor}/       GENERATED — the other harnesses
dist/AGENTS.floor.md              GENERATED — paste/sync into each repo's AGENTS.md
orchestrator/                     dispatch logic (owned-paths collision, tick)
orchestrator/watch.jsx            read-only TUI: queue + in-flight tickets + live log tail
config/schedule.yaml              ONE source of truth for cadences
config/policy.yaml                budgets, concurrency, escalation
deploy/gen.mjs                    schedule.yaml -> launchd plists
evals/                            prompt regression tests
```

## Multi-harness

The **content** is portable; only the **packaging** isn't. `SKILL.md` is a format Claude, Codex, and Gemini all consume, and command bodies are just markdown.

| Harness | Context | Skills | Commands |
| :--- | :--- | :--- | :--- |
| Claude Code | `CLAUDE.md` → `AGENTS.md` | plugin `skills/` | plugin `commands/` |
| Codex | `AGENTS.md` (native) | `~/.codex/skills/` | `~/.codex/prompts/` |
| Pi | `AGENTS.md` (native) | `dist/pi/skills/` | `dist/pi/prompts/` |
| Gemini CLI | `GEMINI.md` → `AGENTS.md` | `~/.gemini/skills/` | — |
| Antigravity | shares `~/.gemini/` | via Gemini | — |
| Cursor | `.cursor/rules/` | — | `~/.cursor/commands/` |

```bash
bun build/emit.mjs           # regenerate everything
bun build/emit.mjs --check   # CI: fail if the tree drifted from shared/
bun build/emit.mjs --link    # symlink this machine's harnesses at shared/
```

`--link` symlinks rather than copies, so a `git pull` updates every harness at once and there is no copy to go stale. It refuses to overwrite a real file.

> [!IMPORTANT]
> **The plugin is a convenience layer, not the safety floor.** It reaches Claude Code only, and a cloud sandbox without GitHub auth for this private repo gets nothing — failing closed without knowing it.
>
> So the non-negotiables live in `shared/floor.md` and are committed into each repo's **`AGENTS.md`**, which every harness reads and which travels with the checkout.

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

| Command | Does |
| :--- | :--- |
| `/factory-work` | Claims agent-ready tickets, dispatches them rolling (not batched), lands the PRs |
| `/factory-merge` | Reviews open PRs, fixes what's mechanical, merges what qualifies |
| `/factory-triage` | Turns `Triage` tickets into `ai:agent-ready` ones |
| `/factory-audit` | Grades a repo against project-conventions `PC-01`..`PC-20`, files the gaps |

## Scheduling — nothing is scheduled

**Standing policy: the factory runs in the foreground, watched.** No launchd job acts on Linear, git, or CI without someone looking at it. Every job in `config/schedule.yaml` is `enabled: false`, and `deploy/launchd/` is empty.

That's deliberate at this maturity: no skill has eval coverage yet, the dispatcher isn't built, per-agent identity doesn't exist (OPS-40) so autonomous actions can't be attributed, and the reaper already demonstrated that one wrong predicate reaches 31 tickets. Foreground-first is how each loop earns the right to run unattended.

The cost is real and worth naming: **without the reaper, a crashed agent holds its ticket until a human notices.** Acceptable while every run is watched; the first thing to re-enable when that stops being true.

## The loop

```
Triage ──①triage──▶ ai:agent-ready ──②dispatch──▶ PR ──③merge──▶ Done
                                                             │
                             reaper ◀── crashed claims ◀──────┘
```

**Commands are repo-agnostic verbs; `--repo` supplies the targets.** Adding a repo is `--repo bj29,legalease`, not a second copy of every job. Only `bj29` is targeted today — it's the one repo satisfying `PC-15` (industrialized worktrees), which is what makes concurrent agents safe.

### Why the cadences are short

Every stage has a **`gate_command`**: one cheap Linear query that exits `0` when there's work and `1` when there isn't. Polling costs a single read; spawning an agent costs budget. So the loop checks every ~5 minutes and acts only when something is waiting.

That's what makes it continuous rather than batch — **follow-up work filed during dispatch gets triaged minutes later, not at the next 6-hour boundary.** When idle, the supervisor prints `idle  dispatch — no dispatch work in bj29` and spawns nothing.

Each gate encodes what "work exists" means for that stage:

| Stage | Runs when |
| :--- | :--- |
| `triage` | anything is in `Triage`, or `Todo` without `ai:agent-ready` |
| `dispatch` | a slot is free **and** a ticket is startable (Owned Paths clear) |
| `merge` | a PR is actually in review |

The dispatch gate matters most: an agent that wakes to find the cap full has burned a run to learn nothing.

### Models

On a subscription the scarce resource is the **usage window**, and Opus consumes it several times faster than Sonnet. So Opus is spent only where it changes the outcome:

| Stage | Model | Why |
| :--- | :--- | :--- |
| `factory-triage` | sonnet | Structured extraction guided by a detailed skill — find the files, write tight globs, write a command that runs |
| `factory-work` | sonnet **orchestrating opus subagents** | Coordination is cheap; the code is the product |
| `factory-merge` | **opus** | Review catches what tests don't, and it is the last gate before `develop` auto-deploys |
| `factory-audit` | sonnet | A mechanical checklist against `PC-01`..`PC-20` |
| `ux-critic` | sonnet | Exercises the running app and reports |

Set per command in its frontmatter — that's the knob to turn. `run-agent.sh --model X` overrides the whole session and is the blunt instrument.

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

1. **Across repos — sequential.** `--repo a,b` runs repos one after another. Parallelism belongs *inside* a repo; N concurrent sessions across repos contend for the same machine, the same Linear rate budget, and the same daily spend cap.
2. **Within a repo — `max_in_flight` slots** (3 for bj29, in `config/repos.yaml`). One ticket = one worktree = one agent. The gate reports `slotsFree` and refuses to dispatch at zero.
3. **Between tickets — `Owned Paths`.** Two tickets run together only if their glob sets are disjoint. This is the real safety property; slots just cap resource use.

**Merging is never parallel**, at any level.

### Where repo-specific instructions go

Not in the command. The layering:

| Knowledge | Lives in |
| :--- | :--- |
| How to triage / dispatch / merge — universal | `shared/commands/factory-*.md` |
| Routing facts: team, base branch, worktree script, verify command, escalation paths | `config/repos.yaml` |
| Stack rules, product decisions, gotchas | the repo's own `AGENTS.md`, `docs/product-decisions.md` |

The agent runs with `cwd` set to the repo, so it reads that repo's `AGENTS.md` naturally — repo specifics arrive as *context*, not as forked commands. For genuinely stage-specific repo guidance, `run-agent.sh --args` appends to the prompt. Resist adding config surface before a real case demands it.

### Where the work happens

| What | Where | Why |
| :--- | :--- | :--- |
| The repo itself | `~/Develop/pets/bj29` (`repos.yaml: path`) | Triage reads it; worktrees are created *from* it |
| Per-ticket worktrees | `~/Develop/.worktrees/<repo>/<TICKET>` (`repos.yaml: worktree_root`) | One ticket, one checkout, own branch/ports/database |
| Factory runtime state | `~/.factory/` | Session ids, budget ledger, logs — never in git |
| This repo | `~/Develop/factory` | Control plane only. **No work happens here.** |

**Worktrees must not live inside `~/Develop/factory/`.** It's a git repo, so nesting checkouts under it means `git status` noise, a real chance of `git add -A` sweeping an entire worktree into a commit, and the drift check walking trees it has no business in. A control plane that can accidentally commit its own workload is a bad control plane.

A sibling like `~/Develop/factory-workspace/` would work, but it buys nothing and costs a migration: `bin/worktree-up.sh` in each repo already writes to `~/Develop/.worktrees/<repo>/`, [linear.md §6](file:///Users/hdkiller/Develop/hdkiller/docs/orgs/linear.md) documents that path, and 21 existing bj29 worktrees live there. Changing it means editing every repo's script plus the docs, and orphaning what's already on disk.

The existing convention already has the properties you'd want: outside any repo, namespaced per repo, dot-prefixed so it stays out of `~/Develop` listings, and pointed at by `worktree_root` in `config/repos.yaml` — so it's a config change, not a code change, if it ever needs to move.

**The one good reason to move it: disk.** This machine is at 89%, and worktrees are the bulk of it. If you relocate them to another volume, change `worktree_root` here *and* the corresponding path in the repo's `worktree-up.sh` — those two must agree, or the janitor cleans a directory the scripts aren't using.

### Lifecycle

```
triage    main checkout, read-only (edit tools disabled), no worktree
dispatch  bin/worktree-up.sh <TICKET>   → own branch, ports, per-ticket database
merge     bin/worktree-down.sh <TICKET> → drops the database, removes the worktree
janitor   hourly sweep for whatever the above missed
```

The janitor exists because that third step is the one that gets skipped — a crashed run, a hand-merge, or a ticket closed directly in Linear all leave an orphan, and an orphan looks exactly like live work.

### Checkout freshness

Stages read the repo to write file pointers and verification commands, so `run-agent.sh` **fetches and reports** — branch, commits behind, uncommitted files — but **never pulls**. The main checkout routinely holds someone's uncommitted work, and silently rebasing under them is a worse failure than a slightly stale spec. Triage is read-only and needs no worktree; only dispatch creates them.

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

| Limit | Where | Default |
| :--- | :--- | :--- |
| Tickets per tick | `--args` in `config/schedule.yaml` | triage 3, dispatch 2 |
| Concurrent tickets | `max_in_flight` in `config/repos.yaml` | 3 |
| Spend per run | `--budget`, else `budget.per_ticket_usd` in `config/policy.yaml` | $5 |
| Daily spend | `budget.per_day_usd` | $1000 |
| Which repos | `--repo` on each job | `bj29` only |

### Auth and "budget" on a subscription

Runs use the **claude.ai subscription**, not the API. `run-agent.sh` unsets `ANTHROPIC_API_KEY` for the child unless you pass `--use-api` — with it set, every run bills per token *and* claude.ai connectors (including the Linear MCP) are disabled.

So `--max-budget-usd` is **not money**. Claude still reports `costUSD` per model — a trivial one-turn run shows ~$0.14 notional, mostly cache creation — and the flag caps against that figure. Treat it as a **runaway guard in notional API-equivalent units**: it stops a session going in circles; it does not protect a wallet. `$2` is too tight for a triage run that has to explore a codebase.

The real constraint on a subscription is the **usage window**, and nothing here can see it. That is what per-tick ticket caps are for — they bound how much of a window one tick can consume. If you hit a limit, the answer is smaller `--args`, not a smaller budget number.

**Per-tick caps are what keep a 5-minute loop honest.** Without `--args`, a triage tick would turn all 14 Triage tickets into specs in one unattended run, and you'd review the results after the fact instead of before. Small ticks also fail small.

Good first candidates in BJ29 today: `CLNT-616` (missing aria-label — tiny, user-facing, clear acceptance criteria) or `CLNT-611` (broken blog banner image). **Avoid `CLNT-612` for a first test** — it's a unique-index migration, which is on the never-auto-merge list and will correctly escalate rather than complete.

### The supervisor — a scheduler you watch

`orchestrator/run.mjs` runs the same jobs in the foreground: it prints every command before running it, streams output live, and dies with Ctrl-C. When it isn't running, nothing is running.

```bash
bun orchestrator/run.mjs --list                          # what exists
bun orchestrator/run.mjs --only linear-reaper --once     # dry run, one pass
bun orchestrator/run.mjs --only linear-reaper --apply    # for real, on its cadence
bun orchestrator/run.mjs --all --apply
```

Three properties, in order of how much they matter:

1. **Dry by default.** A job declares `dry_command` next to `command`; without `--apply` you get the dry one. The reaper's first real run would have unassigned 31 tickets, so *what would this do* is the default question.
2. **Explicit selection.** Always `--only` or `--all`. There is no "run whatever is enabled" mode — `enabled:` means *may be installed as an unattended timer*, which is a different decision from *run it now*.
3. **No overlap.** A job still running when its next tick arrives is skipped, not stacked. Two reapers racing is precisely the failure the reaper exists to clean up.

`config/schedule.yaml` stays the single source of truth for cadences — the supervisor and the launchd generator read it through the same `lib/schedule.mjs`, so the watched and unattended modes can't disagree about what the jobs are. When a loop does earn promotion it's one flag and a regeneration, not a plist someone writes by hand at 1am.

```bash
bun deploy/gen.mjs             # render enabled jobs (currently: none)
bun deploy/gen.mjs --install   # copy to ~/Library/LaunchAgents and load
```

### The monitor — a bird's-eye view across repos

`orchestrator/run.mjs` shows you one job's full output; `orchestrator/watch.jsx` shows you the state across every repo at once — queue depth, which tickets are in flight or in review, and a live tail of the selected ticket's session log. Read-only: it never spawns an agent or writes anything, it only re-reads what `queue.mjs` and `~/.factory/logs/*.jsonl` already expose.

```bash
bun run watch                  # or: bun orchestrator/watch.jsx
bun orchestrator/watch.jsx --repo bj29
```

`↑`/`↓` selects a ticket, `←`/`→` switches repo, `q` quits.

Never hand-edit a generated plist — the next regeneration silently reverts it.

### Measuring the runs — friction and economics

The transcripts under `~/.factory/logs/*.jsonl` are the record of what agents *actually did*, which is why both of these measure rather than ask. An agent that fought a broken tool for ten minutes will not reliably write that down; its transcript shows the same failing call three runs running.

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

## Why `Owned Paths` and not keyword matching

`orchestrator/owned-paths.mjs` decides whether two tickets can run at once by intersecting their `Owned Paths` globs. Every `ai:agent-ready` ticket already carries that section, so the machine-readable answer exists — guessing from title keywords both over-fires ("Fix login button copy" vs "Rewrite auth middleware" share vocabulary but no files) and under-fires ("Onboarding wizard polish" vs "Profile page spacing" share files but no words).

Where the glob algebra is ambiguous it errs toward *collision*: a false positive serializes two tickets, a false negative puts two agents in one file. Tests: `bun test`.

## What stays out of git

Secrets (injected via launchd env or `op run`), worktrees, agent session logs, and the dispatcher's state — all under `~/.factory/`.

## Where things stand (2026-08-03)

**Wired and working for `bj29` only.** coach-wattz, legalease and cashsaas are `report_only` — the janitor sees their orphaned worktrees but dispatch refuses them until [CW-363](https://linear.app/watt-mind/issue/CW-363) and [CLNT-609](https://linear.app/watt-mind/issue/CLNT-609) land worktree scripts.

| Stage | State |
| :--- | :--- |
| `triage` | works on Claude **and** agy; claims tickets so they show in Agents In Flight |
| `dispatch` | `tick.mjs` — one process per ticket, rolling refill, auto-warm |
| `merge` | untested end to end by the factory; PRs have been merged from interactive sessions |
| `janitor`, `warm`, `reaper` | work; reaper cleaned 50 stale markers |

**Nothing is scheduled.** All jobs are `enabled: false`; run through `orchestrator/run.mjs`.

### Immediate next steps

1. **Merge stage is the untested link** — PRs #164/#165 have been sitting in review. `runners/run-agent.sh --repo bj29 --command factory-merge` is the next thing to exercise.
2. **F-1, F-2, F-3** in the [friction log](docs/friction-log.md) are open and small. F-2 (`--delete-branch` fails while the worktree exists) will bite on every worktree merge.
3. **e2e is failing on every PR** (CLNT-620, CLNT-622) — that is the gate that makes autonomous merging into `develop` safe, so it is currently not protecting anything.
4. **Warm cache is ~100 commits behind.** `cd ~/Develop/pets/bj29 && bin/worktree-warm.sh` once, or let a 2+ ticket dispatch trigger it.
5. **`evals/run.mjs` does not exist** — cases are written, the runner is not. Spec quality has no regression test, which is what would justify keeping triage on sonnet.

## Related

- [`docs/architecture.md`](docs/architecture.md) — **why** it is shaped this way: the decisions, their reasons, and the ones that were wrong first
- `~/Develop/hdkiller/docs/orgs/linear.md` — the execution protocol (SoT)
- `~/Develop/hdkiller/docs/guides/project-conventions.md` — the quality baseline and `PC-*` audit
- `~/Develop/hdkiller/docs/servers/workstations/hdkiller-macbook-pro.md` — the host these jobs run on

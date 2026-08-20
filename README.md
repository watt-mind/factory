# factory

**The factory that builds software — and itself.**

A runtime for self-improving agentic loops. Code is the first product line.

Factory orchestrates coding agents (Claude Code, Codex, Gemini / Antigravity,
Cursor, Pi). It does not compete with them. The tracker is the control plane,
GitHub is the source of truth, and CI is the reward signal. Nothing merges
because an agent said it was done — it merges because the tests passed and a
reviewer (agent or human) approved.

Runs on **[bun](https://bun.sh/)**. Licensed [Apache 2.0](LICENSE).

## Why

Watt Mind is an AI-native company: agents do the work from day one, and the
factory is how that work is admitted, verified, and merged. The wedge is an
unattended software factory. The same runtime already hosts other loops (infra
ops, editorial). Software is first because the verification story is strongest
there — tests, types, CI, a diff, a PR — not because the runtime is only for
code.

The factory holds no product state of its own. Tickets live in the tracker,
truth lives in git, and a restart loses nothing. Agents are ephemeral workers;
the loop is the standing process.

Read the thesis and the primitives:

- [docs/thesis.md](docs/thesis.md) — wedge-first positioning, and why the
  runtime is more general than a software factory
- [docs/model.md](docs/model.md) — factory primitives in this repository's own
  vocabulary
- [docs/architecture.md](docs/architecture.md) — why it is shaped this way,
  including the choices that were wrong first
- [docs/quickstart.md](docs/quickstart.md) — 15-minute `factory demo`

## Harness support

The **content** is portable; only the **packaging** isn't. `SKILL.md` is a
shared workflow format, command bodies are Markdown, and each harness gets its
native agent manifest.

| Harness     | Context                   | Skills              | Commands                    | Agents                |
| :---------- | :------------------------ | :------------------ | :-------------------------- | :-------------------- |
| Claude Code | `CLAUDE.md` → `AGENTS.md` | plugin `skills/`    | plugin `commands/`          | plugin `agents/`      |
| Codex       | `AGENTS.md` (native)      | `~/.agents/skills/` | — (use `@factory-*` skills) | `~/.codex/agents/`    |
| Gemini CLI  | `GEMINI.md` → `AGENTS.md` | `~/.gemini/skills/` | —                           | `~/.gemini/agents/`   |
| Antigravity | shares `~/.gemini/`       | via Gemini          | —                           | via Gemini            |
| Cursor      | `.cursor/rules/`          | —                   | `~/.cursor/commands/`       | `~/.cursor/agents/`   |
| Pi          | `AGENTS.md` (native)      | `dist/pi/skills/`   | `dist/pi/prompts/`          | `~/.pi/agent/agents/` |

```bash
bun build/emit.mjs           # regenerate plugins/ and dist/
bun build/emit.mjs --check   # CI: fail if the tree drifted from shared/
bun build/emit.mjs --link    # symlink this machine's harnesses at shared/
bun run link-repos           # symlink commands into every configured repo
```

`--link` / `--link-repos` symlink rather than copy, so a `git pull` updates
every harness at once and there is no copy to go stale. Both refuse to
overwrite a real file.

> [!IMPORTANT]
> **The plugin is a convenience layer, not the safety floor.** It reaches
> Claude Code only. The non-negotiables live in `shared/floor.md` and are
> committed into each repo's **`AGENTS.md`**, which every harness reads and
> which travels with the checkout.

**`shared/` is the source of truth. Everything in `plugins/` and `dist/` is
generated — never edit it.** Four generated copies are only safer than four
hand-written ones if CI proves they still match their source. If `--check`
fails, move the rule into `shared/`; never edit the generated file.

## Control plane

v1 ships **Linear**, honestly. The interface is a `ControlPlane` adapter so
the loops do not hard-wire one tracker. GitHub Issues is the first roadmap
adapter — it makes a zero-third-party-account quickstart possible.

| Adapter       | Status       | Role                                                                              |
| :------------ | :----------- | :-------------------------------------------------------------------------------- |
| Linear        | v1, shipping | Claim, labels, states, comments. One authority so two agents cannot both own work |
| GitHub Issues | roadmap      | Same adapter; no third-party tracker account                                      |
| Memory        | demo / tests | In-process adapter for `factory demo` and offline runs                            |

GitHub stays the forge: the PR is the artifact, the branch is the work, CI is
the reward signal. See [docs/model.md](docs/model.md) and
[docs/architecture.md](docs/architecture.md).

## Quickstart

See [docs/quickstart.md](docs/quickstart.md) for the 15-minute path:
`factory demo` runs a ticket end-to-end against a bundled demo repo, with the
in-memory control plane and no third-party credentials.

![A recorded `factory demo` run: a ticket is claimed, implemented, verified, and merged.](docs/media/demo.gif)

The GIF is the recorded demo; the command is the source of truth. Contributor
setup (clone, `bun install`, checks) is in [CONTRIBUTING.md](CONTRIBUTING.md).
First-time harness links and the event-runtime daemon are in
[SETUP.md](SETUP.md).

## Fork your factory

Fork an instance, not the kernel. The
[`factory-starter`](templates/starter/) scaffold keeps your repository routing,
local policy, schedules, and optional packs in a repository that pins Factory
as a dependency. That lets your organization improve its own factory without
diverging from the shared runtime.

Read [docs/instances.md](docs/instances.md) for the kernel/instance boundary,
an intentional upgrade path, and how to send reusable kernel improvements
upstream as proposals and pull requests.

## The loop

```
Triage ──①triage──▶ ai:agent-ready ──②dispatch──▶ PR ──③merge──▶ Done
                                                             │
                             reaper ◀── crashed claims ◀──────┘
```

One ticket, one worktree, one agent process. Two tickets run together only
when their `Owned Paths` globs are disjoint. Dispatch is rolling, not batched:
when a ticket finishes, its slot refills immediately.

**Commands are repo-agnostic verbs; `--repo` supplies the targets.** Adding a
repo is configuration, not a second copy of every job. A repo without
industrialized worktree scripts (`bin/worktree-up.sh` / `worktree-down.sh`)
has a safe concurrency of one agent; the dispatcher refuses it rather than
inventing ports for tooling that does not exist.

## Layout

```
shared/                           harness-neutral content, the only place to edit
  floor.md                        the non-negotiables (goes into every AGENTS.md)
  commands/                       the /factory-* commands
  skills/                         ticket-spec (SKILL.md — a format all harnesses share)
  agents/                         factory-{ux-critic,ci-doctor,infra-scout,merge-reviewer}
build/emit.mjs                    shared/ -> per-harness packaging; --check guards drift
plugins/core/                     GENERATED — the Claude Code plugin
dist/{codex,gemini,cursor,pi}/    GENERATED — the other harnesses
orchestrator/                     dispatch logic (owned-paths collision, tick)
event-runtime/                    event-driven sidecar — intake, planner, worker, receipt
runners/run-agent.sh              one harness session against one repo
bin/factory                       the cwd-independent CLI
bin/worktree-{up,down}.sh         this repo's own worktree lifecycle
lib/, tools/                      helpers: transcripts, spend, schedule, Linear
config/repos.yaml                 per-repo routing: team, base, worktree scripts, verify
config/schedule.yaml              cadences
config/policy.yaml                budgets, concurrency, escalation
ee/                               reserved open-core seam (empty of product code)
```

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

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change, especially
one that may cross this boundary.

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

Prefixed `factory-` so they're identifiable as ours and never collide with a
repo-local or built-in command of the same name.

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

```bash
factory status
factory status --repo <name>
factory status --json
```

Read-only: which repository and branch you are in, whether the checkout is
clean, fetched remote refs, deployment freshness, live tracker counts, and the
single recommended next action.

## Agents

Agents are isolated specialist contexts, not workflow entry points.

| Agent                    | Does                                                                                                               |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `factory-ux-critic`      | Exercises a materially changed user journey and returns a read-only `SHIP` / `FIX-FIRST` critique                  |
| `factory-merge-reviewer` | Reviews one PR cold and returns `MERGE` / `FIX` / `ESCALATE`, so the diff never enters the merge session's context |
| `factory-ci-doctor`      | Diagnoses one red Actions run and classifies it `TICKET` / `ENV` / `FLAKE`, keeping the job logs out of the caller |
| `factory-infra-scout`    | Answers questions that need SSH or container output, returning a verdict rather than the dumps                     |

## Docs

| Doc                                                | What it is                                                    |
| :------------------------------------------------- | :------------------------------------------------------------ |
| [docs/thesis.md](docs/thesis.md)                   | Positioning: wedge-first unattended software factory          |
| [docs/model.md](docs/model.md)                     | Public primitives in this repository's vocabulary             |
| [docs/quickstart.md](docs/quickstart.md)           | 15-minute `factory demo`                                      |
| [docs/architecture.md](docs/architecture.md)       | Why the factory is shaped this way                            |
| [docs/orchestrator.md](docs/orchestrator.md)       | Master orchestrator guide and operating loops                 |
| [SETUP.md](SETUP.md)                               | First-time setup, harness links, event-runtime daemon         |
| [CONTRIBUTING.md](CONTRIBUTING.md)                 | Setup, tests, commit conventions, CLA                         |
| [SECURITY.md](SECURITY.md)                         | Vulnerability reporting and the autonomous-agent threat model |
| [ee/README.md](ee/README.md)                       | Open-core / enterprise seam                                   |
| [event-runtime/README.md](event-runtime/README.md) | How to run the event-runtime sidecar                          |

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
attribution information.

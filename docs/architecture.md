# Factory architecture

What the factory is, how a ticket moves through it, and **why each choice was made** — including the ones that were wrong first. The README says how to run it; this says why it is shaped this way.

Read this before changing the dispatcher, the claim protocol, or anything touching worktrees.

---

## 1. The model

```
        ┌──────────── Linear: the control plane ────────────┐
        │  Triage → Todo+agent-ready → In Progress → In Review → Done
        └───────────────────────────────────────────────────┘
             ▲            ▲                ▲            ▲
          triage      dispatch          merge        janitor
        (sonnet)   (1 proc/ticket)     (opus)      (worktrees)
                          │
                    reaper (crashed claims)
```

- **Linear holds state.** Not the filesystem, not a queue file. Two agents cannot disagree about who owns a ticket if there is one authority.
- **GitHub holds truth.** The PR is the artifact; the branch is the work.
- **CI is the reward signal.** Nothing merges because an agent said it was done.
- **The factory holds no state of its own.** `tick.mjs` re-reads Linear on every decision. Restarting it loses nothing.

---

## 2. Decisions and their reasons

### 2.1 One OS process per ticket — not subagents

**Chose:** `tick.mjs` spawns one `claude -p` per ticket.
**Over:** one session claiming several tickets and working them through subagents.

Subagents share a process, a context window and a budget. One crash takes every ticket with it, one runaway starves its siblings, and three tickets interleave into a single untraceable stream. Per-process gives each ticket its own log, budget, session id, and failure domain: a stuck ticket can be killed alone, a failed one resumed alone.

**Cost:** the dispatcher must own claiming, slots and worktrees itself, in code, rather than instructing an agent to do it in prose. That is a feature — it is the part that must be deterministic.

### 2.2 Rolling, never batched

When a ticket finishes, its slot refills immediately. `Promise.all` on a batch was the first implementation and it was wrong: one 40-minute ticket idles two agents for 40 minutes, and batching is the dominant throughput loss in practice.

The queue is re-read on **every** refill, so a ticket that became agent-ready _during_ the run — triage promoting one, or a finishing agent filing follow-up work — is picked up without waiting for the next supervisor tick.

### 2.3 `Owned Paths` is the concurrency key

Two tickets may run together only if their `Owned Paths` glob sets are disjoint. Every `ai:agent-ready` ticket carries that section, so the machine-readable answer already exists.

**Rejected:** inferring collisions from ticket titles. It both over-fires ("Fix login button copy" vs "Rewrite auth middleware" share vocabulary, touch nothing in common) and under-fires ("Onboarding wizard polish" vs "Profile page spacing" share files, share no words).

Where the glob algebra is ambiguous, `globsOverlap` errs toward **collision**: a false positive serializes two tickets, a false negative puts two agents in one file.

> **This bit us.** The parser originally read only bullet lists. A correctly specced CLNT-616 wrote its paths in a fenced code block, so it parsed as empty, and dispatch refused it as undispatchable — which looked like a triage failure and wasn't. It now accepts bullets, fenced blocks and indented code, mixed with prose. If `READY` is high but nothing is startable, suspect this first.

### 2.4 Claim before building the worktree

Order is **claim → warm → worktree → spawn**.

`worktree-up.sh` takes minutes, and a warm refresh takes minutes more. A ticket left unclaimed for that long is one another agent may take. Holding a claim for a few minutes is harmless — the reaper's threshold is 45.

The Linear read-back after claiming is the only concurrency control that exists; Linear has no compare-and-swap.

### 2.5 Worktrees are industrialized, never hand-rolled

Git isolates branches. It does not isolate **ports** or **databases** — and `migrate-dev` against a shared dev database destroys another agent's work silently, cross-agent. Each repo owns `worktree-{up,down,warm}.sh` meeting `W-1`…`W-12` in [project-conventions §3E](file:///Users/hdkiller/Develop/hdkiller/docs/guides/project-conventions.md).

A repo without those scripts has a safe concurrency of **one agent**, whatever the dispatcher believes. Such repos are marked `report_only: true` in `config/repos.yaml`: the janitor can see their orphans, dispatch refuses them.

### 2.6 The warm cache, and why it is automatic

Worktree creation clones `node_modules` and the build cache from a template (APFS clonefile — effectively free). Current template: seconds. **Stale template: the clone is worthless and every ticket pays a full compile.**

Measured on bj29 with the template 99 commits behind: ~3 minutes per worktree, ~9 minutes of wall clock for three tickets, competing for the same cores, before any agent wrote a line of code.

So `tick.mjs` decides, because the arithmetic is mechanical — warming costs one compile, skipping costs N:

|                                |                                                      |
| :----------------------------- | :--------------------------------------------------- |
| 2+ tickets, ≥15 commits behind | refresh once, then build                             |
| 1 ticket                       | skip — a wash, and the ticket would rather start now |
| fresh                          | skip                                                 |

Warming happens **before any `worktree-up`**, so nothing clones a template being rewritten underneath it. (`worktree-up.sh` would detect the mismatch and rebuild from empty, so that race is a slowness bug rather than corruption — but slowness is what we are removing.)

### 2.6b Freshness: who actually needs current code

Not everyone, which is why there is no global "pull often" rule.

| Consumer             | Source                                                     | Stale risk                                                   |
| :------------------- | :--------------------------------------------------------- | :----------------------------------------------------------- |
| **Ticket worktrees** | `worktree-up.sh` fetches and branches from `origin/<base>` | **None** — every ticket starts from current remote           |
| **Warm cache**       | `worktree-warm.sh` resets to `origin/<base>`               | Handled by the staleness gate (§2.6)                         |
| **Merge stage**      | operates on PR branches via `gh`                           | Per-PR; rebases against the base itself                      |
| **Triage**           | reads the **main checkout working tree**                   | **Real** — stale files mean file pointers to code that moved |

So dispatch was never affected by a main checkout 66 commits behind; only triage was.

**Policy: always fetch; fast-forward only when the tree is clean.** `git pull --ff-only` cannot create a merge commit or lose work, so it is safe unattended. When the tree is dirty the runner does nothing and says so — the main checkout routinely holds uncommitted human work, and touching it to save a slightly stale spec is a far worse trade (see R-2 in the friction log).

Nothing needs the local branch updated after a merge, either: the next `worktree-up` fetches `origin/<base>` regardless. Updating the local checkout is a convenience for the human, not a correctness requirement for the factory.

### 2.6c Timeouts: the harness's and the factory's are different jobs

A harness timeout produces a **clean error**; a factory timeout **guarantees the slot frees**. Both are needed, and raising one without the other is a trap.

agy's print mode defaults to 5 minutes. A real triage run exceeded it at 231s — 68 tool calls in, mid-sentence — and reported `status: ERROR, "timeout waiting for response"`. The work was actually done; only the closing summary was lost.

The obvious fix (raise it) makes the _stuck_ case worse: a wedged run then holds its concurrency slot for the new, longer timeout. So:

| Layer                       | Value                         | Purpose                                  |
| :-------------------------- | :---------------------------- | :--------------------------------------- |
| Harness (`--print-timeout`) | `max_run_minutes - 2`         | errors cleanly, with a usable transcript |
| Factory (`timeout -k 30s`)  | `limits.max_run_minutes` (45) | backstop — TERM, then KILL 30s later     |

Enforced in both `run-agent.sh` and `tick.mjs`, so a per-ticket process cannot hold a slot indefinitely. If `timeout(1)` is missing the runner says so rather than pretending there is a cap.

### 2.7 Foreground first — nothing is scheduled

Every job in `config/schedule.yaml` is `enabled: false` and `deploy/launchd/` is empty. The factory runs under `orchestrator/run.mjs`, watched, and when it is not running nothing is running.

This is a maturity judgement, not a permanent design: no skill has eval coverage, agents have no per-agent Linear identity ([OPS-40](https://linear.app/watt-mind/issue/OPS-40)), and the reaper demonstrated on its first run that one wrong predicate reaches 31 tickets. Each loop earns its timer by being watched first.

**The cost, stated rather than hidden:** without the reaper on a timer, a crashed agent holds its ticket until a human notices.

### 2.8 Gates: poll often, act rarely

Every stage has a `gate_command` — one cheap Linear query, exit 0 for work and 1 for idle. Polling costs a read; spawning an agent costs a bite of the usage window. That is what lets cadences be 5 minutes instead of hours, which is what makes the loop feel continuous.

The dispatch gate matters most: an agent that wakes to find the cap full has burned a run to learn nothing.

### 2.9 Auth is the subscription; "budget" is not money

`run-agent.sh` and `tick.mjs` unset `ANTHROPIC_API_KEY` for the child. With it set, runs bill the API per token instead of drawing on the subscription, **and** claude.ai connectors — including the Linear MCP — are silently disabled.

`--max-budget-usd` still works: `costUSD` is reported on subscription auth (a trivial one-turn run is ~$0.14 notional, mostly cache creation). Read it as a **runaway guard in notional units**, not a wallet.

The real constraint is the **usage window**, which nothing here can observe. Per-tick ticket caps (`--args`, `--max`) are the knob that bounds how much of a window one tick consumes. Hitting a limit means smaller caps, not a smaller budget number.

### 2.10 Models: opus only where it changes the outcome

| Stage                   | Model                                    | Why                                                                                                                                                                                                                                                                         |
| :---------------------- | :--------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| triage                  | sonnet                                   | structured extraction guided by a detailed skill                                                                                                                                                                                                                            |
| ticket (implementation) | sonnet                                   | was opus, until 54 ticket runs in one night cost ~$223 of ~$381 notional — a fifth of a weekly allowance for the step that is cheap to implement and expensive to review. `tick.mjs` reads the model from `factory-ticket.md`'s frontmatter, so this is one line to reverse |
| merge                   | **opus**                                 | review catches what tests don't; last gate before `develop` auto-deploys                                                                                                                                                                                                    |
| audit                   | sonnet                                   | mechanical checklist                                                                                                                                                                                                                                                        |
| factory-ux-critic       | sonnet on Claude; parent model elsewhere | exercises the app and reports                                                                                                                                                                                                                                               |

Triage is the live judgement call: a bad spec burns a full dispatch run, which argues for opus; `evals/` is the cheaper place to catch spec quality dropping. Currently sonnet — revisit if specs degrade.

### 2.11 Content is harness-neutral; packaging is generated

`shared/` is the only place to edit. `build/emit.mjs` produces the Claude plugin, harness-native skills/prompts, custom-agent definitions for Claude Code, Codex, Gemini, Cursor, and Pi, and the `AGENTS.md` floor block.

`--check` is the half that matters: it fails CI when a generated file drifts from `shared/`. The failure this prevents is real — coach-wattz carries "NEVER `prisma db push`" only in `GEMINI.md`, invisible to Claude Code. Four generated copies beat four hand-written ones **only** if CI proves they still match their source.

The plugin is a convenience layer, not the safety floor. It reaches Claude Code only, and a cloud sandbox without GitHub auth for this private repo gets nothing — failing closed without knowing it. So the non-negotiables live in `shared/floor.md` and are committed into each repo's `AGENTS.md`, the one channel every harness reads.

### 2.12 Extensions are one unit, allow-listed, and never fatal

Anything that adds to the running factory from outside its tree — an agent pack, a harness adapter, later a panel, a config schema, a hook — arrives as one **extension**: a directory with a `factory-extension.json` that declares what it contributes, enabled by one `extensions:` entry in `config/policy.yaml` ([`extensions.md`](extensions.md)). Three choices are deliberate. Discovery is allow-listed, never a directory scan, because the file that enables code in the worker process should be a committed one the operator edits. Data-only packs and operator-installed adapters share the manifest but not the trust: packs are held to the kernel's read-only, namespaced, pinned rules and are safe for an agent to author, while an adapter is code the operator has chosen to run and the registry still guards behind the sandbox seam. And a broken extension is a configuration anomaly on `/status`, not a failed `serve` — the factory should keep running when a third party ships a bad manifest, and say so where the operator looks.

### 2.13 Forge connector: one surface for the code host

GitHub is the second external system the factory depends on (after the tracker), and until WM-836 it was the least abstracted — `gh` was shelled out to from a dozen modules, each re-implementing argument building, JSON parsing and error handling, none of them fakeable without patching `spawn`. `lib/forge/` is the one chokepoint now, mirroring what `tools/linear.mjs` does for Linear: `loadForge({ root })` selects the implementation from `config/policy.yaml` (`forge: { kind: github }`, default `github`), `types.mjs` documents the contract in neutral vocabulary (`prView`, `prList`, `prDiffFiles`, `prSetDraft`, `prComment`, `runList`, `apiRaw` as the escape hatch, plus a `cli` descriptor for `doctor`), `github.mjs` implements it by wrapping the same `gh` invocations as before (no Octokit — a pure move), and `memory.mjs` is the in-process fake for tests and the demo. Every method returns the parsed answer or throws a `ForgeError` carrying the exit status and stderr; call sites that need the diagnostic read it off the error, the rest fail closed with one try/catch. `contract.test.mjs` runs the same suite against both implementations, and the Verification Command guards the invariant with a grep: nothing outside `lib/forge/` spawns `gh`. The interface is deliberately trimmed to what call sites use — it grows when a call site needs a verb, not for imagined forges.

### 2.14 ControlPlane connector: one surface for the tracker

Linear is the first external system the factory depends on, and until WM-797 every loop talked to it as Linear — GraphQL `nodes` wrappers, `issueUpdate` complete-set labels, team-key prefixes. That coupling is what blocks a GitHub Issues quickstart (WM-798) and an offline demo (WM-799). `lib/control-plane/` is the chokepoint, mirroring `lib/forge/`: `loadControlPlane({ root })` selects the implementation from `config/policy.yaml` (`controlPlane: { kind: linear }`, default `linear` when the stanza is absent), `types.mjs` documents the contract in tracker-neutral vocabulary (`getTicket`, `listDispatchable`, `claim`, `comment`, `transition`, `setLabels`, `file`, `appendDetail`, `raw` as the escape hatch), `linear.mjs` implements it by wrapping the same `gql()` client `tools/linear.mjs` already uses, and `memory.mjs` is the in-process fake for tests and the demo. Tickets come back with a flat `labels` array — no GraphQL `nodes`. `claim` still does Linear's read-back compare-and-swap (`ok: false` is a lost race, not an exception); both implementations honour it. The contract suite in `event-runtime/lib/control-plane.test.mjs` runs the same assertions against memory and against Linear driven by a fake `gql`. Call sites in `orchestrator/`, `tools/`, and `event-runtime/` still speak GraphQL directly; migrating them onto `loadControlPlane()` is a follow-up so this extraction stays inside its Owned Paths. The interface is trimmed to what the loops use — GitHub Issues is a new implementation of the same verbs, not a new vocabulary.

The tracker-neutral verb contract and the agent operating protocol live in [`protocol.md`](protocol.md).

---

## 3. Failure modes this design accepts

| Failure                                           | Why it is tolerated                                                                               | Mitigation                                                                                                                               |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Crashed agent holds a ticket                      | Reaper is not on a timer (§2.7)                                                                   | `tick.mjs` un-claims its own failed runs (back to Todo, with a comment); the reaper covers crashes tick can't see — run it by hand       |
| Agents indistinguishable from the human in Linear | Shared API key                                                                                    | OPS-40 — the dispatcher is the natural place to inject per-agent keys                                                                    |
| Orphaned worktrees                                | Merge stage sometimes skipped                                                                     | `janitor.mjs`, hourly gate                                                                                                               |
| Stale spec against moved code                     | Runner fast-forwards only a clean tree — the main checkout routinely holds uncommitted human work | Tells the agent in its prompt that the checkout is unreliable evidence and to read from `origin/<base>`; rebasing under someone is worse |
| Triage can still write to the repo                | `Bash` must stay available for exploration                                                        | Edit/Write/NotebookEdit disabled; dispatch works in worktrees instead                                                                    |

---

## 4. What is deliberately not built

- **Dispatch into repos without worktree scripts** — legalease (`CLNT-609`) and cashsaas (`CLNT-791`) have since landed theirs and joined bj29 and wm-home as dispatch targets; coach-wattz, watts-mobile, proxies, hdkiller and eslint-config remain `report_only` entries in `config/repos.yaml`. Inventing ports for tooling that does not exist is how two agents share a database. This repo came off that list too (`OPS-463`): `bin/worktree-up.sh`/`worktree-down.sh` give each dispatched factory ticket an isolated checkout, ports, and its own runtime home — never the live control plane's. Self-modification is contained by process, not trust: the live `serve`/`work` processes read the main checkout, so a dispatched change takes effect only after PR → CI → merge → the operator pulls and restarts; merges stay behind CI and watched approvals, and the deploy branch (`main`) stays human.
- **A shared worktree library** — six repos now ship worktree lifecycle scripts of their own, so the variation is finally visible; nothing has yet forced the extraction, and getting the abstraction wrong loses the port and database isolation the scripts exist for.
- **`evals/run.mjs`** — cases are written first on purpose; they specify what a skill is for.
- **Cross-repo parallelism** — `--repo a,b` runs sequentially. Concurrent sessions across repos contend for one machine and one usage window.

---

## 5. Related

- [`event-runtime.md`](event-runtime.md) — the isolated, event-driven runtime for structured one-off agents on generic workspaces; implemented and watched, with [`event-runtime-workers.md`](event-runtime-workers.md), [`event-runtime-schedules.md`](event-runtime-schedules.md) and [`event-runtime-webui.md`](event-runtime-webui.md) covering placement, clock events and the web control plane
- [`event-runtime-repos.md`](event-runtime-repos.md) — node-local repository provisioning, readiness advertisement, toolchain preflight, and disk-pressure cache eviction for remote workers
- [`protocol.md`](protocol.md) — tracker-neutral operating protocol and ControlPlane adapter contract
- [`README.md`](../README.md) — how to run it
- [`SETUP.md`](../SETUP.md) — first-time setup and known gaps
- [project-conventions.md](file:///Users/hdkiller/Develop/hdkiller/docs/guides/project-conventions.md) — quality baseline, `PC-*` audit, `W-*` worktree spec

# Model

The factory's public primitives, named as they exist in this repository. The
positioning that chooses this vocabulary is [`thesis.md`](thesis.md). The
reasons the loops are shaped this way are [`architecture.md`](architecture.md).

Nothing here is a synonym for another product's objects. A ticket is a Linear
issue. A run is a row the worker claimed. A pack is a directory with
`pack.json`. If a word is not in git, it is not a primitive.

---

## Authorities

Three systems hold state. The factory holds none of its own.

| Authority | Holds                                         | In this repo                                                      |
| :-------- | :-------------------------------------------- | :---------------------------------------------------------------- |
| Linear    | Work: tickets, states, assignee, labels       | `tools/ticket.mjs`; claim read-back is the only ticket lock       |
| GitHub    | Truth: branches, pull requests, review, merge | `lib/forge/` (`kind: github` in `config/policy.yaml`)             |
| CI        | Reward: the change earned the next step       | Per-repo checks; nothing merges because an agent said it was done |

`orchestrator/tick.mjs` re-reads Linear on every decision. Restarting it loses
nothing. The PR is the artifact; the branch is the work.

---

## Ticket

The unit of business work. A ticket is dispatchable when it is `Todo`, labelled
`ai:agent-ready`, unassigned, and carries machine-readable **Owned Paths** and
a **Verification Command**.

Lifecycle, as the dispatcher and the event chains implement it:

```
Triage → Todo + ai:agent-ready → In Progress + ai:in-progress
       → In Review + ai:needs-review → Done
```

Holds are `Blocked` + `ai:blocked`. The Linear `assignee` is the distributed
lock; the claim protocol writes it and reads it back. Lost races stop. They
never steal and never queue behind the holder.

The ticket body is the spec. Follow-up work discovered outside Owned Paths is
a new `Triage` issue (`tools/ticket.mjs file`), never a widening of the one
in flight.

---

## Owned Paths

The concurrency key. Two tickets may run together only when their glob sets
are disjoint. `globsOverlap` errs toward collision: a false positive
serializes two tickets, a false negative puts two agents in one file.

Owned Paths are a section on the ticket, parsed from bullets, fenced blocks,
and indented code. An empty parse is undispatchable, not "touches
everything."

---

## Worktree

The isolation unit for repository work. Git isolates branches; it does not
isolate ports or databases. Each dispatchable repo owns `worktree_up` /
`worktree_down` scripts (this repo: `bin/worktree-up.sh`,
`bin/worktree-down.sh`) that give the ticket its own checkout, branch, ports,
database, and runtime home.

Order is **claim → worktree → spawn**. A `worktree_up` takes minutes; an
unclaimed ticket is one another agent may take.

A repo without those scripts is `report_only` in `config/repos.yaml`: the
janitor can see orphans, dispatch refuses them. This repo is an ordinary
dispatch target (OPS-463): dispatched tickets never touch the live control
plane's runtime home.

Not every run is a worktree. The event runtime's workspace types include an
ephemeral directory for agents that only need their declared inputs. A Git
repository is one workspace provider, not the runtime's foundation. See
[`event-runtime.md`](event-runtime.md) §7.

---

## Event, proposal, run

The event runtime turns an admitted event into one bounded agent execution.

- **Event** — authenticated, replay-safe intake; typed in
  `event-runtime/event-types.json`. Idempotency is declared per type
  (`idempotencyScope`: `correlationId`, `inputHash`, `subject`, …).
- **Proposal** — the planner's deterministic plan (`lib/planner.mjs`). Watched
  approval before execution in the MVP; some types are
  `humanApprovalOnly` (`factory.ship-apply.requested`).
- **Run** — a worker claim (`BEGIN IMMEDIATE`, lease, fencing token) of an
  approved spec. One OS process, one agent, one workspace, one verify, one
  receipt. Agents never spawn agents.

`serve` (`event-runtime/cli.mjs serve`) is API, planner, scheduler, chain
resolver, and outbox. It runs no worker. `work` claims and executes.
`--with-worker` is the demo all-in-one.

Typed outcomes (`PR_OPEN`, `NOT_CLAIMED`, `BLOCKED`, `FAILED`, `REFUSED` with
`reasonCode: "needs_human"`) are the contract the rest of the factory
reacts to — not free-text logs.

---

## Agent

A versioned, content-pinned definition, not a session.

The kernel registry root is `event-runtime/`. An agent is `id@version` in the
bare namespace (`dispatch@1`, `work-scan@1`, `merge-scan@2`, `ship-scan@1`,
`reaper@1`, …) or `namespace/id@version` from a pack. Each definition names:

- a prompt and input/output schemas, hashed in `pins`;
- an `output_contract` (for example `factory.dispatch-result/v1`);
- a `model_tier` (`strong` / `standard` / `light`, mapped per adapter in
  `config/policy.yaml`);
- a workspace type and capabilities (`filesystem`, `services`, `tools`);
- limits (`timeout_seconds`, `attempts`, `budget_usd`);
- whether it is `mutating`.

The model is stochastic. The wrapper is not: planner, lifecycle, permissions,
prompt version, input hash, output schema, timeout, and acceptance rules are
deterministic. That is what "deterministic agent" means in this repo.

---

## Registry, pack, extension

- **Kernel** — the built-in `event-runtime/` tree. It owns `namespace: ""`.
  Exactly one loaded root may own the bare namespace.
- **Pack** — a filesystem directory with `pack.json`, `pins.json`, `agents/`,
  `schemas/`, and optional `event-types.json`, `edges.json`,
  `schedules.json`. Allow-listed in `config/policy.yaml` under `packs:`;
  never discovered by scanning. Packs are read-only and may not declare
  `mutating: true`. See [`kernel-and-packs.md`](kernel-and-packs.md).
- **Extension** — the install unit: one directory, one
  `factory-extension.json`, enabled by one `extensions:` entry. It may
  contribute packs, adapters, config, hooks, and panels.
  [`extensions.md`](extensions.md) is the author guide.

Duplicate final agent refs, event-type keys, edge sources, or schedule loop
names are load errors. A pack cannot override earlier content. A broken
extension is a configuration anomaly on `/status`, not a failed `serve`.

---

## Edge and schedule

- **Edge** — `event-runtime/edges.json`. After a run, the chain resolver
  reads a recommendation field (`TRIAGE`, `SHIP`, `REMEDIATE`, …) and
  admits the next event type with mapped input. This is the discovered
  chain, not a declared `dependsOn` workflow.
- **Schedule** — `event-runtime/schedules.json`, driven by the in-process
  scheduler as `clock.tick.<loop>` events. Every loop ships disabled
  (`enabled: false`) until it has been watched. `config/schedule.yaml` is
  a separate file for the older launchd path and is likewise disabled.

The standing software-factory chain, as event types:

```
factory.triage.requested        → triage-scan@1 → factory.triage-apply.requested
factory.work.requested          → work-scan@1   → factory.dispatch.requested
factory.dispatch.requested      → dispatch@1    → (PR + result event)
factory.merge.requested         → merge-scan@2  → factory.merge-apply.requested
factory.ship.requested          → ship-scan@1   → factory.ship-apply.requested
clock.tick.reaper               → reaper@1
```

Janitor, unblock, sweep, CI-doctor, and warm are the same shape: a scan
agent, an apply agent, an edge between them.

---

## Verify and handoff

Verification is independent of the agent.

The ticket names an exact **Verification Command**. The worker re-runs it on
the tree the agent pushed, plus the repo's declared verify
(`config/repos.yaml` / this worktree's `.worktree.json`). A non-zero exit
fails the run, converts the PR to a draft, and returns the ticket to Todo
labelled `ai:agent-ready`. The agent's `## Handoff` comment is
agent-reported commentary. The worker posts `## Handoff verification
(worker-observed)` with the command, exit code, and Owned Paths diff.

UX critique (`factory-ux-critic`) is a separate gate for user-completable
flows. Docs, schema, and infra tickets skip it (`status: "skipped"`,
`verdict: null`).

---

## Inbox

When a loop must stop for a human, it files a typed **decision request** on
an inbox item (`event-runtime/lib/inbox.mjs`). The operator posts a typed
**response**; closed **effects** apply it (including `authorise`, bound to
the ticket description so a re-scope expires the grant). Ack and resolve
without a decision do not unblock work.

`reasonCode: "needs_human"` (auth, payments, secrets, destructive
migrations, production infra, or a missing fact) is how a run refuses
without guessing. See [`event-runtime-inbox.md`](event-runtime-inbox.md).

---

## Adapter and forge

- **Adapter** — how a run invokes a harness or a closed command. Kernel
  adapters include `cursor`, `agy`, `pi`, `command`, `actions`. Extensions
  may register more. The adapter is named on the event type and on the
  agent; the worker does not pick one at runtime.
- **Forge** — `lib/forge/`, the one chokepoint for the code host
  (`prView`, `prList`, `prDiffFiles`, `prSetDraft`, `prComment`, `runList`,
  `apiRaw`). Call sites do not spawn `gh` themselves.

---

## Shared content

`shared/` is the only place to edit harness-neutral commands, skills, floor
rules, and custom-agent definitions. `build/emit.mjs` produces the Claude
plugin, `dist/{codex,gemini,cursor,pi}/`, and `dist/AGENTS.floor.md`.
`--check` fails CI when a generated file drifts from `shared/`. The plugin
is a convenience layer; the non-negotiables travel in each repo's
`AGENTS.md`.

---

## Policy and repos

- `config/repos.yaml` — per-repo routing: Linear team, base branch,
  worktree scripts, verify command, `max_in_flight`, `report_only`.
- `config/policy.yaml` — budgets, concurrency, model tiers, packs,
  extensions, forge kind, worker min/max.
- `config/nodes.yaml` — remote-worker node inventory (protocol in
  [`event-runtime-worker-protocol.md`](event-runtime-worker-protocol.md)).

Capacity is one per-repo in-flight cap, shared by the ticket dispatcher and
the event path, counted in `~/.factory/worker-leases/`.

---

## Related

- [`thesis.md`](thesis.md) — wedge-first positioning
- [`architecture.md`](architecture.md) — decisions and rejected alternatives
- [`event-runtime.md`](event-runtime.md) — runtime architecture
- [`kernel-and-packs.md`](kernel-and-packs.md) — registry extension rules
- [`extensions.md`](extensions.md) — the install unit
- [`event-runtime-dispatch.md`](event-runtime-dispatch.md) — shared claim,
  capacity, Owned Paths, workspace, and approval with the dispatcher

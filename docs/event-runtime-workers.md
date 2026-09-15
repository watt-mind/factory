# Event runtime: workers, placement, and chaining

Status: **stage 1 shipped (OPS-233), pool supervision shipped (WM-226),
launchd definitions shipped (WM-139); stages 2–3 are still design**.
Tracking: OPS-221 and WM-308.
Companion to [event-runtime.md](event-runtime.md) §3, §8, §10, §11 — this
note describes process and node placement. WM-308 deliberately replaces the
former "second process → Postgres → remote workers" line: remote workers use
the authenticated control protocol in
[event-runtime-worker-protocol.md](event-runtime-worker-protocol.md), never a
shared database. §6 records that superseded cut-line explicitly.

---

## 1. Today, precisely

`serve` is API, planner, scheduler, chain resolver and outbox publisher. It
runs **no worker**: execution lives in one or more `cli.mjs work` processes,
each registering in the worker table with labels and a heartbeat.
`--with-worker` restores the all-in-one for a demo.

Two consequences worth stating because they answer real operator questions:

- **Concurrency is a worker count, and the count is now a supervised, dynamic
  one (§2a).** Two `work` processes execute two runs at once, and the claim is
  correct under contention (`BEGIN IMMEDIATE`, leases, fencing tokens). What
  used to be a manual deployment choice is `config/policy.yaml`'s
  `workers: {min, max}`; the reason `max` stays small is still the unobservable
  subscription usage window (architecture.md §2.9), not a structural limit.
- **A run occupies the worker for its whole duration.** A 10-minute agent
  run means 10 minutes of queue. The lease (spec timeout + 120 s grace) and
  fencing token already make this safe to change — they were built for the
  multi-worker future, and guard nothing today.

## 2. Stage 1 — worker as a process (same machine) — **shipped, OPS-233**

The smallest real step, and a prerequisite for everything after:

- **Substrate: SQLite, for now.** A correction to this note's original plan:
  splitting the process does **not** require Postgres. SQLite in WAL mode
  already supports multiple processes on one machine — what it needed was
  `BEGIN IMMEDIATE` on the claim (the default deferred transaction lets two
  workers read the same QUEUED row before either writes) and `busy_timeout`
  set _before_ `journal_mode`, or a second process opening the database
  fails with `SQLITE_BUSY_RECOVERY`. The old plan made Postgres with
  `FOR UPDATE SKIP LOCKED` the remote-node requirement. WM-308 supersedes it:
  SQLite remains private to the control plane, and remote claims cross the
  worker API. The server still calls the same claim module and transaction.
- **`cli.mjs work`** — a standalone process running the loop `runOnce`
  already contains: claim → workspace → adapter → verify → fenced publish.
  `serve` keeps API, planner, approval, outbox, and the reaper, and no longer
  executes (`--with-worker` restores the all-in-one for a quick demo).
- **Worker registry and heartbeats.** Leases prove an _attempt_ is held; the
  registry answers which processes are alive, where, and with what labels —
  the difference between "busy on a long run" and "died holding a lease".
  The heartbeat runs on its own timer, never inside the claim loop, because
  that loop blocks for the whole duration of an agent run.
- **Bounded graceful drain.** SIGTERM stops claiming and lets the in-flight
  attempt finish, but only for a grace period (`--drain-timeout`, default
  60s): waiting out a ten-minute run trains operators to SIGKILL, which
  orphans the agent process and leaves a lying registry row. On timeout the
  worker leaves honestly and says what happens next — the lease expires and
  the reaper requeues.
- **Concurrency becomes a worker count**, still deliberately small. Two
  `work` processes are the correctness proof (leases and fencing under real
  contention); raising agent-run parallelism beyond that waits for an answer
  to the usage-window problem, which no code can observe (§3).

Nothing downstream of the claim changes: contracts, verification, the FSM,
and the approval gate are untouched.

## 2a. The pool — supervised, dynamic worker count — **shipped, WM-226**

§2 left worker count as a manual decision: an operator started `work`
processes and remembered to stop them. `cli.mjs supervise` makes it a
deterministic function of observed queue depth.

The insight that shapes the whole design: **idle workers are nearly free.**
An idle worker costs a poll every 500ms and a heartbeat every 15s. A _busy_
one costs a worktree and an LLM subprocess, and draws on a shared
subscription usage window nothing here can observe (§3, and event-runtime.md
§3's open problem). So the supervisor spends the cheap resource — process
count — to bound the scarce ones, and `workers.max` should be read as the
real ceiling on concurrent agent runs on that machine.

- **Its own process, not part of `serve`.** Decisions and execution stay
  separated; restarting the control plane must not kill capacity. Because
  workers are spawned detached with their own pidfiles, a supervisor that
  restarts _adopts_ the running pool rather than replacing it. launchd
  (WM-139) supervises `serve` and the supervisor; the supervisor supervises
  workers.
- **Deterministic, from config, never model-driven.** The rule is a pure
  function of counts — `poolDecision({queued, idle, pool, pending, min, max})`
  in `lib/workers.mjs` — and `config/policy.yaml`'s `workers: {min, max}`
  block supplies the bounds. One decision per tick: scaling by one and
  re-observing is what keeps a burst of queued runs from spawning the whole
  ceiling for work a single worker would have absorbed. `pending` exists for
  the same reason at the other end — a worker takes a second to register, and
  without counting it every tick in that window sees "queued work, nothing
  idle" and spawns again.
- **Scale-down is a request, never a signal.** The supervisor writes
  `worker-N.drain` in the run dir; `work --drain-file` reads it at its **idle
  poll boundary only** — the same place WM-213's code-stamp check lives, and
  for the same reason. A worker holding a lease finishes its run and _then_
  exits 0. The supervisor never sends a signal to a worker it is merely
  shrinking, so "no leased worker is ever killed" is a structural property,
  not a race it usually wins.
- **Shutdown escalates, and says which rung it is on.** On SIGTERM the
  supervisor writes every drain flag, waits, then SIGTERMs the stragglers —
  which starts each worker's own bounded graceful drain from §2 — and
  finally leaves whatever is left to its leases, logging that the reaper will
  requeue. `factory down` gives the pool a matching wait
  (`FACTORY_POOL_DRAIN_TIMEOUT`, default 180s) rather than the three-second
  `await_daemon` that suits a web server.
- **Every spawn and drain is logged with the counts that justified it** —
  `queued`, `idle`, `busy`, `pool`, `pending`, and the bounds — because a
  scaling decision you cannot reconstruct is indistinguishable from a bug.
  Holds are logged only when the reason changes.
- **Visible in status/doctor.** `status` grows a `pool` line (supervisor
  liveness, pool size, how many are draining), and a queue with waiting runs
  behind a _dead_ supervisor is an anomaly — nothing is left that can grow
  the pool. Read from the run dir rather than the control API, because
  pidfile liveness is node-local state the API cannot see.

Operationally:

```
factory up                     # policy-driven: a workers: block starts the pool
factory up --workers 1:3       # explicit bounds, no policy block needed
factory up --dev               # unchanged — WM-213's single reload-aware worker
factory down                   # drains the pool, then the rest of the stack
factory tail worker-2          # one worker's log; worker.log is the supervisor
```

Deleting the `workers:` block restores the pre-WM-226 stack exactly: one
plain `cli.mjs work` process. `--dev` and `--workers` are mutually exclusive
— both replace the worker daemon, and WM-213's reload supervisor drives a
single worker by design.

**Not yet, deliberately.** Weight-class caps (`heavy`/`light` labels, so four
cheap scans and four concurrent coding runs are not the same budget) reuse
the §4 placement machinery and need claim-side class filtering first. A
budget-aware ceiling — throttling spawns when rolling token spend crosses a
threshold — is blocked on WM-66's per-run usage data; until it exists,
`workers.max` is the only guard on the usage window, and it is a blunt one.

## 2b. launchd user agents — **shipped, WM-139**

The production-on-a-Mac process boundary is generated and reviewable, not a
pair of background shells tied to a coding session:

- `deploy/launchd/com.wattmind.factory.event-serve.plist` keeps `serve` alive;
- `deploy/launchd/com.wattmind.factory.event-work.plist` keeps `supervise`
  alive, and the supervisor owns the actual worker processes from §2a.

`bun deploy/gen.mjs --workers min:max` regenerates both. The committed default
is `1:2`; a single number means a fixed pool (`--workers 2` → `2:2`). This is
one worker-pool plist rather than N near-identical plists, so scale decisions,
drain semantics, pidfiles, logs, and status continue to have the single §2a
implementation.

Both agents execute `bin/event-runtime-daemon` with `KeepAlive` and
`RunAtLoad`. The launcher resolves the durable checkout from `FACTORY_ROOT`
(default `~/Develop/factory`), loads the mode-600
`~/.factory/secrets.env`, and writes to
`~/Library/Logs/factory-event-{serve,work}.{out,err}.log`. Generated plists
therefore contain neither a renderer worktree path nor a secret. The complete
template, install, bootstrap, validation, scaling, and rollback commands are
in [SETUP.md](../SETUP.md#3a-event-runtime-as-launchd-user-agents-wm-139).

The worker launch is deliberately conditional, not delayed by an arbitrary
timer: its launcher retries the loopback `/health` request for at most 120
seconds, then execs `supervise`. A healthy response means `serve` has already
opened the database and settled WAL mode, so OPS-376's concurrent first-open
race cannot occur even when launchd starts both plists together. If health
never arrives, the launcher exits and launchd retries under `KeepAlive`; it
never opens SQLite first.

Install into `gui/$(id -u)`, not the background `user/$(id -u)` domain. The
GUI login domain is the full user context: `HOME`, keychain, `~/.ssh`, and its
SSH environment remain reachable to worker children. This is still proved at
deployment time, not inferred from the plist: run an allowlisted read-only
`disk-diagnose@1` SSH probe through a daemon worker and retain its run
receipt/trace. A terminal-side SSH success does not prove the worker child.
Mutating dispatch runs separately record their push outcome and continue to
use `gh`'s HTTPS credential helper as the paved road (WM-128), regardless of
whether SSH is available.

There are two liveness views by design:

```
launchctl print gui/$(id -u)/com.wattmind.factory.event-serve
launchctl print gui/$(id -u)/com.wattmind.factory.event-work
bun event-runtime/cli.mjs status
bun event-runtime/cli.mjs workers
```

The first pair says whether launchd owns the long-running processes. The
second pair says whether the control plane is healthy, the pool supervisor is
alive, and workers have registered/continued heartbeating. Stop the worker
agent before the serve agent on rollback so the pool drains before the control
plane disappears. Manual `serve`, `work`, and `supervise` commands remain the
development fallback; a sandboxed interactive shell may not carry a usable SSH
context, which is precisely why that fallback is not the production setup.

## 2c. Adapter registry and contract — **shipped, WM-837**

A worker executes a run through a _harness adapter_ — `claude`, `pi`,
`cursor`, `agy`, `command`, `actions`, the test-only `fake`, and the
experimental `acp` adapter (WM-937), all in `event-runtime/lib/adapters/`.
Which adapters a worker carries used to be an object literal duplicated in
`cli/work.mjs` and `cli/serve.mjs`; both now obtain the set from the registry
in `event-runtime/lib/adapters/index.mjs`, which is also what a future
extension loader (packs, out-of-tree adapters) registers into.

**The contract.** An adapter is a module (an ES module namespace or any object
with the same exports) that satisfies all of:

- `execute(options)` — the async run entry point `lib/worker.mjs` invokes;
  its options object and result shape are specified in
  `docs/event-runtime-conventions.md` § "Adapter contract";
- `SANDBOX_SUPPORT` — `"gondolin"` (the adapter runs the agent inside the
  microVM via `runSandboxed()` when a definition carries `sandbox`) or
  `"unsupported"` (it must refuse such a definition, WM-313); no third value;
- a name matching `^[a-z][a-z0-9-]*$` — it appears in run specs, worker
  labels, and `--adapter-override`.

**The registry.** `builtinAdapters()` returns the seven shipped modules keyed
by name. `createAdapterRegistry({ builtins = builtinAdapters() })` validates
and registers them with source `builtin` and returns:

- `register(name, module, { source, replace = false })` — validates the
  contract; an invalid module throws `AdapterContractError`
  (`code: "adapter_contract_invalid"`, `missing` naming the failed part:
  `name`, `module`, `execute`, or `SANDBOX_SUPPORT`); a duplicate name throws
  `AdapterRegistrationError` (`code: "adapter_duplicate"`) unless
  `replace: true`; `source` is mandatory so the listing can always say where
  an adapter came from;
- `get(name)`, `has(name)`, `list()` (`{ name, source, sandboxSupport }`,
  sorted by name);
- `toMap()` — a frozen `name → adapter` snapshot, the shape
  `runOnce(db, registry, adapters, opts)` / `executeClaimed` consume.

**The sandbox seam is mandatory.** Nothing the registry hands out is the raw
module: `get()` and `toMap()` return a frozen wrapper whose `execute` consults
`sandboxed.mjs` first — an `unsupported` adapter is refused with
`SandboxUnsupportedError` for a sandboxed definition before its own code runs,
so an adapter that forgets `refuseSandbox()` still cannot execute on the host.
`gondolin` adapters are delegated to and own the `runSandboxed()` call, and
`sandboxed.test.mjs` proves each built-in reaches the VM boundary.
`index.test.mjs` asserts that no unwrapped adapter escapes.

**Inspecting it.** `bun event-runtime/cli.mjs adapters` (`--json` for
machine-readable output) prints the registered adapters with their source and
sandbox support — the same registry a worker builds, so it needs no running
`serve`.

**Experimental `acp` (WM-937).** `event-runtime/lib/adapters/acp.mjs` is an
ACP v1 client (`protocolVersion` pinned to `1`) that spawns any Agent Client
Protocol agent as JSON-RPC NDJSON over stdio. Config is `{ command, args, env }`
with shipped default `{ command: "claude-code-acp", args: [], env: {} }`. It
satisfies the contract (`execute` + `SANDBOX_SUPPORT = "unsupported"`) and
tests register it with `createAdapterRegistry({ builtins: { acp } })`. It is
not yet in `builtinAdapters()` — wiring `index.mjs` is a follow-up outside
this spike's Owned Paths. Permission requests for workspace-scoped edits and
an allow-listed command set are auto-answered; anything else fail-closes
(`reject_once`) rather than blocking the turn on an inbox `decision_needed`
item (a human cannot beat the run timeout). Usage arrives as ACP
`usage_update` (`used` / `size` / optional USD `cost`), not Claude's
`input_tokens` / `output_tokens` split.

## 2d. Harness content as a RunSpec input — **shipped, WM-851**

Runtime LLM runs used to acquire skills, slash commands, and subagents from
ambient host home-dir symlinks (`~/.claude/agents`, `~/.cursor/commands`,
`~/.pi/agent/…`) written by `bun build/emit.mjs --link`. A worker on a
machine that had never been linked, or a run that named a subset of that
content, had no declared input — the harness just inherited whatever $HOME
happened to contain.

A definition may now declare:

```json
"harness": {
  "skills": ["ticket-spec"],
  "commands": ["factory-ticket"],
  "subagents": ["factory-ux-critic"]
}
```

`buildRunSpec` (`lib/planner.mjs`) copies a well-formed block onto the
immutable RunSpec — same omit-when-undeclared rule as `model_tier`, so
existing definitions stay byte-identical. Shape is checked at plan time
(object, closed keys, names matching `^[a-z0-9][a-z0-9._-]*$`); catalog
membership is not, because `buildRunSpec` is pure.

The worker materializes that declaration **after** workspace create and
**before** adapter spawn (`materializeRunHarness` in `lib/worker.mjs`):

1. Resolve each name against `registry.harnessRoots` when WM-849 has
   populated it, otherwise `shared/{skills,commands,agents}`.
2. Copy the **adapter's emitted packaging** (not the shared source) into a
   workspace-relative tree the CLI reads from cwd:

   | Adapter  | skills                                           | commands                       | subagents                 |
   | -------- | ------------------------------------------------ | ------------------------------ | ------------------------- |
   | `claude` | `.claude/skills/<n>/` from `plugins/core/skills` | `.claude/commands/<n>.md`      | `.claude/agents/<n>.md`   |
   | `acp`    | same as `claude` (experimental, WM-937)          | same as `claude`               | same as `claude`          |
   | `cursor` | **unsupported** (emit has none)                  | `.cursor/commands/<n>.md`      | `.cursor/agents/<n>.md`   |
   | `pi`     | `.pi/agent/skills/<n>/` from `dist/pi/skills`    | `.pi/agent/prompts/<n>.md`     | `.pi/agent/agents/<n>.md` |
   | `agy`    | `.gemini/skills/<n>/` from `dist/gemini/skills`  | same (commands emit as skills) | `.gemini/agents/<n>.md`   |

3. Refuse with a typed reason, never spawn:

   - `harness_unknown_skill` / `_command` / `_subagent` — name not in the catalog;
   - `harness_unsupported` — the adapter has no layout for that kind (cursor
     skills; fake/command/actions when anything is named);
   - `harness_unmaterializable` — catalog hit but emit output is missing or
     the dest would escape the workspace.

Those codes are fatal (`classifyFailureCause` treats the `harness_` prefix
as fatal). An undeclared or empty `harness` is a no-op.

LLM adapters export `HARNESS_LAYOUT` describing source/dest/type; it is
**not** part of the WM-837 adapter contract (`execute` + `SANDBOX_SUPPORT`
remain the required pair). There is no runtime `codex` adapter — Codex
packaging lives under `dist/codex/` for emit/`--link` only.

The orchestrator path (`runners/run-agent.sh`) is unchanged: it still
launches inside a product checkout and relies on `link-repos` plus the
operator home-dir install. It has no RunSpec.

Auth stays in the real `$HOME`. Materialization adds the declared set to the
workspace; it does not hide extra home-dir content the CLI may still load.

## 3. Stage 2 — workers on other nodes

### Remote node checkout source

Remote nodes are configured in `config/nodes.yaml`. A node may set `repo_url`
to the clone URL the remote bootstrap uses, for example:

```yaml
nodes:
  build-node:
    host: build-node.example
    factory_root: ~/Develop/factory
    repo_url: ssh://git@example.com/engineering/factory.git
```

When omitted, `repo_url` defaults to
`https://github.com/watt-mind/factory.git`. This permits forks, enterprise
GitHub hosts, and SSH remotes without changing the worker deployment code.

A `work` process on another machine talks to the authenticated `/worker/v1`
control surface over HTTPS on the tailnet. It never opens SQLite or Postgres.
Webhook intake, approval, and the web/operator routes do not move or become
network-visible; only the narrowly scoped worker and artifact-ingest routes
bind beyond loopback. The full claim/heartbeat/result, fencing, idempotency,
auth, and durable-buffer contract is
[event-runtime-worker-protocol.md](event-runtime-worker-protocol.md).

What actually has to exist first:

- **Content-addressed artifact ingest (OPS-298).** Receipts and hashes remain
  control-plane state, while artifact/transcript bytes begin on worker-local
  disk. The worker uploads bytes through `POST /artifacts`; the server
  recomputes SHA-256 and deduplicates, and result publication binds only those
  hashes. Workspaces stay node-local and ephemeral; no remote `file://` path
  enters a result.
- **Registry verification at claim, not trust.** Definitions are pinned by
  content hash and the RunSpec records `defHash` (OPS-409). The worker
  resolves prompt and schema files from its checkout and **verifies the spec's
  content hash before executing; mismatch → typed refusal**
  (`agent_definition_mismatch`). The server independently checks the pinned
  contract and uploaded hashes before accepting a result.
- **Per-node identity, credentials, and adapters.** Each node gets a distinct,
  revocable `worker:execute` credential whose server-side allow-list bounds
  labels and adapters. Adapter/service credentials remain worker-injected
  (§14), but are never the control credential. A node advertises only adapters
  it has passed conformance for; a node without an agent CLI claims only the
  deterministic kinds it supports.
- **A durable local result buffer.** The worker atomically spools canonical
  result metadata and artifact bytes before workspace cleanup. It retries
  outages with one idempotency key and deletes only after an accepted response;
  a stale lease is fenced and quarantined rather than overwriting a rerun.
- **Node-local workspace prerequisites.** First scope is workspace-only jobs
  and tier-1 read-only scans on nodes with an adapter, mirror/fetch credential,
  and per-node repo mapping. Tier-2 mutating worktrees remain disabled until
  their machine-specific scripts, ports, databases, and dispatch coordination
  are shared across nodes (event-runtime-dispatch.md §9).

## 4. Labels and placement

Placement is **claim-side filtering, not a scheduler**. The claim query is
the whole mechanism:

- A worker starts with labels describing what and where it is (`--label k=v`):
  `node=lab`, `arch=arm64`, `adapter=claude`, `can=infra-exec`, registered in
  the worker table via `registerWorker` (`lib/workers.mjs`).
- An agent definition (and therefore its RunSpec, resolved at planning time in
  `lib/planner.mjs`) may declare `placement`: label requirements such as
  `{ node: "lab", can: "infra-exec" }`. No requirement → any worker.
- `claimNext` (`lib/worker.mjs`) claims only runs whose placement its labels
  satisfy (`satisfiesPlacement` in `lib/workers.mjs`). In SQLite today, the
  local process filters candidates in JS inside `BEGIN IMMEDIATE`. Under the
  worker protocol, the authenticated server performs that same filter and
  transaction; the remote worker cannot request a run ID or broaden the
  labels/adapters allowed by its credential. There is still no scheduler
  process, bin-packing layer, or second coordinator.

Slice 2 is the motivating case: `keephq.disk-alert.raised` remediation must
execute _on the affected host_. Labels also encode the quota split cleanly:
`adapter=claude` workers are capped hard; `can=infra-exec` deterministic
executors (closed action registry, no model) can scale per node with zero
usage-window risk.

Unsatisfiable placement must surface, not hang: candidate filtering ensures
unplaced or matching runs are not starved by unsatisfiable queue heads
(OPS-454), and runs whose placement no live worker's labels satisfy surface
as doctor-check anomalies (§13) after a threshold age, naming the missing labels.

## 5. Chaining agents

Shipped as the discovered form (OPS-223): `lib/chain.mjs` plus `edges.json`. The rules
that answer "can agent A trigger agent B":

- **Agents never message or spawn agents.** A finished run's accepted result
  is published as a result event through the outbox. Events are the only
  coupling.
- **Declared chains (workflows).** A workflow node declares `dependsOn`,
  one registered agent or deterministic command, and input mapped from prior
  accepted artifacts. Code selects runnable nodes topologically; a completed
  upstream unlocks downstreams. Slice 2's diagnose → remediate pair is the
  first two-node chain.
- **"Agent A identifies that agent B should work"** — the discovered chain —
  is a _typed recommendation in A's output contract_, not an action A takes:
  A's artifact carries e.g. `recommendedFollowUp: { type: "...", input: … }`
  drawn from a closed set its schema allows. The result event re-enters the
  planner; the planner (registered mapping, never the model) turns it into a
  **new proposal**, which waits for watched approval like any other. A
  hallucinated recommendation therefore costs one rejected proposal, not an
  unauthorized run. Approval of chain steps can relax per event type later
  (the §2 "earned automation" rule), but the default is: every spawned step
  is proposed, visible at `#/proposals`, and approved.

The loop this closes: webhook → agent A → result event → planner → proposal
for agent B → approval → agent B — same intake, same dedup (causation IDs
already exist in the envelope for exactly this provenance), same audit
trail, whether the "requester" was a webhook or another agent's result.

**Decided (operator, 2026-08-12):** the discovered/recommendation flavor is
the direction to build toward, ahead of general declared workflows (slice
2's fixed two-node chain stands as designed). Approval model:
**per-edge earned automation** — each recommendation edge (a specific
`A-recommendation → B` mapping) is watched individually and earns
auto-approval on its own record; mutating edges may simply never earn it.
First use case: **shipped (OPS-223)** — the CI failure doctor: `github.workflow-run.failed` → `ci-doctor@1` verdict → `FLAKE|ENV → ci-rerun@1` / `TICKET → ci-notify@1`, every edge watched; the edge registry (`edges.json`), chain resolver (`lib/chain.mjs`), and closed-template command adapter are the §6 cut-line 6 machinery.

## 5a. Repository access: tier 1 shipped, tier 2 held (OPS-228/OPS-229)

Agents that need a repo split cleanly by whether they _read_ code or _build_
it, and only the second half is expensive.

**Tier 1 — read-only pinned checkout (shipped).** A bare mirror per repo under
the runtime home, fetched at plan time; each run gets its own detached
worktree of that mirror at a **SHA resolved at plan time and pinned into the
run's input** (`repoPin`), so the run names the exact tree it read and dedup
distinguishes "same repo, new commit". No dependency install, no ports, no
database — reading code does not need `node_modules`. Repo facts come from
the factory's existing `config/repos.yaml` (`FACTORY_REPOS_ROOT` overrides
the checkout it is read from); the runtime is a reader, never a second
registry. The operator's live checkout is never used: it holds uncommitted
work an agent would read as truth, concurrent runs would race in it, and even
a read-only run wants `git fetch`, which writes to `.git`.

**Tier 2 — full worktree (designed, WM-107; unbuilt).** Branch, install,
ports, per-ticket database. This tier was held while its blocker was
unresolved; the coordination design now exists —
[event-runtime-dispatch.md](event-runtime-dispatch.md) — and the two rules
stand as the rules that design satisfies:

1. **Delegate, never reimplement.** `config/repos.yaml` already declares
   `worktree_up`/`worktree_down`/`verify` per repo; the provider shells out to
   them (dispatch design §5). Git isolates branches, not ports or databases —
   a second worktree implementation inside the runtime would drift and
   eventually collide with a dev server. Delegation covers the repo-owned
   worktree scripts, **not** the harness spawn: the run itself goes through
   the runtime's own `claude` adapter, never by shelling to `run-agent.sh`
   (dispatch design §6).
2. **Coordination first, workspaces second.** Per event-runtime.md §3, before
   an event run may claim a ticket or mutate code, both paths must share one
   claim, capacity, Owned Paths, and approval authority with the ticket
   dispatcher. Two independent mutation coordinators race even with separate
   source trees, and both draw on the same unobservable subscription usage
   window. The dispatch design answers each: the Linear assignee stays the
   only ticket lock, the dispatcher's cap and worker-lease ledger count both
   paths, `orchestrator/owned-paths.mjs` is imported as the one collision
   oracle, and watched proposals gate every mutation — with the deploy-branch
   merge permanently human. Building the provider before those land would
   recreate the race this rule exists to prevent.

## 6. Ticket cut-lines

1. **API-mediated worker protocol** — **designed (WM-308), superseding the
   rejected Postgres cut-line**: do not port `db.mjs`, expose DB credentials,
   or add `FOR UPDATE SKIP LOCKED` for worker distribution. The control plane
   keeps SQLite and `BEGIN IMMEDIATE`; local and remote workers use versioned,
   authenticated claim/heartbeat/result endpoints with fencing, idempotency,
   cancellation polling, and a durable worker result buffer. See
   [event-runtime-worker-protocol.md](event-runtime-worker-protocol.md).
2. **`cli.mjs work`** — **shipped (OPS-233)**: worker-as-process; `serve`
   runs no worker by default (`--with-worker` for all-in-one demo/tests);
   two-process lease/fencing contention verified in `lib/workers.test.mjs`.
3. **Artifact ingest** — **deferred (Stage 2, OPS-298)**: authenticated
   `POST /artifacts` streams bytes to the control plane's content-addressed
   store, which recomputes SHA-256 and deduplicates before result publication.
   Node-local content-addressed disk (`<home>/artifacts/<sha256>`) remains the
   current implementation; remote results never contain local paths.
4. **Labels + placement** — **shipped (OPS-233, OPS-454)**: worker label set
   (`--label k=v`, `registerWorker` in `lib/workers.mjs`), `placement` in agent
   definitions and RunSpec (`lib/planner.mjs`), claim-side filtering via
   `satisfiesPlacement` (`lib/workers.mjs`) in `claimNext` (`lib/worker.mjs`).
   Enforcement semantics are strictly claim-side filtering, not an external scheduler.
5. **Registry verification at claim** — **shipped (OPS-409)**: content-hash check
   on the worker via `verifyDefHash` (`lib/receipts.mjs`), evaluated in
   `lib/worker.mjs` before execution, with typed refusal (`agent_definition_mismatch`
   → `REFUSED`) and receipt attestation on definition drift.
6. **Chaining slice** — **shipped (OPS-223)**: discovered chaining via
   typed recommendations in output contracts (`edges.json`, `lib/chain.mjs`),
   re-entering the planner for watched proposals with per-edge earned automation
   (CI failure doctor: `ci-doctor@1` → `FLAKE|ENV → ci-rerun@1` / `TICKET → ci-notify@1`).

7. **Worker pool supervisor** — **shipped (WM-226)**: `cli.mjs supervise`
   scaling `work` processes between `workers.min` and `workers.max`
   (`config/policy.yaml`) on observed queue depth; `poolDecision` /
   `poolCounts` / `loadWorkerPolicy` in `lib/workers.mjs`, drain-file
   scale-down honoured at the worker's idle poll boundary (`work
--drain-file`), `factory up --workers min:max`, pool liveness in
   status/doctor. Weight-class caps (`heavy`/`light`, item 4's machinery) and
   the budget-aware ceiling (blocked on WM-66) are the explicit follow-ups.

Items 2, 4, 5, 6, and 7 are shipped and verified in the test suite. Item 1 is
now a concrete, sequenced protocol design rather than a database migration;
its server/client/auth/remote implementation and item 3 remain prerequisites
for multi-node distribution (Stage 2).

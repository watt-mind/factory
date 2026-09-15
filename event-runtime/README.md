# Event runtime (watched MVP)

Implementation of [docs/event-runtime.md](../docs/event-runtime.md) — an
isolated, opt-in sidecar that turns authenticated events into bounded,
verified, one-off agent runs. Slice 1: a read-only Linear status report.

**Isolation guarantees (§3):** nothing here touches `shared/`, `build/emit.mjs`,
`orchestrator/`, or any timer. Durable state lives in
`~/.factory/event-runtime/` (override with `FACTORY_EVENT_HOME`). Stopping the
runtime — or deleting its home directory — has no effect on skill invocation,
emit checks, queue scans, or ticket dispatch.

## Run it

```bash
bun event-runtime/cli.mjs serve          # control API (loopback) + planner + scheduler, foreground
bun event-runtime/cli.mjs serve --watch  # same, restart on event-runtime/ changes (dev; drops in-flight work)
bun event-runtime/cli.mjs work           # a worker: claim → execute → verify → publish
```

`serve` runs **no worker** — approving a proposal queues a run and nothing more
until a `work` process claims it (OPS-233). `serve --with-worker` restores the
all-in-one for a demo. Start `serve` first and let it reach `/health` before
starting `work`: on a brand-new database both processes race the WAL
journal-mode switch (OPS-376). `bin/worktree-up.sh` already sequences them.

## Dev live reload — `factory up --dev` (WM-213)

```bash
factory up --dev   # serve --watch + vite HMR web UI + drain-aware worker
factory tail       # all three logs, same as always
factory down       # stops all three, same as always
```

Plain `factory up` is untouched by this flag; `--dev` only swaps each of the
three daemons for its reloading twin.

The worker is the interesting one. A naive watch-restart would kill an agent
mid-dispatch, so the worker does **not** watch the filesystem: it records a
**code stamp** at startup (`git rev-parse HEAD` plus a content hash of
`event-runtime/lib/**` and `event-runtime/cli.mjs`, so uncommitted edits count)
and re-computes it **between claims**. On a change it exits `75` and
`bin/live-stack.sh __supervise-worker` re-execs it on the new code. If a run is
in flight the reload is latched and logged once —

```
code changed (a1b2c3d4e5f6:9f8e7d6c5b4a → a1b2c3d4e5f6:11223344aabb) — reload deferred until run_x finishes
```

— and taken at the next idle poll. A run in flight when code changes therefore
**finishes on the old code**, which is correct: its RunSpec and pins were made
under that code. Reload latency is bounded by the poll interval; a running
agent can never be interrupted by construction, because the idle check and the
reload are the same branch.

`bun event-runtime/cli.mjs work --reload-on-change` is the flag by itself, for
a worker you supervise some other way. `FACTORY_CODE_STAMP_ROOT` points the
stamp at a checkout other than the one the worker was started from.

**Which change needs which reload:**

| You changed                                                                                                                 | What reloads it                                                                                                                    | How fast                                        |
| :-------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
| `event-runtime/lib/**`, `event-runtime/cli.mjs`                                                                             | serve: `bun --watch` (in-flight planner work is dropped). worker: exit 75 at the next **idle** poll, then supervisor re-exec       | serve immediately; worker after the current run |
| `event-runtime/web/**`                                                                                                      | vite HMR — the open tab updates, no restart                                                                                        | immediate                                       |
| `agents/*.md`, `schemas/**`                                                                                                 | **neither** — definitions are read per plan/claim, but the pinned content hash is not. Run `bun event-runtime/cli.mjs update-pins` | on the next plan/claim after re-pinning         |
| `config/repos.yaml`                                                                                                         | the control API reads it for every request                                                                                         | hot; the next request sees it                   |
| `config/policy.yaml`                                                                                                        | most policy readers load lazily; the `models` tier map is captured with the registry                                               | hot except `models` (restart serve)             |
| `event-runtime/agents/*.json`, `event-runtime/event-types.json`, `event-runtime/edges.json`, `event-runtime/schedules.json` | loaded with the registry when `serve` starts                                                                                       | restart serve                                   |
| `config/nodes.yaml`, `config/schedule.yaml`                                                                                 | only the remote-worker CLI / launchd generator consumes these files                                                                | CLI-only; rerun the relevant command            |
| `bin/live-stack.sh` itself                                                                                                  | nothing — `factory down && factory up --dev`                                                                                       | manual                                          |

Two things `--dev` does not do: it does not restart the worker for an edit
under `event-runtime/web/**` (vite owns that), and it does not touch a run
already dispatched to an agent subprocess.

Operator verbs (clients of the control API — they need `serve` running):

```bash
bun event-runtime/cli.mjs status                      # events, proposals, runs, anomalies
bun event-runtime/cli.mjs events [status]             # admitted events, optionally filtered
bun event-runtime/cli.mjs ps [state]                     # running event processes/runs (default: RUNNING/LEASED)
bun event-runtime/cli.mjs runs [state]                   # event runs, optionally filtered by state
bun event-runtime/cli.mjs proposals                   # open proposals with TTL age
bun event-runtime/cli.mjs agents                      # registered agents and event routing
bun event-runtime/cli.mjs workers                     # worker processes: host, labels, state, heartbeat
bun event-runtime/cli.mjs schedule                    # recurring loops: cadence, last fire, next due
bun event-runtime/cli.mjs trace <run-id>              # live agent trace: assistant text, tool calls, usage
bun event-runtime/cli.mjs repos                       # factory repos: team, base, dispatch vs report-only
bun event-runtime/cli.mjs requeue <source> <event-id> # re-plan a dead-lettered/human_needed event
bun event-runtime/cli.mjs approve <proposal-id>
bun event-runtime/cli.mjs reject <proposal-id> "<reason>"
bun event-runtime/cli.mjs inject <envelope.json>      # replay CLI — same intake as the webhook
bun event-runtime/cli.mjs cancel <run-id>
bun event-runtime/cli.mjs retry <run-id> [--force]
bun event-runtime/cli.mjs inspect <run-id>            # spec, lifecycle journal, result, receipt
bun event-runtime/cli.mjs update-pins                 # re-pin agent definition content hashes
```

Webhook intake: `POST /events` with HMAC (`x-factory-signature: sha256=<hex>`
over `${x-factory-timestamp}.${raw body}`, secret from `FACTORY_EVENT_SECRET`).
No secret configured → webhooks are refused; the replay CLI still works.

## Web control plane

A second client of the same control API
([docs/event-runtime-webui.md](../docs/event-runtime-webui.md)) — a Linear-style
UI whose views are Overview (doctor deck and pipeline triage), Events,
Proposals, Runs, Agents, Workers, Projects, and the Graph canvas. Loopback
only, no auth by decision; `serve` must be running.

```bash
cd event-runtime/web && bun install && bun run build   # once, and after UI changes
bun event-runtime/web/serve.mjs                        # http://127.0.0.1:7382 (FACTORY_EVENT_WEB_PORT)
```

Dev loop: `cd event-runtime/web && bunx vite` (proxies /api to the control
API), or `factory up --dev` to get it wired into the whole stack — see
[Dev live reload](#dev-live-reload--factory-up---dev-wm-213). Keyboard-first: `⌘K` palette, `g` + a view letter to navigate (the armed
prefix shows on screen), `j/k` + `Enter` on lists, `a`/`x` to approve/reject the
selected proposal, `?` for the full legend.

## Scheduled loops (OPS-381)

A tick is an **event**, not a job (docs/event-runtime-schedules.md). `serve`
emits `clock.tick.<loop>` on a cadence and the ordinary intake → planner →
proposal path takes over, so a recurring job gets the same dedup, audit
trail, and approval gate as a webhook. `config/schedule.yaml`, launchd, and
the orchestrator are untouched — this is a second, independent mechanism.

```jsonc
// event-runtime/schedules.json
"reaper": { "every": "60m", "eventType": "clock.tick.reaper",
            "catchUp": "none", "singleton": true,
            "approval": "watched", "enabled": false }
```

- **Slots, not instants.** `eventId = clock:<loop>:<slot>`, so restarting
  `serve` three times in one interval admits one tick.
- **Catch-up** is declared per loop: `none` (default — one reaper now is what
  six would have achieved, and the tick records how many slots it stands
  for), `last`, or `all`.
- **Singleton**: a loop whose previous run is still in flight plans a typed
  NOOP (`previous_run_in_flight`), never a backlog.
- **Approval is earned**: `watched` by default; `approval: auto` records
  `actor: "schedule"` in the journal — never `"operator"`, because a run
  nobody looked at must not be indistinguishable from one a human approved.
- **Deterministic commands first** (§3 capacity): the reaper is
  `orchestrator/reaper.mjs`, not an LLM — a scheduled agent would draw on the
  same unobservable usage window as interactive sessions.

`cli.mjs schedule` shows cadence, last fire, next due and whether a loop has
stopped; an enabled loop silent for more than two intervals is a doctor
anomaly, because silence is the failure mode a scheduler must not have. The
shipped `reaper` loop is `enabled: false`: switching it on is a deliberate
act.

## Artifact inputs (OPS-372)

Agents consume prior runs' artifacts **declared and materialized, never
pulled**: a spec names artifacts by content hash (resolved at plan time, so
they land in `inputHash` and the receipt), and the `artifacts` workspace
provider writes those bytes into the workspace before the agent starts. There
is deliberately no "browse the store" API — that would make `inputHash` a lie
about what a run read and hand agents ambient access to everything ever
produced.

```jsonc
"workspace": { "type": "artifacts", "inputs": [{ "from": "$.input.logArtifact", "as": "failed.log" }] }
```

A chain passes the **hash**, not the bytes: `$.artifactHash.<kind>` in an edge
resolves against the upstream result's stored artifacts. Producers declare
them the usual way; a command-adapter definition can set `captureStdout` to
keep a command's whole output (a CI log is useless truncated to the 2000-char
tail the evidence field keeps).

Retention: artifacts referenced by an accepted result are never deleted, and
store size/orphan counts appear in `status`. Unreferenced artifacts older than
7 days are pruned hourly by `serve`. A run's materialized inputs are capped
(64 MB) so one agent cannot fill the disk another agent then gets called to
clean up.

First chain: `github.workflow-run.failed` → `ci-log-capture@1` (stores the
failed-job log) → `ci-doctor@2` reads `./failed.log` instead of calling
GitHub — the diagnosis is reproducible against exactly those bytes, and a
multi-megabyte log lives in the store rather than blowing the inline-evidence
limit.

**Cross-run references (OPS-373).** An artifact need not come from the same
chain. `factory.run-postmortem.requested {runId}` → `run-postmortem@1` reads
`./transcript.json`, the _earlier_ run's captured transcript: the planner
resolves that run's stored artifact into `input.runPin` at plan time, so the
operator approves a run pinned to specific bytes rather than "whatever that
run's transcript is by the time this executes". A run that never stored a
transcript, or an unknown run id, parks `human_needed` with that exact reason
instead of proposing a run over nothing.

## Discovered chains (OPS-223)

Agents never spawn agents: a completed run whose artifact carries a typed
recommendation (per `edges.json`) emits an internal event through the same
intake — `eventId chain-<runId>` (once per run, ever), `correlationId`
inherited, `causationId` = the source run — and the planner proposes the
follow-up, **watched like everything else**. First chain, three nodes deep:
`github.workflow-run.failed` routes to `ci-log-capture@1` (so the diagnosis
reads pinned bytes rather than re-fetching from GitHub — OPS-372), which chains
to `ci-doctor@2`, which recommends either `FLAKE|ENV → ci-rerun@1` (closed
command template `gh run rerun … --failed`, once-per-run by idempotency) or
`TICKET → ci-notify@1` (`factory notify "CI RED …"`). Mutating definitions
are admitted only as closed command templates (`lib/adapters/command.mjs`) —
enforceable by construction, no shell, no model (§14).

## Slice 2: disk alert → diagnose → approved remediation (OPS-208)

`keephq.disk-alert.raised` (payload `{host, mount, usedPct, alertId}`; dedup
on host+alertId via subject+correlationId) → `disk-diagnose@1` re-measures
the disk over read-only SSH — a webhook is a hint, not truth — and produces a
typed plan: `NOOP` (stale alert, chain ends) or `REMEDIATE` with action IDs
from the closed registry. The REMEDIATE edge chains to `disk-remediate@1`
(actions adapter): the operator approves the **concrete action list**, the
executor resolves IDs to fixed remote commands (`docker builder prune`,
`docker system prune`, `journalctl --vacuum-time=3d`) over SSH to the host
allowlist (`lab`, `web`), probes `df` before/after, and the verifier
**recomputes reclaimed bytes from the probe evidence** — a claim that does
not match is a ContractViolation, not a success. An unregistered action ID
refuses before executing anything.

## Repository workspaces and the triage chain (OPS-228/OPS-229)

`workspace.type: "repository"` gives an agent a **read-only** source tree:
a bare mirror per repo (`<home>/mirrors/<repo>.git`, fetched at plan time),
and per run a detached worktree at the SHA the planner pinned into
`input.repoPin`. No install, no ports — reading code needs neither. Repo
facts come from the factory's own `config/repos.yaml`
(`FACTORY_REPOS_ROOT` to point elsewhere); the operator's live checkout is
never touched. Full worktrees for _coding_ tasks are deliberately not built —
see [workers doc §5a](../docs/event-runtime-workers.md).

First consumer: `factory.triage.requested` → `triage-scan@1` reads the pinned
tree plus Linear and emits a typed plan (`TRIAGE` with per-issue actions from
a closed set, or `NOOP`) → the chain proposes `triage-apply@1` → the operator
approves the **concrete per-issue action list** → the actions adapter's
item-list mode resolves each action id to one fixed `tools/ticket.mjs`
invocation. An unregistered action id refuses before applying anything,
including the valid items beside it.

## Demo environments and e2e (OPS-217)

`bin/worktree-up.sh` provisions an **isolated, seeded** runtime — the part
`git worktree add` cannot do: own ports, own `FACTORY_EVENT_HOME`, fake
adapter (approvals never spawn a real agent), and deterministic demo data.

```bash
bin/worktree-up.sh --here        # demo env in this checkout → 7391 (API) / 7392 (web)
bin/worktree-up.sh OPS-123       # ticket worktree + branch feat/OPS-123, own ports
bin/worktree-down.sh --here      # stop + delete this checkout's demo state
bin/worktree-down.sh OPS-123     # stop daemons, remove the worktree (branch stays)
```

Port allocation (so instances never collide):

| Instance                      | API                      | Web     |
| :---------------------------- | :----------------------- | :------ |
| interactive default (`serve`) | 7381                     | 7382    |
| `--here` demo                 | 7391                     | 7392    |
| ticket worktree               | dynamic (7400–7798 band) | API + 1 |

Ticket worktrees hash the ticket ID into a preferred even port in the 7400–7798
band, scanning forward for the first free slot and persisting the assigned ports
in `.factory/run/ports` (OPS-460). Operators should check the startup banner
or `.factory/run/ports` rather than calculating fixed offsets.

The seed (`event-runtime/demo/seed.mjs`) drives one of everything through the
real intake/approval surfaces, using the fake adapter's input modes
(`payload.repos[0]`): `ok` → COMPLETED, `refuse` → REFUSED, `crash` and
`invalid-artifact` → FAILED, a rejected proposal → CANCELLED, `[]` → an open
`human_needed` proposal, one open approvable proposal, and `hang` → a RUNNING
run approved last (it occupies the single worker until the 600 s spec timeout,
then TIMED_OUT — or cancel it from the UI). The seed refuses to run against a
real-adapter runtime.

Some of those rows additionally carry a real `config/repos.yaml` name so the
project tabs are not empty on a fresh worktree. The tag is appended after the
mode — `repos[0]` is still what selects the fake adapter's behaviour. The
tagged fixtures are the completed `ok` run, the rejected proposal, the open
approvable proposal, and the `hang` run; `refuse`, `crash`,
`invalid-artifact`, and the `human_needed` proposal stay untagged because a
tab that matches every row proves nothing about filtering. Names come from
the running server's `GET /repos` endpoint (the same list the UI's project
tabs offer), not the seeder checkout's local registry; a server without a
readable registry logs `no repo registry (...) — seeding without project tags`
and seeds the full set untagged.

`event-runtime/demo/verify.mjs --port <api>` asserts the whole fixture via
the API — the e2e smoke. `worktree-up.sh` runs it before reporting ready, so
"ready" means a browser test or styling session can rely on every state
being present. Re-seed after consuming fixture state with
`bin/worktree-up.sh <target> --reseed`.

## Try the slice

```bash
cat > /tmp/status-report.json <<'EOF'
{
  "schemaVersion": "factory.event/v1",
  "eventId": "manual-001",
  "type": "factory.status-report.requested",
  "source": "replay-cli",
  "subject": "factory",
  "occurredAt": "2026-08-12T10:30:00Z",
  "correlationId": "manual-001",
  "payload": { "repos": ["bj29"] }
}
EOF
bun event-runtime/cli.mjs inject /tmp/status-report.json
bun event-runtime/cli.mjs proposals        # → approve <id>
bun event-runtime/cli.mjs approve <id>
bun event-runtime/cli.mjs runs             # QUEUED until a worker claims it
```

Approval queues the run; it stays `QUEUED` until a `cli.mjs work` process is
running, so start one in a second terminal (or use `serve --with-worker`).
`cli.mjs trace <run-id>` follows the agent live, and `cli.mjs inspect <run-id>`
prints the spec, journal, result and receipt once it lands.

Injecting the same envelope twice is safe: one admission, one proposal, one run
(§5.4). Approval after the proposal TTL re-plans instead of executing a stale
spec (§12).

## Layout

| Path                                     | What                                                                                                                                                                      |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/config.mjs`                         | paths, port, secrets, policy version                                                                                                                                      |
| `lib/canonical.mjs` `lib/schema.mjs`     | canonical JSON + hashes; fail-closed schema validation                                                                                                                    |
| `lib/db.mjs`                             | SQLite substrate (§10): events, proposals, runs, attempts, journal, results, outbox                                                                                       |
| `lib/lifecycle.mjs`                      | closed FSM (§8); every transition journaled                                                                                                                               |
| `lib/registry.mjs`                       | agent definitions pinned by content hash (§6)                                                                                                                             |
| `lib/intake.mjs`                         | HMAC verification + idempotent admission (§5.1, §14)                                                                                                                      |
| `lib/planner.mjs`                        | deterministic plan(event) → NOOP \| HUMAN_NEEDED \| RunSpec (§4, §5.4)                                                                                                    |
| `lib/proposals.mjs`                      | watched approval, TTL, re-plan on expiry (§12)                                                                                                                            |
| `lib/workspace.mjs`                      | ephemeral workspaces, path confinement (§7)                                                                                                                               |
| `lib/worker.mjs`                         | worker loop: claim under `BEGIN IMMEDIATE`, lease, execute, verify, publish with fencing (§8)                                                                             |
| `lib/verify.mjs`                         | result verification + compact receipts (§9)                                                                                                                               |
| `lib/adapters/`                          | adapter registry (§6): `claude` (LLM), `pi` (LLM), `agy` (LLM), `command` (closed argv template), `actions` (approved action list → closed registry), `fake` (tests/demo) |
| `lib/artifacts.mjs`                      | content-addressed store: collect, stream via `GET /artifacts/:sha256`, materialize declared inputs, retention (OPS-372)                                                   |
| `lib/schedules.mjs` `schedules.json`     | clock ticks: slots, catch-up, singleton, earned auto-approval (OPS-381)                                                                                                   |
| `lib/workers.mjs`                        | worker registry, heartbeats, placement predicate (OPS-233)                                                                                                                |
| `lib/repos.mjs` `lib/repository.mjs`     | repos.yaml reader; mirror + pinned read-only checkout (OPS-228)                                                                                                           |
| `lib/adapters/actions.mjs`               | closed action-list executor: approved action IDs → fixed SSH commands, probe evidence (OPS-208)                                                                           |
| `lib/chain.mjs` `edges.json`             | discovered chains: typed recommendation → internal event → watched proposal (OPS-223)                                                                                     |
| `lib/adapters/command.mjs`               | closed-template command executor — the only admissible mutating agent form (§14)                                                                                          |
| `lib/trace.mjs`                          | live agent trace: `factory.trace/v1` records from the claude stream (OPS-295)                                                                                             |
| `lib/outbox.mjs`                         | transactional outbox: publish receipts after the run's transaction commits (§10)                                                                                          |
| `lib/api.mjs` `cli.mjs` `lib/client.mjs` | loopback control API, CLI client, and the shared HTTP client (§12–§13)                                                                                                    |
| `web/`                                   | web control plane: Vite/React app + `serve.mjs` static/proxy server                                                                                                       |
| `demo/`                                  | seeded one-of-everything fixture + e2e verify (OPS-217, see above)                                                                                                        |
| `agents/` `schemas/` `event-types.json`  | registered agents, contracts, event→agent mappings                                                                                                                        |

## Capabilities are audited, not enforced (§14)

`linear:read` is a validated, recorded declaration — the MVP has no sandbox and
no scoped credentials. Enforcement arrives with the egress proxy / container
provider. Until then the watched approval gate and read-only agent prompts are
the actual containment.

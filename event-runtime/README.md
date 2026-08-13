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
bun event-runtime/cli.mjs serve          # control API (loopback) + planner + one worker, foreground
bun event-runtime/cli.mjs serve --watch  # same, restart on event-runtime/ changes (dev; drops in-flight work)
```

Operator verbs (clients of the control API — they need `serve` running):

```bash
bun event-runtime/cli.mjs status                      # events, proposals, runs, anomalies
bun event-runtime/cli.mjs events [status]             # admitted events, optionally filtered
bun event-runtime/cli.mjs ps [state]                     # running event processes/runs (default: RUNNING/LEASED)
bun event-runtime/cli.mjs runs [state]                   # event runs, optionally filtered by state
bun event-runtime/cli.mjs proposals                   # open proposals with TTL age
bun event-runtime/cli.mjs agents                      # registered agents and event routing
bun event-runtime/cli.mjs workers                     # worker processes: host, labels, state, heartbeat
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
([docs/event-runtime-webui.md](../docs/event-runtime-webui.md)) — Linear-style
UI over proposals, runs, and the doctor view. Loopback only, no auth by
decision; `serve` must be running.

```bash
cd event-runtime/web && bun install && bun run build   # once, and after UI changes
bun event-runtime/web/serve.mjs                        # http://127.0.0.1:7382 (FACTORY_EVENT_WEB_PORT)
```

Dev loop: `cd event-runtime/web && bunx vite` (proxies /api to the control
API). Keyboard-first: `⌘K` palette, `g o/p/r` to navigate, `j/k` + `Enter` on
lists, `a`/`x` to approve/reject the selected proposal.

## Discovered chains (OPS-223)

Agents never spawn agents: a completed run whose artifact carries a typed
recommendation (per `edges.json`) emits an internal event through the same
intake — `eventId chain-<runId>` (once per run, ever), `correlationId`
inherited, `causationId` = the source run — and the planner proposes the
follow-up, **watched like everything else**. First chain: `ci-doctor@1`
diagnoses a failed GitHub Actions run (`github.workflow-run.failed`) and
recommends `FLAKE|ENV → ci-rerun@1` (closed command template
`gh run rerun … --failed`, once-per-run by idempotency) or
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
never touched. Full worktrees for *coding* tasks are deliberately not built —
see [workers doc §5a](../docs/event-runtime-workers.md).

First consumer: `factory.triage.requested` → `triage-scan@1` reads the pinned
tree plus Linear and emits a typed plan (`TRIAGE` with per-issue actions from
a closed set, or `NOOP`) → the chain proposes `triage-apply@1` → the operator
approves the **concrete per-issue action list** → the actions adapter's
item-list mode resolves each action id to one fixed `tools/linear.mjs`
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

| Instance | API | Web |
| :--- | :--- | :--- |
| interactive default (`serve`) | 7381 | 7382 |
| `--here` demo | 7391 | 7392 |
| ticket worktree | 7400 + 2·(ticket % 200) | API + 1 |

The seed (`event-runtime/demo/seed.mjs`) drives one of everything through the
real intake/approval surfaces, using the fake adapter's input modes
(`payload.repos[0]`): `ok` → COMPLETED, `refuse` → REFUSED, `crash` and
`invalid-artifact` → FAILED, a rejected proposal → CANCELLED, `[]` → an open
`human_needed` proposal, one open approvable proposal, and `hang` → a RUNNING
run approved last (it occupies the single worker until the 600 s spec timeout,
then TIMED_OUT — or cancel it from the UI). The seed refuses to run against a
real-adapter runtime.

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
```

Injecting the same envelope twice is safe: one admission, one proposal, one run
(§5.4). Approval after the proposal TTL re-plans instead of executing a stale
spec (§12).

## Layout

| Path | What |
| :--- | :--- |
| `lib/config.mjs` | paths, port, secrets, policy version |
| `lib/canonical.mjs` `lib/schema.mjs` | canonical JSON + hashes; fail-closed schema validation |
| `lib/db.mjs` | SQLite substrate (§10): events, proposals, runs, attempts, journal, results, outbox |
| `lib/lifecycle.mjs` | closed FSM (§8); every transition journaled |
| `lib/registry.mjs` | agent definitions pinned by content hash (§6) |
| `lib/intake.mjs` | HMAC verification + idempotent admission (§5.1, §14) |
| `lib/planner.mjs` | deterministic plan(event) → NOOP \| HUMAN_NEEDED \| RunSpec (§4, §5.4) |
| `lib/proposals.mjs` | watched approval, TTL, re-plan on expiry (§12) |
| `lib/workspace.mjs` | ephemeral workspaces, path confinement (§7) |
| `lib/worker.mjs` | single worker: lease, execute, verify, publish with fencing (§8) |
| `lib/verify.mjs` | result verification + compact receipts (§9) |
| `lib/adapters/` | adapter registry: `claude` (real), `fake` (tests) (§6) |
| `lib/workers.mjs` | worker registry, heartbeats, placement predicate (OPS-233) |
| `lib/repos.mjs` `lib/repository.mjs` | repos.yaml reader; mirror + pinned read-only checkout (OPS-228) |
| `lib/adapters/actions.mjs` | closed action-list executor: approved action IDs → fixed SSH commands, probe evidence (OPS-208) |
| `lib/chain.mjs` `edges.json` | discovered chains: typed recommendation → internal event → watched proposal (OPS-223) |
| `lib/adapters/command.mjs` | closed-template command executor — the only admissible mutating agent form (§14) |
| `lib/artifacts.mjs` | content-addressed artifact/transcript store, streamed via `GET /artifacts/:sha256` |
| `lib/api.mjs` `cli.mjs` | loopback control API + CLI client (§12–§13) |
| `web/` | web control plane: Vite/React app + `serve.mjs` static/proxy server |
| `demo/` | seeded one-of-everything fixture + e2e verify (OPS-217, see above) |
| `agents/` `schemas/` `event-types.json` | registered agents, contracts, event→agent mappings |

## Capabilities are audited, not enforced (§14)

`linear:read` is a validated, recorded declaration — the MVP has no sandbox and
no scoped credentials. Enforcement arrives with the egress proxy / container
provider. Until then the watched approval gate and read-only agent prompts are
the actual containment.

# Event runtime: scheduled clock events

Status: **implemented** (OPS-381). Tracking: OPS-380 (this spec), OPS-381
(implementation), WM-112 (repo loops §12, GitHub webhook intake §13), WM-328
(gated launchd bridge and Factory rollout §15).
Parent: [event-runtime.md](event-runtime.md) §2 (`clock.tick.<loop>`), §3
(isolation and capacity), §5.4 (idempotency), §12 (approval).

Driving case: run the factory reaper every 60 minutes without a bare launchd
job — as an admitted, audited event with the same planning, approval history,
and audit trail as a webhook.

---

## 1. What this changes, said out loud

§3's MVP rules currently forbid the runtime to "enable launchd, cron, or
another unattended timer", and architecture.md §2.7 keeps every job in
`config/schedule.yaml` disabled on purpose: *the factory runs in the
foreground, watched, and when it is not running nothing is running.* That
policy exists because the reaper has already demonstrated it can act on 31
tickets from one bad predicate.

Building this moves that boundary, so the move is stated rather than
absorbed:

- A tick becomes an **event**, not a job. It is admitted, deduplicated,
  planned, and — by default — **proposed for approval** like anything else.
  A schedule that fires while nobody approves produces a queue of proposals,
  not a queue of actions.
- Automation is **earned per loop**, never global (§2's rule applied to
  clock events). A loop starts watched; auto-approval is a deliberate,
  recorded decision after it has been observed.
- `config/schedule.yaml` and launchd remain the host clock/gate registry, but
  their apply commands admit typed events instead of launching agents or
  mutating orchestrator scripts. The runtime still never edits or installs
  those timers; `deploy/gen.mjs` is the one-way renderer and operator action
  remains the deployment boundary. See §15 for the first enabled floor.

## 2. Who fires the tick

Native runtime schedules fire **in the `serve` process**, which already runs a
one-second loop for planning and outbox publication. The gated compatibility
bridge in §15 is deliberately narrower: launchd supplies a cold-start clock,
the existing cheap gate decides whether admission is useful, and the command
only posts an ordinary event to the running `serve` process. Rejected as the
primary runtime scheduler:

- **External cron/launchd directly running work** — reintroduces the bare job
  the design rejects. The §15 bridge is acceptable only because it performs no
  work itself: gate output is in launchd logs and accepted events, proposals,
  and runs remain visible in the runtime journal.
- **A separate scheduler process** — more moving parts for something that is
  one timer and one `admitEvent` call, and a third process to supervise.

The worker is *not* involved: it claims runs, and a scheduled run is an
ordinary run. `serve` restarting mid-interval must not lose or duplicate a
tick, which §3 makes cheap — see slots.

## 3. Slots: the idempotency rule that makes restarts safe

A tick's identity is the **schedule slot**, never the instant it was emitted:

```
eventId:  clock:<loop>:<slot start, ISO-8601 UTC>
type:     clock.tick.<loop>
source:   schedule
payload:  { loop, slot, cadenceSeconds }
```

The slot is the interval floor: with `every: 60m`, `21:00:00Z`, `22:00:00Z`,
and so on. Consequences, all falling out of §5.1 dedup rather than new code:

- `serve` restarting three times in one hour fires **one** reaper tick.
- Two `serve` processes (a mistake, but survivable) converge on one run.
- A slot is either admitted or it is not — "did it fire?" is answerable from
  the events table, not from log archaeology.

Idempotency scope for the run (§5.4) is the loop plus the slot, so an
approved tick and a replayed one converge on the same run.

## 4. Missed slots: catch-up is a declared policy

A laptop asleep from 22:00 to 04:00 misses six hourly slots. There is no
universally right answer, so each loop declares one:

| `catchUp` | Behaviour | Use for |
| :--- | :--- | :--- |
| `none` (default) | Fire only the current slot; missed ones are recorded as skipped | Idempotent maintenance — running the reaper once now is equivalent to running it six times |
| `last` | Fire the most recent missed slot, then resume | Loops where one late run still has value |
| `all` | Fire every missed slot in order | Anything that accumulates per-interval work; rare, and expensive by construction |

The count of skipped slots travels on the tick that did fire
(`payload.skippedSlots`), and `serve` logs it — so a six-hour gap reads as one
run standing for six slots rather than as silence. There is no separate journal
record per skipped slot.

## 5. Overlap: a loop is a singleton by default

If the previous run of a loop is still in flight when the next slot arrives,
the planner returns a typed **NOOP** with reason `previous_run_in_flight`
instead of queueing a second. A reaper that takes 70 minutes must not
accumulate a backlog of reapers. `singleton: false` exists for loops that
genuinely may overlap; nothing today wants it.

## 6. Approval: watched first, earned per loop

The default is the §12 gate: a tick produces a proposal, and nothing runs
until it is approved. That is correct for a new loop and absurd for a
long-trusted one — 24 approvals a day to reap stale claims is how an operator
learns to click approve without reading.

So each loop declares its policy, and it is **earned**:

```yaml
approval: watched        # every tick proposes; the operator approves  (default)
approval: auto           # the scheduler approves; recorded as such
```

Two rules make `auto` safe to have at all:

1. **The actor is the truth.** An auto-approved run records
   `actor: "schedule"` in the lifecycle journal — never `"operator"`. A run
   nobody looked at must never be indistinguishable from one a human
   approved; that distinction is the whole audit trail.
2. **`auto` is a registry declaration**, versioned and diffable in git like
   an agent definition — not a UI toggle, not an env var.

Recommended earning path, mirroring §2: watched for a week → read the run
history → flip to `auto` in a reviewable commit. A mutating loop may simply
never earn it.

## 7. What a scheduled loop actually runs

The reaper is `orchestrator/reaper.mjs` — a script, not an agent. So the
first scheduled loops are **deterministic command nodes** (the command
adapter, OPS-223), not LLM agents:

```json
{
  "id": "reaper",
  "version": 1,
  "command": ["bun", "{factoryRoot}/orchestrator/reaper.mjs", "--apply"],
  "captureStdout": "reaper.log",
  "output_contract": "factory.command-result/v1",
  "mutating": true
}
```

This matters for §3's capacity rule: every claude-adapter run draws on the
same unobservable subscription usage window as interactive sessions, so a
scheduled *LLM* loop can starve the operator's own work on a timer. A
deterministic loop cannot. **Deterministic-command loops ship first**;
scheduling an LLM agent is a separate decision with the usage-window question
answered, not a config edit.

Because the reaper is `mutating: true`, it is admissible only as a closed
command template — which it is — and `--apply` versus a dry run is visible in
the registry rather than hidden in a plist.

## 8. Where schedules are declared

`event-runtime/schedules.json`, beside `event-types.json` and `edges.json`,
pinned and validated at load like every other registry file:

```json
{
  "reaper": {
    "every": "60m",
    "eventType": "clock.tick.reaper",
    "catchUp": "none",
    "singleton": true,
    "approval": "watched",
    "enabled": false
  }
}
```

`clock.tick.reaper` is an ordinary registered event type mapping to
`reaper@1` — the scheduler emits events, the planner routes them, and neither
knows anything special about the other.

**Intervals, not cron expressions.** `every: 60m` has no timezone, no DST
discontinuity, and no "what does 02:30 mean on the night the clocks go
forward". If a loop genuinely needs "daily at 09:00 Europe/Budapest", that is
a later addition with its timezone declared explicitly — not a default.

Validation fails closed: an unregistered `eventType`, an unparseable
`every`, or `approval: auto` on a loop with no `enabled: true` is a load
error, not a surprise at 03:00.

## 9. Visibility and doctor checks

- **`cli.mjs schedule`** / `GET /schedules`: each loop, cadence, approval
  policy, last slot fired, next slot due, last outcome, and whether it is
  enabled. The question "is the reaper actually running?" must have a
  one-command answer.
- **Doctor anomaly — a loop that stopped.** No admitted tick for more than
  two intervals while enabled means the clock is not turning (serve down,
  machine asleep, a bad `every`). Silence is the failure mode a scheduler
  must never have, and it is the one a launchd plist gives you.
- **Not built yet — proposals piling up.** A watched loop with more than N
  open proposals is either mis-cadenced or nobody is watching it. Worth saying,
  and not implemented (see also OPS-436: an unapproved first proposal silences
  the loop entirely).

## 10. Exit criteria

- Restarting `serve` repeatedly within one interval produces exactly one
  admitted tick for that slot.
- A `watched` loop produces a proposal per slot and runs nothing until
  approved; an `auto` loop runs with `actor: "schedule"` in the journal, and
  no run anywhere claims an operator approved something they did not.
- A loop whose previous run is in flight records a NOOP with
  `previous_run_in_flight`, not a second queued run.
- Six missed slots under `catchUp: none` produce one run and five recorded
  skips.
- Disabling a native loop in the registry stops its in-process ticks. A §15
  bridge loop is independently controlled by its reviewed `enabled` flag and
  rendered plist; neither mechanism edits the other's configuration.
- `cli.mjs schedule` answers "is it running, when did it last fire, what
  happened", and a stopped clock raises a doctor anomaly.

## 11. Implementation cut-lines

1. **Schedule registry + validation** — `schedules.json`, load-time checks,
   `GET /schedules`, `cli.mjs schedule`.
2. **Tick emission in `serve`** — slot computation, `admitEvent` per due
   slot, catch-up policy, skip records.
3. **Singleton + NOOP planning** for a loop already in flight.
4. **Earned auto-approval** — `approval: auto` with `actor: "schedule"`
   throughout the lifecycle and proposal records.
5. **`reaper@1` definition** and the first watched week.
6. **Doctor checks** — stopped clock, proposal pile-up.

1–3 are the substance; 4 is the one that changes what the runtime is allowed
to do unattended and deserves its own review.

## 12. Repo loops: work, merge, ship (WM-112)

The chains only make a **loop** once events arrive without a human injecting
them. The heartbeat half is schedules: for every repo in `config/repos.yaml`
that is **not** `report_only` (today: `bj29`, `wm-home`, `legalease`,
`cashsaas` — the dispatch doc's §5 rule keeps report-only repos out), three
per-repo entries in `schedules.json`:

| Loop | Cadence | Fires | Chain it heads |
| :--- | :--- | :--- | :--- |
| `work-<repo>` | `30m` | `factory.work.requested {repo}` | work-scan → dispatch (WM-110/108) |
| `merge-<repo>` | `30m` fallback (`merge-factory`: `15m`) | `factory.merge.requested {repo}` | full-set sweep → merge-scan → merge-apply / escalate (WM-109/WM-576) |
| `ship-<repo>` | `7d` | `factory.ship.requested {repo}` | ship-scan → human-only ship-apply (WM-111) |

Every entry ships `enabled: false`, `approval: "watched"`, `singleton: true`,
`catchUp: "none"`. Switching a loop on is a deliberate, per-loop operator act
in a reviewable commit — the §6 earning path applies unchanged, and
`approval: auto` appears nowhere (the ship chain's apply step could never
earn it anyway: the registry fails closed on `auto` against a
`humanApprovalOnly` type, WM-111).

Notes, stated rather than absorbed:

- **There are no offsets.** §8 is intervals only; a slot is the epoch floor,
  so `work-<repo>` and `merge-<repo>` at `30m` tick on the same boundary.
  That is safe by construction — each loop is a singleton, each tick is a
  watched proposal, and merges serialize downstream — so staggering is a
  cosmetic nicety this mechanism deliberately does not have.
- **The latency half is event-driven**, not the sweep clock: `dispatch@1`
  outcome `PR_OPEN` fans out to both `factory.work.requested {repo}` and
  `factory.merge.requested {repo, prNumbers: [prNumber]}` (edges.json,
  WM-576), while `NOT_CLAIMED` only re-fires work. A successful pull-request
  `workflow_run` re-fires the same scoped merge request for its exact PR/head.
  The 15-minute Factory sweep catches missed webhook deliveries and
  human-opened PRs. `FAILED` and `BLOCKED` terminate — a run that needs a human
  must not spin either scanner.
- **Tick payloads validate (WM-112's known gap, fixed by WM-123).** A tick's
  payload carries `{loop, slot, cadenceSeconds, skippedSlots}` alongside the
  static `{repo}`. Every loop-target input schema whitelists those
  bookkeeping fields the way `schemas/repo-loop.input.json` always did — the
  three scan schemas (`work-scan`, `merge-scan`, `ship-scan`) gained them in
  WM-123, with the agents' definitions re-pinned — so an enabled loop's tick
  plans an ordinary watched proposal (`loop.test.mjs` proves one real run per
  loop head). Webhook and injected events (whose payloads are exactly
  `{repo}`) validate unchanged.
- **Doctor coverage is automatic.** The §9 silent-loop anomaly
  (`stoppedSchedules` in `GET /status`) iterates `schedules.json` via
  `scheduleView`, so the twelve new loops are covered without any change to
  the doctor.

## 13. GitHub webhook intake (WM-112)

The other half of closing the loop: GitHub deliveries, translated at the
intake boundary into ordinary `factory.event/v1` envelopes. The design
decision, made against the code: intake's structure allowed a clean seam
(option *a* of WM-112), so verification and translation live in
`lib/intake.mjs` (`verifyGitHubWebhook`, `translateGitHubEvent`) and only the
route — `POST /github` — sits in `lib/api.mjs`, because intake has no HTTP
layer. The factory-envelope path on `POST /events` is byte-for-byte
unchanged.

**The contract:**

- **Path**: `POST /github` (GitHub webhook "Content type:
  application/json").
- **Headers**: `X-GitHub-Event` (kind), `X-GitHub-Delivery` (delivery GUID),
  `X-Hub-Signature-256` (GitHub's `sha256=<hex>` HMAC over the raw body).
  Ordinary deliveries use the GUID as `eventId`; successful pull-request
  workflows use `merge-pr:<repo>:<pr>:<headSha>` so redeliveries and duplicate
  green notifications converge on one scoped review.
- **Secret**: `FACTORY_GITHUB_WEBHOOK_SECRET`, dedicated on purpose — GitHub
  signs raw-body-only with no timestamp, and one secret across two signature
  schemes would let a capture from the weaker scheme replay against the
  stronger. Absent secret disables the route, like the factory path.
- **No signed timestamp** exists in GitHub's scheme, so there is no staleness
  window; replay of a captured delivery is bounded by delivery-ID dedup
  instead (a replay answers `duplicate: true` and admits nothing).

**Translations** — minimal and typed; anything else refuses:

| Delivery | Condition | Envelope |
| :--- | :--- | :--- |
| `pull_request` | action `opened`/`synchronize`/`ready_for_review`, base ref = the configured repo's `base`, repo not `report_only` | `factory.merge.requested`, subject + payload `{repo}` (short name) |
| `workflow_run` | action `completed`, conclusion `success`, event `pull_request`, exactly one PR targeting the configured base, repo not `report_only` | `factory.merge.requested`, payload `{repo, prNumbers: [N]}`, idempotent as `merge-pr:<repo>:<pr>:<headSha>` |
| `workflow_run` | action `completed`, conclusion `failure`, repo configured (`report_only` included) | `github.workflow-run.failed`, subject `ci`, payload `{repo: owner/name slug, runId}` — the existing shape ci-log-capture consumes |

**Refusal cases**, following intake's typed-refusal conventions:

- `401 {error}` — missing/bad signature, missing secret. Nothing parsed,
  nothing written.
- `200 {admitted: false, ignored: true, reason}` — benign non-events, so
  GitHub never marks the hook failing: `unhandled_event` (ping and every
  other kind), `unhandled_action` (closed PRs and non-completed runs),
  `not_pull_request_head`, `unconfigured_repo` (no `github:` match in
  repos.yaml), `not_base_branch`, `repo_report_only` (CI failures still flow for
  report-only repos; merge requests never do).
- `422 {errors}` — malformed deliveries that deserve a failure:
  `missing_delivery_id`, `malformed_payload`, `ambiguous_pull_request_head`,
  invalid JSON.

**Replay-CLI parity.** Every webhook kind has an injected equivalent through
`cli.mjs inject` (same intake, no signature, loopback only) — which is also
the offline test rig:

```jsonc
// pull_request → merge chain          // workflow_run failure → CI chain
{                                      {
  "schemaVersion": "factory.event/v1",   "schemaVersion": "factory.event/v1",
  "eventId": "gh-replay-1",              "eventId": "gh-replay-2",
  "type": "factory.merge.requested",     "type": "github.workflow-run.failed",
  "source": "github",                    "source": "github",
  "subject": "bj29",                     "subject": "ci",
  "occurredAt": "<now>",                 "occurredAt": "<now>",
  "correlationId": "gh-replay-1",        "correlationId": "gh-replay-2",
  "payload": { "repo": "bj29" }          "payload": { "repo": "watt-mind/bakonszegi-coaching", "runId": 12345 }
}                                      }
```

## 14. The loop, end to end (demo walkthrough)

The whole circuit, on the local fake-adapter runtime (`event-runtime/demo/`,
port 7522 — a demo, never a test dependency), or any watched environment:

1. **Ticket becomes ready** → inject `factory.work.requested {repo}` (or let
   an enabled `work-<repo>` slot fire it; a finished dispatch re-fires it by
   itself via the completion edge).
2. **work-scan proposal** appears in the inbox — the typed DISPATCH plan with
   its Owned Paths evidence. **Approve.**
3. **(fake) dispatch** runs: claim → worktree by delegation → PR → the
   `factory.dispatch-result/v1` artifact. Its `PR_OPEN` outcome chains
   `factory.work.requested` again and immediately chains
   `factory.merge.requested {repo, prNumbers: [prNumber]}` — no full PR scan.
4. **CI turns green** — GitHub's successful pull-request `workflow_run`
   delivery through `POST /github` admits the same scoped request, deduped per
   `(repo, PR, head SHA)`. The earlier `pull_request` delivery can still start
   a scan, while the 15-minute full-set sweep catches missed events.
5. **merge proposal**: merge-scan reviews only the selected PR cold and its MERGE
   verdict chains a head-SHA-pinned `merge-apply` plan into a watched
   proposal. Approving *that* is the merge.

Ship is the same shape on a weekly clock, with one permanent difference: the
`ship-apply` approval is structurally human-only (WM-111) — that watched
approval *is* the master-merge decision, and no schedule, chain, or earned
policy can ever make it `auto`.

## Merge-loop exception (WM-398)

`merge-<repo>` schedules are intentionally enabled with `approval: auto`; this
approves only the read-only cold scan. Mutating follow-ups remain constrained
by git-owned policy, schema proofs, immediate live rechecks, and the global
one-merge barrier. Slot event IDs, singleton planning, SHA pins, and the
unverified-landing barrier make restart replay idempotent. Work and ship loops
remain disabled/watched, and deploy/main/master decisions remain human-only.

## 15. Gated host-clock bridge and Factory rollout (WM-328)

`config/schedule.yaml` is still the source for the host timers rendered into
`deploy/launchd/`, but scheduled **apply** commands no longer run an agent or a
mutating orchestrator script. Each command admits the corresponding typed
event through `lib/emit-event.mjs`:

| Scheduled stage | Admitted event |
| :--- | :--- |
| triage | `factory.triage.requested {repo}` |
| dispatch | `factory.work.requested {repo}` |
| merge | `factory.merge.requested {repo}` |
| unblock | `factory.unblock.requested {repo}` |
| deterministic maintenance | its registered request type (`label-guard`, `warm`, `reconcile`, `unblock-digest`, `janitor-scan`) |
| reaper | `clock.tick.reaper` with an explicit loop/slot payload |

The command fails non-zero if the runtime is unreachable or refuses the event.
Once admitted, planning, approval, adapter execution, output verification, and
chain resolution are entirely runtime-owned. `gate_command` and `dry_command`
remain unchanged and execute before admission, so a frequent clock can still
be cheap without bypassing the runtime audit trail. The old aggregate
`factory-retro` job is not silently mapped to the per-run postmortem agent: it
has no equivalent typed event and is tracked separately by WM-684.

### Factory repo clocks

The Factory control repo now has the same explicit four-stage floor as client
repos. Cadences start conservative, and only the lowest-risk stage is on:

| Loop | Cadence | Enabled | Gate | Runtime effect |
| :--- | :--- | :--- | :--- | :--- |
| `factory-triage` | `24h` | **yes** | `queue.mjs --repo factory --gate triage` | watched `factory.triage.requested` proposal when supply is low and Triage can help |
| `factory-dispatch` | `5m` | no | `queue.mjs --repo factory --gate dispatch` | `factory.work.requested`; work-scan chooses bounded candidates |
| `factory-merge` | `10m` | no | `queue.mjs --repo factory --gate merge` | `factory.merge.requested`; mutating follow-ups retain their own gates |
| `factory-reaper` | `60m` | no | none; strict stale-claim predicate inside reaper | watched `clock.tick.reaper` proposal |

This is **chain-first, not cron-first**. `work-scan@1` emits
`factory.triage.requested` on `LOW_SUPPLY`, and promoted triage work returns to
`factory.work.requested`; completed dispatches re-fire work immediately. The
daily triage timer exists only for cold start and new intake, which have no
predecessor completion to create a chain event. Its supply gate makes a full
queue an observed no-op rather than an unnecessary agent run.

Rollout is one enabled flag at a time: observe triage before considering
dispatch, and merge last. Enabling a plist only enables event admission; it
does not grant auto-approval. The runtime's watched proposal remains the
authority boundary unless the runtime registry separately and explicitly
earns `approval: auto` for that event path.

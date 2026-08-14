# Event runtime: scheduled clock events

Status: **implemented** (OPS-381). Tracking: OPS-380 (this spec), OPS-381
(implementation), WM-112 (repo loops §12, GitHub webhook intake §13).
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
- `config/schedule.yaml` and launchd stay exactly as they are. This is a
  second, independent mechanism; §3 forbids the event runtime from touching
  the orchestrator's timers, and one config file must not mean two things.

## 2. Who fires the tick

**In the `serve` process**, which already runs a one-second loop for planning
and outbox publication. Rejected alternatives:

- **External cron/launchd calling `cli.mjs inject`** — reintroduces exactly
  the bare timer the design rejects, splits the schedule between a plist and
  the registry, and makes "why didn't it fire" a two-system question.
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
- Disabling a loop in the registry stops ticks with no leftover timer; the
  orchestrator's `config/schedule.yaml` and launchd state are untouched
  throughout.
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
| `merge-<repo>` | `30m` | `factory.merge.requested {repo}` | merge-scan → merge-apply / escalate (WM-109) |
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
- **The latency half is the dispatch-completion edge**, not a faster clock:
  `dispatch@1` outcomes `PR_OPEN` and `NOT_CLAIMED` chain straight back into
  `factory.work.requested {repo}` (edges.json, WM-112), so a freed slot is
  re-scanned immediately and the 30-minute tick only catches what no
  completion re-fired. `FAILED` and `BLOCKED` terminate — a run that needs a
  human must not spin the scanner.
- **First-enable precondition (known gap, WM-112).** A tick's payload carries
  `{loop, slot, cadenceSeconds, skippedSlots}` alongside the static
  `{repo}`. The loop-native agents accept those fields
  (`schemas/repo-loop.input.json`); the three scan input schemas
  (`work-scan`, `merge-scan`, `ship-scan`) do not yet, so an enabled loop's
  tick currently plans to a typed `human_needed (invalid_input)` instead of a
  proposal. Extending those schemas means re-pinning the agents' definitions
  — out of WM-112's scope, filed as follow-up. Until it lands, the loops are
  registered, visible, and inert even if enabled; webhook and injected
  events (whose payloads are exactly `{repo}`) are unaffected.
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
- **Headers**: `X-GitHub-Event` (kind), `X-GitHub-Delivery` (GUID →
  `eventId`, so at-least-once delivery dedupes on the ordinary
  `(source="github", eventId)` key), `X-Hub-Signature-256` (GitHub's
  `sha256=<hex>` HMAC over the raw body).
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
| `workflow_run` | action `completed`, conclusion `failure`, repo configured (`report_only` included) | `github.workflow-run.failed`, subject `ci`, payload `{repo: owner/name slug, runId}` — the existing shape ci-log-capture consumes |

**Refusal cases**, following intake's typed-refusal conventions:

- `401 {error}` — missing/bad signature, missing secret. Nothing parsed,
  nothing written.
- `200 {admitted: false, ignored: true, reason}` — benign non-events, so
  GitHub never marks the hook failing: `unhandled_event` (ping and every
  other kind), `unhandled_action` (closed PRs, green runs),
  `unconfigured_repo` (no `github:` match in repos.yaml),
  `not_base_branch`, `repo_report_only` (CI failures still flow for
  report-only repos; merge requests never do).
- `422 {errors}` — malformed deliveries that deserve a failure:
  `missing_delivery_id`, `malformed_payload`, invalid JSON.

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
   `factory.work.requested` again — the queue is re-scanned without anyone
   asking.
4. **PR webhook arrives** — GitHub's `pull_request` delivery on the repo's
   base branch through `POST /github` (or its injected equivalent above) —
   and admits `factory.merge.requested {repo}`, deduped on the delivery ID.
5. **merge proposal**: merge-scan reviews the open PRs cold and its MERGE
   verdict chains a head-SHA-pinned `merge-apply` plan into a watched
   proposal. Approving *that* is the merge.

Ship is the same shape on a weekly clock, with one permanent difference: the
`ship-apply` approval is structurally human-only (WM-111) — that watched
approval *is* the master-merge decision, and no schedule, chain, or earned
policy can ever make it `auto`.

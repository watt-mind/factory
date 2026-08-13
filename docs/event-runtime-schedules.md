# Event runtime: scheduled clock events

Status: **implemented** (OPS-381). Tracking: OPS-380 (this spec), OPS-381 (implementation).
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

Skipped slots are written to the journal with a reason, so a six-hour gap is
visible as a decision rather than as silence.

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
    "enabled": true
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
- **Doctor anomaly — proposals piling up.** A watched loop with more than N
  open proposals is either mis-cadenced or nobody is watching it; both are
  worth saying.

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

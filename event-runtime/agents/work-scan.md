# work-scan — read a repo's agent-ready queue and flag when triage supply is low

You are a dispatch planner. `./input.json` names one repo and the exact source
tree to read it against:

```json
{
  "repo": "bj29",
  "repoPin": {
    "repo": "bj29",
    "ref": "develop",
    "sha": "<40-hex>",
    "github": "owner/name"
  }
}
```

`repoPin` is resolved by the planner, not by you: it names the exact commit
the checkout below is at.

The repo's source is checked out **read-only** at `./repo` (that exact SHA).
You never modify it, never run its build, never install anything. You are
read-only everywhere: you never claim, assign, comment, label, or move a
ticket — dispatching is the chained `factory.dispatch.requested` run's job
(WM-108), not yours. Write `./result.json`. Work only inside this directory.

## Method

1. **Enumerate and filter candidates** with a complete repo queue read
   (`bun "$FACTORY_ROOT/tools/ticket.mjs"`; all pages, no sampling). Build the
   candidate set yourself from the returned fields. A ticket is a candidate
   only when **all three** predicates hold:

   - its state name is exactly `Todo`;
   - its labels include `ai:agent-ready`; and
   - its `assignee` field is `null`.

   Exclude a ticket before ordering when its labels include `ai:escalated` or
   `type:security` (or any other label containing `security`, case
   insensitively). The dispatch planner must refuse those tickets, so including
   them in a bounded batch can exhaust the scan and strand dispatchable work.
   These excluded tickets are not candidates and must not appear in `plan`,
   `deferred`, or `evidence.candidates`.

   Apply this filter before ordering, cap checks, or path checks. `Blocked`,
   `Backlog`, `In Progress`, `In Review`, and `Done` are never candidates. Any
   assignee at all is the ticket lock (docs/event-runtime-dispatch.md §2) and
   excludes the ticket, regardless of state or labels; an `agent:*` or `ai:*`
   label proves nothing about assignment. A ticket without `ai:agent-ready` is
   also excluded. An excluded ticket must never appear in `plan` or `deferred`.
   `readyCandidates` and `evidence.candidatesSeen` both count only tickets left
   after this complete filter and before cap/overlap pruning; they must be equal.
   Preserve those tickets in queue order in `evidence.candidates`, each exactly
   `{ticket, disposition}`. `disposition` is `selected`, `owned_paths_overlap`,
   or `cap_full`, and must agree with `plan`/`deferred`/`noopReason` below.
   `evidence.candidatesSeen` is a non-negative integer equal to that array's
   length, not a prose estimate or the raw count before filtering. If the read
   errors, truncates, or returns
   malformed JSON, refuse with `reasonCode: "needs_human"` rather than inventing
   candidate order.

2. **Order the filtered candidates** with this explicit Linear priority rank,
   then by `createdAt` ascending within the same rank:

   | Rank | Linear value | Label used in `reason` |
   | ---: | -----------: | ---------------------- |
   |    1 |            1 | Urgent                 |
   |    2 |            2 | High                   |
   |    3 |            3 | Medium                 |
   |    4 |            4 | Low                    |
   |    5 |            0 | No priority            |

   Do **not** sort the raw numeric value ascending: Linear's `0` means no
   priority and belongs last. Every selected item's `reason` must include the
   priority label from the table (for example, `priority Urgent`), never only a
   bare priority number.

   Before planning the live queue, check the filter and comparator against this
   fixed fixture using the same rules: `URGENT` is Urgent/Todo/unassigned with
   `ai:agent-ready`; `NONE` is No priority/Todo/unassigned with
   `ai:agent-ready`; `BLOCKED` is Low/Blocked/assigned with
   `ai:agent-ready`. The resulting candidate order must be exactly
   `[URGENT, NONE]`; `BLOCKED` must be absent. Refuse with
   `reasonCode: "needs_human"` if your candidate construction or ordering does
   not produce that result.

3. **Count the cap**: the repo's `max_in_flight` from
   `$FACTORY_ROOT/config/repos.yaml`, falling back to
   `concurrency.max_in_flight_per_repo` in `config/policy.yaml`, else 3. Record
   that value as `evidence.maxInFlight`. The in-flight count against it is the
   repo team/project's `In Progress` tickets — the same set the dispatch gate
   reads; record it as `evidence.inFlightSeen`. Free slots = cap minus in-flight;
   zero or fewer → NOOP `cap_full`.
4. **Pin each candidate's Owned Paths**: parse each candidate's
   `## Owned Paths` section and check the globs against the real tree at
   `./repo`. A glob matching nothing that exists is only a smell (new files
   legitimately match nothing) — note it in the item's `reason`, don't
   disqualify. A ticket with no parseable section owns **everything** (`["**"]`):
   still plannable, but only alone, with nothing in flight. Ambiguous overlap
   is overlap — the same biases as `orchestrator/owned-paths.mjs`, always toward
   collision.
5. **Select the plan**: walk the entire ordered candidate queue. Owned Paths
   overlap is **advisory** (WM-677, `config/policy.yaml`
   `dispatch.owned_paths_collision: advisory`): a textual overlap with an
   in-flight ticket or an already-selected ticket does NOT disqualify — select
   the ticket while a free slot remains and record the overlap in its `reason`
   (`overlaps WM-123 on event-runtime/web/src/App.tsx`); rebase and merge-fix
   resolve real conflicts later. Only two collisions are hard and defer a
   candidate as `owned_paths_overlap`: (a) an in-flight or selected ticket
   claims `**` (including a ticket with no parseable Owned Paths section — see
   step 4), or (b) the candidate and an in-flight/selected ticket claim the
   _identical_ concrete file (no globs on either side). Selected in order, each
   item pins `{ticket, ownedPaths, reason}`. Every candidate not selected goes
   in `deferred` as `{ticket, reason}`, where `reason` is the typed value
   `owned_paths_overlap` for a hard collision or `cap_full` when no slot
   remains. When a hard collision comes from an in-flight ticket with no
   parseable Owned Paths, name that ticket in the `summary` so the operator can
   fix its description (WM-868).
   Do not stop accounting when the slots fill: mark every remaining candidate
   `cap_full`.

   Track the complete candidate count before cap/overlap pruning as both
   `readyCandidates` and `evidence.candidatesSeen`. Record the same candidates,
   in the same queue order, in `evidence.candidates`: selected tickets use
   `disposition: "selected"`; each deferred ticket's disposition equals its
   typed `reason`. On `DISPATCH`, `plan.length + deferred.length` must equal the
   count, with no duplicate ticket across the two arrays, and their ticket IDs
   and dispositions must exactly match `evidence.candidates`.

   If the walk has any dispatch candidates, do not read Triage and emit
   `DISPATCH` or `NOOP` (`cap_full`/`all_overlapping`) according to the result.

   If this ordered walk yields zero dispatch candidates after a complete read and
   `readyCandidates` is exactly 0, run a complete, independent read of `state:
Triage` backlog (again, all pages, fresh command, no sampling). If the Triage
   read fails or returns any malformed payload, refuse with
   `reasonCode: "needs_human"`.

   If `readyCandidates` is greater than 0 and there are no dispatch candidates,
   keep the `NOOP`/`cap_full` or `all_overlapping` outcome, leave `deferred`
   empty because the whole queue is accounted for by `noopReason`, and still set
   `triageBacklog` to 0. A non-empty candidate read can never emit `queue_empty`.

   If there are no dispatch candidates and non-empty Triage backlog, emit
   `LOW_SUPPLY` with `readyCandidates` and `triageBacklog` counts in the
   artifact, then stop (no dispatch plan). If there are zero dispatch
   candidates and an empty backlog, emit normal `NOOP queue_empty`.

## What you cannot see — say so, never pretend

You cannot see the runtime's own ledger: a ticket with an open (not yet
approved) dispatch proposal, or an approved-but-unclaimed run, still reads as
unassigned in Linear. Excluding assigned tickets is the whole dedup you can
enforce from your inputs. The rest is closed downstream, by design: every
chained `factory.dispatch.requested` is re-gated by WM-108's plan-time checks
(assignee, cap, Owned Paths — a stale scan cannot force a dispatch), and the
dispatch run's claim read-back refuses a lost race as `NOT_CLAIMED`. Your
plan is advisory input to that gate, not a reservation.

Every `plan` item chains into its own re-gated dispatch request. `deferred`
contains only ready candidates that cannot start in this scan, never selected
plan items. Rolling dispatch comes from re-firing `factory.work.requested` after
completion, which re-plans those candidates against a fresh world.

## Output

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "recommendation": "DISPATCH",
    "repo": "bj29",
    "ticket": "CLNT-123",
    "plan": [
      {
        "ticket": "CLNT-123",
        "ownedPaths": ["src/feature-a/**"],
        "reason": "priority Urgent, paths disjoint from all in-flight"
      }
    ],
    "deferred": [{ "ticket": "CLNT-124", "reason": "owned_paths_overlap" }],
    "summary": "one line an operator can act on",
    "readyCandidates": 2,
    "triageBacklog": 0
  },
  "evidence": {
    "commands": ["the linear reads this rests on"],
    "candidatesSeen": 2,
    "candidates": [
      { "ticket": "CLNT-123", "disposition": "selected" },
      { "ticket": "CLNT-124", "disposition": "owned_paths_overlap" }
    ],
    "inFlightSeen": 1,
    "maxInFlight": 3
  }
}
```

`ticket` is always `plan[0].ticket` when `recommendation: "DISPATCH"`.
`readyCandidates` and `evidence.candidatesSeen` are the identical complete count
of qualifying candidates before cap/overlap pruning, and
`evidence.candidates.length` is the same count with the ordered ticket IDs and
normalized dispositions retained. `triageBacklog` is the complete count of
Linear `Triage` issues when that independent read is required, and 0 otherwise.

`LOW_SUPPLY` means zero ready candidates and non-empty Triage backlog with a
successful complete read for both; emit `readyCandidates` and `triageBacklog` in
that artifact. `LOW_SUPPLY` no longer chains into an immediate
`factory.triage.requested` (WM: operator decision 2026-08-18, to stop burning
the pi/codex adapter's quota on ~30-minute chain loops); it is now advisory
evidence only. The triage floor is the 8h `triage-factory` schedule
(`event-runtime/schedules.json`) plus the operator manually injecting
`factory.triage.requested` when supply needs to be refilled sooner.

`NOOP` still means no ready work (`queue_empty`), zero free slots
(`cap_full`), or ownership overlap (`all_overlapping`) with an empty `plan`,
empty `deferred`, `ticket: null`, and typed `noopReason`. `queue_empty` is valid
only when `readyCandidates` and `evidence.candidatesSeen` are both exactly 0
and `evidence.candidates` is empty. `cap_full` requires a non-empty candidate
array whose dispositions are all `cap_full` plus capacity evidence showing
`inFlightSeen >= maxInFlight`; `all_overlapping` requires a non-empty candidate
array whose dispositions are all `owned_paths_overlap`. A NOOP is a good
outcome, not a failure. If Linear is unreachable, or the repo has no
team/project in `config/repos.yaml`, refuse:
`{"schemaVersion": "factory.agent-result/v1", "terminalState": "refused", "reasonCode": "needs_human"}`.

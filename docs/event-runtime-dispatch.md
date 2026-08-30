# Event runtime: dispatch coordination for repository-mutating runs

Status: **design — operator-ratified, nothing built**. Tracking: WM-107 (this
design); implementation lands through the work/merge/ship chains
(WM-108..WM-112). Companion to [event-runtime.md](event-runtime.md) §3, which
names the boundary this moves, and
[event-runtime-workers.md](event-runtime-workers.md) §5a, which held tier-2
worktrees until this document existed.

The last row of event-runtime.md §2's table — repository-mutating events —
was deliberately last: before an event run may claim a ticket or modify code,
the runtime and the orchestrator's ticket dispatcher must share **one** claim
mechanism, **one** capacity budget, **one** Owned Paths check, **one**
workspace lifecycle, and **one** approval authority. Two independent mutation
coordinators race even when their source trees are separate. This document
records how each of those five is shared, with the alternatives that were
rejected and why.

---

## 1. What this moves, said out loud

§3's MVP rules forbid the runtime to "create worktrees, mutate repository
source, or merge code". Building this moves that boundary — the third such
move, after timers and Linear writes — so, like those, it is stated rather
than absorbed:

- An event run may **claim a ticket, build a worktree, mutate source, and
  merge to `develop`** — but only through the coordination rules below, every
  one of which is shared with the ticket dispatcher rather than duplicated
  beside it.
- The rest of §3 stands unchanged (§8 restates it item by item). In
  particular: agents still never spawn agents, every mutation still flows
  through intake → planner → watched proposal, and the ship chain's
  deploy-branch merge is **permanently** a human approval (§7).

The failure this prevents is the one §3 names: two mutation coordinators
that each obey their own rules perfectly and still put two agents in one
file, four agents in a three-slot cap, or an unattended merge on a deploy
branch.

---

## 2. Claim: the Linear `assignee` stays the only ticket lock

**Decision.** The Linear `assignee` field remains the single distributed lock
for tickets, for both paths. The runtime's `BEGIN IMMEDIATE` claim
(event-runtime.md §10) governs **runs** — which worker executes an approved
RunSpec — and says nothing about tickets. An event run that finds its target
ticket already assigned refuses with a typed NOOP (`ticket_assigned`); it
never steals, and it never queues behind the holder.

At plan time the runtime admits only a `Todo`, unassigned,
`ai:agent-ready` ticket with no unfinished Linear `blocked by` relation.
Open blockers refuse with `ticket_blocked_by_open:<ID>` (comma-separated for
several); blockers in completed or canceled states do not gate dispatch.

**Rejected: a ticket lock in the runtime database.** The runtime's ledger is
authoritative for event facts only (§10); Linear is the authority for
business work, and architecture.md §1 is explicit that two agents cannot
disagree about ownership when there is one authority. A second lock is a
second authority, and the interesting failure is precisely the moment they
disagree.

**The claim protocol is the dispatcher's, verbatim.** `tick.mjs` claims by
writing the assignee and reading it back — Linear has no compare-and-swap, so
the read-back _is_ the concurrency control — and serializes the
read-decide-claim window through a machine-local lock file
(`~/.factory/locks/<repo>.dispatch.lock`), because every local supervisor
authenticates as the same Linear user (OPS-40) and the read-back cannot tell
them apart. The runtime's executor is exactly such a supervisor: it must take
the **same lock file** for its read-refuse-claim window, then claim, then
read back. A runtime-private lock would be correct against foreign agents and
blind against the dispatcher — the one collision this design exists to
prevent.

Order follows architecture.md §2.4: **claim → worktree → spawn**. A
`worktree_up` takes minutes; an unclaimed ticket is one another agent may
take, and holding a claim for minutes is harmless against the reaper's
45-minute threshold. A failed run must not keep its claim: the executor
applies the dispatcher's un-claim rule — roll back to Todo with a comment
only when the ticket still looks like our claim (In Progress, assigned to us,
`ai:in-progress` present); a run that legitimately moved its ticket to
Blocked or In Review keeps that state.

**A recorded asymmetry, not a contradiction.** `tick.mjs` deliberately does
_not_ treat an assignee on a Todo ticket as a gate — with one shared Linear
identity, "has an assignee" is indistinguishable from "was claimed and never
cleared", and skipping such tickets forever is the reaper's failure to fix,
not dispatch's to avoid. The event run's rule is stricter: assigned →
refuse. That is the safe direction for an automated path with no operator in
the loop at plan time — a false refusal costs one typed NOOP and the reaper
clears the stale claim; a false steal puts two agents in one worktree. The
asymmetry collapses when per-agent Linear identities land (OPS-40); until
then it is stated here so nobody "fixes" either side to match the other. See
§9.

### Trusted-author and body-hash-pin gates (github plane, GH-879)

**Decision.** On the github control plane the factory's control plane is a
public repository: `Todo` + `ai:agent-ready` + unassigned keeps stranger-filed
issues out only until someone with triage permission labels one, and it
covers nothing after that label is applied. An issue body is executable
instructions to the factory — the Verification Command runs on the runner,
Owned Paths scopes which files get touched — so a plausible outside issue
labeled by a hurried maintainer, or an author editing the body **after**
labeling, is command injection into a dispatch worktree. Dispatch admission
(`worktreeDispatchAutoEligibility` in `event-runtime/lib/planner.mjs`) closes
both windows with two checks, applied only when the ticket carries
`controlPlaneKind: "github"` — Linear and memory tickets never set that field
and skip both checks entirely, unaffected.

1. **Trusted-author gate.** Refuses `ticket_untrusted_author` unless BOTH the
   issue's original `authorAssociation` and the association of whoever made
   the most recent body edit are `OWNER`, `MEMBER`, or `COLLABORATOR`
   (`event-runtime/lib/triage.mjs`'s `isTrustedAssociation`). An issue never
   edited since creation has the author as its own last editor — no extra
   request. An edit by someone else is resolved via the repo's collaborator
   permission (`admin`/`maintain`/`write` reads as trusted-equivalent
   `COLLABORATOR`; anything weaker, or unfetchable — including a ghost/deleted
   editor account — resolves to `null` and **fails closed**, never open).
   Reading a repo's edit history needs the same write-level `gh` token the
   dispatcher already needs to label/comment/transition that issue, so an
   admission run that can act on a ticket can also see whether its body was
   edited.

2. **Body-hash pin.** When triage-apply's `label-agent-ready` action (or any
   other `transition`/`setLabels` call) adds `ai:agent-ready`, the github
   control plane stamps an issue comment with the current body's content hash
   — reusing the same `hashJson` convention as every other `descriptionHash`
   in this runtime — as a marker: `<!-- factory:ready-pin sha256:... -->`.
   Admission recomputes the hash from the live body and refuses
   `ticket_body_changed_since_ready` on a mismatch. **Re-labeling is the
   documented refresh path**: applying `ai:agent-ready` again (even if it was
   already present) stamps a fresh pin against whatever the body reads at
   that moment, which is how a legitimate maintainer edit after triage gets
   re-admitted. A ticket with **no** pin at all (labeled before this gate
   shipped, or through a path that predates it) is not itself a refusal —
   only a _mismatched_ pin proves tampering — so rollout does not strand
   every already-ready ticket.

Both checks live inside the one shared admission function every dispatch path
funnels through (automatic chain approval and operator-injected dispatch
alike), so there is no operator bypass — the point is stopping bad-actor
_content_, not bad-actor _operators_.

**Rejected: a verification-command allowlist.** Explicitly deferred
(operator decision 2026-08-22, "operator-approved 1+2" only). Vetting a
proposed Verification Command against a safe-command grammar is a much larger
surface — arbitrary shell quoting, path traversal inside otherwise-innocuous
test invocations — and these two gates already remove the two paths a
stranger has to get _content_ into a ticket in the first place: they can't
author a trusted-looking issue, and they can't edit one after it is trusted
and pinned.

### Per-ticket model tier

A `factory.dispatch.requested` run may override the dispatch agent's default
model tier without changing the agent definition. The effective tier is chosen
at plan time with this precedence: payload `modelTier` > the ticket's single
`tier:<strong|standard|light>` label > the definition's `model_tier`. The
planner records the winning source as
`evidence.checks.model_tier_source` (`payload`, `label`, or `definition`) and
pins both the effective `modelTier` and its resolved concrete `model` in the
RunSpec.

The `tier:*` label vocabulary is closed and must equal the tier keys accepted
by `config/policy.yaml` (`strong`, `standard`, and `light`). More than one
`tier:*` label, or any other `tier:` value, refuses dispatch with the typed
reason `ticket_tier_invalid`; an explicit payload override does not make an
invalid ticket label safe. As with definition tiers, a valid label whose tier
has no mapping for the routed adapter fails closed rather than falling back to
an adapter default.

### Default-tier decision rule

`GET /metrics/breakdown?by=modelTier&metric=cost` and
`bun orchestrator/economics.mjs` report the dispatch cohort, merged-ticket
count, total and median USD per merged ticket, and the standard-tier escalation
rate. A cohort is keyed only by the dispatch RunSpec's pinned `modelTier`; the
concrete model string is never used to infer a tier. For a merged ticket, its
cost includes every RunSpec carrying that ticket, including retries, merge-fix
rounds, and escalation reruns.

Change the dispatch default from strong to standard only when standard's
cost-per-merged-ticket is below strong's across at least 20 merged tickets in
each tier. Treat a high standard-tier escalation rate as a reason to keep the
strong default even if the raw cost comparison is favorable.

### Linear API budget (WM-878)

Linear allows 2500 requests per hour. The factory used to treat a 400/429
`Rate limit exceeded` as `needs_human` and then _amplify_ the outage: every
open chain-dispatch proposal re-ran `fetchTicket` + `fetchViewer` +
`fetchInFlight` on every tick. Rate-limited outcomes are **retry-later**:

- `tools/linear.mjs` records `X-RateLimit-Requests-*` (falling back to the
  complexity headers), exposes `factory ticket budget`, and exits 3 with
  `{rateLimited:true, resetAt}` instead of a generic failure.
- One planning pass memoizes in-flight issues by team+project for ≤60s and
  per-ticket reads for the run, so ten candidates in one repo do not issue
  ten 250-issue queries.
- A rate-limited dispatch plan leaves the event `admitted` with
  `reason: linear_rate_limited`; `plan_failures` is not incremented, the
  ticket is not labelled `ai:escalated`, and no inbox item is opened. The
  next tick (or `resetAt`) retries.
- Auto-approval rechecks that throw a rate-limit error stay open as
  `dispatch_recheck_deferred` (the thrown message is logged; any other throw
  is `dispatch_recheck_failed:<message>`). Rechecks in the same pass back off
  until `resetAt`.
- `factory doctor` prints `Linear budget: N/2500 remaining, resets HH:MM`
  and warns when remaining < 300.

The dispatch agent's prompt still names `needs_human` for an unreachable
Linear API; a follow-up re-pin of `dispatch@1` plus `verify.mjs`
`REFUSAL_REASONS` is required before the agent result itself can carry
`linear_rate_limited` without a contract violation. The planner and
auto-approval path above is what stops the inbox escalation.

---

## 3. Capacity: one budget, checked at plan and again at execute

**Decision.** One per-repo in-flight cap, shared by both paths: the repo's
`max_in_flight` in `config/repos.yaml`, falling back to
`concurrency.max_in_flight_per_repo` in `config/policy.yaml`. The ledger that
counts against it is the existing one — `lib/worker-leases.mjs`: files under
`~/.factory/worker-leases/` that independent supervisors already share, live
only while heartbeating and backed by a real pid. A tier-2 mutating run
writes, renews, and releases a lease exactly as a dispatched ticket process
does, so `tick.mjs`'s `cap - liveWorkerLeases(repo)` arithmetic counts event
runs without learning anything new.

**Rejected: a runtime-private cap.** Two caps that each hold individually sum
to more than the machine's true limit — that is the §3 event-storm scenario
verbatim: an event burst that starves ticket dispatch without violating a
single rule.

**Checked twice, deliberately.** At plan time, a proposal is refused
(`capacity_full`) when the repo is at cap — proposing a run that cannot start
wastes an approval, the same reason the planner refuses on a missing artifact
before the operator decides rather than after. And re-checked at execute:
an approval may sit for its whole TTL, and within the TTL it executes as-is
(event-runtime.md §12) — the world the operator approved against has had
minutes to fill the cap. The plan-time check keeps the inbox honest; the
execute-time check is the one that holds.

**The usage window: a static split, not dynamic observation.** Every
claude-adapter run draws on the same subscription usage window as interactive
sessions and dispatched tickets, and architecture.md §2.9 is blunt that
nothing can observe that window. A coordinator "allocating" an unobservable
resource is guessing with extra steps. So v1 keeps the existing static
protections and calls them the answer for now: **at most one event worker**
(§3's standing rule — a deployment choice since OPS-233, re-affirmed here)
and **singleton scheduled loops** (event-runtime-schedules.md §5). One event
worker means at most one event-side agent run at a time, which bounds the
event path's window draw the same way `--max` bounds a tick's. Dynamic
coordination of the window between the two paths remains the open problem §3
says it is — for the unattended stage, not this design.

---

## 4. Owned Paths: one collision oracle, imported

**Decision.** The planner reuses `orchestrator/owned-paths.mjs` as a library
— `effectiveOwnedPaths`, `pathsCollide`, the same glob algebra, the same
biases. Before proposing a mutating run for a ticket, the planner reads the
in-flight set from Linear (In Progress tickets for the repo's team/project —
the same query shape `tick.mjs` uses) plus its own leased mutating runs, and
**refuses to propose** (`owned_paths_overlap`) on any collision, whichever
path the in-flight ticket belongs to. Re-checked at execute alongside
capacity, for the same TTL reason.

Both of the module's safety biases carry over unchanged: a ticket with no
parseable `Owned Paths` owns everything (dispatchable, but alone), and
ambiguous glob overlap errs toward collision — a false positive serializes
two tickets, a false negative puts two agents in one file.

**Section format.** `parseOwnedPaths` reads the `## Owned Paths` section as
bullets, fenced code, or indented code, strips a trailing `(new)`-style
annotation, and keeps only entries with no whitespace that look like a path
(`/`, `*`, or an extension). One path or glob per line. A bullet like
`- a.mjs, b.mjs, c.mjs` contains spaces and is dropped whole, so a ticket
written that way parses to fewer paths than its author intended — or to none,
which the planner reports as `owned_paths_unknown`. The orchestrator hit both
on 2026-08-19 (WM-907 dispatched with a narrowed scope and blocked; WM-918
refused outright) before rewriting the sections one path per bullet.

**Collision mode (WM-677).** `config/policy.yaml` `dispatch.owned_paths_collision`
selects what a collision _does_:

| mode                           | on overlap                                                                                                    | still refuses                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `strict` (default when absent) | refuse, `owned_paths_overlap`                                                                                 | —                                                 |
| `advisory`                     | record on the proposal as `evidence.ownedPathsOverlap` (`{ticket, path, inFlightPath}` per pair) and dispatch | `**` on either side → `owned_paths_conflict_hard` |

Advisory exists because the strict oracle refuses far more than it protects:
tickets scope themselves with qualified claims (`views/*.tsx (formatter
call-sites only)`) that the glob algebra cannot see, and shared-prefix
wildcards collide by construction. On 2026-08-18 nine dispatch attempts
became two running workers under strict, while six textually-overlapping PRs
rebased onto develop clean the same day. Textual overlap is a rebase job and
`merge-fix` already does it; the pool should not idle waiting for it. What
advisory keeps hard is only the `**` sentinel, whose whole meaning is
"alone". Two tickets naming the _same file_ is not hard: same file is not
same lines — tickets qualify claims (`App.tsx (interval constants only)`) for
exactly this — and an identical-file rule tried first refused four tickets in
one batch on `App.tsx`/`hooks.ts`/`api.mjs`. Merging remains serialized (`concurrency.max_concurrent_merges`),
which is where real conflicts are caught. Both the planner and the worker's
execute-time re-check read the same setting, so operator approval and worker
claim cannot disagree.

**Rejected: a second overlap implementation inside the runtime.** The
existing parser has already bitten once — architecture.md §2.3's CLNT-616,
where a correctly specced ticket parsed as empty and dispatch refused it —
and the fix landed in one place. Two parsers drift, and drift here is not
cosmetic: the moment the runtime's parser accepts a format the dispatcher's
rejects (or vice versa), the two paths compute different in-flight scopes
from the same tickets and the collision check silently stops meaning
anything.

**Importing is not modifying.** §3's rule that the runtime never changes
orchestrator code stands (§8). `owned-paths.mjs` is deliberately
dependency-free and side-effect-free; the runtime reads it the way it reads
`config/repos.yaml` — as the single source of truth it must not fork.

---

## 5. Workspace: tier 2 delegates to the repo's own scripts

**Decision.** The tier-2 mutating workspace provider shells out to the
`worktree_up` / `worktree_down` each repo declares in `config/repos.yaml`,
and the repo's declared `verify` command is the §9 repository verification —
executed by the verifier as ordinary code, outside and after the implementing
agent, never trusted from the agent's own report. This is §5a rule 1
satisfied, not relaxed: **delegate, never reimplement**. Git isolates
branches, not ports or databases (architecture.md §2.5); the ports,
per-ticket databases, and seeded templates live in the repo-owned scripts,
and a second worktree implementation inside the runtime would drift until it
collided with a dev server.

Consequences, all inherited from the dispatcher's rules rather than invented:

- **`report_only` repos are never tier-2 targets.** A repo without the
  scripts has a safe concurrency of one human; `tick.mjs` refuses to
  dispatch there and the planner refuses to propose there
  (`repo_report_only`), for the same reason.
- **One run, one worktree.** The workspace is never shared with interactive
  or ticket agents (§3, unchanged); `worktree_down` tears it down, with
  retain-on-failure per policy like every other workspace type (§7).
- **The runtime stays a reader of `config/repos.yaml`** (`lib/repos.mjs`
  already reads the `worktree_*` and `verify` fields, unused until now). A
  second repo registry is the same drift argument as §4, applied to ports.

### Handoff verification sandbox limits

The worker runs repository and ticket verification in a user, mount, PID, and
network namespace. `sandbox.tmpfs_mb` in local `config/policy.yaml` controls
the guest `/tmp` size in MiB; absent, malformed, or smaller-than-safe values
use the 1024 MiB default, and values above 8192 MiB are capped there. PID 1 is
a reaping init: after the command exits it SIGTERMs every leftover, and
anything still alive after a short grace is SIGKILLed, so orphaned descendants
from process-group tests can neither remain zombies nor keep the sandbox
alive. The host must provide unprivileged user namespaces and
`/usr/bin/python3` (the init/setup interpreter); otherwise the gate refuses
with `sandbox_unavailable` rather than reporting the ticket's command red.
When every explicit ticket `bun test` path is either named verbatim by
repository verify, or is an existing `*.test.*`/`*.spec.*` file under a
directory that repository verify runs, the worker records
`ticket_verify_covered_by_repo_verify` and does not run a redundant second
sandbox step. It otherwise preserves the independent ticket command check;
unparseable shell commands, missing files, non-test modules and flag values
(`--preload x`) never qualify for skipping.

---

## 6. Execution form: the `claude` adapter, `mutating: true`

**Decision.** The ticket workflow runs as an **ordinary registered agent**
through the runtime's existing `claude` adapter
(`lib/adapters/claude.mjs`) with `mutating: true` capabilities, over the
tier-2 workspace from §5. Same registry, same conformance bar, same
lifecycle, same receipts as every other run — repository mutation is a
capability and a workspace type, not a parallel execution path.
Every worktree agent passes the dispatch gate unless its definition declares
`dispatchGateExempt: true`, which registry validation permits only on a
`workspace.type: worktree` definition.

**Rejected: a closed command template shelling to `runners/run-agent.sh`.**
It looks like less work — the runner already spawns ticket-shaped sessions —
and it is the wrong shape three ways:

- **A second spawn path the runtime cannot trace.** The adapter streams
  `factory.trace/v1` events (assistant text, tool use, usage) and captures
  the transcript as a run artifact; a shelled runner collapses all of that
  into an opaque exit code. No trace, no usage, no transcript artifact, no
  verified result contract — the run would be _less_ observable than a
  read-only status report, on the one run class that mutates code.
- **Duplicated machinery.** The adapter already owns the timeout discipline
  (TERM, then KILL), subscription auth (strips `ANTHROPIC_API_KEY`,
  architecture.md §2.9), strict MCP config, and tool confinement. The runner
  owns its own copies for the interactive path. Shelling one from the other
  stacks two timeout layers, two auth strips, and two MCP configs, and the
  first disagreement between them is a debugging session with no owner.
- **§5a's delegation rule does not apply.** Delegate-never-reimplement is
  about **repo-owned isolation scripts** — ports and databases the runtime
  cannot know. `run-agent.sh` is not repo-owned isolation; it is the
  orchestrator's own harness spawn, and the runtime already has one of
  those, tested, with a result contract. Delegation covers the worktree
  scripts (§5), not the harness spawn.

**Knowingly deferred, with triggers named** (§2's rule):

- **Multi-harness dispatch.** codex, pi, and agy remain on `run-agent.sh` /
  `tick.mjs --harness` until each has a conformant adapter — the registry
  admits only adapters with a passing conformance test (§6), and none of the
  three has one. The second-provider capacity they add is an orchestrator
  feature until then.
- **`--max-budget-usd` passthrough (WM-108).** `tick.mjs` passes the policy
  budget to every ticket process; the adapter does not yet pass it at all. A
  mutating run without the runaway guard is not acceptable, so the adapter
  gains the flag **before** the first tier-2 run, not after.

---

## 7. Approval authority: earned for dispatch and develop, never for deploy

**Decision.** Watched proposals gate every mutation — §12 is unchanged as the
centerpiece. On top of that gate, `approval: auto` follows the earned-per-edge
model the schedules and chains already use (event-runtime-schedules.md §6,
event-runtime-workers.md §5), with one permanent exception:

- **Dispatch of a `Todo` + `ai:agent-ready` + unassigned ticket may
  eventually earn `auto`.** The queue itself is the reviewed artifact:
  triage wrote the spec to the agent-ready template, and the operator's
  curation of the queue — what got promoted, what got held — is the review.
  A watched approval of such a proposal restates a decision already made,
  and 24 restatements a day teach an operator to click approve without
  reading (the schedules doc's argument, applied to dispatch). Earned means
  earned: watched first, then flipped in a reviewable registry commit with
  the run history as evidence, `actor` recording the truth.
- **The develop-targeting merge chain may eventually earn `auto`.** This is
  autonomy the orchestrator path already has — `policy.yaml`'s
  `auto_merge_base: [develop]` with green CI — so the runtime earning it is
  parity on a track record, not new ground. Escalation rules
  (`escalate_paths`, the judgment list) apply identically; an escalated PR
  is `human_needed`, never `auto`.
- **The ship chain's deploy-branch merge is PERMANENTLY `watched`.** That
  watched approval **is** the human master-merge decision — policy.yaml:
  master/main always goes through a human, on every repo. It is not an
  approval _about_ the decision; it is the decision, relocated into the
  runtime's inbox. Because §2's earned-automation ratchet only ever loosens,
  this one must be enforced **structurally (WM-111), not by convention**:
  registry validation fails closed on `approval: auto` for any agent whose
  edge merges a deploy branch — a load error, exactly like `approval: auto`
  on a disabled loop — so the config that would delete the human decision
  cannot load, whoever writes it and however good the track record looks.

The failure this prevents: earned-automation creep quietly consuming the one
decision the whole factory routes through a human. Every other gate here may
someday relax on evidence; this one may not, and the place that says so is a
validator, not a paragraph.

Command-emitted chain authority is definition data: `chainCommandEdges`
declares its registered event types, and `chainRepoMustMatchInput: true`
requires the emitted repository to match the predecessor input.

---

### Chain auto-approval (WM-357)

`config/policy.yaml` is the only allowlist for unattended chain proposals. Its
closed set covers `factory.work.requested`, `factory.triage.requested`,
`factory.triage-apply.requested`, and `factory.dispatch.requested`; missing or
malformed policy means watched. The event must have been admitted with source
`chain`, and the normal proposal, lifecycle, journal, budget, and worker gates
remain in force.

Dispatch is re-read immediately before approval: it must still be Todo,
unassigned, `ai:agent-ready`, inside its lease cap, and disjoint from active
Owned Paths. `ai:escalated`, security classification, and a ticket path that
intersects the repo's `escalate_paths` leave the proposal open with a typed
reason. Triage apply additionally revalidates its schema and closed action
registry. Proposal/run-spec mismatches and expired proposals fail closed.

`merge-apply` and `ship-apply` are not allowlistable by this path. In
particular, their watched/human-only controls remain structurally unchanged;
this policy does not implement autonomous merge work.

## 8. The §3 boundary, restated item by item

Moved by this design — permitted only through §§2–7 above:

- create worktrees (§5, via the repo's own scripts);
- mutate repository source (§6, the `claude` adapter with `mutating: true`);
- merge code (§7 — `develop` on an earned record, deploy branches never
  without the human approval that constitutes the decision).

Standing, unchanged:

- **agents never spawn agents** — a ticket run that discovers follow-up work
  files a ticket or emits a typed recommendation; chains go through the
  planner and a proposal, like everything since OPS-223;
- **everything flows intake → planner → watched proposal** — there is no
  express lane for mutations; `auto`, where earned, is a recorded approval
  policy on that same path, not a bypass of it;
- **never share mutable workspaces** with interactive or ticket agents;
- **never modify** `shared/commands/`, `shared/skills/`, their generated
  copies, `build/emit.mjs`, `orchestrator/run.mjs`, `orchestrator/tick.mjs`,
  `config/schedule.yaml`, or the launchd state — importing
  `orchestrator/owned-paths.mjs` as a library (§4) reads orchestrator code
  and changes none of it;
- **never feed a result into the existing dispatcher automatically** — the
  runtime's mutating runs are its own, coordinated with the dispatcher
  through the shared lock, ledger, and oracle above, not injected into it.

---

## 9. Open questions

Recorded, not silently decided:

- **Shared Linear identity (OPS-40) is the load-bearing weakness in §2.**
  The assignee read-back cannot distinguish the two paths, so the
  machine-local dispatch lock file is the real mutual exclusion — and it is
  machine-local by construction. The moment a tier-2 mutating worker runs on
  another node (event-runtime-workers.md stage 2), both the claim window and
  the §3 capacity ledger (also `~/.factory` files) stop covering it.
  **Precondition, stated now:** no remote mutating worker before either
  per-agent Linear identities make the read-back honest, or the lock and
  lease ledgers move to a shared substrate. Deterministic-command remote
  workers (slice 2's remediation class) are unaffected — they touch no
  tickets.
- **The claim asymmetry in §2** — dispatch does not hard-skip assigned Todo
  tickets, event runs refuse on any assignee — is deliberate today and
  should collapse into one rule when OPS-40 lands. Whoever closes OPS-40
  should revisit both sides together, not either alone.
- **The usage window remains unobservable.** §3's static split (one event
  worker, singleton loops) is a stopgap this design re-affirms, not an
  answer. Raising event-side parallelism, or scheduling LLM loops beyond
  singletons, waits on the unattended-stage answer §3 already demands — it
  is not unlocked by anything here.

## Remote handoff dispatch provenance (GH-1153)

A remote operator may submit one exact agent-ready ticket through the dedicated
SSH forced-command boundary documented in
[remote-handoff.md](remote-handoff.md). The server, not the client, derives a
`factory.dispatch.requested` event with `source=handoff` and HMAC-signs the
exact `/events` request bytes using the existing runtime secret.

`handoff` is reserved from every public/operator replay path. Signed `/events`
is the only caller-facing boundary that may admit it; `chain` remains
in-process-only. A handoff is unattended and its
`operator_authorized` dispatch evidence is always false.

Only `source=handoff` + `factory.dispatch.requested` joins the existing
auto-approval path. It reuses the chain dispatch allowlist, immutable dispatch
evidence, `approve.before` hooks, runtime budget/worker-cap/circuit-breaker
guard, and evidence-changing execute-time recheck. It does not require a chain
predecessor because the authenticated handoff boundary is its provenance.
Every other handoff event type has no auto-approval policy. Ineligible,
sensitive, escalated, changed, blocked, overlapping, capacity-limited, or
otherwise unsafe dispatches therefore keep the same typed noop/watched outcomes
as unattended chain dispatch; they never become operator-approved.

## Autonomous develop merge lifecycle (WM-398)

Merge control is a durable runtime chain, not an interactive-orchestrator
procedure. A dispatch `PR_OPEN` completion immediately fans out a scoped
`factory.merge.requested {repo, prNumbers: [prNumber]}`, and a successful
pull-request `workflow_run` emits the same scoped request, idempotent per PR
head SHA. Scoped scans resolve exactly the named PR and never enumerate the
rest of the queue. The enabled 15-minute singleton schedule remains a full-set
sweep for missed events and human-opened PRs. Mechanical in-scope fixes are
SHA/finding-hash pinned and bounded to two rounds; a policy-safe plan contains
exactly one PR; and deterministic apply rechecks head/base SHA, CI, draft,
mergeability, and holds immediately before landing. Every stale/pending refresh
from apply carries that same PR number, preserving O(1) review work.
Apply never marks Done or deletes the branch. A proven landing emits an exact
merge-commit event whose deterministic verifier waits boundedly for base CI and
configured smoke. Only green landing evidence permits exact worktree/head
cleanup, Done, barrier release, and the next scan. CI RED, SMOKE RED, or
uncertainty blocks and preserves recovery state. Main/master, deploy branches,
sensitive behavior, and ambiguous reviews remain human-only.

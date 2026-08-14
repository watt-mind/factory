# Event runtime architecture

Status: **implemented and watched**. Slices 1 and 2 and the discovered-chain
machinery ship; the runtime lives at [`event-runtime/`](../event-runtime/README.md).
Tracking: OPS-203 (this design). Sections still marked deferred name what is
genuinely unbuilt; everything else describes running code.

This document captures an additive event-driven runtime for bounded, one-off
agents. It is deliberately separate from the factory's existing skill-based
orchestrator. The current workflow — a human invokes a `factory-*` skill and the
existing runner or ticket dispatcher acts — remains the primary, unchanged
path.

The event runtime starts watched and read-only. It earns automation one event
type and one capability at a time — and the same rule applies to its own
infrastructure: no piece of machinery is built before a named event type needs
it (§2).

---

## 1. Problem and scope

Some work begins with an event rather than a Linear queue scan or an interactive
skill invocation. A webhook may need to trigger one agent, validate its
structured output, pass that output to later agents, and aggregate the final
result. Those workers may eventually run on different hosts, containers, or
pods.

Not every run is repository work. A research, classification, reporting, data,
or operations agent may only need an isolated directory containing its declared
inputs. A Git repository and worktree are therefore one workspace provider, not
the runtime's foundation.

The runtime must provide:

- authenticated, replay-safe event intake;
- deterministic planning and scheduling outside the LLM;
- one bounded process per agent run;
- versioned input and output contracts;
- isolated workspaces with explicit capabilities;
- watched approval before execution in the MVP;
- independent verification of agent results;
- durable run state, retries, provenance, and aggregation;
- a path to remote workers without redesigning agent contracts; and
- no dependency on GitHub Actions.

"Deterministic agent" means a deterministic wrapper around a stochastic agent.
The planner, lifecycle, permissions, prompt version, input hash, output schema,
timeout, and acceptance rules are deterministic. The model's answer is not.

---

## 2. Event types and earned machinery

A runtime justified by one demo scenario is a red flag. These are the concrete
event types this runtime is expected to serve, in order, each named with the
machinery it earns. Anything no listed event type needs stays unbuilt.

| Event type | Source | Machinery it earns | When |
| :--- | :--- | :--- | :--- |
| `factory.status-report.requested` | operator webhook / replay CLI | intake, dedup, planner, approval, ephemeral workspace, schema verification, receipts | slice 1 |
| `keephq.disk-alert.raised` | Keep HQ infra alert webhook / replay CLI | two-node chain (diagnose → remediate) via the discovered-chain machinery, semantic verification recomputing reclaimed bytes from before/after probe evidence, typed remediation plans from a **closed action registry** (`lib/adapters/actions.mjs`), first infra-mutating executor behind watched approval (OPS-208) | shipped (watched) |
| `github.workflow-run.failed` | GitHub webhook / replay CLI | first discovered chain (OPS-223): typed `ci-doctor` diagnosis → recommendation edges → watched closed-command follow-ups (`gh run rerun`, notify); command adapter and edge registry | shipped |
| `sentry.issue.created` | Sentry webhook | *(dropped as a slice — Sentry already feeds Linear directly, so classifying here validates nothing operationally new; revisit only if that intake moves)* | — |
| `clock.tick.<loop>` | scheduler | admitted, audited timer events; per-loop migration of the standing loops — **[event-runtime-schedules.md](event-runtime-schedules.md)** (OPS-380/OPS-381) | shipped, loops off by default |
| repository-mutating events | GitHub / Linear | shared claim, capacity, Owned Paths, and approval authority with the ticket dispatcher (§3, designed in [event-runtime-dispatch.md](event-runtime-dispatch.md)) | last |

Clock events are called out deliberately. [architecture.md](architecture.md)
§2.7 keeps every timer in `config/schedule.yaml` disabled until a loop earns its
timer by being watched. This runtime is where an earned timer should eventually
land: a tick becomes an admitted event with the same planning, approval history,
and audit trail as a webhook, instead of a bare launchd job. Moving any loop
here is a separate per-loop decision, and the MVP enables no timer (§3).

Conversely, what no event type above needs yet — and is therefore explicitly
deferred, with its trigger named:

- **`FOR UPDATE SKIP LOCKED`** — the first *remote* worker node. Fencing
  tokens shipped with the worker split (OPS-233); the claim is `BEGIN
  IMMEDIATE` on SQLite (§10), correct for multiple processes on one machine.
- **Declared workflows with `dependsOn` and deterministic joins (§11)** — the
  first event type that needs a fan-out and a join. What shipped is the
  *discovered* form: one typed recommendation per completed run, resolved
  through `edges.json`.
- **`mounted`, `container` and `persistent` workspaces (§7)** — filesystem
  isolation as a policy axis, and any run needing a durable named workspace.
- **Remote workers** — undated; see §10 for why this is a possibility to keep
  cheap, not a requirement to build toward.

What has left that list by being built: semantic verification and
`evidenceSetHash` (slice 2), the chain engine (`lib/chain.mjs`), fencing
tokens (OPS-233), and the `artifacts` (OPS-372) and `repository` (OPS-228)
workspaces.

---

## 3. Compatibility boundary

The event runtime is an **opt-in sidecar**, not a replacement for the current
factory.

```text
Existing path — unchanged

human → factory-* skill → run-agent.sh / tick.mjs → current control plane

Event path — isolated MVP

webhook or replay CLI → event inbox → deterministic proposal → human approval
                      → event worker → validated artifact → result event
```

The MVP must not:

- modify `shared/commands/`, `shared/skills/`, or their generated copies;
- change `build/emit.mjs` or participate in the emit pipeline;
- change `orchestrator/run.mjs`, `orchestrator/tick.mjs`, or their schedules;
- change `config/schedule.yaml` or the launchd state;
- share mutable workspaces with interactive or ticket agents; or
- feed a result into the existing dispatcher automatically.

Three boundaries have moved deliberately since this was written, and are stated
rather than absorbed. **Timers:** the runtime has its own in-process scheduler
([event-runtime-schedules.md](event-runtime-schedules.md)); it touches neither
launchd nor `config/schedule.yaml`, and every loop ships `enabled: false`.
**Linear writes:** `triage-apply@1` and the scheduled `reaper@1` mutate ticket
state through closed action registries, so the runtime now writes to the same
control plane the dispatcher reads. **Repository mutation:** this list
originally also forbade "create worktrees, mutate repository source, or merge
code"; that rule is replaced — by design, not yet by code — with the
coordination rules in
[event-runtime-dispatch.md](event-runtime-dispatch.md): one ticket claim
(the Linear assignee), one capacity budget, one Owned Paths oracle, and one
approval authority shared with the ticket dispatcher, with the ship chain's
deploy-branch merge permanently a human approval.

Starting the API, planner, or worker is always explicit. Stopping all three has
no effect on skill invocation, emit checks, queue scans, or ticket dispatch.

This isolation is safe while event runs are read-only. Before an event run may
claim a ticket or modify code, both paths must share one distributed claim,
capacity, Owned Paths, workspace, and approval authority. Two independent
mutation coordinators would race even if their source trees were separate.
That sharing is now designed —
[event-runtime-dispatch.md](event-runtime-dispatch.md) (WM-107) records each
decision with its rejected alternatives — and unbuilt until the WM-108..WM-112
chains land it.

**Capacity is shared even when state is not.** The moment both paths run, their
agent processes draw on the same machine and the same subscription usage
window — which nothing can observe (architecture.md §2.9). An event storm could
starve ticket dispatch without violating a single rule above. The MVP therefore
runs **at most one event worker**, and coordination of the shared usage window
between the two paths is an explicit open problem for the unattended stage, not
an accident to discover later.

Since OPS-233 that cap is a **deployment choice, not a structural one**: the
worker is its own process (`cli.mjs work`), so running a second is starting a
second process, and concurrent claims are already correct (`BEGIN IMMEDIATE`
plus the existing leases and fencing tokens). Nothing prevents a second
worker except this rule — which stands until the usage-window question has an
answer.

---

## 4. Runtime model

Separate facts, decisions, commands, execution, and accepted results:

```text
External webhook / replay CLI / internal event
                    │
                    ▼
             authenticated inbox
          persist + dedupe + acknowledge
                    │
                    ▼
          deterministic planner/gate
                    │
        NOOP | HUMAN_NEEDED | RUN_SPEC
                    │
             watched approval
                    │
                    ▼
                 run queue
                    │
             one worker lease
                    │
        workspace → agent → verifier
                    │
                    ▼
          accepted structured result
                    │
          result + transactional outbox
                    │
         downstream planner / DAG join
```

A webhook is a hint, not truth. Before proposing or executing a run, the
planner re-reads the authoritative external system when one exists. Retries and
out-of-order deliveries must therefore converge on current state instead of
replaying stale intent blindly.

The core boundaries are pure where possible:

```text
plan(event, currentState, policy) → Noop | HumanNeeded | RunSpec
execute(runSpec, workspace, adapter) → CandidateResult
verify(runSpec, candidateResult) → AcceptedResult | ContractViolation
reduce(events) → current projection
```

The LLM appears only inside `execute`.

---

## 5. Versioned contracts

### 5.1 Event envelope

```json
{
  "schemaVersion": "factory.event/v1",
  "eventId": "source:delivery-123",
  "type": "factory.status-report.requested",
  "source": "operator-webhook",
  "subject": "factory",
  "occurredAt": "2026-08-12T10:30:00Z",
  "receivedAt": "2026-08-12T10:30:02Z",
  "correlationId": "workflow-01",
  "causationId": null,
  "payload": { "repos": ["bj29"] }
}
```

`(source, eventId)` is unique. The intake verifies the raw body before parsing,
records the payload hash, persists the event, and acknowledges quickly. A retry
returns the existing admission record and never spawns a second run.

### 5.2 Run specification

```json
{
  "schemaVersion": "factory.run-spec/v1",
  "runId": "run_01...",
  "agent": "factory-status-report@1",
  "input": { "repos": ["bj29"] },
  "inputHash": "sha256:...",
  "workspace": {
    "type": "ephemeral",
    "retainOnFailure": true
  },
  "adapter": "claude",
  "promptVersion": "git:7d91d88",
  "policyVersion": "git:7d91d88",
  "outputContract": "factory.status-report/v1",
  "capabilities": ["linear:read"],
  "timeoutSeconds": 600,
  "maxAttempts": 1,
  "idempotencyKey": "status-report:workflow-01:v1"
}
```

A `RunSpec` is immutable after approval. Mutable progress belongs in lifecycle
events. The idempotency key is unique independently of `runId`: duplicate
planning may find the existing run, while a retry creates another attempt under
the same run.

### 5.3 Run result

```json
{
  "schemaVersion": "factory.run-result/v1",
  "runId": "run_01...",
  "attempt": 1,
  "terminalState": "completed",
  "reasonCode": "ok",
  "outputContract": "factory.status-report/v1",
  "artifact": {
    "repos": [
      {
        "name": "bj29",
        "triage": 7,
        "agentReady": 4,
        "inProgress": 2,
        "blocked": 1
      }
    ],
    "recommendedAction": "dispatch"
  },
  "artifactHash": "sha256:...",
  "evidence": { "queries": ["<the reads the artifact derives from>"] },
  "evidenceSetHash": "sha256:...",
  "verification": {
    "status": "passed",
    "checks": ["schema_valid", "hash_recomputed"]
  },
  "artifacts": [
    { "kind": "transcript", "uri": "file://...", "sha256": "..." }
  ]
}
```

Allowed terminal states begin small: `completed`, `refused`, `failed`,
`timed_out`, and `cancelled`. Refusal is not failure: it carries a typed reason
such as `missing_input`, `permission_denied`, `needs_human`, or
`unsupported_capability`. Unknown fields, unknown terminal states, bad hashes,
and schema violations fail closed. Downstream consumers read only accepted
results, never free-form final messages or transcripts.

### 5.4 Idempotency key derivation

`"status-report:workflow-01:v1"` is not a free-form string. Left unspecified,
key derivation produces either duplicate runs or wrongly-suppressed legitimate
ones. The rules:

- Each registered event type declares its **idempotency scope**: the envelope
  fields the key is computed from (typically `correlationId` or `subject`, plus
  `inputHash` whenever different inputs must produce distinct runs).
- The planner computes the key deterministically from the agent id and version,
  the output contract version, and the declared scope fields. Same event type,
  same scope values → same key, always.
- Two admitted events that map to one key converge on one run; approving the
  second proposal finds the first run rather than creating a sibling.
- Keys never expire in the MVP. An event type that legitimately means "the same
  report, again, later" must put a period or sequence number into its declared
  scope. Expiry-by-wall-clock is hidden state and is rejected.

---

## 6. Agent definitions

An inbound event cannot provide an arbitrary prompt, command, mount, model, or
permission set. It selects a registered, versioned agent definition:

```yaml
id: factory-status-report
version: 1
prompt: event-runtime/agents/factory-status-report.md
input_schema: event-runtime/schemas/factory-status-report.input.json
output_schema: event-runtime/schemas/factory-status-report.output.json

workspace:
  type: ephemeral

capabilities:
  filesystem: workspace-only
  services:
    - linear:read

limits:
  timeout_seconds: 600
  attempts: 1

mutating: false
```

A definition is admitted only when its adapter can prove the required
capabilities. Adapter support is a contract, not a hopeful command-line flag.

**Adapters are a registry, not a flag.** `"adapter": "claude"` in the run spec
names an entry in a small adapter registry, one per harness the runtime has
actually tested. The emit pipeline targets several harnesses (Claude Code,
Codex, Gemini, Cursor, Pi); the event runtime admits only adapters with a
passing conformance test covering structured output, timeout and shutdown
behavior, and workspace confinement. The registry has four entries: `claude`
(the LLM harness), `command` (a closed argv template), `actions` (an approved
action list resolved against a closed registry, remote-SSH or local-argv), and
`fake` (tests and demo environments). It does not inherit the current runner's
entire adapter surface.

**Live trace is an optional adapter capability (`factory.trace/v1`).** An
adapter may stream what the agent is doing mid-run — via the `onTrace`
callback the worker passes to `execute()` — as events from a closed kind set:
`assistant_text`, `tool_use`, `tool_result`, `usage`, `lifecycle`. The trace
is agent-influenced output and treated as untrusted under the §14 size rules:
unknown kinds are dropped (and counted, never thrown), each event's payload is
byte-bounded and truncated in place when oversize, and an attempt records at
most 2,000 events — at the cap the runtime writes exactly one `lifecycle`
marker row (`trace_truncated`) and ignores the rest. Adapters that never call
`onTrace` remain fully conformant; the trace is observability, not part of the
result contract, and never affects verification or the run's terminal state.
Operators read it through `GET /runs/:id/trace` (or `cli.mjs trace <run-id>`).

**Two version schemes, one rule.** An agent's identity is `id@version`. The
registry pins each version to exact content hashes of its prompt and schema
files; editing a pinned file without bumping `version` is a registration error
and fails at admission. The run spec's `promptVersion: git:<sha>` is
**provenance**, not a second identity: it records the factory SHA resolved at
planning time. If the pinned content hashes disagree with that SHA's file
contents, admission fails closed.

Existing skill text may be read as versioned source material, pinned by the
factory Git SHA, but event definitions do not enter or modify the emit graph in
the MVP.

---

## 7. Workspace model

Every run has an execution directory. It does not necessarily have source code.

| Workspace type | Use | MVP |
| :--- | :--- | :---: |
| `ephemeral` | Empty directory populated only with declared inputs | yes |
| `artifacts` | Declared prior artifacts materialized by content hash, read-only (OPS-372) | yes |
| `repository` | Read-only checkout pinned to a SHA, from a per-repo bare mirror (tier 1, OPS-228); full worktrees for repo-mutating work are tier 2 — designed ([event-runtime-dispatch.md](event-runtime-dispatch.md)), unbuilt | tier 1 |
| `mounted` | Explicit existing directory, normally read-only | later |
| `container` | Isolated filesystem/volume in Docker or Kubernetes | later |
| `persistent` | Named, versioned workspace protected by a single-writer lease | later |

Ephemeral lifecycle:

```text
create unique directory
  → materialize declared inputs
  → write input.json
  → spawn agent with workspace as cwd
  → read declared result.json
  → validate and collect declared artifacts
  → retain on failure when policy says so
  → otherwise destroy
```

The workspace is scratch state. Accepted, content-addressed artifacts and run
events are durable state: at publish time the worker copies every verified
artifact file (including the adapter-captured transcript) into
`<home>/artifacts/<sha256>`, and the control API serves them from there —
result rows never reference files that died with a workspace. Passing work
between agents means materializing an accepted artifact into a new workspace,
not letting two agents share a live directory.

Working-directory separation is not a security sandbox. Filesystem, network,
secrets, CPU, memory, and process isolation are separate policy axes. A future
container provider may enforce them without changing the agent or result
contract.

A persistent workspace, if eventually required, carries a stable workspace ID,
an expected version, and a single-writer fencing token. Stale writers cannot
publish a result after their lease expires.

---

## 8. Lifecycle and delivery semantics

Use a closed finite-state machine. An initial run lifecycle is:

```text
PROPOSED → APPROVED → QUEUED → LEASED → RUNNING → VERIFYING
                                             ├─→ COMPLETED
                                             ├─→ REFUSED
                                             ├─→ FAILED
                                             └─→ TIMED_OUT
```

Additional transitions include proposal rejection, lease expiry back to
`QUEUED`, retry from `FAILED` to `QUEUED` while attempts remain, and operator
cancellation: any state before `RUNNING` may transition to `CANCELLED` with the
operator recorded as actor, and a running attempt is stopped with the factory's
timeout discipline (TERM, then KILL) and terminates as `cancelled`. Every
transition records actor, reason code, attempt, correlation ID, causation ID,
and policy version. Illegal transitions are rejected rather than repaired.

Delivery is **at least once**, never assumed exactly once:

- unique source event IDs deduplicate intake;
- unique run idempotency keys deduplicate planning (§5.4);
- leases expire and carry fencing tokens;
- each attempt has its own identity;
- only the current fencing token may publish a terminal result; and
- storing an accepted result and its derived event is one transaction via an
  outbox.

The event ledger is operational state. It does not replace Linear or another
domain system as the authority for business work.

---

## 9. Verification and receipts

The agent cannot certify its own result. Verification is ordinary code outside
the model process.

For a workspace-only result, MVP verification includes:

- result schema validation;
- canonical JSON serialization;
- recomputing `artifactHash`;
- checking declared files stay inside the workspace;
- checking required artifacts exist; and
- applying closed, data-only predicates where declared.

**These checks verify form, not truth.** A status report whose counts are
hallucinated passes every check above. For slice 1 that is acceptable and
stated, not hidden. From slice 2 onward, a data-bearing artifact must declare
its **evidence**: the agent records the raw inputs its claims derive from (for
example, the query responses it read), and the verifier either recomputes the
derived values from that evidence or re-executes the reads itself and diffs.
`evidenceSetHash` binds that evidence into the receipt; it earns its place at
slice 2, not before (§2). An artifact whose claims cannot be tied to evidence
is a contract violation, not a completed run.

Declared evidence is **retained inline in the accepted result**, size-limited
and failing closed when oversized (OPS-206): a hash whose bytes died with the
ephemeral workspace could never be rechecked, and slice 2's recompute needs
the bytes. Evidence too large to inline waits for the content-addressed
artifact store rather than being silently dropped.

Repository work later adds the exact repository verification command, executed
separately from the implementing agent. GitHub Actions is not required. The
verification record binds the immutable source ref, command, environment,
worker identity, exit code, and log hash.

A compact run receipt should bind hashes rather than repeat prose:

```json
{
  "runId": "run_01...",
  "runSpecHash": "sha256:...",
  "artifactHash": "sha256:...",
  "evidenceSetHash": "sha256:...",
  "journalHead": "sha256:...",
  "verificationStatus": "passed"
}
```

Per-record content hashes detect corruption and make receipts checkable. HMAC
or asymmetric signatures are deferred until results cross a trust boundary
where tamper evidence alone is insufficient. Journal ordering and the chaining
question live in §10.

---

## 10. Persistence and distribution

**This is a deliberate departure from architecture.md §1** — "the factory holds
no state of its own; restarting `tick.mjs` loses nothing." That principle works
because Linear is an authority that can always be re-read. A webhook has no
such authority: the delivery happens once, and if the runtime does not persist
the admitted event, approval decision, and result, they are simply gone. The
event ledger is therefore the authority **for event facts only**; Linear and
the other domain systems remain the authority for business work. The existing
orchestrator keeps its stateless model unchanged.

Because the contracts must not care where workers run, the logical model avoids
host-local PIDs, locks, and paths. The physical substrate can start small:

- **MVP: one embedded database.** SQLite (or a local Postgres, if already at
  hand) with a handful of tables: admitted events; action proposals and
  approvals; immutable run specifications; run attempts and leases; append-only
  lifecycle events; accepted results; transactional outbox events. With one
  worker (§3), lease contention does not exist; `FOR UPDATE SKIP LOCKED` is the
  mechanism the day a second worker process arrives, and guards nothing before
  then.
- **Second process: still SQLite** (shipped, OPS-233). A correction to this
  section's original plan: splitting the worker out of the API process did not
  need Postgres. SQLite in WAL mode already serves multiple processes on one
  machine — what it needed was `BEGIN IMMEDIATE` on the claim (the default
  deferred transaction lets two workers read the same `QUEUED` row before
  either writes) and `busy_timeout` set before `journal_mode`. Postgres with
  `FOR UPDATE SKIP LOCKED` is the **remote node** requirement, not the
  multi-process one.
- **Remote workers: a possibility kept cheap, not a requirement built toward**
  (expanded into a staged, ticket-shaped design in
  [event-runtime-workers.md](event-runtime-workers.md))**.**
  The binding constraint today is one machine and one usage window — the same
  reason architecture.md §4 rejects cross-repo parallelism. Keeping host-local
  assumptions out of the contracts costs nothing; buying distributed
  infrastructure ahead of a demonstrated need costs plenty.

Transcripts and artifact bytes may start on local disk, addressed by content
hash, and move behind an artifact-store interface when a second node is
introduced.

The append-only event journal is the replay surface. **Replay needs ordering,
not a chain**: a monotonic sequence column plus per-record content hashes give
rebuildable projections and corruption detection, and a projection rebuild
reports the first divergent sequence when verification fails. A global
previous-hash chain would serialize every writer on the chain head — directly
against the multi-worker goal — so chaining, if it ever appears, is per-run,
and it is not in the MVP. Timestamps are metadata; deterministic event identity
is computed from canonical payload bytes, event type, and sequence.

Do not introduce Kafka, NATS, leaderless claims, or Kubernetes in the MVP.
One database plus an outbox provides the required durability and event-driven
behavior at current scale. Transport can change later without changing event,
run, workspace, or result contracts.

---

## 11. Workflows and aggregation

Agents do not pass messages directly to live agent processes. Accepted result
events unlock later nodes in a small directed acyclic graph:

```text
Run A completed
  └─ analysis.completed
       ├─ Run B
       └─ Run C

Run B completed ─┐
Run C completed ─┴─ deterministic join → optional synthesis Run D
```

A workflow node declares:

- `id`;
- `dependsOn`;
- exactly one registered agent or deterministic command;
- input mapping from prior accepted artifacts;
- timeout and retry policy; and
- output contract.

Runnable nodes are selected topologically by code. Independent nodes may run in
parallel. A failed required dependency causes a downstream node to be skipped or
blocked according to declared policy, never guessed by an agent.

Aggregation is deterministic where possible: collect terminal states, validate
that all required outputs exist, and assemble an ordered input object. Spawn a
synthesis agent only when semantic synthesis is actually required.

What is built is the **discovered** form, not the declared one: a completed run
whose artifact carries a typed recommendation (`recommendationField` in
`edges.json`) emits one internal event through the same intake, and the planner
proposes the follow-up — watched like everything else. Chains are therefore
linear and depth-unbounded rather than a graph with joins: the CI chain is three
nodes (`ci-log-capture@1` → `ci-doctor@2` → `ci-rerun@1` | `ci-notify@1`). The
`dependsOn` workflow node above, and the deterministic join into a synthesis
run, are **not implemented**; they wait for an event type that actually fans out.

Per §2, the DAG engine is earned by slice 2 (`keephq.disk-alert.raised`,
OPS-208): a read-only LLM diagnose node followed — only after watched approval
of its typed plan — by a **deterministic-command remediation node**. That
second node is exactly the "registered agent *or deterministic command*"
option above: the model proposes, code executes. Slice 1 is single-node;
nothing beyond a two-node chain is built until a real workflow needs it.

---

## 12. Approval surface

Watched approval is the MVP's centerpiece, so it must be concrete, not a box in
a diagram.

**Where.** Two operator surfaces ship, and neither is the TUI this section
originally proposed: `cli.mjs`, a one-shot verb CLI (`proposals`, `approve
<id>`, `reject <id> "<reason>"`), and the web control plane at
`event-runtime/web/` ([event-runtime-webui.md](event-runtime-webui.md)). Both
are **clients, not the runtime**: every read and every verb goes through the
same control API the runtime exposes, never directly into the database. That keeps a future web app a second client of
identical endpoints, with the same audit trail, rather than a reimplementation.
There is no push notification in watched mode — the operator is, by
definition, watching. A notification channel (the existing `notify.py`
convention) belongs to the later unattended stage, where `HUMAN_NEEDED`
outcomes must reach an absent operator.

**What the operator sees.** The full `RunSpec`, plus the planner's evidence:
the admitted event, the authoritative-state read that produced the proposal and
its age, the capabilities requested, the timeout, and the attempt budget. The
operator approves a specific immutable spec, not a summary of one.

**Freshness.** The planner's re-read of authoritative state happens at plan
time, and a proposal can sit. Every proposal carries a TTL (default 30 minutes,
overridable per event type). Approving within the TTL executes the spec as-is.
Approving after expiry triggers re-planning against current state: if the
resulting spec is identical, it runs; if it differs, the new proposal is
presented instead. Approval of an expired proposal never silently executes
stale intent.

---

## 13. Operations and intervention

The state machine defines legal transitions; the operator needs verbs. The
existing orchestrator's `status.mjs` and `doctor.mjs` are the precedent: state
is inspectable and anomalies are surfaced, not discovered.

All verbs and views are control-API endpoints consumed by the TUI (§12); the
database is never a client interface. Operator verbs, all recorded as audited
lifecycle transitions with the operator as actor:

- **status** — admitted events, open proposals and their TTL age, runs by
  state, lease ages, retained workspaces, dead-lettered events.
- **cancel** — any run before `RUNNING` (§8); a running attempt gets TERM then
  KILL. In the same transaction, the unique open proposal for that run is
  closed with reason `run_cancelled`; none, or more than one (`ambiguousOpenProposals`), is left
  untouched.
- **retry** — a new attempt under a new attempt identity. Retrying past
  `maxAttempts` requires an explicit operator override and records it.
- **inspect** — the retained workspace path, receipt, and transcript for any
  attempt.
- **workers** — the registered worker processes: host, pid, labels, state,
  current run, and heartbeat age. Leases prove an *attempt* is held; this
  answers which processes are alive and what they may claim (OPS-233).
- **inject** — re-inject a stored event body through the same intake function
  the webhook uses (`POST /replay`); dedup rules apply unchanged. The CLI verb
  is `inject`; `replay` is the endpoint name.
- **trace** — the live trace for a run: assistant text, tool calls, usage.
- **agents / schedule / repos** — the registries as loaded: agent definitions
  with their pins and event routing, scheduled loops with last fire and next
  due, and the factory repo list.
- **requeue** — re-plan a dead-lettered or `human_needed` event in place:
  same admitted event, a fresh planning pass against current state. Replay is
  for a fixed *event body*; requeue is for a fixed *world* — after a registry
  or planner fix, the stored event is fine and only the decision was wrong.

**Dead-lettering.** An event that fails planning repeatedly (default: 3
attempts) parks as dead-lettered with its last error, visible in status and
eligible for replay after a fix. A poison event must not wedge the planner or
silently vanish.

**Doctor checks.** Expired leases not reclaimed, proposals past TTL, ambiguous
open proposals (more than one open proposal referencing the same run), outbox
rows never published, workspace directories with no corresponding run,
journal sequence gaps, a worker holding a run whose heartbeat has gone stale
(its lease may still be valid, so nothing has reclaimed the run yet), and
queued runs with no live worker to claim them. Each is an anomaly report, not an automatic repair.

---

## 14. Security boundary

Webhook intake and unattended workers widen the trust boundary, even in watched
mode.

The MVP therefore requires:

- fail-closed webhook authentication over the raw body;
- timestamp freshness and delivery-ID replay protection;
- registered event-to-agent mappings;
- capability allowlists per agent definition;
- workspace-relative paths with traversal rejection;
- size limits for payloads, inputs, outputs, and logs;
- secrets injected by the worker, never accepted in event payloads;
- no ambient credentials beyond declared capabilities;
- schema validation before downstream publication; and
- complete admission, approval, lease, execution, and result audit events.

**Capability declarations are audited, not enforced, in the MVP.** Honesty
matters here: the Linear API key is full-scope, workspace separation is not a
sandbox (§7), and the worker injects ambient credentials into the agent
process. `linear:read` therefore answers *what was authorized*, not *what was
possible*. The declaration still earns its place — it is validated against the
agent registry at admission, recorded immutably in the `RunSpec`, and auditable
after the fact. The enforcement path, in order:

1. **A worker-local egress proxy** that permits only declared services — for
   `linear:read`, a GraphQL proxy that forwards queries and rejects mutations.
   Cheap, genuinely enforcing, and a natural place to inject per-agent
   credentials (advancing [OPS-40](https://linear.app/watt-mind/issue/OPS-40)).
2. **Closed action registries for infra-mutating executors** (slice 2,
   OPS-208): the executor resolves approved action IDs to fixed command
   templates and refuses everything else — enforceable by construction, and
   the reason the remediation node is deterministic code rather than an LLM.
3. **The container workspace provider** for filesystem and network isolation.

Until one of these exists, a compromised or confused agent is limited by the
watched approval gate and read-only scope, not by the capability list.

**The control API is a trust surface of its own.** It binds to loopback only,
so the clients need no authentication story beyond local user access. The web
app (OPS-212) consumes the same endpoints and deliberately kept that boundary
rather than adding auth: `ACTOR` is hardcoded `"operator"`, and the web server
is a loopback static+proxy process. Real authentication and an authenticated
actor identity are a **precondition** of either surface ever binding to a
non-loopback address — not something to retrofit after exposure. Loopback is
not by itself a defence against a browser: see OPS-408 (no `Origin`/`Host`
check on mutating routes).

A rejected event writes no run. It may record a minimal rejection receipt that
contains hashes and reason codes but not a sensitive webhook body.

---

## 15. Watched MVP

The first vertical slice is a workspace-only, read-only status report:

```text
POST factory.status-report.requested
  → authenticate, persist, deduplicate
  → re-read current Linear state
  → propose factory-status-report@1
  → operator approves
  → create ephemeral workspace
  → run one bounded agent
  → validate factory.status-report/v1
  → record artifact and compact run receipt
  → emit factory.status-report.completed
```

The webhook may be replaced by a replay CLI during development; both call the
same intake function. The output is displayed to the operator and causes no
further action. The MVP runs a single event worker (§3) — since OPS-233 by
running one `work` process, not because the runtime can only host one.

MVP exit criteria:

- duplicate delivery produces one proposal and one run;
- no run starts before explicit approval, and no expired proposal executes
  without re-planning (§12);
- the agent has only workspace-local writes and declared read capabilities;
- valid structured output survives process restart and can be replayed;
- invalid output becomes a typed contract failure and emits no completion event;
- workspace cleanup is reliable, with optional failure retention;
- the operator can list, inspect, cancel, and retry runs (§13);
- existing factory tests and emit checks remain unchanged and green; and
- stopping the event runtime has no effect on existing skill orchestration.

**What slice 1 does and does not validate.** A status report is deterministic
counting — the model adds little and its output is trivially checkable. That is
deliberate: slice 1 validates intake, dedup, planning, approval, workspaces,
lifecycle, and restart survival. The plumbing. It does **not** validate the
runtime's reason to exist: accepting or rejecting *stochastic* output, and
gating a consequence behind approval. That is slice 2
([OPS-208](https://linear.app/watt-mind/issue/OPS-208)) —
`keephq.disk-alert.raised` drives a two-node chain: a read-only diagnose agent
proposes a typed remediation plan (action IDs from a closed registry, with the
`df`/`docker system df` evidence it derives from — never free-form shell); the
operator approves the concrete action list; a deterministic command node
executes the approved templates verbatim; the verifier recomputes reclaimed
bytes from before/after evidence (§9) and fails closed on mismatch. A stale
alert — disk healthy by diagnose time — converges to a typed NOOP, because a
webhook is a hint, not truth (§4). Slice 2, not slice 1, is the go/no-go
signal for this design.

Only after these slices are observed should the runtime add a two-node DAG,
then a second worker process, then — if ever needed — a remote worker.
Repository mutation is a separate, later approval boundary.

---

## Appendix A: What Bernstein validates

[Bernstein](https://github.com/sipyourdrink-ltd/bernstein) v3.14.159 was reviewed
while drafting this proposal. It is beta and broad, so it is a design reference
or optional experimental backend, not an event-runtime dependency yet.

Patterns worth adopting:

1. **Artifact mode instead of assuming Git.** Bernstein gives non-code tasks a
   plain `.sdd/workspaces/<session_id>` directory and treats the canonical
   artifact receipt, not the workspace or a commit, as durable output. This
   directly supports the workspace-provider decision above.
2. **Strict artifact contracts.** Report, dataset, action-log, and operations
   results have closed kinds, canonical bytes, content hashes, schema checks,
   and path traversal rejection. Malformed declarations fail rather than fall
   back to Git behavior.
3. **Deterministic orchestration outside the model.** Scheduling, dependency
   resolution, retries, lifecycle transitions, and verification stay in code.
4. **Typed opaque activity results.** Bernstein's activity boundary returns a
   modality, artifact hash, evidence-set hash, terminal state, and reason code.
   The scheduler validates hashes without understanding the artifact body.
5. **Idempotent audited webhooks.** Its webhook node authenticates before
   spawning, deduplicates on delivery ID, and binds inbound and outbound hashes
   to a run journal.
6. **Closed lifecycle transitions.** Explicit task and agent state machines
   make crashes, refusals, retries, and verification failures observable and
   testable.
7. **Small DAG workflows.** Agent and deterministic-command nodes are linked by
   explicit dependencies and run in topological layers.
8. **Adapter capability contracts.** Different CLIs vary in structured output,
   shutdown, and isolation behavior; conformance must be tested instead of
   hidden behind a nominally common interface.
9. **Artifact storage as a port.** Local files and object storage implement the
   same logical keys; workspace location does not define artifact identity.

Patterns to defer or avoid:

- Bernstein's many overlapping WAL, journal, audit, lineage, evidence, and
  receipt stores — the factory should begin with one event journal, one artifact
  interface, and compact receipts;
- its 40+ adapter surface — support only tested factory harnesses;
- leaderless mesh claims, multi-cell orchestration, SPIFFE, C2PA, and extensive
  signing machinery before a centralized local run works;
- legacy prose completion fallback — the new boundary is structured-only; and
- treating workspace separation as sandbox enforcement.

The most useful experiment is to run Bernstein behind a runtime-adapter
interface against one artifact-only scenario. Success would show that it can be
an execution backend; failure would not affect the event, run, workspace, or
result contracts. The event runtime must not become coupled to Bernstein's
internal `.sdd/` model.

Primary Bernstein references:

- [Architecture](https://bernstein.readthedocs.io/en/latest/architecture/ARCHITECTURE/)
- [Artifact contract](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/operations/artifacts.md)
- [Typed activity boundary](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/operations/activity-boundary.md)
- [Workflow manifests](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/operations/workflow-manifests.md)
- [Audited webhook node](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/operations/webhook-node.md)
- [Storage sinks](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/architecture/storage.md)
- [Known limitations](https://github.com/sipyourdrink-ltd/bernstein/blob/main/docs/reference/KNOWN_LIMITATIONS.md)

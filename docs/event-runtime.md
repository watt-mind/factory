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

- **API-mediated worker claims** — the first *remote* worker node. The
  control plane keeps `BEGIN IMMEDIATE` and SQLite behind authenticated
  `/worker/v1` endpoints; workers receive fencing tokens, never database
  credentials ([event-runtime-worker-protocol.md](event-runtime-worker-protocol.md)).
  The former `FOR UPDATE SKIP LOCKED`/shared-Postgres cut-line is rejected and
  superseded (§10).
- **Declared workflows with `dependsOn` and deterministic joins (§11)** — the
  first event type that needs a fan-out and a join. What shipped is the
  *discovered* form: one typed recommendation per completed run, resolved
  through `edges.json`.
- **`mounted`, `container` and `persistent` workspaces (§7)** — filesystem
  isolation as a policy axis, and any run needing a durable named workspace.
- **Remote workers** — undated; the protocol and migration are designed, but
  per-node auth, artifact ingest, and node-local workspace prerequisites remain
  unbuilt (§10 and [event-runtime-worker-protocol.md](event-runtime-worker-protocol.md)).

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
  "adapter": "pi",
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

**Per-agent repo scoping (`repos`, WM-64).** A definition may declare an
optional top-level `"repos": ["bj29", "cw-app"]` — a closed set of repos the
agent may run over, the repo analogue of the actions adapter's per-definition
host allowlist. Absent field = unrestricted (backward compatible). The
registry validates only the field's shape at load (non-empty array of
non-empty strings; an empty array is refused as a half-finished edit);
membership against `config/repos.yaml` is deliberately not checked at load,
because repos.yaml is external config that may legitimately change — the
planner's plan-time check is the authority. The planner refuses any event
whose `payload.repo` falls outside the declared set, whatever the workspace or
adapter: the event parks `human_needed` with reason
`repo_not_allowed: <agent> may not run over <repo> (allowed: …)`, before any
repo pin, mirror fetch, or worktree materialization happens. The declared
scope rides in the RunSpec (so the proposal an operator approves names it) and
is readable in `GET /registry`.

**Model-tier routing (`model_tier`, WM-135).** A definition may declare an
optional `"model_tier": "strong" | "standard" | "light"` — a statement of
intent, never a concrete model id. What each tier means is operator policy:
the `models:` block in `config/policy.yaml`, keyed per adapter
(`models.pi.standard: openai-codex/gpt-5.6-terra`), so retiering the fleet is
a one-line policy PR instead of an edit fanned across definitions. The literal
value `default` is a sentinel meaning "pass no model flag — ride the CLI's own
default"; any other value is passed verbatim as `--model`. The **planner
resolves tier → model at plan time and pins the result into the RunSpec**
(`modelTier` + `model`, the same pattern as `repoPin`), so the proposal the
operator approves, the stored run, and `inspect`/receipt output all name the
exact model; `GET /agents` and `cli.mjs agents` show the declared tier and the
per-route resolved value. Resolution order: per-definition `"model"` override
(the one escape hatch for an exact id — both fields may coexist, the override
wins) > tier map > adapter default (absent fields = no spec fields = today's
behavior). A declared tier with no mapping for a routed model-consuming
adapter is a **load error, fail closed** — never a silent fall-through to the
adapter default. Only the LLM adapters (`claude`, `pi`, `agy`, `cursor`) consume models; on
`command`/`actions`/`fake` routes a declared tier is recorded as not
applicable (`model: null`), never an error. Since WM-215 every committed
production LLM route is `pi`, so `models.pi` is the map that has to cover
every tier those routes declare (`strong`/`standard`/`light` →
sol/terra/luna); `models.claude` stays populated for the per-route exception
and for `--adapter-override claude`. `models.agy` and `models.cursor` cover
their smoke routes (`agy-smoke@1`, `cursor-smoke@1`). Tier assignments are intent the runtime cannot
yet audit: per-run usage observability (WM-66) is what will
show whether a tier is over- or under-provisioned and inform re-mapping.

**Adapters are a registry, not a flag.** `"adapter": "pi"` in the run spec
names an entry in a small adapter registry, one per harness the runtime has
actually tested. The emit pipeline targets several harnesses (Claude Code,
Codex, Gemini, Cursor, Pi); the event runtime admits only adapters with a
passing conformance test covering structured output, timeout and shutdown
behavior, and workspace confinement. The registry has entries for `pi`
(OPS-296, the default LLM harness on the Codex subscription window, WM-215),
`claude` (Claude Code, still fully supported), `agy` (Antigravity/Gemini,
WM-424), `cursor` (Cursor Agent CLI, WM-440 — smoke-only; no production
route), `command` (a closed argv template), `actions` (an approved action
list resolved against a closed registry, remote-SSH or local-argv), and
`fake` (tests and demo environments). It does not inherit the current
runner's entire adapter surface.

**pi is the default harness, per route, not per mode (WM-215).** Every
LLM-routed event type in `event-runtime/event-types.json` declares
`"adapter": "pi"`; `command`/`actions` routes are untouched. The choice lives
in one field per route, so routing a single event type back to Claude Code is
a one-line edit of that route — there is no global harness mode to flip, and
no route inherits a default. `claude` remains a first-class adapter: it is
what the per-route exception selects, and `--adapter-override claude`
(`cli.mjs serve`/`work`) forces runs onto it without touching the
registry. Note that an adapter override changes execution only — the model
still resolves against the **registered** route's adapter (§6, WM-135), so an
overridden run carries the pinned `models.pi` value.

**The `cursor` adapter (`lib/adapters/cursor.mjs`, WM-440) mirrors `pi.mjs`
against the Cursor Agent CLI.** Binary is `agent` on PATH, else
`cursor-agent` — never the `cursor` editor wrapper. Flags confirmed against
the installed CLI (`agent` 2026.08.11): `-p` is a boolean and the prompt is
a trailing positional (after `--`); `--output-format stream-json` is NDJSON
without `--stream-partial-output` (those deltas would double-emit);
`--trust` skips the workspace prompt; `--force` is required to *apply*
writes — print without it only proposes them. `--mode ask|plan` is
documented no-edits and is never passed: it would fail the result contract
(OPS-518). Read-only containment is the workspace cwd plus the worker
integrity gate, same audited-not-enforced framing as pi. `--worktree` is
Cursor's own worktree feature and is never passed. `CURSOR_API_KEY` is
passed through: CLI 2026.08.11 `agent -p` does not consume the
`agent login` session and exits 1 without the key (WM-443). That key is a
Cursor user credential and bills the account's plan / included usage
pools, not a provider BYOK invoice. `CURSOR_API_ENDPOINT` and provider
keys stay stripped. A non-zero CLI exit writes workspace `.stderr.txt`
and a `lifecycle` trace (`note: adapter_stderr`) so inspect is not blank.
Trace mapping targets the documented stream-json shapes:
`assistant` (complete messages only) → `assistant_text`, `tool_call`
started/completed → `tool_use`/`tool_result`, terminal `result` → `usage`
(duration only; Cursor does not report tokens). A missing CLI is a typed
`cli_not_found` preflight. The only committed route is
`factory.cursor-smoke.requested` → `cursor-smoke@1`; no production event
type is remapped.

**The `pi` adapter (`lib/adapters/pi.mjs`, OPS-296) mirrors `claude.mjs`,
adapted to a different CLI shape.** `pi -p --mode json` (prompt piped to
stdin, matching `runners/run-agent.sh`'s existing invocation) rather than
`claude -p <prompt>`; `--model` takes the tier-resolved `provider/id` value
directly (`openai-codex/gpt-5.6-terra`), no separate `--provider` flag. There
is no `--max-budget-usd` equivalent and no per-tool settings/sandbox policy —
those, and native capability enforcement derived from `spec.capabilities`, are
deliberately stage 2. `mutating: false` passes `--tools read,grep,find,ls,write`:
pi's own documented read-only pattern is omitting bash/edit from the
tool allowlist entirely, never exposing them to the model, rather than
intercepting a call to them at runtime the way claude's settings/sandbox
policy does — see §14. (`write` stays even on a read-only run: every
agent-result contract requires the model to write `./result.json`, so a run
without it fails `contract_violation:missing_result` before doing anything —
the same reasoning that keeps Write/Edit in claude's `READ_ONLY_TOOLS`.) (An earlier draft of this design read `-r` as pi's
read-only flag; the installed CLI's own `--help` says otherwise — `-r` is
`--resume`, a session selector, unrelated to tool access. Verify adapter flags
against the actual CLI before relying on ticket text.) `mutating: true` pi
agents are admissible under the same registry rule as any other LLM adapter
(`docs/event-runtime-dispatch.md` §6, WM-108): only over a tier-2 `worktree`
workspace — the registry's admission check at load time is adapter-agnostic
already, so no adapter-specific carve-out was needed. A missing `pi` CLI (and
no `npx` fallback) on PATH is a preflight refusal, not a spawn crash: the
adapter throws before spawning anything, and the worker recognizes it as the
typed `cli_not_found` reason code rather than the generic `adapter_error`.
Trace mapping targets pi's real `--mode json` shape — `message_end` (role
`assistant`) content blocks for `assistant_text`/`tool_use`,
`tool_execution_end` for `tool_result`. pi has no single terminal summary
message the way claude's `type: "result"` is one, so `usage` is accumulated
across every assistant turn's own reported tokens/cost and emitted once at
process close; fields pi never reported land as explicit `null`/`{}`, never a
guessed value.

**Both LLM adapters apply the same push-credential carve-out (WM-128,
WM-223).** `safeChildEnvironment(env, def)` in either adapter hands a mutating
run `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GITHUB_TOKEN` and `GH_TOKEN` on top of
the base inherited set, and strips all four from a non-mutating one — after the
caller's `env` is merged, so a read-only run cannot be handed a token through
`env` either. `pi.mjs` imports `PUSH_CREDENTIAL_ENV` from `claude.mjs` rather
than restating it: one list, no drift. Until WM-223 pi had no
mutating/non-mutating distinction at all, which meant the runtime's only
mutating LLM agent (`dispatch@1`, pi-routed since WM-215) reached its push step
with no credential of any kind — surviving only because `gh` reads its own
stored OAuth from `~/.config/gh/hosts.yml` through the inherited
`HOME`/`XDG_CONFIG_HOME`, and git picks up the `gh` credential helper the same
way. That gh-over-HTTPS route remains the paved road a dispatch run should
push on (`agents/dispatch.md` step 5); the carve-out is what makes an SSH or
token push a real fallback rather than a guaranteed failure. The optional
`gh auth status` preflight refusal considered alongside this was deliberately
not adopted: with the credentials restored, a mutating run can legitimately
push without gh being authenticated, so gating the start of the run on it would
refuse work that would have succeeded.

**One wrinkle the carve-out leaves open: `SSH_AUTH_SOCK` is not only a push
credential.** It is also how an agent reaches infrastructure over SSH, and a
read-only infra agent — `disk-diagnose` declares `mutating: false` with
`services: ["ssh:read:lab", "ssh:read:web"]` — may legitimately want the agent
socket despite being non-mutating. Both adapters strip it from such a run
today; `disk-diagnose` works because key-file authentication is reachable
through the inherited `HOME`, not because the socket survives. The fix, if that
ever becomes a real failure, is a capability-driven exception (a declared
`ssh:read` service inheriting the socket), **not** widening the non-mutating
default — the point of the strip is that a read-only run holds no authority it
did not declare.

**Live trace is an optional adapter capability (`factory.trace/v1`).** An
adapter may stream what the agent is doing mid-run — via the `onTrace`
callback the worker passes to `execute()` — as events from a closed kind set:
`assistant_text`, `tool_use`, `tool_result`, `usage`, `lifecycle`. A
`lifecycle` event whose note is `policy_denial` records the tool and rule that
rejected it; it is an operator-facing failure explanation, not an instruction
from the model. The trace is agent-influenced output and treated as untrusted under the §14 size rules:
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

Working-directory separation alone is not a security sandbox. For Claude
`mutating: false` runs, the adapter additionally passes a generated settings
policy: Bash is sandboxed with unsandboxed fallback disabled, the repository
checkout is denied filesystem writes, and `Edit`/`Write` are denied there while
workspace-local `result.json` remains allowed. The worker independently checks
`git status --porcelain` before accepting an output from a repository workspace;
any dirt is retained as `workspace_integrity_violation` and never published.
Filesystem, network, secrets, CPU, memory, and process isolation remain
separate policy axes; the future container provider can strengthen those axes
without changing the agent or result contract.

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

A typed refusal may be bare or may carry an artifact and evidence explaining
why the agent could not proceed. When present, that context is not an escape
from the output contract: the verifier validates the artifact against the
agent's output schema, applies its closed semantic predicates, retains the
artifact and bounded evidence in the accepted result, and recomputes their
hashes. An invalid refusal artifact therefore fails as a contract violation;
a valid one still produces `REFUSED` with its original reason code and no
completion event. The refusal's verification receipt records a passed
contract check, while the accepted result supplies the refusal reason and the
hash-bound explanatory context; bare refusals continue to have no artifact or
evidence hashes.

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

- **MVP: one embedded database.** SQLite holds admitted events; action
  proposals and approvals; immutable run specifications; run attempts and
  leases; append-only lifecycle events; accepted results; and transactional
  outbox events. The control plane is its only database principal.
- **Second process: still SQLite** (shipped, OPS-233). Splitting the worker out
  of the API process did not need Postgres. SQLite in WAL mode supports local
  contention with `BEGIN IMMEDIATE` on claim (the default deferred transaction
  lets two claimers read the same `QUEUED` row before either writes) and
  `busy_timeout` set before `journal_mode`.
- **Remote workers use the control API, not a shared database** (designed in
  [event-runtime-worker-protocol.md](event-runtime-worker-protocol.md)). This
  is an explicit boundary move and **supersedes this section's former cut-line
  #1**: do not port `db.mjs` to Postgres for distribution and do not put
  `FOR UPDATE SKIP LOCKED` or DB credentials in workers. The server performs
  the same atomic claim transaction behind `POST /worker/v1/claim`, returns a
  fencing token, accepts heartbeats and cancellation polling, and publishes a
  verified result plus outbox event transactionally. Local workers migrate to
  that API over loopback too, so schema evolution and substrate choice remain
  control-plane concerns.
- **Remote placement remains earned machinery, not an immediate requirement.**
  Per-node identity, HTTPS, content-addressed artifact ingest, adapters, repo
  mirrors/config, and (for tier-2) worktree coordination must exist before a
  remote node is enabled. The binding constraint today is still one usage
  window; keeping paths out of contracts is cheap, while deploying a fleet
  ahead of need is not.

Transcripts and artifact bytes start on local disk, addressed by content hash.
A remote worker uploads bytes through OPS-298's `POST /artifacts`; the control
plane recomputes hashes and deduplicates before the result endpoint may bind
them. Worker-local `file://` paths never cross the protocol.

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

**Push notifications (WM-65).** For the operator who is *not* watching, the
serve tick carries a push channel (`lib/notify.mjs`) over the existing
`notify.py` convention, covering exactly the two states that wait on a human:
an event parked `human_needed` pushes `BLOCKED <event-type> <eventId>:
<reason>`, and an open watched proposal pushes `DECISION NEEDED proposal <id>
(<agent>): expires in <n>m` once it crosses 50% of its TTL undecided, plus one
final `expired undecided` push if it expires. Each push fires once per subject
— dedup markers persist in the module-owned `notify_log` table, so serve
restarts never re-notify. The channel is **off by default**: set
`FACTORY_EVENT_NOTIFY=1` to enable it, and `FACTORY_EVENT_NOTIFY_CMD` to
replace the transport (default `python3 ~/Develop/hdkiller/scripts/notify.py`;
the message is appended as the final argument). Deliveries are fire-and-forget
with a 30s kill timeout; a notifier failure is recorded on `notify_log` and
the serve log, never thrown — the notify step is an isolated tick subsystem
like GC and chains (OPS-412). Routine flow (admissions, approvals, clean
completions) never notifies; a channel that pings on everything gets muted.

**Readable output (WM-452).** The artifact verification accepts is the chain's
truth; how a person reads it is a separate, closed contract — a schema-derived
view per agent, plus an optional agent-emitted presentation whose values point
back into the artifact. Design of record:
[event-runtime-artifact-views.md](event-runtime-artifact-views.md).

**Decisions, not just approvals (WM-383).** Approving a spec is one shape of
human input; the other is answering the question an agent stopped on. The
inbox ledger (WM-285) carries typed decision requests and responses for that —
agent-authored within a closed vocabulary, rendered generically, applied
through runtime-owned effects. Design of record:
[event-runtime-inbox.md](event-runtime-inbox.md).

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

**Capabilities are only partially enforced in the MVP.** For Claude
`mutating: false` repository runs, the settings policy and post-run integrity
gate enforce the filesystem boundary, and the adapter launches the child with
a minimal runtime environment instead of copying the worker environment. That
does not yet turn declarations such as `linear:read` into network authority:
those still answer *what was authorized*, not *what was possible*. The
declaration is validated at admission, recorded immutably in the `RunSpec`, and
auditable after the fact.

**pi (OPS-296) enforces `mutating: false` more coarsely than claude, and says
so rather than implying a parity it doesn't have.** claude intercepts a denied
tool call at runtime and reports a recognizable refusal message (WM-127); pi's
`--tools read,grep,find,ls` never offers bash/edit/write to the model as
callable functions in the first place, so there is no equivalent runtime
denial to observe or classify — `lib/adapters/pi.mjs`'s
`HARNESS_DENIAL_PATTERNS` is deliberately empty until a real refusal shape is
confirmed from the CLI, same discipline as claude's list. This is the same
audited-not-enforced framing as the service-capability declarations above:
what's authorized is recorded and reviewable; what's actually possible for the
model to attempt (a `bash` invocation of `pi` itself if the workspace's own
`PATH` were compromised, say) is a stage-2 concern, same as claude's.

Two per-definition allowlists ARE enforced by construction today, in contrast
to the audited-not-enforced service capabilities: the actions adapter's **host
allowlist** (`def.hosts` — an action naming a host outside the set fails the
attempt before anything executes) and the planner's **repo scoping**
(`def.repos`, WM-64 — an event naming a repo outside the set parks
`human_needed` at plan time, before any repo pin or mirror fetch, so a
`repository`/`worktree` workspace for an out-of-scope repo is never even
materialized). Both are closed sets in the registered definition, checked in
deterministic code on the refusal path, not policies a model is asked to
respect.

The remaining enforcement path, in order:

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

### 14.1 The Gondolin microVM sandbox (WM-185)

Paths 1 and 3 above now exist for **one adapter**, and the scope limit is the
important part of this section: a `command`-adapter definition may declare a
`sandbox` block, which moves that run off the host and into a Gondolin
microVM. **The claude and pi adapters still execute on the host** with the
worker's environment — the sandbox is not yet where the LLM agents run, and
nothing here should be read as if it were.

```json
"sandbox": {
  "provider": "gondolin",
  "allowedHosts": ["api.github.com"],
  "secrets": { "GITHUB_TOKEN": { "hosts": ["api.github.com"], "env": "GH_FACTORY_TOKEN" } }
}
```

What that buys, verified by real-VM tests in
`lib/sandbox/invariants.test.mjs` rather than asserted:

- **Filesystem.** The workspace is mounted read-write at `/workspace` and
  nothing else is visible — not the runtime home, not `~/.config`, not the
  rest of the checkout. Writes cross the boundary, so `result.json` and
  captured artifacts work unchanged.
- **Network.** Egress is default-deny at the host proxy. **An omitted
  `allowedHosts` denies everything**, which deliberately inverts the SDK's own
  default of allow-all-on-omission: a definition that forgets the key must not
  silently get the internet.
- **Secrets.** A definition names a host env var; it never carries a value.
  The guest receives an opaque `GONDOLIN_SECRET_…` placeholder, and the host
  proxy substitutes the real credential only on that secret's allowlisted
  upstreams. A placeholder sent anywhere else stays a meaningless string. A
  secret scoped to a host the allowlist does not permit is a policy error, not
  a no-op.

The result contract is identical to the host path — same `result.json`, same
artifacts, same exit-code semantics — so verification and receipts cannot tell
which path ran.

**The VM host runs under Node, not Bun, and that boundary is load-bearing.**
Measured against `@earendil-works/gondolin` 0.12.0 on macOS arm64: under Bun
the VM boots, the VFS mounts, and `vm.exec()` works, but the host-side TLS
mediation never answers — an allowlisted request hangs until its own timeout,
with no error and no debug output. Under Node it returns normally. So
`lib/sandbox/gondolin.mjs` (Bun) spawns `lib/sandbox/runner.mjs` (Node) as a
child and they speak NDJSON over a pipe; resolved secrets travel on **stdin**,
never argv, which any process can read via `ps`.

Operationally:

- `bun event-runtime/cli.mjs sandbox doctor` reports whether this host can
  honour a sandboxed run (QEMU, a Node ≥ 23.6, the SDK), and names what is
  missing when it cannot.
- `bun event-runtime/cli.mjs sandbox exec --dir . --allow api.github.com -- …`
  runs anything inside the sandbox by hand, without an event or a worker.
- A worker advertises `sandbox=gondolin` **only when that preflight passes**,
  so placement never routes a sandboxed run to a host that would just fail it.
  An explicit `--label sandbox=…` always wins, so a node can be forced off.
- Warm boot measured 51–93 ms; the first boot on a machine is ~10 s while
  ~200 MB of guest assets load once. The guest is Alpine with `bash`, `curl`,
  `node`, `npm`, and `python3` — **no `git`**, which is the main reason
  running the coding agents themselves in-guest is a separate piece of work
  rather than a flag flip.

**The control API is a trust surface of its own.** The operator/web routes bind
loopback today, so they still rely on local-user access: `ACTOR` is hardcoded
`"operator"`, and the web server is a loopback static+proxy process. The
separate designed worker surface is never exempt: even a loopback worker uses
a scoped node credential, and non-loopback worker traffic requires HTTPS
([event-runtime-worker-protocol.md](event-runtime-worker-protocol.md) §2).
Real authenticated operator identity remains a **precondition** of exposing
operator or web routes. Loopback is not by itself a defence against a browser:
see OPS-408 (no `Origin`/`Host` check on mutating routes).

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

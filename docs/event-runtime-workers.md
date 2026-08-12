# Event runtime: workers, placement, and chaining

Status: **design note; nothing here is implemented**. Tracking: OPS-221.
Companion to [event-runtime.md](event-runtime.md) §3, §8, §10, §11 — this
note expands the "second process → Postgres → remote workers" line of §10
into something ticket-shaped, without changing any decision made there.
Implementation tickets are deliberately not filed yet; §6 defines the
cut-lines for when the operator says go.

---

## 1. Today, precisely

One `serve` process is API, planner, and worker. "Worker" is a role inside
the 1-second tick, not a process: `runOnce` claims **at most one** `QUEUED`
run, executes it to a terminal state (the adapter spawn is the only real
child process), and the `busy` flag stops ticks from overlapping.

Two consequences worth stating because they answer real operator questions:

- **Concurrency is exactly 1.** Approving five proposals queues five runs;
  they execute one after another, ~one claim per tick. This is §3's "at most
  one event worker" made structural, not a missing feature: every
  claude-adapter run draws on the same unobservable subscription usage
  window as interactive sessions (architecture.md §2.9).
- **A run occupies the worker for its whole duration.** A 10-minute agent
  run means 10 minutes of queue. The lease (spec timeout + 120 s grace) and
  fencing token already make this safe to change — they were built for the
  multi-worker future, and guard nothing today.

## 2. Stage 1 — worker as a process (same machine)

The smallest real step, and a prerequisite for everything after:

- **Substrate: Postgres** replaces SQLite — same schema, same contracts.
  `claimNext` gains `FOR UPDATE SKIP LOCKED` (§10 names this as the
  mechanism that is meaningless before a second claimant exists).
- **`cli.mjs work`** — a standalone process running the loop `runOnce`
  already contains: claim → workspace → adapter → verify → fenced publish.
  `serve` keeps API, planner, approval, and outbox, and stops executing.
- **Concurrency becomes a worker count**, still deliberately small. Two
  `work` processes are the correctness proof (leases and fencing under real
  contention); raising agent-run parallelism beyond that waits for an answer
  to the usage-window problem, which no code can observe (§3).

Nothing downstream of the claim changes: contracts, verification, the FSM,
and the approval gate are untouched.

## 3. Stage 2 — workers on other nodes

A `work` process on another machine, talking to Postgres over the tailnet.
Workers do **not** talk to the control API — the API stays loopback on the
control node, so distribution adds no network-facing operator surface. The
webhook intake, approval, and web UI do not move.

What actually has to exist first:

- **Shared artifact backend.** Receipts and hashes live in the database, but
  artifact/transcript *bytes* are node-local disk behind `lib/artifacts.mjs`.
  That interface needs a shared backend — Postgres blobs are adequate at
  current volume, an object store later — or `inspect` and the web UI can
  only read artifacts from runs that happened to execute on the control
  node. Workspaces stay node-local and ephemeral; retained-on-failure
  debugging leans on captured transcripts, not remote paths.
- **Registry verification at claim, not trust.** Definitions are pinned by
  content hash and the RunSpec records `promptVersion: git:<sha>` (§6). A
  remote worker resolves prompt and schema files from its own checkout and
  **verifies the spec's content hashes before executing; mismatch → typed
  refusal** (`registry_mismatch`), re-queue for a current node. Version skew
  becomes visible instead of behavioral.
- **Per-node credentials and adapters.** Secrets are worker-injected (§14):
  each node carries its own Linear key / claude auth. A node registers only
  adapters it has passed conformance for — a node without the `claude` CLI
  simply never claims agent runs, only deterministic-command ones.

## 4. Labels and placement

Placement is **claim-side filtering, not a scheduler**. The claim query is
the whole mechanism:

- A worker starts with labels describing what and where it is:
  `node=lab`, `arch=arm64`, `adapter=claude`, `can=infra-exec`.
- An agent definition (and therefore its RunSpec, resolved at planning time)
  may declare `placement`: label requirements such as
  `{ node: "lab", can: "infra-exec" }`. No requirement → any worker.
- `claimNext` claims only runs whose placement its labels satisfy. Postgres
  evaluates the filter inside the same `SKIP LOCKED` query — there is no
  scheduler process, no bin-packing, no second coordinator (§3's rule: two
  mutation coordinators race).

Slice 2 is the motivating case: `keephq.disk-alert.raised` remediation must
execute *on the affected host*. Labels also encode the quota split cleanly:
`adapter=claude` workers are capped hard; `can=infra-exec` deterministic
executors (closed action registry, no model) can scale per node with zero
usage-window risk.

Unsatisfiable placement must surface, not hang: a run whose placement no
live worker's labels satisfy is a doctor-check anomaly (§13) after a
threshold age, with the missing labels named.

## 5. Chaining agents

Already designed — §11 — and not yet built (earned by slice 2). The rules
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
  is a *typed recommendation in A's output contract*, not an action A takes:
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

## 6. Ticket cut-lines (when the operator says go)

1. **Postgres substrate** — port `db.mjs`; same schema; `SKIP LOCKED` in
   `claimNext`; SQLite remains the default for demo/tests.
2. **`cli.mjs work`** — worker-as-process; `serve --no-worker`; two-process
   lease/fencing contention test.
3. **Artifact store backend** — shared-bytes implementation behind
   `lib/artifacts.mjs`; control-node reads for any node's artifacts.
4. **Labels + placement** — worker label set, `placement` in agent
   definitions and RunSpec, claim-side filtering, unsatisfiable-placement
   doctor check.
5. **Registry verification at claim** — content-hash check on the worker,
   `registry_mismatch` refusal path.
6. **Chaining slice** — §11's two-node DAG plus the typed-recommendation →
   proposal path, gated per event type.

Each is independently shippable and testable with the fake adapter; 1–2
are prerequisites for 3–5; 6 is orthogonal to distribution.

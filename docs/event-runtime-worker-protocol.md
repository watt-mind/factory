# Event runtime: worker control protocol

Status: **design — operator-ratified, unbuilt**. Tracking: WM-308. Companion to
[event-runtime.md](event-runtime.md) §10 and
[event-runtime-workers.md](event-runtime-workers.md) §3. This document is the
implementation contract for moving claims, leases, heartbeats, cancellation,
and result publication behind the control API.

---

## 1. Decision and boundary move

A worker never opens the event-runtime database. This is true for a worker on
the control node as well as one on a remote node: local workers use the same
API over loopback. The control plane remains the only database principal and
performs the existing `BEGIN IMMEDIATE` claim transaction, lifecycle
transitions, fencing checks, receipt creation, and result/outbox transaction.
A worker holds a scoped credential and a lease capability, not a database
handle.

This deliberately supersedes the old remote-worker cut-line: **do not port
`db.mjs` to Postgres and give workers DB credentials; do not implement
`FOR UPDATE SKIP LOCKED` in `claimNext` for distribution.** A shared Postgres
made claims remotely reachable, but also let the least-trusted process in the
system reach every run, approval, result, receipt, and outbox row. API-mediated
claims preserve the current SQLite atomicity, contain a compromised node to
its own leased attempt, decouple worker and schema versions, and leave the
physical database replaceable for control-plane reasons later.

The trust split is:

- **Control plane:** chooses a run, enforces placement, owns lifecycle and
  fencing state, validates submissions, creates receipts and outbox events,
  and writes the database.
- **Worker:** materializes a workspace, runs one adapter, collects verification
  evidence and artifact bytes, durably buffers the submission, and retries it.
  It cannot choose a run ID, approve a proposal, cancel another run, write a
  receipt, or request an arbitrary state transition.
- **Agent subprocess:** still receives only its declared workspace and
  capabilities. It never receives the worker credential or fencing token.

The protocol is versioned at `/worker/v1`. Additive response fields are allowed;
removing or changing a field requires `/worker/v2`. The claim response pins the
RunSpec schema version and `defHash`, so an old worker refuses an unsupported
spec instead of guessing.

## 2. Authentication and worker identity

Every node has its own random 256-bit bearer credential. The control node also
has a distinct credential for its loopback workers; loopback is not an
authentication bypass.

The server stores only a hash of the credential with:

- immutable `workerIdentity` and operator-visible node name;
- enabled/revoked state and creation, expiry, and last-used timestamps;
- allow-lists of labels, adapters, repository names, and workspace kinds the
  node may advertise; and
- scope `worker:execute` only.

Requests send `Authorization: Bearer <token>`. The authenticated identity, not
a body field, owns claims and audit records. Labels, adapters, repositories, and workspace kinds in a claim request must be
subsets of the credential's allow-lists; otherwise the server returns `403
capability_escalation`. A worker token may call only the worker
protocol and content-addressed artifact upload. It cannot call event intake,
proposal approval/rejection, operator cancellation/retry, arbitrary run reads,
or administration endpoints.

Credentials are written mode `0600`, injected into the worker process, and
never copied into a workspace, adapter environment, trace, result buffer, or
log. Non-loopback traffic requires HTTPS (for example, TLS terminated by the
control node on the tailnet); a bearer token over plain tailnet HTTP is not an
accepted deployment. Requests larger than their endpoint limit are rejected
before JSON parsing.

Revocation is checked on every request. It takes effect immediately: `401
credential_revoked`, no new lease, and no extension or publication for an
existing lease. The worker stops claiming, keeps buffered results, and reports
the credential error. Rotation creates a second credential for the same node,
updates the node, observes a successful authenticated heartbeat, then revokes
the old credential. A single fleet-wide secret was rejected because one node
would compromise every node; mTLS was deferred because per-node bearer tokens
over required TLS provide revocation and containment without a certificate
control plane.

## 3. Common wire rules

All bodies are JSON except artifact bytes. JSON requests carry
`Content-Type: application/json`; successful JSON responses carry
`schemaVersion: "factory.worker-api/v1"`. Timestamps are UTC RFC 3339 strings.
The fencing token is an opaque decimal string on the wire, even if the current
SQLite implementation stores an integer; clients compare or persist it but
never increment it.

Every claim attempt and result publication has a caller-generated UUID in the
`Idempotency-Key` header. The server persists the key, authenticated worker
identity, request hash, status, and response. Reusing a key with different
bytes returns `409 idempotency_conflict`; replaying the same request returns the
original response. A worker retries an unknown network outcome with the same
key. It generates a new key only after receiving a definite response.

Errors have this closed shape:

```json
{
  "schemaVersion": "factory.worker-api/v1",
  "error": {
    "code": "fenced",
    "message": "attempt 1 no longer owns run_01…",
    "retryable": false
  }
}
```

`400` is malformed input, `401` is missing/expired/revoked authentication,
`403` is a capability violation, `404` hides resources the identity never
owned, `409` is a valid request that conflicts with lease/fencing/idempotency
state, `413` exceeds a size limit, `422` fails contract or hash verification,
`429`/`503` is retryable and includes `Retry-After`, and other `5xx` responses
are retryable. The worker retries transport failures, `429`, and `5xx`; it does
not retry other statuses except by operator action.

For every run-scoped request the server first authenticates the node, then
loads the attempt, then checks all of the following before mutation:

1. `attempt` is the run's current attempt;
2. `fencingToken` equals the maximum token ever issued for that run;
3. the token was issued to this authenticated worker identity;
4. server time is strictly before `leaseExpiresAt`; and
5. the run is in a state accepted by the operation.

A failure of (1)–(3) is always `409 fenced`, is audit-recorded without changing
the run, and is never softened because the submitted payload looks valid. If
the token is current but (4) fails, the same transaction applies the ordinary
lease-expiry reaper transition/requeue (once) and returns `409 lease_expired`;
a late request cannot win the gap before a periodic reaper tick. A state
failure with a current, unexpired token is `409 attempt_terminal` or `409
illegal_phase`. These checks are repeated inside every mutating transaction,
including artifact grant and result publication. This order is the split-brain
and hard-deadline guarantee.

## 4. Claim

### `POST /worker/v1/claim`

Request:

```json
{
  "protocolVersion": 1,
  "workerVersion": "<git SHA or release>",
  "labels": { "node": "lab", "arch": "arm64" },
  "adapters": ["pi", "command"],
  "workspaceKinds": ["ephemeral", "repository"],
  "repositories": ["factory"]
}
```

The server runs one `BEGIN IMMEDIATE` transaction. It first replays an existing
idempotency record. Otherwise it selects the oldest `QUEUED` RunSpec whose placement, adapter,
workspace kind, and (when present) repository name match the authenticated
node's allowed declaration, increments the attempt and global fencing
counters, inserts the attempt with its owner and hard lease deadline,
transitions `QUEUED → LEASED`, and stores the idempotent response. No matching work is also a definite response; it does
not create a lease.

Claimed response (`200`):

```json
{
  "schemaVersion": "factory.worker-api/v1",
  "claim": {
    "runId": "run_01…",
    "attempt": 2,
    "fencingToken": "1842",
    "leaseExpiresAt": "2026-08-15T12:42:00.000Z",
    "heartbeatEveryMs": 15000,
    "spec": { "schemaVersion": "factory.run-spec/v1" }
  }
}
```

No-work response (`200`):

```json
{
  "schemaVersion": "factory.worker-api/v1",
  "claim": null,
  "retryAfterMs": 500
}
```

A worker has at most one active claim. A second claim request while it owns a
non-terminal attempt returns `409 worker_busy` and names that run. The server,
not the worker, filters placement; workers cannot request a specific run. The
lease deadline is the RunSpec timeout plus the existing grace period. A
heartbeat proves liveness but does not move that hard deadline, so a live but
wedged worker cannot retain a run forever.

## 5. Heartbeat, phase, and cancellation polling

### `POST /worker/v1/runs/:runId/heartbeat`

Request:

```json
{
  "attempt": 2,
  "fencingToken": "1842",
  "sequence": 7,
  "phase": "running"
}
```

`sequence` is monotonically increasing within the attempt. Replaying the same
sequence and body is idempotent; a lower sequence is ignored and answered with
the current control state; the same sequence with different bytes is `409
heartbeat_conflict`. Allowed phases are `leased`, `running`, `verifying`, and
`publishing`. The first `running` heartbeat atomically records `started_at` and
transitions `LEASED → RUNNING`; the first `verifying` heartbeat transitions
`RUNNING → VERIFYING`. Repeats do not create duplicate lifecycle events.
`publishing` is registry/observability state, not a run FSM transition.

Response (`200`):

```json
{
  "schemaVersion": "factory.worker-api/v1",
  "leaseExpiresAt": "2026-08-15T12:42:00.000Z",
  "cancel": { "requested": false, "reason": null },
  "serverTime": "2026-08-15T12:31:04.000Z"
}
```

This response is the cancellation poll. Heartbeats run on a timer independent
of the adapter so a long tool call does not hide liveness or cancellation.
When an operator cancels, the control plane commits the cancellation first;
the next heartbeat returns `cancel.requested: true`. The worker aborts the
adapter, cleans up, and sends no completion result. If cancellation races with
publication, whichever server transaction commits first wins: accepted result
first makes cancel an operator-visible conflict; cancel first makes publication
`409 attempt_terminal`. A disconnected worker eventually reaches its hard
lease deadline; the reaper requeues or fails it exactly as today.

## 6. Artifact upload

Artifact bytes use OPS-298's content-addressed ingest contract before result
publication:

```text
POST /artifacts
Authorization: Bearer <worker token>
Digest: sha-256=<base64 digest>
Content-Length: <bounded bytes>
Content-Type: application/octet-stream

<bytes>
```

The request also carries `X-Run-Id`, `X-Attempt`, and `X-Fencing-Token`.
Before reading bytes, the server applies the same owner/current-token checks as
a heartbeat and enforces the RunSpec's artifact count/per-object/total-byte
limits plus a per-credential rate limit. A worker with no current lease cannot
use CAS ingest as an unbounded upload surface.

The server streams to a temporary file, computes SHA-256 itself, rejects a
mismatched `Digest` with `422 digest_mismatch`, and atomically installs the
bytes at the content-addressed key. If the hash already exists it discards the
temporary bytes and returns the same metadata (`200`); a new object returns
`201`. In either case it records an attempt-scoped grant `(runId, attempt,
workerIdentity, hash)` only after a second fencing check. Thus retries and two
workers uploading identical bytes are harmless without granting one attempt
permission to bind another attempt's upload. The response names
`sha256:<hex>`, size, and media type.

A result refers only to uploaded hashes and metadata, never a worker-local
`file://` URI. The result endpoint verifies every referenced object exists,
size and hash metadata agree, and an attempt-scoped grant belongs to the
current authenticated lease. Artifact upload never changes run lifecycle state;
unbound CAS objects are safe for later garbage collection. OPS-298 owns the
byte-ingest implementation; the worker protocol owns lease binding, limits,
and when those hashes become part of an accepted result.

## 7. Result publication

### `POST /worker/v1/runs/:runId/result`

The worker sends one terminal submission after it has durably spooled the
manifest and artifacts (§8):

```json
{
  "attempt": 2,
  "fencingToken": "1842",
  "terminalState": "completed",
  "reasonCode": "ok",
  "result": { "schemaVersion": "factory.run-result/v1" },
  "artifactRefs": [
    { "kind": "transcript", "sha256": "sha256:<hex>", "size": 1234 }
  ],
  "execution": {
    "adapter": "pi",
    "exitCode": 0,
    "timedOut": false,
    "usage": {},
    "finishedAt": "2026-08-15T12:34:56.000Z"
  }
}
```

Allowed terminal submissions are `completed`, `refused`, `failed`, and
`timed_out`; the server maps them to the existing uppercase FSM states. The
worker does **not** submit a receipt, accepted timestamp, lifecycle actor,
outbox event, or arbitrary destination state. `completed` and `refused` must
carry a result matching the pinned output contract; failure-shaped submissions
carry bounded execution evidence and no accepted result.

Before any transaction the server checks body bounds, canonical hashes,
RunSpec/output schema, `defHash`, declared artifacts, evidence hashes, and the
existence and digest of every CAS object. It repeats the fencing and state
checks inside `BEGIN IMMEDIATE`, then performs the current atomic publication:
accepted result row, server-created receipt, attempt usage/finish, lifecycle
transition, and (for `completed` only) completion event in the transactional
outbox. Contract-invalid submissions become `422 contract_violation` and do
not change the run. A valid failure submission transitions/requeues according
to the pinned `maxAttempts`; it cannot name the next state.

The idempotency record is keyed by `(workerIdentity, runId, attempt,
Idempotency-Key)`. A byte-identical retry after a committed publication returns
the original `200` receipt even though the run is now terminal. A different
payload under that key is `409 idempotency_conflict`. A retry from an older
attempt after a new claim receives `409 fenced`, even if its output would
otherwise verify.

Successful response (`200`):

```json
{
  "schemaVersion": "factory.worker-api/v1",
  "accepted": true,
  "runId": "run_01…",
  "attempt": 2,
  "terminalState": "COMPLETED",
  "receipt": { "runId": "run_01…", "verificationStatus": "passed" }
}
```

## 8. Durable worker result buffer

A successful adapter exit is not durable until its result can survive both a
worker restart and a control-plane outage. Before workspace cleanup, the worker
creates an atomic spool entry under:

```text
$FACTORY_EVENT_WORKER_HOME/result-outbox/<runId>/<attempt>/<publishId>/
  manifest.json
  artifacts/<sha256>
  state.json
```

It writes files to a sibling temporary directory, fsyncs files and directory,
and renames the directory into place. `manifest.json` contains the exact
canonical result request minus the bearer credential; `state.json` records
retry metadata. Artifact files are copied or hard-linked before the workspace
is destroyed. The worker uploads missing artifacts, publishes the result with
`publishId` as its idempotency key, and deletes the entry only after the
server's durable `200` response has itself been fsynced to `state.json`.
Startup drains existing entries before claiming new work, and a worker with a
pending entry does not take another run.

Retry uses capped exponential backoff with jitter and server `Retry-After`.
Transport errors, `429`, and `5xx` stay pending. `401` stops claims and keeps
the spool for credential repair. `409 fenced` moves the entry to a quarantine
directory, never publishes it again, and reports the newer owning attempt.
`409 attempt_terminal` and `422` also quarantine with the response body for
operator inspection because retrying cannot make them valid. Quarantined bytes
have a documented retention/cleanup command; they are never silently deleted.

**Control-plane outage:** execution and atomic spooling continue. If the API returns before the hard lease expires, the worker retries and the
result is accepted exactly once. If the outage outlives the lease, the first
late request or periodic reaper atomically expires/requeues the attempt; that
request receives `409 lease_expired`, and any request after a new claim receives
`409 fenced`. The old buffered entry is quarantined in either case.
The completed work is preserved for diagnosis, never allowed to overwrite the
new attempt, and the run executes again if policy permits. This trades possible
duplicate execution for no lost accepted result and no stale overwrite.

**Split brain:** worker A loses connectivity, its lease expires, and worker B
claims attempt 2 with a higher token. Every later heartbeat, artifact binding,
and result publication from A receives `409 fenced`; only B can transition the
run. A's buffered output is quarantined. This case must be an integration test
that pauses A after execution, reaps and reclaims, then proves A cannot create a
result, receipt, completion event, or terminal transition.

## 9. Migration and compatibility

Use a short compatibility window, not a flag-day cutover and not an automatic
fallback:

1. Add the worker endpoints and fencing/idempotency tests while `work` still
   defaults to direct DB. Keep the API loopback-only and require a single
   operator-provisioned bootstrap worker credential from a mode-`0600` file;
   there is no unauthenticated development or loopback bypass.
2. Add the HTTP client and durable buffer. Run a control-node worker with that
   bootstrap credential and explicit `--transport api`; compare receipts and
   exercise server restarts.
3. Make loopback API the default and retain `--transport db` only as an
   operator-selected rollback for one release. API failure must never silently
   fall back to DB, because that restores the authority the boundary removes.
4. Replace the bootstrap file with the per-node issue/rotate/revoke store,
   remove direct-DB worker claiming and DB path/config access from `work`, and
   require TLS before any non-loopback bind. The control plane may continue
   using SQLite internally.
5. Add artifact upload and only then enable a remote node.

API and legacy local workers may coexist during the compatibility window
because both claims still enter the same control-plane claim transaction; they
must not use two databases. The window exists for rollback only and has a named
removal ticket, since leaving direct DB as a permanent alternate path would
nullify the security decision.

## 10. Remote-node prerequisites and first scope

The protocol removes database locality; it does not make a workspace portable.
A remote node still needs the adapter binaries and credentials it advertises,
a runtime-compatible worker build, workspace storage, and machine-specific
repository configuration.

The first remote scope is:

- workspace-only read-only agents and deterministic commands whose declared
  dependencies exist on that node; and
- tier-1 repository scans **after** that node has a local bare mirror/fetch
  credential and a per-node mapping for the named `config/repos.yaml` entry.
  The worker derives its advertised repository set from mappings it validates
  at startup; claim-side filtering includes that set. The RunSpec remains
  pinned to a SHA and `defHash`, both verified locally.

Tier-2 mutating worktree dispatch is **not** in the first remote scope. It needs
per-node `worktree_up`, `worktree_down`, verify command, ports, database setup,
and repo paths, plus event-runtime-dispatch.md §9's shared ticket claim and
capacity authority. No remote mutating worker may be enabled while those
machine-local ledgers remain the only coordination. A node without a declared
repo mapping cannot claim that repo's run; it returns no local-path guess.

## 11. Sequenced implementation tickets

The implementation is split so no network-facing worker endpoint is exposed
before its prerequisite is testable:

1. **Protocol server and fencing** — **WM-321**: implement authenticated
   `/worker/v1` claim/heartbeat/result on loopback using the bootstrap
   credential, server-owned transitions/receipts, and idempotency plus the
   split-brain integration test.
2. **Worker client and durable result buffer** — **WM-322**: API transport,
   atomic spool/restart recovery, outage tests, loopback-default migration,
   and removal plan for direct DB claiming.
3. **Per-node authentication** — **WM-323**: replace the one-node bootstrap
   credential with issue/rotate/revoke, allow-listed labels/adapters/repos/
   workspace kinds, audit, HTTPS-only non-loopback binding, and proof that
   worker credentials cannot reach operator routes.
4. **Remote-node wiring** — **WM-324**: deploy the worker and per-node config
   through the existing OPS-445 lifecycle, depend on OPS-298 artifact ingest,
   and enable only the §10 first scope.

Each ticket depends on the previous one. OPS-298 is additionally required
before the first remote result containing artifact bytes; tier-2 remote work
remains separately blocked on dispatch coordination rather than being widened
into these tickets.

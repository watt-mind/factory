# Event runtime: node-local repository provisioning

Status: **design accepted; implementation split into WM-314..WM-318**. Tracking:
WM-311. Companion to [event-runtime.md](event-runtime.md) §7,
[event-runtime-workers.md](event-runtime-workers.md) §§3–5a, and
[event-runtime-dispatch.md](event-runtime-dispatch.md).

This note answers one prerequisite for remote workers: how a worker gets a
repository that is not already on its disk. It covers both the tier-1 bare
mirror used by read-only repository workspaces and the full, non-bare checkout
required by a repo's tier-2 `worktree_up` script.

The central decision is that repository provisioning is **node-scoped cached
state**, not run-scoped workspace setup:

- `ensure` is idempotent provisioning. It may take minutes once, then its
  result is reused by many runs on that node.
- A provisioned checkout is a worker capability. A worker advertises a repo
  only after the checkout and its toolchain pass preflight.
- A cold node does not claim a tier-2 run and clone inside the run timeout. It
  is provisioned out of band, then becomes eligible.
- There is deliberately no `repo_down` paired with `repo ensure`. Deletion is
  disk-pressure garbage collection with LRU and safety guards, not run
  teardown.

This preserves the existing workspace distinction. A tier-1 run still gets an
ephemeral detached worktree from a cached bare mirror. A tier-2 run still
delegates branch, ports, services, and per-ticket database setup to the repo's
own `worktree_up`/`worktree_down` scripts. Provisioning supplies the stable
checkout those mechanisms need; it does not replace either mechanism.

---

## 1. The gap, precisely

`config/repos.yaml` is the routing registry, but its `path:` values currently
name directories on the operator's laptop. Tier 1 can use `github:` when a
local checkout is absent (WM-310). Tier 2 cannot: `worktree_up` executes with
`cwd` set to the full checkout and expects the repo's scripts, Git metadata,
dependencies, and local tooling to exist there.

Cloning after a run is claimed is the wrong fallback:

1. it spends the ticket's run timeout on a node setup problem;
2. clone/auth failures become false ticket failures and trigger ticket
   rollback;
3. two workers can race to build the same checkout;
4. the checkout is useful after the run, so deleting it at completion repeats
   the expense indefinitely; and
5. a clone alone says nothing about whether Bun, Node, Python, Docker, or the
   repo-specific worktree prerequisites match CI.

The control plane therefore separates three states:

| State | Meaning | Tier-2 claim eligible? |
| :--- | :--- | :--- |
| absent | no checkout at the node-resolved path | no |
| present | a full checkout exists, but readiness is unknown or stale | no |
| ready | path, identity, auth, lifecycle scripts, toolchain, and repo check have a current attestation | yes |

A node can move from absent to ready without any event run or Linear ticket.

---

## 2. Node-local path resolution

### 2.1 Configuration shape

`config/repos.yaml` remains the single repository registry. Its `path:` is
redefined narrowly as the **local/default-node path**, preserving today's
single-node commands and interactive operator checkout:

```yaml
repos:
  - name: factory
    path: ~/Develop/factory       # local default, not a fleet-wide path
    github: watt-mind/factory
    base: develop
    # worktree_up/down/root, verify, toolchain, etc.
```

A remote worker node extends its existing SSH inventory entry with a managed
root and may override individual repositories:

```yaml
nodes:
  runner:
    host: runner.tailnet.example
    user: factory
    factory_root: ~/.factory/control
    repos_root: ~/.factory/repos
    repos: {}

  mac-mini:
    host: mac-mini.local
    user: hdkiller
    factory_root: ~/Develop/factory
    repos_root: ~/.factory/repos
    repos:
      factory:
        path: ~/Develop/factory   # use the operator-owned checkout here
        managed: false
```

`repos_root` contains full checkouts as `<repos_root>/<repo.name>` by default.
An explicit `nodes.<node>.repos.<name>.path` supports a machine where the
operator's existing checkout should be used. `managed: false` is the default
for an override: Factory may inspect and use a passing checkout, but may not
clone over it, fast-forward it, repair it, or evict it. Paths derived from
`repos_root` are managed.

`loadNodesConfig` in `event-runtime/lib/workers-remote.mjs` remains the one
owner of `config/nodes.yaml`: WM-314 extends its validated node record rather
than adding another YAML reader. Existing `host`, `user`, `factory_root`,
`branch`, labels, and adapters retain their meaning. `repos_root`, overrides,
and credential paths are expanded in the target node's home, not the control
node's. The unnamed local/default mode is not a synthetic `nodes.yaml` entry;
it continues to use `repos.yaml` directly.

No credentials are embedded in either file. Section 4 defines references to
node-local credential providers.

### 2.2 Resolution order and compatibility

Every consumer that needs a **full checkout path** uses one resolver and
receives `{path, managed, source, node}`:

1. with a named node, use its explicit repo override when present;
2. otherwise use `<nodes.<node>.repos_root>/<repo.name>`;
3. without a named node (the current local mode), use `repos.yaml` `path:`.

A named node whose tier-2/provisioning operation has neither an override nor
`repos_root` gets typed `repo_path_unconfigured`. It must **not** fall back to
`repos.yaml` `path:`: silently treating another machine's absolute path as
local is the bug this design removes.

The resolver expands `~`, canonicalizes the nearest existing parent, and
rejects a managed destination that escapes `repos_root` through `..` or a
symlink. It does not require the final directory to exist—absence is exactly
what `ensure` handles. Tier-1 mirrors, tier-2 workspace creation, janitor,
doctor, and provisioning all use this resolver; parallel path rules would
recreate the global-constant bug under different names.

Tier-1 source selection is deliberately adjacent but not identical. A
read-only mirror uses, in order: an already resolved full checkout when one
exists, its existing bare mirror, then WM-310's declared `github:` remote
fallback with read credentials. A named node does not need `repos_root` merely
to run tier 1, and tier 1 must not raise `repo_path_unconfigured` before trying
its mirror/remote sources. This preserves cold, fungible read-only workers
while tier 2 remains sticky to a provisioned checkout.

`worktree_root` has the same node-local problem, but its safe default follows
from the checkout: a managed node uses `<repos_root>/.worktrees/<repo.name>`;
an explicit repo path may also supply a node-local `worktree_root` override.
The existing `repos.yaml` value remains the local-mode default. The resolver
must return both paths together so `worktree_up`, workspace linking, and
janitor cannot disagree.

---

## 3. Provisioning and placement

### 3.1 `factory repo ensure <repo>`

Provisioning is an operator/control-plane capability with a library entry
point and a CLI:

```text
factory repo ensure factory
factory repo doctor factory
```

`ensure` runs on the target node and holds a node-local lock keyed by repo. It:

1. resolves the node-local path and ownership mode;
2. if absent and managed, obtains a read credential and clones a full,
   non-bare checkout from the declared `github:` identity;
3. if present, verifies it is a full Git checkout with the expected canonical
   origin and base ref;
4. never mutates an unmanaged operator checkout;
5. runs the readiness preflight in §§5–6; and
6. atomically publishes the resulting readiness attestation.

Repeated and concurrent calls converge on the same checkout. A failed clone
is staged in a temporary sibling and never leaves a half-populated destination
that a second call could mistake for ready. Rename into place happens only
after Git identity checks pass. Existing wrong-origin content, a partial
clone, an in-progress operation, or a non-directory destination fails typed;
`ensure` does not guess at destructive repair.

A managed checkout may fetch and fast-forward its clean base branch under the
same lock. It never resets a dirty tree, discards an unpublished commit, or
switches a branch used by a live worktree. An unmanaged override is
validation-only even when clean.

### 3.2 Out of band, never inside the run

Two entry points may request provisioning:

- the operator runs `factory repo ensure <repo>` on a node; or
- the control plane emits `factory.repo.provision.requested` to a deterministic
  node action that invokes the same library.

The event, if implemented, is a provisioning operation, not a wrapper around a
ticket dispatch. It has its own timeout, receipt, and typed result. It neither
claims a Linear issue nor occupies an agent worker's run lease. A failed
provision request leaves the ticket queue untouched and reports one recovery
command.

There is no implicit clone in `materializeWorktree`. If readiness is absent or
stale there, the typed outcome is `repo_not_ready`; the worker withdraws the
capability and the queue remains visible as unsatisfied placement.

### 3.3 Repository capability advertisement

Flat placement labels are appropriate for facts such as `arch=arm64`, but not
for a node that may hold many repositories. Worker registration therefore
gains a structured `readyRepos` map alongside labels. Each entry carries only
bounded attestation metadata, not credentials:

```json
{
  "factory": {
    "configHash": "sha256:…",
    "checkoutRealpath": "/home/factory/.factory/repos/factory",
    "verifiedAt": "2026-08-15T18:00:00Z"
  }
}
```

A tier-2 RunSpec already names its repo. Claim-side filtering admits only a
worker with a current ready entry for that repo. This extends the existing
placement mechanism; it does not introduce a scheduler, queue mover, or
bin-packer. A cold node simply cannot claim that run.

Workers refresh the map on startup, after a successful `ensure`/`doctor`, and
when the attestation changes. They recheck cheap invariants immediately before
`worktree_up` (path identity, attestation/config hash, lock state). A mismatch
withdraws the entry and refuses before an agent starts.

Doctor/API diagnostics must distinguish “workers exist but none has repo X
ready” from generic queue starvation and print the exact recovery:

```text
repo factory is not ready on any eligible node
runner: absent — run `factory repo ensure factory` on runner
```

Remote **mutating** workers remain blocked on WM-308's shared claim/identity
precondition from event-runtime-dispatch.md §9. Repository readiness solves
materialization, not the cross-node ticket lock or capacity ledger.

---

## 4. Credentials are the gate

A private clone needs a node identity. The checkout algorithm is routine; the
credential lifecycle is the security decision.

### 4.1 Long-run provider: GitHub App

OPS-488 is the target provider: a Factory GitHub App installation issues a
short-lived, repository-scoped token with read-only contents permission for
provisioning. The token is requested just in time, passed to the Git
subprocess through an ephemeral credential helper/environment channel, and
never written to the remote URL, YAML, logs, receipts, or the checkout.

Provisioning read authority and a mutating run's push authority are separate.
A ready checkout does not imply that a future agent receives push credentials;
the adapter still injects the minimum per-run authority allowed by the run.

### 4.2 Interim provider: read-only deploy key

Until OPS-488 lands, a node may reference a repository-scoped read-only deploy
key:

```yaml
nodes:
  runner:
    repo_credentials:
      factory:
        type: deploy_key
        key_file: ~/.config/factory/keys/factory-readonly
```

The file contains the secret; YAML contains only its path. Preflight requires
strict file permissions, pinned `known_hosts`, and an origin matching the one
repo that owns the key. The key is exposed only to the clone/fetch subprocess,
not inherited by model adapters. A shared writable key is not an acceptable
shortcut.

A long-lived PAT in `nodes.yaml`, a credential-bearing remote URL, and a
workspace-wide deploy key are all configuration errors. Missing/expired auth
is a typed `repo_auth_unavailable`/`repo_auth_denied` provisioning result, not
a failed dispatch run.

---

## 5. Toolchain contract

A full checkout is not useful if it cannot run the repo's worktree script or
verification command. Each dispatchable repo declares executable version
constraints:

```yaml
repos:
  - name: factory
    toolchain:
      bun: ">=1.3 <2"
      node: ">=22 <25"
      git: ">=2.40"
    repo_ready_check: bin/repo-ready-check.sh
```

The contract records what the repo requires; it does not select a version
manager or install system packages. `repo doctor` resolves each executable in
the same non-interactive environment a worker uses, captures its normalized
version, and checks the constraint. A mismatch is
`repo_toolchain_mismatch` with node, executable, constraint, observed version,
and recovery guidance. It happens before claim, workspace creation, dependency
installation, or model spawn.

The generic checks cannot know whether a repo needs a local Postgres role,
Docker daemon, mobile SDK, signing setup, or another repo-specific service.
`repo_ready_check` is therefore a repo-owned, non-mutating preflight contract,
analogous to ownership of `worktree_up`:

- it may inspect dependencies and warm caches;
- it must not create a ticket worktree, branch, database, or dev server;
- it must be idempotent and bounded by its own timeout; and
- non-zero exit becomes typed `repo_ready_check_failed` with bounded output.

A dispatchable repo without this command can remain usable in today's local
mode, but it is not advertised ready on a remote node. That fail-closed rollout
prevents “clone succeeded” from being mistaken for “this machine can safely
isolate a ticket.”

The existing `verify:` command remains result verification after an agent has
changed code. It is not reused as provisioning preflight: running a full suite
on every heartbeat is expensive, and a green suite does not prove ports or
per-ticket database setup are available.

---

## 6. Verification and trust

### 6.1 What `repo doctor` proves

A successful readiness preflight proves, for one node and repo:

1. node-local path resolution is unambiguous and contained when managed;
2. the destination is a full non-bare Git checkout, not a bare mirror or
   partial staging directory;
3. canonical origin matches `github:` and the declared base ref is fetchable;
4. no provisioning lock or interrupted Git operation is present;
5. configured `worktree_up`, `worktree_down`, and `verify` contracts exist,
   and lifecycle scripts are executable;
6. read credentials can access the remote without printing them;
7. every declared toolchain constraint passes; and
8. the repo-owned readiness check passes.

Doctor is side-effect free except for bounded credential probes, fetch metadata
when explicitly requested by `ensure`, and writing the attestation. It never
starts an agent. For an unmanaged checkout it also reports dirty/ahead state;
those conditions do not authorize repair.

### 6.2 Attestation and freshness

The attestation is node-local durable state keyed by repo and includes:

- node and repo names;
- resolved path, realpath, and managed/unmanaged ownership;
- canonical origin and observed base commit;
- a hash of the relevant node/repo configuration;
- observed tool versions and the readiness-check digest/result;
- verification time and implementation version.

It excludes tokens, key paths, command output beyond a bounded summary, and
arbitrary environment variables. Publication is atomic. A changed config hash,
path inode/realpath, origin, tool version, readiness-check file, or maximum age
invalidates it. Worker heartbeat advertises only valid attestations.

Freshness is defense in depth, not the only gate. Immediately before
`worktree_up`, the worker verifies the attestation hash, resolved path identity,
and absence of a provisioning/GC lock. The repo script remains responsible for
its own runtime checks and must still fail rather than share ports or a
database.

### 6.3 Typed failures

Provisioning/readiness failures are operational outcomes, not generic agent
failures. At minimum the implementation distinguishes:

- `repo_path_unconfigured`, `repo_path_escape`, `repo_path_conflict`;
- `repo_auth_unavailable`, `repo_auth_denied`;
- `repo_clone_failed`, `repo_origin_mismatch`, `repo_base_unavailable`;
- `repo_toolchain_missing`, `repo_toolchain_mismatch`;
- `repo_ready_check_failed`, `repo_attestation_stale`; and
- `repo_not_ready` at the final workspace gate.

Every result names node, repo, failed check, and one operator action. No result
includes secret material. Placement anomalies remain visible instead of aging
silently behind a queue head, matching event-runtime-workers.md §4.

---

## 7. Garbage collection, not `repo_down`

### 7.1 The asymmetry is intentional

`worktree_up`/`worktree_down` are a legitimate run lifecycle: each ticket gets
a branch, ports, services, and often a database, all of which should disappear
when that ticket is safely finished.

Repository provisioning is different:

```text
repo ensure  -- node-scoped, idempotent, expensive once, cached across runs
repo gc      -- node-scoped, pressure-driven, safety-checked LRU reclamation
```

There is no run for which “delete the full checkout now” is the economic or
safety default. The name `repo_down` is prohibited because it implies symmetry
and invites wiring deletion into run teardown. Normal run completion releases
only the run workspace and its ticket worktree through existing mechanisms.

### 7.2 Inventory and LRU

The node keeps bounded inventory metadata for managed full checkouts and tier-1
mirrors: size, last successful use, last readiness result, and active lease or
worktree references. Use is updated when a mirror materializes a checkout or a
worker begins repo workspace creation—not on every janitor scan, which would
destroy LRU ordering.

Disk GC joins `lib/disk.mjs` and janitor. It starts only under configured disk
pressure and reclaims until usage returns below the warning watermark, giving
hysteresis rather than deleting one item on every poll. Dry-run JSON reports
candidate, held, refused, estimated bytes, and reason before apply.

Eligible classes are considered in this order:

1. **finished ticket worktrees**, using the existing Linear-state, open-PR,
   dirty/unpushed, and repo-owned `worktree_down` guards;
2. **unreferenced tier-1 bare mirrors**, oldest successful use first, only
   when they have no registered detached worktree or active run; and
3. **managed provisioned full checkouts**, oldest successful use first, only
   after every guard below passes.

This order removes stale per-ticket dependencies/databases first, then the
cheapest reproducible cache, and preserves the expensive warm full checkout as
long as possible. A class with no eligible entries is skipped; pressure never
weakens a guard.

### 7.3 Never evict

Janitor/GC must never remove:

- any workspace or checkout held by a live or retained run;
- a repo with a provisioning, preflight, or GC lock held;
- a checkout with any live linked worktree;
- a ticket worktree whose ticket is not completed/canceled, whose branch heads
  an open PR, or whose repo-owned teardown refuses;
- any dirty or untracked checkout;
- any checkout/branch with unpublished commits or an unknown upstream;
- a mirror with registered worktrees;
- an explicit unmanaged/operator-owned repo override; or
- a path whose realpath or Git identity changed since inventory.

The apply path takes an exclusive node/repo lock and repeats all checks just
before deletion. Unknown is held, never eligible. It never passes `--force` to
worktree teardown and never deletes a worktree by hand. A managed full checkout
must be structurally boring—clean base branch, canonical origin, no linked
worktrees or unpublished refs—before recursive removal is allowed.

GC invalidates the readiness attestation before deleting a checkout. A worker
cannot continue advertising a path that reclamation removed.

---

## 8. Why there is no devcontainer or Docker execution path

Devcontainers were considered and rejected for this design:

- The security boundary is already the Gondolin microVM (WM-185), with
  default-deny egress and secret placeholder substitution. A devcontainer is
a weaker boundary. Putting both on the hot path creates two isolation models,
  with the weaker one handling execution.
- The extra isolation a container offers here is filesystem/branch separation.
  Repo-owned worktree scripts already provide that **plus** the parts Git and
  containers do not infer: non-colliding ports, services, and per-ticket
  databases. Containerizing would not remove those scripts; every repo would
  maintain a container definition in lockstep with them.
- Platform coverage would remain partial. `watts-mobile` cannot perform its
  native build in a Linux container, so the factory would permanently operate
  and debug two provisioning paths.
- Reproducible toolchains and fast node onboarding are real benefits, but §§3–6
  provide them directly with a smaller operational and maintenance surface.

If containers are revisited, the honest first experiment is the tier-1
read-only scan fleet: no ports, no databases, no dev servers, no mutation, and
a uniform Bun/Git/GitHub CLI toolchain. That experiment must demonstrate a
benefit before containers become a workspace dependency.

### Also considered and deferred: Kubernetes

Kubernetes is downstream of the container decision; without containers on the
execution path there is nothing for it to schedule.

- Tier-1 scans are Kubernetes-shaped—fungible, stateless, short—but current
  scale is a handful of concurrent jobs on one or two machines. A supervisor
  and systemd/launchd units provide that capacity with much less operations
  surface.
- Tier-2 dispatch is a poor fit. It is sticky to the node holding a full
  checkout, warm caches, worktree scripts, and per-ticket databases; runs are
  long and require a stable filesystem. Encoding that as StatefulSets, node
  affinity, and local persistent volumes is “run on the machine with the repo”
  with another control plane in between.
- The Factory control plane is one process over one SQLite file. If it later
  becomes multi-instance it first needs Postgres and a stateless API, which fit
  the existing Dokploy substrate. Kubernetes now would create a second
  deployment substrate without removing the first.

WM-308, WM-310, this repo-capability design, and enforced toolchain contracts
make a future tier-1 worker genuinely fungible. Revisit Kubernetes as a scale
decision when there are roughly four or more nodes, more than a handful of
always-on services, a real multi-tenant isolation requirement, or a specific
Kubernetes operator the product needs. For bursty, long, per-run-stateful work,
an ephemeral runner or cloud VM per run remains a better first comparison.

---

## 9. Implementation cut-lines

The implementation is intentionally sequenced; later tickets must not invent a
second path resolver, preflight, or inventory.

1. **WM-314 — node-aware repository paths.** Extend the existing validated
   node parser with `repos_root` and overrides, return managed ownership
   metadata, and migrate every full-checkout-path consumer to one resolver
   while preserving tier 1's checkout → mirror → `github:` source fallback.
2. **WM-315 — out-of-band `repo ensure`.** Add locked, idempotent full-checkout
   provisioning and credential providers; preserve unmanaged operator
   checkouts. Depends on WM-314 and uses OPS-488 when available.
3. **WM-316 — toolchain and readiness preflight.** Add `toolchain`, the
   repo-owned readiness check contract, typed doctor output, and the first
   factory-repo fixture. Depends on WM-314/WM-315.
4. **WM-317 — readiness advertisement and claim filtering.** Persist bounded
   attestations, register structured ready repos, gate tier-2 claim/workspace
   creation, and expose unsatisfied readiness. Depends on WM-314..WM-316 and
   does not enable remote mutation before WM-308.
5. **WM-318 — disk-pressure repo-cache GC.** Add inventory, dry/apply LRU, and
   all never-evict guards; use `factory repo gc`, never `repo_down`. Depends on
   WM-315/WM-317.

Cross-linking this document from `event-runtime-workers.md`,
`event-runtime.md`, or `event-runtime-worker-protocol.md` is deliberately
left to whichever of WM-308 and WM-311 lands second. Those files are owned by
WM-308 concurrently; this ticket changes only the architecture index.

---

## 10. Decisions that implementations may not reopen silently

- `repos.yaml` `path:` is a local default, not fleet truth.
- A named node never falls back to another node's absolute path.
- Provisioning happens before placement eligibility, not after a run claim.
- Only a current, passing readiness attestation is advertised.
- Toolchain preflight validates; it does not install or mutate host tooling.
- Long-lived PATs do not belong in node configuration.
- Provisioned checkouts persist across runs.
- Deletion is guarded LRU under disk pressure; there is no `repo_down`.
- Repo-owned worktree scripts remain the authority for ports, services,
  databases, and teardown.
- Devcontainers, Docker, and Kubernetes are not on the execution path.

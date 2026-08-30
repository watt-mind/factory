# Containerized per-repository environments: baseline and decision

**Decision (2026-08-29): do not add a container execution path yet.** The
current evidence shows a small number of genuine missing-tool or missing-local-
configuration failures, not a recurring node-toolchain capacity limit. The
existing worktree model supplies isolation a container would still have to
rebuild, while APFS clonefile keeps a current template cheap.

## Status-quo baseline

This spike queried the production lifecycle ledger at
`~/.factory/event-runtime/runtime.db` on 2026-08-29:

```sql
SELECT count(*) events, count(DISTINCT run_id) runs
FROM lifecycle_events
WHERE reason LIKE 'failure:environment:%';
```

It contains **160 environment-failure events across 48 runs** out of 4,136
recorded runs (2026-08-17 through 2026-08-29). That broad label is not a
containerisation signal:

| Reason family                                            | Events / runs | What it says                      | Would a per-repo image fix it?                      |
| -------------------------------------------------------- | ------------: | --------------------------------- | --------------------------------------------------- |
| Missing artifact-store object                            |      152 / 46 | Runtime artifact availability     | No                                                  |
| Tracker rate limit                                       |         8 / 2 | Control-plane quota               | No                                                  |
| Workspace provisioning (branch/lease/port/seed failures) |       50 / 48 | Worktree lifecycle coordination   | No; it would need equivalent lifecycle coordination |
| Missing `wasp`                                           |         1 / 1 | A genuine absent toolchain        | Potentially                                         |
| Missing `cashsaas/.env.server`                           |         6 / 6 | Node-local operator configuration | Only if secrets/config are deliberately brokered    |

The environment-labelled rate is therefore 48 / 4,136 = **1.16%**, but the
observed _toolchain_ portion is only one run (0.02%); six local-config failures
are not safely solved by baking credentials into an image. `docs/friction-log.md`
also records the material historical worktree cost as stale-cache compilation
(F-4), now fixed, rather than missing tools.

The worktree baseline is deliberately not the historical worst case.
`docs/architecture.md` §2.6 records about **three minutes per worktree** only
when the template was 99 commits stale; a current APFS clonefile template takes
**seconds**. This spike's current `bin/worktree-up.sh` provisioning of its own
factory worktree completed in about **31 seconds** including dependency reuse,
runtime/web startup, and demo seeding. A proposed environment must beat that
current number or remove a measured node-onboarding failure; comparing it only
with the stale three-minute incident would be misleading.

## What a container must not erase

`bin/worktree-up.sh` and `bin/worktree-common.sh` are not a bare `git worktree
add` wrapper. They reserve a ticket-derived API/web port pair, persist it,
verify that `/health` names the expected `FACTORY_EVENT_HOME`, isolate the
runtime database under the worktree, and start/tear down its services. As
`docs/architecture.md` §2.5 says, Git isolates branches but not ports or
databases. A container with a bind-mounted worktree still needs this lifecycle
contract; otherwise it reintroduces cross-ticket database and port collisions.

| Breakage / constraint                     | Evidence                                                                                             | Container consequence                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree ports, DB, runtime home          | `bin/worktree-up.sh:13-21`, `bin/worktree-common.sh` port reservations, `docs/architecture.md` §2.5  | Keep repo scripts or duplicate their lifecycle and ownership checks inside the container boundary.                                                          |
| Fast host cloning                         | `docs/architecture.md` §2.6: APFS clonefile is effectively free when current                         | Image build/pull layers do not preserve this host warm-cache win; an image cache can become a second stale-template problem.                                |
| Harness subscription/OAuth authentication | `runners/run-agent.sh:140-170` deliberately unsets API keys so harnesses use subscription/login auth | A Linux image cannot assume the host login/session exists. Mounting it weakens the claimed isolation; copying keys changes billing and connector behaviour. |
| Browser tooling                           | `config/mcp/claude.json` launches isolated headless Chrome through `npx chrome-devtools-mcp`         | The container needs browser binaries, display/sandbox support, localhost routing to the worktree app, and a separate profile lifecycle.                     |
| GitHub credentials                        | `bin/worktree-up.sh` uses `gh` to inspect PR state                                                   | The image must broker `gh` auth or mount the host credential store; either adds a credential boundary and refresh path.                                     |

## Two candidate shapes

| Shape                                                                      | Avoids                                                                                                                                   | Does not avoid / new cost                                                                                                                                                                                                   | Multi-node effect                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Per-repo image, bind-mounted ticket worktree**                        | Can pin Bun/Python/system packages and make a node's base toolchain reproducible.                                                        | Does **not** avoid worktree ports/DB/runtime-home coordination, APFS clonefile loss, host subscription auth, browser setup, or `gh` credential brokering. Needs image build, registry, CVE updates, and cache invalidation. | A new node can pull a declared image, but every image tag becomes a warm-cache analogue: it must be rebuilt and attested when lockfiles/toolchain pins change.                     |
| **B. Declarative host environment (Nix, mise, or asdf), retain worktrees** | Pins/install-checks toolchains while retaining current APFS cloning, worktree scripts, host login, browser configuration, and `gh` auth. | Does not create a filesystem security boundary and still needs per-node installation/bootstrap.                                                                                                                             | Makes node onboarding cheaper by declaring prerequisites in the repo/node profile without introducing image distribution; the profile lock/update cadence still needs maintenance. |

For this workload, B addresses the only measured missing-tool case with the
smallest change. A is not rejected forever, but has no demonstrated net benefit
over the current current-template path. The existing tier-1 read-only fleet is
the safer first container experiment because it has no ports, databases, dev
servers, or mutating worktrees; `docs/event-runtime-repos.md` §8 reaches the
same conclusion.

## Cost estimate and recommendation

With a current template, the host pays seconds (31 seconds in this spike's
representative factory provisioning) rather than the historical ~3 minutes.
Shape A adds at minimum an image availability check and, on a cache miss, image
pull/build time before the same worktree lifecycle starts. It has no credible
path to remove the 31-second startup without separately solving services,
ports, credentials, and browser tooling. Its likely cold-start tail is worse,
not better. Shape B adds only a deterministic prerequisite check/install step;
it should be evaluated through the existing toolchain preflight after #1076,
not implemented here.

**Recommendation:** keep `worktree_up` as the tier-2 authority. Ship and
observe #1076's preflight first. Prefer a declarative host toolchain profile if
the remaining node mismatch is real. Do not add Dockerfiles, devcontainers, or
container runtime dependencies for ticket worktrees.

**Revisit trigger:** reopen this decision only when, in a rolling 30-day
window, either (1) at least **three distinct runs** fail preflight or workspace
provisioning solely because a required executable/runtime is absent on an
otherwise eligible node, or (2) a second worker node is blocked from serving a
repo after a reproducible host-profile trial. Any container proposal must then
measure a current-template p95 dispatch startup against its own warm and cold
starts, show how it preserves all five constraints above, and demonstrate a
benefit first on the tier-1 read-only fleet.

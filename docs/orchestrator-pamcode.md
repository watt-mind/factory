---
name: factory-orchestrator
description: Run a factory orchestrator shift — keep supply, dispatch, merge, and recovery loops self-sustaining at ~10 concurrent worker runs. Use when opening an orchestrator session or when the factory has stalled.
---

# Factory Master Orchestrator

> **Format experiment.** This is [`docs/orchestrator.md`](./orchestrator.md) re-expressed in
> [pamcode](https://github.com/rstacruz/pamcode) — pseudocode-in-Markdown for agent workflows.
> Same behaviour, different shell: the prose guide explains _why_, this one shows the _shape_.
> `orchestrator.md` remains the normative source; where the two disagree, it wins.

You are the **Master Orchestrator**. The human operator observes and sets high-level strategy;
you prioritize, decide, unblock, and execute autonomously without per-step confirmation.

## Input

- `$repo` — short name from `config/repos.yaml`; defaults to `factory`
- `$teams` — ticket teams to draw supply from; defaults to `WM`
- `$slots` — worker pool size; defaults to `10`
- `--once` — run a single cycle and report, instead of holding the shift open
- `--no-dispatch` — observe, land, and recover, but start no new work (use while trunk CI is red)

## Skill dependencies

Read first:

- `/factory-work` — the per-ticket worker loop this orchestrator feeds
- `/factory-merge` — the merge gate contract (CI-green mode, escalation triggers)
- `/factory-triage` — how raw issues become `ai:agent-ready` supply
- `/factory-unblock` — recovery moves for wedged runs and stale holds

Subagents available: `factory-ci-doctor`, `factory-merge-reviewer`, `factory-infra-scout`,
`factory-ux-critic`.

## Workflow

```pseudocode
begin($repo, $teams, $slots, { --once, --no-dispatch }) {
  # -- boot: never assume state from past notes --
  $state = assess()
  if ($state.stack is down) {
    `bin/live-stack.sh up --workers 3:10`
  }

  loop {
    # -- 1. observe --
    $state = assess()

    # -- 2. land what is finished; freed slots and chain edges come from here --
    land-prs($state.prs)

    # -- 3. recover before adding load --
    watchdog-sweep($state.runs)

    # -- 4. refill supply if the queue cannot fill the pool --
    if ($state.ready < $state.free_slots or $state.ready < 5) {
      refill-supply($teams)
    }

    # -- 5. dispatch into free slots --
    if (not --no-dispatch and trunk CI is green) {
      dispatch($repo, $state.free_slots)
    }

    # -- 6. keep the main checkout pullable, or the factory freezes on old code --
    refresh-stack()

    # -- 7. report: what was fixed, what is now running --
    report to the operator in a few lines; no menu, no "want me to…?"

    if (--once) { break }
    wait for a run or PR completion notification, else `/loop 15m`
  }
}
```

### assess()

Assess live reality in one shot. Reads that answer immediately stay inline; anything that
blocks goes to a subagent (see **Guidelines → Delegate the waiting**).

```pseudocode
def assess() {
  $pulse = `factory pulse --json`   # stack, workers, runs, supply, PRs, git freshness

  if ($pulse is unavailable) {
    `curl -sf http://127.0.0.1:7381/health`      # policyVersion == the SHA the stack booted on
    `bun event-runtime/cli.mjs status`
    `factory ticket queue --team WM`
    `gh pr list --state open --json number,title,headRefName,statusCheckRollup,reviews`
    `git fetch --quiet && git status --porcelain`
    `git rev-list --count HEAD..origin/develop`  # >0 means behind
  }

  if (the API on :7381 is unreachable or 500s) {
    # fail closed: an unreadable pool is a FULL pool
    return { free_slots: 0, ready: 0, degraded: true }
  }

  return { stack, workers, runs, prs, ready, free_slots, dirty, behind }
}
```

Supply health: 10–20+ tickets in `Todo` + `ai:agent-ready` + unassigned is healthy; under 5 is a
refill trigger. **Empty read trap:** a network drop reports "0 issues" for a Triage queue that has
work — verify raw counts before concluding supply is exhausted.

### refill-supply()

Workers idle if supply dries up. Convert raw `Triage` issues into dispatchable candidates.

```pseudocode
def refill-supply($teams) {
  $raw = `factory ticket triage --team WM`
  for each candidate {
    subagent(write-detail) {
      write unambiguous acceptance criteria
      write Owned Paths as explicit globs covering every file the work touches
      write one deterministic Verification command
    }
    if (criteria are not 100% achievable inside Owned Paths) { send back to Triage }
    move to Todo + ai:agent-ready
  }
  return { added: $count }
}
```

Owned-Paths guardrails when authoring:

- An agent prompt edit (`.md`) must also own its definition `.json` — the change requires
  `bun event-runtime/cli.mjs update-pins`.
- An edit under `shared/**` must also own `dist/**` — enforced by `bun build/emit.mjs --check`.

### dispatch()

```pseudocode
def dispatch($repo, $free_slots) {
  $candidates = highest-priority agent-ready tickets, newest spec first

  loop {
    if ($free_slots == 0) { break }
    $t = next candidate

    # Owned Paths overlap is ADVISORY (config/policy.yaml dispatch.owned_paths_collision).
    # The gate records overlapping claims as evidence and dispatches anyway;
    # only a `**` claim on either side refuses (owned_paths_conflict_hard).
    # Real conflicts are caught at merge, which stays serialized (max_concurrent_merges: 1).

    `bun event-runtime/cli.mjs inject -` with:
      { schemaVersion: "factory.event/v1",
        eventId: "dispatch:factory:$t:1",
        type: "factory.dispatch.requested",
        source: "operator",
        subject: $t,
        payload: { repo: $repo, ticket: $t } }     # `ticket`, not `ticketId`

    # operator-sourced events are not auto-approvable (only source: "chain" is)
    `bun event-runtime/cli.mjs proposals`
    `bun event-runtime/cli.mjs approve <proposal-id>`
    wait a few seconds between approvals   # a burst of ~10 hits claim_lock_starvation (WM-682)

    $free_slots -= 1
  }
  return { dispatched: [...] }
}
```

Re-dispatch (the idempotency pin trap):

```pseudocode
def redispatch($ticket, $runId) {
  # a FAILED/BLOCKED run pins the ticket's idempotency key;
  # a duplicate dispatch.requested no-ops as ticket_dispatch_already_live
  if (the run is of the current policyVersion) {
    `bun event-runtime/cli.mjs retry <runId> --force`
  } else {
    # planned before a stack restart: no worker will ever claim it (registry_stale spin)
    `bun event-runtime/cli.mjs cancel <runId>`
    `factory ticket labels $ticket --add ai:agent-ready`   # every terminal failure strips it (WM-682)
    dispatch($repo, 1) with a bumped eventId suffix
  }
}
```

### land-prs()

The factory auto-merges PRs targeting `develop` once the gates pass. Four gates, all mandatory.

```pseudocode
def land-prs($prs) {
  for each $pr {
    if ($pr touches auth/authz, payments, secrets, destructive migrations,
        production infra, or CLNT security policy) {
      escalate($pr, "ESCALATED")
      continue
    }

    subagent(factory-merge-reviewer) {
      read the diff for $pr; classify MERGE / FIX / ESCALATE; return ranked findings
    }

    if (verdict != MERGE) {
      # a hold only in your head is not a hold — make it structural NOW
      `gh pr ready --undo <PR>`            # or add ai:escalated on the ticket
      if (verdict == FIX) { fix in-branch, max 2 rounds }
      continue
    }

    # gate: live observed CI — a cached green is not a green
    if (the CI run was never seen in a non-completed state) { observe it first }
    if (CI is red) {
      subagent(factory-ci-doctor) { diagnose the failed run; classify TICKET / ENV / FLAKE }
      fix and re-push, max 2 rounds, then stop and report
      continue
    }

    # gate: structured handoff
    if ($pr has no `## Handoff` section with verification output, UX verdict, and file scope) {
      request revision
      continue
    }

    # gate: stale-rebase guard
    `git diff --stat origin/develop origin/<branch>`
    if (develop-side files are deleted without explanation) { abort "stale rebase would revert trunk" }

    subagent(merge) {
      merge the PR
      delete ONLY this PR's HEAD_REF     # never develop, master, or a develop -> master branch
      move the ticket to Done
      remove the worktree
    }

    # chaining: a merge unblocks downstream work
    review edges.json for dependents and dispatch them immediately
  }
}
```

### watchdog-sweep()

```pseudocode
def watchdog-sweep($runs) {
  `factory watchdog --once`

  for each run RUNNING with no heartbeat for >20 min, or past its timeout {
    `bun event-runtime/cli.mjs inspect <runId>`
    preserve and push any uncommitted worktree work first
    if (clean) { cancel, unassign the ticket back to Todo } else { mark BLOCKED and escalate }
  }

  # after any stack restart: in-flight runs are orphaned, and the reaper is disabled (WM-657)
  compare `attempts.lease_owner` against `bun event-runtime/cli.mjs workers`
  cancel the orphans
}
```

### refresh-stack()

The live stack pins `policyVersion` at boot and loads agent definitions once — **the factory keeps
running whatever was on disk when it booted**. A dirty main checkout silently freezes it at an old
commit. Clearing that is part of the loop, not a question for the operator.

```pseudocode
def refresh-stack() {
  if (`git status --porcelain` is non-empty) { clear-tree() }
  if (`git rev-list --count HEAD..origin/develop` == 0) { return { restarted: false } }

  `git checkout develop && git pull --ff-only`

  # restart is REQUIRED when develop changed any of:
  #   event-runtime/agents/**, event-runtime/schemas/**, event-runtime/event-types.json,
  #   event-runtime/schedules.json, config/**
  # model-tier and routing changes resolve at plan time inside `serve` — a serve-only
  # restart is enough for those and leaves running workers untouched.
  if (no dispatch@1 run is RUNNING or LEASED) {
    `bin/live-stack.sh down`               # drains in flight; does NOT wait — see watchdog-sweep()
    `bin/live-stack.sh up --workers 3:10`
    `curl -sf http://127.0.0.1:7381/health`   # policyVersion must be the new SHA
  }
  return { restarted: true }
}
```

### clear-tree()

**Never `git stash`.** The stash stack (`.git/refs/stash`) is repo-global, not per-worktree, so a
stash here can be popped into a concurrent agent's worktree — silent cross-session data loss. The
escape is always a commit.

```pseudocode
def clear-tree() {
  read the diff first; never blanket `git checkout --` a tree you have not looked at

  if (the work matters) {
    file the ticket, commit on a branch, push, open the PR
  } else if (not yours and not obviously disposable) {
    commit it to a branch anyway and say so in the report   # a branch is recoverable; a diff is not
  } else if (confirmed untracked build litter) {
    remove it
  }
}
```

### escalate()

The interrupt channel is strictly for events needing the human. Routine updates (claims, clean
merges, spec completions) belong in ticket comments and the session summary — a channel that pings
on everything gets muted, and then the blocker notification is lost too.

```pseudocode
def escalate($subject, $event) {
  add `ai:escalated` to the ticket
  `factory notify "<EVENT> <TICKET/PR>: <one answerable sentence>"`
}
```

| Event             | When                                                                          |
| :---------------- | :---------------------------------------------------------------------------- |
| `BLOCKED`         | Missing credential, contradictory spec, unresolvable environment issue        |
| `ESCALATED`       | Security, auth, money movement, or destructive migration PR needs human merge |
| `CI RED`          | `develop` trunk CI broken; dispatch paused until green                        |
| `SMOKE RED`       | Post-deploy smoke failure on staging/production                               |
| `CIRCUIT BREAKER` | Cascade failures across workers (5+ consecutive runner crashes)               |
| `RC READY`        | `develop -> master` candidate green and awaiting sign-off                     |

Reserved for the human — the only things worth stopping for: `master`/deploy merges and release
sign-off; auth/authz, payments, secrets, destructive migrations, production infra; whatever a
`Blocked` ticket is genuinely waiting on; a circuit-breaker stop or trunk CI you could not fix in
two rounds. **Everything else is yours to decide.**

## Guidelines

**High agency, least-destructive move.** If a run wedges, unstick it. If supply drops, sweep
triage. If a merge gate fails on a fixable nit, fix it. Pick the least destructive option that
actually unblocks, take it, and say what you chose and why. Prefer reversible moves (a draft, a
label, a revert, a new ticket) over destructive ones (closing, deleting, force-pushing).
Being wrong-but-reversible while moving beats being right-but-stopped.

**Diagnosis is not the deliverable.** The failure mode to avoid is _diagnose, then wait_ —
presenting a correct analysis as a menu and stopping for a pick. That makes the operator the
bottleneck for work they already delegated. If you are writing "want me to…?" about something
inside your authority, do it instead.

**Delegate the waiting — the ~30s rule.** No inline call may block for more than ~30 seconds.
CI waits, `gh run watch`, `bun test`, `bun install`, `worktree-up`, rebases, and any
`sleep`-then-recheck loop all exceed it and all belong in a subagent. Keep the decisions inline —
selecting and dispatching tickets, approving proposals, judging escalations — that is exactly what
the operator is steering. Reach for the specialised agent before a general one:

| Agent                    | Use for                                                    |
| :----------------------- | :--------------------------------------------------------- |
| `factory-ci-doctor`      | one red Actions run — after it fails, never to wait for it |
| `factory-merge-reviewer` | a PR diff, so the diff never enters the orchestrator       |
| `factory-infra-scout`    | anything needing SSH or container output                   |
| `factory-ux-critic`      | user-facing flows, after verification and before the PR    |

Two failure modes: spawning a subagent then re-doing its work inline, and reading a subagent's
transcript file — which puts back exactly the payload the delegation removed. Cost is the secondary
reason: a tool result is re-sent every later turn, so a test log read inline is charged for the rest
of the shift.

**Volume is the point.** ~10 concurrent runs surfaces latent harness defects, contract violations,
and race conditions that a quiet factory never shows.

**Fail closed.** Unreadable APIs are full pools. Unverified tests are failures. A `**` Owned Paths
claim blocks.

**Command naming.** `factory linear <verb>` is the deprecated alias; use `factory ticket <verb>`
(`get`, `queue`, `claim`, `comment`, `detail`, `labels`, `state`, `file`, `triage`, `budget`).

## Traps

| Trap                       | Mechanism                                                                               | Rule                                                                                   |
| :------------------------- | :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| CI rerun cache             | `gh run rerun` on a green run is refused; on a failed run it reuses the attempt         | Observe the run in a non-completed state before trusting green                         |
| `GET /runs` has no `spec`  | WM-303 — `row.spec` reads empty                                                         | Take ticket identity from `eventId` or `cli.mjs inspect <runId>`                       |
| Idempotency pinning        | `FAILED`/`BLOCKED` runs pin the input hash; re-injection no-ops                         | `cli.mjs retry <runId> --force`, or cancel + relabel + re-inject with a bumped eventId |
| `git stash` in worktrees   | The stash stack is repo-global, not per-worktree                                        | Never stash, never `rebase --autostash`. Commit to a branch instead                    |
| macOS bash 3.2             | No `mapfile` / `readarray`                                                              | POSIX `while IFS= read -r line` loops in every shell script                            |
| Prettier scope             | Repo-wide prettier reformats hundreds of `.mjs` files                                   | Prettier covers `shared/**/*.md` only (`bun run format:check`)                         |
| Label replacement          | Raw GraphQL label mutations replace the whole array, wiping `type:*` / `area:*`         | Always `--add` / `--remove` via `factory ticket labels` / `state`                      |
| Restart orphans in-flight  | `live-stack.sh down` does not wait; the leaseholder dies and the reaper is off (WM-657) | Restart only when no `dispatch@1` run is RUNNING/LEASED; cancel orphans afterwards     |
| Stale rebase reverts trunk | A rebase onto a stale `origin/develop` drops PRs merged since — and still passes CI     | `git diff --stat origin/develop origin/<branch>` must show no unexplained deletions    |
| Blocking waits inline      | A `sleep`-recheck loop queues the operator's steering behind the whole wait             | Nothing inline blocks >~30s                                                            |
| A hold only in your head   | `merge-scan`/`merge-apply` cannot read your intentions — #552 auto-merged a "held" PR   | On FIX/ESCALATE, convert to draft or add `ai:escalated` immediately                    |

## Command reference

```bash
# pulse & watchdog
factory pulse [--json]                          # stack, workers, supply, PRs in one shot
factory watchdog --once                         # health inspection & anomaly detection
factory watchdog --interval-sec 300 --notify    # background daemon with Telegram alerts

# live stack
bin/live-stack.sh up --workers 3:10 | down | ps

# event runtime
export FACTORY_EVENT_SECRET=$(cat ~/.factory/orchestration/event-secret.txt)
bun event-runtime/cli.mjs status | proposals | runs | workers
bun event-runtime/cli.mjs inspect <runId>       # full receipt, lifecycle, logs
bun event-runtime/cli.mjs retry <runId> --force
bun event-runtime/cli.mjs update-pins           # after any agent definition edit

# tickets
factory ticket queue --team WM
factory ticket get <ID> | claim <ID> | comment <ID> "..." | detail <ID> "..."
factory ticket state <ID> "In Review" --add ai:needs-review
factory ticket file --team WM --title "..." --body "..." --type docs

# CI — one-shot reads are inline-safe
gh pr view <PR> --json headRefOid,mergeable,mergeStateStatus
gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | "\(.name)=\(.conclusion // .status)"'
# blocking waits — subagent only
gh pr checks <PR> --watch --fail-fast
gh run watch <run-id> --exit-status
```

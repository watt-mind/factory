---
name: factory-swarm
description: "Fan out N parallel workers across slices or races, drain them, and return one consolidated report. Use for /factory-swarm, 'swarm this', parallel coverage, races, gauntlets, and exploration."
---

# Factory Swarm

Fan out N parallel workers, enforce SHA/method discipline, aggregate terminal results, and return one consolidated report. Adapted from `pstack`'s `swarm` for Factory's T3Code-native orchestrator, harness-native subagents, and `factory swarm` CLI runner.

Open a checklist with one entry per phase before launching anything:

1. **Frame**
2. **Fan out**
3. **Aggregate**
4. **Report**

## Per-Node Configuration (`~/.factory/swarm.yaml`)

`factory swarm` reads `~/.factory/swarm.yaml` on the active node (falling back to `$FACTORY_ROOT/config/swarm.example.yaml`):

- **`defaults.worker`:** default worker profile (`opus` -> `claude-opus-5-5`) used for partitioned slices unless overridden.
- **`profiles.race`:** cross-harness race arms (`gpt-sol` via `codex`, `fable` via `claude`, `carbon` via `agy`), with `argon` and `pi` fallback available.

Inspect the node's resolved worker roster anytime with:

```bash
factory swarm config
```

## Backend Selection (T3Code-native vs. Harness Subagents vs. CLI Runner)

1. **T3Code-native (preferred when inside T3Code):** If T3Code Orchestrator MCP tools (`orchestrator_capabilities`, `delegate_task`, `task_cancel`, `t3_thread_wait`, `t3_thread_read`) are available in the session:
   - Call `orchestrator_capabilities` **once per thread** before your first `delegate_task`.
   - Fan out all N workers via **`delegate_task` (`mode: "async"`)** — **never** use `create_threads` or `t3_thread_launch` for worker fan-out (those create top-level threads, reserved for explicit user requests).
   - Follow `delegate_task`'s `next` behavior: end your turn for reactive wakeup rather than polling `task_status` or looping on `t3_thread_wait`.
   - Each new review or re-check is a fresh `delegate_task`, never `t3_thread_send` to a finished child; cancel replaced or extra delegates with `task_cancel` (never `t3_thread_interrupt`).
   - **Worktree interaction:** `delegate_task` only accepts `isolation: "shared" | "worktree"` (no `worktreePath` param). For repos with `bin/worktree-up.sh`, run `bin/worktree-up.sh <ISSUE-ID>` sequentially in the coordinator and pass `isolation: "shared"` with `worktree: <abs-path>` spelled out in `task`, or initialize per-worktree ports/DB inside an `isolation: "worktree"` checkout.
2. **Harness-native subagents (same-harness interactive):** When running partitioned slices inside a single harness (`claude`, `codex`, `agy`, `cursor`) without cross-vendor race arms, you may use the harness's native `swarm` / `invoke_subagent` / `run_workflow` tools with isolated worktrees (`workspace:"share"` or `bin/worktree-up.sh`).
3. **CLI runner (`factory swarm run`):** For cross-harness races or headless/terminal fan-outs across `codex`, `claude`, `agy`, and `pi`, run `factory swarm run`.

## Phase A: Frame

1. **State the done predicate** and the artifact or report the swarm must return.
2. **Choose the shape:** `partition` (disjoint slices), `race` (N workers on identical briefs), or `mixed`. For `race` or `mixed`, declare the selection rule up front: `first-pass`, `rank-all`, or `best-of`.
3. **Enforce SHA & measurement discipline:** When workers verify or measure commits, every brief names the exact commit SHAs. A measurement brief also names the method (sample count, what one sample is, order). Workers must echo both in their result.
4. **Isolate writable outputs:** Every concurrent writer gets its own `$TMPDIR` directory or isolated `git worktree` (never share a writable checkout or use `git stash`).

## Phase B: Fan out

Launch all N workers in parallel. Every brief must stand alone and state:

- Goal, scope, exact slice or race arm, and required verification command.
- Expected verdict token: `PASS`, `ISSUES`, or `BLOCKED` with concrete evidence (`file:line`, SHA, or command output). A worker that can prove a defect reports `ISSUES` and lists **every** issue it can prove, not only the first.

CLI invocation example (partitioned slices JSON or race):

```bash
factory swarm run \
  --shape partition \
  --tasks-file "$TMPDIR/swarm-<id>/tasks.json" \
  --mode sandbox \
  --json
```

Or for a cross-harness race:

```bash
factory swarm run \
  --shape race \
  --rule best-of \
  --profile race \
  --prompt-file "$TMPDIR/swarm-<id>/prompt.md" \
  --json
```

If a worker drops out or fails, proceed with `N - 1` and record the dropout.

## Phase C: Aggregate

1. **Enforce brief contracts:** Drop any result that omits the required commit SHAs or measurement method named in its brief, and respawn that worker **once**. After a second miss, record a **gap** (a gap never counts as `PASS`).
2. **Check coverage / apply race rule:** For `partition`, verify every required slice has a result. For `race`, apply the declared selection rule (`first-pass`, `rank-all`, or `best-of`).
3. **Synthesize, never dump:** Distill findings; never paste raw worker logs into chat.

## Phase D: Report & Cleanup

1. If you used `factory swarm run`, clean up temporary worktrees/sandboxes once integrated:

```bash
factory swarm cleanup --manifest "<outDir>/manifest.json"
```

2. Return one consolidated in-chat report containing:
   - **Result table** (slice/arm, model/harness, verdict `PASS|ISSUES|BLOCKED|GAP`, key evidence)
   - **Issue one-liners** (deduplicated)
   - **Gaps or dropouts**
   - **Race rule & winner** (when `race` or `mixed`)

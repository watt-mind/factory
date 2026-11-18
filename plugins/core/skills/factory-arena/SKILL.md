---
name: factory-arena
description: "Run N parallel CLI candidates across Codex, Claude, and Antigravity (`agy`) on the same task, cross-judge against a rubric, pick a base, graft winning ideas, and verify. Use for /factory-arena, 'arena this', or competitive multi-model design/implementation bakeoffs."
---

# Factory Arena

Multi-harness competitive bakeoff and grafting workflow, adapted from `pstack`'s `arena` for Factory's CLI harnesses (`codex`, `claude`, `agy`, `pi`, `cursor`) and node-local `~/.factory/arena.yaml` configuration.

Open a checklist with one entry per phase (**Frame**, **Fan out**, **Cross-judge**, **Pick**, **Graft**, **Verify**) before launching anything.

## Per-Node Configuration (`~/.factory/arena.yaml`)

`factory arena` reads `~/.factory/arena.yaml` on the active node (falling back to `$FACTORY_ROOT/config/arena.example.yaml`):

- **`default` profile (3 runners across OpenAI / Anthropic / Google):** `gpt-sol` (`codex`, `gpt-6.2-sol`), `fable` (`claude`, `claude-fable-5-2`), `carbon` (`agy`, `gemini-4-carbon-high`).
- **`full` profile (all 5 contenders):** adds `opus` (`claude`, `claude-opus-5-5`) and `argon` (`agy`, `gemini-4-argon-high`).
- **`cross_judge_pool`:** ordered read-only judges; selects the first ready judge from a different vendor family than the calling harness (`fable` counts as `anthropic`).
- Missing CLIs fall back via `fallback:` or drop the seat cleanly; at least `min_runners` (default `2`) must succeed.

Inspect the node's resolved roster anytime with:

```bash
factory arena config
```

## Phase A: Frame (in the calling session)

1. **State the artifact** each candidate must produce.
2. **Derive the rubric** — 3–6 concrete, gradeable criteria for _this_ task. Write it to `$TMPDIR/arena-<id>/rubric.md`. **Candidates do not see the rubric.**
3. **Write the shared prompt** to `$TMPDIR/arena-<id>/prompt.md` (task, constraints, grounding paths).
4. **Choose isolation mode:**
   - `sandbox` (default): `$TMPDIR/factory-arena-*/candidate-<name>/` for designs, specs, audits, or standalone files.
   - `worktree`: detached git worktrees (`--mode worktree --repo-dir <repo> --base origin/<base>`) for multi-file code changes. Never share a writable checkout or touch `git stash`.

## Backend Selection (T3Code-native vs. CLI Runner)

Choose the execution backend based on the active session's tools:

1. **T3Code-native (preferred when inside T3Code):** If T3Code Orchestrator MCP tools (`orchestrator_capabilities`, `delegate_task`, `task_cancel`, `t3_thread_wait`, `t3_thread_read`) are available in the session:
   - Call `orchestrator_capabilities` **once per thread** before the first `delegate_task` to resolve the node's configured models (`gpt-6.2-sol`, `claude-fable-5-2`, `claude-opus-5-5`, `gemini-4-carbon-high`, `gemini-4-argon-high`) matching `~/.factory/arena.yaml`.
   - Spawn all contenders and the read-only cross-judge via **`delegate_task` (`mode: "async"`)** — **never** use `create_threads` or `t3_thread_launch` for worker/arena fan-out (those create top-level threads, reserved for explicit user requests).
   - Follow `delegate_task`'s `next` behavior (end your turn for reactive wakeup; never poll `task_status` or loop on `t3_thread_wait`).
   - Every new review or re-check is a fresh `delegate_task`, never `t3_thread_send` to a finished child; cancel replaced or extra delegates with `task_cancel` (never `t3_thread_interrupt`).
   - `delegate_task` only accepts `isolation: "shared" | "worktree"` (no `worktreePath` param). For repos with `bin/worktree-up.sh`, run `bin/worktree-up.sh <ISSUE-ID>` sequentially in the coordinator and pass `isolation: "shared"` with `worktree: <abs-path>` spelled out in `task`, or initialize per-worktree ports/DB inside an `isolation: "worktree"` checkout.
2. **CLI runner fallback (terminal / headless harnesses):** Otherwise, use `factory arena run` and `factory arena judge` below.

## Phase B: Fan out (`factory arena run` or T3Code `delegate_task`)

```bash
factory arena run \
  --prompt-file "$TMPDIR/arena-<id>/prompt.md" \
  --profile default \
  --mode sandbox \
  --json
```

Pass `--profile full` for all 5 contenders, or `--runners gpt-sol,carbon` for a custom slice. If a candidate fails or times out, proceed with the survivors (>= 2) and record the dropout.

## Phase C: Cross-judge (`factory arena judge`)

Run one read-only judge from a different vendor family than your active harness:

```bash
factory arena judge \
  --manifest "<outDir>/manifest.json" \
  --rubric-file "$TMPDIR/arena-<id>/rubric.md" \
  --caller-vendor "<anthropic|openai|google>" \
  --json
```

## Phase D: Pick a base

Read every surviving candidate end-to-end before picking. Score each criterion-by-criterion against your rubric and compare with `<outDir>/judge-report.md`. Prefer the base a future maintainer can extend most easily without breaking invariants.

## Phase E: Graft

Walk each losing candidate once more for 1–2 standout ideas, boundary checks, or helpers worth porting into the chosen base. Fold grafts in by hand so the result stays coherent under one mental model.

- If candidates converge on one shape, note the agreement and ship it.
- If they diverge wildly, Phase A was under-specified — reframe and re-run instead of averaging.

## Phase F: Verify & Cleanup

1. Verify the synthesized artifact with the repo's real checks (tests, lint, typecheck, or live UI check).
2. Clean up temporary sandboxes/worktrees once the winner is integrated into your branch:

```bash
factory arena cleanup --manifest "<outDir>/manifest.json"
```

3. Report the chosen base and why, the cross-judge verdict (or if skipped), each graft + source candidate, what was rejected, any dropouts, and verification output.

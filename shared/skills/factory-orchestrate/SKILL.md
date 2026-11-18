---
name: factory-orchestrate
description: "Coordinate multiple agents interactively on complex work using Swarm (partitioned parallel tracks), Arena (competitive bakeoff + synthesis), or Staged Pipeline (research -> implement -> verify -> review) with worktree isolation. Use for /factory-orchestrate, /orchestrate, or multi-agent execution within a session (distinct from /factory-work queue dispatch)."
---

# Orchestrate (interactive multi-agent execution)

Coordinate multiple subagents or swarm workers inside an interactive session when parallel coverage, competitive design exploration, or independent adversarial verification beats a single linear loop.

## `/factory-work` vs `/factory-orchestrate`

Use the right tool for the job:

- **Standing queue execution (`/factory-work` + `factory handoff`):** Autonomous pick-up of `Todo` + `ai:agent-ready` Linear/GitHub tickets, strict per-ticket orchestration, telemetry, and PR landing via the Factory runtime.
- **`/factory-orchestrate` (this skill):** Interactive multi-agent coordination inside your active session — parallel codebase audits, competitive design bakeoffs, sharded refactors/migrations across disjoint files, or a Producer -> Critic pipeline on high-risk diffs.

## Non-negotiable safety rules

Every topology obeys `shared/floor.md`:

1. **Never share a writable checkout or `git stash`:** Give every concurrent writer its own isolated worktree (`bin/worktree-up.sh <ISSUE-ID>` when the repo provides one, or harness `workspace:"share"` / `workspace:"branch"`, or disjoint scratch patches in `$TMPDIR`). Read-only research/reviewers may inherit the workspace after checking `origin/<base>` freshness.
2. **Disjoint `Owned Paths` for parallel writers:** No two concurrent implementers may edit overlapping files, schemas, or generated manifests. Regenerate shared manifests (`pins.json`, barrel exports, dist outputs) once in the coordinator or final staging step.
3. **Ticket discipline before permanent edits:** Before creating or modifying repo files meant to ship, ensure each track maps to a ticket (`Todo` -> claim -> worktree) or explicit user-approved bundle, unless exploring throwaway options in `$TMPDIR`.
4. **Never poll with `sleep N`:** Wait on native turn/message notifications, process completion (`wait`), or bounded condition checks (`gh run watch <id> --exit-status --interval 60`).
5. **Never trust a subagent summary blindly:** Check claims against the actual git diff, `origin/<base>@<sha>`, and real test/CI outputs in your own turn.

## Non-blocking coordinator default

Keep the main session unblocked for steering, cross-slice seams, and final verification gates. Delegate leaf implementation, read-only exploration, and slow test/build runs to isolated subagents with explicit `Owned Paths` and verification commands, reserving main context for integration and decisions.

**Hard invariant (`reviewer != implementer`):** Review and critique must run in a separate agent conversation (and separate model or harness family where available). The implementing agent never self-approves its own diff.

## Difficulty tier × harness routing

Route subagents by difficulty tier (`tier:light`, `tier:standard`, `tier:strong`) and role:

| Difficulty / Role | Claude Code                                 | Codex / Cursor                  | Pi                              |
| :---------------- | :------------------------------------------ | :------------------------------ | :------------------------------ |
| `tier:light`      | `haiku` / `sonnet`                          | fast (`sol` / fast)             | `muse-spark`                    |
| `tier:standard`   | `sonnet` (or `opus` for multi-module seams) | `sol` / `wonder`                | `muse` / `wonder`               |
| `tier:strong`     | `opus`                                      | `sol` / `opus`-class            | `wonder` / `opus`-class         |
| `reviewer`        | separate `opus` (`factory-merge-reviewer`)  | separate `wonder` / cross-model | separate `wonder` / cross-model |

**Fallback chain:** Fall back to the harness default (`inherit`) if a tier model is unavailable or quota-limited.

## Capacity-aware concurrency and bundle slots

Check `bun orchestrator/pulse.mjs` (or `factory pulse`) and read `CAPACITY & FLOW` (`DRAIN_MERGES_FIRST`, `HOLD_OR_BUNDLE`, `WIDEN`) before widening parallel lanes. Never widen on backlog depth alone — widen only on `mergedLastHour` flow and runner headroom. When CI or review capacity is the binding constraint (`HOLD_OR_BUNDLE`), coalesce 3–6 related low-risk tickets with disjoint `Owned Paths` into cohesive bundles: each bundle shares one worktree, branch, and PR, and the concurrency cap counts **bundle/PR slots** rather than raw ticket count.

## Choose one topology

Pick the topology that fits the task rather than spawning agents for show:

### 1. Swarm (partitioned parallel tracks)

Use when work splits cleanly into independent slices with little coordination overhead:

- Multi-module codebase audits or principles reviews (one `research` reviewer per directory/layer).
- Independent tickets whose `Owned Paths` do not intersect (one implementer + worktree per ticket).
- Large test, migration, or lint cleanups sharded by directory.

**Steps:**

1. Partition scope cleanly by directory, module, or review lens so no two workers duplicate searches or collide on files.
2. Give each worker a concrete brief: exact files/globs owned, what not to touch, required verification command, and concise structured return format (`file:line`, severity, evidence).
3. Launch workers in parallel (using your harness's native `swarm`, `invoke_subagent`, or `run_workflow` tools) and stop calling tools until results arrive.
4. Synthesize, deduplicate, and verify cross-slice seams (shared types, generated artifacts, `AGENTS.md`/CI budgets) before landing.

### 2. Arena (competitive bakeoff and grafting)

Pairs with `../principle-exhaust-the-design-space/SKILL.md` and `../factory-arena/SKILL.md` (gated: use on net-new UI surfaces, material layout/architecture forks, or explicit user comparison requests — never routine bugfixes). For cross-harness multi-model bakeoffs (`codex` / `claude` / `agy`), invoke `/factory-arena` (`factory arena`).

**Steps:**

1. **Write the rubric first:** Before spawning contenders, lock 3-5 concrete evaluation criteria (for example: correctness under concurrency, diff/bundle minimality, reader load, UI visual hierarchy, testability).
2. **Enforce genuine diversity:** Spawn 2-3 workers (or run `factory arena run --profile default|full`) with distinct models/hypotheses in separate isolated worktrees or `$TMPDIR` sandboxes. Never run two slightly tweaked copies of the same prompt.
3. **Judge coldly against artifacts:** Run a read-only cross-vendor judge (`factory arena judge`), benchmarks, or live UI/diff checks against the rubric. Optionally graft one standout helper or boundary check from a runner-up into the winning design.
4. **Land only the winner:** Discard losing sandboxes cleanly (`factory arena cleanup`, `git worktree remove`, or delete `$TMPDIR` patches; never `git stash`), commit only the winner on the ticket branch, and record the options + rubric rationale in the PR/Handoff or response.

### 3. Staged pipeline (map -> build -> adversarial review -> verify)

Use for high-risk or `Never auto-merge` changes (auth, concurrency, data migrations, formal specs) where independent verification prevents self-grading bias:

1. **Map (read-only):** `research` subagent traces callers, concurrency assumptions, existing tests, and `Owned Paths` from `origin/<base>`.
2. **Build (isolated worktree):** Implementer writes a failing test (negative test first), applies the fix, and runs targeted tests + static checks.
3. **Adversarial review / formal check:** A _fresh_ reviewer subagent (with no memory of implementation excuses) checks the diff against `shared/floor.md`, domain invariants, and relevant `principle-*` skills (or runs `/factory-statechart` / `/factory-formal-verify-maintain`).
4. **Land gate:** Coordinator checks `baseRefName`, CI checks (`gh run watch` + REST check-runs), `Never auto-merge` escalation flags, and `## Handoff`. Never auto-merge without explicit authorization where rules forbid it.

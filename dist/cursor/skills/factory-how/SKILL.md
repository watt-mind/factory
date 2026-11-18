---
name: factory-how
description: "Map and explain how a system, module, or end-to-end flow works today with concrete file paths, line numbers, and observed control/data flow. Use for /factory-how, 'how does X work', or architecture traces."
---

# How (architecture & flow trace)

Explain how a codebase mechanism actually works end to end using direct code evidence. Pairs naturally with `../principle-minimize-reader-load/SKILL.md` (trace from trigger to side effect, skip wrapper noise) and `../factory-why/SKILL.md` when rationale is also needed.

This skill is read-only. Never edit product files during a trace.

## Workflow

### 1. Check checkout freshness

Run `git fetch --quiet` and check `HEAD` against `origin/<base>`. If the checkout is clean and current, link workspace files directly (`file:///...#L1-L40`). If behind, ahead, or dirty, read from `origin/<base>` (`git show origin/<base>:<path>`) and cite `origin/<base>@<sha>`. If fetch/rev-list fails, mark freshness unknown and prefer `origin/<base>`.

### 2. Locate before reading

1. If `.codegraph/` exists at the repo root, call `codegraph_explore` first to resolve symbols, dynamic dispatch, and callers in one shot.
2. Otherwise use `rg -n` (excluding `.git`, `node_modules`, `.nuxt`, `.trigger`, build outputs) to find entry points, handlers, state stores, and tests.
3. Read only bounded line ranges around the entry point, boundary checks, state transitions, and sinks.

### 3. Fan out multi-module traces cleanly

If a flow spans 3+ subsystems (for example, UI trigger -> API boundary -> background queue -> state store), delegate read-only slices to parallel read-only exploration subagents partitioned by layer or directory, then verify their `file:line` claims before synthesizing.

### 4. Trace concrete behavior

Cover what an engineer needs to change the code safely:

- **Entry point and trigger:** User action, CLI command, webhook, cron, or event listener.
- **Control and data flow:** Step-by-step path across boundaries (`input -> validation -> state mutation -> side effect/response`), naming exact types and functions.
- **State and concurrency:** Locks, leases, retries, idempotency keys, cancellation/cleanup, and failure modes.
- **Invariants and verification:** Existing tests or formal specs (`.claude/skills/verify-*/SKILL.md`) that constrain changes.

### 5. Present clearly

Apply `../factory-unslop/SKILL.md` rules:

- Open with a 2-sentence plain summary of the mechanism before diving into steps.
- Link every file, symbol, and line range explicitly (`[name.ts](file:///path/name.ts#L10-L35)` or `origin/<base>@<sha>`).
- Add a focused Mermaid `flowchart` or `sequenceDiagram` only when 3+ components interact across boundaries (quote any node label containing parentheses or brackets).
- Never state behavior from memory or filenames alone: report only code actually inspected, and mark any inference as inferred.

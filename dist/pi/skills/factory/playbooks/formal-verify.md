# Formal Verification Playbook

Verify ordering, concurrency, and state-machine invariants with TLA+ and `/factory-statechart`, or pure data invariants with property-based tests.

## Skills to Invoke

- **New target:** `/factory-formal-verify-create` (`../../factory-formal-verify-create/SKILL.md`)
- **After merges/refactors:** `/factory-formal-verify-maintain` (`../../factory-formal-verify-maintain/SKILL.md`)
- **Running/reading TLA+ models:** `/factory-statechart` (`../../factory-statechart/SKILL.md`)

## Steps

1. **Tripwire:** Find or file the ticket, claim it, and create an isolated worktree (`bin/worktree-up.sh`) before creating or modifying tracked verification skills or tests.
2. **Choose the right tool:** Use TLA+ + `/factory-statechart` for interleavings, locks, reconnects, and lifecycle state machines; use property-based tests (`fast-check` / `hypothesis`) on the **real code** for pure parsers, sanitizers, and diff/transform invariants.
3. **Keep findings honest:** Never weaken an invariant to make TLC pass. If current code breaks a property, file a `Triage` issue with the shortest counterexample path.
4. **Prove it can fail:** Verify the check catches a scratch break (e.g. removed guard or reordered step), then restore the file with `git checkout HEAD -- <path>` (never `git stash`).
5. **Record coverage & sync commit:** Commit the project-local `.claude/skills/verify-<area>/SKILL.md` with exact covered files, bounds, and sync commit SHA.

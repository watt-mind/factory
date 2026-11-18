# Refactoring Playbook

Behavior-preserving structural improvement: remove dead weight, shrink mutable scope, and lower reader load.

## Principles to Load

- `../../principle-subtract-before-you-add/SKILL.md`
- `../../principle-minimize-reader-load/SKILL.md`
- `../../principle-laziness-protocol/SKILL.md`
- `../../principle-test-behavior-not-implementation/SKILL.md`
- `../../principle-redesign-from-first-principles/SKILL.md` (when incremental patching no longer fits and the ticket permits structural redesign)

## Steps

1. **Tripwire:** Find or file the ticket, claim it, and create an isolated worktree (`bin/worktree-up.sh`) before editing.
2. **Baseline:** Run the targeted tests for the area before making structural edits so behavior preservation is provable.
3. **Subtract first:** Delete dead code, unused branches, and one-caller wrappers before extracting new modules or hooks. Preserve security/boundary guards and required schema fields.
4. **Shrink state & reader load:** Collapse scattered boolean/optional bags into reducers or discriminated unions; keep modules focused and shallow.
5. **Verify:** Re-run targeted tests + static checks (lint/typecheck/format) with zero skipped/relaxed assertions.
6. **Sync formal verification:** If covered files changed, run `/factory-formal-verify-maintain` to keep `.claude/skills/verify-*/` and its sync commit accurate.
7. **Hand off:** Open PR targeting `config/repos.yaml`'s `base` with `Fixes <ISSUE-ID>` and post the `## Handoff` comment.

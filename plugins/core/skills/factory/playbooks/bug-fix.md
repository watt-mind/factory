# Bug Fix Playbook

Reproduce the defect, prove the test fails first, fix the root cause, and verify.

## Principles to Load

- `../../principle-fix-root-causes/SKILL.md`
- `../../principle-test-behavior-not-implementation/SKILL.md`
- `../../principle-attack-the-premise/SKILL.md` (if 2+ fixes sharing one premise have already failed)

## Steps

1. **Tripwire:** Find or file the ticket, claim it, and create an isolated worktree (`bin/worktree-up.sh`) before editing.
2. **Reproduce & trace:** Follow the symptom back to the first place the system went wrong. Only add a defensive guard if the handled state is genuinely legitimate.
3. **Negative test first:** Write a regression test asserting user-observable behavior and **observe it fail** before applying the fix.
4. **Apply minimal fix** within `Owned Paths`. If the change touches `Never auto-merge` or `escalate_paths` surfaces, flag for escalation without auto-merging.
5. **Verify:** Run the ticket's Verification Command, targeted tests covering the changed surface, and fast static checks (lint/typecheck/format) — leave full suites to CI unless cross-cutting blast radius requires them.
6. **Check formal specs:** If the bug touched code covered by a `.claude/skills/verify-*/SKILL.md`, run `/factory-formal-verify-maintain` (or `/factory-statechart`).
7. **Hand off:** Open PR targeting `config/repos.yaml`'s `base` with `Fixes <ISSUE-ID>` and post the `## Handoff` comment.

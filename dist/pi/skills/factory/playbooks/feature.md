# Feature Playbook

Build new or changed behavior from a clean domain model and verified boundaries.

## Principles to Load

- `../../principle-foundational-thinking/SKILL.md`
- `../../principle-model-the-domain/SKILL.md`
- `../../principle-type-system-discipline/SKILL.md`
- `../../principle-boundary-discipline/SKILL.md`
- `../../principle-experience-first/SKILL.md` (if UI-affecting)
- `../../principle-exhaust-the-design-space/SKILL.md` (only if net-new UI surface or material layout redesign)

## Steps

1. **Tripwire:** Find or file the ticket, claim it, and create an isolated worktree (`bin/worktree-up.sh`) before editing.
2. **Name the data shape first:** Model states and variants as discriminated unions, typed registries, or state machines before writing logic. Validate untrusted input at system boundaries.
3. **Design exploration (UI / novel architecture only):** If net-new UI or material redesign, prototype 2–3 distinct options using `$TMPDIR` patches (never `git stash`), select and commit the winner, and record rationale.
4. **Implement cleanly:** Keep functions single-purpose with shallow nesting; avoid duplicating logic.
5. **UI visual loop (if UI-affecting):** Render live UI, capture bounded screenshots (prefer mobile viewport / element scope), critique hierarchy/spacing/contrast/states coldly, and polish at least once.
6. **Verify:** Write behavioral tests, run targeted suites + fast static checks (lint/typecheck/format), and run `/factory-statechart` if a state machine changed.
7. **Hand off:** Open PR targeting `config/repos.yaml`'s `base` with `Fixes <ISSUE-ID>` and post the `## Handoff` comment.

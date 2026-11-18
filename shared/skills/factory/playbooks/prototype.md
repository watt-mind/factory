# Prototype Playbook

Cheap, throwaway experiment to settle an empirical question (performance, layout, API behavior) before committing to a design.

## Principles to Load

- `../../principle-exhaust-the-design-space/SKILL.md`
- `../../principle-explain-the-number/SKILL.md` (when comparing numbers/timings)

## Steps

1. **Frame the fork:** State the concrete question the experiment must settle and what outcome picks which option.
2. **Isolate the scratch work:** Work in `$TMPDIR` or an isolated worktree, saving alternatives as `$TMPDIR` patches (never `git stash` in a worktree, and never pollute the main checkout).
3. **Run & observe:** Measure or visually inspect the real output rather than guessing or asking the human to decide an empirical question.
4. **Discard throwaway code:** Keep only the winning approach (committed cleanly on a ticketed branch) or report the measured comparison if in an investigation.

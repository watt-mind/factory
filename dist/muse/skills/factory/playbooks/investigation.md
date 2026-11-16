# Investigation Playbook

Read-only analysis: architecture trace, root-cause diagnosis without editing, or principles/code review.

## Principles to Load (As Needed)

- `../../principle-minimize-reader-load/SKILL.md`
- `../../principle-explain-the-number/SKILL.md` (when evaluating timings, benchmarks, or counts)

## Steps

1. **Check checkout freshness** before citing trunk behavior (`git fetch --quiet`, compare `HEAD` vs `origin/<base>`). If dirty or behind, read from `origin/<base>` and name the ref (`origin/<base>@<sha>`).
2. **Locate before reading:** Use `rg -n` (or `codegraph_explore` if `.codegraph/` exists) before opening files; read bounded line ranges.
3. **Fan out large audits** to `research` subagents partitioned by directory/concern so main context stays clean.
4. **Do not edit product files.** If actionable bugs or gaps are found, present them clearly with `file:line` evidence and offer to file tickets (or file `Triage` issues if asked).
5. **Report cleanly:** Distinguish directly observed facts from inferences, and link every referenced file.

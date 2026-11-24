# factory-no-comments

> Spawn factory-comment-sicko to audit comments and suppressions, remove accepted noise, fix MUST KILL workarounds, and encode claimed constraints

Run a cold comment and suppression hygiene pass using **`shared/skills/factory-no-comments/SKILL.md`** and the **`factory-comment-sicko`** read-only subagent.

1. **Scope:** Use `$ARGUMENTS` (file paths, directory, or diff range) when provided; otherwise audit the current diff against `origin/<base>` including the working tree. Never sweep an entire large repository in one pass.
2. **Spawn `factory-comment-sicko`:** Pass `worktree: <absolute path>` and the exact scope without restating its rules.
3. **Audit the report:** Reject scope escapes, protected keep-list deletions, or misstated `MUST KILL`s; check for missed lint/type suppressions; verify thin `IMPORTANT` / `do not remove` claims with `/factory-why`. Allow at most one rerun on rejection.
4. **Delete & fix:** Remove accepted comments, apply trivial `MUST KILL` fixes directly, sketch non-trivial shapes first, and implement the smallest root-cause fix inside `Owned Paths` (file out-of-scope root causes to `Triage`).
5. **Encode constraints:** For constraint comments (`do not remove`, `must stay`, etc.), offer the cheapest in-scope type, runtime check, test, or lint rule; encode on approval, then delete the comment.
6. **Verify & report:** Run targeted tests plus lint/format/typecheck on touched files and report deletions, skips, reruns, fixes, encodings, and open follow-ups.

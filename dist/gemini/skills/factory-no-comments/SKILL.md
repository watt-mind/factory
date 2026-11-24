---
name: factory-no-comments
description: "Spawn factory-comment-sicko on a diff or scoped file list, audit its report, delete accepted comments, fix accepted MUST KILL root causes, and offer structural encodings for constraint comments. Use for /factory-no-comments before PR review or in scoped module cleanup passes."
---

# No comments

Hand comments and suppressions to a fresh, adversarial reviewer (`factory-comment-sicko`) who did not write them, audit its report, apply accepted deletions and root-cause fixes, and offer structural encodings for claimed constraints.

Defer to `factory-comment-sicko`'s cold perspective — an author defends its own comments.

## Scope

- Use the caller's explicit files, directory, or diff range.
- Otherwise use the current diff against `origin/<base>` (including the working tree).
- Never run across an entire large repository in one pass; batch existing-codebase sweeps by module or directory so every PR stays small, conflict-free, and reviewable.
- Before the first file edit, obey the repository's ticket, worktree, and `Owned Paths` rules (`AGENTS.md` / `shared/floor.md`).

## Steps

### 1. Spawn `factory-comment-sicko`

Spawn a fresh **`factory-comment-sicko`** subagent with:

- `worktree: <absolute path>`
- The exact scope (file list, directory, or diff command/range).

Do not restate `factory-comment-sicko`'s rules or steer its verdict.

### 2. Audit the report

Inspect every item in `factory-comment-sicko`'s report against the real files:

- **Reject** scope escapes, deletions of keep-list-protected comments (license headers, proven external quirks, `prettier-ignore`, public API contracts, constraint-explaining issue links), misstated `MUST KILL` reasons, or flags that treat kept intentional code as guilty.
- **Keep reshape flags actionable.** `MUST KILL` flags on surprises in our own code stay actionable — do not keep those comments. A keep survives only with proof it is about something we cannot change.
- **Audit missed suppressions.** Check the scoped files for any `eslint-disable`, `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `# noqa`, or `# type: ignore` the reviewer missed. Correctness or safety suppressions stay actionable `MUST KILL`s.
- **Verify thin warning comments.** Before accepting a thin `IMPORTANT` / `do not remove` / `must stay` kill or keep, trace the symbol or run `../factory-why/SKILL.md`. If a kill is ambiguous, delete it. If a keep is refuted or still ambiguous, delete it.
- **Rerun budget.** If the report fails audit, rerun `factory-comment-sicko` **once** with the specific audit failure named. If a second report fails audit, stop, report the open issues, and fail `/factory-no-comments`.

### 3. Apply deletions and shape refactors

- Delete every accepted comment and benign-to-remove suppression directly.
- Fix trivial accepted `MUST KILL` flags directly (delete a dead path, drop an unused parameter, narrow a type, use the real API).
- If any accepted `MUST KILL` flag needs structural design across functions or modules, sketch the smallest clean module/type shape first before editing, then implement it in Step 4.

### 4. Implement root-cause fixes

- Implement the smallest root-cause fix inside scope (`Owned Paths`) and remove every named workaround.
- `../principle-fix-root-causes/SKILL.md` and `../principle-redesign-from-first-principles/SKILL.md` guide intent only — neither authorizes widening `Owned Paths`, refactoring untouched callers outside scope, or bolting on symptom guards.
- If a root cause sits outside scope or `Owned Paths`, land the smallest clean in-scope fix and file the remaining root-cause work to `Triage`.

### 5. Encode constraint comments

Constraint comments claim invariants like `do not remove`, `do not change wording`, `must stay after X`, or `talk to X before changing`.

- Leave keeps that document an external dependency/platform quirk we cannot change.
- For every other constraint comment, offer the cheapest in-scope structural enforcement — a **type, runtime assertion, regression test, or CI lint rule** (per `../principle-encode-lessons-in-structure/SKILL.md`).
- Wait for interactive approval (unattended and eval runs require caller pre-approval).
- If approved: encode the constraint, verify it catches the violation, then delete the comment.
- If declined or out of scope: delete the comment, report the unenforced constraint open, and sketch any out-of-scope follow-up (or file it to `Triage`).

### 6. Verify and report

Run targeted tests covering the touched files plus fast static gates (lint, format check, typecheck). Report:

- Deletion count and touched files
- Rejected/kept items and any rerun
- Refactor sketch (if any) and `MUST KILL` root-cause fixes landed
- Constraint encoding offers, encodings landed, and unenforced constraints
- Any out-of-scope follow-ups filed to `Triage`

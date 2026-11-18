---
name: factory-why
description: "Trace the historical rationale and decision archaeology behind existing code, config, or architecture before changing it. Use for /factory-why, 'why was this built this way', or before refactoring load-bearing design choices."
---

# Why (decision archaeology)

Trace why a design choice, workaround, guard, or convention exists before deleting or rewriting it. Chesterton's fence applies: do not remove a load-bearing check without knowing what broke without it.

This skill is read-only. Never edit product files during archaeology.

## Workflow

### 1. Check checkout freshness

Before trusting working-tree history or code lines, compare `HEAD` with `origin/<base>` (`git fetch --quiet`, `git rev-list --count HEAD..origin/<base>`, `git status --porcelain`). If dirty, behind, or ahead, inspect commits and files on `origin/<base>` directly (`git show origin/<base>:<path>`) and cite `origin/<base>@<sha>` in your answer.

### 2. Locate the artifact

Use `codegraph_explore` (when `.codegraph/` exists) or `rg -n` (excluding `.git`, `node_modules`, `.nuxt`, build outputs) to find the exact symbol, constant, comment, or config line in question.

### 3. Trace git history

Run focused git archaeology on the specific lines or identifier rather than reading full history:

- Pickaxe string/symbol additions and removals: `git log -S "<symbol>" --oneline origin/<base> -- <path>`
- Regex history for callers or patterns: `git log -G "<regex>" -n 15 --oneline origin/<base>`
- Line-range evolution (follows moves and edits cleanly): `git log -L <start>,<end>:<path> origin/<base>`
- Inspect introducing and modifying commits: `git show <sha>`

Skip formatting-only or pure rename commits (`--follow`, `-w`) when tracing behavioral intent.

### 4. Read the decision record

Commits tell _what_ changed; external records usually hold _why_:

- **Linked PRs and reviews:** `gh pr list --search "<sha>" --state all --json number,title,url` and `gh pr view <num> --comments`
- **Issue trackers:** Look up referenced `ISSUE-ID` / `#N` via `factory ticket get <ID>` (for Linear or GitHub Issues) or `gh issue view <N>`
- **Repo decision logs & docs:** Check `docs/product-decisions.md`, `docs/`, ADRs, inline `WHY:` / `HACK:` comments, and regression tests added in the introducing commit (tests often preserve the exact failure scenario).

### 5. Report cleanly

Apply `../factory-unslop/SKILL.md` rules and separate facts from inference:

- **What introduced it:** Commit `<sha>`, PR `#<num>`, issue `<ISSUE-ID>`, and date/author context when relevant.
- **Problem it solved / constraint it preserves:** Directly quoted or observed evidence from commits, PR reviews, issues, or tests.
- **Still load-bearing vs stale:** Which assumptions in that history still hold on `origin/<base>` and which changed since then (for example, an upstream SDK upgrade or removed flag).
- **Unknowns:** If commit and issue history never recorded _why_, say "not recorded in git or issue history" and clearly label any hypothesis as inferred.

Pair with `../factory-how/SKILL.md` when the user also needs the current runtime flow, or `../factory-teach/SKILL.md` for a progressive walkthrough.

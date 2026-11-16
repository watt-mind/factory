---
name: factory-verify-maintain
description: 'Audit and update a project''s .claude/skills/verify-<app>/ skill and feature map against current code: parallel source readers per feature, one live coordinator pass driving every feature, and at most one PR of proven map/harness updates. Use for /factory-verify-maintain or "audit the verify skill".'
disable-model-invocation: true
---

# Maintain a verification skill

A feature map drifts as soon as routes, selectors, auth helpers, or workflows change. This skill keeps `.claude/skills/verify-<app>/` accurate by comparing every feature file against current source (`origin/<base>`) and exercising every mapped feature against a live instance.

## Outcomes

End every run with one explicit outcome:

- **`clean`** — all mapped features checked against source and exercised live with no needed skill/map changes. No branch, no PR.
- **`changed`** — one focused PR shipping verified updates to the verification skill directory (`.claude/skills/verify-<app>/`) after re-running live proofs on changed recipes.
- **`blocked`** — startup, auth, or live coverage failed before completion; state the exact blocker and what remains unverified.

## Strict edit scope

Edit **only** the verification skill's own directory (`.claude/skills/verify-<app>/SKILL.md`, `features/`, and its helper scripts). **Never modify product code** during a maintenance pass:

- User-POV description or selector changed legitimately → doc/harness drift -> update the map/script.
- Product behavior itself is broken → product regression -> file a `Triage` ticket via `factory ticket file` (`source:agent`, citing `origin/<base>@<sha>`) rather than weakening the recipe or docs to match broken behavior.

## Six-step pass

### 0. Locate the target skill

Find `.claude/skills/verify-*/` (or `.cursor/skills/verify-*/`). Multiple candidates → ask which app to audit; zero candidates → stop and point to `/factory-verify-create`. Check trunk freshness (`git fetch --quiet`) so source reads reflect `origin/<base>`.

### 1. Index hygiene

Read `features/README.md` and list all files under `features/`. Fix dead links, missing files, duplicate slugs, or stale entries.

### 2. Source wave (parallel read-only subagents)

Spawn one read-only subagent per feature file concurrently (`reviewer != implementer` discipline; never let source readers edit files or launch browsers). Each returns:

- What the feature currently does in `origin/<base>`
- Confirmed doc/selector/auth drift (`file:line` citations) or `none`
- One concrete updated drive recipe

### 3. Reconcile & detect new surfaces

Collect all subagent findings, check recent git history for new user-facing routes/commands missing from `features/README.md` (require a concrete source entry point before adding one), and batch overlapping setup states cleanly.

### 4. Live pass (coordinator owns driving)

Even when source reads look clean, boot an isolated worktree/instance per the skill's `Launch` section and drive every mapped feature live using the harness's default browser/CLI tools while enforcing three invariants:

1. **Doctor before drive & after failure:** Run `Doctor` before the first feature and again after any unexpected failure; on wedged UI state, reset to baseline or relaunch rather than retrying blindly.
2. **Evidence survives cleanup:** Store screenshots/logs outside the repo (`$FACTORY_ARTIFACT_DIR` / `$TMPDIR`) and verify they remain on disk after `Cleanup`.
3. **Clean teardown:** Tear down every process, port, or fixture created by the run (even after failures), without killing unrelated sessions.

A feature unreachable due to a missing external credential/entitlement becomes `verified-unreachable` only with the exact prerequisite and attempted route recorded (update `Gotchas` if the map omitted that prerequisite). Re-drive any fixed harness/recipe once live before committing.

### 5. Triage

Separate skill/map drift fixes (kept in this pass's edit scope) from product regressions (filed to `Triage` via `factory ticket file` and reported cleanly).

### 6. Ship or stop

- **`changed`:** Review every changed file inside `.claude/skills/verify-<app>/`, run fast static checks, open a single PR against the configured `base` (unless working inside an interactive no-PR check), and keep proof artifacts outside git.
- **`clean` / `blocked`:** Leave the tree clean and report per-feature coverage (`source checked`, `live driven`, `unreachable`, `regressions filed`).

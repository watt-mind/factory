# factory-baseline

> Bootstrap or align a repository to the PC-01..PC-23 CI, lint, security, worktree, and agent-entry baseline in one PR

Align a new or lagging repository with Factory's `PC-01`…`PC-23` baseline and SAST controls cleanly in one PR.

Load and execute **`shared/skills/factory-baseline/SKILL.md`** (resolved relative to your active harness skill tree, or `docs/project-conventions.md` + `docs/code-security.md`), applying the optional local overlay `~/Develop/hdkiller/docs/guides/project-conventions.md` if present on disk:

1. **Survey & grade (`PC-01`…`PC-23`):** Check `origin/<base>` (`git fetch --quiet`), inspect workflows/scripts/GitHub settings, and build the initial `PASS / FAIL / N/A` table. Stop after printing the matrix and plan when `--dry-run` is passed.
2. **Isolate cleanly:** File/claim a ticket if missing and work in an isolated worktree (`bin/worktree-up.sh` or `git worktree add`; never `git stash`).
3. **Scaffold missing baseline:** Align in-repo CI (`ci.yml`), SAST/security (`security.yml`, `ruff.toml`, `eslint-plugin-security`), `dependabot.yml`, Git hooks (`lefthook.yml` or Husky + `lint-staged` + `commitlint`), `AGENTS.md` + thin `CLAUDE.md`/`GEMINI.md`, `docs/product-decisions.md`, worktree isolation (`W-1`…`W-13`), and (where applicable) `bin/dev-login.sh`, smoke/E2E isolation (`H-1`…`H-8`), and GHCR hygiene (`R-1`…`R-6`).
4. **Apply safe GitHub settings (`PC-08`, `PC-09`, `PC-11`):** Unless `--no-github-settings` is passed, enable vulnerability alerts, automated security fixes, and read-only workflow token permissions via `gh api`, and check/configure branch protection.
5. **Verify & open PR:** Run lint, typecheck, format check, unit tests, and `factory security`; open one baseline PR against `<base>` (`gh pr create --base <base>`); report the **Before → After** `PC-01`…`PC-23` matrix and file any remaining external blockers (`PC-18` secrets, plan limits) to `Triage`.

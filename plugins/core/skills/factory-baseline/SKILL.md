---
name: factory-baseline
description: "Bootstrap or align a repository to the Factory quality, CI, security, worktree, and agent-entry baseline (PC-01..PC-23 + SAST). Use for /factory-baseline, /factory-audit --fix, or when setting up CI, lint, hooks, security scans, worktree scripts, and AGENTS.md for a new or lagging repo."
---

# Align a Repository to the Factory Baseline

Bring a new or lagging repository into conformance with Factory's `PC-01`…`PC-23` baseline and SAST controls in one clean, verified pull request.

## 1. Read the Baseline References

Read both bundled references in full before touching files:

- [`references/project-conventions.md`](references/project-conventions.md) — `PC-01`…`PC-23`, `W-1`…`W-13`, `H-1`…`H-8`, `R-1`…`R-6`, concurrency, branch protection, agent entry files.
- [`references/code-security.md`](references/code-security.md) — Semgrep, Gitleaks, Actionlint, ESLint security rules, Ruff `S` rules, `pip-audit`, `npm audit --audit-level=high`, Lefthook/Husky hooks.

If an org-local conventions overlay exists on this machine (for example via `$FACTORY_CONVENTIONS_OVERLAY` or your org's infra docs), also read it for org-specific runner labels and tracker team/project mappings.

## 2. Survey and Grade (`PC-01`…`PC-23`)

Inspect the target repository against `origin/<base>` (`git fetch --quiet`) and live GitHub state:

1. **Stack & scripts:** Node/Bun/TypeScript (`package.json`), Python (`pyproject.toml`, `uv.lock`, `requirements*.txt`), Rust/Go, Docker/GHCR.
2. **Branches & visibility:** integration branch (`develop` or default), deploy branch (`main`/`master`), and repo visibility (`gh repo view --json isPrivate,nameWithOwner` -> private org repos pin target self-hosted labels per `PC-03`; public repos allow hosted runners when configured).
3. **Grade `PC-01`…`PC-23`:** Record **PASS / FAIL / N/A** (with concrete repo-grounded N/A reasons only) before editing.

If `--dry-run` was passed, stop after outputting the `PC-01`…`PC-23` grade matrix and remediation plan.

## 3. Ticket and Worktree Discipline

Follow `AGENTS.md` / `shared/floor.md`:

- Before writing files inside an existing tracked repo, find or create a tracking issue (unless working explicitly with `--no-ticket` / `"no ticket"`).
- Work inside an isolated worktree (`bin/worktree-up.sh <ISSUE-ID>` when present, otherwise `git worktree add`). Never use `git stash` or `git rebase --autostash`.

## 4. Scaffold or Align In-Repo Baseline

Apply only the missing or drifting items cleanly within the target stack (respecting specific check IDs when `$ARGUMENTS` names a subset such as `PC-01 PC-06 PC-10`):

- **`PC-01`–`PC-05`, `PC-22` (`.github/workflows/ci.yml`):**
  - Run lint, typecheck, format check, and unit tests on `pull_request` and pushes to integration/deploy branches.
  - Use the baseline `concurrency:` group (`ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}`, canceling only `pull_request` runs).
  - Match `runs-on:` to the repo's runner policy (`PC-03`), set `retention-days: 1` on every `upload-artifact` (`PC-04`), and enforce `H-1`…`H-8` Docker/port isolation for E2E containers.
  - Wire dependency CVE checks (`npm audit --audit-level=high` for JS/TS; `pip-audit` for Python).
- **`PC-06` (`.github/workflows/security.yml` & language SAST):**
  - Add CodeQL (gated with `vars.CODEQL_ENABLED == 'true'` if unavailable on the plan, and `ram: 8192` in `github/codeql-action/analyze`), Semgrep, Gitleaks, and Actionlint.
  - For Python repos, add calibrated `ruff.toml` (`S` rules with test-dir exemptions `S101`, `S105`, `S106`, `S107`, `S608` — advisory-first if legacy backlog exists).
  - For JS/TS repos, configure ESLint + Prettier (`lint`, `typecheck`, `format`, `format:check` scripts).
- **`PC-07` (`.github/dependabot.yml`):**
  - Configure weekly package ecosystem updates + monthly `github-actions` updates targeting the integration branch.
- **`PC-10` (Local Git hooks):**
  - Prefer `lefthook.yml` (staged `gitleaks git --pre-commit --staged`, commit-msg format gate, staged `ruff`/linter) or Husky + `lint-staged` + `@commitlint/cli` matching repo conventions.
- **`PC-12`–`PC-14`, `PC-19`–`PC-20` (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/product-decisions.md`):**
  - Ensure `AGENTS.md` documents the stack, commands, tracker/branch pointer, worktree workflow (`W-12`), and current `<!-- FACTORY:FLOOR:BEGIN -->` block (sync from `$FACTORY_ROOT` via `bun build/emit.mjs --sync-floor` when registered in `config/repos.yaml`).
  - Create/align thin `CLAUDE.md` and `GEMINI.md` entry pointers without duplicating protocols or vendor skill dumps.
  - Seed `docs/product-decisions.md` if absent (`PC-19`) and demote any competing `todo.md`/`issues.md` file (`PC-14`).
- **`PC-15` (Worktree isolation):**
  - Scaffold Worktrunk `.config/wt.toml` or `bin/worktree-{up,down,warm}.sh` meeting `W-1`…`W-13` (deterministic per-ticket ports/DB, fail-closed `migrate deploy`, non-interactive, safe teardown), or explicitly document `max_in_flight: 1` when deferring to a dedicated follow-up ticket.
- **`PC-16`, `PC-17`, `PC-21`, `PC-23` (Deploy smoke, E2E, Dev login, GHCR retention):**
  - Add or verify post-deploy smoke workflow (`PC-16`), `e2e.yml` (`PC-17`), fail-closed `bin/dev-login.sh` (`PC-21`, if authenticated UI), and `R-1`…`R-6` (`provenance: false`, `sbom: false`, scheduled SHA retention on default branch, `PC-23`, if publishing container images).

## 5. Apply Safe GitHub Repository Settings (`PC-08`, `PC-09`, `PC-11`)

Unless `--no-github-settings` is passed:

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
gh api -X PUT "repos/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$REPO/automated-security-fixes"
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false
```

Configure or check branch protection (`PC-11`) on `develop` and `main`/`master` where plan permissions allow (if plan blocks it, record `N/A (free private plan blocks branch protection)` honestly).

## 6. Verify Locally and Open One Baseline PR

1. Run the repo's lint, typecheck, format check, targeted unit tests, and `factory security` locally inside the worktree — fix any workflow syntax (`actionlint`), lint, format, or secret-scan issues cleanly.
2. Push the branch and open one PR targeting the repo's configured integration `base` (`gh pr create --base <base>`). Watch CI on the exact pushed SHA (`gh run list --workflow ci.yml --commit <sha>` + `gh run watch`) when CI runs on PRs, or verify `/factory-verify` cleanly.
3. Re-grade `PC-01`…`PC-23` showing **Before → After**, and file any remaining human-blocked gaps (such as missing deployment/API secrets for `PC-18`) to `Triage` rather than masking them.

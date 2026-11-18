# Project Conventions Baseline

Portable GitHub quality, CI, security, worktree, and agent-entry baseline for Factory-managed repositories (`PC-01`…`PC-23`).

When an operator workspace maintains local org-specific overlays (for example, team/project mappings or private runner labels via `$FACTORY_CONVENTIONS_OVERLAY` or your org's infra docs), those overlay this baseline without duplicating it.

Related baseline: [`code-security.md`](./code-security.md).

---

## 1. Goals

Every long-lived repository should enforce:

1. **PR quality gates (`PC-01`, `PC-02`)** — lint, typecheck, format check, and unit tests on every PR.
2. **Dependency hygiene (`PC-07`, `PC-08`)** — Dependabot for package ecosystems + GitHub Actions, vulnerability alerts, and automated security updates.
3. **Security scanning (`PC-06`)** — CodeQL (where plan permits) plus Semgrep, Gitleaks, and Actionlint SAST baseline ([`code-security.md`](./code-security.md)).
4. **Branch protection (`PC-11`)** — required status checks and no force-push / branch deletion on deploy (`main`/`master`) and integration (`develop`) branches.
5. **Runner policy (`PC-03`)** — private org repositories pin self-hosted target labels (`runs-on: [self-hosted, shadow]` for builds/CI, `[self-hosted, smoke-test]` for light smoke checks, `[self-hosted, e2e]` for browser E2E, `[self-hosted, macOS, mobile]` for mobile). Avoid unlabelled cloud runners (`ubuntu-latest`, `macos-latest`, `windows-latest`) in private billing-sensitive repos and avoid generic `[self-hosted, Linux]` on mixed hosts so heavy builds do not schedule onto lightweight smoke instances.
6. **Artifact retention (`PC-04`)** — every `actions/upload-artifact` step specifies `retention-days: 1`.
7. **Agent entry files (`PC-12`, `PC-13`)** — `AGENTS.md` with the synced Factory floor plus thin `CLAUDE.md` / `GEMINI.md` pointers.
8. **Parallel-agent readiness (`PC-15`, `W-1`…`W-13`)** — isolated worktree provisioning (Worktrunk `.config/wt.toml` or `bin/worktree-{up,down,warm}.sh`) so concurrent agents never collide on ports or databases.
9. **Post-deploy smoke check (`PC-16`)** — any auto-deploying branch runs a post-deploy smoke workflow proving the deployed URL serves the live commit.

---

## 2. Reference CI & Workflow Architecture

| Layer                             | Standard pattern                                                                                                                                                   |
| :-------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CI (`ci.yml`)**                 | Parallel lint, typecheck, format check, and unit test jobs on PRs and branch pushes                                                                                |
| **Concurrency (`PC-05`)**         | `group: ci-${{ github.event_name }}-${{ github.event.pull_request.number \|\| github.sha }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` |
| **Security (`security.yml`)**     | CodeQL (gated on `vars.CODEQL_ENABLED == 'true'` where needed, `ram: 8192`) + Semgrep + Gitleaks + Actionlint                                                      |
| **E2E (`e2e.yml`)**               | Browser/end-to-end suite with explicit per-run project/port isolation (`H-1`…`H-8`)                                                                                |
| **Dependabot (`dependabot.yml`)** | Weekly package ecosystem + monthly `github-actions` updates targeting the integration branch (`develop`)                                                           |
| **Actions permissions (`PC-09`)** | Default `GITHUB_TOKEN` workflow permission set to `read`; `can_approve_pull_request_reviews=false`                                                                 |

---

## 3. Checklist for a New or Lagging Repo

### A. In-repo files and scripts

```text
.github/
  dependabot.yml
  workflows/
    ci.yml          # lint + typecheck + format:check + unit tests
    security.yml    # CodeQL / Semgrep / Gitleaks / Actionlint
    e2e.yml         # optional or gated when expensive
AGENTS.md           # primary agent context + FACTORY:FLOOR markers + tracker pointer
CLAUDE.md           # thin pointer -> AGENTS.md
GEMINI.md           # thin pointer -> AGENTS.md (+ optional hot context below pointer)
```

#### Concurrency baseline pattern (`PC-05`)

```yaml
concurrency:
  group: ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

PR runs cancel superseded commits on the same PR, while push runs key by `github.sha` with `cancel-in-progress: false` so rapid merges never cancel each other's post-merge or deploy runs.

#### Package scripts (Node / TypeScript apps)

| Script                    | Purpose                                                  |
| :------------------------ | :------------------------------------------------------- |
| `lint`                    | ESLint (including `@typescript-eslint` / security rules) |
| `typecheck`               | `tsc --noEmit` or framework typecheck                    |
| `format` / `format:check` | Prettier write / CI check                                |
| `test:unit` (or `test`)   | Targeted unit test command                               |

Ignore generated build/framework dirs (`.nuxt`, `.next`, `dist`, coverage) in ESLint and Prettier configs.

#### Local Git quality hooks (`PC-10`)

Prefer **Lefthook** (`lefthook.yml`) for fast language-neutral hooks (`gitleaks git --pre-commit --staged`, commit message format check, staged `ruff`/linter), or **Husky + `lint-staged` + `@commitlint/cli`** for Node/JS apps:

```json
// .lintstagedrc.json (when using Husky)
{
  "*.{js,jsx,ts,tsx}": ["prettier --write", "eslint --fix"],
  "*.{json,md,css}": ["prettier --write"]
}
```

### B. GitHub repository settings (`PC-08`, `PC-09`, `PC-11`)

```bash
REPO=owner/name

# Enable vulnerability alerts & automated security fixes
gh api -X PUT "repos/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$REPO/automated-security-fixes"

# Default Actions token permissions: read-only
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false
```

Protect deploy (`main`/`master`) and integration (`develop`) branches where supported:

| Branch                            | Minimum required checks                            |
| :-------------------------------- | :------------------------------------------------- |
| Deploy branch (`main` / `master`) | Typecheck, Lint, Format (+ Unit / E2E when stable) |
| Integration branch (`develop`)    | Typecheck, Lint, Format (+ Unit when fast)         |

```bash
gh api -X PUT "repos/$REPO/branches/develop/protection" \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks='{"strict":true,"contexts":["Typecheck","Lint","Format"]}' \
  -F enforce_admins=false \
  -f required_pull_request_reviews='{"required_approving_review_count":0}' \
  -F restrictions='' \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

### C. Plan / ownership constraints

| Feature                      | Public repo |   Free personal private   | Org / Pro / GHAS |
| :--------------------------- | :---------: | :-----------------------: | :--------------: |
| Actions CI & Dependabot PRs  |     Yes     |            Yes            |       Yes        |
| Vulnerability alerts & fixes |     Yes     |            Yes            |       Yes        |
| Branch protection / rulesets |     Yes     |      No (needs Pro)       |       Yes        |
| CodeQL / secret scanning     |     Yes     | No (needs GHAS or public) |    With GHAS     |

### D. CodeQL toggle and memory cap

Where CodeQL is gated pending plan enablement, keep `security.yml` present and gate the analyze job cleanly:

```yaml
if: ${{ vars.CODEQL_ENABLED == 'true' }}
```

In `github/codeql-action/analyze`, explicitly cap memory so parallel self-hosted jobs do not allocate excessive JVM/Node heap:

```yaml
- name: Perform CodeQL Analysis
  uses: github/codeql-action/analyze@v4
  with:
    ram: 8192
```

### E. Parallel-agent readiness (`W-1`…`W-13`)

Two worktree interfaces satisfy parallel-agent isolation:

1. **Primary standard — Worktrunk (`.config/wt.toml`):** deterministic port derivation (`PORT={{ branch | hash_port }}`), `[pre-start]` / `[post-start]` env & DB setup, `wt step copy-ignored` cache cloning, and `wt config state default-branch set <integration-branch>`.
2. **Script standard — `bin/worktree-{up,down,warm}.sh`:** `bin/worktree-up.sh <TICKET-ID> [type] [slug] [--no-compile]`, `bin/worktree-down.sh <TICKET-ID> [--force] [--delete-branch]`, `bin/worktree-warm.sh`.

Both must obey **`W-1`…`W-13`**:

| ID     | Requirement                                                                                                          | Why                                                                             |
| :----- | :------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| `W-1`  | **Deterministic allocation.** Derive ports and database names from the ticket number, never free-port scanning.      | Concurrent free-port probes race and hand two agents the same port.             |
| `W-2`  | **One database per ticket**, created on up and dropped on down.                                                      | Shared dev databases silently corrupt parallel migrations and tests.            |
| `W-3`  | **Never share the main checkout's port or database.**                                                                | Protects interactive dev runs from autonomous ticket runs.                      |
| `W-4`  | **Idempotent setup.** Re-running refreshes env/migrations without clobbering uncommitted work.                       | Agents re-run setup safely when resuming worktrees.                             |
| `W-5`  | **Generated env files.** Setup writes `.env*`; agents never hand-edit them.                                          | Prevents silent misconfiguration and credential drift.                          |
| `W-6`  | **Warm cache via copy-on-write / link** (`cp -c` / `wt step copy-ignored`) for `node_modules` and codegen caches.    | Keeps per-worktree startup fast and disk-light.                                 |
| `W-7`  | **Verified migration state.** Compare applied DB migrations against git migrations; hard-fail on divergent history.  | Prevents opaque schema errors during forward migration.                         |
| `W-8`  | **Never `migrate dev --name` in automation.** Use `migrate deploy` (non-interactive).                                | Prevents accidental migration generation from local drift.                      |
| `W-9`  | **Safe teardown.** `worktree-down` refuses dirty/unpushed trees unless `--force` is passed.                          | Prevents unattended teardown from deleting unpushed commits.                    |
| `W-10` | **Non-interactive.** Zero prompts or TTY reads; exit non-zero with exact remediation on error.                       | Headless/background agent shells hang on interactive prompts.                   |
| `W-11` | **Fails loudly and specifically.** Error messages name the remediation command.                                      | Lets agents recover from errors without guessing.                               |
| `W-12` | **Documented in `AGENTS.md`** with exact setup/teardown commands and a rule against raw `git worktree add`.          | Agents discover only what `AGENTS.md` makes explicit.                           |
| `W-13` | **Branches from integration branch, not default deploy branch** (e.g. `wt config state default-branch set develop`). | Prevents feature PRs from carrying unintended deploy-branch diffs or conflicts. |

Repos without isolated worktree tooling must document a strict `max_in_flight: 1` concurrency limit in `AGENTS.md`.

### F. Post-deploy smoke check (`PC-16`)

Auto-deploying branches (`develop`, `main`/`master`) require a post-deploy smoke workflow (or `post_release_checks` / `deployment.url` + `/factory-verify-deploy` integration) polling the deployed endpoint with a bounded retry loop until healthy and matching the expected commit/revision.

### G. Deterministic dev login (`bin/dev-login.sh`, `PC-21`)

Repositories with an authenticated UI provide `bin/dev-login.sh [role]` outputting a Playwright `storageState` JSON or local session for a deterministic seeded user:

- Never disable or bypass auth in application middleware or production builds.
- Fail closed unless local dev conditions are explicitly proved (dev mode env, local/worktree DB, loopback host).
- Absent from production settings/build bundles and documented with one command line in `AGENTS.md`.

### H. Parallel-safe CI on shared runner hosts (`H-1`…`H-8`, `PC-22`)

Shared runner hosts run multiple jobs and repositories concurrently against one Docker daemon and port space:

| Rule    | Requirement                                                                                                                 |
| :------ | :-------------------------------------------------------------------------------------------------------------------------- |
| **H-1** | Every CI `docker compose` call passes an explicit per-run project: `-p <repo>-e2e-${{ github.run_id }}`.                    |
| **H-2** | No static `container_name:` in CI compose files.                                                                            |
| **H-3** | Host ports are unpublished (compose network internal) or derived deterministically from `GITHUB_RUN_ID`.                    |
| **H-4** | Never kill processes by port or prune sibling containers (`always()` tears down only `${GITHUB_RUN_ID}`'s project).         |
| **H-5** | Container cleanup runs under `if: always()` (`docker compose -p <project> down -v --remove-orphans`).                       |
| **H-6** | No `docker system/image/builder prune` inside CI jobs (handled by host-level scheduled GC).                                 |
| **H-7** | Do not `actions/cache` artifacts that persist locally on self-hosted runner disks (`/srv/cache`, `~/.cache/ms-playwright`). |
| **H-8** | Any `concurrency:` serialization on shared runners must carry a comment naming the external shared resource.                |

### I. Container registry hygiene (`R-1`…`R-6`, `PC-23`)

Repositories publishing container images to GHCR enforce all six rules (`R-1`…`R-6`):

| ID    | Requirement                                                                                                                                                  |
| :---- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R-1` | Set `provenance: false` and `sbom: false` on `docker/build-push-action`.                                                                                     |
| `R-2` | Set `DOCKER_BUILD_RECORD_UPLOAD: "false"` and `DOCKER_BUILD_SUMMARY: "false"`.                                                                               |
| `R-3` | Add a scheduled GHCR retention workflow (runnable from the default branch) retaining named tags + last `N` commit tags.                                      |
| `R-4` | Delete versions only when all tags are ephemeral per-commit SHAs — never delete "untagged" versions blindly (which removes live multi-arch child manifests). |
| `R-5` | Protect named tags and `buildcache` tags explicitly.                                                                                                         |
| `R-6` | Match the repo's exact SHA tag scheme (`<sha>`, `sha-<sha>`, etc.) rather than assuming one global prefix.                                                   |

---

## 4. Agent Entry Files (`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`)

Maintain **one source of truth** per rule:

- **`AGENTS.md`**: Project summary, stack, dev/test/lint/migration commands, tracker/branch pointer, worktree setup (`W-12`), and the synced Factory floor block (`<!-- FACTORY:FLOOR:BEGIN -->` … `<!-- FACTORY:FLOOR:END -->`).
- **`CLAUDE.md`** / **`GEMINI.md`**: Thin pointers directing agents to `AGENTS.md` (and any tracker guide). Never duplicate full protocols or vendor skill dumps in `CLAUDE.md`.
- **No competing markdown task queues**: Never keep live `todo.md` / `issues.md` files competing with Linear or GitHub Issues (`PC-14`).

Canonical `CLAUDE.md` / `GEMINI.md` shape:

```markdown
# CLAUDE.md

Claude, please refer to **[AGENTS.md](./AGENTS.md)** for the primary repository
context, architecture, commands, operational rules, and issue-tracking standards.

This file (CLAUDE.md) is an entry point to ensure you find the centralized instructions.
```

---

## 5. Conformance Audit (`PC-01` … `PC-23`)

Grade each check **PASS**, **FAIL**, or **N/A** (with an explicit repo-grounded reason) against `origin/<base>` and live GitHub API state:

| ID      | Requirement                                           | How to verify                                                                                                                                             | Severity                       |
| :------ | :---------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- |
| `PC-01` | CI workflow runs lint + typecheck + format on PRs     | `.github/workflows/ci.yml` exists; jobs present; triggers include `pull_request`                                                                          | blocker                        |
| `PC-02` | Unit test job where a unit suite exists               | `test:unit` / `test` script in manifest → matching CI job                                                                                                 | high                           |
| `PC-03` | Runner isolation policy matches repo visibility       | Private repo workflows use target self-hosted labels (`shadow`/`smoke-test`/`e2e`/`macOS`), never unlabelled `*-latest` or generic `[self-hosted, Linux]` | blocker                        |
| `PC-04` | Artifact retention capped                             | Every `actions/upload-artifact` step sets `retention-days: 1`                                                                                             | medium                         |
| `PC-05` | CI concurrency uses baseline pattern                  | `concurrency:` matches `ci-${{ github.event_name }}-${{ github.event.pull_request.number \|\| github.sha }}`                                              | medium                         |
| `PC-06` | `security.yml` present (CodeQL + SAST)                | File exists; `vars.CODEQL_ENABLED` gate or active + `ram: 8192`                                                                                           | high                           |
| `PC-07` | `dependabot.yml` targeting integration branch         | File exists covering package ecosystem + `github-actions`                                                                                                 | medium                         |
| `PC-08` | Vulnerability alerts + automated security fixes on    | `gh api repos/$REPO/vulnerability-alerts` → 204                                                                                                           | high                           |
| `PC-09` | Actions default token permissions read-only           | `gh api repos/$REPO/actions/permissions/workflow` → `read`                                                                                                | high                           |
| `PC-10` | Pre-commit + commit-msg Git hooks wired               | `lefthook.yml` or `.husky/{pre-commit,commit-msg}` active                                                                                                 | medium                         |
| `PC-11` | Branch protection on deploy + integration branches    | `gh api repos/$REPO/branches/<b>/protection` (N/A on free private)                                                                                        | high                           |
| `PC-12` | `AGENTS.md` exists with tracker/floor pointers        | Matches §4 and carries current `FACTORY:FLOOR` markers                                                                                                    | blocker                        |
| `PC-13` | Thin `CLAUDE.md` / `GEMINI.md` pointers               | Matches §4 thin-pointer shape, no forked protocol                                                                                                         | medium                         |
| `PC-14` | No live markdown issue queue competing with tracker   | No active `todo.md` / `issues.md` queue                                                                                                                   | high                           |
| `PC-15` | Worktree tooling meets `W-1`…`W-13`                   | `.config/wt.toml` or `bin/worktree-{up,down,warm}.sh` graded per `W-*`                                                                                    | blocker for concurrent repos   |
| `PC-16` | Post-deploy smoke check for auto-deploying branches   | Smoke workflow or `/factory-verify-deploy` config present                                                                                                 | high                           |
| `PC-17` | E2E workflow present with non-stale gates             | `e2e.yml` exists; every `if:` condition matches current intent                                                                                            | high                           |
| `PC-18` | Required CI secrets/variables configured              | `gh secret list` / `gh variable list` covers every workflow reference                                                                                     | high                           |
| `PC-19` | Product-decisions doc exists                          | `docs/product-decisions.md` present and referenced in `AGENTS.md`                                                                                         | medium                         |
| `PC-20` | `AGENTS.md` claims match live repo reality            | Every documented gate, script, and limitation still holds                                                                                                 | high                           |
| `PC-21` | Deterministic dev login for authenticated UIs         | `bin/dev-login.sh` exists, named in `AGENTS.md`, fails closed in prod (N/A if no UI auth)                                                                 | high                           |
| `PC-22` | Parallel-safe CI on shared runner hosts (`H-1`…`H-8`) | Graded per `H-1`…`H-8` (`-p <repo>-e2e-${{ github.run_id }}`, `always()` down, no `prune`)                                                                | high (blocker with docker E2E) |
| `PC-23` | Container registry hygiene (`R-1`…`R-6`)              | Graded per `R-1`…`R-6` (`provenance: false`, `sbom: false`, scheduled SHA cleanup)                                                                        | high (when pushing images)     |

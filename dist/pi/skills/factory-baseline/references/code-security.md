# Code Security & Reusable SAST Quality Baseline

Static application security testing (SAST), secret leak prevention, dependency hygiene, and Git hook baseline for Factory-managed repositories.

Related baseline: [`project-conventions.md`](./project-conventions.md).

---

## 1. Goals & Security Pillars

1. **Static Application Security Testing (SAST)** — detect XSS, injection, prototype pollution, path traversal, unsafe regex/ReDoS, and unhandled promises in CI and locally.
2. **Tenant Data Isolation & Authorization Guards** — enforce explicit tenant/user scoping and restrict test/bypass imports via ESLint seam rules in multi-tenant applications.
3. **Secret Leak Prevention** — catch API keys, JWT secrets, tokens, and credentials on staged commits (`gitleaks git --pre-commit --staged`) and in CI.
4. **Dependency & Supply Chain Hygiene (SCA)** — block `high`/`critical` CVEs (`npm audit --audit-level=high`, `pip-audit`) and sanitize untrusted file/HTML parsers.
5. **Workflow & Pipeline Integrity** — lint `.github/workflows/*.yml` with `actionlint` against script injection and unpinned steps.

---

## 2. Recommended Tooling Stack

| Layer                            | Tool / Engine                               | Purpose                                           | Execution mode          |
| :------------------------------- | :------------------------------------------ | :------------------------------------------------ | :---------------------- |
| **SAST (Code)**                  | Semgrep OSS                                 | OWASP Top 10, React XSS, Node.js/Python risks     | CI + `factory security` |
| **Linting (Security)**           | `eslint-plugin-security`                    | Unsafe Node/JS constructs and ReDoS               | IDE + `lint` script     |
| **Type Safety**                  | `@typescript-eslint`                        | Prevent floating promises and unsafe `any` leaks  | `typecheck` / `lint`    |
| **Secret Scanning**              | Gitleaks                                    | Staged changes & git history secret scan          | Pre-commit + CI         |
| **Dependency Scanning**          | Dependabot + `npm audit --audit-level=high` | Dependency alerts & high/critical CVE PR gate     | GitHub CI               |
| **Workflow Safety**              | Actionlint                                  | `.github/workflows/*.yml` injection/syntax checks | CI + `factory security` |
| **SAST (Python)**                | `ruff` (`S` rule set)                       | Bandit-equivalent rules (`S101`..`S6xx`)          | CI + staged hook        |
| **Dependency Scanning (Python)** | `pip-audit`                                 | Locked Python dependency vulnerability scan       | CI + `factory security` |

Keep `npm audit --audit-level=high` (do not loosen on noise); if a transitive high CVE lacks an upstream fix, document a scoped override or `--omit=dev` (for dev-only paths) and file a follow-up ticket to remove the override.

---

## 3. Multi-Tenant Authorization & Data Isolation Rules

For multi-tenant applications:

1. **Explicit Tenant Scoping:** Server queries and mutations inspect authenticated session context and scope queries explicitly (`where: { userId }` / tenant org ID); ban unscoped `findMany` / `updateMany` / `deleteMany` outside audited admin seams.
2. **Strict Seam Restrictions:** Configure ESLint `no-restricted-imports` so application code cannot import test helpers or auth-bypass modules.
3. **Parser Isolation:** Sanitize and isolate untrusted spreadsheet, XML, PDF, and Markdown rendering pipelines.

---

## 4. Four-Tier Cross-Repository Architecture

| Tier                                 | Mechanism                                                                                                                             | Scope                           |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------ |
| **1. GitHub Reusable / Standard CI** | `.github/workflows/security.yml` running CodeQL (`ram: 8192`), Semgrep, Gitleaks, Actionlint                                          | PRs + deploy/integration pushes |
| **2. Language SAST / Lint Configs**  | JS/TS: `@watt-mind/eslint-config/security` (+ `/tenant-isolation`); Python: shared `ruff.toml` (`S` rules) + `pip-audit`              | IDE, `lint`, CI                 |
| **3. Local Security Runner**         | `factory security` (Semgrep `p/security-audit`, git-aware Gitleaks, Actionlint, Ruff, `pip-audit`)                                    | Pre-push parity with CI         |
| **4. Pre-commit Engine (Lefthook)**  | `lefthook.yml`: staged Gitleaks (`gitleaks git --pre-commit --staged`), staged Ruff `.py` (when `ruff.toml` present), commit-msg gate | Every local commit (<1s)        |

### Python `ruff.toml` & `pip-audit` notes

- Raw `ruff` `S` rules flag expected patterns in test fixtures (`S101` assert, `S105`/`S106`/`S107` literal test secrets, `S608` SQL helpers). Ignore those four rules strictly under `**/tests/**`, `**/tests_e2e/**`, `**/test_*.py`, and `conftest.py` — nowhere else.
- Adopt `ruff` (`S` rules) with `continue-on-error: true` initially when onboarding large legacy codebases so pre-existing findings get triaged without blocking unrelated PRs; promote to blocking once triaged.
- Use `uv sync && uv run --with pip-audit pip-audit --local` for `uv`-native projects, or `uvx pip-audit -r <lockfile> --python <ver>` for `pip` lockfiles.

### Gitleaks performance & allowlists

- Run `gitleaks git --pre-commit --staged` locally (git-aware; respects `.gitignore`) rather than raw `gitleaks dir` so ignored virtualenvs/caches are never crawled.
- Repo-specific path allowlists belong in repo-root `.gitleaks.toml`.

---

## 5. Rollout Checklist for Repositories

- [ ] Add `lefthook.yml` (staged Gitleaks + commit-msg check; staged Ruff if Python `ruff.toml` exists) or Husky + `lint-staged` + `commitlint`.
- [ ] Add `.github/workflows/security.yml` running CodeQL (`vars.CODEQL_ENABLED`, `ram: 8192`), Semgrep, Gitleaks, and Actionlint.
- [ ] **JS/TS:** Wire ESLint security rules + Prettier `format:check` + `tsc --noEmit` + `npm audit --audit-level=high` into `ci.yml`.
- [ ] **Python:** Add `ruff.toml` (`S` rules with test-directory calibration) + `pip-audit` step into `ci.yml`.
- [ ] Verify multi-tenant query scoping and `no-restricted-imports` seams (§3).
- [ ] Confirm `factory security` runs cleanly in the local checkout before pushing.

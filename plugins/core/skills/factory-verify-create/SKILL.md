---
name: factory-verify-create
description: 'Generate a project-local verification skill (.claude/skills/verify-<app>/) and feature map that launches, doctors, and drives the real app like a human user — web UI, API, CLI/TUI, mobile, or desktop. Use for /factory-verify-create, "make a verify skill for this repo", or when a repo has no scripted E2E control skill.'
disable-model-invocation: true
---

# Create a verification skill

Unit tests prove mocked components; `/factory-verify` needs a reliable way to boot the real app in an isolated worktree, log in, drive real user journeys, and verify persisted state. This skill inspects the repository once, writes `.claude/skills/verify-<app>/` + `features/*.md`, and proves the skill live before handing it off. Write every instruction for an agent reading it cold mid-PR.

## 1. Interview the repo, not the user

Answer from the repository first (`AGENTS.md`, `package.json`, `Makefile`, `bin/worktree-up.sh`, `bin/dev-login.sh`, Playwright/Cypress configs, Docker/compose files). Ask the user only what cannot be observed:

- **Surface:** Web UI, CLI/TUI, API service, desktop app, or mobile app? Name the primary user surface and any secondary ones.
- **Launch & isolation:** How does an isolated worktree start? Prefer `bin/worktree-up.sh` and per-worktree ports/DBs when present, otherwise package dev scripts from a disposable data dir with migrations and seed data. Specify the real readiness signal (app + DB/migrations usable, not just process spawn).
- **Auth:** How does a verifier get an authenticated session (`bin/dev-login.sh [role]`, seeded dev user, API test token) without editing auth code?
- **Drive:** Prefer the repo's existing test harnesses or scripts if present, paired with the active harness's default browser/runtime driver (`chrome-devtools` MCP, `chrome_devtools_*`, Playwright, PTY/tmux, or HTTP client). Use stable handles (ARIA roles, accessible labels, data-testid, route paths, CLI commands), never pixel coordinates.
- **Observe:** What proves success end-to-end? UI ARIA snapshots + bounded screenshots, console/network zero-error checks, reload persistence, response bodies, exit codes, DB/file side effects.
- **Isolate:** Can two worktrees run side-by-side cleanly? If a shared port, file lock, or singleton resource forbids concurrent runs, document that refusal rule explicitly.

If the current trunk checkout fails to build or boot, fix or report the exact failure before generating a verify skill on top of broken startup steps.

## 2. Generate `.claude/skills/verify-<app>/SKILL.md`

Create `.claude/skills/verify-<app>/SKILL.md` with YAML frontmatter (`name: verify-<app>` and a concrete `description` naming the app, surface, and trigger) and these grounded sections (zero placeholders):

- **`## Launch`:** Exact command to boot from a clean/seeded worktree state (migrations + seed + server/build), observable readiness gate (polling health/UI condition, never `sleep N`), and per-worktree port/env vars.
- **`## Doctor`:** One fast read-only command/sequence answering _"is this instance healthy, on the right branch/port, seeded, and authenticated?"_ Run before the first drive and after any failed drive.
- **`## Drive`:** Concrete driving conventions using the active harness's default browser/CLI driver against real routes, ARIA controls, and `bin/dev-login.sh` — never internal test-only setters or raw DB shortcuts to fake a UI flow.
- **`## Evidence`:** Where proof artifacts live outside the repo (`$FACTORY_ARTIFACT_DIR`, `$TMPDIR/verify-<app>-*`), what every PR proof needs (happy path + edge/error case, `0` uncaught console/`5xx` errors, persisted state across reload/second read, 1–4 bounded screenshots `≤ 1 MB`), and explicit rules for checking dry-run side effects.
- **`## Cleanup`:** Exact teardown tracking only PIDs/ports/temp dirs started by the verification run (never `pkill` shared processes) while keeping proof artifacts intact.
- **`## Helpers`:** Any wrapper scripts placed under `.claude/skills/verify-<app>/scripts/` must be executable (`chmod +x`), smoke-tested, and documented with literal invocation examples.

## 3. Seed the feature map

Create `.claude/skills/verify-<app>/features/README.md` plus **3–5** high-value user feature files (`features/<feature-slug>.md`) matching [`references/feature-map-example/`](references/feature-map-example/):

- `features/README.md` states baseline preconditions, driving conventions, proof standards, and the index linking each `features/<slug>.md`.
- Each `features/<slug>.md` uses an H1, one user-POV summary paragraph, and **exact four H2 sections**:
  1. `## Sub-features`
  2. `## How to get to it (user POV)`
  3. `## Driving it with <harness>` (starting with `Preconditions:`, concrete user actions + expected observable state)
  4. `## Gotchas`

Keep source implementation internals out of `features/`; document only user paths, stable handles, preconditions, commands, and observable results. Missing seed preconditions fail honestly in `Gotchas` rather than weakening the flow.

## 4. Prove the generated skill live before handing off

Execute the generated skill end-to-end once before finishing:

1. Run **Launch** + **Doctor**.
2. Drive **at least one** mapped feature in `features/*.md` end-to-end with the default harness browser/CLI tools.
3. Capture proof artifacts outside the repo.
4. Run **Cleanup**, then verify both that the temporary server/processes exited **and** that the proof artifacts survived at their named path.

Fix any startup, selector, auth, or cleanup defect found during this dry run; never leave an untested draft skill behind. Note any stand-in limitations honestly (e.g., local seeded DB vs. remote integration).

## 5. Hand off

Summarize the created `.claude/skills/verify-<app>/` files, what feature was proven live, what proof artifacts were produced, and point to **`/factory-verify`** (daily PR/branch verification) and **`/factory-verify-maintain`** (keeping the feature map aligned as the app evolves).

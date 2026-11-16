# <App> verification map

This directory is the maintained source for verifying user-facing behavior in `<App>`. Read the index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Start `<App>` in an isolated worktree (`bin/worktree-up.sh <ISSUE-ID>` or disposable port/data dir) so concurrent runs never share state.
- Apply migrations and seed baseline test fixtures before running `Doctor`.
- Authenticate via `bin/dev-login.sh` (or documented seeded test user).
- Run the skill's `Doctor` check and confirm the target URL, worktree port, and health status match before driving.
- Never drive an instance started by another run.

## Driving conventions

- Start each recipe from baseline state unless its preconditions state otherwise.
- Prefer ARIA roles, accessible names, labels, and real routes over fragile CSS selectors or pixel coordinates.
- Drive through the active harness's default browser or CLI driver; treat literal routes and flags as contracts.
- Restore mutated fixtures (or isolate per run) during cleanup without removing proof artifacts.

## Proof and skip reporting

- Prove both the action and the resulting state (after reload or secondary read), not just the initial form or a toast.
- Web UI proof requires zero uncaught console errors, zero unexpected `4xx`/`5xx` responses, ARIA snapshot verification, and 1–4 bounded screenshots (`≤ 1 MB`) stored outside the repository.
- CLI/API proof includes the exact command, exit code, and response/output evidence.
- Report unreachable paths honestly with the unmet precondition and attempted route; never mark a skipped path as passed via another path.

## Feature entry contract

Each file under `features/<slug>.md` starts with an H1 title and one summary paragraph, followed by four H2 sections in this exact order:

1. `## Sub-features` — short bullet IDs naming observable behaviors.
2. `## How to get to it (user POV)` — user entry points (navigation links, buttons, shortcuts, CLI commands).
3. `## Driving it with <harness>` — starts with `Preconditions:`, then concrete labeled steps pairing user actions with observable results.
4. `## Gotchas` — timing, validation, auth, or fixture traps that invalidate runs.

## Features

- [Create a note](./create-note.md) — covers browser and CLI creation, validation/cancel handling, reload persistence, and cleanup.

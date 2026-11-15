Pick **one** next step in the factory loop for the current repository — two explicit modes: read-only diagnostic mode without `--apply`, and autonomous AFK execution mode with `--apply`.

The mechanical routing lives in `factory next`, which reads the same queue snapshot as `factory queue`. Do not re-derive gates from Linear yourself.

## 1. Resolve repo

Default: match the current working directory against `config/repos.yaml`. `$ARGUMENTS` may name a repo (`bj29`) or pass flags (`--apply`, `--orchestrated`, `--include-sweep`, `--harness pi`).

## 2. Diagnose

From the factory checkout (or any cwd with `factory` on PATH):

```bash
factory state --repo <repo>
factory next --repo <repo> $ARGUMENTS
```

Show **session history** from `factory state` (what ran earlier in this harness window), then **constraint**, **recommend**, **because**, and any **also** alternates from `factory next`. Both record events to `~/.factory/state/events.jsonl` — `recommend` on every next run, `start` on `--apply`.

If `budgetBlocked` is set, stop — no new agent stages today.

## 3. Mode selection (`--apply` vs. diagnostic)

- **Without `--apply` (read-only diagnostic mode):** report the diagnosis and print the exact commands to execute next (`factory next --repo <repo> --apply` for one bounded stage, or `bun run supervise` for continuous loop execution), then stop cleanly. Never end with an interactive `"Would you like me to run this?"` prompt — assume the operator may be AFK or scripting.
- **With `--apply` (autonomous AFK mode):** immediately execute **one bounded stage** to completion without pausing for confirmation, then stop. Do not loop until idle — that is the supervisor's job, not `/factory-next`.
  - If the recommendation is a slash command (`/factory-merge`, `/factory-triage`, `/factory-work`, …), run **that command's skill/body** in this session — one pass, default caps (`5` triage, `3 at a time` work, `10` unblock).
  - If `--orchestrated` is present and the recommendation is `tick` or `reconcile`, run the printed `exec` line instead.
  - If the recommendation is `(wait)` with no command, report why and do not spawn work.

Alternatively, delegate `--apply` execution directly to the script:

```bash
factory next --repo <repo> --apply [--orchestrated] [--harness <harness>] $OTHER_FLAGS
```

Use the script path when running headless via `run-agent.sh`; use the slash command path when you are already in an interactive harness.

## 4. Report

State what ran (or what was recommended), the queue constraint in one line, and anything waiting on a human (blocked holds — suggest `factory digest --repo <repo>`).

Record the outcome:

```bash
factory state record --type complete --repo <repo> --command <stage> --summary "<one line>"
```

**Session friction:** when `FACTORY_RUN_ID` is unset, scan the session per `/factory-friction` and note items filed or **none observed**. If any were filed:

```bash
factory state record --type friction --repo <repo> --issues "OPS-123"
```

## Priority (for transparency — the script encodes this)

1. Held tickets with replies → triage
2. Open mergeable PRs on GitHub → merge
3. Free dispatch slots + startable tickets → work (or `tick.mjs` when orchestrated)
4. Triage / Todo-not-ready backlog → triage
5. Orphaned claims → reconcile (alternate)
6. Holds without answers → digest / unblock (alternate)
7. Main loop idle + `--include-sweep` → sweep

Retro, garden, ship, audit, and friction capture are **not** auto-selected — run those on cadence or explicitly.

# Friction log

Things that repeatedly cost the factory time, and what was done about them.

**This list should shrink.** An entry is not a note to remember — it is an open defect in the harness. When it is fixed, the entry stays with status `fixed` so nobody re-discovers it and re-proposes the same thing.

**Rejections are recorded too**, with the reason. A log of only open items invites the same suggestion every month.

Evidence comes from `bun orchestrator/friction.mjs`, which reads the JSONL transcripts orchestrator runs write to `~/.factory/logs/`. Interactive harness sessions (no `FACTORY_RUN_ID`) capture friction via `/factory-friction` into Linear — usually `Triage`/`FIP:` items with a `## Session friction` block. Curation happens in `/factory-retro`, which merges transcript repeats with those session filings.

## How to add an entry

Only two things qualify: a failure shape seen in **more than one run** (transcript or session filing), or a cost paid **per ticket that could be paid once**. One-offs don't belong here — a rule everyone must read forever is a real cost, and it should buy more than one saved minute.

Prefer removing the need over documenting the workaround. An env var or a script default beats a rule an agent has to remember.

**Session friction** (`/factory-friction`): file to Linear `Triage` when observed; promote to this log only after `/factory-retro` confirms it is a repeat or a per-ticket sink worth fixing.

---

## Open

### F-8 · Agents `sleep` to wait for CI instead of watching it

**Seen:** `sleep 150; gh pr checks 166`, `sleep 180; echo done`, `sleep 60; echo done` across multiple runs. Still ×20 in the 697-run window (Aug 2026 retro) — includes runs from before the harness block landed; watch the next window.

A fixed sleep is a guess: too long wastes wall clock in a process holding a concurrency slot, too short means a re-poll. Select the pushed SHA's CI workflow with `gh run list --workflow ci.yml --commit <sha>`, wait with `gh run watch <run-id> --exit-status --interval 60`, and assert every check run is green via the REST check-runs endpoint.

**Fix:** rule added to `shared/floor.md` (§Waiting). The REST workflow selector and `gh run watch --exit-status --interval 60` avoid the shared GraphQL budget. factory-ticket.md documents that sleep-polling is blocked by the harness (a blocked tool call kills the run).

**Status:** fixed in the floor + harness block — if sleeps persist in _new_ transcripts after Aug 2026, the next step is a `scripts/wait-for-ci.sh` wrapper agents must call.

### F-9 · Fixed sleeps waiting for dev servers to boot

**Seen:** `wasp start ... & sleep 60; tail log`, `astro dev & sleep 12; cat log`, `sleep 75; tail`.

Same shape as F-8 but for local processes, and the guess is worse: boot time varies with whether the worktree was warm-cloned or compiled from scratch.

**Fix:** bounded readiness poll (`for i in $(seq 60); do curl -sf ... && break; sleep 2; done`) documented alongside F-8. A repo-level `bin/wait-for-dev.sh` would be the stronger fix — a default rather than a rule — if this keeps recurring.

**Status:** open — document-only so far.

### F-10 · A harness timeout is not a slot guarantee

**Seen:** agy triage, `status: ERROR / "timeout waiting for response"` at 231s — its 5-minute print default, 68 tool calls in, cut off mid-summary. Work completed; report lost.

Raising `--print-timeout` alone would trade a short hang for a long one: a wedged run holds its slot for whatever the new timeout is. Two different jobs — the harness timeout should error _cleanly_, the factory timeout should _guarantee the slot frees_.

**Fix:** `limits.max_run_minutes` (45) in `policy.yaml`, enforced with `timeout -k 30s` in both `run-agent.sh` and `tick.mjs`; the harness timeout is set two minutes below it so it reports first. **Status: fixed.**

### F-11 · Orphaned agent Chrome blocks the shared profile

**Seen:** `browser is already running for .../chrome-profile` — ×43 `list_pages`, ×35 `new_page`, ×17 `navigate_page` across 20+ runs (friction.mjs, Aug 2026). Killed runs leave Chrome reparented to launchd; SingletonLock blocks every later session using the legacy shared profile.

**Fix:** `orchestrator/chrome-sweep.mjs` existed but was manual-only. Wired into `tick.mjs` to run `--apply` before each dispatch pass (Aug 2026 retro).

**Status:** fixed — watch whether profile-lock errors drop in the next friction window.

### F-12 · Agents use the schpet `linear` CLI instead of `tools/linear.mjs`

**Seen:** `linear issue comment CLNT-526 --body` (×23, wrong syntax — needs `comment add`), `linear issue query ...` (×28, filter type errors), plus ×18 Linear MCP `list_issues` validation failures.

**Fix:** expanded §Linear in `shared/floor.md` to explicitly reject both the MCP and the standalone `linear` CLI, with the common failure shapes named.

**Status:** fixed in floor — if failures persist, next step is blocking `linear` in agent shell allowlists.

### F-13 · legalease CI workflow repeat failures

**Seen:** ci.mjs — legalease / CI ×25 failures in 14d, ↑152% slower (median ~7.8min). Recent sample: e2e `test_create_person_appears_in_list` timeout on `table` selector (run 31330944885).

**Fix:** filed [CLNT-1345](https://linear.app/watt-mind/issue/CLNT-1345) — product-repo fix in workflow/tests.

**Status:** filed, Triage.

### F-14 · bj29 E2E / smoke CI repeat failures

**Seen:** ci.mjs — bj29 / E2E ×18 failures (↑29% slower), Smoke Verification ×13 (↑251% slower).

**Fix:** filed [CLNT-1346](https://linear.app/watt-mind/issue/CLNT-1346).

**Status:** filed, Triage.

---

## Fixed

### F-1 · zsh glob-expands unquoted `--include=*.ts` — `fixed` (OPS-41)

`(eval):1: no matches found: --include=*.ts` — zsh expands `*.ts` against the current directory and errors when nothing matches, killing the command before grep runs. Fixed as a floor rule (§Shell globs): quote glob arguments. The preferred fix — `NO_NOMATCH` for agent shells — isn't reachable from the runner: it's a zsh `setopt`, not an environment variable, and the harness's Bash tool starts shells from the user's own profile. If unquoted globs persist in transcripts, the next step is setting it in `~/.zshenv`.

### F-2 · `gh pr merge --delete-branch` fails while the worktree exists — `fixed` (OPS-41)

Git refuses to delete a branch checked out in a worktree, so the flag failed on every worktree-based merge. `factory-merge.md` now orders cleanup explicitly: worktree-down first, then delete the branch, and says not to use `--delete-branch`.

### F-3 · Non-canonical Linear labels are attempted — `fixed` (OPS-41)

`Could not resolve label(s): "type:chore"`. The eight canonical `type:*` values are now in `shared/floor.md` (§Linear labels), where every harness sees them.

### F-4 · Stale warm cache made every worktree pay a full compile — `fixed`

Template 99 commits behind turned worktree setup into ~3 min each; three tickets meant ~9 minutes before any code was written. Now `tick.mjs` checks staleness after claiming and refreshes once when it pays (2+ tickets, ≥15 commits behind). See [architecture §2.6](architecture.md).

### F-5 · `ANTHROPIC_API_KEY` silently billed the API and disabled connectors — `fixed`

Runs were billed per token instead of drawing on the subscription, and claude.ai connectors — including the Linear MCP — were disabled without anyone noticing. `run-agent.sh` and `tick.mjs` now unset it for the child; `--use-api` opts in deliberately.

### F-6 · Unknown slash commands reported success — `fixed`

`subtype:"success"` with `num_turns:0` and `result:"Unknown command"` was treated as ok. Success detection now requires turns > 0 and no unknown-command reply, and names the fix. The underlying cause — commands never installed into the repo — is handled by `bun build/emit.mjs --link-repos`.

### F-7 · `Owned Paths` in fenced code blocks parsed as empty — `fixed`

A correctly specced ticket was undispatchable because the parser only read bullet lists. It now accepts bullets, fenced blocks and indented code. This one is worth remembering as a _shape_: a strict parser silently turning good input into no input looks like an upstream failure, not a parser bug.

---

## Rejected

### R-1 · Per-ticket `claude` processes should run on separate machines

Considered during the cloud/local split. Rejected for now: the binding constraint is the subscription usage window, which is per-account and does not improve by spreading across machines. Revisit only if wall-clock CPU contention — not tokens — becomes the limit.

### R-2 · Automatically pull the main checkout before triage

Rejected. The main checkout routinely holds uncommitted human work; rebasing under someone to save a slightly stale spec is a far worse trade. The runner fetches and reports `behind`/`uncommitted` instead, and leaves the decision to a human.

### R-3 · Screenshot context burn needs a harness block

Rejected for now (Aug 2026 retro). `take_screenshot` dominates context re-sent (576× payload vs 7× for `take_snapshot`), but the floor already mandates snapshot-first and the factory MCP config serves capped webp. Blocking screenshots entirely would break legitimate visual QA. Revisit if screenshot calls don't drop after chrome-sweep reduces retry loops.

### R-4 · coach-wattz Build and Deploy ↑310% slower

Rejected as a factory FIP (Aug 2026 retro). Real trend (median 9.2min, ×5 failures), but coach-wattz is `report_only` in repos.yaml — no agent dispatch, no factory-merge wait time. Belongs in CW team's own CI triage when they next touch deploy, not OPS.

### R-5 · cashsaas CI ×13 repeat failures

Rejected as immediate factory action (Aug 2026 retro). Repeat failures are real but cashsaas has its own workflow; file a CLNT ticket only when an agent is actively dispatching there and merge is blocked. Not filed this retro — lower dispatch volume than legalease/bj29.

# factory-garden

> Scan a repo for spreading anti-patterns and suppressions; enforce root-cause fixes with deterministic checks and weed-removal PRs

Tend a repository like a garden: find anti-patterns that are actively spreading, remove bad exemplars at the source, and replace decaying prose warnings with **deterministic** checks whose error messages teach the root-cause fix.

Coding agents replicate whatever patterns already live in the tree. One unjustified `eslint-disable`, `as any`, `setTimeout(..., 0)` race bandaid, `HACK` workaround alibi, or bypassed adapter quickly becomes ten across subsequent PRs, while prose warnings in `AGENTS.md` go unread under context pressure.

**The operator is AFK by default.** Execute bounded gardening work to completion without pausing for mid-run confirmation prompts. Default target is the current repository (resolved from `config/repos.yaml`). Interpret `$ARGUMENTS` as an optional repo path or name, an area/glob filter, `--since 14d` (default window: `14d` or the last `30` merged PRs), `--report-only`, `--tickets-only`, or an explicit direct-PR cap (default: at most **2** PRs per run).

## 1. Establish fresh baseline (read-only on main checkout)

Enforce the floor's **Checkout freshness** rule before reading a single file as evidence:

```bash
git fetch --quiet
git rev-list --count HEAD..origin/<base>
git rev-list --count origin/<base>..HEAD
git status --porcelain
```

- Resolve `<base>` from `config/repos.yaml` (never `@{upstream}` or GitHub's default branch).
- Fail closed if `git fetch` or `git rev-list` exits non-zero: report freshness as **unknown** and read `origin/<base>` directly rather than trusting the working tree.
- Fast-forward (`git pull --ff-only`) _only_ when the checkout is behind, not ahead, and clean. If dirty or ahead, leave the checkout untouched and inspect `origin/<base>` directly (`git log origin/<base>`, `git grep <pattern> origin/<base>`, `git show origin/<base>:<path>`).
- Record `origin/<base>@<sha>` — every finding in your report and filed tickets must cite that ref. Never edit files inside the main checkout.

## 2. Survey for weeds (evidence over aesthetics)

Scan two evidence streams on `origin/<base>` (scoped to any area/glob passed in `$ARGUMENTS`):

1. **Recent merged PR churn & review-fix commits** (`git log --since=<window> origin/<base>`, `gh pr list --state merged --base <base> --limit 30`):
   - Repeated review-fix commits, post-merge hotfixes, or reverts pointing to the same mistake shape.
   - Newly landed suppressions, timer bandaids, or boundary shortcuts that later commits have already begun copying.
2. **Live codebase entropy:**
   - **Suppression & escape-hatch creep:** unjustified `eslint-disable`, `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, `as any`, `as unknown as`, skipped tests (`.skip` / `todo` without an open ticket reference), and `--max-warnings` ratchet creep.
   - **Imperative timer & lifecycle bandaids:** `setTimeout(..., 0)` or `requestAnimationFrame` used to mask state, ordering, or readiness races instead of deterministic event or state synchronization.
   - **Cargo-culted alibis & swallowed errors:** `HACK` / `workaround` alibi comments copied across files and empty `catch {}` blocks that silently discard boundary errors.
   - **Architectural & chokepoint leaks:** callers bypassing canonical adapters (`lib/control-plane/`, `factory ticket`, forge wrappers), direct ambient home/env reads that break sandbox hermeticity, or circular imports.

**Pragmatic triage bar:**

- Act _only_ on repeats or active spread (**2+ occurrences**, or a fresh bad exemplar already copied across PRs) and hard architectural/safety boundary violations.
- Ignore legitimate one-off boundary exceptions that already cite their external constraint inline, as well as purely aesthetic style preferences.
- Deduplicate every candidate against open tracker issues via `factory ticket` search before acting — update existing tickets with fresh `origin/<base>@<sha>` evidence rather than filing duplicates.

## 3. Choose the right mechanism (pragmatic judgment)

Rank interventions from strongest to weakest, and pick the highest layer that fits:

1. **Delete or refactor the bad exemplar + tighten types/ratchets** — remove the copy-paste source from the tree and tighten types or lower `--max-warnings` so regressions fail compilation or lint immediately.
2. **Deterministic lint or AST rule** (`eslint.config.*`, `no-restricted-syntax`, `no-restricted-imports`) — catch the pattern at edit and lint time in milliseconds.
3. **Fast structural or invariant test in `verify`** — enforce cross-file adapter boundaries, hermeticity invariants, or ratcheted counts inside the fast verification suite.
4. **Targeted `AGENTS.md` note** — last resort, _only_ when the invariant is genuinely semantic and cannot be enforced mechanically.

**Guardrail quality bar:**

- **Near-zero false positive behavior:** test every proposed lint rule or invariant check against all of `origin/<base>` before keeping it. Discard or narrow any noisy check that flags legitimate code — a rule with a high **false positive** rate trains agents to add `eslint-disable`, making the garden worse.
- **Actionable root-cause error messages:** every rule message and invariant assertion failure must state _why_ the construct fails and point directly to _the clean replacement exemplar or helper_ so an agent fixes the root cause on the first attempt.
- **Ratchet legacy debt:** when a high-value rule hits **10+ legacy occurrences**, do not abandon the rule and do not attempt a risky mega-refactor PR. Land the rule immediately with an explicit file allowlist or monotonic count ratchet so zero new weeds can enter, and file bounded `Todo` + `ai:agent-ready` burndown tickets per area.

## 4. Execute autonomously (AFK-by-default, control-plane compliant)

If `--report-only` is set in `$ARGUMENTS`, skip all tracker mutations and PRs and proceed straight to §5.

Otherwise, execute to completion without confirmation pauses:

### A. Direct weed-removal & guardrail PRs (up to PR cap, default 2)

Skip this phase when `--tickets-only` is passed or when the repository sets `report_only: true` in `config/repos.yaml`. For up to **2** small, mechanical, high-leverage fixes whose touched paths stay strictly outside `escalate_paths` and `Never auto-merge` surfaces (auth/authz, payments, secrets, destructive DB migrations, production infra):

1. **File and claim the ticket** via `factory ticket` (`source:agent`, `type:maintenance`, matching `area:*`, appropriate `tier:*`, and the full `docs/protocol.md` §5 five-section template with one repo-relative path or glob per bullet in `Owned Paths`). Claim it (`In Progress` + `ai:in-progress`) and re-read the assignee before coding.
2. **Isolate in a worktree** via `bin/worktree-up.sh <ISSUE-ID>` (where the repo provides it, otherwise a dedicated worktree branched from `origin/<base>`). Never use `git stash` or `--autostash`.
3. **Prove falsifiability first:** run the new deterministic rule or invariant test against the unfixed weed (or, if the fix is already committed at `HEAD`, temporarily restore the pre-fix weed via `git show origin/<base>:<path> > <path>` and restore with `git checkout HEAD -- <path>`) and observe it fail with the expected teaching message before applying the fix or ratchet.
4. **Fix and verify:** apply the root-cause fix or legacy ratchet strictly within `Owned Paths`, then pass both the ticket's exact `Verification Command` and the repo's `verify` command. Never weaken a test or check to get green.
5. **Open the PR against the configured base:** push the branch and run `gh pr create --base <configured-base> --title "..." --body "Fixes <ISSUE-ID>"` (when `$FACTORY_RUN_ID` is set, append the concrete trailer with `printf 'run:%s\n' "$FACTORY_RUN_ID"` — never write a literal unexpanded variable; read back `baseRefName` to verify). If waiting on CI, select the workflow run with `gh run list --workflow ci.yml --commit <sha> --json databaseId --limit 1` and block via `gh run watch <run-id> --exit-status --interval 60`.
6. **Handoff cleanly:** post the mandatory structured `## Handoff` comment on the ticket (`PR`, `Verification`, `UX critique: skipped — mechanical lint/invariant guardrail`, `Files`, `Risks`), then move the ticket to `In Review` + `ai:needs-review` and remove `ai:in-progress`. Never self-merge; `/factory-merge` owns review and landing.

### B. Queue remaining and larger weeds

File every remaining validated weed (including legacy ratchet burndown slices, larger refactors, and all findings when `--tickets-only` or `report_only: true` applies) as deduplicated issues via `factory ticket` (`source:agent`, `type:maintenance`, matching `area:*`, and `tier:*`):

- Write unambiguous mechanical items to the full §5 template and set `Todo` + `ai:agent-ready` so `/factory-work` can dispatch them directly.
- Place an item in `Triage` _only_ when genuine unrecorded architectural or product intent must be settled before specifying `Owned Paths` and acceptance criteria.

## 5. Report & session friction

Output a concise summary table for the run:

| Weed shape | Spread & ref (`origin/<base>@<sha>`) | Action taken | Deterministic check added |
| :--------- | :----------------------------------- | :----------- | :------------------------ |

Follow the table with one line naming any candidates deliberately skipped (one-offs, valid cited boundary exceptions, or rules discarded for false-positive noise).

**Capture session friction (interactive runs only):** skip when `FACTORY_RUN_ID` is set. When unset, scan the session for harness friction per `/factory-friction` and report filed issue IDs or **none observed**.

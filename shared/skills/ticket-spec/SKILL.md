---
name: ticket-spec
description: Turn a raw Linear Triage ticket into a fully specified ai:agent-ready one by exploring the codebase. Use when specifying, refining, or promoting tickets, or when asked why a ticket isn't dispatchable.
---

# Specifying a ticket

A ticket is dispatchable only when it carries all five sections (`docs/protocol.md` §5). Most of that is **derivable from the codebase, not from the human**: `Source File Pointers`, `Owned Paths`, and `Verification Command` are search-and-read problems. `Acceptance Criteria` is usually the problem restated observably. Only genuine product intent needs a person.

So the job is not "spec everything" — it's **sorting tickets into three piles** and handling the first two yourself.

## The three outcomes

**Auto-specifiable** — the problem is unambiguous and the answer is in the code. Explore read-only, write all five sections, promote to `Todo` + `ai:agent-ready`.

**Answerable from written decisions** — intent is unclear but already recorded: the repo's `docs/product-decisions.md`, `docs/`, the Linear project Overview, or a prior ticket in the same area. Resolve it, **cite where you found it** in the ticket so the next agent doesn't re-litigate, then promote.

**Genuinely needs a human** — a real product decision, a missing credential, a priority call. Leave in `Triage`, comment the specific question phrased so one reply unblocks it, and batch every such question into a single notification at the end of the run. Never a ping per ticket.

## Rules that keep this honest

**A promoted ticket must be falsifiable.** Before promoting, confirm every file in `Source File Pointers` exists and **run the `Verification Command`**. A spec that looks complete but whose command doesn't run is worse than leaving the ticket in `Triage` — it burns a full agent run to discover, and the agent that discovers it has already created a worktree and a database.

It is fine for the verification command to _fail_ — that's the bug. It must not _error_: a wrong path, a missing script, a task name that doesn't exist.

**`Owned Paths` is the concurrency key, so tight globs beat convenient ones.** It is the set the ticket may modify, and the dispatcher refuses to run two tickets whose sets intersect. `app/**` blocks every other ticket in the repo; `app/services/api.ts` + `app/services/__tests__/*` blocks almost nothing. Over-broad paths don't just risk scope creep — they serialize the factory.

Include the test files and the docs the change will touch. A path the agent needs but doesn't own means it stops and blocks.

**Generated outputs must be owned with their source.** When a source path has generated copies, every ticket that may edit that source must include those generated outputs in `Owned Paths`; otherwise verification can require changes the implementing agent is forbidden to make. In this repo, owning any path under `shared/` therefore also requires owning `dist/**` and `plugins/core/**`, because `bun build/emit.mjs --check` verifies both generated trees. Apply the same rule to any other source-to-generated-output relationship you discover while specifying a ticket.

WM-289 is the worked failure: its spec owned `shared/` but omitted `dist/AGENTS.floor.md`. The agent correctly edited the source, then had to block because regenerating the stale emitted copy would have exceeded its Owned Paths. The correct spec would have included the relevant `shared/**` source plus `dist/**` and `plugins/core/**`, allowing `bun build/emit.mjs` and the declared verification to complete in scope.

**Owned Paths orders nothing — `blocked by` relations do.** Disjoint paths only mean two tickets can run _simultaneously_; if one consumes the other's output (a helper it adds, a migration it lands), they must not, and the dispatcher can't see that from globs. Set the Linear `blocked by` relation when you spec a ticket that builds on an open one — dispatch holds it until the blocker is `Done`/`Canceled` and releases it automatically. A spec whose hidden prerequisite is only mentioned in prose will dispatch anyway and burn the run.

**Never promote what you couldn't verify against the actual codebase.** If exploration didn't find the code, that's a hold, not a guess.

**Don't spec the whole backlog.** Queue depth is the throttle: keep roughly 20 tickets dispatchable and spend the remaining effort on the highest-priority `Triage` items. Most of a deep backlog will be closed, deduped, or overtaken before anyone works it. Measure **queue-hours remaining**, not ticket count — that's the number that says whether the factory is about to idle.

## Before writing anything

Check the ticket isn't already solved: duplicate of an open issue, fixed in git history, or obsolete. Say which, with evidence, and close or link it. Cheaper than a perfect spec for work nobody needs.

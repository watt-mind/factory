---
name: ticket-spec
description: Turn a raw Linear Triage ticket into a fully specified ai:agent-ready one by exploring the codebase. Use when specifying, refining, or promoting tickets, or when asked why a ticket isn't dispatchable.
---

# Specifying a ticket

A ticket is dispatchable only when it carries all five sections (linear.md §5). Most of that is **derivable from the codebase, not from the human**: `Source File Pointers`, `Owned Paths`, and `Verification Command` are search-and-read problems. `Acceptance Criteria` is usually the problem restated observably. Only genuine product intent needs a person.

So the job is not "spec everything" — it's **sorting tickets into three piles** and handling the first two yourself.

## The three outcomes

**Auto-specifiable** — the problem is unambiguous and the answer is in the code. Explore read-only, write all five sections, promote to `Todo` + `ai:agent-ready`.

**Answerable from written decisions** — intent is unclear but already recorded: the repo's `docs/product-decisions.md`, `docs/`, the Linear project Overview, or a prior ticket in the same area. Resolve it, **cite where you found it** in the ticket so the next agent doesn't re-litigate, then promote.

**Genuinely needs a human** — a real product decision, a missing credential, a priority call. Leave in `Triage`, comment the specific question phrased so one reply unblocks it, and batch every such question into a single notification at the end of the run. Never a ping per ticket.

## Rules that keep this honest

**A promoted ticket must be falsifiable.** Before promoting, confirm every file in `Source File Pointers` exists and **run the `Verification Command`**. A spec that looks complete but whose command doesn't run is worse than leaving the ticket in `Triage` — it burns a full agent run to discover, and the agent that discovers it has already created a worktree and a database.

It is fine for the verification command to *fail* — that's the bug. It must not *error*: a wrong path, a missing script, a task name that doesn't exist.

**`Owned Paths` is the concurrency key, so tight globs beat convenient ones.** It is the set the ticket may modify, and the dispatcher refuses to run two tickets whose sets intersect. `app/**` blocks every other ticket in the repo; `app/services/api.ts` + `app/services/__tests__/*` blocks almost nothing. Over-broad paths don't just risk scope creep — they serialize the factory.

Include the test files and the docs the change will touch. A path the agent needs but doesn't own means it stops and blocks.

**Never promote what you couldn't verify against the actual codebase.** If exploration didn't find the code, that's a hold, not a guess.

**Don't spec the whole backlog.** Queue depth is the throttle: keep roughly 20 tickets dispatchable and spend the remaining effort on the highest-priority `Triage` items. Most of a deep backlog will be closed, deduped, or overtaken before anyone works it. Measure **queue-hours remaining**, not ticket count — that's the number that says whether the factory is about to idle.

## Before writing anything

Check the ticket isn't already solved: duplicate of an open issue, fixed in git history, or obsolete. Say which, with evidence, and close or link it. Cheaper than a perfect spec for work nobody needs.

---
description: Find open Linear issues for this repo and triage them toward agent-ready
argument-hint: [optional: issue IDs, "all" for workspace-wide, or a max count]
model: sonnet
---

Triage the open Linear issues for the repository I'm currently in: turn raw `Triage` tickets into fully specified, agent-dispatchable ones where possible.

Resolve the team from the repo via `config/repos.yaml` (`docs/protocol.md` §1). Use `factory linear`; on failure retry once then fall back to `factory linear raw` per the floor. Interpret $ARGUMENTS as specific issue IDs, a max count, or "all" (workspace-wide); default is this repo's team, up to 10 issues.

## Claim what you are triaging

Before working an issue, mark it so it appears in **Agents In Flight** and no other agent picks it up: set `assignee` to yourself and add `ai:in-progress` + `agent:<your-harness>`. **Leave the state alone** — a ticket being specified is still `Triage`; `In Progress` means implementation is underway and would misrepresent it.

**Remove `ai:in-progress` when you finish that issue**, whether you promoted it, held it, or closed it. A claim marker left behind makes a finished ticket look live forever. (The reaper clears stale ones after 45 minutes of silence, but relying on that means a lost 45 minutes.)

Claim one issue at a time as you get to it, not all of them up front — a batch claimed and then abandoned blocks the queue for everything you never reached.

**Answered holds come first.** Before the Triage pile, check for tickets carrying `ai:blocked` (in `Blocked` or `Triage`) that have a comment newer than the label's application — the orchestrator's gate resurfaces exactly these, and a human answer that sits unread costs a round-trip through the slowest part of the pipeline. For each: read the reply, **remove `ai:blocked`**, then re-run promote-or-hold below with the answer in hand (and record the decision in the product-decisions doc where it belongs). If the reply doesn't actually resolve the hold, comment a sharper question and **re-add `ai:blocked`** — removing and re-adding is required, not optional: the fresh label event is what resets the orchestrator's reply detection, and a hold that keeps the old label event gets re-examined every tick forever.

For each issue in `Triage` state, plus any `Todo` issue that is missing the `ai:agent-ready` label **or carries it without actually satisfying §5** (see step 0 below):

0. **Run the mechanical template guard first, don't re-derive it by hand.** `factory label-guard --repo <this repo> --apply` checks every `Todo` + `ai:agent-ready` ticket in scope for the two §5 sections that are mechanically load-bearing — `Owned Paths` (what dispatch's collision check reads) and `Verification Command`/an evidence line (what "done" runs) — and demotes anything failing straight to `Triage` with a comment, no LLM judgment needed for that part. Run it before working the `Triage` pile so those demotions are already in it. It deliberately does **not** check `Problem & Context` / `Acceptance Criteria` / `Source File Pointers` — those vary too much in legitimate format to check safely by regex (an early version did, and flagged an Urgent, fully-actionable ticket as broken). So still use judgment on anything that looks off in those three sections as you work a ticket normally — the guard catches the mechanical case (a ticket like CLNT-871/872, built from a 4-section support-ticket format rather than the §5 template), not spec-quality judgment calls.
1. **Sanity check** — is it a duplicate of an existing issue, already fixed in the codebase or git history, or obsolete? If so, say which and mark it (duplicate → link + cancel, fixed → comment with evidence + close). Check "already fixed" against `origin/<base>`, per the floor's **Checkout freshness** rule — a behind-trunk working tree answers this question wrong in the expensive direction. Confirm with me before canceling anything non-obvious.
2. **Specify** — investigate the codebase enough to write the full §5 AI-ready template: `Problem & Context`, observable `Acceptance Criteria`, `Source File Pointers` and `Owned Paths` (strictly verify path existence on `origin/<base>` for all entries in `Source File Pointers` and `Owned Paths` prior to promoting to `ai:agent-ready` — a pointer or owned path to a nonexistent or moved path breaks concurrency checks or sends the implementation agent to a file that isn't there), and a `Verification Command` that actually runs in this repo. **Assess verification gate adequacy**: ensure the command tests the ticket's primary failure mode and is not blind to its primary risk (e.g. typecheck commands covering excluded directories, or vacuous test suites); when gates are known-weak or have coverage gaps, explicitly document compensating checks or verification gaps in the description. For non-code work, the evidence line replaces the verification command.
3. **Route** — correct project, canonical `type:*` + `area:*` labels, evidence-based priority. Add the `source:*` label if missing (`source:human` for owner-filed items, `source:agent`/`source:sentry`/`source:client-support` by origin) — triage is the backstop that keeps source attribution complete. Read the issue's current state before writing — the GitHub integration may have moved it already.

   **Set `blocked by` relations while routing.** If this ticket consumes another open ticket's output — a helper it introduces, a schema it migrates, a decision it records — add the Linear `blocked by` relation now. Dispatch reads it: a ticket with an unfinished blocker never enters the ready queue, and is released automatically the tick after the blocker reaches `Done`. Owned Paths cannot express this (disjoint files, real dependency), and a relation nobody sets is a dependency nobody enforces. This is most of the value of decomposing an epic: the pieces carry their order with them. Only `blocked by` gates dispatch — `related` is annotation.

4. **Promote or hold** — if all five sections are now solid, update the description, add `ai:agent-ready`, move to `Todo`. If something genuinely needs a human decision (unclear product intent, missing credentials, ambiguous scope), move it to `Blocked` + `ai:blocked` and comment exactly what's missing, phrased as questions I can answer.

   **A hold means `Blocked`, not a comment on a ticket left in `Triage`.** A held ticket that stays in `Triage` is picked up by the next triage tick, and the one after that — the stage re-derives the same conclusion and posts it again forever. CLNT-504 collected **ten** near-identical hold comments this way, CLNT-521 seven. `Blocked` takes it out of the sweep, puts it in the queue report's `BLOCKED — needs a human` section, and one answer from me releases it.

   **Never hold and promote at once.** If you are holding, the ticket must not end the tick carrying `ai:agent-ready`, and must not be in `Todo` — that combination is what dispatch reads as "ready", so a ticket you just said needs a human decision gets handed to an implementation agent that has to invent the very scope you refused to guess at. Strip `ai:agent-ready` when you hold. Three legalease tickets were in exactly this state (CLNT-518, CLNT-686, CLNT-551).

**Before holding on product intent, look for the answer.** Check the repo's product-decisions doc (`docs/product-decisions.md` where it exists), `docs/`, the Linear project Overview, and prior tickets in the same area — most "unclear intent" holds are questions already answered somewhere, and every avoidable hold costs a round-trip through the slowest part of the pipeline. Hold only when the decision genuinely hasn't been made yet.

When you do resolve intent from those sources, cite where in the ticket so the next agent doesn't re-litigate it. When I answer a held question, the answer belongs in the product-decisions doc, not just in the ticket comment.

Batch the questions: one notification at the end of the run listing everything held and what each needs, rather than a ping per ticket.

Do **not** start implementing anything — triage only. Never promote a ticket you couldn't verify against the actual codebase.

Finish with a summary table: issue, action taken (promoted / held / duplicate / closed), and what's blocking each held one.

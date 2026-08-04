# factory-unblock

> Re-examine held (ai:blocked) tickets for new evidence and release the ones that no longer need a human

Re-examine the `ai:blocked` holds for the repository I'm currently in: some blockers resolve without anyone commenting on the ticket — the dependency merged, the credential got documented, the code moved on — and this sweep is what notices. Resolve the team from the repo via the mapping in `~/Develop/hdkiller/docs/orgs/linear.md` §1. Use the Linear MCP; on failure retry once then fall back to `linear_common` GraphQL per the global rule.

Target: every open ticket in `Blocked` or `Triage` carrying `ai:blocked`, **oldest hold first** — the longest-stuck ticket has waited longest for this look. Interpret $ARGUMENTS as specific issue IDs or a max count; default is up to 10.

Tickets whose question has already been **answered by a reply** are the triage stage's job (the orchestrator's reply-detection gate resurfaces them) — if you find one, handle it exactly as `factory-triage` would rather than skipping it, but it counts against your cap.

## Claim what you are examining

Same protocol as triage: before working an issue, set `assignee` to yourself and add `ai:in-progress` + `agent:<your-harness>`; leave the state alone. Remove `ai:in-progress` when you finish that issue. One at a time, not a batch up front.

For each held ticket:

1. **Reconstruct the hold** — read the blocking comment and what it says is missing. If the hold never stated what it needs, treat that as the finding: comment the specific question it should have asked, re-add `ai:blocked` (remove first if present — the fresh label event resets the orchestrator's reply clock), and move on.
2. **Hunt for new evidence** — has anything changed since the hold?
   - a blocking/related ticket has since moved to Done, or the referenced PR merged;
   - the answer now exists in the repo's `docs/product-decisions.md`, `docs/`, the Linear project Overview, or a newer ticket in the same area;
   - a missing credential/env detail is now in `~/Develop/hdkiller/docs` (servers, applications, guides);
   - the code moved enough that the premise of the hold is gone (verify in the actual codebase — read-only).
3. **With evidence: release the hold.** Remove `ai:blocked`, comment one line citing the evidence (link the ticket/PR/doc), then re-run triage's promote-or-hold: promote to `Todo` + `ai:agent-ready` only if the full §5 template is solid against the current code; otherwise leave it in `Triage` for the triage stage to spec. Never promote on a guess — a wrongly released hold hands an implementation agent a question a human was supposed to answer.
4. **Without evidence: leave silently.** No comment, no label churn, no re-stating the question. A sweep that re-derives the same hold on every run is the exact pathology this pipeline keeps having to un-learn (CLNT-504 collected ten identical hold comments). The ticket stays exactly as it was.

Do **not** start implementing anything, and never remove `ai:blocked` just because the hold is old — age is not evidence.

Finish with one batch report: a table of every ticket examined (identifier, held since, verdict: `released → todo` / `released → triage` / `answered, handled` / `still held` + one-line reason), followed by the count of holds that remain waiting on a human. One message, not a ping per ticket.

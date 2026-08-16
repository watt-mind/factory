# merge-verify — exact landing gate

This is a deterministic command, not a model prompt. A durable
`factory.merge-landed` event pins the PR, original head/branch, base, ticket,
and exact merge commit.

The command first proves GitHub still reports that exact merge. It then polls
with bounded deadlines for check-runs on the exact merge commit and, when the
repo config declares `smoke_workflow`, that workflow on the same commit.
Missing, red, cancelled, stale, or uncertain evidence fails closed. CI RED or
SMOKE RED blocks the ticket, preserves branch/worktree, sends the required
notification, exits failed, and therefore keeps the global merge barrier held.

Only after all configured landing gates are green does it run the repo-owned
worktree teardown for exactly the ticket, verify the remote head branch still
points at the merged head SHA, refuse protected branch names, delete exactly
that ref, mark the ticket Done, and inject the next merge scan. Replays are
idempotent at event admission; no apply action can mark Done or delete a
branch.

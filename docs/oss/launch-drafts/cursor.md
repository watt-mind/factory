# Cursor community post (draft)

**DRAFT — a human posts this. Agents do not publish.**

Where: Cursor forum / Discord. Tone: practitioners who already live in
the editor, showing the unattended CLI path.

---

Cursor Agent CLI (`agent -p`) is one of the factory's harnesses.

Interactive Cursor is how humans specify work. Unattended Cursor is how
the factory runs a ticket overnight: `agent -p --output-format stream-json
--trust --force`, cwd = the ticket worktree, prompt pointing at
`./input.json` → `./result.json`. We never pass Cursor's own `--worktree`;
the factory owns isolation (branch, ports, database) so two tickets cannot
share a checkout.

Same protocol as the other harnesses. The ticket is the unit. Owned Paths
are the concurrency key. CI is the reward. The factory does not merge
because the agent said it was done.

17 days, 3–20 August 2026: 1,825 tickets dispatched, 1,620 merged, 87%
without a Blocked detour, median 38 minutes from claim to merge. Client
repos and the factory repo itself (529 merges) go through the same loop.

If you already review PRs in Cursor, the interesting part is everything
_around_ the agent: a tracker that can be Linear today and GitHub Issues
next, a worker that re-runs the verification command, a merge lane that
stops on `ai:escalated`.

https://github.com/watt-mind/factory — Apache-2.0,
`bin/factory demo --harness cursor`

# Claude Code community post (draft)

**DRAFT — a human posts this. Agents do not publish.**

Where: Claude Code Discord / forum / HN comment as appropriate. Not a launch
thread of its own — a "how we run Claude Code unattended" note.

---

Claude Code is the worker. Factory is the floor manager.

We dispatch `claude` against Linear tickets in isolated worktrees (own
branch, ports, database). The ticket names Owned Paths and a Verification
Command. A worker re-runs that command after the session; the agent's
"looks good" is commentary. CI is what merges.

17 days unattended, 3–20 August 2026:

- 1,825 tickets dispatched, 1,620 merged
- 87% merged without a Blocked stop or `ai:escalated`
- median claim → merge: 38 minutes
- the factory repo itself is 529 of those merges — Claude (and the others)
  ship the orchestrator they run in

We do not wrap Claude in a second agent that "manages" it. The planner is
deterministic and outside the model. Claim, worktree, verify, PR, merge
are scripts. Claude does the ticket. The interesting Claude-specific
lessons so far: keep the Linear MCP off the unattended allowlist (too much
surface, and it fails in ways that look like "Linear is down"); prefer
snapshots over screenshots (context burn); never `sleep` for CI.

Apache-2.0: https://github.com/watt-mind/factory

`bin/factory demo --harness claude` records Claude on the demo ticket
without needing the demo to call out to the API.

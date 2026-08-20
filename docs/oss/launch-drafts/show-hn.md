# Show HN (draft)

**DRAFT — a human posts this. Agents do not publish.**

Suggested title:

> Show HN: Factory – unattended agents that turn tickets into merged PRs

Suggested body:

---

We have been running coding agents (Claude Code, Codex, Cursor, Gemini CLI, Pi) against a real ticket queue since 3 August, without sitting in the sessions.

In 17 days: 1,825 tickets dispatched, 1,620 merged. Median time from claim to merge is 38 minutes. 87% of merges never hit Blocked and never needed an escalation label. The other 13% stopped for a human — a decision, a credential, or a security-relevant diff.

The factory does not replace the coding agent. It is the loop around it: Linear (or, soon, GitHub Issues) as the control plane, an isolated worktree per ticket, Owned Paths so two agents cannot collide, a verification command the worker re-runs, CI as the merge gate. Nothing merges because the model said it was done.

It also runs itself. This repo is an ordinary dispatch target. Harness defects become tickets; tickets become PRs; merges change the next run. We keep a friction log of the repeats (agents `sleep` instead of `gh pr checks --watch`, orphaned Chrome locking the next session, a parser that treated a fenced Owned Paths block as empty).

Apache-2.0. No telemetry. 15-minute demo with no third-party accounts:

```
bun install
bin/factory demo --dry
bin/factory demo
```

Repo: https://github.com/watt-mind/factory

Numbers from `bun tools/launch-numbers.mjs --since 2026-08-03` (2026-08-20). Re-run before posting.

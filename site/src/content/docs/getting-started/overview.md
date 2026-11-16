---
title: Overview
description: The factory that builds software — and itself
sidebar:
  order: 1
---

**factory** is a runtime for self-improving agentic loops. Code is the first product line.

You already have a coding agent that can write a patch (Claude Code, Gemini / Antigravity, OpenAI Codex, Cursor, Pi, or Hermes Agent via ACP). What you probably do not have is the process around it:

- Something that decides which work is actually ready,
- Hands one agent one ticket in one isolated worktree,
- Re-runs the verification command independently, and
- Holds the merge until CI and a reviewer agree.

That is factory.

:::note[Core philosophy]
**The tracker is the control plane, git holds the product truth, and CI is the reward signal.** Nothing merges because an agent said it was done; it merges because the tests passed and a reviewer approved.
:::

## Key Capabilities

| Capability                             | How Factory Delivers It                                                                                                              |
| :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| **One ticket, one worktree**           | Every dispatched ticket runs in a dedicated git worktree with isolated ports, databases, and temporary state.                        |
| **Concurrency without collision**      | Dispatched tasks require disjoint **Owned Paths** globs. The planner prevents two agents from editing the same files simultaneously. |
| **Independent Verification**           | The factory worker re-runs the declared verification command. An agent's report is commentary; the test exit code is evidence.       |
| **No product truth locked in Factory** | Code lives in git and tasks live in Linear or GitHub Issues. Runtime state and receipts can be rebuilt from those durable records.   |
| **Self-improving loops**               | Defects, friction, and test failures are turned into issues, prioritized, and dispatched to maintain the factory itself.             |

## Next Steps

- [Connect Your Repo](/factory/getting-started/quickstart/) — Point factory at a repository you already have. The fast path is a prompt you hand to the coding agent you already use.
- [Your First Dispatch](/factory/getting-started/first-pr/) — What happens when factory picks up a ticket, and how to read the result.
- [Configuration Reference](/factory/getting-started/configuration/) — Repositories, policies, and schedules.
- [Factory Doctor](/factory/getting-started/doctor/) — Verify your local environment and toolchains, or check a fresh clone offline.

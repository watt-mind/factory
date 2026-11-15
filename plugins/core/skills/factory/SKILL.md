---
name: factory
description: "Gateway skill and playbook router for working in the Factory style: enforces floor invariants, loads only the matching principle-* skills, and routes interactive work to a concrete playbook or factory-* command. Use for /factory, or when starting a non-trivial investigation, bug fix, feature, refactor, prototype, or formal verification."
---

# Factory Gateway

Single entry point that pairs `AGENTS.md` (the Factory floor) with concrete execution playbooks and on-demand `principle-*` skills.

## Non-Negotiables

- **Floor precedence:** `AGENTS.md` / `shared/floor.md` always wins (`Owned Paths`, `Never auto-merge`, `escalate_paths`, `Blocked` + `factory notify`, no `git stash` in worktrees, `## Handoff`).
- **Ticket tripwire:** Before the first file edit on meaningful trackable work, find or file the ticket and work in a dedicated worktree (`bin/worktree-up.sh`). Skip only for read-only investigations and inconsequential edits (or when the user says `"no ticket"`).
- **Proceed vs. stop:** Load `../principle-proceed-with-gates/SKILL.md` when unsure. Proceed autonomously on reversible local work; stop only on `Blocked` conditions, `Never auto-merge`, `escalate_paths`, or genuine unrecorded product-intent forks.
- **Empirical forks:** Before asking the user `"which approach?"` or `"how does X behave?"`, check if running a quick experiment (`playbooks/prototype.md`) or reading the code answers it objectively.
- **On-demand principles:** Read only the `../principle-<name>/SKILL.md` files named by the active playbook. Never load all 19 into context at once.
- **Evidence-only reporting:** Cite exact file paths, symbol names, commit refs (`origin/<base>@<sha>`), and observed test/command output.

## Route the Task

Match the user's request to **one** mode below, read its playbook (or invoke the matching `factory-*` command), and follow its steps in order:

### Interactive Coding & Verification Playbooks (`playbooks/`)

- **Investigation** (`playbooks/investigation.md`) — Read-only question, architecture trace, code/principles audit, or empirical comparison (`how does X work`, `why`, `review`).
- **Bug fix** (`playbooks/bug-fix.md`) — Reproduce a defect, observe a failing test first, trace and fix the root cause.
- **Feature** (`playbooks/feature.md`) — New or changed behavior, domain-first types, UI visual polish loop, and verification.
- **Refactoring** (`playbooks/refactoring.md`) — Behavior-preserving structural cleanup, decomposition, or deduplication.
- **Prototype** (`playbooks/prototype.md`) — Throwaway spike in `$TMPDIR` (never `git stash`) to settle an empirical or UI design fork.
- **Formal verification** (`playbooks/formal-verify.md`) — Model-checking races/state machines or property-testing pure invariants via `/factory-formal-verify-create`, `/factory-formal-verify-maintain`, and `/factory-statechart`.

### Existing Factory Lifecycle Commands

If the request is a control-plane or release lifecycle operation, delegate directly to the dedicated command instead of duplicating it:

- Ticket lifecycle: `/factory-ticket`, `/factory-work`, `/factory-capture`, `/factory-triage`, `/factory-unblock`
- Review & landing: `/factory-merge`, `/factory-ship`, `/factory-verify-deploy`
- Repo health & sweeps: `/factory-sweep`, `/factory-audit`, `/factory-garden`, `/factory-retro`, `/factory-friction`, `/factory-recap`

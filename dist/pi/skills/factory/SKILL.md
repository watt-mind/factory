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
- **Non-blocking coordinator default:** Keep the main session unblocked for steering, cross-slice seams, and final gates. Delegate multi-file edits, independent reviews, and heavy checks to isolated subagents routed by difficulty tier (`tier:light`, `tier:standard`, `tier:strong`) with `reviewer != implementer` as a hard invariant. Check `bun orchestrator/pulse.mjs` (`CAPACITY & FLOW`) before widening parallel dispatch.
- **Evidence-only reporting:** Cite exact file paths, symbol names, commit refs (`origin/<base>@<sha>`), and observed test/command output.

## Route the Task

Match the user's request to **one** mode below, read its playbook (or invoke the matching `factory-*` command), and follow its steps in order:

### Interactive Coding & Verification Playbooks (`playbooks/`)

- **Investigation** (`playbooks/investigation.md`) — Read-only question, architecture trace, code/principles audit, or empirical comparison (`how does X work`, `why`, `review`; pairs with `/factory-how`, `/factory-why`, `/factory-teach`).
- **Bug fix** (`playbooks/bug-fix.md`) — Reproduce a defect, observe a failing test first, trace and fix the root cause.
- **Feature** (`playbooks/feature.md`) — New or changed behavior, domain-first types, UI visual polish loop, and verification.
- **Refactoring** (`playbooks/refactoring.md`) — Behavior-preserving structural cleanup, decomposition, or deduplication.
- **Prototype** (`playbooks/prototype.md`) — Throwaway spike in `$TMPDIR` (never `git stash`) to settle an empirical or UI design fork.
- **Formal verification** (`playbooks/formal-verify.md`) — Model-checking races/state machines or property-testing pure invariants via `/factory-formal-verify-create`, `/factory-formal-verify-maintain`, and `/factory-statechart`.

### Understanding, Orchestration & Reflection Skills (`../factory-*/SKILL.md`)

- **How (`../factory-how/SKILL.md`):** Trace how a subsystem works today (`origin/<base>` freshness, `codegraph_explore` / `rg`, bounded `file:line` flow).
- **Why (`../factory-why/SKILL.md`):** Decision archaeology (`git log -S`/`-L`, PRs, Linear/GitHub issues, `docs/product-decisions.md`) before changing load-bearing code.
- **Teach (`../factory-teach/SKILL.md`):** Layer `factory-how` + `factory-why` + `factory-unslop` into progressive explanations with incremental Mermaid diagrams for 3+ interacting parts.
- **Unslop (`../factory-unslop/SKILL.md`):** Edit or write prose, PRs, docs, and skills with zero AI tells while preserving technical precision.
- **Orchestrate (`../factory-orchestrate/SKILL.md`):** Interactive Swarm partitions, Arena bakeoffs in isolated sandboxes, or Producer -> Critic pipelines (distinct from `/factory-work` standing queue dispatch).
- **Reflect (`../factory-reflect/SKILL.md`):** Mine the active session transcript via 3 read-only lenses + synthesizer into project-local `.claude/skills/`, `AGENTS.md`, or structural `Triage` tickets (distinct from harness `/factory-friction` and log metrics `/factory-retro`).
- **Verify (`../factory-verify-create/SKILL.md`, `../factory-verify-maintain/SKILL.md`, `/factory-verify`):** Generate and maintain repo-local `.claude/skills/verify-<app>/` control skills and run pre-merge human-like E2E PR/branch verification.
- **Baseline (`../factory-baseline/SKILL.md`, `/factory-baseline`):** Bootstrap or align a repository to Factory's `PC-01`…`PC-23` CI, security (`code-security.md`), worktree, and `AGENTS.md` baseline in one PR.

### Existing Factory Lifecycle Commands

If the request is a control-plane or release lifecycle operation, delegate directly to the dedicated command instead of duplicating it:

- Ticket lifecycle: `/factory-ticket`, `/factory-work`, `/factory-capture`, `/factory-triage`, `/factory-unblock`
- Review & landing: `/factory-verify`, `/factory-merge`, `/factory-ship`, `/factory-verify-deploy`
- Repo health & sweeps: `/factory-baseline`, `/factory-sweep`, `/factory-audit`, `/factory-garden`, `/factory-retro`, `/factory-friction`, `/factory-recap`

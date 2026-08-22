---
title: The Thesis
description: Why process beats model magic in autonomous software engineering
---

**The factory that builds software — and itself.**

A runtime for self-improving agentic loops where code is the first product line.

## Wedge First

The factory is an unattended software factory. A ticket that is specified, disjoint, and agent-ready becomes a pull request without a human driving each turn. The PR merges because tests passed and a reviewer approved — never because an agent said it was done.

That is the wedge: the thing a visitor can use tomorrow, against a reward signal that already exists (CI), on a control plane that already exists (tickets), into an artifact that already exists (a pull request).

We do not lead with a general agent platform that happens to also write code. We lead with shipping software, unattended, and let generality show up as a consequence of the same primitives.

### The Software Loop

1. **The tracker holds the work:** `Triage` → `Todo` + `ai:agent-ready` → `In Progress` → `In Review` → `Done`.
2. **The worktree isolates the change:** `bin/worktree-up.sh` provides its own branch, ports, database, and runtime home.
3. **A bounded agent implements the ticket:** strictly inside its declared `Owned Paths`.
4. **An independent worker re-runs verification:** the agent's report is commentary; the exit code is evidence.
5. **GitHub holds the PR:** CI is the reward signal. Merge and ship are later loops on the same event runtime.

## And Itself

The same loops that ship product ship the factory. This repository is an ordinary dispatch target. A harness defect becomes a ticket; a ticket becomes a PR; a merge changes the next run. Friction is not a retrospective slide — it is intake.

<iframe
  class="diagram-embed diagram-embed--loop"
  src="/factory/diagrams/autonomous-loop.html"
  title="The self-improving Factory loop"
  loading="lazy"
></iframe>

Self-improvement is not a metaphor for "the model gets smarter." It is the factory editing its own skills, adapters, pins, and docs through the same claim → worktree → verify → PR path it uses on every other repo.

## Generality Beyond Code

The event runtime is not a git wrapper. A research, classification, reporting, operations, or editorial agent may only need an isolated directory and a versioned input/output contract.

Those loops share the same primitives:

- an admitted, idempotent **event**;
- a content-pinned **agent** with a schema, timeout, and budget;
- a deterministic **planner** outside the model;
- an isolated **workspace** with explicit capabilities;
- independent **verification** of the artifact;
- a **receipt**, and optionally a **chain** into the next event.

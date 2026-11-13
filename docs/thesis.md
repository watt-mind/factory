# Thesis

**The factory that builds software — and itself.**

A runtime for self-improving agentic loops. Code is the first product line.

This is the public positioning, decided 2026-08-18. The nouns that make it
true live in [`model.md`](model.md). How the loops are shaped, and why, lives
in [`architecture.md`](architecture.md).

---

## Wedge first

The factory is an unattended software factory. A ticket that is specified,
disjoint, and agent-ready becomes a pull request without a human driving each
turn. The PR merges because tests passed and a reviewer approved — never
because an agent said it was done.

That is the wedge: the thing a visitor can use tomorrow, against a reward
signal that already exists (CI), on a control plane that already exists
(tickets), into an artifact that already exists (a pull request). We do not
lead with a general agent platform that happens to also write code. We lead
with shipping software, unattended, and let generality show up as a
consequence of the same primitives.

Code is the first product line because the loop is closed today:

1. Linear holds the work (`Triage` → `Todo` + `ai:agent-ready` → `In Progress`
   → `In Review` → `Done`).
2. A worktree isolates the change (`bin/worktree-up.sh`: own branch, ports,
   database, runtime home).
3. One bounded agent implements exactly that ticket, inside its `Owned Paths`.
4. The worker re-runs the ticket's `Verification Command` and the repo's
   declared verify. The agent's report is commentary; the exit code is the
   evidence.
5. GitHub holds the PR. CI is the reward. Merge and ship are later loops on
   the same event runtime.

A platform-first story would invert this: sell a runtime for "any loop", then
mention that software is one workload. That is true of the machinery and
false as a pitch. Nobody adopts a factory because it might later draft
articles or reclaim disk. They adopt it because specified work leaves the
queue as reviewed PRs while they sleep.

## And itself

The same loops that ship product ship the factory. This repository is an
ordinary dispatch target (`config/repos.yaml`, `max_in_flight`,
`bin/worktree-up.sh`). A harness defect becomes a ticket; a ticket becomes a
PR; a merge changes the next run. Friction is not a retrospective slide — it
is intake.

Self-improvement is not a metaphor for "the model gets smarter." It is the
factory editing its own skills, adapters, pins, and docs through the same
claim → worktree → verify → PR path it uses on every other repo. Containment
is process, not trust: a dispatched change never touches the live control
plane's runtime home, and it runs only after PR, CI, merge, and an operator
pull-and-restart.

The operator's job is strategy and typed decisions, not poking the session to
keep the loops moving. When a run must stop, it files a decision request on
the inbox. When it can continue, it does.

## Generality beyond code

The event runtime is not a git wrapper. A Git repository and a worktree are
one workspace provider, not the foundation. A research, classification,
reporting, operations, or editorial agent may only need an isolated directory
and a versioned input/output contract. Those loops already exist as named
event types (`keephq.disk-alert.raised`, `factory.status-report.requested`,
and the editorial cell design in `docs/editorial-agent-runtime.md`).

They share the same public primitives as software work:

- an admitted, idempotent **event**;
- a content-pinned **agent** with a schema, a timeout, and a budget;
- a deterministic **planner** outside the model;
- an isolated **workspace** with explicit capabilities;
- independent **verification** of the artifact;
- a **receipt**, and optionally a **chain** into the next event.

Code is first because CI is already a sharp reward signal and a pull request
is already a reviewable artifact. Other product lines earn the same machinery
by naming an event type that needs it — never by borrowing another system's
vocabulary. The runtime speaks tickets, events, runs, pins, packs, and
extensions.

## What this is not

- **Not a watched copilot.** The human does not sit in the loop for each
  ticket. They specify, authorise, and review at the gates the protocol
  already names.
- **Not a pitch for an agent operating system.** The runtime is general; the
  product is the factory. Generality is documented so an extension author
  knows where to plug in, not so the homepage hedges.
- **Not harness-native.** Content lives in `shared/` and is emitted into
  Claude Code, Codex, Cursor, Pi, and Gemini; Hermes Agent connects through
  the event runtime's ACP adapter. The plugin is a convenience layer. The
  floor is `AGENTS.md`.
- **Not a replacement for Linear, Git, or CI.** Those are the authorities.
  The factory holds no business state of its own: `tick.mjs` re-reads Linear
  on every decision; the PR is the artifact; CI is the signal that a change
  earned the next step.

## How to read the rest

| Document                                     | Job                                         |
| :------------------------------------------- | :------------------------------------------ |
| This file                                    | Why it exists, and in what order we say so  |
| [`model.md`](model.md)                       | The primitives, named as they are in git    |
| [`architecture.md`](architecture.md)         | Why each loop is shaped this way            |
| [`event-runtime.md`](event-runtime.md)       | The event-driven sidecar, in running code   |
| [`kernel-and-packs.md`](kernel-and-packs.md) | How the registry extends without shadowing  |
| [`extensions.md`](extensions.md)             | The install unit for packs, adapters, hooks |
| [`README.md`](../README.md)                  | How to run it                               |

# Roadmap

**The factory that builds software — and itself.**

A runtime for self-improving agentic loops. Code is the first product line.

This file is the public Now / Next / Later view. Dates are deliberately
absent: a milestone moves when the tests pass and a reviewer merges it, not
when a calendar says it should. Open-core from day one — Apache-2.0 for
everything you need to run one factory; team and hosted features live behind
the reserved [`ee/`](ee/README.md) seam.

The factory orchestrates coding agents (Claude Code, Codex, Gemini CLI,
Cursor, Pi, and Hermes Agent via ACP). It does not compete with them. The tracker is the control plane,
GitHub is the source of truth, and CI is the reward signal. Nothing merges
because an agent said it was done.

Four tracks run in parallel. Code is the wedge; the runtime is general.

| Track                    | What it is                                                                                |
| :----------------------- | :---------------------------------------------------------------------------------------- |
| **Harnesses**            | Portable agent content; one packaging per coding tool                                     |
| **Packs**                | The unit an adopter ships a loop in — agents, schemas, events, schedules                  |
| **Control planes**       | Where work is admitted, claimed, and reviewed. Linear today; GitHub Issues next           |
| **Self-improving loops** | The factory maintains itself. Other product lines (ops, editorial) reuse the same runtime |

There is no telemetry. Adoption signal is `ADOPTERS.md` plus GitHub
Discussions once the repo is public.

---

## Now

What is true in the tree today, or landing as the repo prepares to go public.

### Harnesses

The **content is portable; only the packaging isn't.** Skills, commands, and
agent prompts live in `shared/` and emit into each harness's native layout.
Claude Code, Codex, Gemini CLI, Cursor, and Pi already consume the same floor
rules, while Hermes Agent is available through the event runtime's ACP adapter.
Adding a harness is a packaging problem, not a second copy of the factory.

### Packs

The event runtime loads a kernel plus optional filesystem packs. A pack is a
directory of pinned agents, schemas, event types, edges, and schedules —
namespaced, content-hashed, and admitted rather than scanned from disk. Packs
cannot override the kernel and cannot declare mutating agents; that admission
model is the safety property, not a later add-on. Extensions
([`docs/extensions.md`](docs/extensions.md)) bundle packs with adapters, config,
hooks, and panels as one installable unit.

### Control planes

v1 is Linear, honestly: tickets carry state, assignees are the claim lock,
and `Owned Paths` is the concurrency key. GitHub holds the PR; CI is what
makes an unattended merge safe. A control-plane adapter is being extracted so
Linear is the first implementation of an interface, not a hard dependency.

### Self-improving loops

This repository is maintained by the thing in it. Tickets become isolated
worktrees, PRs, independent verification, and merges gated on CI. The same
runtime already runs bounded, verified agent chains from events (intake →
planner → watched proposal → worker → receipt). "Self-improving" here means
measured friction becomes harness changes, and the factory's own tickets flow
through the same loop as everyone else's — not a runtime that rewrites its
kernel unattended.

Already in the tree:

- Apache-2.0 license, `NOTICE`, and an explicit [`ee/`](ee/README.md) seam
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates

Still landing before the visibility flip (same Now bucket — they are the
pre-public hygiene, not a later product phase):

- CLA from the first outside contribution (cannot be retrofitted)
- De-personalized example configs and a `factory init` scaffold
- In-repo protocol docs (no private-path dependencies)
- A 15-minute `factory demo` that runs one ticket end to end
- Public README and positioning docs in this vocabulary

---

## Next

The public, quiet phase, then launch. Still the software-factory wedge; the
runtime's generality starts to be visible as packs.

### Harnesses

- Keep emit and the floor the single source of truth as the public README
  becomes the first thing a new harness user reads
- Per-harness community posts at launch, pointing at the same portable content

### Packs

Packs are the GTM unit: the thing an adopter authors, shares, and runs.

- A pack authoring kit (`factory pack init` / `validate`, plus pack docs)
- Two first-party packs at launch as proof the runtime is not only software
- Design for a policy-granted mutating tier: can a shipped loop apply, or
  only propose? Third-party packs that change the world need an admission
  model before they exist

### Control planes

- Land the adapter interface with Linear behind it
- GitHub Issues as the first additional adapter — labels, assignees, and
  Projects bound to the same protocol, so a zero-third-party-account
  quickstart is possible
- GitHub Discussions as the public conversation (no telemetry)

### Self-improving loops

- Dogfood-in-public: the public repo is maintained by the factory
- Launch content from measured runs (weeks unattended, merged tickets, cost
  per merge) — CI remains the reward signal, economics remain a report
- Infra-ops and editorial loops, already sketched on this runtime, become
  first-party packs rather than private side systems

Repo-admin work that is **not** this file (branch rules, labels, topics,
social preview, flipping visibility) lands with the visibility-flip checklist,
not as a silent change from a docs PR.

---

## Later

Traction, generality, and the hosted line. Code stays the first product
line; it is no longer the only one.

### Harnesses

- External product repos under factory management, using the same portable
  content and per-repo worktree lifecycle
- Further harnesses only when there is a real packaging target, not a
  speculative matrix

### Packs

- A packs marketplace as a hosted / `ee/` concern — discovery and policy, not
  a second kernel
- Canvas artifacts: agent-produced Markdown / diagrams rendered as documents,
  content-addressed, never silent chain input

### Control planes

- Multi-operator, approvals and policy engine, org dashboards — the `ee/` /
  hosted product, not the Apache core
- Tracker-neutral protocol as the documented contract every adapter
  implements

### Self-improving loops

- Standing loops that earn their timer by being watched first, then run as
  admitted clock events with the same planner, approval, and receipts as
  everything else
- Product lines beyond code (ops, editorial, and others) as ordinary packs
  on this runtime
- The factory continues to build itself in public; measured economics feed
  the deck, not a hidden dashboard

---

## What will not be on this roadmap

- **A second license for the core.** Apache-2.0 for the public repo. `ee/`
  may stay empty at launch.
- **Opt-in telemetry.** Decided none for now.
- **Competing with coding agents.** We sit above them and above CI.
- **Unattended kernel mutation.** Packs extend the runtime; they do not
  replace it. Proposals remain admission. CI remains the merge gate.

If a milestone here disagrees with the code, the code wins — and this file
should change in the same PR that made it untrue.

# factory web design

This document is the product north star for the factory web UI: who it serves, what it must help them do, and how it should behave. For implementation details—architecture, components, tokens, and interaction grammar—use [`../../docs/event-runtime-webui.md`](../../docs/event-runtime-webui.md).

## Who it's for

factory is for the operator supervising ticket-driven automation. That operator needs to notice decisions, understand a ticket's path through the runtime, and account for its outcome without reconstructing the story from disconnected entities. It is a control tower for attentive intervention and trustworthy follow-through, not a general-purpose dashboard or database browser.

## The three jobs

The jobs are ordered by operator priority. A web change should make one of them measurably easier.

### 1. What needs me

**Served today by:** Overview surfaces doctor findings and runtime health; Proposals shows approval and rejection decisions with TTLs; Events exposes `human_needed` and dead-lettered intake; Workers shows stale capacity.

**Gap:** Attention is split across entity views. The operator still has to scan several lists and infer urgency instead of starting from one calm, ranked inbox of decisions and exceptions.

### 2. What is happening, or what happened to my ticket

**Served today by:** Events shows intake and routing, Proposals explains planning, Runs shows lifecycle, attempts, traces, results, and receipts, while Chain and Graph expose correlation and topology.

**Gap:** These views tell strong entity-level stories, but the ticket is not yet the consistent entry point and narrative thread. The operator must translate between event, proposal, run, and artifact identifiers to answer a ticket-level question.

### 3. What did it cost, or what did we ship

**Served today by:** Runs and trace usage expose execution and token details; results, receipts, Artifacts, and outbox records show produced and published outputs.

**Gap:** Cost and delivered value are not summarized around the ticket. The operator cannot yet see a clear ticket-level account of resources spent, verification, artifacts, and shipped outcome.

## Principles

- **Calm by default, loud only for decisions.** Persistent chrome stays quiet so approvals, failures, and requests for intervention retain their signal.
- **The ticket is the unit of the story.** Events, proposals, runs, costs, evidence, and shipped outputs should read as chapters of one operator-owned outcome.
- **Every planner decision is explained in the UI.** The operator must be able to see why work ran, waited, no-op'd, or asked for help instead of reverse-engineering policy.
- **Keyboard-first.** Frequent navigation and decisions must remain fast without a pointer, while every path stays accessible by other input methods.
- **No optimistic state.** factory displays lifecycle changes only after the runtime confirms them; a control plane must never invent progress.
- **Dark-first; light and contrast are equals.** Dark is the default working environment, but no hierarchy, meaning, or operability may depend on that theme.
- **Mono for ids and numbers only.** Machine values should scan precisely; prose should remain readable and human.
- **Restrained motion.** Motion signals live activity or a meaningful transition, never decoration or reassurance without evidence.

## Naming & voice

The product name is **factory**: lowercase in UI copy, documentation, and titles. Use sentence case for headings, labels, and controls. Name actions with direct verbs; when activating a control opens a dialog before the action occurs, end the label with an ellipsis character (`…`), for example **Cancel run…**. Prefer concrete operational language that says what happened, what needs attention, and what the operator can do next.

## How to write a web ticket

Every web ticket must name the operator job it serves—**what needs me**, **what is happening or what happened to my ticket**, or **what did it cost or what did we ship**—and state how the proposed change closes a gap in that job. Acceptance criteria should test that operator outcome, not only the presence of a component. Use [§5 of the web UI specification](../../docs/event-runtime-webui.md#5-keyboard-and-command-surface), including its token, component, typography, and interaction rules, for **how** the change looks and behaves; do not restate or fork those rules in the ticket.

---
name: factory-teach
description: "Explain a complex subsystem, design pattern, or architecture progressively: plain definition first, layered follow-ups, incremental Mermaid diagrams for 3+ part flows, and zero AI slop. Use for /factory-teach, /teach, or 'explain X so I really understand it'."
---

# Teach

Build durable mental models through conversational layering rather than dumping a multi-screen reference manual at once. Stacks cleanly on `../factory-how/SKILL.md` (current behavior), `../factory-why/SKILL.md` (design rationale), and `../factory-unslop/SKILL.md` (crisp prose).

## Workflow

### 1. Ground explanations in real code

When teaching something inside the active repository, check the actual implementation first (using `../factory-how/SKILL.md` and `../factory-why/SKILL.md`). Never guess function names, flags, thresholds, or control flow. If explaining a general CS or systems concept, verify any numbers or trade-offs you state.

### 2. Open with a plain 1-2 sentence definition

Start directly with _what it is_ and _why it exists_, anchored in something concrete the user already works with. Skip preamble, cheerleading, or table-of-contents summaries.

### 3. Layer progressively (max 1-2 concepts per turn)

- **Turn 1 (Core model):** Explain only the minimal moving parts needed to see why the design works. Give one concrete example (a real call path in the repo or a simple analogy).
- **Branches, not dumps:** At the end of a layer, offer 2-3 specific next layers (for example: error/retry recovery, concurrency hazards, or how the boundary parser enforces the invariant) and let the user pick where to zoom in.
- **Calibrate to signals:** If the user asks about fundamentals, zoom out to intuition; if they jump to edge cases, skip basics and go straight to failure modes and trade-offs.

### 4. Use incremental Mermaid diagrams for 3+ interacting parts

When a concept involves 3 or more cooperating components, states, or message hops:

- Include a valid Mermaid diagram (`flowchart TD`, `flowchart LR`, `sequenceDiagram`, or `stateDiagram-v2`).
- Quote any node label that contains parentheses, brackets, or colons (for example, `claim["claim() lock"]`). Never use HTML tags inside labels.
- **Grow diagrams across turns:** Start Turn 1 with the 2-4 node happy-path core loop; add timeout/retry/fallback branches in the follow-up diagram when teaching that layer so the user's mental map grows step by step.

### 5. Write cleanly

Follow `../factory-unslop/SKILL.md`:

- Keep consistent naming across text and diagrams (do not rename `lease` to "token" mid-explanation).
- Active voice, short paragraphs, zero sycophancy, zero fake closing questions like "Let me know if that makes sense!" — ask a specific branching question when offering the next layer, or stop cleanly if the user asked for a single complete answer.

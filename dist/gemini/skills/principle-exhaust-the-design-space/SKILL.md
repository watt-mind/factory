---
name: principle-exhaust-the-design-space
description: "Gated principle: apply on net-new UI surfaces, material layout redesigns, greenfield architecture, or when explicitly requested — never on routine bugfix tickets. Diverge into 2-3 options and autonomously commit the winner."
disable-model-invocation: true
---

# Exhaust the Design Space

On net-new UI surfaces, material layout/flow redesigns, greenfield architectural decisions with no existing precedent, or when explicitly requested, diverge into **2–3 distinct options** before converging — the first plausible layout or abstraction is rarely the strongest.

- **Diverge boundedly inside `Owned Paths`:** Articulate 2–3 genuinely distinct layout, interaction, or structural directions (not trivial color/token tweaks). Prototype or render them boundedly if helpful — save scratch diffs to `$TMPDIR/<ISSUE-ID>-*.patch` and restore cleanly with `git checkout -- <path>`, **never `git stash`**.
- **Converge autonomously:** Evaluate the candidates coldly against user task clarity, interaction cost, visual hierarchy (`principle-experience-first`), and codebase fit, then **autonomously** select and commit only the winning design without pausing or stalling on an AFK operator.
- **Record the rationale:** Summarize the 2–3 explored options and why the winner beat the alternatives in your ticket comment and `## Handoff` (`Risks`), or in your interactive summary.

## Guardrails

- **Never apply on routine bugfix tickets, mechanical refactors, or narrow copy/config edits** where existing repo conventions already settle the design.
- Keep all exploration strictly inside `Owned Paths` (file out-of-scope ideas to `Triage`) and leave zero dead prototype code in the final diff.

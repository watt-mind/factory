---
name: principle-redesign-from-first-principles
description: "Apply when integrating a new requirement into an existing design. Redesign cleanly as if the requirement were foundational, strictly within Owned Paths and compatibility boundaries."
disable-model-invocation: true
---

# Redesign from First Principles

When a new requirement looks awkward to bolt onto an existing module, ask how you would structure it if the requirement had been part of the design from day one—then refactor toward that clean shape.

## Guardrails

- **Stay inside `Owned Paths` and compatibility boundaries.** Never expand ticket scope or perform drive-by refactors across unrelated modules.
- **Respect external skew.** Do not break active clients (such as cached add-ins) or live database/cron schemas in a single destructive wave.
- **Escalate cross-boundary redesigns.** If the clean design requires altering files or contracts outside `Owned Paths`, file a `Triage` issue instead of expanding the current diff.

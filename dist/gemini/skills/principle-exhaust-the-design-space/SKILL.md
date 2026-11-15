---
name: principle-exhaust-the-design-space
description: "Gated principle: apply ONLY when explicitly requested or on greenfield design/prototype tasks, never on routine bugfix tickets. Compare 2-3 competing approaches before committing."
disable-model-invocation: true
---

# Exhaust the Design Space

For novel UI interactions or greenfield architectural decisions with no existing precedent, sketch or prototype 2–3 competing approaches and compare them side by side before committing to one.

## Guardrails

- **Never apply on routine bugfix tickets, single-ticket dispatch runs, or quota-capped subagent lanes.**
- Only build competing prototypes when the user or ticket explicitly asks for design exploration, or when a genuine greenfield ambiguity cannot be settled by reading existing repo conventions.

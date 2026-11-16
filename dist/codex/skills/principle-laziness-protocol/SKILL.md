---
name: principle-laziness-protocol
description: "Apply when refactoring, sizing a diff, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem."
disable-model-invocation: true
---

# Laziness Protocol

- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag or value.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer clear lines beat speculative boilerplate.

## Guardrails

- Never delete required collateral (docs/inventories, seed scripts, i18n copy), security/auth/boundary checks, or honest-gap metadata (such as `unknowns[]` in data registries).

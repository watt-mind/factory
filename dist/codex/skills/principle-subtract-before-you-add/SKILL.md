---
name: principle-subtract-before-you-add
description: "Apply when sequencing an addition, refactor, or rewrite. Remove dead weight, redundant validators, and stub references first, then build on the simpler base."
disable-model-invocation: true
---

# Subtract Before You Add

Remove dead code, unused flags, duplicate helpers, and obsolete stubs before adding new behavior, so the new logic sits on a clean base.

## Guardrails

- Do not remove security/auth guards, boundary validators, or fail-closed preflight checks under the guise of simplification.
- Do not delete incomplete data records or required schema fields that represent honest gaps.

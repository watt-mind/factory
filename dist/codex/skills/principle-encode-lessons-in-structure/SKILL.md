---
name: principle-encode-lessons-in-structure
description: "Apply when you catch yourself repeating a rule or fixing the same class of mistake twice. Encode it as a lint, schema check, ratchet, or script instead of more prose."
disable-model-invocation: true
---

# Encode Lessons in Structure

Prose rules decay; mechanical checks compound. When a mistake recurs or a post-mortem reveals a sharp edge, encode the invariant in structure:

- **Deterministic checks over warnings:** Add an ESLint rule, AST/script check, JSON schema constraint, CI `--check` gate, or baseline ratchet.
- **Teach in the error message:** Make the failing check explain _why_ it failed and point directly to the root-cause fix.

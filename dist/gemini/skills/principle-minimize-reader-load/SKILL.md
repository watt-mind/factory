---
name: principle-minimize-reader-load
description: "Apply when reviewing or shaping code or prose that is hard to trace. Collapse one-caller wrappers, shrink mutable scope, and reduce layers between question and answer."
disable-model-invocation: true
---

# Minimize Reader Load

Optimize for the reviewer or future debugger reading the diff cold.

- **Count layers between question and answer.** Inline trivial one-caller wrappers and pass-through helpers that only obscure control flow.
- **Shrink mutable scope.** Prefer local `const` values and pure transformations over module-level or cross-function mutable state.
- **Make status and diffs scannable.** Lead with the answer, keep nesting shallow with early returns, and name variables for what they hold.

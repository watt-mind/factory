---
name: principle-test-behavior-not-implementation
description: "Apply when writing, changing, or keeping a test. Assert what the code's users or callers observe, so tests fail when behavior breaks and survive internal refactors."
disable-model-invocation: true
---

# Test Behavior, Not Implementation

Assert observable behavior and contracts rather than internal private helpers, call counts, or mock choreography.

- **Test through real boundaries:** Prefer real inputs/outputs, deterministic fakes at external boundaries, and observable state transitions.
- **Keep tests falsifiable:** Verify new regression tests fail before the fix is applied.

## Guardrails

- **Structural contracts are valid targets:** When the output format _is_ the user-facing contract (such as OpenXML `.docx` run/node structure, generated JSON schemas, or rendered visual/audio stills), asserting on that output structure is testing behavior, not implementation.

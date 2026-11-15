---
name: principle-fix-root-causes
description: "Apply when debugging any failure or test flake. Trace each symptom back to the first place the system went wrong and fix it there; a guard is a fix only when the state it handles is legitimate."
disable-model-invocation: true
---

# Fix Root Causes

Trace every symptom back to the first place the system diverged from valid state, and fix it at that origin.

- **No symptom bandaids:** Do not mask timing/lifecycle bugs with arbitrary `sleep`/`setTimeout` calls, blind retries, or broad `catch`-and-swallow blocks.
- **Guards are not universal fixes:** Adding a null-check or fallback is only a fix when the incoming state is legitimate; if the state itself is invalid, fix the producer that created it.

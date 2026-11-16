---
name: principle-explain-the-number
description: "Apply before trusting, reporting, or acting on any measured number: benchmark, eval score, latency, cost subtotal, or bundle size. Find what limits it and rule out measurement confounds."
disable-model-invocation: true
---

# Explain the Number

Never report or act on a metric until you can explain what drives it and have ruled out measurement artifacts.

1. **Separate failure modes:** Distinguish infrastructure/probe/timeout errors from genuine model or query failures (`probe_failed` vs. `query_failed`).
2. **Preserve coverage and caveats:** Report lower bounds, stale snapshots, or missing coverage explicitly—never fabricate zero costs or hide unmeasured slices.
3. **Rule out CI timing noise:** Never assert naive wall-clock ratios on shared runners; use deterministic counts, bundle budgets, or controlled comparisons.

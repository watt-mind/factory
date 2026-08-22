---
title: Non-Code Workloads
description: Running ops, alert remediation, and editorial pipelines
---

While software development is the initial product line, Factory's primitives apply to any verifiable workflow:

## Infrastructure Ops Loops

<iframe
  class="diagram-embed diagram-embed--loop"
  src="/factory/diagrams/concept-guides.html#non-code-ops-loop"
  title="Infrastructure operations loop"
  loading="lazy"
></iframe>

1. **Event:** A monitoring connector admits a disk-usage observation.
2. **Workspace:** The runtime creates an isolated workspace with a versioned input contract.
3. **Agent:** A data-only pack analyzes the supplied telemetry and proposes bounded remediation.
4. **Approval and action:** Operator-installed code may execute an approved cleanup under explicit capabilities.
5. **Verification:** A fresh observation proves whether usage crossed the target threshold.
6. **Receipt:** The runtime stores the evidence and outcome for the next event.

The included `packs/ops-disk` example is intentionally read-only: it analyzes telemetry but does not run commands or modify a host. This keeps the pack trust boundary honest while leaving mutation to an explicitly installed extension.

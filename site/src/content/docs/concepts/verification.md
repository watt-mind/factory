---
title: Verification as a Gate
description: Independent, falsifiable verification over agent self-attestation
---

In Factory, **an agent's own report is commentary; the exit code is the evidence.**

## Why Independent Verification?

A completion message cannot prove that the declared checks ran in the intended worktree. The worker therefore repeats verification outside the agent process.

Factory workers enforce an independent verification gate:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#verification-gate"
  title="Independent verification gate"
  loading="lazy"
></iframe>

1. The agent finishes writing code and calls its completion tool.
2. The orchestrator worker executes the ticket's exact `Verification Command` in the worktree.
3. If the command exits non-zero:
   - The run does **not** advance to a successful handoff.
   - Failure output and receipt data are retained.
   - Recovery policy decides whether the ticket is retried, returned to the queue, or held for a human.

## Writing Verification Commands

A robust verification command should verify both functionality and style:

```bash
bun test event-runtime/lib/dispatch.test.mjs && bun run format:check && bun run lint
```

## Negative Testing & Falsifiability

When authoring a regression test, observe it fail against the pre-fix implementation and pass after the fix. A test that already passes does not demonstrate the reported failure mode.

---
title: Owned Paths
description: Path-scoped concurrency keys for safer parallel agent execution
---

**Owned Paths** is the concurrency key in Factory. It defines the exact set of files and directories an agent is allowed to touch for a given ticket.

## The Rule of Disjoint Sets

Under the strict collision policy, two tickets can run concurrently only when their Owned Paths globs are disjoint:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#owned-paths"
  title="Owned Paths collision comparison"
  loading="lazy"
></iframe>

## Formatting Requirements

Owned Paths must be written as **one path or glob per bullet**:

```markdown
### Owned Paths

- event-runtime/lib/dispatch.mjs
- event-runtime/lib/dispatch.test.mjs
```

:::danger[Avoid comma-separated bullets]
The planner's parser keeps only bullets that look like a valid path without internal spaces. A bullet with comma-separated paths (`- foo.ts, bar.ts`) is dropped. If no valid paths remain, Factory treats the scope as unknown (`**`) and serializes the ticket rather than assuming it is safe to overlap.
:::

The behavior is policy-controlled through `dispatch.owned_paths_collision` in `config/policy.yaml`. Use `strict` when overlap must block dispatch; `advisory` records the overlap as evidence instead. Owned Paths remain the declared scope and audit boundary in either mode; strict conformance is required when they must also be an enforced write boundary.

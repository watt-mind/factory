---
title: Agent-Ready Tasks
description: The 5-section specification standard for dispatchable issues
---

A ticket is dispatchable only when it is in `Todo`, labeled `ai:agent-ready`, unassigned, and specific enough to implement safely. The specification uses five required sections:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#agent-ready"
  title="Agent-ready ticket structure"
  loading="lazy"
></iframe>

````markdown
### Problem & Context

Clear description of what is wrong or missing and why it matters.

### Acceptance Criteria

- [ ] Observable, falsifiable condition 1
- [ ] Observable, falsifiable condition 2

### Source File Pointers

- `path/to/source.ts` — explanation of what lives here
- `path/to/test.ts` — existing test file

### Owned Paths

- path/to/source.ts
- path/to/test.ts

### Verification Command

```bash
bun test path/to/test.ts && bun run lint
```
````

Owned Paths use one path or glob per bullet. The verification command must be runnable from the ticket worktree without relying on an agent's prior shell state.

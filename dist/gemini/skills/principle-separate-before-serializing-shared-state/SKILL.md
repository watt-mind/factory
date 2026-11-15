---
name: principle-separate-before-serializing-shared-state
description: "Apply when concurrent actors (tabs, taskpanes, worktrees, agents, cron jobs) might read/write the same token, file, database, or branch. Eliminate sharing first."
disable-model-invocation: true
---

# Separate Before Serializing Shared State

When concurrent actors touch the same resource, first ask whether they need to share it at all.

1. **Isolate ownership first:** Give each worktree its own DB and port band, each writer its own part-file, and each pane/session its own non-clobbering token or lease.
2. **Serialize only true invariants:** When a single shared writer is genuinely required (such as merging to a trunk branch or rotating a single upstream token), place it behind one explicit lock or coordinator.

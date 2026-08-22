---
title: Selected Project Conventions
description: A concise overview of the Factory operating baseline
---

The full project-conventions audit covers `PC-01` through `PC-20`. These are the most important day-to-day rules:

- **PC-01:** No bare sleeps (`sleep N`) — wait on observable conditions.
- **PC-02:** Strict Owned Paths containment.
- **PC-03:** Independent Verification Command execution.
- **PC-04:** No `git stash` or `--autostash` in worktrees.
- **PC-05:** Zero credentials or secrets in transcripts or diffs.
- **PC-06:** Conventional commit subjects referencing issue IDs.
- **PC-07:** Falsifiable regression tests that fail before the fix.

The current `AGENTS.md` operating floor is authoritative. Start with the [Protocol Contract](/factory/reference/protocol/) and treat this page as an overview, not a substitute for the live project policy.

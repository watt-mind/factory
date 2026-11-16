---
name: principle-foundational-thinking
description: "Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, or asking what concurrent actors share."
disable-model-invocation: true
---

# Foundational Thinking

Get the data structures and ownership boundaries right before writing control flow so downstream code becomes obvious.

1. **Name the data shape first.** Identify the canonical state, inputs, and outputs before writing handlers or helpers.
2. **Sequence scaffold before features.** Establish the schema, boundary parser, or test harness before layering features on top.
3. **Check concurrency early.** Ask what concurrent worktrees, tabs, cron jobs, or actors share before choosing where state lives.

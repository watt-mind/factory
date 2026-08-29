# janitor-scan — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
factory janitor --repo {repo} --json
```

Surveys the repository's configured worktree root on the worker host, matching
local directories against Linear issue states. Reports finished/canceled
reclaimable checkouts, active in-progress worktrees, and named worktrees without
deleting anything.

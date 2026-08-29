# warm — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
bun orchestrator/warm.mjs --repo {repo} --apply
```

Refreshes the repo's worktree warm-cache template (declared as
`worktree_warm` in config/repos.yaml): compiles once so that N ticket
worktrees don't each pay a full install and build. Mutates only the local
template cache on the worker host — it never touches Linear, GitHub, or any
live checkout. The generous timeout is a full cold build.

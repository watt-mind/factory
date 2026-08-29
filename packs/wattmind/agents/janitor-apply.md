# janitor-apply — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
factory janitor --repo {repo} --apply --json
```

Reclaims finished/canceled ticket worktrees in the repository's configured
worktree root on the worker host by executing the repository's `worktree_down`
script without `--force`. Preserves any checkout containing uncommitted or
unpushed work.

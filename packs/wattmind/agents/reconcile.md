# reconcile — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
bun orchestrator/reconcile.mjs --repo {repo} --apply
```

Reconciles Linear ticket state with what GitHub actually shows: a ticket
sitting `In Progress` whose own PR is already open moves to `In Review`
(freeing its dispatch slot), and one whose PR is merged moves on. Positive
evidence only — it never acts on silence (that is the reaper's question) and
never merges anything itself.

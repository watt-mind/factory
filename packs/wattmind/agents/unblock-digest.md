# unblock-digest — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
bun orchestrator/digest.mjs --repo {repo}
```

Read-only report of every `ai:blocked` ticket for the repo: the blocking
question, hold age, and ANSWERED markers where a reply already exists. Writes
nothing anywhere — the captured log is the deliverable, and the agent pass
that acts on holds (`unblock-scan`/`unblock-apply`) is a separate, watched
route.

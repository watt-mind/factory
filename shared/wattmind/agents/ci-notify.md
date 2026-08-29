# ci-notify — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
factory notify "CI RED {repo} run {runId}: {summary}"
```

Pushes the operator notification for a `TICKET` verdict from `ci-doctor@1` —
a real failure needing a human decision, per the notification protocol
(escalations only, never routine progress).

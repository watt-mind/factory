# merge-notify — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
factory notify "ESCALATED merge {repo}: {summary}"
```

Pushes the operator notification for an `ESCALATE` recommendation from
`merge-scan@1` — a PR whose diff changes security-relevant behavior (or
matches `escalate_paths`) needs the human decision, per the notification
protocol (escalations only, never routine progress). Same shape as
`ci-notify@1` for `ci-doctor@2`'s TICKET verdict.

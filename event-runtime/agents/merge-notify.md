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

## Result envelope

The deterministic command adapter, not this command, writes the completed
`factory.agent-result/v1` wrapper. Its `artifact` is the
`factory.command-result/v1` value validated by this definition's registered
output schema:

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "command": [
      "factory",
      "notify",
      "ESCALATED merge factory: PR needs a human decision"
    ],
    "exitCode": 0,
    "outputTail": "Notification sent."
  },
  "evidence": {
    "command": [
      "factory",
      "notify",
      "ESCALATED merge factory: PR needs a human decision"
    ],
    "outputTail": "Notification sent."
  }
}
```

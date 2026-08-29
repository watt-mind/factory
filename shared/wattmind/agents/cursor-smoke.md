# cursor-smoke — smoke test for the Cursor Agent CLI adapter

`./input.json` names one `message` string. Read it and write `./result.json`
echoing it back unchanged. This is a wiring smoke test (WM-440), not a real
task — do nothing else: no other tool calls, no file writes beyond
`./result.json`.

## Output

Write `./result.json`:

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": { "echo": "<input.json's message, unchanged>" },
  "evidence": { "commands": [] }
}
```

# agy-smoke — smoke test for the agy (Antigravity) adapter

`./input.json` names one `message` string. Read it and write `./result.json`
echoing it back unchanged. This is a wiring smoke test (WM-424), not a real
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

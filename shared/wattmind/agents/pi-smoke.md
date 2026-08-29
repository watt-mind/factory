# pi-smoke — read-only smoke test for the pi adapter

`./input.json` names one `message` string. Read it and write `./result.json`
echoing it back unchanged. This is a wiring smoke test (OPS-517), not a real
task — do nothing else: no other tool calls, no file writes beyond
`./result.json`.

Known gap (OPS-518): pi's `mutating: false` path (`lib/adapters/pi.mjs`
`READ_ONLY_TOOLS`) currently omits `write` entirely, so a live run against
this definition cannot produce `./result.json` yet — confirmed against the
real pi CLI while building this agent. The route itself (registry,
event-type, worker dispatch) is proven by the fake-shim test in
`cli.test.mjs`; this agent will run end-to-end once OPS-518 is fixed.

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

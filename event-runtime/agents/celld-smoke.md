# celld-smoke — smoke agent for celld Durable Objects runtime

`./input.json` provides:

- `cellId`: The target cell identifier.
- `endpoint`: celld HTTP/RPC endpoint (defaults to `http://127.0.0.1:9876`).
- `testKey`: Entity ID key to persist under collection `smoke_tests`.
- `testData`: JSON payload to write and read back.

This is a wiring and durable cell storage verification agent.

## Steps

1. Read `./input.json`.
2. Connect to the specified `cellId` on the given `endpoint` via `CellClient` or HTTP REST/RPC.
3. Fetch `/v1/schema` to verify cell accessibility.
4. Ensure migration `001_celld_smoke_init` is applied (`CREATE TABLE IF NOT EXISTS smoke_records (id TEXT PRIMARY KEY, value TEXT);`).
5. Persist `testData` into collection `smoke_tests` with ID `testKey` using optimistic locking (`expectedVersion: 0` for initial write, or current version).
6. Read back the entity from collection `smoke_tests` with ID `testKey` to assert exact data matching.
7. Write `./result.json`.

## Output

Write `./result.json`:

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "cellId": "<input.json's cellId>",
    "cellVersion": 2,
    "migrated": true,
    "entityVersion": 1,
    "verified": true
  },
  "evidence": { "commands": [] }
}
```

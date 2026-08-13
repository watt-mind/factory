# run-postmortem — explain why one run failed, from its own transcript

`./input.json` names a run of this runtime:

```json
{ "runId": "run_...", "runPin": { "runId": "run_...", "transcript": "<40+ hex>", "state": "FAILED", "agent": "ci-doctor@2" } }
```

`./transcript.json` is **that run's captured agent transcript**, materialized
from the artifact store by content hash — the exact bytes the agent produced,
not a summary. Read it and write `./result.json`. You are read-only: you never
retry, cancel, or modify anything. Work only inside this directory.

## Method

1. Read `./transcript.json`. It is the adapter's structured capture of the
   agent's session.
2. Find where the run actually went wrong — the first real failure, not the
   symptoms after it. Distinguish these plainly:
   - the **agent misunderstood its task** (prompt or contract problem),
   - the **agent did its job and the world refused** (a tool errored, a
     service was down, permissions),
   - the **output violated its contract** (schema, hashes, evidence),
   - the run was **cut short** (timeout, cancellation).
3. Say what an operator should do about it, in one actionable sentence. If the
   right answer is "nothing, retry it", say that.

## Output

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "runId": "run_...",
    "category": "agent_error | environment | contract_violation | cut_short | unclear",
    "whatHappened": "one plain sentence",
    "operatorAction": "one actionable sentence",
    "evidenceLines": ["the transcript lines this rests on"]
  },
  "evidence": { "transcriptBytes": 12345 }
}
```

If the transcript is empty, unreadable, or shows nothing conclusive, use
`category: "unclear"` and say so — a confident wrong story about a failure is
worse than admitting the transcript does not explain it.

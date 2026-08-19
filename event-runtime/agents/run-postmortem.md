# run-postmortem — explain why one run failed, from its own transcript

`./input.json` names a run of this runtime:

```json
{
  "runId": "run_...",
  "runPin": {
    "runId": "run_...",
    "transcript": "<40+ hex>",
    "state": "FAILED",
    "agent": "ci-doctor@2"
  }
}
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
    "evidenceLines": ["the transcript lines this rests on"],
    "memos": [
      {
        "subject": { "type": "ticket", "id": "WM-313" },
        "kind": "postmortem",
        "body": "Attempt 1 timed out running the full suite (`bun test`) inside verification; the ticket's Verification Command scopes to event-runtime/lib. Run the scoped command, not the full suite.",
        "bindings": { "descriptionHash": "sha256:…" }
      }
    ]
  },
  "evidence": { "transcriptBytes": 12345 }
}
```

If the transcript is empty, unreadable, or shows nothing conclusive, use
`category: "unclear"` and say so — a confident wrong story about a failure is
worse than admitting the transcript does not explain it.

When the failed run's transcript or captured input names a Linear ticket
(`CLNT-123`, `WM-313`, …), emit **one** `postmortem` memo on that ticket.
`body` is the agent-facing distillation for the next dispatch ("do not X;
the scoped command is Y") — keep `operatorAction` for the human. Include
`bindings.descriptionHash` only when the transcript actually carries the
ticket description hash; omit `bindings` rather than guessing. If the failed
run has no Linear ticket, omit `memos`. Never write a memo about a ticket
this run was not analysing.

---
name: factory-handoff
description: Hand one exact agent-ready ticket to the central Factory runtime over the configured SSH forced-command boundary. Use when an operator asks to hand off an existing ticket or a prose request instead of implementing it in the current session.
---

# Remote Factory handoff

Handoff means **capture/specify here, execute centrally**. Never claim the ticket, create a worktree, spawn an implementation subagent, or begin the implementation in this session.

## Existing ticket identifier

1. Resolve the current repository through Factory's configured repo registry.
2. Read the ticket and confirm it is dispatchable: `Todo`, `ai:agent-ready`, unassigned, and complete under the five-section protocol (Problem & Context, Acceptance Criteria, Source File Pointers, Owned Paths, Verification Command). Do not "repair" an ambiguous ticket by guessing.
3. If it is not ready, apply the `ticket-spec` skill: explore read-only, complete only derivable sections, verify the command exists/runs, and promote only when the specification is falsifiable. A genuine product decision remains Triage and is not handed off.
4. Run the mechanical client with the canonical ticket identifier:

   ```sh
   factory handoff --repo <configured-short-name> <ticket>
   ```

   The repo flag may be omitted when cwd is inside the configured checkout or one of its worktrees. GitHub tickets use `OWNER/REPO#N`; Linear tickets use `TEAM-N`.

5. Return the machine receipt's admission/duplicate disposition, event/proposal/run state, and dashboard URL. A watched/refused result is a safe outcome, not permission to start locally.

## Prose request

Follow the existing capture and specification protocols before handoff:

1. Search for duplicates and use the existing ticket when one covers the request.
2. Otherwise file exactly one meaningful ticket with `source:human`, the correct repo/team/project and taxonomy, and the five complete sections only when supported by code evidence.
3. Use `ticket-spec` to fill derivable gaps. If intent or credentials are missing, leave it in Triage and report what is needed; do not hand it off yet.
4. Once the ticket is `Todo` + `ai:agent-ready` + unassigned, invoke `factory handoff` as above.

## Checking run progress and traces

When an operator asks for the status of a handed-off ticket or wants to inspect execution:

1. **Query receipt state via request ID** (idempotent; returns event, proposal, and run status):

   ```sh
   factory handoff --request-id <requestId> [--repo <repo>] <ticket>
   ```

2. **Check the ticket on the control plane**:

   ```sh
   factory ticket get [--repo <repo>] <ticket>
   ```

3. **Inspect run details, token usage, and lifecycle history on the runner**:

   ```sh
   ssh runner "factory events inspect <runId>"
   ```

4. **Stream or view the agent execution trace**:

   ```sh
   ssh runner "factory events trace <runId> | tail -n 50"
   ```

5. **Web dashboard**: `https://factory.whale-pike.ts.net`

## Retry rule

The client creates a unique request ID. If transport failed after the request may have reached the server, retry with the **same** ID so admission deduplicates:

```sh
factory handoff --request-id <original-id> --repo <repo> <ticket>
```

Never use `factory dispatch`, `/replay`, direct HTTP, a caller-selected `source`, or a local implementation agent as a substitute. The client sends only `{schemaVersion, requestId, repo, ticket}` and does not possess the runtime signing secret.

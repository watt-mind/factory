# merge-scan — ledger enumerator (not a reviewer)

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
bun {factoryRoot}/event-runtime/lib/merge-reviews.mjs scan
```

The command reads `./input.json` and writes `./result.json`. It lists open PRs
via the forge, looks each `(github, pr, headSha)` up in the `merge_reviews`
ledger (`baseSha` is recorded, not part of the key), and emits `reviews[]` only
for misses — a moved head. A moved base with the same head is a hit. A selected
scan (`prNumbers`) forces a review even on a ledger hit. For a hit whose live
state is CONFLICTING or BEHIND (or whose recorded `baseSha` differs from the
live base tip), emit an operational `rebase_onto_base` item in `fix[]` with
`mechanical: true`, `withinOwnedPaths: true`, and `round` from the ledger; do
not start a review run. Do not emit a review item when an open, queued, or
running `merge-review@1` proposal or run already exists at the same
`(pr, headSha)`. MERGE ledger hits are not stubbed into `plan[]` — they are
queued as `planRequests[]` so `merge-plan@1` can batch them. `plan[]` on a
scan artifact is always empty.

When `prNumbers` is absent, enumerate **all** open PRs and consider every
base-targeting, non-draft PR. Emit an `escalate[]` item for every non-draft PR
with an identifiable ticket that targets a different base, and name every
wrong-base PR and its actual/expected bases in the summary rather than silently
excluding it; this is a dispatch/handoff escape that needs an operator to
retarget or close. When `prNumbers` is present, review exactly those
PR numbers in the listed repo — do not enumerate the open-PR set and do not add
newer, related, or otherwise open PRs to the scan. Selected scans must stay
O(the number selected), normally O(1).

Resolve every selected number directly, including numbers absent from an
open-PR listing. A selected PR that is missing, closed, draft, or targets a
base other than the configured base fails the whole selected scan closed. Write
a schema-valid refusal with `terminalState: "refused"` and
`reasonCode: "needs_human"`, with evidence clearly naming every invalid
selected PR and whether it is missing, closed, draft, or wrong-base. Do not
emit a merge-plan artifact, FIX request, or merge candidate when any selected
target is invalid. This whole-run refusal is the explicit human escalation;
never silently skip an invalid selected number.

Transient forge errors (list/view/base SHA) complete as `NOOP` with a summary
naming the error, not as a per-PR human escalation — the next tick retries.

Never modify the checkout, GitHub, or Linear. Write only `./result.json` in the
workspace root.

If the named repo's configuration is missing or malformed, fail closed with
this complete result and stop:

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "refused",
  "reasonCode": "needs_human"
}
```

## Result envelope

`./result.json` must always be a `factory.agent-result/v1` wrapper. On a
completed scan, put the complete `factory.merge-plan/v2` merge plan under
`artifact`, never at the wrapper root. This is the required nesting (the
values shown are only a valid NOOP example; emit the result of the actual
review):

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "recommendation": "NOOP",
    "repo": "factory",
    "github": "watt-mind/factory",
    "base": "develop",
    "deployBranch": "master",
    "reviews": [],
    "plan": [],
    "fix": [],
    "escalate": [],
    "summary": "No open pull requests target the configured base branch.",
    "noopReason": "no_open_prs"
  },
  "evidence": {
    "commands": []
  }
}
```

Do not place `recommendation`, `repo`, `github`, `base`, `deployBranch`,
`reviews`, `plan`, `fix`, `escalate`, `summary`, or `noopReason` beside
`schemaVersion`; all merge-plan fields belong inside `artifact`. Never omit
`terminalState`. For any refusal, use the fail-closed wrapper shown above
rather than writing a partial merge plan. A selected-target refusal must
additionally include the evidence required above.

After producing the artifact, do nothing else. In particular, never approve,
merge, push, mark Done, or delete a branch.

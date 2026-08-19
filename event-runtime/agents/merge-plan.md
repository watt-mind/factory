# merge-plan — deterministic batch planner

This is a closed action definition, not a model prompt. It executes a fixed
command template through the deterministic command adapter
(`lib/adapters/command.mjs`). No model runs.

```
bun {factoryRoot}/event-runtime/lib/merge-reviews.mjs plan
```

The command reads `./input.json` and writes `./result.json`. It lists live
open, non-draft, base-targeting PRs, looks each `(github, pr, headSha, baseSha)`
up in the `merge_reviews` ledger, and keeps only MERGE-verdict hits whose live
head is still MERGEABLE, required CI is green (`merge-ci-proof.mjs`), and
neither GitHub nor Linear holds an escalation/security/Blocked flag. Those
candidates are ordered by PR number and truncated to `policy.merge.batch_size`
(default 4). Zero candidates is a NOOP with reason.

Never modify the checkout, GitHub, or Linear. Write only `./result.json` in
the workspace root.

## Result envelope

`./result.json` is always a `factory.agent-result/v1` wrapper. On a completed
plan, put the `factory.merge-plan/v2` artifact under `artifact`. A nonempty
`plan[]` chains one `factory.merge-apply.requested`. An empty `plan[]` is a
NOOP and emits nothing.

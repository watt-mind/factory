# merge-apply — deterministic batched landing

This is a closed command definition, not a model prompt. Its input contains
a schema-validated `plan[]` of `merge_pr` items from `merge-plan@1` (size 1
through `policy.merge.batch_size`). Immediately before each squash, the
command re-reads that PR's head and base SHA, exact branch names,
open/draft/mergeable state, GitHub and Linear holds, and required CI. A
stale, unmergeable, held, or red item is **skipped with a reason**; the rest
of the batch continues. Only `develop` is auto-mergeable.

The command uses `--match-head-commit`, never deletes a branch, never tears
down a worktree, and never marks Linear Done.

After GitHub proves each successful squash is MERGED, the command records
that item's exact merge SHA. One idempotent `factory.merge-landed` event is
emitted for the whole batch, carrying `landed[]` (`pr`, `ticket`, `headSha`,
`mergeSha`, `headRef`) plus `finalSha` (the last successful merge SHA). That
event is the only path to merge verification. If nothing landed, a refresh
`factory.merge.requested` is emitted so skipped items can be re-planned.
Uncertain merge (squash succeeded but SHA unreadable) fails the run when
nothing has landed yet; after earlier successes it skips the remainder.

```
bun {factoryRoot}/event-runtime/lib/merge-apply.mjs
```

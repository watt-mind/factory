# merge-apply — deterministic one-PR landing

This is a closed action definition, not a model prompt. Its input contains
exactly one schema-validated `merge_pr` item from an independent cold scan.
Immediately before merging, the fixed command re-reads the PR head and base
SHA, exact branch names, open/draft/mergeable state, GitHub and Linear holds,
and real required CI. Any stale, missing, red, unknown, or ambiguous fact
fails closed; moved head/base evidence emits a durable fresh merge scan.

Only `develop` is accepted. Policy auto-approval separately requires an
allowed owner/base and rejects main/master, deploy branches, sensitive or
ambiguous reviews. The command uses `--match-head-commit`, never deletes the
branch, never tears down a worktree, and never marks Linear Done.

After GitHub proves the PR is MERGED, the command reads its exact merge commit
and injects one idempotent `factory.merge-landed` event. That event is the only
path to merge verification. A failure after the merge but before durable event
admission is reported as uncertain and must be recovered before another merge;
it is never treated as success.

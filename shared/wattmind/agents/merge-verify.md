# merge-verify — exact batched landing gate

This is a deterministic command, not a model prompt. A durable
`factory.merge-landed` event pins `landed[]` (each PR, original head/branch,
ticket, merge SHA) and `finalSha` (the batch's last merge commit).

The command first proves GitHub still reports every landed PR as MERGED at
its recorded merge SHA. It then polls with bounded deadlines for check-runs
on **`finalSha` only** and, when the repo config declares `smoke_workflow`,
that workflow on the same commit. Missing, red, cancelled, stale, or
uncertain evidence fails closed.

**Green:** for every ticket in `landed[]`, run the repo-owned worktree
teardown for that ticket, verify the remote head branch still points at the
merged head SHA, refuse protected branch names, delete exactly that ref, and
mark the ticket Done. Then inject the next merge scan. Replays are
idempotent at event admission.

**Red:** the existing CI/SMOKE RED handling runs for **every** ticket in
`landed[]` (block + notify). Branches and worktrees are preserved. The merge
barrier stays held. Apply never marks Done or deletes a branch.

```
bun {factoryRoot}/event-runtime/lib/merge-verify.mjs
```

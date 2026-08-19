# Merge lane

The factory merge lane reviews open base-targeting PRs, applies mechanical
fixes, and lands already-reviewed MERGE PRs in small batches under a single
writer. This document is the v3 shape (WM-907 / WM-936 / WM-908 / WM-906): a durable
review ledger, per-PR reviews, a deterministic merge-plan, and batched
apply/verify. `concurrency.max_concurrent_merges` stays 1.

## Flow

1. **`factory.merge.requested`** → `merge-scan@2` (command enumerator).
   Lists open, non-draft, base-targeting PRs with live head/base SHAs. Looks
   each `(github, pr, headSha)` up in `merge_reviews`. Emits `reviews[]` for
   ledger **misses** (moved head) only. A moved base with the same head is a
   hit. Hits that are CONFLICTING/BEHIND emit an operational
   `rebase_onto_base` `fix[]` item (no review run). A selected scan
   (`prNumbers`) forces a review even on a hit. In-flight `merge-review@1`
   proposals/runs at the same head are not re-emitted. MERGE hits are **not**
   stubbed into `plan[]`; they become `planRequests[]` so planning can batch
   them.
2. **`factory.merge-review.requested`** → `merge-review@1` (agy, one PR).
   Same rubric, CI proof resolver, and refusal semantics as the old batch
   scan. Writes `factory.merge-review/v1`. On COMPLETED the worker upserts
   `merge_reviews`. FIX and ESCALATE chain immediately; MERGE is recorded
   for the planner.
3. **`factory.merge-plan.requested`** → `merge-plan@1` (command, no model).
   Reads the ledger, re-checks live mergeability / required CI / GitHub and
   Linear holds, orders candidates by PR number, and takes up to
   `policy.merge.batch_size` (default 4). Emits one
   `factory.merge-apply.requested` with that `plan[]`. Zero candidates is a
   NOOP (`noopReason: no_merge_candidates`).
4. **`factory.merge-fix.requested`** → `merge-fix@1`. On `UPDATED`, chains to
   `factory.merge-review.requested` for that PR's new head — not a full scan.
5. **`factory.merge-apply.requested`** → `merge-apply@2` (command). Lands each
   plan item in order. Re-checks mergeable + head SHA immediately before
   `gh pr merge --squash`. A conflicted or stale item is skipped with a
   reason; the batch continues. One `factory.merge-landed` carries `landed[]`
   (`pr`, `ticket`, `headSha`, `mergeSha`, `headRef`) plus `finalSha`.
6. **`factory.merge-landed`** → `merge-verify@1` (command). Proves every
   landed PR still reports its merge SHA. Polls check-runs (and
   `smoke_workflow` when configured) on **`finalSha` only**. Green: delete
   each head ref, mark each ticket Done, release the barrier, inject the next
   scan. Red: existing CI RED handling for **every** ticket in `landed[]`
   (block + notify, branches preserved); the barrier stays held.

A second scheduled tick with no **head** movement emits **zero** review runs:
every open PR is a ledger hit (a develop merge that only moves `base_sha` is
not a miss). Behind/conflicting hits emit mechanical rebase fixes instead.
Planning still runs when MERGE hits exist. `reviews[]` stays empty and the
command enumerator returns in seconds.

## Ledger

Table `merge_reviews` in `runtime.db`, keyed
`(github, pr, head_sha)`. `base_sha` is recorded so the enumerator can see
that the base moved; it is not part of the key. A moved head is a miss.
Columns:

| column           | meaning                                        |
| ---------------- | ---------------------------------------------- |
| `verdict`        | `MERGE` \| `FIX` \| `ESCALATE`                 |
| `findings_json`  | reviewer findings                              |
| `fix_json`       | the `fix[]` item shape merge-scan used to emit |
| `plan_json`      | the per-PR plan assertions a MERGE needs       |
| `policy_version` | run policy pin                                 |
| `run_id`         | the `merge-review@1` run that wrote the row    |
| `reviewed_at`    | ISO time                                       |

Helpers: `event-runtime/lib/merge-reviews.mjs`.

## Batching

`config/policy.yaml`:

```yaml
merge:
  batch_size: 4 # PRs per apply/verify cycle
concurrency:
  max_concurrent_merges: 1 # one writer; do not raise
```

Six green MERGE PRs at `batch_size: 4` land 4 on the first cycle and 2 on
the next. An item that becomes unmergeable after an earlier squash in the
same batch is skipped and re-planned. Batch CI red on `finalSha` blocks
every ticket in `landed[]` and keeps the barrier.

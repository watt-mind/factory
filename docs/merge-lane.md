# Merge lane

The factory merge lane reviews open base-targeting PRs, applies mechanical
fixes, and lands at most one PR per base-CI cycle. This document is the v3
shape (WM-907 / WM-906): a durable review ledger plus per-PR reviews, with
landing still serialized until part 2.

## Flow

1. **`factory.merge.requested`** → `merge-scan@2` (command enumerator).
   Lists open, non-draft, base-targeting PRs with live head/base SHAs. Looks
   each `(github, pr, headSha, baseSha)` up in `merge_reviews`. Emits
   `reviews[]` for ledger **misses** only. A selected scan (`prNumbers`)
   forces a review even on a hit. Stub `plan[]` is today's single lowest
   MERGE candidate already in the ledger, so one PR can still land per cycle.
2. **`factory.merge-review.requested`** → `merge-review@1` (agy, one PR).
   The body of the old batch merge-scan: same rubric, same CI proof resolver,
   same refusal semantics. Writes `factory.merge-review/v1`. On COMPLETED the
   worker upserts `merge_reviews`. FIX and ESCALATE chain immediately; MERGE
   is recorded for the enumerator's plan stub.
3. **`factory.merge-fix.requested`** → `merge-fix@1`. On `UPDATED`, chains to
   `factory.merge-review.requested` for that PR's new head — not a full scan.
4. **`factory.merge-apply.requested`** / landed / verify are unchanged.

A second scheduled tick with no SHA movement emits **zero** review runs: every
open PR is a ledger hit, so `reviews[]` is empty and the command enumerator
returns in seconds.

## Ledger

Table `merge_reviews` in `runtime.db`, keyed
`(github, pr, head_sha, base_sha)`. A moved head is a miss. Columns:

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

## Out of scope (part 2)

Batching and parallel landing. Until that lands, the enumerator still emits at
most one `merge-apply.requested` from the ledger's lowest MERGE candidate.

# merge-fix — bounded mechanical correction on an existing PR

`input.json` is one SHA-pinned mechanical finding. `./repo` is the repo-owned
isolated worktree for the ticket. This is not a general implementation run.

1. Read the ticket and all comments. Re-read the PR head/base and required
   checks. Refuse if head SHA, base SHA, ticket, branch, finding hash, or PR
   identity moved; stale evidence requires a fresh independent scan.
2. Confirm the finding is mechanical, round is 1 or 2, and no
   security/product/policy judgment is involved. Otherwise move the ticket to
   Blocked, notify when policy requires, and output BLOCKED without editing.
   Owned Paths bound the _correction_, not the _rebase_ (WM-679):
   - `format_and_lint`: compute the PR file set once with
     `git diff --name-only --diff-filter=ACMR -z origin/<base>...HEAD`. Pass
     that NUL-delimited set, and no repository-wide path, to both fixers:

     ```sh
     changed=$(mktemp)
     git diff --name-only --diff-filter=ACMR -z origin/<base>...HEAD >"$changed"
     xargs -0 -r bunx prettier --write --ignore-unknown <"$changed"
     xargs -0 -r bunx eslint --fix --no-warn-ignored <"$changed"
     rm -f "$changed"
     ```

     Do not make judgment-based source edits under this finding. Re-run the
     ticket's exact Verification Command, push, and let the next independent
     scan establish green. This deterministic correction does not consume a
     `max_fix_rounds` round.

   - `rebase_onto_base` / `rerun_ci_at_head`: rebase the head branch onto the
     current base. Resolve conflicts faithfully to both sides, reading the
     surrounding code; the files git reports as conflicting are in scope for
     the resolution regardless of the ticket's Owned Paths, because a rebase
     touches what the base touched. Never `git stash` or `--autostash`. If a
     hunk is genuinely ambiguous — two real behaviours, no way to keep both —
     that is the one case to BLOCK with the hunk named. After every rebase,
     run the same changed-file-only prettier and eslint commands described for
     `format_and_lint`, then re-run verification and push with
     `--force-with-lease`. Formatting drift after a rebase is predictable, so
     never push the rebased branch before this hygiene step.
   - A finding that names an Owned Paths deviation (an expectation outside the
     ticket's paths that the PR's own change invalidated): make that one
     correction, and record the deviation on the ticket in your comment.
   - Any other change outside the supplied Owned Paths and the ticket's live
     Owned Paths: BLOCK.
3. Move the ticket from In Review to In Progress. Check out the existing PR
   head branch at the pinned SHA. Make only the smallest correction, add or
   update a falsifiable regression test where the finding is a code change (a
   pure rebase adds none), and run the ticket's exact Verification Command.
   Never weaken or skip it.
4. Commit with the ticket ID and push the same head branch. For ordinary
   findings, add a PR comment exactly
   `factory-merge-fix round=<round> finding=<findingHash> old=<oldSha>
new=<newSha>`. For `format_and_lint`, use the non-round marker exactly
   `factory-merge-fix mechanical=format_and_lint finding=<findingHash>
old=<oldSha> new=<newSha>`. Do not merge, approve, mark Done, or delete
   anything.
5. Return UPDATED with the new 40-hex head SHA. Completion chains to a wholly
   new merge-scan run. You are forbidden to declare your own update mergeable.

If the branch cannot be reconstructed safely, verification fails, a change
beyond the finding is out of scope, or any evidence is uncertain, preserve
the worktree/branch, block the ticket with one answerable reason, and return
BLOCKED.

## Result contract

Write `result.json` as a completed `factory.agent-result/v1` wrapper. Put the
`factory.merge-fix-result/v1` value under its `artifact` property: the
registered output schema validates that nested artifact, not the wrapper.
Both artifacts (the nested `artifact` values in the UPDATED and BLOCKED
examples) must contain exactly these properties, in this order: `outcome`,
`repo`, `ticket`, `pr`, `headSha`, `round`, `summary`. Do not put those fields
beside `schemaVersion`, `terminalState`, or `reasonCode`, and do not add
diagnostic artifact properties; put the reason or change description in
`summary`.

Copy `repo`, `ticket`, `pr`, and `round` from `input.json`. Substitute the real
values for the representative values below.

### UPDATED result envelope

Emit exactly this wrapper shape (never the bare `artifact` object). Use the new
commit SHA that was successfully pushed as `artifact.headSha`:

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "outcome": "UPDATED",
    "repo": "factory",
    "ticket": "WM-500",
    "pr": 42,
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "round": 1,
    "summary": "Applied the mechanical correction, verified it, and pushed the updated head."
  },
  "evidence": {
    "commands": []
  }
}
```

### BLOCKED result envelope

Emit exactly this wrapper shape (never the bare `artifact` object). Use the
pinned `input.json` `headSha` as the required `artifact.headSha`, including when
the live PR head moved. Describe the observed mismatch or other blocking reason
only in `artifact.summary`:

```json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "outcome": "BLOCKED",
    "repo": "factory",
    "ticket": "WM-500",
    "pr": 42,
    "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "round": 1,
    "summary": "Blocked because the live PR head no longer matches the pinned input head."
  },
  "evidence": {
    "commands": []
  }
}
```

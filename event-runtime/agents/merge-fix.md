# merge-fix — bounded mechanical correction on an existing PR

`input.json` is one SHA-pinned mechanical finding. `./repo` is the repo-owned
isolated worktree for the ticket. This is not a general implementation run.

1. Read the ticket and all comments. Re-read the PR head/base and required
   checks. Refuse if the ticket, PR identity, branch, finding hash, or base
   identity moved. A changed PR head is not by itself a refusal for an
   operational rebase: handle it with the concurrent-head protocol below so a
   fixer cannot be erased. Other stale evidence requires a fresh independent
   scan.
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

   - `rebase_onto_base` / `rerun_ci_at_head`: first fetch both the PR branch
     and base, record the fetched PR tip as `expectedRemoteSha`, and keep that
     exact value for the push lease:

     ```sh
     git fetch --no-tags origin \
       "+refs/heads/<headRef>:refs/remotes/origin/<headRef>" \
       "+refs/heads/<base>:refs/remotes/origin/<base>"
     expectedRemoteSha=$(git rev-parse "origin/<headRef>")
     ```

     Before either rebase, query check runs on that exact
     `expectedRemoteSha` (not a branch-name lookup). If `Full verification` is
     `QUEUED` or `IN_PROGRESS`, return `outcome: "BLOCKED"` with a summary
     beginning `ci_in_flight:` and do not edit or push. Also leave the branch
     alone when that check concluded `SUCCESS` within
     `FACTORY_MERGE_REBASE_SKIP_FRESH_CI_MINUTES` (default `60`) minutes,
     returning a summary beginning `ci_fresh:`. For example, inspect the
     exact head with:

     ```sh
     gh api "repos/<github>/commits/${expectedRemoteSha}/check-runs?per_page=100"
     ```

     A `CONFLICTING` PR still needs a rebase even when CI is running or fresh.
     Query the live PR labels too (`gh pr view <pr> --repo <github> --json
labels`); an `ai:landing` label always blocks this mechanical rebase with
     a summary beginning `ai_landing:`. Treat an
     unreadable check response conservatively as `ci_in_flight:` rather than
     risking an external lander's branch.

     Compare `expectedRemoteSha` with the pinned `input.json` `headSha`. Only
     when they differ, query the live PR with
     `gh pr view <pr> --repo <github> --json headRefOid,updatedAt`. Refuse with
     `branch_moved:` before editing if that live head no longer equals
     `expectedRemoteSha`. A differing fetched head proves another actor moved
     the branch because this run has not pushed yet; do not substitute commit
     author/committer metadata, which does not identify who pushed or when.
     Treat the PR's `updatedAt` as a conservative upper bound on the head-change
     time. If it is within `MERGE_FIX_IN_FLIGHT_MINUTES` (default `10`), do not
     touch or push the branch. Return `outcome: "BLOCKED"` and a `summary`
     beginning `branch_in_flight:` instead of racing the active fixer. Treat an
     unknown live head or timestamp as in flight; validate the optional minute
     value as a positive integer before using it. Never classify the unchanged
     pinned head as `branch_in_flight`. PR activity other than a push can only
     make this conservative check wait longer; it cannot allow a clobber.

     If `expectedRemoteSha` is not an ancestor of local `HEAD`, someone pushed
     commits the worktree does not contain. Rebase local work **on top of** the
     fetched remote branch first (`git rebase "origin/<headRef>"`), then rebase
     onto `origin/<base>`; never reconstruct the branch by replaying only this
     run's original dispatch commit. This preserves foreign commits even when
     the local and remote histories diverged. Resolve conflicts faithfully to
     both sides, reading the surrounding code; the files git reports as
     conflicting are in scope for the resolution regardless of the ticket's
     Owned Paths, because a rebase touches what the base touched. Never stash
     changes or use `--autostash`. If a hunk is genuinely ambiguous — two real
     behaviours, no way to keep both — that is the one case to BLOCK with the
     hunk named. After every rebase, run the same
     changed-file-only prettier and eslint commands described for
     `format_and_lint`, then re-run verification. Push exactly once with the
     fetched-tip lease:

     ```sh
     git push origin "HEAD:refs/heads/<headRef>" \
       "--force-with-lease=<headRef>:${expectedRemoteSha}"
     ```

     A lease failure means another writer moved the branch after the fetch:
     make no retry push, return `outcome: "BLOCKED"` with a `summary` beginning
     `branch_moved:`, and leave the remote branch untouched. The stable summary
     prefix is the structured reason because this agent's exact-property
     result schema has no separate reason field. Formatting drift after a
     rebase is predictable, so never push the rebased branch before this
     hygiene step.

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
4. Commit with the ticket ID and push the same head branch. Post a
   human-readable Markdown PR comment with the actual finding and a concise
   summary of the correction. For ordinary findings, render this shape (the
   short SHAs are the first seven characters of the full SHAs):

   ```md
   ### 🛠️ Factory Merge Auto-Fix (Round <round> of <max_fix_rounds>)

   **Finding:** <finding description>
   **Changes:** <summary of changes made>
   **Commit:** `<oldSha first 7>` → `<newSha first 7>`

   <!-- factory-merge-fix round=<round> finding=<findingHash> old=<oldSha> new=<newSha> -->
   ```

   `<max_fix_rounds>` is the configured `merge.max_fix_rounds` cap (the same
   value merge-review enforces; default 2), never a hardcoded number. The
   embedded HTML comment is the machine-readable tracking marker: preserve
   its complete, exact field order and substitute the real full values. For
   `format_and_lint`, retain its non-round marker inside an otherwise
   human-readable comment (finding, changes, and short commit SHAs):

   ```md
   ### 🛠️ Factory Merge Auto-Fix (Formatting & Lint)

   **Finding:** <finding description>
   **Changes:** <summary of changes made>
   **Commit:** `<oldSha first 7>` → `<newSha first 7>`

   <!-- factory-merge-fix mechanical=format_and_lint finding=<findingHash> old=<oldSha> new=<newSha> -->
   ```

   Do not merge, approve, mark Done, or delete anything.

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

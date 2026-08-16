# merge-fix — bounded mechanical correction on an existing PR

`input.json` is one SHA-pinned mechanical finding. `./repo` is the repo-owned
isolated worktree for the ticket. This is not a general implementation run.

1. Read the ticket and all comments. Re-read the PR head/base and required
   checks. Refuse if head SHA, base SHA, ticket, branch, finding hash, or PR
   identity moved; stale evidence requires a fresh independent scan.
2. Confirm the finding is mechanical, round is 1 or 2, the change is wholly
   within the supplied Owned Paths and the ticket's live Owned Paths, and no
   security/product/policy judgment is involved. Otherwise move the ticket to
   Blocked, notify when policy requires, and output BLOCKED without editing.
3. Move the ticket from In Review to In Progress. Check out the existing PR
   head branch at the pinned SHA. Make only the smallest correction, add or
   update a falsifiable regression test, and run the ticket's exact
   Verification Command. Never weaken or skip it.
4. Commit with the ticket ID, push the same head branch, and add a PR comment
   exactly `factory-merge-fix round=<round> finding=<findingHash> old=<oldSha>
new=<newSha>`. Do not merge, approve, mark Done, or delete anything.
5. Return UPDATED with the new 40-hex head SHA. Completion chains to a wholly
   new merge-scan run. You are forbidden to declare your own update mergeable.

If the branch cannot be reconstructed safely, verification fails, a path is
out of scope, or any evidence is uncertain, preserve the worktree/branch,
block the ticket with one answerable reason, and return BLOCKED.

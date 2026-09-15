Ship the current release: merge everything on the integration branch to the deploy branch. My invoking this command **is** the human `master` decision — the one call the autonomous loop never makes on its own. That means you carry it through to a verified deploy or a clear stop; don't hand it back to me half-done.

Interpret `$ARGUMENTS` as a repo name from `config/repos.yaml` (run from that repo's checkout); default is the repo you're standing in.

## 1. Pre-flight — run the command, don't re-derive it

**Start here, always:**

```bash
factory ship-preflight --repo <name>      # read-only; exit 0 means shippable
```

It prints one PASS / FAIL / SKIP line per check and, on every FAIL, the exact command that fixes it. Do not proceed past a FAIL, and do not substitute your own reading of `gh run list` for it — this command exists because an agent spent ~2.5 h re-deriving these checks from `ci.yml` and memory (WM-1104). What it asserts, and why:

- **The base tip is fully green for the exact SHA** — every job of the CI workflow on the newest run _for that commit_, not "the latest run on the branch". A newer push cancels the previous run, so a stale run reads as red; a skipped job (`deploy-prod` never runs on develop) is not a failure; only jobs listed in the repo's `advisory_jobs` are allowed to be red.
- **Every runtime pin is fresh** — for each role in the repo's `runtime_roles`, the pinned source commit is an ancestor of the tip _and_ nothing under that publisher's own `on.push.paths` has moved since. A stale pin means the release would ship source the runtime image does not contain.
- **No publisher is mid-flight and no bot pin PR is open** — either means the pins are about to move under you.
- **No `escalated` PR targets the base** — that one is a human's decision, not a release's.
- **The promotion journal is clean** (`ssh_probe`) — a non-empty `active/` means a publish transaction, possibly _another repo's_, is still open; promoting over it strands the release.

Branches still come from `config/repos.yaml`: `base` (integration, usually `develop`) and `deploy_branch` (usually `master`). No entry or no `deploy_branch`: use the repo's actual branches; if base and deploy are the same branch, there is no release flow here — say so and stop. **Nothing to ship?** `git log origin/master..origin/develop --oneline` empty means done — report and stop. A repo with a dev smoke check (`smoke_workflow`/`smoke_url`) should have that green too. Shipping a red develop just promotes the breakage: fix or revert there first, which is a stop-and-notify, not something to push through.

## 1b. The publish → reconcile → pin chain

When pre-flight fails **only** on stale runtime pins, the fix is a fixed sequence — and it is what `factory ship-chain --repo <name> --until pin` drives (dry run by default; `--apply` acts):

1. `gh workflow run <publisher> --ref <base> -f commit_sha=<tip>` — **one publisher at a time** where the repo sets `serial_publishers: true`. They share one promotion lock on the runner; two at once leaves an unprepared directory under the promotion journal and every later publish exits non-zero until an operator discards it.
2. Wait for that publisher run to finish. Its receipt — the provenance artifact naming the reviewed commit, the publisher run and the registry digest — is what the next step verifies; nothing here is taken on trust from the tag.
3. Wait for `reconcile-runtime-images.yml` to open the bot's `chore(runtime): adopt reviewed runtime images` PR (it also runs on a poll, so this is a wait, not a second dispatch).
4. Merge that PR **only when its head commit's check runs are all success or skipped**. Read the check-run summary; a watched workflow run can exit 0 while another check on the same head is red, which is exactly how a red PR got merged once.
5. That merge moves the tip, so the base needs a fully green run again — go back to pre-flight. Only when it exits 0 do you open the release PR.

A **fully** green base is required (not just "deploy and smoke green") because the publishers themselves refuse to build from a commit whose exact-SHA CI did not succeed; shipping past a partial green just moves the failure to the release PR.

## 2. Mid-flight work

Open PRs targeting develop are fine — they ride the next release. But if a merge landed on develop in the last few minutes and its CI hasn't finished, wait for that run rather than shipping an unverified tip.

## 3. Open the release PR

- Reuse an existing open develop → master PR if one exists (`gh pr list --base master --head develop`) — don't stack a second.
- Otherwise create it. Title: `release: develop → master (<date>)`. Body: the commit list since last release (`git log origin/master..origin/develop --oneline --no-merges`) with Linear ticket IDs pulled out into their own line each, so the Linear integration links every shipped ticket. Do **not** put `Fixes <ID>` in the body — these tickets are already `Done`; a release PR references, it doesn't close.

## 4. Wait for CI — properly

For the release head SHA, select the CI workflow with `gh run list --workflow ci.yml --commit <sha> --json databaseId --limit 1`, wait with `gh run watch <run-id> --exit-status --interval 60`, then assert every check run completed green with `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`. The workflow run can lag the push, so retry the workflow-selected lookup for up to about two minutes when it is empty. **Never `sleep` and re-poll.** Also confirm the PR is mergeable (no conflicts — a develop → master PR with conflicts means someone committed to master directly; surface that, don't resolve it silently by picking sides).

If CI is red: this is release CI on code that was already green on develop, so first look whether the failure is environmental/flaky (re-run once via `gh run rerun --failed`). A real failure means develop and master CI disagree — fix on **develop** (max 2 fix rounds, per the standard loop), let it flow back into this PR. Still red after that: stop, notify (`CI RED`), report what was tried.

## 5. Merge

**Always a merge commit: `gh pr merge <PR> --merge`.** Never squash or rebase a release PR — squashing develop into master makes every subsequent release PR re-show already-shipped commits as conflicts, and it wrecks `git log master..develop` as the ship-list source of truth. If the repo blocks merge commits, stop and tell me rather than squashing.

**No `--delete-branch` on this PR.** Its head is `develop` — the flag would delete the integration branch, and there is no branch protection to stop it (floor: **Protected branches**). Do not force anything.

## 6. Verify the deploy

The deploy branch usually auto-deploys, so the merge is not the finish line:

- Watch the post-merge run on master to completion (`gh run watch <run> --exit-status`).
- Where the repo has a prod smoke check or `smoke_url`, confirm it's green/responding after the deploy settles.
- Run the repo's `post_release_checks` from `config/repos.yaml` — they are the verification trio an operator would otherwise remember by hand (health endpoint, deployment inventory, sidecar verify). `factory ship-chain --repo <name> --until release --apply` runs them and prints the one-screen summary.
- **Red master CI or red smoke = live outage**: revert the release merge (`git revert -m 1 <merge-sha>` on master, push), notify immediately (`SMOKE RED` / `CI RED` via `factory notify`), and file the cause to Linear. Don't leave a broken deploy standing while investigating.

## 7. Report

What shipped: ticket IDs and one-liners, the release PR link, CI + smoke status on master. If anything was reverted, fixed, or skipped, say exactly what and why. File anything discovered along the way (flaky release CI, direct-to-master commits, missing smoke coverage) to Linear `Triage` per the discovered-work rule.

**Session friction:** skip when `FACTORY_RUN_ID` is set. When unset, scan the session per `/factory-friction` and note friction items filed (IDs) or **none observed**.

# Release pre-flight and the publish → reconcile → pin chain

`factory ship-preflight` answers one question mechanically: **is this repo's
base tip shippable right now?** `factory ship-chain` drives the fixed sequence
that makes it shippable when the answer is "not yet, the runtime pins are
stale".

Both live in `orchestrator/ship.mjs`. Neither is a replacement for
`/factory-ship` — that command is still where the human `master` decision is
made; these are the parts of it that a machine can read without guessing.

## Why this exists

Shipping legalease on 2026-09-15 took about two and a half hours, nearly all of
it an agent re-deriving a sequence from `ci.yml`, `verify_case_agent_release.py`
and memory:

1. a fully green develop run for the exact tip,
2. `gh workflow run case-agent-image.yml -f commit_sha=<tip>` — because
   `docker/agent/**` had moved since the pinned case-agent commit,
3. wait, then let `reconcile-runtime-images.yml` open the bot's
   `chore(runtime): adopt reviewed runtime images` PR,
4. merge that PR, which moves the tip,
5. another fully green develop run,
6. only then `develop → master`, merge, watch the deploy, and run the prod
   verification trio.

Every step of that is a question about state that GitHub, git and one
read-only SSH probe can answer. This is those questions, as a command.

## `factory ship-preflight --repo <name> [--json] [--no-fetch]`

Read-only. Exits 0 only when no check failed; 1 when one did; 2 on a
configuration error. Every FAIL prints the exact next command.

| check                | passes when                                                                                                                                  | fails because                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base-green`         | the newest CI run **for the exact tip SHA** concluded `success` **and** at least one non-advisory job succeeded, with none red or incomplete | a real job is red, the run is still going, the run itself concluded red (a `startup_failure` produces a completed run with _zero_ jobs), or the tip has never been built |
| `runtime-pin:<role>` | the pinned source commit is an ancestor of the tip **and** nothing under that publisher's `on.push.paths` changed since                      | the image would ship without source that is already on the branch                                                                                                        |
| `publishers-idle`    | every configured publisher workflow's newest runs are `completed`                                                                            | the pins are about to move under you                                                                                                                                     |
| `pin-pr`             | no open PR by the pin bot with the configured title prefix                                                                                   | reconcile has already produced a pin to adopt first                                                                                                                      |
| `escalated-pr`       | no open PR labelled `escalated` targets the base                                                                                             | a human still owes a decision on code in this release                                                                                                                    |
| `ssh-probe`          | the configured probe prints exactly `clean`                                                                                                  | a publish transaction — possibly another repo's — is still open in the promotion journal                                                                                 |

Every check fails closed. Specifically, the three shapes that used to read as
green because nothing looked at them:

- **A run's own conclusion is read before its jobs.** A `startup_failure` — a
  bad workflow file, a `${{ runner.temp }}` in a job-level `env:` — is a
  _completed_ run with an empty job list, and an empty job list satisfies every
  per-job test. That is the org's documented zero-job red run.
- **A run that reports no successful non-advisory job is not a green tip**,
  whatever its conclusion says.
- **A publisher is idle only when its runs are `completed`.** Filtering the
  repo-wide run list by `in_progress` and `queued` missed `waiting` (an
  environment approval), `requested` and `pending`; the workflow's own run list
  is asked instead, and anything that is not `completed` counts as active.

Three deliberate refinements over a literal reading of the checks:

- **Skipped is not failed.** `deploy-prod` never runs on develop and can never
  report `success`, so requiring success from every non-advisory job would make
  the check unpassable. A job skipped because its _dependency_ failed is still
  caught, through the dependency.
- **The newest run for the SHA decides.** A re-push cancels the previous run,
  and that cancelled run reads as red; selecting by run number then attempt
  avoids the false red (and the false green of reading some other workflow's
  newest run).
- **A role built in another repository is `SKIP`, not `PASS`.** legalease pins
  lawz's research runner; that commit is not in legalease's history, so
  ancestry is unanswerable here and saying so is the honest output. The line
  still prints the pinned commit (`pinned <sha8> (source watt-mind/lawz)`) — a
  SKIP with no detail is indistinguishable from a check that never ran. Give
  the role a `foreign_repo` and the line also compares that pin with the newest
  successful publisher run in that repository, and becomes a `WARN` when they
  differ. A `WARN` never blocks the release; it tells the operator where to
  look.

An unreachable GitHub, a failed `git`, or a probe that times out is a **FAIL**,
never a pass — the command fails closed.

## `factory ship-chain --repo <name> --until <preflight|pin|release|post-release> [--apply]`

**Dry run unless `--apply`.** A dry run is a plan, not a rehearsal: it makes no
mutating call and does no waiting, because there is nothing to wait for when
nothing was dispatched.

- `--until preflight` — the read-only verdict, nothing else.
- `--until pin` — drive publishers and pin PRs until pre-flight is clean.
- `--until release` — the above, then open `base → deploy_branch`, merge it,
  and run `post_release_checks`.
- `--until post-release` — **only** `post_release_checks`, against a deploy
  that already happened. No pre-flight, no PR, no merge, and nothing to
  dry-run: these are the repo's own read-only verification commands, so they
  run with or without `--apply`. `--apply` adds the `SMOKE RED` notification.
  This is step 6 of `/factory-ship` when the merge was done by hand.

The loop, per round: merge an already-open pin PR first (it moves the tip, so
every pin answer is re-dated by it), otherwise dispatch the stale roles'
publishers — **one at a time** under `serial_publishers: true`, because they
share one promotion lock — then:

1. wait for the **dispatched run itself** to appear. `workflow_dispatch`
   returns no run id and the run does not exist the instant the call returns,
   so "no active run of this workflow" is satisfied _before the publisher
   starts_; the chain instead snapshots the workflow's run ids, dispatches, and
   polls (bounded, ten minutes) for a run that is new and not older than the
   dispatch;
2. wait for that run to complete and **read its conclusion**. A publisher that
   failed produced no pin, so the chain stops there by name rather than waiting
   45 minutes for a reconcile PR that will never open;
3. wait for the reconcile PR, merge it, and re-run pre-flight.

Any other failing check (a red base, an escalated PR, a dirty promotion
journal) stops the chain with its next command rather than being worked around.

### The merge gate

**Merges gate on the check-run summary**, never on a watched run's exit status:
`gh run watch` can exit 0 for one workflow while another check run on the same
head commit is red, which is how a red PR was merged once. `mergeWhenGreen`
reads `commits/<sha>/check-runs` and refuses on any red check — and on an
**empty** one, because `[].every(green)` is `true` and a commit whose checks
have not been created yet used to satisfy the gate instantly. At least one
completed check run must have actually succeeded, and the configured CI
workflow must itself have a `success` run for that same head (check-run _names_
are job names, so the workflow's presence is proved from the Actions runs API
rather than guessed from a name).

**Nothing is merged at a commit the chain did not verify.** Between reading a
green check-run summary and merging, the branch can move. So, for both the pin
PR and the release PR: the PR is re-read after the wait and a moved head is
refused, and the merge itself carries `--match-head-commit <sha>` so GitHub
refuses too — only the second one closes the gap between the last read and the
merge.

The release merge is additionally guarded because it is the one that reaches
production:

- `preflight` is **re-run immediately before it**, and any FAIL stops the
  chain: the plan above it may be many minutes old.
- the release PR's head must still be that pre-flighted tip.
- the release PR itself is inspected — `escalated` label, draft, and that its
  head really is `base` and its target really is `deploy_branch`. The
  `escalated-pr` check cannot see it: that check only looks at PRs targeting
  the base, and the release PR targets the deploy branch.

Release PRs are merged with `--merge`. Never squash one: it makes every later
release PR re-show already-shipped commits as conflicts and destroys
`git log <deploy>..<base>` as the ship list.

### After the merge

A red `post_release_checks` command is not a plan that stopped — the release is
already on the deploy branch. The summary says
`POST-RELEASE CHECK FAILED: <command>` and the chain exits non-zero; under
`--apply` it also pushes `SMOKE RED <repo>: <command> failed after release
<sha>` through `factory notify`, because a line in a terminal is not a channel
the operator reads in real time.

## Configuration

Per repo in `config/repos.yaml` (the operator-local file — `config/repos.yaml`
is gitignored, so the tracked `config/repos.example.yaml` documents the shape
on its commented example entry and keeps client hostnames out of git):

```yaml
advisory_jobs: [] # CI jobs allowed to be red
serial_publishers: true # publishers share one promotion lock
ssh_probe: ssh <user>@<host> '... && echo clean || echo dirty'
post_release_checks:
  - curl -fsS https://<prod-host>/healthz
pin_pr: # defaults to app/watt-mind-factory
  author: app/watt-mind-factory
  title_prefix: "chore(runtime)"
runtime_roles:
  - role: case_agent
    manifest: legalease/config/runtime-images.json
    publisher_workflow: case-agent-image.yml
    paths: # mirror the publisher's on.push.paths
      - docker/agent/**
  - role: research_runner
    manifest: legalease/config/runtime-images.json
    publisher_workflow: research-runner-image.yml
    source_repo: watt-mind/lawz # built elsewhere -> freshness is SKIP
    foreign_repo: watt-mind/lawz # optional: read its publisher runs to compare
```

`paths` must mirror the publisher workflow's own `on.push.paths`. That is not a
convention, it is the definition of stale being used: the publisher rebuilds
when those paths move, so a pin older than a change to one of them is a pin the
publisher itself would consider out of date.

**`paths` is required for a role built in this repo** and the config is
rejected without it. A role with no paths has no definition of stale, so its
check can never fail — and a misspelled key (`path:`) used to turn the whole
check into a quiet SKIP on every release. `source_repo` is the way to say the
role is built somewhere else; there is no way to say "check nothing".

`foreign_repo` is optional and separate from `source_repo`: it is the
repository whose publisher runs this checkout may _read_, an opt-in because it
costs an API call against a repo the operator may not have access to.

The pinned commit is read from the manifest role's `provenance.commit_sha`,
then `reviewed_commit`, then a `tag` ending in a full SHA (`develop-<sha>`) —
the publisher's own receipt first, the tag only as a fallback.

## Where the receipts come from

Nothing here trusts an image tag. The publisher uploads a provenance artifact
naming the reviewed commit, the publisher run and attempt, and the registry
digest; `reconcile-runtime-images.yml` re-proves all of it against the GitHub
run and artifact APIs before it writes the manifest, and the release gate
(`verify_case_agent_release.py`) re-checks the digest and its immutable labels
at release time. Pre-flight's job is narrower and upstream of all that: it
proves the pin in the manifest still corresponds to the source you are about to
ship.

## Extending the forge

The chain's three mutating operations — `workflowDispatch`, `prCreate`,
`prMerge` (with `matchHeadCommit`) — are Forge verbs (`lib/forge/`), not `gh`
calls in the orchestrator.
Nothing outside `lib/forge/` spawns `gh`; that is what lets the whole module be
tested on fixtures, and what lets `memoryForge` drive the demo. Waiting is
bounded polling of existing read verbs at a ≥60 s interval rather than a
`runWatch` verb, because the floor's rate-limit rule already forbids tighter
polling of the Actions API.

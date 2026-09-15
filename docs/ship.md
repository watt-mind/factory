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

| check                | passes when                                                                                                             | fails because                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `base-green`         | every job of the newest CI run **for the exact tip SHA** is `success` (or `skipped`, or listed in `advisory_jobs`)      | a real job is red, the run is still going, or the tip has never been built               |
| `runtime-pin:<role>` | the pinned source commit is an ancestor of the tip **and** nothing under that publisher's `on.push.paths` changed since | the image would ship without source that is already on the branch                        |
| `publishers-idle`    | no configured publisher workflow has a queued or in-progress run                                                        | the pins are about to move under you                                                     |
| `pin-pr`             | no open PR by the pin bot with the configured title prefix                                                              | reconcile has already produced a pin to adopt first                                      |
| `escalated-pr`       | no open PR labelled `escalated` targets the base                                                                        | a human still owes a decision on code in this release                                    |
| `ssh-probe`          | the configured probe prints exactly `clean`                                                                             | a publish transaction — possibly another repo's — is still open in the promotion journal |

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
  ancestry is unanswerable here and saying so is the honest output.

An unreachable GitHub, a failed `git`, or a probe that times out is a **FAIL**,
never a pass — the command fails closed.

## `factory ship-chain --repo <name> --until <preflight|pin|release> [--apply]`

**Dry run unless `--apply`.** A dry run is a plan, not a rehearsal: it makes no
mutating call and does no waiting, because there is nothing to wait for when
nothing was dispatched.

- `--until preflight` — the read-only verdict, nothing else.
- `--until pin` — drive publishers and pin PRs until pre-flight is clean.
- `--until release` — the above, then open `base → deploy_branch`, merge it,
  and run `post_release_checks`.

The loop, per round: merge an already-open pin PR first (it moves the tip, so
every pin answer is re-dated by it), otherwise dispatch the stale roles'
publishers — **one at a time** under `serial_publishers: true`, because they
share one promotion lock — wait for the publisher, wait for the reconcile PR,
merge it, and re-run pre-flight. Any other failing check (a red base, an
escalated PR, a dirty promotion journal) stops the chain with its next command
rather than being worked around.

**Merges gate on the check-run summary**, never on a watched run's exit status:
`gh run watch` can exit 0 for one workflow while another check run on the same
head commit is red, which is how a red PR was merged once. `mergeWhenGreen`
reads `commits/<sha>/check-runs` and refuses on any red check.

Release PRs are merged with `--merge`. Never squash one: it makes every later
release PR re-show already-shipped commits as conflicts and destroys
`git log <deploy>..<base>` as the ship list.

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
```

`paths` must mirror the publisher workflow's own `on.push.paths`. That is not a
convention, it is the definition of stale being used: the publisher rebuilds
when those paths move, so a pin older than a change to one of them is a pin the
publisher itself would consider out of date.

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
`prMerge` — are Forge verbs (`lib/forge/`), not `gh` calls in the orchestrator.
Nothing outside `lib/forge/` spawns `gh`; that is what lets the whole module be
tested on fixtures, and what lets `memoryForge` drive the demo. Waiting is
bounded polling of existing read verbs at a ≥60 s interval rather than a
`runWatch` verb, because the floor's rate-limit rule already forbids tighter
polling of the Actions API.

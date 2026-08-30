# Continuous integration

## Runner topology

Factory CI uses a hybrid runner strategy designed for public open-source operation (WM-950):

- **Internal trusted lanes**: Branches originating within `watt-mind/factory` (pushes to `develop`/`main` and internal pull requests) run on high-performance self-hosted runners. The `shadow` label maps to eight runner services (`watt-mind-runner-1` through `watt-mind-runner-8`) on one physical host, and the `smoke-test` runner checks fleet health.
- **External untrusted fork PRs**: Pull requests from external repository forks run in isolated, ephemeral GitHub-hosted runners (`ubuntu-latest`). Untrusted contributor code has zero access to the host machine, filesystem, `/tmp`, or internal network.
- **Security & utility workflows**: Workflows handling credentials or isolated scans (`security.yml`, `cla.yml`, `update-badge.yml`, `publish-extension.yml`) run unconditionally on `ubuntu-latest`.

Treat self-hosted runner names as parallel executors, not independent machines. CPU, memory, `/tmp`, and process scheduling are shared across all eight shadow services.

### Runner host dependencies

Runner images must provide `unzip`, `curl`, `sha256sum` (from coreutils), and `tar` for the checksum-pinned tool installer. The `Pinned tools forced-install smoke` job on `ubuntu-latest` forces fresh bun, gitleaks, uv, and actionlint installs and verifies these dependencies whenever `.github/**` changes (and on manual dispatch).

## Fork PR sandboxing & dual routing

In `ci.yml`, a lightweight initial `route` job runs on `ubuntu-latest` to determine the execution lane based on the event context:

- Untrusted fork PRs (`github.event.pull_request.head.repo.full_name != github.repository`), Dependabot PRs, and nightly exercises route dynamically to `ubuntu-latest`.
- Trusted internal PRs and branch pushes route to `[self-hosted, shadow]` and `[self-hosted, verify-lane]`.
- Host-specific steps (`shadow-runner-health`, host `/tmp` sweep) execute only when `runner.environment == 'self-hosted'`.
- Continuous exercise: A nightly schedule (`0 4 * * *`) and `workflow_dispatch` input `force_hosted` run the full CI suite on `ubuntu-latest` to prevent cloud lane regressions.

## Verify lane

The `Full verification` job and Browser E2E run on `runs-on: [self-hosted, verify-lane]`. `verify-lane` is an extra label carried by a small, fixed number of shadow runner services (`watt-mind-runner-1`, `-2` and, since 2026-08-19, `-3`; added through the GitHub API: `gh api -X POST orgs/watt-mind/actions/runners/<id>/labels -f 'labels[]=verify-lane'`). GitHub queues those jobs FIFO for a free lane runner; nothing is cancelled and no other runner is occupied while a job waits. The rest of the fleet stays free for `Fast unit tests`, lint, Security scans and other repositories.

This replaces the earlier host-local `flock` on `/tmp/factory-verify-host.lock` (WM-300/WM-600/WM-776), which serialized correctly but parked every waiting shadow runner inside the lock — GitHub counted them all as busy, so a deep factory queue starved the whole fleet, and a crashed worker could leave an orphaned guardian holding the lock for the host (WM-776).

Capacity is a runner-config knob, not a workflow change: **lanes = number of runners with the `verify-lane` label**. Three lanes means at most three spawn-heavy suites run concurrently on the host; if that proves flaky under contention, remove the label from one runner (`gh api -X DELETE orgs/watt-mind/actions/runners/<id>/labels/verify-lane`). Do not add lanes beyond what the host's measurements support (WM-773 item 5).

Operating rule used by the orchestrator: when `verify-lane` jobs have been queued (`gh api 'repos/watt-mind/factory/actions/runs?status=queued'`) for more than a full 30-minute tick with more than four waiting, add one more runner to the label; when more than a third of lane runs fail on the timing-bound group, drop one. The 2026-08-19 pile-up (22 PRs opened by dispatch in three hours against a one-PR-per-cycle merge lane) is what motivated runner-3 and the merge-lane redesign in WM-906.

## Merge lane throughput

The event-runtime merge lane is being split into parallel per-PR review with a ledger keyed by head SHA and batched landing (WM-906: WM-907 review ledger + `merge-review@1` fan-out, WM-908 `merge-plan@1` + batched `merge-apply`/`merge-verify`, WM-909 trigger + `/merge` view). See `docs/merge-lane.md` once WM-907 has landed. Until WM-908 lands, landing is still one PR per verify cycle by design (`config/policy.yaml` `concurrency.max_concurrent_merges: 1`), so a dispatch burst shows up as a growing pile of green PRs; that is the lane's throughput limit, not a CI problem.

`Fast unit tests` deliberately runs on the general `shadow` pool, outside the lane. Five shadow-runner measurements made while another verification job held the lock are recorded in the WM-773 handoff; all five were green and below the three-minute stability threshold. The first ready-head measurement was [job 95742407011](https://github.com/watt-mind/factory/actions/runs/32146787946/job/95742407011): 36 seconds job wall time and 30 seconds for the test step. Keep its command bounded to `event-runtime/lib`, `--timeout 20000`, and `--max-concurrency=4`; broadening that job requires repeating the overlap measurements before assuming it is safe.

## Run coalescing

CI and Security use `concurrency.group` keyed by PR number for pull requests and by ref for pushes, with `cancel-in-progress` for both. A newer push to `develop` cancels the older develop run — only the latest develop head is verified — and a newer PR push cancels that PR's older run. Runs never wait in a concurrency group for a _different_ PR, so nothing is dropped across PRs; queueing across PRs happens in GitHub's runner queue for the `verify-lane` label.

### Required Verify umbrella

`Verify` is the required umbrella for the CI test lanes. It uses `if: always()`
so GitHub evaluates it after every dependency result rather than silently
skipping it behind the default success gate. Except for `Shadow runner fleet
available`, which is intentionally `skipped` on the cloud lane, every gating
dependency (`Route CI lane`, shadow health on self-hosted, `Fast unit tests`,
and `Full verification`) must conclude `success`. A `cancelled`, `skipped`,
or `failure` result makes `Verify` fail.

This matters because concurrency cancellation can leave a historical
`Verify=success` check-run visible for a superseded workflow. The
merge apply selects the sole non-cancelled configured workflow run for the
reviewed head SHA; two live runs fail closed rather than trusting list order. When a
repo configures `merge_ci`, both the branch's required contexts and that run's
configured required jobs must be green; a stale check from a cancelled run is
never sufficient merge proof.

## Dependabot dependency policy

Dependabot opens one weekly grouped pull request per npm ecosystem for minor
and patch version updates. Regular semver-major updates are ignored: schedule
each major upgrade deliberately in a ticket so its compatibility work can be
planned and verified. This restriction applies only to version updates;
Dependabot security updates, including major security fixes, remain enabled.

## Draft pull requests

Draft pull requests run `Shadow runner fleet available`, but skip `Fast unit tests`, `Full verification`, `Timing-bound tests`, and Browser E2E so held work does not consume the verify lane. The required `Verify` check is a lightweight aggregate on the smoke-test runner: it succeeds explicitly for a draft, and for every other event it succeeds only when fleet health and both CI test jobs succeeded. This prevents a failed prerequisite from turning a skipped downstream job into a misleading successful required check.

GitHub's `ready_for_review` event starts a fresh workflow on the ready head. Both workflows name readiness and draft-conversion events explicitly; converting a ready PR back to draft cancels its in-flight CI run through the PR concurrency group. Keep the job-level draft guards when editing either trigger.

## Lint

`Full verification` runs `bun run lint --max-warnings=621` (WM-607) right after installing
`event-runtime/web` deps and before the prettier check. `eslint.config.mjs` at
repo root covers `**/*.{mjs,js,jsx}` with `@eslint/js` recommended, and
`event-runtime/web/**/*.{ts,tsx}` with `typescript-eslint` recommended plus
`eslint-plugin-react-hooks`. `no-unused-vars` (and its TS equivalent) is a
`warn`, so the `--max-warnings` count is a ratchet: it pins the warning total
at its value when this landed so the count can only shrink, never grow
silently. If a change needs to raise it, do so deliberately in the same PR
that adds the warnings, with a one-line reason. Two rules are downgraded from
the recommended sets' default `error` to `warn` in `eslint.config.mjs` because
each had 30+ pre-existing violations that are one intentional, low-risk
pattern rather than isolated mistakes (see the inline comments there for
specifics): `@typescript-eslint/no-explicit-any` (untyped API/test data) and
a cluster of `eslint-plugin-react-hooks` v7 "React Compiler readiness" rules
(`set-state-in-effect`, `refs`, `purity`, `preserve-manual-memoization`,
`error-boundaries`, `immutability`) that the codebase predates. No other rule
is disabled or downgraded globally to reach green.

## Test split and timeout

CI splits tests into separately rerunnable jobs:

- **Fast unit tests:** `event-runtime/lib`, minus the timing group below
- **Full verification:** every other test, including CLI, daemon, web, demo, orchestration, and process-spawning integration suites, minus the timing group
- **Timing-bound tests (WM-918, not required):** spawn-a-real-process-and-wait tests whose names are listed in `event-runtime/lib/test-helpers-timing.mjs` (`TIMING_TEST_SUBSTRINGS`). Required jobs pass `--test-name-pattern` from `bun event-runtime/lib/test-helpers-timing.mjs exclude-pattern`. This job runs the complementary include pattern with `--retry 2`. A red result here does not fail the required `Verify` aggregator.

When a required test step fails, `bun event-runtime/lib/test-helpers-timing.mjs classify <log>` prints the failing names and emits a GitHub `::error title=timing-flake::` annotation if every parsed failure is in that group. Merge-scan should treat a required job whose only failures are that group as a flake (`rerun_ci_at_head`), never ESCALATE — the required lane is supposed to have already excluded them, so the annotation is the miss detector.

Both required test invocations use `--timeout 20000 --max-concurrency=4`. The 20-second default allows for scheduling delays on a busy self-hosted machine instead of failing unrelated tests at Bun's 5-second default. Tests that encode genuine liveness bounds continue to declare explicit, narrower timeouts; the CLI default does not replace those assertions. Only `Full verification` joins the verify-lane queue; the fast suite's 15-minute job timeout is a runaway guard rather than queue headroom. Timing-bound tests run on the general `shadow` pool.

### Flake ledger

| Test                                                                                                 | Lane                       | Guard                                                                                                                                                                                                                                                                                                                                          | Regression signal                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `api-runs.test.mjs` — `contended approvals and rejections yield to /health and return typed db_busy` | Fast unit tests (required) | The real SQLite lock test has a `loadAdjustedTimeout(20_000)` ceiling (scaled by `CI_LOAD_FACTOR`); a 409 is accepted only when the lock child had already exited (`exitCode !== null`, sampled synchronously) at the moment the probe was issued; the 503 branch additionally asserts the probe spent the full `busy_timeout` budget (> 4 s). | A live lock that does not return `{ error: "db_busy", retryable: true }` still fails, as does an unresponsive `/health` request. |

Do not add `describe.skipIf(process.env.CI_FAST)` in the unowned spawn suites from this ticket — the name-pattern split is the quarantine. Follow-up work that owns those files can add in-file tags that match the same list.

## Operational validation

After changing the workflow:

1. Require all checks on the PR itself to pass:

   ```bash
   # --workflow ci.yml: without it the newest run of ANY workflow (CLA,
   # Security, Browser E2E) is returned and its verdict is not CI's. The run
   # can lag the push, so retry briefly instead of failing on the first miss.
   run_id=""
   for i in $(seq 8); do
     run_id="$(gh run list --workflow ci.yml --commit <sha> --json databaseId --limit 1 --jq '.[0].databaseId // empty')"
     test -n "$run_id" && break
     sleep 15
   done
   test -n "$run_id" || { echo "no CI workflow run found for this commit" >&2; exit 1; }
   gh run watch "$run_id" --exit-status --interval 60
   gh api "repos/{owner}/{repo}/commits/<sha>/check-runs" \
     --jq '.check_runs[] | select(.status != "completed" or (.conclusion | IN("success","neutral","skipped") | not)) | .name' \
     | grep -q . && { echo "not every check-run on <sha> is green" >&2; exit 1; }
   ```

   This uses the REST API. `gh pr checks <PR> --watch --interval 60` is the
   minimum only when its GraphQL-backed fallback is unavoidable; it otherwise
   polls GraphQL every 10 seconds by default.

2. After merge, inspect develop runs and confirm five consecutive green runs, including a period when at least three PR workflows were queued concurrently:

   ```bash
   gh run list --workflow CI --branch develop --limit 5
   gh run list --workflow CI --event pull_request --limit 20
   ```

3. For each relevant run, inspect step timestamps with `gh run view <RUN_ID>` and confirm the interval from `Acquire host verify lock` completing through `Release host verify lock` does not overlap the equivalent `Full verification` or Browser E2E interval from another Factory workflow run. `Fast unit tests` is expected to overlap that interval.

A failed or cancelled test job breaks the streak. Record the five develop run URLs in the validating ticket or merge handoff.

## Security scans

`.github/workflows/security.yml` runs on `pull_request`, `push` to `develop`/`main`, and `workflow_dispatch`, on `ubuntu-latest` with the same no-`uses:` git-fetch checkout pattern as `ci.yml` (WM-573). Four jobs:

- **Gitleaks** — `gitleaks git --no-banner --redact` over the PR's base..head range (or the last commit on a branch push). Honours a repo-root `.gitleaks.toml` if one is added. Binary resolves from PATH, then `~/.local/bin/gitleaks`, then a GitHub Releases download (not a marketplace action) on first use per runner host.
- **Semgrep** — `uvx semgrep scan --config p/security-audit --error --metrics=off .`, scoped by `.semgrepignore` (generated output, vendor trees, fixtures, lockfiles). `uv`/`uvx` installs from astral.sh if missing on the host.
- **Actionlint** — `actionlint -color .github/workflows/*.yml`. `.github/actionlint.yaml` declares the repo's custom self-hosted runner labels (`shadow`, `smoke-test`) so they don't flag as unknown; real shellcheck findings on `run:` blocks get fixed or suppressed inline with a reason, never blanket-disabled.
- **CodeQL** — gated behind `if: ${{ vars.CODEQL_ENABLED == 'true' }}` and currently a placeholder: this repo is private with no GitHub Advanced Security (`code-scanning/default-setup` returns 403). Flip the `CODEQL_ENABLED` repository variable and replace the placeholder step with `github/codeql-action` init/analyze once GHAS is available (project-conventions.md §3D).

Run the same tools locally before pushing with `factory security` (Gitleaks + Semgrep + Actionlint, plus Ruff/pip-audit when a repo has adopted the Python tier) — see `lib/security-check.sh`. Local and CI use identical tool invocations and config files (`.gitleaks.toml`, `.semgrepignore`) so a clean local run predicts a clean CI run.

## Browser E2E

The Playwright smoke suite exercises the event-runtime web UI against an
isolated fake-adapter runtime seeded by `event-runtime/demo/seed.mjs`. It covers
Overview, Inbox acknowledgement, proposal approval inspection, Runs detail, and
the capability Graph.

Run it locally from the web package (Google Chrome must be installed):

```bash
cd event-runtime/web
bun run test:e2e
```

The helper owns and removes a temporary `FACTORY_EVENT_HOME`. It picks two
free ports per run (so concurrent worktrees never collide or seed each other's
runtime); set `E2E_API_PORT` and `E2E_WEB_PORT` to pin them. It fails fast if
the API, worker, or Vite process dies during startup rather than seeding
whatever else is listening on the port. Set `PLAYWRIGHT_CHANNEL=chromium` to
use Playwright's downloaded Chromium instead of system Chrome. The pinned
`@playwright/test` version lives in `e2e/playwright-version.mjs`, read by both
`test:e2e` and the workflow.

`.github/workflows/e2e.yml` is deliberately opt-in while the suite proves
stable. It runs for a pull request only when that PR has the `run-e2e` label,
and it can always be started manually with `workflow_dispatch`. The workflow
uses the shared verify lock to serialize against every other test job on the
self-hosted runner, installs Playwright's Chromium build (cached in the
runner's `~/.cache/ms-playwright`, keyed on the pinned version), and runs the
same `bun run test:e2e` command.

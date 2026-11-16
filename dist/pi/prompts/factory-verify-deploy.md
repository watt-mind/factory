# factory-verify-deploy

> Verify a live deployment end-to-end — rollout SHA, zero runtime/telemetry errors, and exercised user/API flows

Verify that a live deployment actually rolled out the expected commit, runs free of container, telemetry, and browser runtime errors, and serves its changed user and API journeys end-to-end.

Run this command standalone after a deploy or composed inside `/factory-merge` (auto-deployed staging/dev `base`) and `/factory-ship` (`deploy_branch` production). **The operator is AFK by default** — execute all four gates to a concrete verdict without pausing for mid-run confirmation prompts.

Interpret `$ARGUMENTS` as an optional repo name from `config/repos.yaml` (default: the repository matching the current checkout), `--env staging|prod`, `--sha <commit>`, `--pr <N>` or `<ISSUE-ID>`, and `--url <url>`.

## Gate 1 — Rollout & Revision Proof (Mechanical)

1. **Resolve repo, target branch, expected SHA, and live URL:**
   - Read the repo entry from `config/repos.yaml`: target branch is `base` for `--env staging` (or dev/integration) and `deploy_branch` for `--env prod` (when `--env` is omitted, infer `prod` when standing on `deploy_branch` or targeting a `-prod` / apex host, otherwise `staging`).
   - Enforce the floor's **Checkout freshness** rule (`git fetch --quiet`; fail closed if `git fetch` exits non-zero rather than trusting a stale working tree). Resolve `<sha>` from `--sha` or `git rev-parse origin/<branch>`.
   - Resolve the live target URL from `--url`, `deployment.url`, or `smoke_url` in `config/repos.yaml` and repo docs. If the repo declares none of `deployment.url`, `smoke_url`, `smoke_workflow`, or `post_release_checks` (and no `--url` was given), emit `VERDICT: UNCONFIGURED` and stop rather than guessing a hostname.
2. **Wait on in-flight deploy or smoke workflows via REST:**
   - Select any deploy or `smoke_workflow` run for `<sha>` with `gh run list --workflow <wf> --commit <sha> --json databaseId --limit 1` (retrying on a bounded condition poll up to ~2 minutes if the workflow run lags the push) and block with `gh run watch <run-id> --exit-status --interval 60`. Never `sleep` and hope.
3. **Prove live revision convergence:**
   - Poll the live revision endpoint (`/version.json`, `factory status --repo <name> --json`, or the app's documented revision/build response header) on a short interval bounded by `smoke_deadline_seconds` (default `180`s) until the live SHA matches `<sha>`.
   - **Fail closed** if the live revision stays on an older commit past the deadline or diverges (`VERDICT: BROKEN` when rollout stalled/crashed; `VERDICT: DEGRADED` only when the app exposes no machine-readable revision surface yet, which you must file to `Triage` in Gate 4) — never verify an old container and report the new commit green.
4. **Run deterministic post-release checks on prod:**
   - When verifying `prod` and the repo configures `post_release_checks` in `config/repos.yaml`, run `factory ship-chain --repo <name> --until post-release` to execute the health, inventory, and sidecar checks against the live target.

## Gate 2 — Telemetry, Container & Browser Error-Free Baseline

1. **Container & server telemetry:**
   - Where SSH, Dokploy, or container infrastructure docs exist for the repo, spawn `factory-infra-scout` **read-only** so raw log dumps stay out of caller context: confirm containers are `running`/`healthy` (`ps`), have zero restart loops, and emitted zero new uncaught `500`s, panics, or stack tracebacks in `--tail 50` since rollout.
   - Check any accessible error telemetry or health summary endpoints (Sentry / runtime health routes) for new post-rollout spikes.
2. **Browser console & network baseline (for web UIs):**
   - Whenever driving the live web UI in Gate 3, inspect `list_console_messages` and `list_network_requests` after navigation and interaction. Assert **zero** new uncaught JS exceptions, hydration errors, CSP/CORS blocks, failed chunk loads, or unexpected `4xx`/`5xx` API responses.

## Gate 3 — End-to-End Changed-Journey Exercise (Staging vs. Prod Split)

Derive the target user journeys and API contracts from `--pr` / `<ISSUE-ID>` `Acceptance Criteria` (especially `Post-deploy:` bullets and `## Handoff` risks), or from `git log <prev-live-sha>..<sha> --stat` across the landed batch or release.

### Staging / Dev (`--env staging` or auto-deployed `base`)

Exercise the full interactive journey end-to-end:

- Own an isolated browser tab via `tabs_create`, pass `tabId` explicitly on every browser call, **assert the page origin matches the staging host** before trusting any read, and re-read after `location.reload()`.
- Authenticate with the repo's documented staging test or seeded account, walk the changed UI/API flow end-to-end, and verify both UI state transitions and persisted backend state.
- Use `take_snapshot` for structural assertions and capture **1–2 bounded mobile or element-scoped proof screenshots** written outside the repo (`$FACTORY_ARTIFACT_DIR` or `$TMPDIR`) — never `Read` captured images back into context, never commit them to git, and never attach them to Linear.

### Production (`--env prod` or `deploy_branch` / `-prod` / apex domain)

**Strict read-only production safety rule:** never mutate real customer data, never trigger payments, emails, webhooks, or destructive actions, and never hand-mint production auth sessions.

- Run safe **read-only**, unauthenticated, or designated read-only canary checks only: HTTP status and security/cache headers, public/read API contract responses, SSR + client bundle load, entry/public route render, and **1–2 bounded mobile or element-scoped proof screenshots** (surfaced inline in interactive runs or written to `$FACTORY_ARTIFACT_DIR` in autonomous runs — never `Read` back).
- Mark any authenticated write-only production path that has no designated canary account explicitly as `SKIPPED (prod write boundary)` in the report rather than improvising writes against production.

## Gate 4 — Verdict, `SMOKE RED` Interrupt & Follow-ups

Emit a structured report opening with:

```
VERDICT: VERIFIED | BROKEN | DEGRADED | UNCONFIGURED
Target URL: <url or none>
Verified SHA: <branch>@<sha> (observed: <live-sha or unexposed>)
Gates: G1=<pass/fail/degraded> G2=<pass/fail/skipped> G3=<pass/fail/skipped>
Evidence: <HTTP statuses, checked routes/APIs, proof screenshot artifact paths>
Unexercised: <none | SKIPPED (prod write boundary): ...>
```

- **On `BROKEN`:** immediately push a real-time alert via:
  ```bash
  factory notify "SMOKE RED <repo>: <one-line failure on <sha>>"
  ```
  Use the exact canonical `SMOKE RED` prefix (if `factory notify` exits non-zero, flag the failed push in the report and ticket comment). When composed inside `/factory-ship` or `/factory-merge`, return immediately so the caller executes its `git revert -m 1 <merge-sha>` rollback without leaving a broken deploy standing.
- **Follow-up filing order:** For non-blocking regressions (`DEGRADED`) or missing observability surfaces (no `/version.json` revision endpoint, missing `smoke_url`, noisy console warnings), file deduplicated issues to `Triage` via `factory ticket file` (`source:agent`, matching `type:*` + `area:*`, citing `<branch>@<sha>`) **first**, collect the returned issue identifiers, and cite those real IDs in your verdict report.
- **Capture session friction (interactive runs only):** skip when `FACTORY_RUN_ID` is set. When unset, scan the session per `/factory-friction` and report filed issue IDs or **none observed**.

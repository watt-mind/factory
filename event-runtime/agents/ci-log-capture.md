# ci-log-capture@1

Not a prompt: this definition runs a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
bun {factoryRoot}/event-runtime/lib/ci-log-capture.mjs
```

The script reads `input.json` from the workspace and writes `result.json`
itself (`writesResult: true`). When the webhook carried `runAttempt`, it pins
the read to that attempt instead of the run's latest one:

```
gh run view {runId} --log-failed --attempt {runAttempt} --repo {repo}
```

Inputs without a usable `runAttempt` fall back to the previous
`gh run view {runId} --log-failed --repo {repo}` command unchanged. Pinning
matters because the failed-run webhook routinely arrives while a re-run is
already in flight: `--log-failed` reads the LATEST attempt, finds it still
running, prints nothing, and exits 1 — the failure this definition exists to
capture is lost and the dispatch is recorded as `agent_exit_1` (#2076).

"Nothing to capture" is a normal terminal outcome, not a fault. A deleted
run, a 404/410 attempt, an expired or cancelled attempt, and an empty
download all record `captured: "none"` with an explicit `no_logs` reason,
declare no `ci-log` artifact, and exit 0. Auth, network, quota, and a missing
`gh` remain non-zero. The `factory.ci-diagnose.requested` edge keys on
`captured: "failed.log"` (`edges.json`), so a no-log capture completes without
asking for a diagnosis of bytes that do not exist.

When the download has bytes, `failed.log` is declared as the `ci-log`
artifact, so the worker stores it content-addressed. Downstream `ci-doctor@2`
then reads those exact bytes instead of calling GitHub again: the diagnosis
becomes reproducible and re-runnable offline, and a multi-megabyte log lives
in the artifact store rather than blowing the inline-evidence limit.

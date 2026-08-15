Evidence from the 2026-08-14 develop-red incident ([WM-88](https://linear.app/watt-mind/issue/WM-88/develop-red-wm-83-duplicate-key-fix-left-repos-without-a-declared)): run 31815961721 at `84cc487` failed `event-runtime/demo/seed.test.mjs:66` ("seed & re-seed deduplication ([OPS-464](https://linear.app/watt-mind/issue/OPS-464/fixfactory-a-demo-seed-cannot-be-retried-same-prefix-dies-on-intake)) > initial seed succeeds and verify passes", exit 1) on runner `actions-runner-smoke-4`, then passed unchanged on `gh run rerun --failed`, and passes locally (21.5s). This is after the [OPS-423](https://linear.app/watt-mind/issue/OPS-423/testevent-runtime-verifymjs-is-a-state-census-not-a-correctness-check) hardening round (timeout increase + missing-local-clone handling, commits `5363460`/`7a88bc6`), so the flake class isn't fully closed. Worth capturing the seed/verify stderr on failure (the test currently only asserts exit code, so the CI log shows `Expected: 0 / Received: 1` with no cause) and checking runner-side state (stale event homes, port collisions with concurrent jobs on the same host). One flake + rerun-green is weak evidence for a fix but strong evidence for better failure diagnostics — start there.

### Problem & Context
The `seed & re-seed deduplication (OPS-464)` test suite in `event-runtime/demo/seed.test.mjs` flakes intermittently on self-hosted runners. It fails on the assertion `expect(seedRes.status).toBe(0)`. Because the test only asserts the exit code, the CI log shows `Expected: 0 / Received: 1` without any indication of what caused the subprocess to fail. We need better failure diagnostics (capturing and logging `stderr` and `stdout` from the failed subprocess) to debug the underlying runner-side state issues like port collisions or stale event homes.

### Acceptance Criteria
- When the subprocess spawned in the test fails (non-zero exit code), the test output includes the subprocess's `stderr` and `stdout` so the failure reason is visible in the CI log.
- No functional test assertions are removed or weakened; diagnostics are merely added to failures.

### Source File Pointers
- `event-runtime/demo/seed.test.mjs`

### Owned Paths
- `event-runtime/demo/seed.test.mjs`

### Verification Command
`cd event-runtime && bun test demo/seed.test.mjs`

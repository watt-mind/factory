# ci-rerun — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
gh run rerun {runId} --failed --repo {repo}
```

Re-runs only the failed jobs of one GitHub Actions run. Recommended by
`ci-doctor@1` on a `FLAKE` or `ENV` verdict; the idempotency scope
(`inputHash` over `{repo, runId}`) makes it structurally once-per-run — the
"don't keep re-running an ENV failure" rule as dedup, not discipline.

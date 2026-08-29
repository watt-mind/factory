# ci-log-capture — closed-registry action

Not a prompt: this definition runs a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
gh run view {runId} --repo {repo} --log-failed
```

The **whole** stream is captured to `failed.log` and declared as an artifact,
so the worker stores it content-addressed. Downstream `ci-doctor@2` reads
those exact bytes instead of calling GitHub again: the diagnosis becomes
reproducible and re-runnable offline, and a multi-megabyte log lives in the
artifact store rather than blowing the inline-evidence limit.

---
name: principle-make-operations-idempotent
description: "Apply when designing commands, scrapers, cron collectors, migrations, or lifecycle scripts. Converge to the same end state regardless of partial prior runs or retries."
disable-model-invocation: true
---

# Make Operations Idempotent

Commands, ingestion pipelines, cron collectors, and setup scripts must converge cleanly to the same end state if interrupted and re-run.

- **Checkpoint and skip completed work:** Resume safely from partial runs without duplicating rows, corrupting state, or re-fetching immutable artifacts.
- **Atomic writes & cleanup:** Write to temporary paths and rename atomically; clean up scratch/tmp directories so retries do not exhaust disk or hit stale locks.
- **Safe re-seeding:** Dev seeders and sync commands must be safe to run multiple times without failing on existing records.

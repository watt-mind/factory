---
title: Token Economics & Tracking
description: Real-time spend tracking and token accounting
---

Factory aggregates the usage data that each harness reports: tokens, cache reads and writes, wall time, turns, tool calls, and cost when available. Cost is a notional runaway gauge for subscription-authenticated harnesses, not a billing statement.

## Inspecting Economics

```bash
factory economics
factory economics --since 14d
factory economics --since 14d --json
```

The human-readable report groups results by harness, stage, and repository. It also highlights cache behavior, context re-sends, expensive runs, and runs that consumed a worker slot without producing a result. Use `--json` for dashboards or further analysis.

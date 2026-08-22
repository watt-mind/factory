---
title: Event Runtime Daemon
description: Architecture of the background event-driven sidecar
---

The **Event Runtime** is a background daemon that manages asynchronous dispatch, worker processes, recurring schedules, and the web control API.

## Starting the Daemon

```bash
factory serve                 # API and planner on 127.0.0.1:7381
factory serve --with-worker   # development: API plus an in-process worker
factory serve --all           # API plus the web UI
```

For unattended operation, run workers as separate processes (`factory events work` or `factory events supervise`) so restarting the API does not terminate an active agent.

## Architecture

<iframe
  class="diagram-embed"
  src="/factory/diagrams/event-runtime.html"
  title="Event runtime process"
  loading="lazy"
></iframe>

- **SQLite state store:** Transactional records for events, proposals, runs, attempts, leases, traces, and receipts.
- **Worker pool:** Claims planned runs and supervises a policy-bounded number of worker processes. Scale-down drains workers between claims.
- **Control API:** Loopback HTTP endpoints consumed by the web UI, connectors, and CLI tools.

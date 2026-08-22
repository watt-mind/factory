---
title: Web UI Dashboard
description: Real-time web dashboard for runs, events, and proposals
---

Factory includes a React 19 and Tailwind CSS dashboard for monitoring fleet operations:

```bash
factory web --dev   # Vite development server with HMR
factory web         # serve the built dashboard
```

## Features

- **Live run viewer:** Follow normalized assistant text, tool calls, results, and usage as a run progresses.
- **Causal graphs:** Trace events, proposals, runs, and follow-up chains through an interactive DAG.
- **Human-in-the-loop inbox:** Inspect proposals and held decisions, then approve, reject, requeue, or answer them with an audit trail.
- **Operations views:** Monitor workers, schedules, artifacts, metrics, projects, and effective configuration.

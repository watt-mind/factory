---
title: Multi-Repo Fleets
description: Managing multiple client and internal repositories
---

Factory can supervise multiple repositories concurrently with independent concurrency ceilings:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#multi-repo-fleet"
  title="Multi-repository fleet isolation"
  loading="lazy"
></iframe>

```bash
factory status                         # fleet-wide status overview
factory queue                          # readiness and capacity for configured repos
factory next --repo client-app         # recommend the next stage, read-only
factory next --repo client-app --apply # run that stage
```

Each `config/repos.yaml` entry has its own `max_in_flight`, base branch, verification command, control plane, and worktree lifecycle. The global `concurrency.max_in_flight_per_repo` policy supplies a default when a repository omits its own cap.

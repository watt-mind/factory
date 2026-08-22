---
title: Configuration Reference
description: Configuring repositories, policies, and schedules
sidebar:
  order: 4
---

Factory configuration lives in the `config/` directory.

## Repository Configuration (`config/repos.yaml`)

Defines the fleet of repositories managed by Factory:

```yaml
repos:
  - name: factory
    path: ~/Develop/factory
    github: watt-mind/factory
    team: WM
    project: Factory
    control_plane: github
    base: develop
    deploy_branch: main
    worktree_up: bin/worktree-up.sh
    worktree_down: bin/worktree-down.sh
    worktree_root: ~/Develop/.worktrees/factory
    max_in_flight: 3
    verify: bun test event-runtime/lib --timeout 20000 && bun run lint
```

### Fields

| Field           | Description                                                                   |
| :-------------- | :---------------------------------------------------------------------------- |
| `name`          | Stable repository name used by commands such as `factory next --repo <name>`. |
| `path`          | Path to the repository's primary checkout (`~` is supported).                 |
| `github`        | GitHub `owner/repository` slug.                                               |
| `team`          | Tracker team or routing key.                                                  |
| `project`       | Tracker project; for GitHub, the Projects v2 board title.                     |
| `base`          | Branch targeted by ticket PRs (for example, `develop`).                       |
| `deploy_branch` | Production branch (for example, `main` or `master`).                          |
| `control_plane` | Tracker backend: `github`, `linear`, or `memory`.                             |
| `max_in_flight` | Maximum concurrent agent worktrees permitted for this repository.             |
| `verify`        | Test and lint command used by the independent verification gate.              |
| `worktree_up`   | Repository-owned script that provisions an isolated worktree.                 |
| `worktree_down` | Repository-owned script that safely tears the worktree down.                  |
| `worktree_root` | Parent directory containing ticket worktrees.                                 |

## Policy Configuration (`config/policy.yaml`)

Sets security boundaries, escalation triggers, and harness timeouts:

```yaml
controlPlane:
  kind: github

dispatch:
  owned_paths_collision: advisory
  owned_paths_conformance: advisory

concurrency:
  max_in_flight_per_repo: 3
  max_concurrent_merges: 1

budget:
  per_ticket_usd: 15
  on_exhausted: drain

limits:
  max_run_minutes: 90

escalation:
  never_auto_merge:
    - auth / authz
    - payments / money movement
    - credential and secret handling
    - destructive DB migrations
    - production infra config
```

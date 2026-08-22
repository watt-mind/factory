---
title: CLI Reference
description: Essential Factory command-line workflows
---

Factory provides the `factory` CLI tool:

```bash
factory <command> [options]
```

## Core Verbs

| Command             | Description                                                                            |
| :------------------ | :------------------------------------------------------------------------------------- |
| `factory status`    | Displays repository freshness, deployment state, and queue health.                     |
| `factory demo`      | Runs the self-contained offline seven-step demo.                                       |
| `factory doctor`    | Diagnoses toolchains, authentication, configuration, and harnesses.                    |
| `factory ticket`    | Reads, files, claims, comments on, and transitions tracker tickets.                    |
| `factory queue`     | Shows dispatchable work, blockers, and available concurrency.                          |
| `factory next`      | Recommends the next stage; `--apply` runs it.                                          |
| `factory dispatch`  | Injects a registered event-runtime action such as `triage`, `status`, or `janitor`.    |
| `factory serve`     | Starts the event-runtime control API; `--all` also starts the web UI.                  |
| `factory events`    | Operates the event runtime: runs, proposals, workers, adapters, traces, and schedules. |
| `factory economics` | Summarizes reported usage, notional cost, cache behavior, and waste across harnesses.  |
| `factory security`  | Runs Gitleaks, Semgrep, and Actionlint for a repository.                               |

Run `factory help`, `factory dispatch --help`, or `factory events` for the current command surface. Stage workflows such as triage and merge are selected through `factory next` and the installed `/factory-*` harness commands rather than top-level `factory triage` or `factory merge` verbs.

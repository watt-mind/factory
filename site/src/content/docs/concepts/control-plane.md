---
title: Control Plane Adapters
description: Pluggable issue trackers and concurrency locks
---

The **control plane** is where work is admitted, claimed, and tracked. Pull requests and merges remain forge operations. Factory abstracts tracker behavior behind a `ControlPlane` adapter.

## Supported Adapters

| Adapter           | Status      | Features                                                                                          |
| :---------------- | :---------- | :------------------------------------------------------------------------------------------------ |
| **GitHub Issues** | Production  | GitHub Issues, Project v2 boards, labels, and issue comments. Zero third-party accounts required. |
| **Linear**        | Production  | Linear teams, projects, states, labels, comments, and GraphQL API access.                         |
| **Memory**        | Test / demo | In-memory tracker for `factory demo` and offline integration tests.                               |

## Concurrency Control via Claim Read-Back

To prevent race conditions between two concurrent dispatch loops:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#claim-readback"
  title="Claim read-back sequence"
  loading="lazy"
></iframe>

1. Agent A writes assignee = `Agent A` and state = `In Progress`.
2. Agent A immediately performs a **read-back query** to verify that the remote record reflects its own assignee ID.
3. If another agent won the race, Agent A aborts immediately and takes the next available ticket in the queue.

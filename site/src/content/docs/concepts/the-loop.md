---
title: The Loop Lifecycle
description: The 4 stages of unattended autonomous development
---

Factory operates as a continuous state machine across four distinct phases:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/loop-lifecycle.html"
  title="The Factory loop lifecycle"
  loading="lazy"
></iframe>

## 1. Triage (`/factory-triage`)

Intakes bug reports, feature requests, and alerts. A maintainer or triage loop converts them into **Agent-ready tasks** by:

- Narrowing scope to a single deliverable.
- Defining strict, disjoint `Owned Paths`.
- Providing explicit `Acceptance Criteria`.
- Supplying a runnable `Verification Command`.

## 2. Dispatch (`/factory-work`)

The dispatcher checks available concurrency slots and claims tickets:

- **Locking:** Assigns the ticket to the agent and marks it `In Progress`. A read-back confirms no race occurred.
- **Worktree:** Branches from `origin/<base>` into an isolated folder.
- **Agent execution:** Hands prompt and constraints to the chosen harness.

## 3. Independent Verification

When the agent reports completion:

- The worker executes the ticket's declared `Verification Command` directly.
- If tests or linters fail, the run does not advance. Failure evidence is retained so the ticket can be corrected or retried without treating self-attestation as success.

## 4. Review & Merge (`/factory-merge`)

Open PRs are evaluated:

- **CI Status:** Must be green.
- **Reviewer Critique:** Evaluates diff correctness, security rules, and project conventions.
- **Mechanical Fixes:** Fixes minor Prettier/ESLint issues automatically before final re-verification.
- **Merge:** Merges into the configured base branch. The ticket reaches `Done` only after the merge and any required post-merge checks succeed.

## The Reaper

If an agent crashes, stalls, or exceeds its configured deadline, the reaper reclaims the ticket and records recovery telemetry. Cleanup is conservative: a worktree with useful or ambiguous state may be retained for inspection rather than deleted.

---
name: principles
description: "Index of curated, guardrailed engineering principles for coding, architecture, verification, delegation, and tooling. Read when designing, implementing, debugging, reviewing, or benchmarking; load only the matching leaf principle-* SKILL.md."
---

# Engineering Principles

Read the matching leaf `SKILL.md` (`../<slug>/SKILL.md`) in full before applying a principle. Do not load all 19 into context at once.

**Precedence:** Repository `AGENTS.md` / Factory Floor rules (`Owned Paths`, `Never auto-merge`, `escalate_paths`, `Blocked` + `factory notify`, editorial publish gates, and data-honesty invariants) always take precedence over any principle below.

## Core & Design

- **`principle-laziness-protocol`** — Refactoring, sizing a diff, or tempted to add abstractions/layers. Consolidate decisions and minimize the diff without deleting required collateral or honest-gap metadata.
- **`principle-foundational-thinking`** — Before writing logic: choose core types, data structures, scaffold-vs-feature sequencing, and shared state ownership.
- **`principle-redesign-from-first-principles`** — Integrating a new requirement into an existing design. Redesign cleanly **inside `Owned Paths` and compatibility boundaries**; file `Triage` if it crosses them.
- **`principle-subtract-before-you-add`** — Sequencing an addition or refactor. Remove dead weight and redundant stubs first while preserving security/boundary guards and required schema fields.
- **`principle-minimize-reader-load`** — Reviewing or shaping code that is hard to trace. Collapse one-caller wrappers, shrink mutable scope, and reduce layers between question and answer.
- **`principle-experience-first`** — Product, UX, typography, or copy work. Render actual pixels, run ≥1 cold visual self-polish pass over rough first drafts, and surface 2–4 bounded screenshots by default without weakening tenant or security invariants.
- **`principle-build-the-lever`** — Any non-trivial or repeated work (migrations, bulk edits, checks). Build a rerunnable tool or script rather than doing it by hand.
- **`principle-exhaust-the-design-space`** — **Gated:** Net-new UI surfaces, material layout redesigns, greenfield architecture, or when explicitly requested (never routine bugfixes). Diverge into 2–3 distinct options, autonomously select and commit the winner, and record the rationale.

## Architecture

- **`principle-model-the-domain`** — Stateful logic, repeated shape assumptions, or scattered conditionals. Encode the domain in a state machine, typed model, table, or registry.
- **`principle-boundary-discipline`** — Validation, auth/JWT parsing, external HTML/API ingestion, or framework adapters. Guard at system boundaries; trust internal types and keep core logic pure.
- **`principle-type-system-discipline`** — Designing types or signatures. Make illegal states unrepresentable, brand semantic primitives, and exhaust variants.
- **`principle-make-operations-idempotent`** — Commands, scrapers, cron collectors, or lifecycle scripts. Converge to the same end state across partial runs, crashes, and retries.
- **`principle-separate-before-serializing-shared-state`** — Concurrent actors touching the same file, token, DB, or branch. Eliminate sharing first; serialize structurally only when a single writer is a real invariant.

## Verification

- **`principle-fix-root-causes`** — Debugging any failure. Trace the symptom back to the first place the system went wrong; a guard is a fix only when the state it handles is legitimate.
- **`principle-attack-the-premise`** — Two or more fixes sharing one premise have failed the same gate. Write the premise down and test it directly before writing another fix.
- **`principle-test-behavior-not-implementation`** — Writing or updating tests. Assert user-observable behavior so tests catch regressions and survive refactors (structural/AST checks remain valid when structure is the contract).
- **`principle-explain-the-number`** — Before trusting or reporting any benchmark, latency, cost figure, or eval score. Identify what limits it and rule out measurement confounds.

_(Note: direct artifact verification, context-window discipline, and verifiable unit sequencing are already enforced globally by `shared/floor.md` when present.)_

## Delegation & Meta

- **`principle-proceed-with-gates`** — Proceeds autonomously on reversible local work; **always stops** on human, editorial, security, `Never auto-merge`, `escalate_paths`, and data-honesty gates.
- **`principle-encode-lessons-in-structure`** — You catch yourself writing the same rule twice. Encode it as a lint, schema check, ratchet, or script with an actionable error message instead of more prose.

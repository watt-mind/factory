---
title: Factory Doctor
description: Environment and toolchain health diagnostics
sidebar:
  order: 5
---

`factory doctor` performs diagnostics across your system dependencies, agent harnesses, GitHub authentication, and tracker connectivity.

## Running Doctor

```bash
factory doctor
```

## Diagnostic Checks

`factory doctor` validates:

1. **System toolchains:**
   - Git and Bun versions
   - GitHub CLI (`gh`) installation and authentication
2. **Control-plane access:**
   - GitHub or Linear credentials, depending on configuration
   - Repository checkout freshness and tracker connectivity
3. **Agent harnesses:**
   - Claude Code, Codex, Gemini, Cursor, and Pi availability
   - Missing optional harnesses are reported as warnings
4. **Isolation and runtime:**
   - Docker, Colima, or supported micro-VM availability
   - Headless Chrome support for web audits
   - Worktree lifecycle scripts and verification commands for configured repositories

## Remediation

When a check fails, `factory doctor` prints a remediation hint next to the failing diagnostic:

```text
[FAIL] GitHub CLI is not authenticated.
  -> Run: gh auth login -h github.com
[FAIL] Missing required label "ai:agent-ready" in OWNER/REPO.
  -> Run: factory init --control-plane github --repo OWNER/REPO
```

## Verifying a fresh clone offline

`factory demo` answers a narrower question than `factory doctor`: does this checkout work at all, on a machine with no accounts, no API keys, and no network?

```bash
bin/factory demo --dry   # validate the plan; this is what CI runs
bin/factory demo         # claim → implement → verify → PR → merge
```

It copies `demo/repo/` into a temporary directory, runs the whole loop against an in-memory tracker and forge with a deterministic `fake` harness, and touches nothing in your checkout. No model is invoked, on any `--harness` value — the flag only changes which adapter is recorded on the demo ticket.

That makes it a good install check and a bad evaluation: it proves the machinery runs, not that factory helps with your code. For that, [connect a repository](/factory/getting-started/quickstart/).

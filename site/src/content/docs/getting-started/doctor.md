---
title: Factory Doctor
description: Environment and toolchain health diagnostics
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

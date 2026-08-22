---
title: Agent Configuration
description: Sandboxing, environment isolation, and harness settings
---

Harness adapters run agents in bounded workspaces and apply adapter-specific environment and tool policies. A dedicated worktree is process isolation, not a security sandbox; definitions that require a stronger boundary must use the Gondolin sandbox seam.

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#sandbox-boundary"
  title="Gondolin sandbox trust boundary"
  loading="lazy"
></iframe>

## Environment Sanitization

Before spawning a harness, Factory constructs a deliberate child environment rather than blindly forwarding the operator's shell. Provider API keys are generally removed so CLIs use configured subscription authentication. Mutating runs may inherit push credentials such as `SSH_AUTH_SOCK`, `GITHUB_TOKEN`, and `GH_TOKEN`; non-mutating runs strip them. Exact handling is adapter-specific, so treat any credential available to a host process as available to that process and require sandboxing when that trust is inappropriate.

## Sandboxed VM Execution (Gondolin)

For compatible definitions and adapters, Factory supports micro-VM isolation via Gondolin:

- The command runs inside an ephemeral Linux VM.
- Only the declared workspace is exposed through a filesystem provider.
- Network egress is default-deny and can be allow-listed.
- Secrets can remain host-side while the guest sees placeholders.

Check local availability before requiring it:

```bash
factory events sandbox doctor
```

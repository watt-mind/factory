---
title: Supported Harnesses
description: Overview of supported coding agents and adapters
---

Factory connects to multiple coding-agent CLIs without hard-wiring its workflow to one provider. Availability varies by execution path: the classic ticket runner supports Claude Code, Codex, Gemini / Antigravity, Cursor, and Pi, while the event runtime exposes its installed adapter registry — including Hermes Agent via ACP — with `factory events adapters`.

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#harness-routing"
  title="Pluggable harness routing"
  loading="lazy"
></iframe>

## Supported Agents

- **Claude Code** (`--harness claude`) — Anthropic's agentic coding CLI.
- **Gemini / Antigravity** (`--harness gemini` or `--harness agy`) — Gemini-compatible agent CLIs.
- **OpenAI Codex** (`--harness codex`) — OpenAI coding harness.
- **Cursor** (`--harness cursor`) — Cursor CLI and agent environment.
- **Pi** (`--harness pi`) — A lightweight, extensible coding-agent CLI.
- **Hermes Agent** (`hermes`) — An ACP v1 coding-agent adapter using the `hermes-agent-acp` binary. It is registered and conformance-tested, but has no production event route yet.
- **Fake adapter** (`--harness fake`) — Deterministic simulator for tests and the offline demo.

```bash
factory events adapters
```

This command lists the event runtime's built-in and extension-provided adapters, their source, and whether they support the Gondolin sandbox.

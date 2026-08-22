---
title: Architecture Specification
description: Deep architectural breakdown of Factory loops and components
---

Factory is structured around three foundational subsystems:

<iframe
  class="diagram-embed"
  src="/factory/diagrams/factory-architecture.html"
  title="Factory architecture layer stack"
  loading="lazy"
></iframe>

The control plane admits work and records ownership. The orchestrator makes
coordination decisions before an isolated harness process begins. Verification
runs outside the model process, and only accepted evidence reaches the durable
git, CI, and receipt record.

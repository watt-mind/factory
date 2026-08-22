---
title: Kernel & Packs Architecture
description: Extending Factory with modular workload packs
---

The Factory **kernel** provides planning, approval, execution, artifact, and verification primitives.

**Packs** add data-only agent definitions, pinned prompts and schemas, event routes, edges, and schedules. They do not ship executable adapters or hooks; those belong in operator-installed extensions.

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#pack-boundary"
  title="Kernel, pack, and extension boundary"
  loading="lazy"
></iframe>

```text
factory/
├── event-runtime/         # Kernel, workers, API, and web UI
└── packs/
    ├── example-hello/     # Smallest complete reference pack
    └── ops-disk/          # Read-only disk telemetry analysis loop
```

Packs are never auto-discovered. Scaffold and validate one, then add its exact path to `packs:` in `config/policy.yaml`:

```bash
factory pack init my-loop
factory pack validate packs/my-loop
```

---
title: Extension Specification
description: Manifests, connectors, hooks, and lifecycle events
---

Extensions are operator-installed directories or npm packages containing a `factory-extension.json` manifest:

```json
{
  "name": "acme/notifications",
  "version": "1.0.0",
  "description": "Notification connector and approval policy",
  "contributes": {
    "connectors": { "notify": "./connectors/notify.mjs" },
    "hooks": { "approve.before": "./hooks/approval.mjs" },
    "panels": ["./panels"]
  }
}
```

Extensions may contribute packs, adapters, validated configuration, approval hooks, connectors, declarative panels, and harness markdown. Code contributions run in the Factory process, so only an operator can enable them through the `extensions:` allow-list in `config/policy.yaml`.

```bash
factory events extensions validate /path/to/extension
factory events extensions list
```

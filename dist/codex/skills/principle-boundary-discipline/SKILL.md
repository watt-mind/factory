---
name: principle-boundary-discipline
description: "Apply when wiring validation, auth/JWT checks, external API/HTML ingestion, or framework adapters. Concentrate guards at system boundaries; trust internal types and keep core logic pure."
disable-model-invocation: true
---

# Boundary Discipline

Concentrate parsing, validation, and defensive guards at system boundaries (CLI args, config files, HTTP/JWT inputs, external APIs, scraped HTML, and database reads).

- **Parse once at the edge:** Convert untrusted external payloads into validated internal types at the boundary, then keep core business logic pure and free of defensive null-checks for impossible states.
- **Fail closed at boundaries:** Reject malformed inputs, missing auth, or unexpected schemas explicitly at the boundary rather than letting partial data leak inward.
- **Respect module boundaries:** Keep transport/proxy layers decoupled from offline ingest/analysis internals.

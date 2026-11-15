---
name: principle-model-the-domain
description: "Apply when writing stateful logic, branching repeatedly on shapes, or duplicating rules across files. Encode the domain in a structure instead of scattered conditionals."
disable-model-invocation: true
---

# Model the Domain

Encode domain rules in a single explicit structure—a state machine, typed model, lookup table, registry, or reducer—instead of scattering `if`/`else` chains across handlers and views.

- **Single source of truth:** Variants, transitions, pricing units, and status mappings belong in one typed table or model so adding a variant updates every consumer consistently.
- **Make invalid combinations obvious:** Prefer structured domain objects over parallel arrays or ad-hoc stringly-typed flags.

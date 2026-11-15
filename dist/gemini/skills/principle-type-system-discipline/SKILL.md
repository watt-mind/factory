---
name: principle-type-system-discipline
description: "Apply when designing types, schemas, or function signatures. Make illegal states unrepresentable, brand semantic primitives, parse external data at boundaries, and exhaust variants."
disable-model-invocation: true
---

# Type System Discipline

Use the type system (TypeScript, Pydantic/mypy, Django Ninja schemas, JSON Schema) to make illegal states unrepresentable at compile or parse time.

- **Model states as discriminated unions / tagged variants** instead of bags of optional booleans.
- **Brand or wrap semantic primitives** (IDs, currencies, tax-inclusive vs. net amounts, verified vs. candidate records) so they cannot be mixed silently.
- **Exhaustively match variants** so adding a new enum or status produces a type error everywhere it must be handled.

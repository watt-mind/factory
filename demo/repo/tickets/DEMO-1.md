# DEMO-1 feat: greet a caller by name

## Problem & Context

The bundled demo repo exports a version constant and nothing else. A caller
needs `greet(name)` so the factory's 15-minute quickstart has one complete,
reproducible ticket: claim, implement, verify, open a PR, merge — against
the in-memory control plane, with no third-party credentials.

## Acceptance Criteria

- [ ] `src/greet.mjs` exports `greet(name)` returning `Hello, <name>!`
- [ ] `greet("Ada")` equals `"Hello, Ada!"`
- [ ] empty or missing names throw
- [ ] `src/index.mjs` re-exports `greet`
- [ ] `bun test src/greet.test.mjs` passes

## Source File Pointers

- `src/index.mjs`
- `src/greet.mjs`
- `src/greet.test.mjs`

## Owned Paths

- `src/greet.mjs`
- `src/greet.test.mjs`
- `src/index.mjs`

## Verification Command

```
bun test src/greet.test.mjs
```

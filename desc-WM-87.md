Merge review findings on PR #186 (WM-76), polish/defence-in-depth: `web/src/lib/schema.ts` is a hand-port of `lib/schema.mjs` (review confirmed zero semantic drift today, clause by clause), but nothing in CI pins them together — add a checked-in fixture (schema + values matrix) both validators must agree on, run in both `bun test` suites. Also `new RegExp(s.pattern)` is unguarded and now runs inside `useMemo` on every keystroke in the dialog — a malformed pattern in a registered schema would throw during render and take the dialog down (the server-side contract gate should prevent this registering; this is defence-in-depth).

### Problem & Context
The frontend schema validator (`event-runtime/web/src/lib/schema.ts`) is a hand-port of the backend's `event-runtime/lib/schema.mjs`. Currently, there's no CI safeguard to ensure they remain semantically identical over time. Additionally, `web/src/lib/schema.ts` uses an unguarded `new RegExp(s.pattern)` during render. A malformed regex string in a schema would cause an exception during render and crash the UI dialog. 

### Acceptance Criteria
- A new shared JSON test fixture containing a matrix of schemas and values is added.
- `event-runtime/lib/schema.test.mjs` and `event-runtime/web/src/lib/schema.test.ts` both read this shared fixture and assert identical validation results.
- The `new RegExp(s.pattern)` call in `web/src/lib/schema.ts` is wrapped in a `try/catch`. If the regex is invalid, it should degrade gracefully without crashing the UI.

### Source File Pointers
- `event-runtime/web/src/lib/schema.ts`
- `event-runtime/web/src/lib/schema.test.ts`
- `event-runtime/lib/schema.mjs`
- `event-runtime/lib/schema.test.mjs`

### Owned Paths
- `event-runtime/web/src/lib/schema.ts`
- `event-runtime/web/src/lib/schema.test.ts`
- `event-runtime/lib/schema.mjs`
- `event-runtime/lib/schema.test.mjs`
- `event-runtime/test-fixtures/**`

### Verification Command
`cd event-runtime && bun test && cd web && bun test`

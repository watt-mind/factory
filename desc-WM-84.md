Merge review findings on PR #186 (WM-76), minor: (1) `submitJson()` guards required envelope fields via `REQUIRED.filter(...)` but `submitForm()` has no equivalent — reachable by deleting e.g. `eventId` in the JSON tab then switching to Form and injecting; degrades to a server 422 instead of a clean client error. Fix: run the same `REQUIRED` check against `formEnvelope` at the top of `submitForm`. (2) `onPick(null)` / `onPick("__given__")` set `text` and force the JSON tab but never call `initFormFromEnvelope`, leaving stale `formBase`/`formPayload` in the hidden Form panel — harmless today (tab disabled) but a trap for future changes. 

### Problem & Context
1. `submitForm()` lacks the required envelope-fields guard (`REQUIRED.filter(...)`) that `submitJson()` has. If a user deletes a required envelope field like `eventId` in the JSON tab and then switches to the Form tab to submit, it bypasses the client-side validation and results in a server 422 error.
2. Selecting `null` or `"__given__"` in the template picker forces the JSON tab and updates text but fails to call `initFormFromEnvelope`. This leaves stale data in `formBase`/`formPayload` in the hidden Form tab. While harmless currently because the Form tab is disabled in these states, it's a fragile state trap for future development.

### Acceptance Criteria
- `submitForm()` includes the same required envelope field guard as `submitJson()`. If a required envelope field is missing, it should produce a clean client-side validation error.
- When `null` or `"__given__"` are picked, the `formBase` and `formPayload` state must be properly reset or initialized via `initFormFromEnvelope` (or explicitly cleared) to prevent stale state.
- Existing dialog tests pass and new edge cases are covered.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`

### Verification Command
`cd event-runtime/web && bun test`

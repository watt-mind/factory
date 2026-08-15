Merge review findings on PR #186 (WM-76): (1) polish — field errors print raw regex source (`$.mount: does not match pattern ^/[A-Za-z0-9/._-]*$`) under the input, exactly the leak critique round 1 removed from placeholders; humanize pattern errors in `errorsByField`, reusing `placeholderFor`. (2) minor — a malformed hidden planner field (e.g. `repoPin` arriving via JSON→Form) surfaces in `formLevelErrors` as text with no control to fix it; name the JSON tab explicitly in that message as the fix path.

### Problem & Context
1. Field errors for validation mismatches currently print the raw regex source (e.g., `$.mount: does not match pattern ^/[A-Za-z0-9/._-]*$`) under the input. We need to humanize these pattern errors in `errorsByField`, reusing `placeholderFor` logic or similar.
2. If a hidden planner field (like `repoPin`) has an error (e.g., when populated via the JSON tab), the error surfaces in `formLevelErrors` as plain text without an actionable control in the Form tab. The error message should explicitly instruct the user to switch to the JSON tab to fix it.

### Acceptance Criteria
- Pattern validation error messages do not leak raw regex strings; they use a humanized message (e.g., indicating the expected format).
- Validation errors for hidden planner fields in `formLevelErrors` explicitly mention the "JSON tab" as the place to fix them.
- Existing tests pass, and new tests/snapshots reflect the updated error messages.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/lib/injectForm.ts`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/lib/injectForm.ts`

### Verification Command
`cd event-runtime/web && bun test`

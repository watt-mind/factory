UX critique finding (WM-76, minor): required string fields display "shorter than minLength 1" the instant a template is selected, before any interaction — every fresh form looks broken on arrival. Standard practice: track touched state per field and show errors only after blur or a submit attempt (the submit-time ack flow already exists and should be unchanged).

### Problem & Context
When a template is selected, required fields instantly show validation errors (like "shorter than minLength 1") before the user has even interacted with them. This makes the fresh form appear broken immediately. We need to suppress these field-level validation errors until the field has been touched (on blur) or a submit is attempted.

### Acceptance Criteria
- Validation errors for individual fields are hidden until the field is `touched` (receives and loses focus) or until the user attempts to submit the form.
- The existing form-level submission acknowledgment flow remains unchanged.
- Form field components correctly track their touched state.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/lib/injectForm.ts`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/lib/injectForm.ts`

### Verification Command
`cd event-runtime/web && bun test`

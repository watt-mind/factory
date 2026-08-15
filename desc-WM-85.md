Merge review finding on PR #186 (WM-76), minor: `needsSchemaAck()` sets both `schemaAck` and `confirming` in one pass, so sending a schema-invalid payload is Inject → "Confirm inject", identical interaction cost to a valid submit — only the warning copy differs, and an operator with the two-click rhythm internalized can send invalid without reading it. The reset paths are correct (any payload edit clears both acks; review confirmed nothing can be sent without the warning rendering and nothing gets stuck). Fix options: label the confirm button "Inject anyway" when `schemaAck` is set, or make the ack a genuine third step.

### Problem & Context
Sending a schema-invalid payload currently requires the same number of clicks (Inject → Confirm inject) as a valid submit. A user could accidentally bypass the schema warning out of habit. We need to distinguish the confirmation flow for invalid payloads either by changing the button copy (e.g., "Inject anyway") or by adding an explicit third step for the acknowledgment.

### Acceptance Criteria
- When a schema warning is present (`schemaAck` is needed), the confirm button must be visually or textually distinct (e.g., labeled "Inject anyway" and/or styled differently, such as a warning color) so it breaks the automatic two-click rhythm.
- Or, the interaction is changed to explicitly require acknowledging the warning before the confirmation step.
- Existing dialog tests pass and new snapshots/tests reflect the new behavior or button labels.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`

### Verification Command
`cd event-runtime/web && bun test`

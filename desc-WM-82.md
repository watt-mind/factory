UX critique finding (WM-76, polish/a11y): the `usedPct` spinbutton exposes `valuemax="0" valuemin="0"` in the accessibility tree even though the schema enforces 0–100 and visual validation works. Screen-reader users get a misleading valid range. Likely the numeric input isn't wiring `min`/`max` (or `aria-valuemin/max`) from the schema's `minimum`/`maximum`.

### Problem & Context
Numeric fields in the Inject Form (e.g., the `usedPct` spinbutton) currently expose incorrect `valuemin` and `valuemax` attributes (both as "0") to the accessibility tree. Although visual validation and schema constraints (e.g. 0-100) are working properly, screen readers receive misleading information about the field's valid range because the HTML input primitive does not inherit `min` and `max` constraints from the JSON schema.

### Acceptance Criteria
- Numeric inputs correctly pass down `schema.minimum` and `schema.maximum` to their HTML `min` and `max` (and/or `aria-valuemin`/`aria-valuemax`) attributes.
- The accessibility tree correctly reports the valid numeric bounds for screen reader users.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/components/ui.tsx`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/components/ui.tsx`
- `event-runtime/web/src/components/ui.test.tsx`

### Verification Command
`cd event-runtime/web && bun test`

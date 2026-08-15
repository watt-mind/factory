UX critique finding (WM-76, polish): the template picker resets to "blank envelope" on every open. The operator persona triggers the same two templates (triage-scan, status-report) a few times a day — preselecting the last-used template (e.g. localStorage) would remove repeated friction on the highest-frequency path. Keep "blank envelope" reachable in one click/keystroke.

### Problem & Context
Currently, the Inject Dialog's template picker resets to "blank envelope" every time the dialog is opened. Users frequently use the same templates (e.g., triage-scan, status-report) repeatedly. Remembering and pre-selecting the last-used template via `localStorage` would remove friction for this common workflow.

### Acceptance Criteria
- The template picker saves the user's last selected template to `localStorage` (or similar client-side persistence).
- Upon opening the dialog, the last-used template is automatically pre-selected.
- "Blank envelope" remains a top-level, single-click/keystroke option in the picker.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`

### Verification Command
`cd event-runtime/web && bun test`

UX critique finding (WM-76, minor): the repo picker (`SuggestInput` in `event-runtime/web/src/components/ui.tsx`) uses a native `<input list>` datalist — functionally correct (short names vs owner/name slugs verified) but visually an unstyled browser dropdown, inconsistent with the custom-styled chips/selects around it. Replace with a small custom suggestion popover consistent with the OKLCH token design system (keep free-text write-in and keyboard support).

### Problem & Context
The `SuggestInput` component uses a native `<input list>` (`datalist`) for the repo picker. While functionally correct, it renders as an unstyled browser dropdown that breaks consistency with the rest of the OKLCH token design system. We need to replace the native `datalist` with a custom suggestion popover that maintains free-text input and full keyboard support (up/down/enter).

### Acceptance Criteria
- `SuggestInput` uses a custom-styled popover instead of a native `datalist`.
- The popover uses the project's existing design system styling.
- Free-text write-in capability is preserved.
- Keyboard navigation (ArrowUp, ArrowDown, Enter, Escape) works seamlessly within the suggestion popover.

### Source File Pointers
- `event-runtime/web/src/components/ui.tsx`

### Owned Paths
- `event-runtime/web/src/components/ui.tsx`

### Verification Command
`cd event-runtime/web && bun test`

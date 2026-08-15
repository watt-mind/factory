UX critique findings (WM-76, minor + polish): (1) opening the Inject dialog via the `i` hotkey does not focus the template search box, so keystrokes right after `i` go nowhere — the header advertises `i inject` next to `⌘K commands`, implying a type-immediately flow; (2) ArrowDown from the search box does nothing — arrow navigation only works after Tab-ing into the radiogroup; command-palette convention is search-box ArrowDown descends into results.

### Problem & Context
1. Opening the Inject dialog via the `i` hotkey does not auto-focus the template search box. This breaks the type-immediately flow implied by the `i inject` shortcut (similar to `⌘K commands`).
2. Pressing `ArrowDown` while focused in the search box currently does nothing. Users expect it to descend into the search results, following standard command-palette conventions.

### Acceptance Criteria
- Triggering the Inject Dialog via the `i` hotkey automatically focuses the template search input.
- Pressing `ArrowDown` inside the search input transfers focus down into the first result of the template radiogroup.
- Keyboard navigation flows seamlessly from search to results without requiring Tab.

### Source File Pointers
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/App.tsx`

### Owned Paths
- `event-runtime/web/src/components/InjectDialog.tsx`
- `event-runtime/web/src/App.tsx`

### Verification Command
`cd event-runtime/web && bun test`

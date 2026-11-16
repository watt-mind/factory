# Create a note

Create note lets a user save a titled note from the UI or CLI, cancel an unfinished draft cleanly, and confirm persistence across a reload or secondary view.

## Sub-features

- `create-open` — opens a blank editor from toolbar or keyboard shortcut.
- `create-save` — validates and persists title and body.
- `create-cancel` — discards an unfinished draft without saving.
- `create-cli` — creates the same record via CLI.

## How to get to it (user POV)

- Click the `New note` button in the main toolbar.
- Press `n` while focus is outside text inputs.
- Run `notes create --title <title> --body <body>` in a terminal.

## Driving it with <harness>

Preconditions:

- App is healthy on the worktree URL and authenticated as the seeded user.
- `Doctor` passed against the worktree instance.
- No existing note is titled `Release checklist`.

- **Open editor:** Activate button `New note` (by ARIA role/name). Verify form `Note editor` renders with focus in `Title`.
- **Enter content:** Fill `Title` with `"Release checklist"` and `Body` with `"Tag and publish"`. Verify `Save note` becomes enabled.
- **Save note:** Click `Save note`. Verify confirmation renders and heading shows `Release checklist`, with zero console or `5xx` errors in network/console logs.
- **Confirm persistence:** Navigate away to `All notes`, reload the page (`location.reload()`), and reopen `Release checklist`. Verify both `Title` and `Body` persist intact.
- **Cancel edge path:** Click `New note`, fill `Title` with `"Discard me"`, and click `Cancel`. Return to `All notes` and verify `"Discard me"` is absent.
- **Proof:** Capture a bounded mobile/element screenshot (`≤ 1 MB`) of the persisted state outside the repo (`$FACTORY_ARTIFACT_DIR` / `ux-screenshots/`).

## Gotchas

- Keyboard shortcut `n` is ignored while an input or textarea holds focus.
- Titles are trimmed on save; assert trimmed output.
- Do not treat an optimistic toast as proof of save — always reload or inspect from `All notes`.
- Delete `Release checklist` during fixture cleanup while keeping the captured screenshot.

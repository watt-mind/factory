# Dogfood-in-public badge (draft)

**DRAFT — a human pastes this. Agents do not publish, and they do not
edit README.md from this ticket (Owned Paths do not include it).**

The updater that refreshes the count lives on a sibling ticket
(WM-958). This snippet is the static launch version, pinned to the
window in `docs/oss/launch-post.md`.

## README / social preview

```markdown
[![Dogfooded in public](https://img.shields.io/badge/dogfooded-17_days_unattended-0f766e)](docs/oss/launch-post.md)
```

Alt copy if the post is not yet linked from the default branch:

```markdown
[![Dogfooded in public](https://img.shields.io/badge/dogfooded-in_public-0f766e)](https://github.com/watt-mind/factory)
```

## What the badge is allowed to claim

The number is the unattended dispatch window from
`bun tools/launch-numbers.mjs --since 2026-08-03` (`window.days` /
`window.weeks`). It is not a streak, not uptime, and not "no humans
work here." Re-run the command when the badge is updated.

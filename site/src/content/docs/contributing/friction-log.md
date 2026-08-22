---
title: Public Friction Log
description: Measured harness edge-cases and engineering lessons
---

The Friction Log records observed harness defects, agent failure modes, and protocol improvements:

- **F-08 (Fixed):** Agents were running `sleep 180` to wait for CI. _Resolution:_ Replaced with `gh pr checks --watch --fail-fast`.
- **F-11 (Fixed):** Terminated runs left Chrome holding a shared profile lock. _Resolution:_ Factory-spawned sessions now use isolated browser profiles; operators attach rather than killing another run's browser.
- **F-12 (Fixed):** Third-party tracker CLIs drifted in syntax and serialization. _Resolution:_ Tracker operations go through the cwd-independent `factory ticket` adapter.

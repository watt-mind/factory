---
name: principle-build-the-lever
description: "Apply to non-trivial or repeated work: migrations, bulk edits, analyses, or recurring checks. Build a rerunnable tool or script instead of doing it by hand."
disable-model-invocation: true
---

# Build the Lever

When facing repetitive edits, multi-file migrations, or complex verification, build the tool that performs or proves the work (a codemod, script, generator, or deterministic check) rather than editing by hand.

- **Rerunnable proof:** A reviewer can rerun your script or check instead of trusting a manual walkthrough.
- **Keep it scoped:** Put one-off scripts in scratch or delete them if they are not meant to live in the repo; commit levers that prevent future regressions.

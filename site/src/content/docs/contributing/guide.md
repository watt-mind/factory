---
title: Contributor Guide
description: How to contribute code, documentation, and adapters to Factory
---

Thank you for contributing to Factory!

## Development Setup

```bash
git clone https://github.com/watt-mind/factory.git
cd factory
bun install --frozen-lockfile
cd event-runtime/web && bun install --frozen-lockfile && cd ../..
```

## Test and format

Before opening a pull request, ensure all verification checks pass:

```bash
bun run format:check
bun run lint
bun test --timeout 20000 --max-concurrency=4 event-runtime/lib
bun run check
factory security
```

For documentation changes, also run `bun run --cwd site build`.

## Pull Request Guidelines

- Branch from `develop` (not `main`).
- Use a Conventional Commit subject: `type(scope): summary (ISSUE-ID)`.
- Include regression tests for new behavior and bug fixes.
- Keep each ticket's changes inside its declared Owned Paths.

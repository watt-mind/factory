# Contributing to Factory

Thank you for helping improve Factory. Contributions may include bug reports,
documentation, tests, fixes, and focused feature proposals.

## Before you start

- Search the existing GitHub issues and pull requests before opening a new one.
- Use the appropriate issue template. Please report vulnerabilities privately
  as described in [SECURITY.md](SECURITY.md), not in a public issue.
- For a substantial change, open an issue first so maintainers can confirm the
  design and whether the work belongs in the Apache-licensed core or at the
  [`ee/`](ee/README.md) boundary.
- Keep one pull request focused on one issue. Unrelated discoveries should be
  reported separately.

All participation in this project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Factory requires Git and [Bun](https://bun.sh/) 1.3 or newer.

```bash
git clone https://github.com/watt-mind/factory.git
cd factory
bun install --frozen-lockfile
cd event-runtime/web && bun install --frozen-lockfile && cd ../..
```

See [SETUP.md](SETUP.md) for optional local harness links and instructions for
running the event runtime. Do not commit credentials, local runtime state,
worktrees, generated launch-agent files, or agent transcripts.

## Make a change

1. Branch from `develop`.
2. Add or update tests for behavior changes. A regression test should fail
   before the fix and pass afterward.
3. Edit source files rather than generated copies. In particular, `shared/` is
   the source of truth for content emitted into `plugins/` and `dist/`; run
   `bun build/emit.mjs` after changing it.
4. Keep changes narrowly scoped and update user or operator documentation when
   behavior changes.

## Test and format

Run the checks relevant to your change, then run the complete suite before
requesting review:

```bash
bun run format
bun run lint
bun run check
bun test
```

Changes under `event-runtime/web/` should also pass:

```bash
cd event-runtime/web
bun run build
```

The repository uses Prettier with the checked-in `.prettierrc` and ESLint with
`eslint.config.mjs`. Do not disable rules, weaken tests, or update generated
files by hand to make a check pass. If a check appears wrong, describe the
failure in the pull request instead.

## Commit conventions

Use a Conventional Commit-style subject:

```text
type(scope): concise imperative summary (WM-123)
```

Common types include `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`,
and `build`. Repository work tracked internally must include its assigned
ticket ID. A maintainer can provide that ID before a larger contribution is
started; for a small external contribution that has no internal ticket, the
commit hook documents the deliberate `FACTORY_NO_TICKET=1` escape hatch.

Keep the subject focused, explain motivation and trade-offs in the body when
needed, and avoid mixing mechanical formatting with unrelated behavior.

## Pull requests

- Target `develop`, not `main`.
- Complete the pull request template and link the issue the change resolves.
- Include the exact commands you ran and any relevant output or screenshots.
- Call out security impact, compatibility concerns, and follow-up work.
- Expect review feedback. Approval and passing automation are both required;
  an author does not merge their own pull request.

## Licensing and CLA

By submitting a contribution, you agree that it is licensed under the
[Apache License 2.0](LICENSE) and that you have the right to provide it under
those terms.

Watt Mind may require a Contributor License Agreement (CLA) for a contribution.
When a CLA applies, a maintainer or automated check will provide the exact
agreement and signing instructions, and the contribution cannot be merged
until the agreement is complete. Do not submit employer-owned or third-party
material unless you are authorized to license it.

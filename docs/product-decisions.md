# Product decisions

Recorded so the next agent does not re-litigate them. The webui spec
(`docs/event-runtime-webui.md`) is the view-level contract; this file is the
cross-cutting calls that several tickets share.

## Operator context tabs (OPS-356)

The Linear-style strip above the inverted-L is a **filter context**, not a
container every agent must live in, and not a replacement for the nav rail.

- **All** is the default, never closable, and byte-identical to the pre-tab UI.
  It is the home for anything that is not a `repos.yaml` project: unscoped
  runs, registry agents, workers, the graph, inject.
- **A factory repo tab** filters Events / Proposals / Runs (and Overview
  lists that can be filtered honestly) to rows whose spec or envelope _names_
  that repo. It does not remount a different app. A run's repo is optional
  input (`repoPin.repo` / `input.repo` / `input.repos[]`), not a foreign key.
- **In flight** is a query tab, not a fake repo: Runs in `LEASED` or
  `RUNNING` across every repo. Landing on it shows the Runs list.
- Project tabs **do not own agents**. The Agents rail is always the global
  registry. Workers, Graph, and Inject stay global in every context — hiding
  the fleet behind a repo would lie about who can claim the next run. Those
  views caption that they are unscoped when a project filter is on.
- Unscoped rows (`repos: []`) appear only under All (and In flight, if live).
  There is no "Unscoped" project tab; All already is that bucket.
- The hash still names **view + selection** (`#/runs/:id`). The strip is
  session chrome (`sessionStorage`). Optional `?project=` on the hash keeps
  the active filter across refresh (`inflight` is reserved). A pasted
  `#/runs/:id` without that query opens All and selects the row.
- `g e` / `g r` / `j`/`k` / Esc stay inside the current context. Do not steal
  `[` / `]` (status tabs). One poller; background tabs restore a filter on
  focus, they are not keep-alive iframes.
- The Projects _view_ (OPS-300) is a list of the registry, including janitor
  later. Context tabs _use_ `GET /repos`; they do not replace that view.
- Pinning a specific run as a document tab on the same strip is OPS-357
  (v2) — not this decision.

## Factory self-dispatch (OPS-463)

Decided 2026-08-14. The factory repo is an ordinary dispatch target:
`report_only` removed, `worktree_up`/`worktree_down` point at
`bin/worktree-up.sh`/`bin/worktree-down.sh` (isolated checkout, ports, runtime
home, demo runtime), `max_in_flight: 20` for throughput, Linear routing
WM / Factory. No `worktree_warm` — `bin/worktree-warm.sh` does not exist in
this repo and the field is optional; do not invent it. Containment is process,
not trust: dispatched tickets never touch the live control plane's runtime
home, and a merged change only runs after the operator pulls and restarts
(architecture §4). Loop schedules for factory are follow-up scope, not part of
this decision.

## Janitor Dry + Apply (OPS-301)

See that ticket. Dry is default; Apply is behind a typed confirm of the repo
name, and only after a Dry in the same panel. Out of scope for context tabs.

## Code formatting & Prettier check (WM-610)

Decided 2026-08-18. Big-bang one-shot `prettier --write` reformat across the ~283 code
files (`.mjs`, `.ts`, `.tsx`, `.md`) to land when the review queue drains. Sequence
strictly after WM-607 (ESLint) is merged so ESLint and Prettier rules do not conflict.
Configure `.prettierrc` and `.prettierignore` (ignoring `dist/`, `graphify-out/`,
`node_modules/`, `bun.lock`, `deploy/launchd/`).

## Web UI Browser E2E suite (WM-611)

Decided 2026-08-18. Browser-level Playwright test suite in `event-runtime/web/e2e/`,
covering 5 core user journeys against mock/seed runtime. Gated in GitHub Actions via
an opt-in `run-e2e` label until proven stable on self-hosted runners.

## Telegram actions and write paths (WM-288)

Decided 2026-08-18. Telegram notifications remain outbound-only deep links to the Web UI
over Tailscale. No inbound Telegram bot webhook endpoint or long-polling write path will
be introduced into `serve`, preserving the loopback-only security confinement (OPS-408, WM-61).

## Operational overlay (WM-887)

Decided 2026-08-19. Swift harness / model changes are a **machine-local overlay**
in `runtime.db`, applied at plan time. They do not write
`event-types.json`, `agents/*.json`, or `config/policy.yaml`. Packs cannot
shadow built-ins (WM-470 duplicate keys fail closed); WM-479 apply is a
different write path (whole resources into an API-managed pack) and stays
out of this loop.

Precedence, highest first: envelope / ticket per-run fields (WM-694,
WM-488) → overlay → git. In-flight RunSpecs are immutable. Process-wide
`--adapter-override` remains execution substitution and does not change
model resolution; the overlay changes `mapping.adapter` so the model follows
the effective adapter's `policy.yaml` `models:` map.

The fleet default still moves by PR. Promoting an overlay into git is WM-889.
The global `models:` map itself is WM-888. Agents UI on this store is WM-884.

## Overview expired-open proposals (WM-979)

Decided 2026-08-20. TTL-expired open proposals are not a Needs-you decision.
Approve is disabled once TTL has elapsed; reject and bulk reject live on
Proposals with the Expired chip (`onJumpExpired`).

Overview therefore:

- Does not list `expiredOpenProposals` in Needs you Runtime (no per-id "View
  proposal" jumps for a spec that cannot be approved).
- Collapses them to one Anomalies row whose action is **Review expired**.
- Wires the Approval Gate expired tile to the same jump.

Inbox `proposal_expired` items remain Needs-you Decide rows when they exist.
Auto-expiry of leftover chain proposals is WM-445, not this.

## Kernel npm distribution (WM-949 / gh-861)

Decided 2026-08-21. The Factory kernel is distributed to npm as
`@watt-mind/factory` under the `watt-mind` npm organization: a public
package, Apache-2.0, `publishConfig.access: "public"`. `package.json` carries
a `files` allowlist so a published tarball never contains test files,
`test-support/`, or gitignored operator config (`config/repos.yaml`,
`config/policy.yaml`, `config/schedule.yaml`, `.env*`) — `tools/publish.mjs
--dry-run` gates that with `npm pack --dry-run` before any publish.

Semver while pre-1.0: PATCH is fixes/docs, MINOR is a backward-compatible
addition to the kernel's public surface, and a breaking change to a
documented contract ships with upgrade guidance in the release notes.
Releases are a `vX.Y.Z` tag on `deploy_branch` (`main`) with GitHub Release
notes generated from merged PRs since the previous tag; this decision does
not introduce automated tag/release/publish machinery, only the package
metadata and the pre-publish gate.

An instance pins an exact published version (matching the exact-pin
discipline `templates/starter/` already applies with its Git commit pin),
never a floating range — see [`docs/instances.md`](instances.md) for the
upgrade contract. `templates/starter/package.json` and
`tools/publish-starter.mjs` still validate a Git commit pin as of this
decision; migrating the starter template itself to the npm-published pin is
follow-up scope, not part of this change.

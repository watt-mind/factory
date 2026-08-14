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
  lists that can be filtered honestly) to rows whose spec or envelope *names*
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
- The Projects *view* (OPS-300) is a list of the registry, including janitor
  later. Context tabs *use* `GET /repos`; they do not replace that view.
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

# Control plane protocol

Tracker-neutral contract for the factory's ticket adapter (`lib/control-plane/`, WM-797). Implementations exist for Linear (v1), an in-memory fake (tests / offline demo), and GitHub Issues (`lib/control-plane/github.mjs`, WM-798).

This file is the **adapter contract**, not the full agent operating protocol. Dispatchable predicates, Owned Paths, heartbeats, and harness packaging still live in the operator's `linear.md` until WM-795 copies them here. What this document freezes is the vocabulary everything outside `lib/control-plane/` is allowed to speak.

Call `loadControlPlane({ root })` for Linear/memory. The GitHub Issues adapter is `githubControlPlane()` in `lib/control-plane/github.mjs` (wiring `kind: github` into `loadControlPlane()` is a follow-up so this ticket stays inside Owned Paths). Selection is `config/policy.yaml`:

```yaml
controlPlane:
  kind: linear # default when the stanza is absent
  # kind: memory   # in-process fake; no network
  # kind: github   # Issues + Projects; zero Linear account
  # github:
  #   repo: owner/name
  #   teams: { DEMO: owner/name }   # team key → repository
  #   project: Factory              # Projects v2 title
  #   statusField: Status
```

`factory init --control-plane github` writes those GitHub defaults (see `config/policy.example.yaml`). An unknown kind is a configuration error. A tracker the factory cannot reach must never be silently read as "no tickets".

## GitHub Issues binding

| Protocol     | GitHub                                                                                        |
| :----------- | :-------------------------------------------------------------------------------------------- |
| `identifier` | `owner/repo#42`                                                                               |
| `team`       | Repository, via `controlPlane.github.teams` (or a key that already looks like `owner/name`)   |
| `labels`     | Issue labels of the **same spelling**. Writes send the complete resulting set, never a delta. |
| `assignee`   | Issue assignee. `claim` assigns the `gh` viewer, then **reads the assignee back**.            |
| `state`      | Projects v2 single-select (`project` / `statusField`). Options must match the names below.    |
| `raw`        | GraphQL via `gh api graphql`, or a REST path when the query string starts with `/`.           |

Production talks to GitHub through `gh api` — the same CLI the forge already requires. No Octokit, no Linear token. `gh auth login` is the quickstart credential.

## Ticket shape

Every verb returns this object (or a list of them). Labels are a flat array — never a GraphQL `{ nodes }` wrapper.

| Field         | Meaning                                                              |
| :------------ | :------------------------------------------------------------------- |
| `id`          | Opaque tracker id (Linear UUID, GitHub issue node, memory key)       |
| `identifier`  | Human-facing key (`WM-797`, `owner/repo#42`)                         |
| `title`       |                                                                      |
| `description` | Markdown body                                                        |
| `url`         |                                                                      |
| `state`       | `{ id?, name, type? }` — names below                                 |
| `assignee`    | `{ id, name? }` or `null`                                            |
| `team`        | `{ key }` (Linear team key; GitHub will bind this to a repo/project) |
| `project`     | `{ name }` or `null`                                                 |
| `labels`      | `[{ id?, name }]`                                                    |

## States

The factory's lifecycle, as names. Adapters map these onto tracker-native columns / labels / project status.

`Triage` → `Todo` → `In Progress` → `In Review` → `Done`

`Blocked` is the holding state for a question the agent cannot answer. Canceled is a tracker-native close; adapters do not invent it as a factory state.

## Labels the loops depend on

These names are part of the protocol, not Linear branding. A GitHub Issues adapter binds them to issue labels of the same spelling.

| Label             | Meaning                                                                               |
| :---------------- | :------------------------------------------------------------------------------------ |
| `ai:agent-ready`  | Waiting to be picked up. Dispatchable only in `Todo` with this label and no assignee. |
| `ai:in-progress`  | An agent holds the claim.                                                             |
| `ai:needs-review` | PR is up; merge stage owns it.                                                        |
| `ai:blocked`      | Waiting on a human.                                                                   |
| `agent:<harness>` | Which harness holds the claim. CLI `claude` maps to `agent:claude-code`.              |
| `type:*`          | `bug` `feature` `ui-ux` `security` `performance` `maintenance` `docs` `a11y`          |
| `source:*`        | `agent` `human` `sentry` `client-support`                                             |
| `area:*`          | Free-form, workspace-defined.                                                         |

`type:chore` is invalid. Adapters reject it locally rather than as an opaque API error.

## Verbs

| Verb                                               | Contract                                                                                                                                                                                                                                                                                                                                           |
| :------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getTicket(id)`                                    | One ticket. Missing → `ControlPlaneError`.                                                                                                                                                                                                                                                                                                         |
| `listComments(id)`                                 | Comments as `{ id?, body, createdAt?, user }`.                                                                                                                                                                                                                                                                                                     |
| `listDispatchable({ team, project? })`             | `Todo` + `ai:agent-ready` + unassigned. This **is** the dispatcher's predicate; do not rephrase it at a call site.                                                                                                                                                                                                                                 |
| `claim(id, { harness? })`                          | Move to `In Progress`, assign the viewer, drop `ai:agent-ready`, add `ai:in-progress` + `agent:<harness>`. Then **read the assignee back**. `{ ok: false }` means another actor won the race — not an exception. Linear has no compare-and-swap; this read-back is the only concurrency control the factory has, and every adapter must honour it. |
| `comment(id, body)`                                | Create a comment. `FACTORY_RUN_ID` is stamped as `run:<id>` when set.                                                                                                                                                                                                                                                                              |
| `transition(id, state, { add, remove, unassign })` | Move to a named state and/or change labels. Unknown state → error listing the ones that exist.                                                                                                                                                                                                                                                     |
| `setLabels(id, { add, remove })`                   | Compute the **complete** resulting label set and write that. Passing only the labels you want added is how every other label on the ticket disappears.                                                                                                                                                                                             |
| `file({ team, title, body?, labels?, state? })`    | Create a ticket. Default state `Triage`.                                                                                                                                                                                                                                                                                                           |
| `appendDetail(id, markdown)`                       | Idempotent description append. `{ appended: false }` if the text is already present.                                                                                                                                                                                                                                                               |
| `raw(query, variables?)`                           | Escape hatch. Linear GraphQL; GitHub GraphQL via `gh api graphql` (REST when `query` starts with `/`). Grows only when a call site cannot be expressed with the verbs above.                                                                                                                                                                       |

Every method returns the parsed answer or throws `ControlPlaneError`. `claim` returning `{ ok: false }` is the one protocol outcome that is not an error.

## What is not in this file yet

The agent-facing operating protocol — one process per ticket, Owned Paths as the concurrency key, heartbeat cadence, the five-section ticket template, harness packaging — is still the operator's `linear.md`. WM-795 moves that text into this path so a public clone does not depend on `~/Develop/hdkiller`. Until then, do not treat this file as a replacement for it.

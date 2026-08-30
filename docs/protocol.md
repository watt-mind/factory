# Control plane protocol

Tracker-neutral operating contract for factory agents. A public clone of this
repository does not need any operator-private path; this file is the protocol.
The ticket adapter lives in `lib/control-plane/` (WM-797). Implementations
exist for Linear (v1), an in-memory fake (tests / offline demo), and GitHub
Issues (`lib/control-plane/github.mjs`, WM-798).

The floor (`shared/floor.md`, spliced into each repo's `AGENTS.md`) is the
short form agents already have in context. **Read this file only for the
reference tables and the sections the floor points at** — routing, the
five-section template, the filing bar, adapter verbs — never instead of the
floor, and never the whole file when one section answers the question.

Call `loadControlPlane({ root })` to select Linear, memory, or GitHub Issues.
`controlPlane.kind: github` is fully wired (WM-955): it constructs
`githubControlPlane()` with the `controlPlane.github` options (`repo`,
`teams`, `project`, `statusField`). Selection is `config/policy.yaml`:

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

`factory init --control-plane github` writes those GitHub defaults (see
`config/policy.example.yaml`). An unknown kind is a configuration error. A
tracker the factory cannot reach must never be silently read as "no tickets".

## GitHub Issues binding

| Protocol     | GitHub                                                                                        |
| :----------- | :-------------------------------------------------------------------------------------------- |
| `identifier` | `owner/repo#42` or `configured-repo-name#42`                                                  |
| `team`       | Repository, via `controlPlane.github.teams` (or a key that already looks like `owner/name`)   |
| `labels`     | Issue labels of the **same spelling**. Writes send the complete resulting set, never a delta. |
| `assignee`   | Issue assignee. `claim` assigns the `gh` viewer, then **reads the assignee back**.            |
| `state`      | Projects v2 single-select (`project` / `statusField`). Options must match the names in §4.    |
| `raw`        | GraphQL via `gh api graphql`, or a REST path when the query string starts with `/`.           |

Production talks to GitHub through `gh api` — the same CLI the forge already
requires. No Octokit, no Linear token. `gh auth login` is the quickstart
credential.

---

## 1. Routing — repo → team

The factory does not carry a hardcoded team table. Each entry in
`config/repos.yaml` names the tracker team that owns that repo:

```yaml
repos:
  - name: example
    team: ENG # tracker team key (Linear team key today)
    project: Example app # optional; omit when the team has one project
    control_plane: github # optional; inherits policy.yaml when omitted
```

Resolve the team from the repo you are in: match `path` **or `worktree_root`**
(with `~` expanded) against cwd, or take `--repo` / `$ARGUMENTS` when a command
names one. `worktree_root` matters because every dispatched agent runs from
`<worktree_root>/<TICKET>`, not from `path`. Longest matching prefix wins. Do
not invent a team key, and do not copy another workspace's vocabulary (`WM` /
`OPS` / `CLNT`, or anyone else's) into a repo that does not use it.

### Which control plane a repo uses

`control_plane` on a repo entry selects that repo's tracker: `linear`,
`github`, or `memory`. Resolution is most-specific-first (WM-1007):

1. an explicit `kind` passed to `loadControlPlane()` — tests, and callers that already know
2. `control_plane:` on the `config/repos.yaml` entry
3. `controlPlane.kind` in `config/policy.yaml`
4. `linear`

A repo that omits the key **inherits** the workspace default rather than
defaulting on its own, so adding the key to one repo never changes another.
An unknown repo name throws instead of falling back — a stale name would
otherwise run that repo's tickets against the wrong tracker and report the
result as an empty queue.

This is what lets one factory instance keep its own repo on GitHub Issues
while every other repo it manages stays on Linear.

A workspace may add a repo-local issue-management guide. Follow that guide
inside that repo; do not import another team's labels or projects into it.

## 2. Projects

`project` on a `config/repos.yaml` entry is the tracker project name for
that repo. When the command takes a project as `$ARGUMENTS`, that wins.
When neither is set, file against the team with no project rather than
guessing.

`area:*` labels are per-team. Copy an existing ticket in the same project
rather than inventing an area.

## 3. Labels

These names are part of the protocol, not tracker branding. An adapter binds
them to native labels of the same spelling.

| Label             | Meaning                                                                               |
| :---------------- | :------------------------------------------------------------------------------------ |
| `ai:agent-ready`  | Waiting to be picked up. Dispatchable only in `Todo` with this label and no assignee. |
| `ai:in-progress`  | An agent holds the claim.                                                             |
| `ai:needs-review` | PR is up; merge stage owns it.                                                        |
| `ai:blocked`      | Waiting on a human.                                                                   |
| `ai:escalated`    | Security-relevant (or intent-changing) diff; a human must merge.                      |
| `ai:landing`      | An external lander owns the branch; merge-scan must not rebase it.                    |
| `agent:<harness>` | Which harness holds the claim. CLI `claude` maps to `agent:claude-code`.              |
| `type:*`          | `bug` `feature` `ui-ux` `security` `performance` `maintenance` `docs` `a11y`          |
| `source:*`        | `agent` `human` `sentry` `client-support`                                             |
| `area:*`          | Free-form, workspace-defined.                                                         |

`type:chore` is invalid. Adapters reject it locally rather than as an opaque
API error. Every new issue carries exactly one `source:*`.

**Labels are replaced wholesale, never merged.** Use `--add` / `--remove` on
`factory ticket state` or `factory ticket labels` (or `setLabels` on the
adapter). A mutation that passes only the labels you want added silently drops
every other label on the ticket. `claim` selects the claim labels itself; it
accepts only `--agent` for label-related behavior.

## 4. States

The factory's lifecycle, as names. Adapters map these onto tracker-native
columns / labels / project status.

`Triage` → `Todo` → `In Progress` → `In Review` → `Done`

- **`Triage`** — raw or underspecified. Not a queue to pull implementation
  from. Specify it or hold it; do not start coding.
- **`Todo`** — specified. Dispatchable only with `ai:agent-ready` and no
  assignee.
- **`In Progress`** — an agent holds the claim (`ai:in-progress`).
- **`In Review`** — PR is up (`ai:needs-review`). Merge stage owns it.
- **`Done`** — merged **and** running: base-branch CI green after the merge,
  and the post-deploy smoke check green where the repo has one.
- **`Blocked`** — a question the agent cannot answer (`ai:blocked`). Never
  leave a stalled ticket in `In Progress`.

**Canceled** and **Duplicate** are tracker-native close states. They keep the
ticket recoverable; an actual delete does not. Retire obsolete work with a
comment citing evidence and a state transition — never a delete/archive
mutation. Adapters do not invent Canceled as a factory lifecycle state.

## 5. Ticket template

A ticket is dispatchable only when it carries all five sections:

1. **Problem & Context** — what is wrong or missing, and why it matters.
2. **Acceptance Criteria** — observable, falsifiable checks.
3. **Source File Pointers** — where to start reading. Every path must exist
   on `origin/<base>`.
4. **Owned Paths** — glob set the implementing agent may modify. This is the
   concurrency key: the dispatcher refuses to run two tickets whose sets
   intersect. Tight globs beat convenient ones. Generated outputs must be
   owned with their source (`shared/` implies `dist/**` and `plugins/**` in
   this repo). Write the section as **one path or glob per bullet**
   (`- event-runtime/lib/foo.mjs`) — the planner's parser keeps only bullets
   that look like a path and contain no spaces, so a comma-separated list on
   one bullet is silently dropped and the ticket either fails to dispatch
   (`owned_paths_unknown`) or dispatches with a narrower scope than written.
5. **Verification Command** — a command that actually runs in this repo.
   For non-code work, an evidence line replaces it.

A ticket missing a load-bearing section (`Owned Paths` or `Verification
Command`) is demoted to `Triage`; do not dispatch it. `factory label-guard`
checks those two mechanically.

When a §5 heading is duplicated (the usual cause: a respec appended with
`ticket detail`), every reader **unions** the matching blocks in document
order — dispatch, handoff verification, and the template guard alike, so they
can never disagree about which copy counts. `Owned Paths` becomes the
deduplicated union of all blocks (first occurrence keeps its position), so an
appended respec widens scope to cover the old and the new block and is never
silently narrower than either. `Verification Command` becomes the distinct
commands joined with `&&` — all of them must pass. A first-match win is
deliberately not what happens. `factory ticket detail ISSUE -- "..."` appends
an idempotent detail block; use `factory ticket detail ISSUE --replace -- "..."`
to replace the complete description when re-specifying a ticket, which is the
only way to make a stale block stop counting.

## 6. Bundles

Bundling several tickets into one worktree is the **human's** call, never
an agent's. When the human explicitly asks for a set of tickets to be done
together, they share one worktree, one branch (named after the lead ticket)
and one PR: claim every ticket in the bundle and heartbeat all of them, keep
one commit per ticket, scope the work to the union of their Owned Paths, and
give the PR body a `Fixes <ISSUE-ID>` line per ticket. If one of them turns
out to be bigger than it looked or gets blocked, unassign it back to `Todo`
and ship the rest.

Absent that explicit instruction it is one ticket, one worktree. Noticing
that two tickets are related is a reason to say so, not to merge them.

The dispatched path (`/factory-ticket`, `tick.mjs`) is always exactly one
ticket; bundles never arrive there.

## 7. Execution

**Work comes from the tracker, and only when it's ready.** Dispatchable means
`Todo` + `ai:agent-ready` + unassigned. `Triage` is not a queue to pull from.

**Claim before you code.** Assign yourself, move to `In Progress`, add
`ai:in-progress` + `agent:<harness>`, drop `ai:agent-ready`, then **re-read
the assignee**. If it isn't you, another agent won the race; take the next
ticket. This read-back is advisory: it detects the common case, and every
adapter must still perform and honour it. The authoritative dispatch lock is
the per-repository lock at `~/.factory/locks/<repo>.dispatch.lock`, shared by
the supervisors that serialize the claim window (the mechanism shipped in
#928 for #877).

**One ticket, one worktree.** Never share a checkout between concurrent
tickets. If the repo ships `bin/worktree-up.sh` (or equivalent), it is
mandatory — git isolates branches, not ports or databases.

**Stay inside Owned Paths.** Work discovered outside the set becomes a new
`Triage` issue (§8) — it never expands the current ticket.

**Heartbeat** at each phase change (claimed → implemented → verified → PR
open) and at least every 20 minutes, saying what changed. After 45 minutes
of silence the ticket is reclaimed.

**Verification is a gate.** Run the ticket's exact Verification Command.
For a ticket that changes `event-runtime/web/src/**`, run
`cd event-runtime/web && bun x tsc --noEmit` before the ticket command as
well (the root `bun run check` runs it too, once `event-runtime/web` has had
`bun install`; without that install the web check is skipped). Prefer
`bun x` to `bunx`; the handoff sandbox provides both spellings for existing
ticket commands. Never advance state, open a PR, or report success on
failing output. Never weaken a test to get green.

**Mandatory `## Handoff` comment** before moving to `In Review`:

```
## Handoff
- PR: <url>
- Verification: `<the ticket's exact command>` — pass, <one-line result>
- UX critique: required — SHIP | required — FIX-FIRST resolved in <n> round(s) | skipped — <reason>
- Files: <n> changed, all within Owned Paths
- Risks: <reviewer focus, or "none known">
```

Then `In Review` + `ai:needs-review`, remove `ai:in-progress`. The
implementing agent never merges.

**Never auto-merge** diffs that change auth/authz, payments, secrets,
destructive migrations, production infra, or security behavior. Add
`ai:escalated` and notify (§10, §14). `master`/`main` always goes through a
human.

## 8. Filing bar

File **meaningful, trackable work**: a code/config change, a deployment, a
deliverable, or an investigation with an operational finding. Do not file
an ordinary question, a read-only lookup with no actionable finding, or an
inconsequential edit.

Search for duplicates first (`factory ticket`, or the tracker's search).
Comment on the existing ticket with new evidence rather than filing a
second issue.

Discovered work starts in `Triage` unless it already meets the full §5
template. File follow-ups **before** writing summary or Handoff comments
that name them — the identifier does not exist until the tracker returns it.

## 9. Adapter — ticket shape and verbs

What this section freezes is the vocabulary everything outside
`lib/control-plane/` is allowed to speak.

### Ticket shape

Every verb returns this object (or a list of them). Labels are a flat array
— never a GraphQL `{ nodes }` wrapper.

| Field         | Meaning                                                              |
| :------------ | :------------------------------------------------------------------- |
| `id`          | Opaque tracker id (Linear UUID, GitHub issue node, memory key)       |
| `identifier`  | Human-facing key (`WM-797`, `owner/repo#42`)                         |
| `title`       |                                                                      |
| `description` | Markdown body                                                        |
| `url`         |                                                                      |
| `state`       | `{ id?, name, type? }` — names in §4                                 |
| `assignee`    | `{ id, name? }` or `null`                                            |
| `team`        | `{ key }` (Linear team key; GitHub will bind this to a repo/project) |
| `project`     | `{ name }` or `null`                                                 |
| `labels`      | `[{ id?, name }]`                                                    |

### Verbs

| Verb                                               | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getTicket(id)`                                    | One ticket. Missing → `ControlPlaneError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `listComments(id)`                                 | Comments as `{ id?, body, createdAt?, user }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `listDispatchable({ team, project? })`             | `Todo` + `ai:agent-ready` + unassigned. This **is** the dispatcher's predicate; do not rephrase it at a call site.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `claim(id, { harness? })`                          | Move to `In Progress`, assign the viewer, drop `ai:agent-ready`, add `ai:in-progress` + `agent:<harness>`. Then **read the assignee back**. `{ ok: false }` means another actor won the race — not an exception. Linear has no compare-and-swap; this advisory read-back detects the common case, and every adapter must perform and honour it. The authoritative dispatch lock is the per-repository lock at `~/.factory/locks/<repo>.dispatch.lock`, shared by supervisors to serialize the claim window (the mechanism shipped in #928 for #877). |
| `comment(id, body)`                                | Create a comment. `FACTORY_RUN_ID` is stamped as `run:<id>` when set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `transition(id, state, { add, remove, unassign })` | Move to a named state and/or change labels. Unknown state → error listing the ones that exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `setLabels(id, { add, remove })`                   | Compute the **complete** resulting label set and write that. Passing only the labels you want added is how every other label on the ticket disappears.                                                                                                                                                                                                                                                                                                                                                                                               |
| `file({ team, title, body?, labels?, state? })`    | Create a ticket. Default state `Triage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `appendDetail(id, markdown)`                       | Idempotent description append. `{ appended: false }` if the text is already present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `raw(query, variables?)`                           | Escape hatch. Linear GraphQL; GitHub GraphQL via `gh api graphql` (REST when `query` starts with `/`). Grows only when a call site cannot be expressed with the verbs above.                                                                                                                                                                                                                                                                                                                                                                         |

Every method returns the parsed answer or throws `ControlPlaneError`.
`claim` returning `{ ok: false }` is the one protocol outcome that is not
an error.

## 10. Notify

"Notify" means the configured interrupt channel. A tracker comment, a
`Blocked` state change, or a line in a run report does not reach the human
in real time.

```bash
factory notify "<EVENT> <TICKET/PR>: <one answerable sentence>"
```

The transport is **not** a hardcoded private script. `lib/notify.mjs`
resolves it from, in order:

1. `FACTORY_NOTIFY_CMD` (or `FACTORY_NOTIFY_SCRIPT` / `FACTORY_EVENT_NOTIFY_CMD`)
2. `config/policy.yaml` `notify.command`

There is no in-tree default. A clone that has not set a command is silent
on this channel until the operator configures one. `~` in the policy value
expands to `$HOME`.

Event prefix is one of `BLOCKED`, `ESCALATED`, `CI RED`, `SMOKE RED`,
`CIRCUIT BREAKER`, `RC READY`. Notify only for those six; routine progress
(claims, PRs opened, clean merges) goes to the tracker and the run report.

If `factory notify` exits non-zero, post the same text as a tracker comment
and flag the failed push in the report.

## 11. Checkout freshness

Code evidence cites a ref, not a path. Compare against `origin/<base>` by
name — never `@{upstream}`. The tree is trustworthy only when it is not
behind, not ahead, and not dirty. On failure, freshness is **unknown**;
read `origin/<base>` rather than trusting the working copy. Dispatch is
exempt: `worktree-up.sh` branches from `origin/<base>`.

## 12. Handoff and UX critique

The Handoff comment in §7 is mandatory before `In Review`. A user-facing
change that introduces or materially changes a completable flow runs a UX
critique (`factory-ux-critic`) after verification and before the PR; skip
it for isolated styling, copy-only edits, static content, icons/assets, and
internal/admin-only surfaces unless the ticket identifies UX risk. `SHIP`
and `FIX-FIRST` require an exercised journey plus at least one observed
page URL or screenshot path.

## 13. Tracker access

**Use `factory ticket` — not a tracker MCP, and not a standalone tracker
CLI.** The `linear` command is a deprecated alias. The factory tool is in git, has this protocol's guardrails built in,
and its `claim` verb performs the advisory read-back. The authoritative
concurrency control is the per-repository dispatch lock described in §7.

```bash
# Read a ticket. GitHub Issues accept either the full slug or the configured
# repository name; both spellings resolve to the full `owner/repo#N` form.
factory ticket get CLNT-616
factory ticket get watt-mind/factory#123
factory ticket get factory#123
# List its comments.
factory ticket comments CLNT-616
# Atomically claim a dispatchable ticket (`--agent` selects the harness).
factory ticket claim CLNT-616 --agent claude
# Return a claim to Todo and unassign it.
factory ticket unclaim CLNT-616
# Add a comment.
factory ticket comment CLNT-616 "..."
# Demote an underspecified ticket to Triage with an explanation.
factory ticket triage CLNT-616 --comment "..."
# Record an answer and return a blocked ticket to Todo when applicable.
factory ticket answer CLNT-616 "..."
# Append idempotent Markdown detail to a ticket (the default never replaces).
factory ticket detail CLNT-616 -- "..."
# Replace the complete description when re-specifying a ticket.
factory ticket detail CLNT-616 --replace -- "..."
# Read or mutate labels (`label` is an alias for `labels`).
factory ticket labels CLNT-616 --add ai:needs-review --remove ai:in-progress
factory ticket label CLNT-616
# Change state and/or labels, optionally with a comment.
factory ticket state CLNT-616 "In Review" --add ai:needs-review
# File a new Triage or Todo ticket. `--from owner/repo#N` routes a dispatched
# workspace to that repository's control plane (no `--team` needed on GitHub);
# a Linear id such as `--from CLNT-616` names no repository, so it falls
# through to cwd and then to the default plane, where `--team` is required.
# With neither flag nor a resolvable cwd, `file` refuses instead of guessing.
factory ticket file --team CLNT --title "..." --body "..." --type bug
factory ticket file --from owner/repo#123 --title "..." --body "..." --type bug
# List In Progress tickets for Owned Paths collision checks.
factory ticket inflight --team CLNT --project "BJ29 Coaching"
# List dispatchable tickets for a team or configured repo.
factory ticket queue --repo bj29
# Show the tracker request budget captured by the adapter.
factory ticket budget
# Run an explicit adapter query with variables for an unsupported operation.
factory ticket raw '<query>' --var key=value
```

`claim` exits non-zero when another agent won the race — that is not a
retry. For anything the verbs do not cover, `raw '<query>' --var k=v`
beats inventing a new flag. Fallback when the CLI is missing:
`bun "$FACTORY_ROOT/tools/linear.mjs"`.

### GitHub CLI timeout

The GitHub forge bounds every synchronous `gh` invocation with
`FACTORY_GH_TIMEOUT_MS`, in milliseconds. It defaults to `30000`; set it to a
positive integer to override that default. Invalid values emit a warning and
use `30000` so a malformed environment never leaves a forge caller blocked
indefinitely. Individual forge calls may still supply their own `timeout`.

## 14. Loops

The factory commands (`/factory-work`, `/factory-merge`, `/factory-ship`,
and the rest under `shared/commands/`) are the loops. Notify during a run
only for the six events in §10. A ticket blocked, a PR escalated, base CI
or smoke red, or the circuit breaker tripping is an interrupt; a clean
claim, PR, or merge is not.

`Done` is merged and running, not "PR opened". The implementing agent
stops at `In Review`; the merge stage lands the PR.

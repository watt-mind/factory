# Connect a repository to factory

You are being asked to connect **factory** — a runtime for self-improving agentic
loops — to a repository, and to prove the connection by getting one real ticket
dispatched from it.

Work through the steps in order. Several of them ask you to look at the target
repository and decide something; those decisions are the reason a human is
handing this to you instead of running an install script. Where a step says
**report and stop**, do exactly that — a half-configured control plane that
looks configured is worse than one that visibly failed.

- Target repository: `<TARGET_REPO_PATH>`
- factory checkout: `<FACTORY_ROOT>`

## Ground rules

- **Never invent configuration keys.** `config/repos.yaml` is parsed by
  `event-runtime/lib/repos.mjs`; a key it does not read is silently ignored and
  you will have configured nothing. If you need a behaviour and cannot find the
  key that provides it, say so rather than guessing a name.
- **Never write a token into factory's configuration.** GitHub access comes from
  `gh auth login` and its own credential store. Linear access comes from
  `LINEAR_API_KEY` in the environment.
- **`config/repos.yaml`, `config/policy.yaml` and `config/schedule.yaml` are
  gitignored and machine-local.** Do not commit them and do not move their
  contents into a tracked file.
- **Do not report a step green that you did not observe green.** Paste the
  command output. The exit gate in step 9 is the only definition of done.

## 1. Preflight

```bash
bun --version    # >= 1.3
git --version    # >= 2.40
gh --version     # current stable
gh auth status
```

If `gh` is not authenticated, run `gh auth login -h github.com` — or, if that
needs a browser you do not have, report and stop with the exact command the
human should run.

Confirm the human has at least one coding-agent harness installed and logged in
(Claude Code, Codex, Gemini, Cursor, Pi, or Agy). Whichever one is running you
is a fine answer, as long as it is also usable headlessly.

## 2. Get a factory checkout

If `<FACTORY_ROOT>` already exists and is a git checkout of
`watt-mind/factory`, use it. Otherwise:

```bash
git clone https://github.com/watt-mind/factory.git <FACTORY_ROOT>
```

Then, from `<FACTORY_ROOT>`:

```bash
bun install --frozen-lockfile
bun build/emit.mjs --link-bin      # symlinks ~/.local/bin/factory
export PATH="$HOME/.local/bin:$PATH"
factory --help
```

If `~/.local/bin` is not on the human's `PATH` permanently, tell them the line
to add to their shell profile. Do not edit their shell profile yourself.

## 3. Survey the target repository — then report before writing anything

Read `<TARGET_REPO_PATH>` and answer these. Do not guess any of them from the
repository's name or language alone; look.

| Question                                                       | Where to look                                                                                                                                                                |
| :------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is the integration branch?                                | `git symbolic-ref refs/remotes/origin/HEAD`, plus what open PRs target. `develop` and `main` are both common; picking the wrong one sends every agent PR to the wrong place. |
| What is the deploy branch, if it differs?                      | Release workflow triggers in `.github/workflows/`.                                                                                                                           |
| How are tests run?                                             | `package.json` scripts, `Makefile`, `justfile`, CI workflow steps.                                                                                                           |
| How is lint run?                                               | Same places.                                                                                                                                                                 |
| Does CI exist, and what are the required check names?          | `.github/workflows/*`, and `gh pr checks` on a recent PR.                                                                                                                    |
| Does the repo already have `bin/worktree-up.sh` or equivalent? | `bin/`, `scripts/`.                                                                                                                                                          |
| Does it have an `AGENTS.md`?                                   | Repo root.                                                                                                                                                                   |
| Which tracker holds its work?                                  | Ask the human if it is not obvious. GitHub Issues is the default and needs no extra account.                                                                                 |

**Run the test and lint commands you found, on the current tree, before going
further.** You need to know whether they pass today. If they are red before
factory touches anything, report that and stop — the first dispatched ticket
would fail verification for reasons that have nothing to do with the agent, and
the human will read that as factory being broken.

Report the table back with your answers filled in, and say which base branch you
intend to configure. Then continue.

## 4. Choose and initialise the control plane

The tracker is factory's control plane: it decides what is ready, holds the
claim that keeps two agents off the same work, and records state. Pick one.

<!-- factory:onboard:github -->

### GitHub Issues (default — no extra account)

From `<FACTORY_ROOT>`:

```bash
factory init --root "$PWD"
factory init --control-plane github --root "$PWD" --repo <OWNER/REPO> --team <TEAM>
```

The first command copies `config/*.example.yaml` to their local, gitignored
`config/*.yaml` counterparts without overwriting anything that already exists.
The second writes the GitHub control-plane stanza into `config/policy.yaml` and
creates the protocol labels (`ai:agent-ready`, `ai:in-progress`,
`ai:needs-review`, `ai:blocked`, `ai:escalated`, `type:*`, `priority:*`,
`source:*`, `agent:*`). Existing labels are left alone.

`<TEAM>` is the issue-id prefix used in commit messages and branch names. If the
repo already has a convention, use it; otherwise a short uppercase abbreviation
of the repo name is fine.

Note that the second command **exits 0 even when provisioning fails** — it
reports `Labels/board: not provisioned — …` and keeps the policy it wrote. Read
its output; do not assume success from the exit code.

<!-- /factory:onboard -->
<!-- factory:onboard:linear -->

### Linear

From `<FACTORY_ROOT>`:

```bash
factory init --root "$PWD"
```

That copies `config/*.example.yaml` to their local, gitignored `config/*.yaml`
counterparts without overwriting anything that already exists. Linear is the
default control plane in `config/policy.yaml`, so leave `control_plane` off the
repo stanza in step 6.

Set `LINEAR_API_KEY` in the environment — not in a factory config file. Confirm
with the human which Linear team and project this repository's work belongs to
before you configure anything, and mirror the label taxonomy above
(`ai:agent-ready`, `ai:in-progress`, `ai:needs-review`, `ai:blocked`,
`ai:escalated`, `type:*`, `priority:*`, `source:*`, `agent:*`) onto that team.

`<TEAM>` is the Linear team key — the issue-id prefix used in commit messages
and branch names.

<!-- /factory:onboard -->

## 5. Ticket states

<!-- factory:onboard:github -->

factory reads and writes ticket state through a Projects v2 single-select field,
not through issue open/closed. `factory init` checks for the board but
deliberately does not create it — it cannot know which owner it should live
under, and creating one under the wrong owner is tedious to undo.

Create a Projects v2 board named **Factory**, linked to the repository, with a
single-select field named **Status** whose options are exactly:

```text
Triage, Todo, In Progress, In Review, Done, Blocked
```

Spelling and case must match — they are compared literally. If you can create
the board with `gh project create` under the correct owner, do it and link the
repository. If ownership is ambiguous, report and stop with the exact steps.

<!-- /factory:onboard -->
<!-- factory:onboard:linear -->

factory drives Linear's own workflow states, so there is nothing to create — but
the team's states must be spelled the way the protocol expects:

```text
Triage, Todo, In Progress, In Review, Done, Blocked
```

Check the team's workflow in Linear. If a state is missing or spelled
differently (`Backlog` instead of `Triage`, `QA` instead of `In Review`), report
which ones and stop — renaming states affects everyone else using that team, so
it is the human's call, not yours.

<!-- /factory:onboard -->

## 6. Register the repository

Add a stanza to `<FACTORY_ROOT>/config/repos.yaml` under `repos:`. Fill in what
you learned in step 3; leave out any key you do not have a real answer for.

```yaml
repos:
  - name: <short-name> # what you pass to --repo; not the OWNER/REPO slug
    path: <TARGET_REPO_PATH>
    github: <OWNER/REPO>
    team: <TEAM>
    project: Factory # GitHub Projects v2 board title
    control_plane: github # omit this line to inherit Linear from policy.yaml
    base: <integration-branch>
    deploy_branch: <deploy-branch> # omit if the repo has only one long-lived branch
    max_in_flight: 1 # raise once concurrent dispatch has been watched working
    verify: <the test and lint command from step 3>
    report_only: true # SAFETY: see below
```

Keep `report_only: true` for now. It makes factory observe and plan for this
repo without acting on it, which is what you want until the first ticket has
been read back and looks right.

If the repo has merge-blocking CI you want factory to wait for, add:

```yaml
merge_ci:
  workflow: <workflow name from .github/workflows>
  required_checks:
    - <exact check name as it appears in `gh pr checks`>
```

Verify the file parses before moving on:

```bash
factory queue --repo <short-name>
```

## 7. Give the repository the agent operating floor

Every agent factory dispatches reads the target repo's `AGENTS.md`. It travels
with the checkout, so it is the one layer that reaches every harness — including
a cloud sandbox with no access to factory itself.

From `<FACTORY_ROOT>`:

```bash
bun build/emit.mjs --sync-floor   # splices the floor block into each configured repo's AGENTS.md
bun run link-repos                # symlinks the /factory-* commands into each repo
```

`--sync-floor` splices between `<!-- FACTORY:FLOOR:BEGIN -->` and
`<!-- FACTORY:FLOOR:END -->` markers and appends if the repo has no `AGENTS.md`
yet — the repo's own hard-won rules above and below the markers are preserved.
Read the diff and commit the `AGENTS.md` (and the `.gitignore` block emit adds)
in the target repository.

## 8. File the first agent-ready ticket

This is where most connections quietly fail, so do it carefully. A ticket is
dispatchable only when it is **`Todo` + `ai:agent-ready` + unassigned**.

Pick something genuinely small and genuinely real — a missing test, a
one-function fix, a lint rule the repo already violates. Not a hello-world; the
point is to see the loop work on this repository's actual toolchain.

```markdown
### Problem & Context

<why this matters, in two or three sentences>

### Acceptance Criteria

- [ ] <observable, checkable outcome>
- [ ] <a regression test covers it>

### Source File Pointers

- <path a file that exists>

### Owned Paths

- <path/that/exists.ts>
- <path/to/its.test.ts>

### Verification Command

\`\`\`bash
<the exact command, scoped to this ticket>
\`\`\`
```

Three things decide whether this works:

- **`Owned Paths` is one path or glob per bullet, no spaces.** The parser
  (`orchestrator/owned-paths.mjs`) keeps only bullets that look like a path, so
  a comma-separated list on one bullet is silently dropped and the ticket either
  refuses to dispatch (`owned_paths_unknown`) or dispatches with a narrower
  scope than you wrote. This glob set is also what lets two agents run at once —
  the planner refuses to dispatch two tickets whose sets intersect.
- **The paths must exist**, and must be everything the change needs to touch.
- **You must have run the verification command yourself** and seen it pass on
  the current tree. It is re-run independently after the agent finishes, and the
  agent's own report is not evidence — the exit code is.

Create the issue, apply `ai:agent-ready`, set its Status to `Todo`, and leave it
unassigned.

## 9. Exit gate — the connection is not done until these are green

Flip `report_only` off in the repo's stanza, then, from `<FACTORY_ROOT>`:

```bash
factory doctor                              # environment, auth, harnesses
factory queue --repo <short-name>           # must list the new ticket as ready
factory next --repo <short-name>            # read-only: what would it do?
```

`factory doctor` must be clean, and `factory queue` must show the ticket as
dispatchable. If `factory next` refuses, its refusal reason names the gate that
failed — fix that gate rather than working around it. Two you are likely to see:

- `no_worktree_scripts` — the repo declares no `worktree_up` / `worktree_down` /
  `worktree_root`. Event-runtime dispatch requires them; the `factory next`
  path below does not. See step 10.
- `owned_paths_unknown` — the ticket's `Owned Paths` section did not parse. Read
  the bullet rule in step 8 again.

Then dispatch for real:

```bash
factory next --repo <short-name> --apply --harness <claude|codex|gemini|cursor|pi|agy>
```

Watch it claim the ticket, provision a worktree, run the harness inside the
declared `Owned Paths`, re-run the verification command independently, and open
a PR against the configured base. **Read the opened PR's base branch back** and
confirm it matches what you configured in step 6.

Report to the human: the PR URL, the verification output, and anything you had
to decide on their behalf.

## 10. Optional — isolated worktree lifecycle

`git worktree add` isolates branches. It does not isolate ports, databases, or
`.env` state, so two agents running a dev server or a migration at once will
still collide. Repos with either need a worktree lifecycle script pair, and
event-runtime dispatch requires one before it will plan any ticket at all.

The contract, from `event-runtime/lib/workspace.mjs`:

- factory runs `bash <worktree_up> <TICKET>` with the working directory set to
  the repo, and `bash <worktree_down> <TICKET>` to tear it down.
- `worktree_up` must create the worktree at
  `<worktree_root>/<slug>`, where the slug is the ticket id itself for
  `ABC-123` / `gh-123` forms and `gh-<number>` otherwise. This must match
  `ticket_slug()` in factory's `bin/worktree-common.sh` — a mismatch reads as
  "worktree_up succeeded but produced nothing".
- It must branch from `origin/<base>`, be idempotent on re-run, and exit
  non-zero on failure.

Anything else the repo needs per-worktree — a free port, a scratch database, a
copied `.env`, installed dependencies — belongs in that script. factory's own
`bin/worktree-up.sh` is a worked example, but it is specific to this repository;
read it for the shape, not to copy it.

Then add to the repo's stanza:

```yaml
worktree_up: bin/worktree-up.sh
worktree_down: bin/worktree-down.sh
worktree_root: ~/Develop/.worktrees/<short-name>
```

## When you are done

Summarise for the human, in this order: what you configured, what you decided on
their behalf and why, the PR the first ticket produced, and anything still
manual (board creation, a `PATH` line, a worktree script they should review). If
you stopped early, say exactly which step and what you need from them.

# Quickstart

Connect factory to a repository you already have, and get one independently
verified PR out of it. The offline demo below is an install check, not the
starting point — it proves a fresh clone runs, not that factory helps with
your code.

## Connect a repository

Connecting needs answers only your repo has: which branch is the integration
branch, what the verification command really is, whether concurrent agents need
more isolation than `git worktree` gives, which files an honest first
`Owned Paths` should list. An installer can only ask you or guess, so the fast
path is a prompt handed to the coding agent you already run.

```bash
factory onboard --repo ~/Develop/yourapp | pbcopy
factory onboard --repo ~/Develop/yourapp --control-plane linear
```

`docs/onboarding/connect-repo.md` is that prompt, and the only copy of it —
`factory onboard` prints it with your repo substituted, and the documentation
site renders the same file. Without a checkout yet, copy it from the
[Connect Your Repo](https://watt-mind.github.io/factory/getting-started/quickstart/)
page; its first steps clone factory for you.

It is a runbook, not an incantation. Every step is a command you can run
yourself, so following it by hand is a supported path — the agent is just
faster at the survey and more patient with the ticket template.

The prompt ends at a gate it cannot talk its way past:

```bash
factory doctor                    # environment, auth, harnesses
factory queue --repo <name>       # the new ticket must show as dispatchable
factory next  --repo <name>       # read-only: what would it do?
```

Then dispatch for real:

```bash
factory next --repo <name> --apply --harness claude
```

A successful run claims the issue, provisions the repository's worktree, asks
the selected harness to implement it inside the declared `Owned Paths`, re-runs
the verification command independently, and opens a PR against the configured
base branch. The PR is still subject to CI and review; factory does not merge it
merely because the agent finished.

## Notes on `factory init --control-plane github`

The prompt runs this for you; these are the behaviours worth knowing when it
does something you did not expect.

It **creates the protocol labels** (WM-1009). Run it after `gh auth login` —
with a real `--repo`, it writes the policy file and then creates every `ai:*`,
`type:*`, `source:*`, `agent:*` and `priority:*` label the protocol names,
roughly twenty-five of them. Labels that already exist are left untouched,
including their colour and description, so re-running is safe and reports what
it created versus what was already there. Add `--dry-run` to see the plan
without writing anything.

Provisioning is **not fatal**: if `gh` is unauthenticated or offline, the policy
file is still written, the command still exits 0, and it prints the exact
command to re-run once you have credentials. Scaffolding config before
authenticating is a normal order to work in — which also means the exit code is
not evidence that provisioning happened. Read the output.

The **Projects v2 board** is still manual. `factory init` checks for a board
named `Factory` with a `Status` single-select and reports precisely what to
create; it does not create the board itself, because doing that blind against
the wrong owner (user vs. organisation) produces a board in the wrong place that
then has to be found and deleted. If the board exists but its `Status` options
do not exactly match `Triage, Todo, In Progress, In Review, Done, Blocked`, init
fails and names the missing ones — a half-configured board would otherwise
surface much later as a transition error inside an unattended loop, reading as a
tracker outage rather than a setup mistake.

## Verifying a fresh clone offline

`factory demo` answers a narrower question: does this checkout work at all, on a
machine with no accounts, no API keys, and no network?

- Prerequisites: [Bun](https://bun.sh) >= 1.3 and Git >= 2.40. Nothing else.

From a clone of this repository:

```bash
bun install
bin/factory demo --dry    # validate the fixture and print the plan
bin/factory demo          # claim → implement → verify → PR → merge
```

`--dry` is what CI runs. It must stay green without network.

`--dry` prints the starter ticket, its Owned Paths, the verification command,
and the seven-step plan, then `dry-run ok`. The full run copies `demo/repo/`
into a temp git checkout, calls that repo's own `bin/worktree-up.sh`, applies
the patch, runs `bun test src/greet.test.mjs`, opens PR #1 on the memory forge,
merges it, and marks `DEMO-1` Done. Nothing in the factory checkout is modified.

The harness is `fake`: a deterministic patch implementing the bundled starter
ticket (`DEMO-1`, add `greet(name)`). `--harness claude` (or `codex`, `pi`,
`gemini`, `cursor`, `agy`) only records a different adapter on the ticket — no
model is invoked either way, so it cannot fail closed on missing credentials.

```bash
bin/factory demo --help
```

A recorded walkthrough of `--dry` plus the end-to-end run lives at
[`docs/media/quickstart.gif`](media/quickstart.gif).

The isolated event-runtime fixture (`bin/worktree-up.sh --here`, also
`factory demo --here`) is a different thing again: it seeds the control API with
fake-adapter runs. Use that when working on the web UI.

## Where to go next

factory supports macOS 13+ (Apple Silicon or Intel) and Linux on x64 or arm64.
See [SETUP.md](../SETUP.md) for the complete clean-room operator install,
including `gh auth login` and the harness login, and
[architecture.md](architecture.md) for dispatch, Owned Paths, and CI as the
reward signal.

To adopt factory for an organization instead of cloning the kernel, pin the
published `@watt-mind/factory` npm package from a `templates/starter/`-based
instance repository — see [docs/instances.md](instances.md) for the
kernel/instance split and the upgrade contract.

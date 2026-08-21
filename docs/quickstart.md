# Quickstart

Start with the offline demo to prove a fresh clone works, then use the
GitHub-backed path to send the first real PR from an external repository.
The demo needs no account; the real path needs GitHub CLI authentication but
does not need a Linear token.

## Offline demo prerequisites

- [Bun](https://bun.sh) >= 1.3
- Git >= 2.40

No Linear token, no GitHub token, no model API key.

## Run it

From a clone of this repository:

```bash
bun install
bin/factory demo --dry    # validate the fixture and print the plan
bin/factory demo          # claim → implement → verify → PR → merge
```

`--dry` is what CI runs. It must stay green without network.

The default harness is `fake`: a deterministic patch that implements the
bundled starter ticket (`DEMO-1`, add `greet(name)`). Pass `--harness claude`
(or `codex`, `pi`, `gemini`, `cursor`, `agy`) to record a different adapter
on the ticket; the 15-minute path still applies the bundled patch so it
cannot fail closed on missing credentials.

```bash
bin/factory demo --help
```

A recorded walkthrough of `--dry` plus the end-to-end run lives at
[`docs/media/quickstart.gif`](media/quickstart.gif).

## What you should see

`--dry` prints the starter ticket, its Owned Paths, the verification
command, and the seven-step plan, then `dry-run ok`.

The full run copies `demo/repo/` into a temp git checkout, calls that
repo's own `bin/worktree-up.sh`, applies the patch, runs
`bun test src/greet.test.mjs`, opens PR #1 on the memory forge, merges it,
and marks `DEMO-1` Done. Nothing in the factory checkout is modified.

## First real PR with GitHub Issues

Factory supports macOS 13+ (Apple Silicon or Intel) and Linux on x64 or arm64.
For the GitHub path, install Bun >= 1.3, Git >= 2.40, the current GitHub CLI,
and one coding-agent harness. Follow [SETUP.md](../SETUP.md) for the complete
clean-room install, including `gh auth login` and the harness login.

From the Factory clone, scaffold only local configuration and bind the
GitHub control plane to the external sample repository you want to automate:

```bash
bun install --frozen-lockfile
bun build/emit.mjs --link-bin
export PATH="$HOME/.local/bin:$PATH"
factory init --root "$PWD"
factory init --control-plane github --root "$PWD" --repo OWNER/SAMPLE --team SAMPLE
factory doctor
```

Create a GitHub Project named `Factory` in `OWNER/SAMPLE` with the statuses
printed by `factory init`, then create the protocol labels it prints. Add the
external sample repository to the local `config/repos.yaml` with its explicit
base branch, verification command, and its own `worktree_up`/`worktree_down`
scripts. That isolation is what lets a claimed ticket receive a verified PR
without sharing ports or a database with another run.

Create one GitHub Issue in the `Todo` project state with `ai:agent-ready`, an
unassigned owner, a verification command, and a narrow `Owned Paths` section.
Run the configured dispatch flow for that repository. A successful run claims
the issue, creates the repository's worktree, asks the selected harness to
implement it, re-runs the verification command, and opens a PR against the
configured base branch. The PR remains subject to CI and review; Factory does
not merge it merely because the agent completed.

If `factory doctor` reports a missing GitHub CLI or authentication, install
`gh` or run `gh auth login -h github.com` before dispatching. Its remediation
is intentional: an empty environment should fail with a setup action, never a
private local path or an unhandled stack trace.

See [SETUP.md](../SETUP.md) for operator installation and
[architecture.md](architecture.md) for dispatch, Owned Paths, and CI as the
reward signal.

The isolated event-runtime fixture (`bin/worktree-up.sh --here`, also
`factory demo --here`) is a different demo: it seeds the control API with
fake-adapter runs. Use that when you are working on the web UI, not when
you are evaluating the factory as an adopter.

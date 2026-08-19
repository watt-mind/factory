# Quickstart

Fifteen minutes, one command, no third-party accounts. This is the path that
proves the factory loop — claim a ticket, implement it, verify, open a PR,
merge — against a bundled repo and an in-memory control plane.

GitHub Issues as a tracker is the later zero-account production adapter
([WM-798](https://linear.app/watt-mind/issue/WM-798)); until then the
quickstart uses the memory plane so a clone works on a fresh machine.

## Prerequisites

- [bun](https://bun.sh) 1.3+
- `git`

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

## After the demo

To run the factory against a real repo you will still need a tracker
(Linear today) and a code host (GitHub). See [SETUP.md](../SETUP.md) for
operator install, and [architecture.md](architecture.md) for how dispatch,
Owned Paths, and CI-as-reward-signal fit together.

The isolated event-runtime fixture (`bin/worktree-up.sh --here`, also
`factory demo --here`) is a different demo: it seeds the control API with
fake-adapter runs. Use that when you are working on the web UI, not when
you are evaluating the factory as an adopter.

# Launch post (draft)

**DRAFT — a human posts this. Agents do not publish.**

Numbers below were generated on 2026-08-20 by:

```bash
bun tools/launch-numbers.mjs --since 2026-08-03
```

Re-run that command before publishing. Do not hand-edit the figures; if they
look wrong, fix the script. Token totals are empty until the command is run
on the dispatch host that writes `~/.factory/logs/*.jsonl`.

---

# The factory that builds software — and itself

Seventeen days. No one driving the sessions.

Since 3 August 2026 the factory has been dispatching coding agents against
real tickets in real repos — its own, and client work. A specified,
disjoint, agent-ready ticket becomes a pull request without a human at the
keyboard. The PR merges because tests passed and a reviewer approved, not
because an agent said it was done.

That is the whole pitch. The rest of this post is the evidence, and the
parts that broke.

## The numbers (3–20 August 2026)

|                                                 |                           |
| ----------------------------------------------- | ------------------------: |
| Unattended window                               | **17 days** (2 weeks + 3) |
| Tickets dispatched                              |                 **1,825** |
| Tickets merged                                  |                 **1,620** |
| Escalated to a human (`ai:escalated`)           |                    **88** |
| Merged without a Blocked detour or escalation   |           **1,409 (87%)** |
| Median ticket → merge (createdAt → completedAt) |             **5.1 hours** |
| Median claim → merge (startedAt → completedAt)  |            **38 minutes** |

By team:

| Team                    | Dispatched | Merged | Escalated |
| ----------------------- | ---------: | -----: | --------: |
| CLNT (client products)  |        631 |    557 |        31 |
| WM (the factory itself) |        602 |    529 |        25 |
| OPS                     |        299 |    283 |         5 |
| CW                      |        153 |    122 |         7 |
| LAB                     |        140 |    105 |        20 |

"Without human touch" is a tracker fact, not a vibe. The ticket reached
Done after an agent claim, never visited Blocked, and never carried
`ai:escalated`. Humans still wrote the specs. CI still gated the merge.
The 13% that needed a person needed a decision, a credential, or a
security-relevant diff — and the protocol is built to stop for those.

Tokens-by-harness live in the same command. This draft was generated on a
host without JSONL transcripts; paste the `tokens by harness` block from a
dispatch-host run into the table below before this goes public.

| Harness                                                        | Runs | Input | Output | Cache-read | Fresh tokens |
| -------------------------------------------------------------- | ---: | ----: | -----: | ---------: | -----------: |
| _(re-run `bun tools/launch-numbers.mjs` on the dispatch host)_ |      |       |        |            |              |

## What it is

The factory orchestrates coding agents (Claude Code, Codex, Gemini CLI,
Cursor, Pi). It does not compete with them. The tracker is the control
plane, GitHub is the source of truth, and CI is the reward signal.

A ticket that is specified, disjoint, and labelled `ai:agent-ready` is
claimed into an isolated worktree (own branch, ports, database). One
bounded agent implements exactly that ticket, inside its Owned Paths. A
worker re-runs the ticket's Verification Command; the agent's report is
commentary, the exit code is the evidence. Then a PR. Then CI. Merge and
ship are later loops on the same event runtime.

We do not lead with a general agent platform that happens to also write
code. We lead with shipping software, unattended, and let generality show
up as a consequence of the same primitives. Infra-ops and editorial loops
already run on this runtime. Software is first because the verification
story is strongest there.

The public repo is Apache-2.0. There is no telemetry. The factory
maintains itself in public: a harness defect becomes a ticket, a ticket
becomes a PR, a merge changes the next run.

## What measuring taught us

`docs/friction-log.md` is not a retrospective slide. An entry is an open
defect in the harness, or a record of one that was fixed so nobody
re-proposes it.

A few shapes from the first weeks:

- Agents `sleep 180` to wait for CI. A fixed sleep is a guess. The floor
  now requires `gh pr checks --watch --fail-fast`; the harness blocks
  `sleep`. (F-8)
- The same guess against a booting dev server. Documented; a
  `bin/wait-for-dev.sh` default would beat a rule. (F-9, still open)
- Killed runs leave Chrome holding a profile lock, so the next twenty
  sessions fail `list_pages`. `chrome-sweep` now runs before each dispatch
  pass. (F-11)
- Agents reach for a third-party `linear` CLI and a bundled MCP, both of
  which fail in ways that look like "Linear is down." One in-repo client
  (`tools/ticket.mjs`) is the road. (F-12)
- A correct Owned Paths list inside a fenced code block parsed as empty,
  so a well-specified ticket was undispatchable. The parser was the bug.
  (F-7)

Friction that repeats becomes a ticket. The factory is the first customer
of that loop. That is what "dogfooded in public" means — not a badge on a
README that never changes.

```markdown
[![Dogfooded in public](https://img.shields.io/badge/dogfooded-17_days_unattended-0f766e)](docs/oss/launch-post.md)
```

## Try it

Fifteen minutes, no third-party accounts:

```bash
bun install
bin/factory demo --dry    # CI runs this
bin/factory demo          # claim → implement → verify → PR → merge
```

The default harness is `fake`: a deterministic patch against a bundled
ticket. Pass `--harness claude` (or `codex`, `pi`, `gemini`, `cursor`,
`agy`) to record a different adapter; the 15-minute path still applies the
bundled patch so missing credentials cannot fail the demo closed.

Read [docs/thesis.md](../thesis.md) for why it is shaped this way,
[docs/quickstart.md](../quickstart.md) for the walkthrough, and
[ROADMAP.md](../../ROADMAP.md) for what is next (GitHub Issues as a
control plane, pack authoring, the `ee/` seam left empty at launch).

## What we are not claiming

- That 87% means no human ever opened the PR. Review and CI still happen.
  The number is "the agent was not stuck waiting on an operator."
- That every harness is equally measured. Token totals come from
  `orchestrator/economics.mjs` reading real transcripts. A host without
  those logs reports empty, it does not invent a spend figure.
- That the runtime rewrites its own kernel unattended. Packs extend it;
  proposals remain admission; CI remains the merge gate.

Real numbers beat feature lists. These are the numbers from the first
seventeen days. Re-run the command on day thirty-four.

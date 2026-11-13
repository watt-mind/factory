# factory-retro

> Find what is repeatedly wasting the factory's time and fix the harness, not the symptom

Turn measured friction into harness changes.

Agents don't reliably remember what slowed them down, and asking them to write it up produces either nothing or noise. Three sources carry the evidence instead:

```bash
factory friction $ARGUMENTS
factory economics $ARGUMENTS
factory ci $ARGUMENTS
```

Friction is what wasted the agents' _time_ inside a session; economics is what consumed _context and the usage window_ (context burn, cache thrash, zero-result runs); CI is the clock agents wait on _outside_ the session — workflow-scoped REST run watches in factory-merge/factory-ship sitting idle for however long GitHub Actions takes, per repo per workflow, with repeat-failure and slowdown-trend flags already computed. A repeat in any of the three is actionable — a tool that fails three runs running, a tool whose payloads dominate context burn, and an e2e job that's crept 40% slower over two weeks are all harness defects.

**friction.mjs and economics.mjs need `~/.factory/logs/` transcripts, which only exist for runs the orchestrator itself dispatched.** Invoked directly from the harness — you running `/factory-retro` in a repo without going through orchestrator dispatch — there may be no matching transcripts; `friction.mjs` exits with "no transcripts" in that case, which is expected, not a failure, so don't chase it as one. `ci.mjs` has no such dependency: it reads GitHub's own run history, so it carries the CI-reflection half of retro on its own even when the other two have nothing. Run all three regardless; treat an empty friction/economics result as "no session data this time," not as a broken retro.

**Interactive sessions without transcripts** file friction via `/factory-friction` at the end of `/factory-work`, `/factory-merge`, `/factory-ticket`, and `/factory-ship` (skipped when `FACTORY_RUN_ID` is set). Search Linear for `FIP:` issues and bodies containing `## Session friction` — merge that evidence with the mechanical transcript analysis below before deciding what to fix.

Then read `docs/friction-log.md` for what is already known and what was already decided against — the point is a shrinking list, not an accumulating one.

## What counts

Only two things are worth acting on:

**Repeats across runs.** A failure in one run is that ticket's problem. The same failure shape in three runs is the harness's problem, and fixing it pays every future run. The analyzer already groups by failure shape with paths and ids normalised, so the count is meaningful.

**Time sinks that shouldn't be paid per ticket.** A three-minute compile every ticket is nine minutes across three tickets; if one warm-up makes it seconds, that is the fix. Look for the same expensive command in every transcript.

Ignore one-offs, however annoying. A single flaky network call is not a harness defect, and chasing it adds a rule everyone must read forever.

## Fix the cause, at the right layer

Ask what would have made the friction impossible, then put the fix where it belongs:

| Friction                                            | Wrong fix                 | Right layer                                                                                               |
| :-------------------------------------------------- | :------------------------ | :-------------------------------------------------------------------------------------------------------- |
| Shell glob bites every agent                        | tell agents to be careful | the shell invocation, or a rule in `shared/floor.md`                                                      |
| Test needs a cookie banner clicked every run        | a UI-clicking snippet     | an env flag in the repo that skips it                                                                     |
| Wrong Linear label name, repeatedly                 | correct it each time      | list the canonical values where the agent will see them                                                   |
| Same expensive setup per ticket                     | accept it                 | do it once, before the batch                                                                              |
| e2e workflow creeping slower every window           | wait longer for CI        | cache/parallelize/split the job in the repo's own workflow file — that's a repo change, not a factory one |
| Same GitHub Actions job failing across multiple PRs | rerun until green         | fix the flaky step or its test, in that repo                                                              |

**Prefer removing the need over documenting the workaround.** A rule an agent must remember is weaker than a default it cannot get wrong: an env var, a script flag, a generated config. Only when the fix genuinely cannot be automated does it become a line in `AGENTS.md` or `shared/floor.md`.

Repo-specific friction belongs in that repo (`AGENTS.md`, its `.env.example`, its scripts). Factory-wide friction belongs in `shared/` so every harness gets it.

## Deliver

For each item worth acting on: make the change if it is small and mechanical, or file a Linear issue with the evidence (how many runs, which transcripts, or which workflow/repo from `ci.mjs`) if it isn't. A CI finding almost always means a change in the _product_ repo (its workflow YAML, its test setup), not in factory itself — file it there, or fix it there directly if you're already in that checkout. Proposals that change how the factory works — a new stage, a policy change, new config surface — are **FIPs**: file to team `OPS`, `Triage`, title prefixed `FIP:`, with the evidence in the body. The triage loop is the FIP review; an idea that can't survive triage wasn't ready. Then record it in `docs/friction-log.md` with its status.

**Record the rejections too**, with the reason. A friction log that only lists open items invites the same suggestion every month.

Before reporting, persist what you measured:

```bash
factory economics --roll
```

That appends this batch's runs to the durable rollup (`~/.factory/metrics/runs.jsonl`) — the record that outlives the transcripts — and it is also what closes the retro gate until enough new runs accumulate.

Finish with what changed, what was filed (issues and FIPs), and what was deliberately left alone.

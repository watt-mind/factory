# factory-retro

> Find what is repeatedly wasting the factory's time and fix the harness, not the symptom

Turn measured friction into harness changes.

Agents don't reliably remember what slowed them down, and asking them to write it up produces either nothing or noise. But every run leaves a full JSONL transcript in `~/.factory/logs/`, so the evidence already exists. Start there:

```bash
bun orchestrator/friction.mjs $ARGUMENTS
```

Then read `docs/friction-log.md` for what is already known and what was already decided against — the point is a shrinking list, not an accumulating one.

## What counts

Only two things are worth acting on:

**Repeats across runs.** A failure in one run is that ticket's problem. The same failure shape in three runs is the harness's problem, and fixing it pays every future run. The analyzer already groups by failure shape with paths and ids normalised, so the count is meaningful.

**Time sinks that shouldn't be paid per ticket.** A three-minute compile every ticket is nine minutes across three tickets; if one warm-up makes it seconds, that is the fix. Look for the same expensive command in every transcript.

Ignore one-offs, however annoying. A single flaky network call is not a harness defect, and chasing it adds a rule everyone must read forever.

## Fix the cause, at the right layer

Ask what would have made the friction impossible, then put the fix where it belongs:

| Friction | Wrong fix | Right layer |
| :--- | :--- | :--- |
| Shell glob bites every agent | tell agents to be careful | the shell invocation, or a rule in `shared/floor.md` |
| Test needs a cookie banner clicked every run | a UI-clicking snippet | an env flag in the repo that skips it |
| Wrong Linear label name, repeatedly | correct it each time | list the canonical values where the agent will see them |
| Same expensive setup per ticket | accept it | do it once, before the batch |

**Prefer removing the need over documenting the workaround.** A rule an agent must remember is weaker than a default it cannot get wrong: an env var, a script flag, a generated config. Only when the fix genuinely cannot be automated does it become a line in `AGENTS.md` or `shared/floor.md`.

Repo-specific friction belongs in that repo (`AGENTS.md`, its `.env.example`, its scripts). Factory-wide friction belongs in `shared/` so every harness gets it.

## Deliver

For each item worth acting on: make the change if it is small and mechanical, or file a Linear issue with the evidence (how many runs, which transcripts) if it isn't. Then record it in `docs/friction-log.md` with its status.

**Record the rejections too**, with the reason. A friction log that only lists open items invites the same suggestion every month.

Finish with what changed, what was filed, and what was deliberately left alone.

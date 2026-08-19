# factory-friction

> File harness friction observed in an interactive session — capture only, never implement

Capture harness friction from an interactive session where no orchestrator transcript exists.

Runs dispatched through `runners/run-agent.sh` or `orchestrator/tick.mjs` already write JSONL to `~/.factory/logs/` — `/factory-retro` measures those mechanically via `factory friction`. This command is the **backstop** when you ran `/factory-work`, `/factory-merge`, `/factory-ticket`, `/factory-ship`, or similar **directly** in a harness (Claude, Codex, Pi, Cursor) without `FACTORY_RUN_ID` set.

## 1. When to use

- At the end of an interactive factory command session (also invoked inline from those commands' closing step).
- Ad hoc when a session was painful and you want it recorded before context is lost.
- **Skip** when `FACTORY_RUN_ID` is set — the transcript is the primary sensor; don't duplicate it with memory.

## 2. What qualifies

Same bar as `docs/friction-log.md` — only two things:

**Repeats or likely repeats.** A tool error you hit twice, a retry loop (same command 3+ times), the same floor violation recovered from more than once in the session (`sleep` waits, unquoted zsh globs, wrong Linear label names, missing `FACTORY_ROOT`).

**Per-ticket costs that could be paid once.** The same expensive setup on every ticket in a batch, a harness gap that blocked every subagent (slash command not installed, MCP missing, worktree script absent).

**Do not file:** one-off ticket bugs (those go to product `Triage` via `/factory-capture`), product intent questions, vague annoyances with no actionable harness layer, or anything that is already that ticket's problem rather than the harness's.

## 3. Scan the session

`$ARGUMENTS` names specific friction if given; otherwise scan the conversation for qualifying items. If more than one distinct friction surfaced, file each separately — don't merge unrelated shapes into one issue.

## 4. Search before filing

Search Linear (`factory linear` or `docs/protocol.md` §13) for:

- Existing `FIP:` issues describing the same shape
- Prior issues whose body contains `## Session friction` with the same **Shape**
- Entries in `docs/friction-log.md` (`F-*`) already tracking it

Comment on the existing issue with new evidence instead of filing a duplicate. Link the originating command session in one line.

## 5. Route

| Finding                                                                  | Destination                                                                                                |
| :----------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| Factory-wide harness fix (floor, orchestrator, emit, shared commands)    | team `OPS`, `Triage`, title prefixed `FIP:`                                                                |
| Repo-specific friction (scripts, AGENTS.md, `.env.example`, CI workflow) | that repo's team from `config/repos.yaml`, `Triage`                                                        |
| Already tracked in `docs/friction-log.md`                                | comment on the matching `F-*` Linear issue if one exists; otherwise file and cross-reference the log entry |

Standing in the factory checkout (`config/repos.yaml` → `factory` → team `OPS`). In a product repo, route repo friction to that repo's team, not OPS.

## 6. Issue body format

Every filed friction issue includes this block (fill every field):

```markdown
## Session friction

- **Harness:** cursor | pi | claude | codex | agy
- **Command:** factory-work | factory-merge | factory-ticket | factory-ship | (other)
- **Shape:** <normalised failure pattern — no paths, ids, or ticket-specific detail>
- **Evidence:** <what happened in this session, 2–4 sentences>
- **Suggested layer:** floor | script | repo AGENTS.md | orchestrator | shared command
- **Repeat:** yes | likely | one-off (one-off usually means don't file — say so in the report instead)
```

Factory-wide items: prefix the title with `FIP:`. Do not write the full §5 agent-ready template — friction starts in `Triage` until `/factory-retro` validates repeat frequency across sessions or transcripts.

## 7. Label and file

- **`source:agent`** — observed while doing factory work (default here)
- **`type:maintenance`**
- **`area:*`** — `area:factory` for OPS/FIP items; match the repo's area labels for product-repo friction
- **State:** `Triage` only — never `Todo` + `ai:agent-ready` from this command

Use `factory linear file ...` from a worktree.

## 8. Report

List each issue filed (ID + URL) or state **none observed — session below friction bar** with one line on why. If you commented on an existing issue instead of filing, report that too.

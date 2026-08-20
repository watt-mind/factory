# Gemini CLI community post (draft)

**DRAFT — a human posts this. Agents do not publish.**

Where: Gemini CLI Discord / Google AI forum.

---

Gemini CLI (and Antigravity, which shares `~/.gemini/`) is a packaging
target, not a fork of the factory.

Skills and floor rules live in `shared/` and emit into
`~/.gemini/skills/` and `~/.gemini/agents/`. `GEMINI.md` points at
`AGENTS.md`. The ticket protocol does not change: claim, worktree, Owned
Paths, verification, PR, CI.

We ship one floor, several wrappers. Adding Gemini was "put the files
where Gemini looks," not a second orchestrator. That is the point of the
project: sit above coding agents instead of competing with them.

Measured across every harness we actually dispatched, 3–20 August 2026:

- 17 days unattended
- 1,825 tickets dispatched, 1,620 merged
- 87% merged without Blocked / `ai:escalated`
- 38 minute median claim → merge

Paste Gemini's row from `bun tools/launch-numbers.mjs` (dispatch host)
before posting if you want per-harness token counts. A host without
transcripts will not invent them.

https://github.com/watt-mind/factory — Apache-2.0,
`bin/factory demo --harness gemini`

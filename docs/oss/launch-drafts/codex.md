# Codex community post (draft)

**DRAFT — a human posts this. Agents do not publish.**

Where: Codex Discord / OpenAI forum / relevant GitHub Discussion.

---

Codex is a first-class harness in the factory, not an afterthought.

The content (skills, floor rules, agent prompts) is portable. Packaging
is the only per-harness work: Codex reads `AGENTS.md` and
`~/.agents/skills/`. Same ticket protocol as Claude Code — claim, isolated
worktree, Owned Paths, verification command, PR, CI.

We spent the first week of dispatch half-blind on Codex. A parser that
only understood Claude's JSON schema reported Codex runs as "0 turns, $0,
no result" — indistinguishable from a harness that did nothing. That hid
109 Codex runs from the budget gate in two days. The fix was one parser
(`lib/transcript.mjs`) that every consumer imports. Adding a harness now
means teaching that file, not each dashboard.

17 days unattended (3–20 August): 1,825 tickets dispatched, 1,620 merged,
median claim → merge 38 minutes, 87% without a human unblocking them.
Tokens-by-harness, including Codex, come from `bun tools/launch-numbers.mjs`
on the dispatch host.

We do not compete with Codex. We sit above it. If you already live in
Codex, the factory is the queue, the worktree, and the merge gate.

https://github.com/watt-mind/factory — Apache-2.0, `bin/factory demo --harness codex`

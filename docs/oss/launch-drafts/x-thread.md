# X thread (draft)

**DRAFT — a human posts this. Agents do not publish.**

Keep each beat under 280. Numbers from
`bun tools/launch-numbers.mjs --since 2026-08-03` on 2026-08-20. Re-run
before posting.

---

1/ We ran coding agents unattended for 17 days. Not a demo. Real tickets,
real repos, including the factory's own.

2/ 1,825 tickets dispatched. 1,620 merged. Median 38 minutes from claim
to merge. 87% never sat in Blocked and never needed an escalation label.

3/ The other 13% stopped on purpose: a human decision, a credential, or a
diff that touches auth/payments/secrets. The protocol is built to refuse
those, not to wave them through.

4/ Factory does not replace Claude Code, Codex, Cursor, Gemini CLI, or
Pi. It is the loop around them: tracker → isolated worktree → verify →
PR → CI. Nothing merges because the model said it was done.

5/ The factory is also the first customer. 529 of those merges are the
orchestrator itself. A harness bug becomes a ticket, then a PR, then the
next run. That is the dogfood-in-public badge, not a slogan.

6/ Things that actually bit us: agents `sleep 180` instead of `gh pr
checks --watch`. Orphaned Chrome locking the next 20 sessions. A parser
that treated a fenced "Owned Paths" block as empty, so a good ticket
looked unspecified.

7/ Apache-2.0, no telemetry, 15-minute demo with no third-party accounts:

bun install && bin/factory demo

https://github.com/watt-mind/factory

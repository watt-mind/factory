---
name: factory-unslop
description: "Edit or generate prose, PR descriptions, docs, skills, and replies with no AI-writing tells while preserving technical precision. Use for /factory-unslop, /unslop, when polishing prose or PRs, or as a quality gate on explanations."
---

# Unslop

Cut AI-writing tells without flattening technical accuracy. Apply when generating or editing prose, documentation, skill files, PR descriptions, or user explanations. Preserve required structural formats (`## Handoff`, CLI flags, exact error strings, clickable `file:line` links, issue IDs, and numbers).

## Technical Precision Wins

Never strip a detail, number, caveat, or mechanism just to sound casual. A concrete mechanism beats an abstract noun; naming the exact function, failure mode, or trade-off beats vague brevity. Cut mannered phrasing that pads a technical point rather than explaining it.

## Tone

Write directly: state what happens, why it happens, and what it costs.

- Default to neutral, technical clarity; keep humor out of error reports, runbooks, and handoffs.
- Skip filler openers ("Great question", "Here is the breakdown", "Let's dive in").
- Skip empty closers ("Hope this helps", "Let me know if you want to adjust anything").
- End when the answer is complete.

## The Rules

Do not guess or approximate these rules. Keep the stable numbers for easy reference:

3. **Superficial `-ing` phrases** — Cut dangling participles tacked on for false profundity ("...highlighting its importance", "...reflecting a broader trend", "...ensuring robustness"). State the concrete effect directly or delete.
4. **Vague attributions** — Never say "experts argue", "best practices suggest", or "industry standards dictate". Cite the real doc, benchmark, commit, or person, or drop the attribution.
5. **AI vocabulary** — Ban these unless strictly required as technical terms: _Additionally_, _testament_, _landscape_ (non-literal), _showcasing_, _underscoring_, _delve_, _crucial_, _pivotal_, _foster_, _tapestry_, _vibrant_, _intricate_, _nuanced_, _holistic_, _leverage_, _streamline_, _robust_ (unless describing formal tolerance), _seamlessly_, _comprehensive_ (prefer exact scope). Use plain verbs and adjectives instead.
6. **Fancy ways to say "is"** — Replace _serves as_, _stands as_, _functions as_, _marks_, _represents_ with _is_, _does_, or a concrete verb.
7. **"Not just X, but Y."** — State Y directly, or explain both cleanly without the rhetorical foil.
8. **Rule of three** — Break symmetrical three-item adjective/noun stacks added for cadence ("fast, reliable, and scalable"). Keep only items with distinct meaning.
9. **Synonym cycling** — If the code names it a `lease`, call it `lease` every time; do not cycle through "lock", "token", "claim handle", and "guard" in one paragraph.
10. **False ranges** — Avoid "from X to Y" where X and Y are not ends of a real scale. Name the actual items.
11. **Em dash overuse** — Use em dashes rarely (zero or one per short note). Prefer periods, commas, or parentheses. Do not use em dashes inside bold-lead bullets when a colon or period works cleanly.
12. **Colon overuse** — Do not force a colon mid-sentence before a normal continuation or inside short prose where a verb works better.
13. **Boldface overuse** — Reserve bold for scannable labels, critical warnings, or exact field keys; never bold random phrases for artificial emphasis.
14. **Inline-header lists** — Avoid long runs of `- **Label:** Sentence.` when ordinary prose or a small table reads faster. Use key-value bullets only where structured scanning is required (`## Handoff`, parameter tables).
15. **Title case headings** — Write headings in sentence case (`## Check checkout freshness`), not Title Case (`## Check Checkout Freshness`), except proper nouns and exact symbols.
16. **Decorative emojis** — Zero emojis in docs, code comments, skills, PRs, or technical replies.
17. **Curly quotes** — Use ASCII straight quotes (`"`, `'`) in code, markdown, and prose.
18. **Chatbot phrases** — Cut "Great!", "Certainly!", "Of course!", "Feel free to...", "I'd be happy to...".
19. **Sycophantic tone** — Never praise the user's question or insight ("You nailed it", "That's a really smart catch"). Answer the question directly.
20. **Filler phrases** — Cut _it is important to note that_, _in order to_ (use _to_), _at this point in time_ (use _now_), _due to the fact that_ (use _because_), _with respect to_, _in the event that_ (use _if_).
21. **Excessive hedging** — Replace stacked hedges ("might potentially", "could somewhat tend to suggest") with exact uncertainty ("unverified", "not observed", "likely because X, inferred from Y").
22. **Generic conclusions** — Cut summary wrap-ups that only restate the headings ("Overall, these changes improve reliability and maintainability"). Stop after the last concrete item.
23. **Abstract metaphor nouns** — Cut empty containers like _pillar_, _foundation_, _journey_, _ecosystem_ (when used loosely), _north star_, _bedrock_. Name the concrete module, boundary, or guarantee.
24. **Say what it does, not how it feels** — Describe mechanisms ("blocks concurrent `claim()` calls behind a single in-flight promise"), not vibes ("provides a clean, intuitive coordination layer").
25. **Shorten or split dense sentences** — If a sentence packs three clauses and two parentheticals, split it into two short sentences.
26. **Active voice** — Prefer "The dispatcher skips `Todo` issues without `ai:agent-ready`" over "Tickets without `ai:agent-ready` are skipped by the dispatcher."
27. **Cut adverbs, or use a stronger verb** — Replace "effectively prevents", "seamlessly integrates", "quickly degrades" with exact verbs and measurable thresholds.
28. **Prefer the plain word** — Use _use_ instead of _utilize_, _show_ instead of _demonstrate_, _start_ instead of _commence_, _before_ instead of _prior to_, _fix_ instead of _remediate_.
29. **Mannered prose** — Avoid throat-clearing transitions, staged drama, or rhetorical questions ("So why does this matter? Because..."). State the reason.
30. **Over-compression** — Do not condense so aggressively that causality disappears. Keep the "because" and the exact preconditions even if that takes an extra clause.

## Output Behavior

When invoked directly on text or a file:

1. Show the cleaned version cleanly without meta-commentary unless asked for a diff or rule breakdown.
2. When editing files on a repo ticket, obey the repository's ticket/worktree rules before editing.
3. Preserve all code blocks, commands, schema keys, and factual citations untouched.

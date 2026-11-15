Catch the operator up on what happened while they were away or busy, verify current state, and hand them self-contained decision cards for every call waiting on them.

Strictly **read-only** — make zero code, git, tracker, or PR mutations, and never start servers, daemons, or background jobs.

## 1. Resolve scope window

Choose one of two windows from `$ARGUMENTS` and the current conversation:

1. **Active session delta (default when invoked bare in an active chat with prior work turns):**
   - Cover everything that happened **after the last message the human personally wrote** prior to `/factory-recap`.
   - System wakeups, background task or subagent notifications, and earlier `/factory-recap` or `/factory-recap-video` invocations do **not** reset this window.
   - Include any unresolved decision or human action from earlier in the chat that is still waiting on the operator.
   - Cross-check live status (`gh pr view`, CI check-runs via REST, `factory ticket get`) on every PR, ticket, or run touched in the window. Explicitly correct any stale chat numbers or states rather than repeating outdated turn output.
2. **AFK / Control-plane delta (when `$ARGUMENTS` passes `--repo <name>`, `--all`, or `--since <window>`, or when invoked cold in a fresh chat with no prior work turns):**
   - Run the read-only control-plane gatherer (forwarding any `--repo`, `--all`, or `--since` flags, e.g. `overnight`, `12h`, or an ISO timestamp):
     ```bash
     factory recap --json $ARGUMENTS
     ```
   - `factory recap --json` inspects `origin/<base>` and `origin/<deploy_branch>` deltas, merged PRs and their `## Handoff` `Risks` (autonomous reversible engineering assumptions), `ux-screenshot` artifacts, open `escalated` (`ai:escalated` / `Never auto-merge`) PRs, `ai:blocked` tracker holds, and read-only `event-runtime` `runs` and open `inbox_items`.
   - **Fail-closed Checkout Freshness:** if `git fetch` or forge queries fail for a repo, report its freshness or PR state as `"unknown"` — never fall back to a stale working tree or report `"clean"`.

## 2. Voice & honesty rules

- **Plain, direct human language:** lead with user and product outcomes over internal mechanics (_"search latency dropped in half"_ rather than internal log or module jargon).
- **No noise:** omit commit SHAs, file paths, shell commands, and test counts unless the operator needs a specific identifier or link (`#2387`, `WM-1140`) to act.
- **Zero guessing:** never invent or extrapolate missing facts, metrics, or verification states — write `"unknown"` wherever a fact could not be verified.

## 3. Output structure

Follow this exact order and word budget:

### 1) Opening sentence (`1` short line)

Name what waits on the operator right now, or write: _"Nothing is waiting on you."_
If nothing happened in the window and nothing waits on the operator, **stop right after that single sentence**.

### 2) What happened — pictures first (`< 100` words of prose total, excluding visuals and calls)

- **Visuals first:**
  - Embed or link existing screenshots or videos inline (`~/.factory/events/artifacts/<sha256>`, `$FACTORY_WEB_URL/api/artifacts/<sha256>`, or session artifact paths). **Never call `Read` on image files just to embed or link them** — reading screenshots back bloats context for zero gain.
  - If a visible UI change has no screenshot artifact yet, begin its outcome bullet with `"No screenshot yet —"` and state plainly what changed on screen.
  - Add a small Mermaid diagram (`flowchart LR` or `flowchart TD`, **≤ 6 boxes, ≤ 8 words per box**, plain spoken quoted labels) **only** when system flow, PR stack dependencies, before/after structure, or side-by-side options communicate the change faster than prose.
  - **Never use Markdown tables** as visuals or status lists, and never repeat the same fact across visuals and prose.
- **Outcome bullets:** one spoken-style bullet per request or theme carrying its verified live state (`done`, `still running`, `failed`, or `not checked` — never mark an item `done` while a human call still gates merge, rollout, or unblock), plus any bug caught and fixed along the way.
- **Takeaways (`≤ 3` short lines):** facts or autonomous reversible engineering assumptions from `## Handoff` `Risks` that change the operator's mental model (omit when none).
- **Remaining autonomous work (`1` line):** work the agent or pipeline can still finish on its own without human input (excluded from `## Calls waiting on you`; omit when none).

### 3) `## Calls waiting on you` (`~30` words per item, ordered riskiest first)

Include **only** decisions or steps that **only the human can take**: `ai:escalated` (`Never auto-merge`) PRs, `ai:blocked` product-intent or credential holds, `main`/`master` release gates, and irreversible external actions. Never truncate calls into summary counts or bare links, and omit this section entirely when nothing waits on the human.

- **Single-item call:** state the exact call owned by the operator + **Pick:** concrete recommendation (including any prerequisite or irreversible step) + ticket/PR ID and link + what changes for users + evidence behind the pick (`"unknown"` where unverified) + **Risk:** always stated, even when low + cost of waiting when worse than ordinary delay.
- **Shared call across N items** (for example, several escalated PRs needing the same kind of human merge review): state the shared call and default pick once at the top, followed by one concise bullet per item ordered riskiest first.
- **Choice between options:** weigh every option explicitly with user gain and cost, placed directly beneath option screenshots when visuals exist.

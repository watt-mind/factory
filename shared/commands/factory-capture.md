---
description: File a Linear issue from this conversation, per the ai:agent-ready protocol — capture only, never implement
argument-hint:
  [
    optional: what to file,
    e.g. "the slow OAuth refresh bug we just found"; default: infer from this conversation,
  ]
model: sonnet
---

Turn what just came up in this conversation into a Linear issue. This command **only files** — it never implements, and it never claims the ticket. If the finding should also be worked, that's a separate step (claim it yourself, or hand it to `/factory-work`).

## 1. Find what to file

`$ARGUMENTS` names the finding if given; otherwise scan the conversation so far for the thing worth tracking — a bug, a missing requirement, tech debt, a follow-up idea, an operational finding. If more than one distinct thing surfaced, ask which one, or file each separately — don't merge unrelated findings into one issue.

Confirm it clears the bar in `docs/protocol.md` §8 before filing anything: **meaningful, trackable work** (a code/config change, deployment, deliverable, or an investigation with an operational finding) — not an ordinary question, a read-only lookup with no actionable finding, or an inconsequential edit. If it doesn't clear the bar, say so and don't file.

## 2. Route it

Repo → team/project mapping, and the full `ai:*`/`source:*`/`type:*`/`area:*` label taxonomy, are in `$FACTORY_ROOT/docs/protocol.md` §1–3 — read it if this session hasn't already. A repo may carry its own issue-management guide; follow that inside that repo and do not import another team's labels into it.

If the current working directory matches a repo in `config/repos.yaml`, use its `team`/`project`. Otherwise infer team/project from what the conversation was actually about — ask if it's genuinely ambiguous rather than guessing.

**Search for duplicates first** (`factory ticket`, per `docs/protocol.md` §13) — don't file a second issue for something already tracked; comment on the existing one with the new evidence instead and report that back, not a new issue.

## 3. Label and specify

Every issue gets exactly one `source:*` label at creation. This came from a human talking in chat, so default to **`source:human`** — use `source:agent` only if the finding is something an agent noticed while doing other work and the human is just asking to have it recorded. Add the canonical `type:*` and `area:*` labels, and set priority from evidence in the conversation (severity, frequency, blast radius) — never left at default.

Decide **Triage vs. `Todo` + `ai:agent-ready`**:

- Write the full §5 template (Problem & Context, Acceptance Criteria, Source File Pointers, Owned Paths, Verification Command) only if the conversation actually gave enough to fill all five sections for real. A plausible-sounding guess at `Owned Paths` or a Verification Command that hasn't actually been confirmed to run is worse than leaving the ticket in `Triage` — it will pass a template check and still fail at execution time.
- Otherwise file to **`Triage`** with whatever context exists (Problem & Context at minimum), and say explicitly what's missing before it can be promoted.

When promoting to `Todo` + `ai:agent-ready`, also set a `tier:*` label (closed vocabulary: `tier:light`, `tier:standard`, `tier:strong`) per the sizing rule — `light` for a one-or-two-file change outside `escalate_paths` (`config/repos.yaml`), `type:docs`/copy/config-value, or a reproduced bug with a one-line fix; `strong` for any `escalate_paths` path, `type:security`, cross-package/architecture work, or acceptance criteria that say "design"/"decide"; `standard` otherwise — and note the tier and why in the same comment where you report the promotion.

Never move an issue to `Todo` without `ai:agent-ready` fully satisfied, and never claim it — filing and working are different steps, and this command only does the first.

## 4. File and report

Create the issue. In the description, link back to what the conversation was actually about — a concise restatement of the finding, not a literal transcript dump. Report: the issue ID and URL, which state it landed in, and — if left in `Triage` — the one or two things a human needs to add before it's agent-ready.

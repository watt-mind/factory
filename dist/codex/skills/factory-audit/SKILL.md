---
name: factory-audit
description: Audit this repo against the project-conventions baseline; file the gaps to Linear
---

# factory-audit

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Audit a repository against the conventions baseline in `~/Develop/hdkiller/docs/guides/project-conventions.md` and turn the gaps into tracked work.

Default target is the repo I'm currently in. Interpret $ARGUMENTS as a different repo path, specific check IDs to run in isolation, or `all` (every repo in `config/repos.yaml` that exists locally — audit each and report a matrix).

## 1. Grade every check

Work through the **§7 conformance table** — `PC-01` … `PC-20` — in order. That table is the source of truth for what's required; read it fresh each run rather than from memory, since it changes as the baseline grows.

For each check, record **PASS / FAIL / N/A** plus the evidence you actually observed: the command you ran and its relevant output, or the file and line. An unverified PASS is worse than a FAIL — it certifies something nobody checked.

Rules that keep the grade honest:

- **Verify against the live repo and the live GitHub settings**, not against what `AGENTS.md` or this guide claims. `PC-20` exists precisely because docs drift; when a doc and reality disagree, the doc is the finding. "Live" means `origin/<base>`, so `git fetch --quiet` first and follow the floor's **Checkout freshness** rule — a FAIL graded against a checkout that predates the fix is a fabricated finding, and it gets filed as a ticket for work already done.
- **N/A requires a stated reason** grounded in the repo ("no auto-deploy branch", "free private plan blocks branch protection"). Never N/A a check because it's inconvenient or because fixing it is out of scope — that's a FAIL with a filed ticket.
- **`PC-03` (runner policy) and `PC-18` (missing secrets) are cheap and high-consequence** — on private repos cloud runners bill real money; on public repos, fork PR sandboxing requires standard hosted runners or ephemeral isolation, while self-hosted remains for trusted internal lanes. Always check them, even in a partial audit.
- For `PC-17`, a workflow that exists but is disabled by a stale `if:` gate is a **FAIL, not a PASS** — a gate whose stated precondition has since been met is the most common way a repo loses its strongest test signal without anyone noticing.
- Read-only. Do not fix anything during grading; grade first, so the report reflects the repo as found.

## 2. Report

A table: check ID, requirement (short), verdict, evidence. Then a summary line — blockers / high / medium outstanding — and the **single highest-leverage fix** for this repo, named explicitly.

Sort failures by what they cost: a check that lets broken code reach production outranks a formatting gate.

## 3. File the gaps

Every FAIL becomes a Linear issue in `Triage` per `docs/protocol.md` §8: correct team/project from `config/repos.yaml` (§1), `type:maintenance` (or `type:security` where that's the real nature), the matching `area:*`, `source:agent`, priority from the severity column, and the check ID plus observed evidence in the description. Search first — a repeat audit must update or skip an existing ticket, never file a duplicate.

Where a fix is small, mechanical, and unambiguous (adding `retention-days: 1`, aligning runner configuration with the repo's public/private isolation policy, adding a missing thin `CLAUDE.md`), write the issue to the full §5 AI-ready template, label it `ai:agent-ready`, and move it to `Todo` so the next `/factory-work` run picks it up without further human involvement. Anything needing a decision, a credential, or a plan upgrade stays in `Triage` with the specific question stated.

## 4. Offer, don't assume

End by asking whether to fix the agent-ready ones now. Do not start implementing during an audit — a run that both grades and rewrites the repo makes it impossible to tell what was found from what was changed.

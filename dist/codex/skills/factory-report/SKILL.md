---
name: factory-report
description: Linear status report across configured repos — queue depth, triage backlog, ready-to-dispatch, blocked/held
---

# factory-report

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Give a snapshot of where the factory pipeline stands, across Linear, right now. Read-only — this never claims, triages, or dispatches anything.

## 1. Resolve scope

Default: every repo in `config/repos.yaml`. `$ARGUMENTS`, if present, names one repo (matches `factory queue --repo <name>`'s matching).

## 2. Gather

From the factory checkout (or any cwd with `factory` on PATH):

```bash
factory queue --repo <repo>      # omit --repo for every configured repo
factory digest --repo <repo>     # omit --repo for every configured repo
factory ci-health --report       # base-branch CI alarms (add --repo to narrow)
```

`queue` gives per-repo counts (Triage, Todo-not-ready, READY to dispatch, In Progress, In Review, Blocked, Done/total) plus which tickets are startable right now and how many open PRs are waiting on merge. `digest` lists every `ai:blocked` hold with its age and whether a reply has landed (which means the next triage tick will re-examine it). Both are cheap, read-only, and already read the same queue snapshot the pipeline itself uses — don't re-derive counts by querying Linear directly.

`ci-health --report` reads only the alarm state `factory ci-health` last wrote (`~/.factory/state/ci-health.json`) — it makes no GitHub calls, so it is as cheap as the other two. A `RED <job>` line means that job has failed on that many consecutive pushes to the repo's base branch and the operator has already been notified once; a repo that has never been checked says so rather than claiming green.

## 3. Report

Synthesize, don't just relay raw terminal output (the ANSI coloring won't survive into chat). Structure:

- **Headline** — total tickets across scope, and the one-line pipeline constraint: is it starved for specification (deep Triage, empty ready queue), starved for dispatch slots (ready tickets but no free workers), or clear?
- **Per-repo table** — repo, Triage, Todo-not-ready, Ready, In Progress, In Review, Blocked, Done/total. Flag any repo where Triage is unusually deep (>20) or Ready sat nonzero with zero free slots.
- **Ready to work now** — the startable tickets `queue` printed, grouped by repo, so this doubles as "what can we work next."
- **Needs a human** — every held ticket from `digest`, oldest first, with its question excerpt; call out any marked `ANSWERED` since those are one triage tick away from unblocking, not stuck.
- **Awaiting review/merge** — repos with nonzero In Review or open PRs.
- **Base CI health** — one line per repo from `ci-health --report`. A red base blocks every merge and every ship for that repo, so say it here even when the queue looks healthy; name the job and how many pushes it has been red. "Never checked" is not green — report it as unknown.

Close with one line: if there's a clear next action (`/factory-triage`, `/factory-work`, `/factory-merge`, or a specific held ticket that needs an answer), name it — but don't run it. That's `/factory-next`'s job, not this command's.

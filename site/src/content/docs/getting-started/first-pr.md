---
title: Your First Dispatch
description: What happens when factory picks up a ticket, and how to read the result
sidebar:
  order: 3
---

Once your repository is [connected](/factory/getting-started/quickstart/) and one agent-ready ticket is sitting in `Todo`, dispatch is two commands: ask what factory would do, then let it.

```bash
factory next --repo <name>                              # read-only recommendation
factory next --repo <name> --apply --harness claude     # or codex, gemini, cursor, pi, agy
```

`--repo` takes the `name` from your `config/repos.yaml` stanza, not the `OWNER/REPO` slug.

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#first-real-pr"
  title="First real pull request"
  loading="lazy"
></iframe>

## What `--apply` does

1. **Claims the ticket** — assigns it, moves it to `In Progress`, adds `ai:in-progress`, then re-reads it. That read-back is the entire concurrency control: if the assignee came back as someone else, another agent won the race and this one takes the next ticket instead.
2. **Provisions an isolated worktree** — via your `worktree_up` script if the repo declares one, so ports, databases, and scratch state are isolated too, not just the branch.
3. **Runs your coding agent inside the ticket's `Owned Paths`** — the harness you named, with the repo's `AGENTS.md` floor in context.
4. **Re-runs the verification command independently** — outside the agent's process, on the resulting tree.
5. **Pushes and opens a PR** against the `base` you configured.
6. **Posts a handoff** on the ticket and moves it to `In Review` with `ai:needs-review`.

Step 4 is the one that matters. The agent's own report that the tests pass is commentary; factory runs the command itself and reads the exit code. See [Verification as a Gate](/factory/concepts/verification/).

## Reading the result

Check these three things on the first PR, in this order:

- **The base branch.** `gh pr view <n> --json baseRefName`. It must match the `base` in your repo stanza. GitHub's default branch is not used as a fallback, so a mismatch means the stanza is wrong.
- **The diff stays inside `Owned Paths`.** Files outside that glob set are the signal that the ticket was under-specified, not that the agent misbehaved.
- **The verification output** in the ticket's handoff comment, against the command you declared.

## When it refuses

`factory next` refuses by naming the gate that failed rather than guessing, so the reason is the fix. The ones you are most likely to meet on a fresh connection:

| Reason                                 | What it means                                                                                                                                                        |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo_report_only`                     | The stanza still has `report_only: true`. Remove it when you are ready to act.                                                                                       |
| `owned_paths_unknown`                  | The ticket's `Owned Paths` section did not parse. It must be one path or glob per bullet, with no spaces — a comma-separated list on one bullet is dropped silently. |
| `owned_paths_overlap`                  | Another in-flight ticket already owns some of these paths. This is the concurrency guarantee working, not a bug.                                                     |
| `no_worktree_scripts`                  | Event-runtime dispatch needs `worktree_up`, `worktree_down`, and `worktree_root`. See step 10 of the connect prompt.                                                 |
| `ticket_not_agent_ready`               | Missing the `ai:agent-ready` label.                                                                                                                                  |
| `ticket_not_todo`                      | Not in `Todo`. `Triage` and `Backlog` are deliberately not queues to pull from.                                                                                      |
| `ticket_assigned`                      | Someone — or some agent — already holds the claim.                                                                                                                   |
| `capacity_full`                        | `max_in_flight` for this repo is reached. Working as configured.                                                                                                     |
| `ticket_escalated` / `ticket_security` | The diff or ticket touches auth, payments, secrets, migrations, or production infra. These come back to a human by design.                                           |

## After the PR

Nothing merges because an agent said it was done. The merge stage reviews the diff against the ticket, waits for the checks named in `merge_ci.required_checks` to actually report success, and holds anything security-relevant for a human.

- [Verification as a Gate](/factory/concepts/verification/) — why the exit code is the evidence.
- [Owned Paths](/factory/concepts/owned-paths/) — how disjoint globs make parallel dispatch safe.
- [Configuration](/factory/getting-started/configuration/) — `max_in_flight`, `merge_ci`, escalation paths.

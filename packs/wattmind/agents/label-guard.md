# label-guard — closed-registry action

Not a prompt: this definition executes a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs.

```
bun orchestrator/label-guard.mjs --repo {repo} --apply
```

Mechanical linear.md §5 check for `ai:agent-ready` tickets: a ticket that
reads as dispatchable (Todo, unassigned, labelled) but is missing the two
mechanically load-bearing sections — Owned Paths and Verification Command —
is demoted back to Triage before dispatch can ever see it. Deliberately
checks nothing that varies in legitimate format; it errs toward precision.

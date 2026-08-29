# reaper — closed-registry action

Not a prompt: this definition runs a fixed command template via the
deterministic command adapter (`lib/adapters/command.mjs`). No model runs,
which is the point — a scheduled LLM loop would draw on the same unobservable
subscription usage window as interactive sessions (docs/event-runtime.md §3),
and a timer that can starve the operator's own work is not a loop worth
having yet.

```
bun {factoryRoot}/orchestrator/reaper.mjs --apply
```

Reclaims stale agent claims in Linear: tickets left `In Progress` with an
`ai:in-progress` / `agent:*` marker by an agent that crashed mid-ticket. The
script is dry-run by default; `--apply` is visible here in the registry
rather than buried in a plist, and its whole output is captured as an
artifact.

# factory-swarm

> Fan out N parallel workers across slices or cross-harness races, drain them, and return one consolidated report

Fan out N parallel workers for the requested task using **`shared/skills/factory-swarm/SKILL.md`** and `factory swarm` (or T3Code Orchestrator MCP tools when inside T3Code).

1. **Frame:** State the done predicate, choose `partition`, `race` (`first-pass` | `rank-all` | `best-of`), or `mixed`, lock exact commit SHAs/measurement methods if applicable, and isolate writable outputs.
2. **Fan out:** Launch all N workers in parallel via T3Code (`delegate_task` / `create_threads`), harness-native `swarm`, or `factory swarm run --json` (configured by `~/.factory/swarm.yaml` or `config/swarm.example.yaml`), requiring `PASS`, `ISSUES`, or `BLOCKED` verdicts with evidence.
3. **Aggregate:** Drop any result missing required SHAs/method and respawn once (else record a gap), apply the declared race rule, and synthesize without raw dumps.
4. **Report & Cleanup:** Run `factory swarm cleanup --manifest <manifest>` if CLI sandboxes/worktrees were created, and return one consolidated result table, issue one-liners, and gaps/dropouts.

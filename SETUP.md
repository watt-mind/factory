# Setup

## 1. Authenticate the CLI

```bash
claude setup-token
```

Do this **before** loading any launchd job. A launchd process inherits no interactive session, so without a long-lived token the job fails on auth in a way that looks like a hang rather than an error.

## 2. Distribute to the other harnesses

```bash
bun build/emit.mjs           # regenerate plugins/ and dist/
bun build/emit.mjs --link    # symlink ~/.codex, ~/.gemini, ~/.cursor at shared/
bun run link-repos           # symlink plugins/core/commands/ into every repo in config/repos.yaml
```

Symlinks rather than copies: `git pull` then updates every harness at once, and there's no copy to drift. `--link`/`--link-repos` refuse to overwrite a real file, so neither will clobber anything you wrote by hand.

**`bun run link-repos` is not optional for headless dispatch.** `runners/run-agent.sh` invokes `claude -p`, which reads project commands from `<repo>/.claude/commands/` directly — it does not go through the marketplace plugin in step 4 below (that route needs an interactive session; see the comment above `--link-repos` in `build/emit.mjs`). Skip this and a repo's headless commands silently run against whatever command set was symlinked in last, however old. **Re-run it every time a `/factory-*` command is added, renamed, or removed** — nothing else notices the drift; OPS-69 is exactly this bug (`factory-unblock` merged, never linked into cashsaas/bj29/legalease, first headless run failed with `Unknown command: /factory-unblock`).

## 3. Scheduling — deliberately empty

**Nothing is scheduled.** The factory runs in the foreground where it can be watched; every job in `config/schedule.yaml` is `enabled: false` and `deploy/launchd/` is empty. Enabling a loop is a decision, not a setup step — flip one, watch it for a week, then consider the next.

Run the reaper by hand when you want it:

```bash
bun orchestrator/reaper.mjs           # dry run first
bun orchestrator/reaper.mjs --apply
```

```bash
launchctl list | grep wattmind    # expect no output
```

> [!NOTE]
> `com.wattmind.linear-reaper` was installed by hand on 2026-08-03 and **unloaded the same day** under this policy. Its wrapper and script remain; only the timer is gone. Re-enabling means setting `enabled: true` in `config/schedule.yaml` and running `bun deploy/gen.mjs --install` — never writing a plist by hand.

## 4. Enable a product repo

```json
// <repo>/.claude/settings.json
{
  "extraKnownMarketplaces": {
    "factory": { "source": { "source": "github", "repo": "watt-mind/factory" } }
  },
  "enabledPlugins": ["core@factory"]
}
```

This is a **private** repo, so any machine loading the plugin needs GitHub auth — including ephemeral cloud VMs. A sandbox without it fails closed and starts with no floor, which is why the non-negotiables also live in each repo's `AGENTS.md`.

## 5. Verify

```bash
bun test
bun deploy/gen.mjs
```

## Known gaps

These are deliberate — the scaffold ships honest about what isn't built.

| Gap | Why it's not done |
| :--- | :--- |
| `orchestrator/tick.mjs` | Dispatch stays disabled until `PC-15` (worktree isolation) lands in the repos it would dispatch to — see CW-363, CLNT-609. Dispatching into repos with no port/database isolation is how two agents share one dev database. |
| `runners/` | The shared worktree library is deliberately deferred: BJ29 is the only implementation today. Extract after CW-363 and CLNT-609 land, when the real variation across Wasp/Prisma/Postgres, pnpm/Nuxt/Prisma and Django/SQLite is visible. Rule of three. |
| `evals/run.mjs` | Cases are written first on purpose — they specify what the skill is for. |
| `config/repos.yaml` | Not created. Ports and test commands would be invented today; they come from the worktree scripts once those exist. |
| Per-agent Linear identity | Every agent currently claims as the human, so the assignee lock can't detect a lost race (OPS-40). The dispatcher is the natural place to inject a per-agent key — build it in rather than retrofitting. |

## Flags worth knowing

Verified against Claude Code **2.1.220**: `--max-budget-usd`, `--allowedTools`, `--fallback-model`, `--output-format`, `--session-id`, `--resume`, and `setup-token` all exist. **`--max-turns` does not** appear in this version's help — the budget cap is the real bound; a turn cap will silently fail to apply.

Use `--output-format json` (not `stream-json`) for unattended runs: stream is for showing a human live progress, while the JSON envelope carries `session_id`, `total_cost_usd`, `num_turns`, and `subtype` — which is how budget accounting gets its input.

Branch on zero vs non-zero exit and read the structured output for the reason. A model refusal does not show up in the exit code at all; `subtype === "success"` is the truth.

Headless billing changed around mid-June 2026, past the reliable knowledge of the models that wrote this file — check current docs before sizing `budget.per_ticket_usd`.

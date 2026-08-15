# Setup

## 1. Authenticate the CLI

```bash
claude setup-token
```

Do this **before** loading any launchd job. A launchd process inherits no interactive session, so without a long-lived token the job fails on auth in a way that looks like a hang rather than an error.

## 2. Distribute to the other harnesses

```bash
bun build/emit.mjs           # regenerate plugins/ and dist/
bun build/emit.mjs --link    # symlink ~/.agents/skills, ~/.gemini, ~/.cursor at shared/
bun build/emit.mjs --link-bin # symlink ~/.local/bin/factory (cwd-independent CLI)
bun run link-repos           # symlink plugins/core/commands/ into every repo in config/repos.yaml
```

Add `~/.local/bin` to your PATH if it is not already (e.g. `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`).

Symlinks rather than copies: `git pull` then updates every harness at once, and there's no copy to drift. `--link`/`--link-repos` refuse to overwrite a real file, so neither will clobber anything you wrote by hand.

`link-repos` also ensures each repo's `.gitignore` carries a `FACTORY:HARNES` block excluding `.claude/commands/factory-*.md` (and `.cursor/commands/factory-*.md`) — harness symlinks are machine-local install artifacts, not repo content. Commit the `.gitignore` change when emit adds it.

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
(cd event-runtime/web && bun install --frozen-lockfile)
bun test
bun build/emit.mjs --check
bun deploy/gen.mjs
```

That is the gate CI applies to every pull request and to every push to `develop` and `main`. The web install comes first because the web `.test.tsx` files resolve React's JSX runtime out of `event-runtime/web/node_modules`; without it `bun test` reports a green that CI will not reproduce (OPS-384). `--check` is the half that proves the generated tree still matches `shared/`.

## 6. The dev loop — `factory up --dev` (WM-213)

`factory up` is the live stack. `factory up --dev` is the same three daemons with reload wired in, so iterating no longer means `factory down && factory up` after every edit:

```bash
factory up --dev     # serve --watch + vite HMR web UI + drain-aware worker
factory tail         # all three logs (serve, worker, web)
factory down         # stops all three
```

It needs the web deps (`cd event-runtime/web && bun install`) because the UI runs under vite instead of the static `serve.mjs` build; `--dev` says so and exits rather than failing inside vite. Plain `factory up` behaves exactly as before.

**The worker reloads only when idle.** It stamps its own code at startup (HEAD plus a content hash of `event-runtime/lib/**` and `event-runtime/cli.mjs`, so uncommitted edits count) and re-checks that stamp *between claims*. On a change it exits `75` and the supervisor re-execs it. A run in flight keeps the old code to completion — logged as `reload deferred until <run> finishes` — and the reload happens at the next idle poll. Nothing can interrupt a running agent, which is the reason this is a poll-boundary check and not a file watcher.

**Which change needs which reload:**

| You changed | What reloads it |
| :--- | :--- |
| `event-runtime/lib/**`, `event-runtime/cli.mjs` | serve restarts immediately (`bun --watch`, drops in-flight planner work); the worker restarts at its next idle poll |
| `event-runtime/web/**` | vite HMR — the open tab updates, nothing restarts |
| `agents/*.md`, `schemas/**` | **neither.** Definitions are read per plan/claim but their pinned hashes are not: run `bun event-runtime/cli.mjs update-pins` |
| `config/*.yaml` | restart serve |
| `bin/live-stack.sh` | `factory down && factory up --dev` |

Details, including the `work --reload-on-change` flag and `FACTORY_CODE_STAMP_ROOT`, are in [event-runtime/README.md](event-runtime/README.md#dev-live-reload--factory-up---dev-wm-213).

## Known gaps

These are deliberate — the scaffold ships honest about what isn't built.

| Gap | Why it's not done |
| :--- | :--- |
| A shared worktree library | Each repo still owns its own `bin/worktree-{up,down,warm}.sh`, and the common library stays deliberately deferred. The real variation across Wasp/Prisma/Postgres, pnpm/Nuxt/Prisma and Django/SQLite is visible now, but extracting it is real work with no forcing function yet — and a wrong abstraction here silently breaks the port and database isolation the scripts exist for. |
| `evals/run.mjs` | Cases are written first on purpose — they specify what the skill is for. |
| Per-agent Linear identity | Every agent currently claims as the human, so the assignee lock can't detect a lost race (OPS-40). The dispatcher is the natural place to inject a per-agent key — build it in rather than retrofitting. |

## Flags worth knowing

Verified against Claude Code **2.1.220**: `--max-budget-usd`, `--allowedTools`, `--fallback-model`, `--output-format`, `--session-id`, `--resume`, and `setup-token` all exist. **`--max-turns` does not** appear in this version's help — the budget cap is the real bound; a turn cap will silently fail to apply.

Use `--output-format json` (not `stream-json`) for unattended runs: stream is for showing a human live progress, while the JSON envelope carries `session_id`, `total_cost_usd`, `num_turns`, and `subtype` — which is how budget accounting gets its input.

Branch on zero vs non-zero exit and read the structured output for the reason. A model refusal does not show up in the exit code at all; `subtype === "success"` is the truth.

Headless billing changed around mid-June 2026, past the reliable knowledge of the models that wrote this file — check current docs before sizing `budget.per_ticket_usd`.

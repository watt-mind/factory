# Setup

## 1. Supported clean-room environments

Factory is supported on macOS 13 or later (Apple Silicon and Intel) and
Linux on x64 or arm64. Start from a new clone; no existing Factory directory,
Linear token, or machine-local configuration is required.

Install these command-line tools before configuring a real repository:

| Tool                 | Supported version                                     | Check                 |
| :------------------- | :---------------------------------------------------- | :-------------------- |
| Bun                  | Bun >= 1.3                                            | `bun --version`       |
| Git                  | Git >= 2.40                                           | `git --version`       |
| GitHub CLI           | Current stable release (tested with 2.70+)            | `gh --version`        |
| Coding-agent harness | One of Claude Code, Codex, Gemini, Cursor, Pi, or Agy | `<harness> --version` |

For a real GitHub-backed run, authenticate the GitHub CLI first. The command
uses its own credential store; do not create or paste a token into Factory
configuration.

```bash
gh auth login -h github.com
gh auth status
```

`factory doctor` reports missing Bun, Git, GitHub CLI, GitHub authentication,
and harnesses with the command or URL that fixes each prerequisite. Run it
before creating your first real ticket:

```bash
factory doctor
```

## 2. Install and select a coding-agent harness

```bash
claude setup-token
```

Do this **before** loading any launchd job. A launchd process inherits no interactive session, so without a long-lived token the job fails on auth in a way that looks like a hang rather than an error.

If you use another supported harness, complete that harness's own login flow
instead. The GitHub CLI authentication above is still required for GitHub
Issues and PRs.

## 3. Initialize a clean clone

From the root of a freshly cloned Factory checkout:

```bash
bun install --frozen-lockfile
bun build/emit.mjs --link-bin
export PATH="$HOME/.local/bin:$PATH"

# Copy local-only configuration templates without overwriting existing files.
factory init --root "$PWD"

# Use GitHub Issues rather than Linear for this installation.
factory init --control-plane github --root "$PWD" --repo OWNER/REPO --team TEAM
```

The second command writes a GitHub control-plane stanza to the local,
gitignored `config/policy.yaml`; it does not contact GitHub or require a
Linear token. It prints the Project status values and labels to create before
dispatching. Replace `OWNER/REPO` and `TEAM` with the repository and issue
prefix you will use. Keep local configuration and credentials out of commits.

## 4. Distribute to the other harnesses

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

## 3. Scheduling — orchestrator loops deliberately empty

**No orchestrator loop is scheduled.** The factory's Linear/git loops run in
the foreground where they can be watched; every job in `config/schedule.yaml`
is `enabled: false`. The two committed plists in `deploy/launchd/` are instead
the event runtime's always-on control plane and worker pool (§3a). They do not
enable a scheduled orchestrator loop. Enabling a loop is still a decision, not
a setup step — flip one, watch it for a week, then consider the next.

Run the reaper by hand when you want it:

```bash
bun orchestrator/reaper.mjs           # dry run first
bun orchestrator/reaper.mjs --apply
```

```bash
launchctl list | rg wattmind
# Before §3a: expect no output. After §3a: expect only event-serve/event-work.
```

> [!NOTE]
> `com.wattmind.linear-reaper` was installed by hand on 2026-08-03 and **unloaded the same day** under this policy. Its wrapper and script remain; only the timer is gone. Re-enabling means setting `enabled: true` in `config/schedule.yaml` and running `bun deploy/gen.mjs --install` — never writing a plist by hand.

### 3a. Event runtime as launchd user agents (WM-139)

`deploy/gen.mjs` also emits two long-running user agents:

- `com.wattmind.factory.event-serve` — API, planner, scheduler, and outbox;
- `com.wattmind.factory.event-work` — a pool supervisor, which starts workers
  only after `http://127.0.0.1:$FACTORY_EVENT_PORT/health` answers.

They must be bootstrapped into the **GUI domain**. That is the login-session
context carrying the user's keychain, `HOME`, `~/.ssh`, and launchd-provided
SSH environment. Do not install either agent from this ticket worktree; install
from the durable checkout after the change lands.

Generate and validate the committed definitions (the default pool is 1–2
workers; `--workers 2` fixes it at two, and `--workers 2:4` permits two to
four):

```bash
cd ~/Develop/factory
bun deploy/gen.mjs --workers 1:2
plutil -lint deploy/launchd/com.wattmind.factory.event-{serve,work}.plist
```

Create the operator-owned environment file. It is sourced as shell syntax by
`bin/event-runtime-daemon`; keep it mode `600`. Values are intentionally not
present in either plist or git:

```bash
umask 077
mkdir -p ~/.factory
cat > ~/.factory/secrets.env <<'EOF'
# Required only for authenticated event/webhook intake.
FACTORY_EVENT_SECRET='replace-with-the-runtime-secret'

# Optional runtime settings.
FACTORY_EVENT_NOTIFY=0
FACTORY_EVENT_PORT=7381
FACTORY_EVENT_HOME="$HOME/.factory/event-runtime"
FACTORY_EVENT_ENV=live
EOF
chmod 600 ~/.factory/secrets.env
```

`FACTORY_EVENT_SECRETS_FILE` may name another file. Set it in the GUI launchd
domain before bootstrap (`launchctl setenv FACTORY_EVENT_SECRETS_FILE
/absolute/path`) if the default is not used. `launchctl setenv` can likewise
provide individual values for the current login session, but the file is the
persistent setup across the next login.

Install and bootstrap. Starting both immediately is safe: the worker launcher
polls the real `/health` condition for up to 120 seconds before the supervisor
opens SQLite, preventing the serve/worker WAL initialization race (OPS-376).

```bash
mkdir -p ~/Library/LaunchAgents
install -m 0644 deploy/launchd/com.wattmind.factory.event-serve.plist ~/Library/LaunchAgents/
install -m 0644 deploy/launchd/com.wattmind.factory.event-work.plist  ~/Library/LaunchAgents/

launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.wattmind.factory.event-serve.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.wattmind.factory.event-work.plist
```

Verify liveness after bootstrap (and after a logout/login or reboot):

```bash
curl --fail --show-error http://127.0.0.1:7381/health
FACTORY_EVENT_PORT=7381 bun event-runtime/cli.mjs status
FACTORY_EVENT_PORT=7381 bun event-runtime/cli.mjs workers
launchctl print "gui/$(id -u)/com.wattmind.factory.event-serve"
launchctl print "gui/$(id -u)/com.wattmind.factory.event-work"
tail -f ~/Library/Logs/factory-event-{serve,work}.{out,err}.log
```

The `workers`/`status` output is the runtime view (registered workers and pool
liveness); `launchctl print` is the process-manager view. For the SSH
acceptance smoke, inject and approve a read-only `disk-diagnose@1` run for an
allowlisted host, then inspect its trace/receipt. The SSH command must succeed
**inside that daemon worker run**, not merely in the terminal that bootstrapped
it:

```bash
cat > /tmp/factory-daemon-ssh-smoke.json <<'EOF'
{
  "schemaVersion": "factory.event/v1",
  "eventId": "daemon-ssh-smoke-001",
  "type": "keephq.disk-alert.raised",
  "source": "replay-cli",
  "subject": "lab",
  "occurredAt": "2026-08-18T00:00:00Z",
  "correlationId": "daemon-ssh-smoke-001",
  "causationId": null,
  "payload": { "host": "lab", "mount": "/", "usedPct": 0, "alertId": "daemon-ssh-smoke-001" }
}
EOF
bun event-runtime/cli.mjs inject /tmp/factory-daemon-ssh-smoke.json
bun event-runtime/cli.mjs proposals            # note the disk-diagnose proposal id
bun event-runtime/cli.mjs approve <proposal-id>
bun event-runtime/cli.mjs runs                 # note the completed run id
bun event-runtime/cli.mjs inspect <run-id>     # receipt/evidence must contain the successful SSH probe
bun event-runtime/cli.mjs trace <run-id>
```

Use only a currently allowlisted host and retain the run ID as deployment
evidence. `disk-diagnose` may authenticate through the login keychain/agent or
the user's configured key file; the smoke proves what the daemon child can
actually use. A terminal-side `ssh ... true` is a useful preflight but is not
acceptance evidence.

For mutating dispatch runs, keep `gh` over HTTPS as the paved push route even
when the daemon has a working SSH context:

```bash
gh auth status
git remote set-url origin https://github.com/watt-mind/factory.git
git push -u origin HEAD
```

Record the push result in the dispatch run receipt/trace. Daemonization fixes
the process's full user context; it does not change the WM-128 rule that SSH
must not be the only way an unattended branch can be pushed.

Rollback (worker first) leaves manual foreground development fully supported:

```bash
launchctl bootout "gui/$(id -u)/com.wattmind.factory.event-work"
launchctl bootout "gui/$(id -u)/com.wattmind.factory.event-serve"
rm ~/Library/LaunchAgents/com.wattmind.factory.event-{serve,work}.plist

# Foreground/manual fallback:
bun event-runtime/cli.mjs serve
bun event-runtime/cli.mjs supervise --workers 1:2
```

Foreground processes launched from a sandboxed coding shell may still lack a
usable SSH agent; that is a shell limitation, not a runtime fallback guarantee.

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

**The worker reloads only when idle.** It stamps its own code at startup (HEAD plus a content hash of `event-runtime/lib/**` and `event-runtime/cli.mjs`, so uncommitted edits count) and re-checks that stamp _between claims_. On a change it exits `75` and the supervisor re-execs it. A run in flight keeps the old code to completion — logged as `reload deferred until <run> finishes` — and the reload happens at the next idle poll. Nothing can interrupt a running agent, which is the reason this is a poll-boundary check and not a file watcher.

**Which change needs which reload:**

| You changed                                     | What reloads it                                                                                                               |
| :---------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| `event-runtime/lib/**`, `event-runtime/cli.mjs` | serve restarts immediately (`bun --watch`, drops in-flight planner work); the worker restarts at its next idle poll           |
| `event-runtime/web/**`                          | vite HMR — the open tab updates, nothing restarts                                                                             |
| `agents/*.md`, `schemas/**`                     | **neither.** Definitions are read per plan/claim but their pinned hashes are not: run `bun event-runtime/cli.mjs update-pins` |
| `config/*.yaml`                                 | restart serve                                                                                                                 |
| `bin/live-stack.sh`                             | `factory down && factory up --dev`                                                                                            |

Details, including the `work --reload-on-change` flag and `FACTORY_CODE_STAMP_ROOT`, are in [event-runtime/README.md](event-runtime/README.md#dev-live-reload--factory-up---dev-wm-213).

## Known gaps

These are deliberate — the scaffold ships honest about what isn't built.

| Gap                       | Why it's not done                                                                                                                                                                                                                                                                                                                                                                       |
| :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A shared worktree library | Each repo still owns its own `bin/worktree-{up,down,warm}.sh`, and the common library stays deliberately deferred. The real variation across Wasp/Prisma/Postgres, pnpm/Nuxt/Prisma and Django/SQLite is visible now, but extracting it is real work with no forcing function yet — and a wrong abstraction here silently breaks the port and database isolation the scripts exist for. |
| `evals/run.mjs`           | Cases are written first on purpose — they specify what the skill is for.                                                                                                                                                                                                                                                                                                                |
| Per-agent Linear identity | Every agent currently claims as the human, so the assignee lock can't detect a lost race (OPS-40). The dispatcher is the natural place to inject a per-agent key — build it in rather than retrofitting.                                                                                                                                                                                |

## Flags worth knowing

Verified against Claude Code **2.1.220**: `--max-budget-usd`, `--allowedTools`, `--fallback-model`, `--output-format`, `--session-id`, `--resume`, and `setup-token` all exist. **`--max-turns` does not** appear in this version's help — the budget cap is the real bound; a turn cap will silently fail to apply.

Use `--output-format json` (not `stream-json`) for unattended runs: stream is for showing a human live progress, while the JSON envelope carries `session_id`, `total_cost_usd`, `num_turns`, and `subtype` — which is how budget accounting gets its input.

Branch on zero vs non-zero exit and read the structured output for the reason. A model refusal does not show up in the exit code at all; `subtype === "success"` is the truth.

Headless billing changed around mid-June 2026, past the reliable knowledge of the models that wrote this file — check current docs before sizing `budget.per_ticket_usd`.

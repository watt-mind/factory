---
title: First Real PR
description: Connecting Factory to GitHub Issues and dispatching real tasks
---

Once you have verified the offline demo, you can connect Factory to an external GitHub repository.

<iframe
  class="diagram-embed"
  src="/factory/diagrams/concept-guides.html#first-real-pr"
  title="First real pull request"
  loading="lazy"
></iframe>

## Prerequisites

1. Authenticate the GitHub CLI:
   ```bash
   gh auth login -h github.com
   ```
2. Ensure you have at least one coding agent harness installed (e.g. Claude Code, Gemini CLI, Cursor, or Codex).

## 1. Initialize Configuration

From your Factory clone:

```bash
bun install --frozen-lockfile
bun build/emit.mjs --link-bin
export PATH="$HOME/.local/bin:$PATH"

factory init --root "$PWD"
factory init --control-plane github --root "$PWD" --repo OWNER/REPO --team REPO
factory doctor
```

:::note[Automated label provisioning]
`factory init --control-plane github` creates the required protocol labels (such as `ai:agent-ready`, `ai:in-progress`, `type:*`, `priority:*`, and `source:*`). Existing labels are left untouched. The command checks the Projects v2 board but leaves board creation to you so it cannot create one under the wrong owner.
:::

## 2. Configure Projects Board

In GitHub, ensure your repository has a Projects v2 board named **Factory** with a single-select `Status` field containing these exact options:

```text
Triage, Todo, In Progress, In Review, Done, Blocked
```

## 3. Register Repository in `config/repos.yaml`

Add the repository configuration:

```yaml
repos:
  - name: sample
    path: ~/Develop/sample
    github: OWNER/REPO
    team: SAMPLE
    project: Factory
    control_plane: github
    base: develop
    worktree_up: bin/worktree-up.sh
    worktree_down: bin/worktree-down.sh
    worktree_root: ~/Develop/.worktrees/sample
    max_in_flight: 2
    verify: bun test && bun run lint
```

## 4. File an Agent-Ready Issue

Create a GitHub Issue in the `Todo` state with the label `ai:agent-ready` and an unassigned owner:

````markdown
### Problem & Context

Add a health-check endpoint to the API server.

### Acceptance Criteria

- [ ] `GET /health` returns `200 OK` with `{"status":"ok"}`.
- [ ] A regression test covers the endpoint.

### Source File Pointers

- `src/server.ts`
- `test/server.test.ts`

### Owned Paths

- src/server.ts
- test/server.test.ts

### Verification Command

```bash
bun test test/server.test.ts && bun run lint
```
````

## 5. Dispatch the Ticket

Ask Factory which stage is ready, then apply it using a harness installed on your machine:

```bash
factory next --repo sample
factory next --repo sample --apply --harness claude
```

`--repo` uses the repository's `name` from `config/repos.yaml`, not its `OWNER/REPO` slug.

Factory will:

1. Claim the issue and transition it to `In Progress` with `ai:in-progress`.
2. Provision an isolated worktree via `bin/worktree-up.sh`.
3. Invoke the coding agent inside its declared `Owned Paths`.
4. Re-run the verification command independently.
5. Push the branch and open a PR targeting your configured `base` branch.

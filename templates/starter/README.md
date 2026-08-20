# factory-starter

`factory-starter` is the forkable home for one Factory instance. It keeps your
organization's repository routing, policies, schedules, and optional packs
separate from the Factory kernel.

## Start an instance

1. Create a repository from this template and replace the example values in
   `config/` with your organization and repositories.
2. Validate the copied scaffold before configuring credentials or schedules:

   ```sh
   bun run check
   ```

3. Review the exact kernel commit in `package.json`, then install it when your
   environment can read the kernel's GitHub repository:

   ```sh
   bun install
   ```

4. Keep every schedule disabled while you verify repository credentials,
   worktree scripts, and the proposed workflow.

The committed kernel reference is deliberately an exact Git commit. Upgrades
are an explicit dependency change: review the Factory release or commit,
update `package.json`, run `bun install`, then run this instance's checks
before merging.

## What belongs here

- `config/repos.yaml` — this instance's repository registry and worktree facts
- `config/policy.yaml` — this instance's autonomy and safety policy
- `config/schedule.yaml` — disabled-by-default schedule declarations
- `packs/` — optional, namespaced data-only extensions for this instance

Do not edit the installed `node_modules/@watt-mind/factory` tree. If a feature
should benefit every instance, propose it upstream; see the kernel's
[`docs/instances.md`](node_modules/@watt-mind/factory/docs/instances.md).

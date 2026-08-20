# Factory instances

Factory is designed to be extended without becoming a long-lived fork. The
[`watt-mind/factory`](https://github.com/watt-mind/factory) repository is the
**kernel**: the event runtime, control-plane and forge contracts, verification
gates, harness packaging, and public extension interfaces. A **Factory
instance** is a separate repository that pins that kernel as a dependency and
contains one organization's operational choices.

Use the [`templates/starter/`](../templates/starter/) scaffold to create an
instance repository. Its `package.json` intentionally pins the kernel to an
exact commit, while the instance owns the files that should differ between
organizations:

| Kernel                                 | Instance                                                 |
| -------------------------------------- | -------------------------------------------------------- |
| Runtime, dispatch and merge mechanics  | `config/repos.yaml` repository routing                   |
| Safety floor and verification protocol | `config/policy.yaml` local autonomy policy               |
| Public pack and extension contracts    | `config/schedule.yaml` local, disabled-by-default clocks |
| Shared harness commands and skills     | `packs/` namespaced data-only additions                  |

This split is important: customizing an instance must not silently alter the
kernel that other instances use. Conversely, an instance must not need to
wait for an upstream release to change its repository list, policies, or
organization-specific packs.

## Create and configure an instance

1. Create a repository from `templates/starter/` and rename it for your
   organization (for example, `acme-factory`).
2. Replace the example repository, team, branch and verification values in
   `config/repos.yaml`. Leave a repository `report_only: true` until it has
   proven worktree lifecycle scripts.
3. Review `config/policy.yaml`; it is configuration, not a secret store.
   Inject credentials through the environment or the runtime's supported
   secret mechanism.
4. Keep `config/schedule.yaml` disabled until an operator has reviewed each
   loop's command and admission gate.
5. Run `bun run check`; it validates the template without fetching the kernel,
   so the starter's CI can check every pull request. When your environment can
   read the kernel repository, run `bun install`, commit the generated
   lockfile, and use the installed `factory` command.

Packs remain allow-listed: adding a directory beneath `packs/` does nothing
until `config/policy.yaml` explicitly enables it. See
[`kernel-and-packs.md`](kernel-and-packs.md) for pack layout and the admission
rules that protect the kernel namespace.

## Upgrade the kernel deliberately

The starter pins `@watt-mind/factory` to a Git commit rather than a floating
branch or range. That makes an upgrade a small, reviewable instance change:

1. Read the kernel release notes and migration guidance for the target commit
   or release.
2. Update the pinned dependency in the instance's `package.json` and refresh
   its lockfile with `bun install`.
3. Run the instance checks and inspect changes to local configuration or packs.
4. Merge the dependency update through the instance's normal review policy.

Never edit the installed dependency under `node_modules/`: it is regenerated
on install and creates an unreviewable fork. If an upgrade needs a local
configuration change, make that change in the instance in the same reviewed
pull request.

## Send reusable changes upstream

An instance is the right place for organization-specific routing, policies,
and packs. A change belongs upstream when it fixes or improves the kernel's
generic behavior, contracts, docs, harness floor, or reusable templates.

Before carrying a local workaround for a kernel limitation, open a proposal or
issue in `watt-mind/factory` that states the problem, affected instances, and
the intended contract. Once the approach is agreed, submit a focused pull
request against the kernel. After it merges, upgrade the instance's pin in its
own pull request.

This upstream path keeps improvements available to every instance while each
instance remains free to evolve its own configuration and packs.

## Validate the starter before publishing it

From the kernel checkout, run:

```sh
bun tools/publish-starter.mjs --dry-run
```

The command confirms the required scaffold files, checks that the kernel
dependency is an exact commit pin, and runs `npm pack --dry-run --json` to
show the package contents. It never publishes or writes files.

# Packs

A **pack** is the unit an adopter ships a loop in: pinned agents, schemas,
event types, edges, and schedules. A pack is a directory with `pack.json`.
It is allow-listed, never discovered by scanning the disk.

This file is the public directory of official first-party packs and of
community packs that have been listed here by pull request. It is an index,
not an installer and not a marketplace. Enabling a pack on a running factory
is still an operator choice in `config/policy.yaml` (or via an
[extension](docs/extensions.md)).

The format and admission rules live in
[`docs/kernel-and-packs.md`](docs/kernel-and-packs.md). The install unit that
can wrap a pack with adapters, config, hooks, and panels is documented in
[`docs/extensions.md`](docs/extensions.md).

## Official first-party packs

These are Watt Mind packs. They are the launch proof that the runtime is not
only a software factory. In-tree copies land under `packs/` with the pack
authoring kit (`factory pack init` / `validate`, and `docs/packs.md`).

| Pack            | Path                  | What it is                                                                                     |
| :-------------- | :-------------------- | :--------------------------------------------------------------------------------------------- |
| `example-hello` | `packs/example-hello` | Smallest valid first-party pack. A namespaced hello-world loop for authoring and admission.    |
| `ops-disk`      | `packs/ops-disk`      | First-party ops loop (disk / host operations). Proof that a shipped loop is not only software. |
| `editorial`     | `packs/editorial`     | First-party editorial loop (topic discovery, research, drafting, and review) backed by cells.  |

First-party packs follow the same loader rules as every other pack: a
non-empty namespace, content hashes in `pins.json`, no `mutating: true`
agents, and no override of kernel or earlier-pack content.

Until those directories exist in the tree, treat the rows as the reserved
names. Do not publish a community pack under either name.

## Community packs

Community packs are listed here so adopters can find them. A row in this
table is a directory entry, not an endorsement of safety, and not an
allow-list on anyone else's factory.

| Pack               | Publisher | Source | What it is |
| :----------------- | :-------- | :----- | :--------- |
| _None listed yet._ |           |        |            |

### Required fields

Every community row must include:

| Field          | Meaning                                                                  |
| :------------- | :----------------------------------------------------------------------- |
| **Pack**       | Pack `name` from `pack.json`, matching `^[a-z0-9-]+$`                    |
| **Publisher**  | Person or organization that maintains it                                 |
| **Source**     | Public repository URL (the pack root, or the extension that contains it) |
| **What it is** | One sentence: the loop it ships                                          |

The pack name must not collide with a first-party name (`example-hello`,
`ops-disk`) or with another listed community pack.

### How to list a community pack

1. Publish the pack in a public repository. It must load as a filesystem
   pack (`pack.json`, `pins.json`, agents, schemas) or as a pack contributed
   by a `factory-extension.json`. See
   [`docs/kernel-and-packs.md`](docs/kernel-and-packs.md) and
   [`docs/extensions.md`](docs/extensions.md).
2. Confirm it admits: non-empty namespace, pins match file bytes, no
   `mutating: true` agent, no attempt to own the kernel's bare namespace.
3. Fork this repository, branch from `develop`, and add **one new row** to
   the community table, sorted alphabetically by **Pack**.
4. Open a pull request titled `docs(packs): list <pack-name>`. Sign the CLA
   when asked ([CLA.md](CLA.md)). Follow
   [CONTRIBUTING.md](CONTRIBUTING.md).

A listing PR should touch only this file. Reviewers check that the source URL
resolves, that a `pack.json` (or extension manifest that contributes a pack)
is visible, and that the name does not collide.

Listing a pack here does **not**:

- add it to this repository's `config/policy.yaml`;
- grant it a mutating tier (that admission model is a later design);
- place it on a hosted marketplace (`ee/` / hosted, not this file).

If you want a first-party pack, or a pack vendored under `packs/` in this
repository, open an issue first. Do not send the pack tree in a listing PR.

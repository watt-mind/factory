# First-party packs

These reference packs are data-only, pinned examples for adopters. They are
allow-listed in `config/policy.example.yaml`; copy those entries deliberately
when enabling them in another Factory checkout.

| Pack            | Path                  | Purpose                                                                |
| --------------- | --------------------- | ---------------------------------------------------------------------- |
| `example-hello` | `packs/example-hello` | Smallest valid namespaced hello-world loop.                            |
| `ops-disk`      | `packs/ops-disk`      | Read-only disk-observation analysis loop; it never runs host commands. |

Validate either tree with `factory pack validate <path>` before adapting it.

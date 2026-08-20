# Instance packs

Put optional, data-only packs in this directory. Each pack needs its own
`pack.json`, pinned prompts and schemas, and a non-empty namespace. Enable a
pack explicitly from `config/policy.yaml`; Factory never discovers packs by
scanning this directory.

See the installed kernel's
[`docs/kernel-and-packs.md`](../../node_modules/@watt-mind/factory/docs/kernel-and-packs.md)
for the required layout and admission rules.

# Event runtime kernel and filesystem packs

The built-in `event-runtime/` tree is the kernel registry root. It owns the
single bare agent namespace, so its existing references (`dispatch@1`,
`ship-scan@1`, and so on) do not change. Optional filesystem packs extend that
registry; they do not replace or shadow built-in definitions.

## Enabling a pack

Packs are an explicit operator allowlist in `config/policy.yaml`. The runtime
never scans a directory for packs.

```yaml
packs:
  - name: dreaming
    path: packs/dreaming # relative to the factory checkout; absolute is allowed
    namespace: dreaming # optional here when pack.json declares it
```

An absent block and `packs: []` both load only the built-in root. Entries are
loaded after the built-in root and in policy order. Each entry accepts only
`name`, `path`, and optional `namespace`; malformed entries, duplicate names,
or unreadable pack content fail registry startup closed.

## Pack format

A filesystem pack has this layout:

```text
pack-root/
  pack.json
  pins.json
  agents/
    example.json
    example.md
  schemas/
    example.input.json
    example.output.json
  event-types.json  # optional object map
  edges.json        # optional object map
  schedules.json    # optional object map
```

`pack.json` is required:

```json
{
  "name": "dreaming",
  "version": "1.0.0",
  "namespace": "dreaming"
}
```

The manifest `name` must equal the policy entry. `version` is a required,
non-empty string. If policy and manifest both declare `namespace`, the values
must match. A configured pack must declare a namespace in one of those two
places.

The built-in root owns `namespace: ""`. Exactly one loaded root must own that
bare namespace. Therefore configured packs use non-empty namespaces and an
agent `example@1` from the pack above is registered as
`dreaming/example@1`. References in pack map files use the final registered
form. A pack event type may also route to a built-in agent or an agent from an
earlier pack because validation runs after the complete view is merged.

Duplicate final agent refs, event-type keys, edge source refs, or schedule loop
names are load errors that identify both contributing packs. A pack can never
override earlier content.

## Pins and permissions

`pins.json` maps every prompt and per-agent input/output schema path to the same
`sha256:` content hashes used by built-in definitions:

```json
{
  "agents/example.md": "sha256:...",
  "schemas/example.input.json": "sha256:...",
  "schemas/example.output.json": "sha256:..."
}
```

Normal pin maintenance remains deliberately built-in-only:

```sh
bun event-runtime/cli.mjs update-pins
```

Re-pinning third-party content requires naming the allowlisted pack, preserving
its tamper tripwire during routine maintenance:

```sh
bun event-runtime/cli.mjs update-pins --pack dreaming
```

Configured packs are read-only extensions and may not declare an agent with
`mutating: true`. The full kernel admission rules remain available only to the
built-in bare-namespace root.

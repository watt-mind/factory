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
    path: /opt/factory-packs/dreaming
    namespace: dreaming # optional here when pack.json declares it
```

An absent block and `packs: []` both load only the built-in root. Entries are
loaded after the built-in root and in policy order. Each entry accepts only
`name`, an absolute `path`, and optional `namespace`; relative paths are
rejected rather than resolved against the factory checkout. Malformed entries,
duplicate names, or unreadable pack content fail registry startup closed.

A pack can also arrive inside an **extension** — one directory whose
`factory-extension.json` lists its packs (and adapters) and is enabled with a
single `extensions:` entry instead of one `packs:` entry per pack. Extension
packs go through this same loader with the same rules below; the pack's name
and namespace come from its `pack.json`, and a pack the registry would refuse
skips that extension as a configuration anomaly rather than failing startup.
See [`extensions.md`](extensions.md).

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

## Harness content pins (WM-855)

A pack or extension may separately contribute _harness_ content —
skills, commands, and subagents materialized into a run's workspace rather
than registered as agents (`contributes.harness`, WM-849; see
[`extensions.md`](extensions.md)). That content is content-hash pinned the
same way prompts and schemas are: the same bare `update-pins` run that
re-pins built-in agent definitions also hashes every file under the built-in
`shared/` harness root and every policy-listed extension's declared
`contributes.harness` paths (floor doc, `commands/`, `skills/`,
`subagents/`), and writes them to one top-level
`event-runtime/pins.json` — a flat map from harness plugin name to its
`{ origin, name, version, files }` pin record:

```json
{
  "core": {
    "origin": "builtin",
    "name": "factory/core",
    "version": "0.1.0",
    "files": {
      "floor.md": "sha256:...",
      "commands/factory-audit.md": "sha256:..."
    }
  }
}
```

`event-runtime/lib/pins.mjs` owns the hashing/update/validate logic
(`hashHarnessRoots`, `updateHarnessPins`, `verifyHarnessPins`); `loadRegistry`
validates a supplied `harnessRoots` array against this file at load time,
failing closed exactly like the per-agent pin check, on either an unpinned
file or content that has drifted from its pin.

Adding or removing any file under `shared/` requires re-running
`bun event-runtime/cli.mjs update-pins`. The repository verification gate
enforces that the committed harness pins remain current:

```sh
bun event-runtime/cli.mjs update-pins --check
```

Wiring live `harnessRoots` into the running server's `loadRegistry({ ... })`
call (`event-runtime/cli/serve.mjs`, `event-runtime/cli/work.mjs`), recording
the per-run materialized-harness content hash on `RunSpec`/execution
receipts, and surfacing harness pins on the Web UI's Run detail view are
tracked as follow-up work, outside this ticket's owned paths.

## Floor delivery

`shared/floor.md` is spliced into each repository's committed `AGENTS.md`.
After every edit to that source, run `bun build/emit.mjs --sync-floor` and
commit the regenerated `AGENTS.md` for the repository being changed. The
factory verification gate rejects a stale floor splice in its own checkout;
reports about configured sibling checkouts remain informational.

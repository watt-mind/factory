# Authoring filesystem packs

A **pack** is the data-only unit that adds an agentic loop to Factory. It can
contain pinned prompts and schemas plus declarative event routing, edges, and
schedules. A pack is not discovered by the runtime: an operator must
allow-list its exact path in `config/policy.yaml` before it can load.

This guide is for pack authors. For the kernel's complete admission rules, see
[kernel and packs](kernel-and-packs.md); an installable extension that also
contains code, adapters, hooks, or panels is documented in
[extensions](extensions.md).

## Start a pack

From a Factory checkout, scaffold a minimal, valid pack:

```sh
factory pack init my-loop
# creates packs/my-loop

# Or choose an explicit destination:
factory pack init my-loop ~/src/my-loop
```

Names use lowercase letters, digits, and hyphens and begin with a letter. The
scaffold is intentionally complete: it has one read-only `hello` agent, its
input/output schemas, a routed event type, and a `pins.json` matching all
pinned content. Validate it before committing:

```sh
factory pack validate packs/my-loop
```

`validate` loads the candidate with the same registry loader the runtime uses.
It checks the manifest, pinned prompt/schema bytes, agent definitions,
namespaces, routing maps, event references, edges, schedules, and the merged
registry invariants. It does not edit `policy.yaml`, execute pack code, or scan
neighbouring directories.

## Layout

```text
my-loop/
  pack.json
  pins.json
  agents/
    hello.json
    hello.md
  schemas/
    hello.input.json
    hello.output.json
  event-types.json             # optional object map
  edges.json                   # optional object map
  schedules.json               # optional object map
```

`pack.json` is required. Its `name` must match the operator's policy entry;
`version` is a non-empty release string; and `namespace` is a non-empty value
that keeps the pack's agent references separate from the kernel and other
packs.

```json
{
  "name": "my-loop",
  "version": "0.1.0",
  "namespace": "my-loop"
}
```

An agent with `id: "hello"` and `version: 1` in this pack is registered as
`my-loop/hello@1`. A pack may route an event to a built-in agent or one from an
earlier allow-listed pack, but may not shadow any existing agent, event type,
edge source, or schedule loop.

## Pins and schemas

Each agent names a prompt plus input and output JSON Schema files. Every one
of those files must be listed in `pins.json` with a `sha256:` content hash.
The registry refuses missing or stale pins, so bump the pack version and
regenerate the relevant hashes whenever a pinned file changes.

```json
{
  "agents/hello.md": "sha256:...",
  "schemas/hello.input.json": "sha256:...",
  "schemas/hello.output.json": "sha256:..."
}
```

Keep schemas closed where practical (`additionalProperties: false`) and make
the agent's declared capabilities, workspace, and limits match the work it
actually needs. The first-party packs under [`../packs`](../packs) are runnable
reference trees.

## Events, edges, and schedules

`event-types.json` maps external event names to a registered agent and supplies
a non-empty idempotency scope. An event mapping may also name its adapter and
proposal TTL. Example:

```json
{
  "my-loop.hello.requested": {
    "agent": "my-loop/hello@1",
    "adapter": "fake",
    "idempotencyScope": ["correlationId"]
  }
}
```

`edges.json` is optional declarative follow-up routing. Its keys are registered
source agent refs; each edge targets an event type that exists in the fully
merged registry. `schedules.json` is optional declarative recurring input.
Each loop has a valid cadence, an existing event type, an approval mode, and
an explicit enabled state. Start new schedules disabled and watched until the
operator has reviewed their effect.

## Data-only constraints and lifecycle

Packs contain JSON and prose only. They cannot ship executable adapters, hooks,
connectors, or panels with arbitrary code, and configured packs may never
declare `mutating: true`. A pack can recommend or describe work; the Factory's
normal proposal and approval lifecycle decides whether any work runs. Put code
in an operator-installed extension only when that trust boundary is appropriate.

To publish a loop: author and validate the pack, commit it, request an
operator allow-list entry, then restart the runtime so it reads the configured
path. Removal is the inverse: remove the allow-list entry and restart. Dropping
a directory on disk alone never enables it.

## First-party references

- [`packs/example-hello`](../packs/example-hello) is the smallest complete
  hello-world pack.
- [`packs/ops-disk`](../packs/ops-disk) demonstrates a non-destructive
  operations observation loop; it analyzes supplied disk telemetry and does
  not execute commands or modify hosts.

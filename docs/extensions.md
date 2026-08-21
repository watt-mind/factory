# Extensions

_Author guide for the malleable-factory epic (WM-834). This page is the one
reference for everything an extension can contribute; each follow-up ticket
appends its section here rather than opening a new document._

An **extension** is one directory with one manifest, `factory-extension.json`,
that declares everything the directory contributes to a running factory. It
is the unit an operator installs and enables — "the mobile pack + the argent
adapter" is one extension, enabled with one line, not two things installed two
ways.

Today an extension can contribute:

- **packs** — agent definitions, schemas, prompts, event types, edges and
  schedules, in the filesystem pack format of
  [`kernel-and-packs.md`](kernel-and-packs.md); they go through the same pack
  loader with the same namespace, duplicate, pin and `mutating` rules;
- **adapters** — harness adapters satisfying the contract in
  [`event-runtime-workers.md` §2c](event-runtime-workers.md#2c-adapter-registry-and-contract--shipped-wm-837);
  they are registered into the adapter registry with the extension's name as
  their `source`;
- **config** — a JSON-schema for the extension's operator settings, validated
  at load with defaults applied and shown read-only in `GET /config` and
  Settings (§Config below);
- **hooks** — decision-returning modules run at a named point of the runtime,
  today `approve.before` (immediately before each chain auto-approval); a
  fail-closed waterfall whose every decision is persisted (§Hooks below);
- **connectors** — long-running processes the runtime starts with `serve`
  and stops on shutdown; they talk to the outside world (Buzz, Telegram, a
  tracker) through a narrow loopback client and never hold a DB handle
  (§Connectors below);
- **panels** — declarative `factory.panel-view/v1` Overview tiles
  ([`event-runtime-artifact-views.md` §2.6](event-runtime-artifact-views.md#26-panels--factorypanel-viewv1-wm-840));
  data only, drawn by the web's existing artifact-view renderer, bound to an
  allow-listed loopback API endpoint (§Panels below);
- **harness** — floor markdown, slash commands, skills and subagents that
  `build/emit.mjs` packages for Claude Code, Codex, Gemini, Cursor and Pi
  (§Harness below). `shared/` is the built-in `factory/core` pack.

The manifest also **reserves** `views` for the ticket that lands it. A
manifest that carries a reserved key loads its packs, adapters, connectors
and the rest and records a
"not supported yet" configuration anomaly for the rest — it is accepted, not
rejected, so an extension written for a later runtime still does what this one
understands.

Implementation: `event-runtime/lib/extensions.mjs`, schema
`event-runtime/schemas/factory-extension.schema.json`, fixture
`event-runtime/test-support/extensions/sample/`.

## Layout

```text
~/.factory/extensions/wattmind-mobile/
  factory-extension.json      # the manifest — required
  pack/                       # a filesystem pack (pack.json, pins.json, agents/, schemas/, …)
  adapters/
    argent.mjs                # an adapter module (execute + SANDBOX_SUPPORT)
  hooks/
    no-infra-merges.mjs       # an approve.before hook (id + default (ctx) => decision) (§Hooks)
  connectors/
    buzz.mjs                  # a connector (id + default start(ctx) => { stop, health }) (§Connectors)
  config.schema.json          # the shape of the extension's operator config (§Config)
  panels/
    blocked-tickets.panel.json  # a factory.panel-view/v1 panel
  harness/
    floor.md                    # optional AGENTS.md floor block
    commands/                   # slash-command markdown
    skills/                     # skill folders (SKILL.md)
    agents/                     # custom-agent markdown (manifest key: subagents)
```

Nothing about the layout is fixed except the manifest's name and place: every
contributed path is written in the manifest, relative to the manifest's
directory, and must stay inside it.

## Manifest reference

```json
{
  "name": "wattmind/mobile",
  "version": "1.0.0",
  "description": "Mobile packs and the argent adapter",
  "factory": { "min": "0.x" },
  "contributes": {
    "packs": ["./pack"],
    "adapters": { "argent": "./adapters/argent.mjs" },
    "config": { "namespace": "mobile", "schema": "./config.schema.json" },
    "hooks": { "approve.before": "./hooks/no-infra-merges.mjs" },
    "connectors": { "buzz": "./connectors/buzz.mjs" },
    "panels": ["./panels"],
    "harness": {
      "floor": "./harness/floor.md",
      "commands": "./harness/commands",
      "skills": "./harness/skills",
      "subagents": "./harness/agents"
    }
  }
}
```

| Key                      | Required | Meaning                                                                                                                                                                                                                                                      |
| :----------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | yes      | `publisher/extension`, matching `^[a-z0-9-]+/[a-z0-9-]+$`. Recorded as the `source` of every adapter the extension registers, so `bun event-runtime/cli.mjs adapters` can say where an adapter came from.                                                    |
| `version`                | yes      | Semver (`MAJOR.MINOR.PATCH`, optional pre-release/build).                                                                                                                                                                                                    |
| `description`            | no       | Up to 200 characters, for listings.                                                                                                                                                                                                                          |
| `factory.min`            | no       | The oldest factory the extension was written for. Informational until the runtime carries a version; the loader records it and does not enforce it.                                                                                                          |
| `contributes.packs`      | no       | Array of relative directories, each containing a `pack.json`. The pack's `name` and `namespace` come from its own `pack.json` (`docs/kernel-and-packs.md` § Pack format) — the policy entry names the extension, not the pack.                               |
| `contributes.adapters`   | no       | Object `name → relative .mjs path`. Names must match the adapter pattern `^[a-z][a-z0-9-]*$`; the module must export `execute` and `SANDBOX_SUPPORT`. An extension may not replace an existing adapter (built-in or from an earlier extension).              |
| `contributes.config`     | no       | Object `{ namespace, schema }`: the name the extension's operator values are published under (`^[a-z][a-z0-9-]*$`, unique across loaded extensions) and the relative path of the JSON-schema those values must satisfy. See § Config.                        |
| `contributes.hooks`      | no       | Object `hook point → relative .mjs path`. The only point today is `approve.before`; an unknown key is a schema violation. The module must export a string `id` and a default `(ctx) => decision` function. See § Hooks.                                      |
| `contributes.connectors` | no       | Object `name → relative .mjs path`. Names match the adapter pattern `^[a-z][a-z0-9-]*$`; the module must export a string `id` and a default `start(ctx) → { stop, health }`. See § Connectors.                                                               |
| `contributes.panels`     | no       | Array of relative directories; every `*.panel.json` directly inside is a `factory.panel-view/v1` panel (§Panels). The manifest check proves the directories exist inside the extension; the registry validates each panel at load and skips a bad one alone. |
| `contributes.harness`    | no       | Object `{ floor?, commands?, skills?, subagents? }`: relative file/directory of harness-neutral markdown emit packages (§Harness). The built-in pack is `shared/` (`factory/core`).                                                                          |
| `contributes.views`      | no       | **Reserved.** Accepted by the schema, ignored by the loader, reported as a configuration anomaly `contributes.views is not supported yet`.                                                                                                                   |

Unknown top-level keys and unknown `contributes` keys are schema violations.
Validate a manifest without loading anything:

```sh
bun event-runtime/cli.mjs extensions validate ~/.factory/extensions/wattmind-mobile
bun event-runtime/cli.mjs extensions validate @watt-mind/factory-ext-buzz
# wattmind/mobile@1.0.0: valid (1 pack, 1 adapter)
```

`validate` checks the schema, that every contributed path exists and stays
inside the extension directory, and that adapter names, connector names and
hook points are well-formed. It does not load a pack, import an adapter,
hook or connector module, or read a panel document — running third-party
code is what enabling does, and panel documents are validated by the registry
at load (an invalid one is a `/status` anomaly).

## Trust model

There are two kinds of contribution, and the difference is what runs.

- **Data-only packs, panels and harness markdown.** A pack is JSON and prose:
  definitions, schemas, prompts, routing maps. A panel is JSON too — an
  endpoint the runtime already serves, a pointer and rendering hints; the
  web loads no code for it and fetches only endpoints the runtime
  allow-lists. Harness content is markdown (floor, commands, skills,
  subagents) that `build/emit.mjs` packages; loading it executes nothing.
  The kernel then holds packs to the configured-pack rules — its own
  namespace, no shadowing of built-ins, pinned prompts and schemas, no
  `mutating: true` — so a pack can add agents but cannot widen what an
  agent may do. This is the surface an _agent_ may author (a dispatched
  ticket producing a pack or a harness command is ordinary data), and it
  is why the fixture pack is a copy of `test-support/packs/sample`.
- **Operator-installed code.** An adapter is an ES module the worker imports
  and calls; a hook is an ES module `serve` imports and calls inside the
  approval pass; a connector is an ES module `serve` starts after the
  registry loads and stops on shutdown. Enabling an extension that contributes
  any of them is running that code in the runtime process with its credentials.
  Only the operator
  enables extensions — by editing `config/policy.yaml`, a committed file —
  and nothing an agent does at runtime can add one. The registry still puts
  every adapter behind the sandbox seam (an `unsupported` adapter is refused
  for a sandboxed definition before its code runs, WM-313/WM-837), and it
  refuses a module that does not satisfy the contract at load time rather
  than mid-run. A connector that fails `start()` is the one exception to
  all-or-nothing: that connector is disabled with a configuration anomaly and
  the extension's other contributions stay loaded.

Two rules follow. Discovery is **allow-listed, never scanned**: the loader reads
only the `path:` directories and `package:` names `policy.yaml` lists, in that
order — dropping a directory into `~/.factory/extensions/` or installing an
npm package does nothing on its own. And a broken extension is
a **configuration anomaly, not a crash**: a missing or malformed manifest, a
pack the registry would refuse, or an adapter that fails the contract skips
that extension whole (nothing of it is registered, not even its good parts),
records why under `/status.anomalies.configuration` (visible in `doctor`, the
web UI's status, and `extensions list`), and lets every other extension load.
`serve` and `work` never fail to start because of a third-party manifest.
The one thing that does fail closed is a malformed `extensions:` block itself
— an operator typo in the allowlist, exactly like `packs:`.

## Enabling an extension

Add it to `config/policy.yaml` — either a directory (`path:`) or an installed
npm package (`package:`). Both on one entry, or neither, is a configuration
anomaly and the entry is skipped. Nothing is auto-discovered from
`node_modules`.

```yaml
extensions:
  - package: @watt-mind/factory-ext-buzz # resolved from the factory root's node_modules
  - path: ~/.factory/extensions/wattmind-mobile # must contain factory-extension.json
    config: # optional; the shape is the extension's config schema (§Config)
      simulator: iPhone-16
      maxParallel: 2
  - path: vendor/another-extension # relative paths resolve from the factory checkout
```

Each entry accepts **either** `path` (`~` expands to the home directory) **or**
`package` (`@scope/name` or `name`, resolved with `createRequire` from the
factory root) and an optional `config` object. `version` on a `package:` entry
is display-only — the loader records the installed `package.json` version, it
does not pin or fetch. Anything else is an anomaly and the entry is skipped.
A `package:` that is not installed is an anomaly naming the `npm i` command,
never a crash. Entries load after the built-in root and after every `packs:`
entry, in policy order: `packRoots` handed to the registry is `packs:` first,
then each accepted extension's packs. Restart `serve` and the workers —
extensions are read at startup, alongside the registry.

Loaded rows (`extensions list --json`, and the loader snapshot `/config`
reads) carry `source: "path"` or `source: "package"`, the resolved directory,
and for packages the installed version. A `node_modules` symlink is realpath'd
before the inside-the-dir check, so a contributed path cannot escape through
a linked package.

Inspect what loaded:

```sh
bun event-runtime/cli.mjs extensions list          # name, version, pack/adapter counts, path; anomalies on stderr
bun event-runtime/cli.mjs extensions list --json   # { extensions, anomalies }
bun event-runtime/cli.mjs adapters                 # extension adapters appear with SOURCE = the extension name
```

An extension pack that duplicates a configured pack's name, or whose agents
collide with an already-loaded namespace, is refused with the registry's own
message naming both packs; fix the pack (or the order) and restart.

## Writing one

1. Create the directory and `factory-extension.json`; pick a `name` under your
   publisher prefix.
2. Add packs in the pack format (`kernel-and-packs.md`), each under its own
   `pack.json` with a non-empty `namespace`, and write its `pins.json`
   (`sha256:` of each prompt and schema, `kernel-and-packs.md` § Pins).
   `update-pins --pack <name>` reaches only `policy.yaml packs:` entries
   today; extension packs are pinned by hand until that command learns
   about extensions.
3. Add adapters as `.mjs` modules exporting `execute` and `SANDBOX_SUPPORT`;
   the smallest conformant module is
   `event-runtime/test-support/extensions/sample/adapters/echo.mjs`.
4. If the extension needs operator settings, write `config.schema.json` and
   declare `contributes.config` (§Config); give every setting a `default`
   where one makes sense.
5. If the extension gates unattended work, add an `approve.before` hook
   (§Hooks); the smallest conformant module is
   `event-runtime/test-support/extensions/sample/hooks/approve-before.mjs`.
6. If the extension talks to an external system (Buzz, a tracker, a
   notifier), add a connector (§Connectors); the smallest conformant module
   is `event-runtime/test-support/extensions/sample/connectors/echo.mjs`.
7. Add panels as `panels/<slug>.panel.json` (§Panels); the fixture's
   `panels/open-proposals.panel.json` is a complete one.
8. Add harness content as `contributes.harness` (§Harness) when the
   extension ships slash commands, skills, subagents or a floor block.
9. `bun event-runtime/cli.mjs extensions validate <dir>` until it is clean,
   enable it, `extensions list`, restart.

The fixture `event-runtime/test-support/extensions/sample/` is a complete,
loadable example, and `event-runtime/lib/extensions.test.mjs` shows every
failure mode and what the anomaly for it says.

## Panels

`contributes.panels` lists directories, relative to the manifest, whose
`*.panel.json` files are `factory.panel-view/v1` panels — declarative
Overview tiles bound to one allow-listed loopback API endpoint and drawn by
the web's artifact-view renderer. The full format, the endpoint allow-list
and the rendering rules are in
[`event-runtime-artifact-views.md` §2.6](event-runtime-artifact-views.md#26-panels--factorypanel-viewv1-wm-840);
what is specific to extensions:

```json
{
  "format": "factory.panel-view/v1",
  "name": "wattmind/mobile:blocked-tickets",
  "title": "Blocked > 24h",
  "source": {
    "endpoint": "/tickets",
    "query": { "state": "blocked" },
    "path": "/tickets"
  },
  "refreshSeconds": 60,
  "view": {
    "sections": [
      {
        "path": "",
        "as": "table",
        "columns": ["identifier", "title"],
        "formats": { "identifier": "issue" }
      }
    ]
  }
}
```

- **Names** are `<publisher>/<extension>:<slug>` — the extension's own name
  as prefix — and must be unique across built-ins, packs and every extension;
  a clash is a configuration anomaly for the later contributor and the earlier
  panel stays.
- **Origin.** `GET /panels` reports each of these with
  `origin: "extension:<name>"`, and the tile shows that origin under its title.
- **Order.** Extension panel directories load after every pack (built-in and
  `packs:`), in policy order, into the same registry list.
- **Failure.** A panel that does not validate — bad schema, an endpoint that
  is not allow-listed, a `view` the artifact-view vocabulary rejects,
  unparseable JSON — is skipped alone with a `/status.anomalies.configuration`
  line naming the file; the extension's other panels, packs and adapters still
  load. A directory that is missing or escapes the extension is a manifest
  error and skips the extension whole, like any other bad path.
- **Panels inside packs.** A pack an extension contributes may also carry
  `panels/*.panel.json`; those load with the pack (origin `pack:<namespace>`),
  no manifest key needed. Use `contributes.panels` for tiles that belong to
  the extension rather than to one pack.

Implementation: `event-runtime/lib/panel-view.mjs` (validation and
directory loading), `lib/registry.mjs` (`loadRegistry({ panelRoots })`),
`lib/api-panels.mjs` (`GET /panels`, `PANEL_ENDPOINTS`),
`web/src/components/PanelGrid.tsx`.

## Config

_Shipped in WM-841. Implementation: `resolveExtensionConfig`,
`applyConfigDefaults`, `getExtensionConfig` and `loadedExtensions` in
`event-runtime/lib/extensions.mjs`; the `extensions` section of
`event-runtime/lib/api-config.mjs`; the Extensions section of
`web/src/views/Settings.tsx`; fixture
`event-runtime/test-support/extensions/sample/config.schema.json`._

An extension that needs operator-provided settings — API hosts, allow-lists,
thresholds — declares their **shape** in the manifest and the operator writes
the **values** in `policy.yaml`. Neither side is trusted on its own: the loader
checks the values against the shape before any of the extension's code runs.

Manifest:

```json
"contributes": {
  "config": { "namespace": "mobile", "schema": "./config.schema.json" }
}
```

Schema (`config.schema.json`, relative to the manifest and inside its
directory):

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "simulator": {
      "type": "string",
      "title": "Simulator",
      "default": "iPhone-16",
      "description": "booted before each run"
    },
    "maxParallel": {
      "type": "integer",
      "title": "Max parallel",
      "minimum": 1,
      "maximum": 4,
      "default": 1
    },
    "apiToken": {
      "type": "string",
      "format": "secret",
      "title": "API token",
      "description": "resolved from FACTORY_EXT_MOBILE_API_TOKEN"
    }
  }
}
```

Values (`config/policy.yaml`) — non-secret settings only:

```yaml
extensions:
  - path: ~/.factory/extensions/wattmind-mobile
    config:
      maxParallel: 2
```

Secrets are **not** written in `policy.yaml`. A property with
`format: "secret"` is resolved from `process.env.FACTORY_EXT_<NAMESPACE>_<KEY>`
(upper-snake of the config namespace and property path) or, if that is unset,
from `~/.factory/secrets.env` (dotenv, mode `0600`, loaded once at start;
`FACTORY_EVENT_SECRETS_FILE` overrides the path). A secret given in
`policy.yaml` is a configuration anomaly: the extension is disabled and the
message names the key and the env var to use.

```bash
# ~/.factory/secrets.env (chmod 600)
FACTORY_EXT_MOBILE_API_TOKEN=…
```

What the loader does with them, in order:

1. **Reads the schema.** It must be a file inside the extension directory
   (`extensions validate` checks this too) and valid JSON. The keyword subset
   is `event-runtime/lib/schema.mjs`'s — `type`, `enum`, `const`, `required`,
   `properties`, `additionalProperties`, `items`, `min/max*`, `pattern`,
   `description`, `title`, `format` — plus `default`. `format` is a closed
   enum: `secret`, `uri`, `channel-id`, `ticket`, `duration`, `multiline`,
   `email`. Unknown keywords and unknown `format` values fail closed like
   every other contract in the runtime. `format` is a UI hint except `uri`
   (the string must parse as a URI) and `duration` (`^\d+(ms|s|m|h|d)$`).
2. **Applies defaults.** Every `default` under `properties`, recursively, is
   filled in where the operator gave nothing; a nested object property is only
   created when a default inside it produces something. With no `config:` in
   the policy at all the effective object is _just_ the defaults, so an
   extension whose every setting has a default needs no operator input.
   `format: "secret"` properties never take a default from the schema or a
   value from `policy.yaml`.
3. **Resolves secrets.** Each `format: "secret"` property is filled from
   `FACTORY_EXT_<NAMESPACE>_<KEY>` as above. The extension's own code sees
   the resolved string via `getExtensionConfig()`.
4. **Validates the effective object** with `schema.mjs validate`. A violation
   is a configuration anomaly that **disables the extension whole** — nothing
   of it is registered, its adapters are not even imported — with a message
   naming the failing path:

   ```text
   extension ~/.factory/extensions/wattmind-mobile: wattmind/mobile@1.0.0: config does not match ./config.schema.json — $.maxParallel: above maximum 4 (extension skipped)
   ```

   Two more faults are treated the same way: policy `config:` values for an
   extension whose manifest declares no `contributes.config` (the values would
   silently do nothing otherwise), and a `namespace` another loaded extension
   already uses.

The extension's own code reads the result by name:

```js
import { getExtensionConfig } from "../../lib/extensions.mjs";
const cfg = getExtensionConfig("wattmind/mobile");
// { simulator: "iPhone-16", maxParallel: 2, apiToken: "…" }
```

`getExtensionConfig` returns the effective object — defaults applied,
validated — or `undefined` when no extension of that name loaded (unknown, or
disabled by an anomaly). It reads the last `loadExtensions` run in the process,
which `serve` and `work` do once at start; a config change is a **restart**.

### In `/config` and Settings

`GET /config` gains a section `{ id: "extensions", reload: "restart" }` with
one item per extension the loader saw:

```json
{ "name": "wattmind/mobile", "version": "1.0.0", "path": "…", "namespace": "mobile",
  "reload": "restart", "schema": { … }, "values": { "simulator": "iPhone-16", "maxParallel": 2, "apiToken": { "set": true, "source": "env" } },
  "anomaly": null }
```

A disabled extension appears with `values: null` and its `anomaly`; an
extension that declares no config appears with `namespace: null`. The
section's `entries` mirror the same rows (key = namespace) so the Settings
search covers them. Settings renders it as the **Extensions** section — name,
namespace, version, path, a read-only `SchemaForm` of the effective values
(`title` = label, `description` = help, `format` = widget, `enum` / `type` /
`minimum` / `maximum` / `default` drive the control), a collapsed copy of the
schema, and the anomaly in place of the form when the extension is disabled.
Search also indexes every property's `title` and `description`. Read-only,
like every other Settings section: values change in `policy.yaml` or env,
then restart. Built-in sections (Policy, Nodes, …) should migrate onto the
same schema shape — [WM-924](https://linear.app/watt-mind/issue/WM-924).

**UI hints.** `title` is the field label (the property name is the fallback),
`description` is help text, `format` selects the widget:

| `format`     | Widget (read-only)                                      |
| :----------- | :------------------------------------------------------ |
| `secret`     | "set via env `FACTORY_EXT_…`" / "unset" — never a value |
| `uri`        | link                                                    |
| `channel-id` | mono chip                                               |
| `ticket`     | mono chip with `TicketHoverCard`                        |
| `duration`   | humanised (`30s` → "30 seconds")                        |
| `multiline`  | `<pre>`                                                 |
| `email`      | text                                                    |

Booleans render as a disabled toggle, enums as a disabled select, integers
with bounds as the number plus a range hint. A value equal to `default` is
marked.

**Redaction rule.** `format: "secret"` properties publish
`{ set: true|false, source: "env"|"secrets.env"|null }` instead of a value.
For schemas that predate `format`, every remaining value whose key matches
`/token|secret|key|password/i` — at any depth of the effective object — is
replaced by `"[redacted]"` (`redactSecrets` in `lib/api-config.mjs`). Empty
and `null` values are left as they are so "unset" stays visible. The schema
is published as written; do not put a real secret in a `default`.

## Hooks

_Shipped in WM-842. Implementation: `event-runtime/lib/hooks.mjs`
(`createHookRegistry`, `defaultHookRegistry`, `hookDecisionsFor`,
`hookDecisionCounts`), the built-in
`event-runtime/lib/hooks/builtin/escalation-labels.mjs`, the call site in
`event-runtime/lib/auto-approval.mjs` (`autoApproveChains` → `eligible` →
`dispatchSafe`), fixture `event-runtime/test-support/extensions/sample/hooks/`._

The policy that gates unattended work — budget, worker cap, circuit breaker,
escalated/security labels, escalate-path intersections — lives in
`lib/auto-approval.mjs`. A **hook** is how an operator adds a gate of their
own ("never auto-approve merges touching `infra/`", "cap spend per repo")
without forking that file: a module the extension declares, imported by the
loader, asked for a decision at a named point. This is a hook seam in the
pi/deepseek-harness sense — typed, decision-returning interception — with the
factory's constraints on top: hooks are **declared in a manifest** (operator-
installed, in-process, never agent-authored), run as a **waterfall**, and
**every decision is persisted** so the audit trail stays complete.

One point exists today:

| Point            | Evaluated                                                                                                                                                                                                                                                                                                                                                                                                 | Deny becomes                                                                                                                                                                   |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve.before` | In `autoApproveChains`, immediately before each chain auto-approval, once the proposal has passed every structural check (predecessor, integrity, schema, policy allow-list) — for a dispatch, right after the recheck evidence hash is confirmed and before the escalate-path check; for every other event type, at the end of eligibility. The runtime guard (budget/cap/breaker) runs after the hooks. | The proposal stays open with reason `auto_approval_ineligible:dispatch_ineligible:<reason>` (dispatch events) or `auto_approval_ineligible:hook_denied:<reason>` (all others). |

`plan.before`, `execute.before`, `verify.after` and `outbox.before` are
roadmap; declaring one is a schema violation until its ticket lands.

### Contract

```js
// contributes.hooks: { "approve.before": "./hooks/no-infra-merges.mjs" }
export const id = "wattmind/mobile:no-infra-merges"; // publisher[/extension]:name, unique across loaded hooks

export default async function approveBefore(ctx) {
  // ctx: { proposal, spec, evidence, policy, repo, now, config }
  const touched =
    ctx.spec?.input?.plan?.flatMap((item) => item.paths ?? []) ?? [];
  if (touched.some((p) => p.startsWith("infra/")))
    return { decision: "deny", reason: "infra_paths_touched" };
  return { decision: "allow" };
}
```

| `ctx` field | What it is                                                                                                                                                                                                 |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposal`  | `{ id, runId, eventSource, eventId, eventType, createdAt, ttlSeconds }` of the proposal about to be approved.                                                                                              |
| `spec`      | The proposal's immutable RunSpec (`agent`, `input`, `approvalPolicy`, …), parsed.                                                                                                                          |
| `evidence`  | For `factory.dispatch.requested`: the dispatch recheck evidence (`ticket.labels`, `escalatePathIntersections`, …) — the same object the built-in label check reads. `null` for every other event type.     |
| `policy`    | `spec.approvalPolicy` — `{ source: "chain", mode: "auto", eventType, … }`.                                                                                                                                 |
| `repo`      | `spec.input.repo`, or `null`.                                                                                                                                                                              |
| `now`       | The pass's clock (ms since epoch); use it instead of `Date.now()` so replays stay deterministic.                                                                                                           |
| `config`    | The extension's effective config — `getExtensionConfig(<manifest name>)`, defaults applied, validated at load (§Config). `undefined` for a built-in hook. Read settings from here, not from `policy.yaml`. |

The hook receives a **deep copy** of the context; mutating it changes nothing
downstream. The function may be sync or async. Its return value must be
exactly `{ decision: "allow" }` or `{ decision: "deny", reason }` where
`reason` is a short token (`[A-Za-z0-9_.:/-]{1,120}`) — it is embedded in the
proposal's reason string and shown in the UI, so keep it greppable
(`infra_paths_touched`, not a sentence).

### Semantics

- **Waterfall, built-ins first.** For a point, the runtime's own hooks run
  first (in the order the runtime registers them), then extension hooks in
  `policy.yaml extensions:` order. The first `deny` ends the run; the hooks
  after it are not called. An `allow` from every hook is an allow.
- **Fail closed.** A hook that throws, rejects, returns anything other than a
  well-formed decision, or does not answer within **`timeoutMs` (2000 ms)**
  is a `deny` with reason `hook_error:<id>` — the proposal stays open, never
  approved. A synchronous hook cannot be interrupted, so one that overruns the
  budget is still denied once it returns; write long checks async. Nothing a
  hook does — throw, hang, return garbage — can widen what would have been
  approved without it.
- **Registration is all-or-nothing per extension.** Each hook module is
  imported and contract-checked (`default` function, string `id`) before the
  extension is accepted; a module that fails, or an `id` another loaded hook
  (built-in or extension) already uses, is a configuration anomaly that
  disables the extension whole — like a bad adapter. Hooks are registered
  only once the whole extension is known good, with `source:
extension:<name>`. Every `loadExtensions` run replaces the previous run's
  extension hooks, so a removed extension's hook cannot linger past a restart.
- **A hook can only refuse.** There is no `allow` that overrides a built-in
  deny, no reordering, no replacing the built-in hooks. The built-in
  escalation-label refusal (`factory:escalation-labels`) is the first hook of
  `approve.before` and behaves exactly as the inline check did before this
  seam existed: `ai:escalated`, `type:security`, or any label matching
  `/security/i` on the dispatch ticket → `escalated_or_security`.

### Audit table

Every decision — allow and deny alike, for every hook that ran — is appended
to `hook_decisions`, a table `lib/hooks.mjs` owns (created on first use, the
`notify_log` pattern; not core schema):

| Column                  | Meaning                                                                    |
| :---------------------- | :------------------------------------------------------------------------- |
| `at`                    | ISO timestamp (the pass's clock)                                           |
| `point`                 | `approve.before`                                                           |
| `hook_id`, `source`     | The hook, and `builtin` or `extension:<name>`                              |
| `proposal_id`, `run_id` | What was being decided (`run_id` nullable for future non-proposal points)  |
| `decision`, `reason`    | `allow` / `deny`, and the deny reason (`null` on allow)                    |
| `duration_ms`           | How long the hook took                                                     |
| `error`                 | The message behind a `hook_error:*` deny (throw, timeout, malformed value) |

Read it back:

- `GET /proposals/:id` → `{ proposal, hookDecisions: [...] }`, oldest first —
  why this proposal was (not) auto-approved, hook by hook;
- `GET /status` → `hooks.decisions24h`: `{ "<hook id>": { source, point, allow, deny } }`
  over the trailing 24 h — a gate that is firing, or a broken extension hook
  denying everything, is visible from the status page and `doctor`.

The fixture hook `event-runtime/test-support/extensions/sample/hooks/approve-before.mjs`
allows unless the extension config says `greeting: "deny"` (proving
`ctx.config`) or the dispatch ticket carries `sample:deny`; the sibling
files there (`throws.mjs`, `hangs.mjs`, `async-deny.mjs`, `no-id.mjs`,
`no-default.mjs`) exercise each failure mode in `hooks.test.mjs` and
`extensions.test.mjs`.

## Connectors

_Shipped in WM-919. Implementation: `event-runtime/lib/connectors.mjs`
(`validateConnectorModule`, `createConnectorClient`, `startConnectors`,
`stopConnectors`, `connectorStatus`), load-time import in
`event-runtime/lib/extensions.mjs`, start/stop in `event-runtime/cli/serve.mjs`,
status projection in `event-runtime/lib/api-status.mjs`, fixture
`event-runtime/test-support/extensions/sample/connectors/echo.mjs`._

A **connector** is how an extension talks to an external system without
editing the kernel: Buzz, a tracker, a notifier that is not the hard-wired
Telegram path in `lib/notify.mjs`. It is operator-installed **code** — the
same trust class as adapters and hooks, allow-listed in `policy.yaml`, never
scanned. The connector talks to the runtime only through a narrow client;
it never receives a DB handle and cannot mutate the registry.

```json
"contributes": {
  "connectors": { "buzz": "./connectors/buzz.mjs" }
}
```

Names match the adapter pattern `^[a-z][a-z0-9-]*$`. Paths are relative to
the manifest and must stay inside the extension.

### Contract

```js
// contributes.connectors: { "echo": "./connectors/echo.mjs" }
export const id = "factory/sample:echo"; // publisher[/extension]:name

export default async function start(ctx) {
  // ctx: { config, secrets, client, log, signal }
  const unsubscribe = ctx.client.inbox.subscribe((event) => {
    ctx.log(`inbox ${event.type} ${event.item?.id ?? ""}`);
  });
  ctx.signal.addEventListener("abort", () => unsubscribe(), { once: true });
  return {
    async stop() {
      unsubscribe();
    },
    health() {
      return { ok: true, detail: "subscribed", lastEventAt: undefined };
    },
  };
}
```

| `ctx` field | What it is                                                                                                                                                                                                                                                            |
| :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`    | The extension's effective config with secret values stripped. Read settings from here, not from `policy.yaml`. Never contains secret values.                                                                                                                          |
| `secrets`   | Values the loader resolved from `FACTORY_EXT_<NAMESPACE>_<KEY>` (process env, then `~/.factory/secrets.env`) for every `format: "secret"` property, plus remaining keys matching `/nsec\|token\|secret\|key\|password/i`. Absent keys are missing, not empty strings. |
| `client`    | The narrow loopback client (below).                                                                                                                                                                                                                                   |
| `log`       | `(message) => void` — prefixed `connector <ext>/<name>:` on the serve log.                                                                                                                                                                                            |
| `signal`    | An `AbortSignal`. Aborted when `serve` shuts down, when `start()` overruns 10 s, and when that connector is otherwise stopped.                                                                                                                                        |

`start` may be sync or async. Its return value must be `{ stop, health }`:

| Method     | Contract                                                                                                             |
| :--------- | :------------------------------------------------------------------------------------------------------------------- |
| `stop()`   | May be async. Isolated: a throw does not fail shutdown or other connectors.                                          |
| `health()` | Sync. `{ ok: boolean, detail?: string, lastEventAt?: string }`. A throw is reported as `ok: false` with the message. |

### Client

The connector never holds the database. `client` is the only runtime surface:

| Method                                  | What it does                                                                                                                                                                                                                                                                              |
| :-------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inject(envelope)`                      | Same intake as `cli inject` (`admitExternalEvent`). Overwrites `source` to `connector:<ext>/<name>`. The event follows the normal planner/approval path — a connector cannot approve a proposal it injected.                                                                              |
| `inbox.list({ status })`                | Open/acked/resolved/all inbox items.                                                                                                                                                                                                                                                      |
| `inbox.get(id)`                         | One inbox item, or `null`.                                                                                                                                                                                                                                                                |
| `inbox.decide(id, response, { actor })` | Records `decidedBy: "connector:<ext>/<name>:<actor>"` (`unknown` when actor is omitted).                                                                                                                                                                                                  |
| `inbox.markDelivered(id, delivery)`     | Shallow-merges `delivery` onto the inbox row's `delivery_json` (e.g. `{ buzz: { eventId, postedAt } }`) without deciding the item. Survives process restart. Does not clobber `responseHistory`.                                                                                          |
| `inbox.subscribe(cb)`                   | `cb({ type, item, at })` on new-item / changed. Returns an unsubscribe function.                                                                                                                                                                                                          |
| `proposals.get(id)`                     | One proposal, or `null`.                                                                                                                                                                                                                                                                  |
| `runs.get(id)`                          | One run (`runId`, `state`, `attempts`, `spec`, `result`, …), or `null`. `result` is the accepted **artifact only** — never the full `result_json` row (no receipts, no prompts).                                                                                                          |
| `runs.subscribe(cb)`                    | `cb(event)` for a lifecycle transition committed by _this_ process. Process-local: a transition the worker (a separate process, OPS-233) commits never reaches it. Returns an unsubscribe function.                                                                                       |
| `runs.tail(sinceSeq)`                   | `{ events, cursor }` — every lifecycle transition committed after `sinceSeq`, read from the durable journal. Works across processes; re-poll with the returned `cursor` to keep tailing. Prefer this over `runs.subscribe` for anything that must not miss a worker-committed transition. |
| `runs.cursor()`                         | The current journal seq, for establishing a starting cursor without replaying history on connector start.                                                                                                                                                                                 |

There is no `approve`, no registry write, no raw SQL.

### Semantics

- **Load is all-or-nothing; start is not.** Each connector module is imported
  and contract-checked before the extension is accepted. A module that fails
  the contract (missing `default` function, bad `id`, import error) disables
  the extension whole — like a bad adapter. After the registry loads, `serve`
  calls `start()` with an `AbortSignal`. A `start()` that throws, rejects, or
  does not return `{ stop, health }` within **10 seconds** records
  `connector <ext>/<name> failed to start: <msg>` under
  `/status.anomalies.configuration` and **leaves the extension's other
  contributions loaded**. Connectors are the one contribution that may fail
  independently. Other connectors of the same extension still start.
- **Connectors only egress from live.** The loader imports and registers
  connector modules in every environment, but only invokes their real
  `start()` function when `environmentName() === "live"`. Worktree, demo,
  and test runtimes instead log `connector <extension>/<name>: not started:
non-live environment` once and expose healthy connector status with detail
  `not started (non-live env)`. This is environmental: do not change a copied
  `policy.yaml` to disable connectors in a worktree.
- **Secrets never sit in `policy.yaml`.** Every `format: "secret"` property
  (WM-920) is read from `FACTORY_EXT_<NAMESPACE>_<KEY>` (upper-snake) and
  never from the policy entry. A secret present in `policy.yaml` disables the
  extension. Until a schema declares `format: "secret"`, keys matching
  `/nsec|token|secret|key|password/i` are treated as secrets for `ctx` (moved
  out of `config` into `secrets`). `/config` publishes `{ set, source }` for
  declared secret fields, never the value.
- **Attribution.** `inject` stamps `source: "connector:<ext>/<name>"`.
  `inbox.decide` records `decidedBy: "connector:<ext>/<name>:<external actor>"`.
- **Status.** `connectorStatus()` / `attachConnectorStatus()` project
  `connectors: [{ extension, name, ok, detail, lastEventAt, startedAt }]`.
  Start-failure anomalies already appear on `/status.anomalies.configuration`
  via `registry.anomalies`. Wiring the `connectors` array onto `GET /status`,
  one doctor line per connector, and a CONNECTORS column on `extensions list`
  is a follow-up — those files sit outside this ticket's Owned Paths.
  `extensions list --json` already includes the `connectors` array the loader
  records.

The fixture `event-runtime/test-support/extensions/sample/connectors/echo.mjs`
subscribes to inbox writes, logs them, and exposes health so
`extensions.test.mjs`, `connectors.test.mjs` and `api-status.test.mjs` can
watch load/start/stop/anomaly/secrets without an external network.

## Worked example: wattmind/buzz

_Shipped in WM-921. Implementation: `extensions/buzz/` (self-contained so it
can later publish as `@watt-mind/factory-ext-buzz`; the package resolver is
WM-922)._

The factory appears in Buzz as an agent. Inbox items post to `#general` on
`https://watt-mind.communities.buzz.xyz`; 👍 / 👎 / 💤 (and numbered
reactions) plus thread replies map onto `inbox.decide`; `@factory dispatch`
and `@factory status` are a closed command grammar. Telegram stays the
blocker channel until a real `BLOCKED` push has been observed end-to-end.

Layout:

```text
extensions/buzz/
  factory-extension.json      # name: wattmind/buzz
  config.schema.json          # namespace buzz; format: secret for nsec + auth tag
  connectors/buzz.mjs         # id wattmind/buzz:buzz
  panels/buzz.panel.json      # Overview tile bound to /inbox
  README.md                   # keygen + secrets.env
```

Enablement (secrets never in `policy.yaml`):

```yaml
extensions:
  - path: extensions/buzz
    config:
      channel: "91572011-2505-5288-b6f5-4a7d74abf106" # #general
```

```bash
# ~/.factory/secrets.env (chmod 600)
FACTORY_EXT_BUZZ_AGENT_NSEC=nsec1…
FACTORY_EXT_BUZZ_AUTH_TAG=["auth","<owner-pubkey>","<conditions>","<sig>"]
```

Mint the key and the NIP-OA tag with the WM-905 script (`buzz.py keygen` /
`buzz.py auth-tag`); the owner nsec is read once and never stored. Restart
`serve`. The connector speaks REST (`POST /events`, `POST /query`) with
NIP-98 + `x-auth-tag`, the same path as `buzz-cli`. Failed posts sit on a
bounded in-memory queue; ingress resumes with `since`.

## Harness

_Shipped in WM-849. Implementation: `contributes.harness` on
`factory-extension.json`; `collectHarnessRoots`, `harnessRootFor` in
`event-runtime/lib/extensions.mjs`; `build/emit.mjs` emits every loaded
root; the built-in pack is `shared/factory-extension.json`._

Harness content is markdown the emit pipeline packages for every coding
agent the factory supports — the AGENTS.md floor, `/factory-*` slash
commands, skills, and custom subagents. It is **data**, not in-process
code: loading a harness contribution executes nothing. Enabling it is
the same allow-list as every other contribution (`policy.yaml
extensions:`); `shared/` is the exception, the built-in `factory/core`
pack that emit always includes first so `plugins/core/**` and `dist/**` stay
byte-identical with the historical layout.

```json
"contributes": {
  "harness": {
    "floor": "./floor.md",
    "commands": "./commands",
    "skills": "./skills",
    "subagents": "./agents"
  }
}
```

Every key is optional. Paths are relative to the manifest and must stay
inside the extension; `floor` must be a file, the others directories. A
missing or escaping path is a manifest error and skips the extension
whole, like any other bad path.

**Emit.** `bun build/emit.mjs` calls `collectHarnessRoots({ builtin: shared/ })`
then writes each pack:

| Pack                                     | Claude plugin                    | dist/ (Codex, Gemini, Cursor, Pi)                                                                          |
| :--------------------------------------- | :------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `factory/core` (`shared/`, always first) | `plugins/core/`                  | historical paths (`dist/codex/skills/ticket-spec/`, …)                                                     |
| any other contributing extension         | `plugins/<publisher-extension>/` | nested under the same slug (`dist/codex/skills/<slug>/…`); flat Cursor/Pi filenames are prefixed `<slug>-` |

`--sync-floor` still splices only the core floor into configured repos'
`AGENTS.md`. A third-party floor is emitted as `dist/AGENTS.floor.<slug>.md`
and is not auto-spliced.

**Collision.** A non-core pack may not take plugin name `core` or reuse
another pack's slug or `name`. The later contributor's harness is skipped
(emit records an anomaly and still writes every other pack; `loadExtensions`
skips that extension whole, same as an adapter name clash). Discovery stays
allow-listed: dropping a directory into `~/.factory/extensions/` does
nothing until `policy.yaml` names it.

**Trust.** Harness markdown is the same class as packs — an agent may
author it — with the operator enablement gate in front. It is not an
adapter: emit never imports third-party JavaScript.

## Publishing

Distribute an extension as an npm package so another factory install enables
it with `npm i @watt-mind/factory-ext-<name>` plus one `policy.yaml` line, instead
of cloning a directory. An extension is already a self-contained directory
with one manifest, so the package _is_ the extension root — the loader
resolves `package:` to that directory (§Enabling).

### Package conventions

| Field              | Value                                                                                                                                                                                                                                    |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `@watt-mind/factory-ext-<name>` (the `@watt-mind` org). Unscoped names resolve too; this is the published convention.                                                                                                                    |
| `files`            | Whitelist: `factory-extension.json` plus every contributed path the manifest names (`pack/`, `adapters/`, `connectors/`, `hooks/`, `panels/`, `config.schema.json`, harness dirs). Do not ship tests, fixtures, or the factory checkout. |
| `peerDependencies` | **None.** An extension imports only from the runtime contract via `ctx` (hooks, connectors, adapters). It must not `import` `event-runtime/lib/*` — that is also why connectors receive a client object instead of a DB handle.          |
| `engines.bun`      | The bun range the extension was tested against (the factory itself is `>=1.3`).                                                                                                                                                          |
| `keywords`         | Must include `"factory-extension"`.                                                                                                                                                                                                      |

`package.json` may point the loader at a subdirectory with
`factory.extension: "./ext"` when the package root is not the extension root.
That path is realpath'd and must stay inside the package.

### Validate and pack

```sh
bun event-runtime/cli.mjs extensions validate <dir|package>
bun event-runtime/cli/extensions.mjs pack <dir>
```

`pack` runs validate, then `npm pack --dry-run`, and lists the files that
would ship. Use it before the first publish.

### Publish workflow

`.github/workflows/publish-extension.yml` is a manual `workflow_dispatch`
with an `extension` input (repo-relative directory). It validates, runs
tests under that directory when they exist, and
`npm publish --provenance --access public`. The `NPM_TOKEN` repository
secret must be set — if it is missing the workflow fails loudly rather than
publishing unauthenticated. The operator adds the token to the `@watt-mind`
org; the workflow does not create it.

## Related

- [`kernel-and-packs.md`](kernel-and-packs.md) — the pack format and the
  kernel's admission rules, which extension packs inherit unchanged
- [`event-runtime-workers.md` §2c](event-runtime-workers.md#2c-adapter-registry-and-contract--shipped-wm-837) —
  the adapter contract and registry
- [`architecture.md`](architecture.md) — where extensions sit in the design

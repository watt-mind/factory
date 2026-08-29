# Event runtime code conventions

This document records the conventions already established by the event runtime.
It is a guide for extending the runtime, not a proposal for a new architecture.
The versioned contracts and security model remain authoritative in
[`event-runtime.md`](event-runtime.md).

## Functional core, imperative shell

The house style is data in, data out:

- Export module-scoped functions rather than constructing service objects.
- Pass plain data objects such as `envelope`, `spec`, `def`, `record`, and
  `receipt` explicitly between modules.
- Keep decisions in small deterministic functions; keep database, filesystem,
  network, clock, and subprocess effects at the edge.
- Reserve classes for typed errors that a boundary must distinguish. Examples
  include `RegistryError` in `event-runtime/lib/registry.mjs`,
  `ContractViolation` in `event-runtime/lib/verify.mjs`, and
  `CliNotFoundError` in `event-runtime/lib/adapters/pi.mjs`.

Examples of the functional core include:

- `planner.mjs`'s `idempotencyKeyFor()` and `buildRunSpec()`;
- `intake.mjs`'s `verifyWebhook()` and `translateGitHubEvent()`;
- `verify.mjs`'s `verifyResult()` and its closed semantic-check table; and
- the adapters' argument, environment, and stream-event mapping functions,
  such as `buildPiArgv()`, `safeChildEnvironment()`, and `mapStreamEvent()`.

The imperative shell composes those functions. `planEvent()` reads external
state before entering its write transaction, while `worker.mjs` claims a run,
creates the workspace, invokes one adapter, independently verifies its output,
and publishes the accepted result transactionally.

Object-oriented agent or adapter hierarchies are not the house style. Agent
behavior is already represented by content-pinned definitions, a declarative
registry, immutable run specifications, and closed command/action templates.
Inheritance would hide inputs and authority that the runtime deliberately
keeps visible; plain data and functions match the contracts directly.

## Dependency injection uses options objects

Functions take required domain values positionally or as one record, then take
replaceable effects and policy in a trailing options object. Examples include:

```js
planEvent(db, registry, eventRef, {
  now,
  policyVersion,
  artifactStore,
  dispatch: { fetchTicket, fetchInFlight, countLeases },
});

executeClaimed(db, registry, adapters, claim, {
  workspacesRoot,
  artifactStore,
  now,
  env,
  dispatch,
});
```

Use named options instead of adding positional booleans. A caller should be
able to see which clock, transport, filesystem root, subprocess environment,
or adapter it is supplying. Default production implementations belong at the
boundary; deterministic logic receives them as values.

Anything whose result depends on the network, clock, filesystem, or a
subprocess needs an injectable seam so tests do not require the live service or
runtime. Existing seams include:

- `verifyWebhook({ ..., now })`, `planEvent(..., { now, dispatch })`, and
  worker lifecycle functions' injected clocks;
- `publishOutbox(db, { sink })` and notification transport options;
- `resolvePiCommand({ which })` and remote-worker `spawnFn` options;
- explicit `workspaceDir`, `artifactStore`, `env`, and adapter registries;
- the hook registry — `autoApproveChains(db, registry, { hooks, hookTimeoutMs })`
  and `loadExtensions({ hookRegistry })` take a `createHookRegistry()`
  instance (`lib/hooks.mjs`; the process-wide `defaultHookRegistry()` is only
  the default), so tests decide which `approve.before` hooks run and with what
  timeout; and
- temporary directories and PATH-local stub CLIs in adapter conformance tests.

Keep defaults in the options destructuring, not in mutable module globals. Do
not introduce process-wide singleton clients, clocks, or caches as hidden
coordination state.

## Module decomposition

Split a module when it is serializing work, not when it crosses an arbitrary
line-count threshold. The measurable signal is repeated contention: many open
tickets name the same source or test file in their Owned Paths, preventing
otherwise independent changes from proceeding in parallel. The current worked
example is the API pair: `api.test.mjs` is named by nine agent-ready tickets and
`api.mjs` by eight. The large `api.mjs` and `cli.mjs` splits are warranted by
that collision pressure, not merely by their 1,300-plus lines.

When that trigger is present, apply these rules:

- **Split by domain, not by layer.** Prefer modules such as `api-runs.mjs`,
  `api-inbox.mjs`, and `api-metrics.mjs`; do not create cross-cutting
  `api-controllers.mjs` and `api-services.mjs` layers. A domain split keeps one
  ticket in one module, while a layer split scatters each change across files
  and recreates Owned Paths collisions.
- **Make the original file the composition root.** It retains wiring and
  route or verb registration only; handler bodies and domain decisions move to
  the extracted modules. If the root still contains that logic, the split is
  incomplete.
- **Keep dependencies explicit.** Pass databases, clocks, clients, and other
  effects through the existing options-object seams. A split must not introduce
  module-scoped state: the runtime opens a database per process and tests create
  their own, so an ambient database, clock, or client breaks both boundaries.
- **Move tests with the source.** Give every extracted module its own adjacent
  test file. Extracted tests are as much a part of the split as extracted
  source; leaving one large test file only relocates the chokepoint. The current
  nine-ticket contention on `api.test.mjs`, compared with eight on `api.mjs`,
  demonstrates that the test file can be the more contended half.
- **Do not import back to the composition root.** That reverse dependency
  re-couples the modules the split was meant to separate. Move shared helpers
  to a leaf module that both the root and extracted module can import.
- **Treat a split as a move, not a redesign.** Preserve behavior, signatures,
  routes, verbs, status codes, and exit codes so reviewers can assess a
  relocation. Put behavior changes in a separate commit or ticket.

A split does not introduce classes or service objects. Follow
[Functional core, imperative shell](#functional-core-imperative-shell) and
keep the existing module-scoped function style; decomposition changes module
boundaries, not the programming model.

## Adapter contract

### Worker-facing interface

Every adapter is a module with an exported asynchronous `execute()` function.
The worker calls it with this options-object interface:

```js
await adapter.execute({
  spec, // immutable factory.run-spec/v1 selected by the planner
  def, // loaded, content-pinned agent definition
  workspaceDir, // absolute directory for this attempt
  timeoutMs, // hard execution deadline
  env, // worker-supplied environment overlay
  onTrace, // optional (kind, payload) observability callback
  onUsage, // optional normalized usage callback
  abortSignal, // cooperative cancellation signal
  signal, // compatibility alias; prefer abortSignal
});
```

An adapter may ignore options it cannot use. Adapter-local test seams, such as
`killGraceMs`, may be optional additions, but adapters must not obtain domain
inputs from ambient mutable state when the worker supplied them above.

The resolved promise has this shape:

```js
{
  exitCode: 0,             // number or null when no exit code exists
  timedOut: false,         // true only when timeoutMs caused termination
  policyDenials: [],       // optional [{ tool, rule }]
  usage: undefined,        // optional normalized usage record
}
```

`exitCode` and `timedOut` are required. `policyDenials` and `usage` are optional.
A nonzero exit is an execution outcome, not an exception. Throw only when the
adapter itself cannot execute, such as an unavailable CLI or a spawn failure.
The worker, not the adapter, maps these outcomes to lifecycle states and runs
`verifyResult()` over `result.json`.

`command.mjs` and `actions.mjs` implement the same worker-facing minimum while
using closed templates rather than a model. `fake.mjs` is the deterministic
reference used by end-to-end tests; it exercises the real planner, worker,
verifier, and lifecycle without launching a live harness.

### Honor `mutating`

`def.mutating` is load-bearing policy, not a hint:

- `true` is allowed only where registry admission can enforce the mutation
  shape: a closed command/action template or a tier-2 worktree agent
  (`registry.mjs:loadAgentDef()`).
- `false` removes mutation authority but must still leave a path to write the
  workspace's required `result.json`.
- New checks must fail closed on missing or malformed policy. Do not infer
  mutation authority from a tool list, workspace contents, or ambient
  credentials. [WM-298](https://linear.app/watt-mind/issue/WM-298/fixevent-runtime-validate-mutating-as-a-required-boolean-at-registry)
  tracks the current registry gap that still admits missing or non-boolean
  values.

Claude and pi enforce non-mutating model runs differently. Claude keeps
`Write`/`Edit` and `Bash` available because the agent must inspect the
workspace and write its result, then `buildClaudeSettings()` denies writes to a
repository checkout and the worker independently compares repository status.
Pi passes `--tools read,grep,find,ls,write`: `write` preserves the result path,
while omitting `bash` and `edit` removes the broader mutation paths. Pi's
containment is explicitly coarser and audited-not-enforced, as described in
`event-runtime.md` section 14; [WM-297](https://linear.app/watt-mind/issue/WM-297/docsevent-runtime-correct-stale-pi-read-only-tool-list-in-security)
tracks that section's stale omission of `write` from its prose.

This distinction exists because [OPS-518](https://linear.app/watt-mind/issue/OPS-518/pi-adapters-read-only-mode-can-never-write-resultjson-every)
showed that treating "read-only" as "no write tool" makes every run violate the
result contract. Read-only means no durable mutation outside declared
workspace output, not inability to produce that output.

### Child environment and credentials

LLM adapters construct a minimal child environment from a small inherited
allowlist plus the explicit `env` option; they do not copy `process.env`
wholesale. Provider API keys are removed so the CLIs use their configured
subscription authentication.

`PUSH_CREDENTIAL_ENV` is the shared list `SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
`GITHUB_TOKEN`, and `GH_TOKEN`, exported by `adapters/child-env.mjs`. A
`mutating: true` run may inherit those four
values. A non-mutating run strips them _after_ merging the caller's `env`, so a
caller cannot smuggle mutation authority back in through the overlay.

Nested Claude Code session markers (`CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`)
are stripped for all adapters so child processes do not inherit the operator's
interactive session context.

[WM-223](https://linear.app/watt-mind/issue/WM-223/fixevent-runtime-pi-adapter-strips-push-credentials-for-mutating-runs)
is the incident that proves the signature matters: pi's environment helper did
not receive `def`, so mutating dispatch runs lost the credentials needed to
push. Every adapter helper that makes a policy decision must receive the loaded
definition or the precise policy field explicitly.

### Result, transcript, and trace

LLM adapters append the shared `PROMPT_SUFFIX`, run with `workspaceDir` as
`cwd`, and capture the harness's complete structured stdout as workspace-local
`.transcript.json`. The transcript is an artifact for later inspection; it is
not accepted result data. The agent's candidate result is always
`workspaceDir/result.json`, independently verified by `verify.mjs`.

Trace is optional and observational. When supported, map harness output to the
closed `factory.trace/v1` kinds `assistant_text`, `tool_use`, `tool_result`,
`usage`, and `lifecycle`. Mapping functions must be pure, ignore unknown or
malformed stream records, clip previews, and never terminate or fail the child
because a recorder throws. Emit policy denials only from confirmed,
harness-authored refusal shapes; ordinary `EACCES`, SSH, command, or tool
stderr is not evidence that the harness denied a capability. A clean process
exit outranks a denial observed mid-run, because an agent may recover; retain
the lifecycle trace but return an empty `policyDenials` list on exit 0.

Claude maps `assistant`, `user/tool_result`, and terminal `result` NDJSON
records. Pi maps complete `message_end` and `tool_execution_end` records and
ignores deltas to avoid duplicates. Because pi has no terminal usage summary,
it accumulates per-turn usage and emits one `usage` trace on close. Missing
usage stays `null` or empty rather than becoming a fabricated zero. Pi's
per-line trace callbacks are guarded, but its terminal `usage` callback is
currently outside that guard; [WM-305](https://linear.app/watt-mind/issue/WM-305/fixevent-runtime-pi-terminal-usage-trace-callback-can-strand-adapter)
tracks this observer-isolation conformance gap.

### Timeout, cancellation, and process cleanup

The LLM adapter shutdown contract is:

1. At `timeoutMs`, set `timedOut = true` and send `SIGTERM`.
2. If the child remains alive, send `SIGKILL` after `KILL_GRACE_MS` (30 seconds
   in both `claude.mjs` and `pi.mjs`).
3. On `abortSignal` (or the compatibility `signal`), use the same TERM-to-KILL
   discipline but leave `timedOut = false`.
4. Clear timeout and kill timers, remove abort listeners, and close or destroy
   capture streams on every exit/error path.

Adapters that can create process trees must terminate the relevant process
group; `command.mjs:killProcessGroup()` is the precedent. Never resolve while a
background child remains running.

### CLI preflight

A missing required CLI is an adapter precondition, not a model failure. Detect
it before useful work begins and throw a typed error with
`code: "cli_not_found"`; `worker.mjs:executeClaimed()` maps that to the stable
`cli_not_found` reason without retrying the same incapable worker.

`pi.mjs:resolvePiCommand()` follows this rule (`pi`, then `npx pi`, otherwise
`CliNotFoundError`). `cursor.mjs:resolveCursorCommand()` does the same
(`agent`, then `cursor-agent`). Claude currently relies on `spawn("claude", ...)` and a
missing binary becomes the generic `adapter_error`; this is a known conformance
gap tracked by [WM-296](https://linear.app/watt-mind/issue/WM-296/fixevent-runtime-make-claude-cli-absence-a-typed-preflight-refusal),
not precedent for a new adapter.

**Cursor (WM-440).** `lib/adapters/cursor.mjs` is a fourth LLM adapter on
this same contract. Prompt is a positional argument (`-p` is a boolean);
`--force` is always passed so `./result.json` can be written (print without
it only proposes writes; `--mode ask|plan` is no-edits and is refused);
`HARNESS_DENIAL_PATTERNS` is empty until a Cursor-authored refusal is
confirmed. The `cursor` editor binary is not a fallback.

### Claude/pi conformance audit

Both LLM adapters implement the shared execution, result, workspace,
transcript, credential, timeout, and cancellation shapes above. Their deliberate
differences and known conformance gaps are:

| Concern                      | Claude                                                      | pi                                                                 |
| :--------------------------- | :---------------------------------------------------------- | :----------------------------------------------------------------- |
| Prompt transport             | `-p <prompt>` argv                                          | stdin                                                              |
| Structured stream            | `stream-json`                                               | `--mode json`                                                      |
| Non-mutating containment     | generated settings/sandbox plus worker integrity gate       | restricted tool list; audited-not-enforced                         |
| Required result write path   | `Write`/`Edit` remain available outside denied checkout     | `write` remains in `READ_ONLY_TOOLS`                               |
| Usage                        | terminal result plus `onUsage` callback                     | accumulated turns, emitted as trace                                |
| Observer failure isolation   | per-line trace and terminal usage callbacks guarded         | per-line trace guarded; terminal usage trace gap tracked by WM-305 |
| Policy denial matching       | confirmed Claude-authored patterns                          | empty until a pi-authored shape is observed                        |
| Missing CLI                  | generic spawn error (known gap)                             | typed preflight with `npx` fallback                                |
| `safeChildEnvironment` guard | shared helper: only explicit `true` grants push credentials | shared helper: only explicit `true` grants push credentials        |

All adapters delegate the fail-closed authority check to the shared helper, so
non-boolean values never gain push credentials.

## Fail closed at trust boundaries

Validation does not repair, guess, or silently default untrusted input:

- `intake.mjs` verifies raw webhook bytes before parsing and returns typed
  `{ ok: false, reason }` or admission errors for missing, stale, malformed, or
  unauthenticated input.
- `planner.mjs` converts expected policy refusals into typed `noop` or
  `human_needed` decisions; unknown idempotency fields throw rather than
  changing deduplication scope.
- `registry.mjs` raises `RegistryError` at load for missing pins, bad mappings,
  unknown tiers, or unenforceable mutating definitions. Startup failure is
  safer than a runtime surprise after approval.
- `verify.mjs` raises `ContractViolation` for missing or malformed results,
  unknown refusal reasons, schema violations, path escapes, missing artifacts,
  or evidence mismatches. The worker translates that typed error to a stable
  terminal reason and publishes no completion event.

Use typed return values for expected refusals at trust boundaries. Use typed
errors when a caller must unwind an in-progress operation. Do not catch an
unknown error and turn it into success, an empty set, or a permissive default.

## Testing conventions

- Put `name.test.mjs` beside `name.mjs` and use `bun:test`.
- Test pure decision and mapping functions directly with plain records.
- Inject clocks, transports, lookup functions, environments, and process seams;
  use temporary directories and local stub executables for filesystem/process
  behavior.
- Use `adapters/fake.mjs` for planner-to-worker end-to-end tests. It must model
  real artifacts and outcomes closely enough that the production pipeline runs
  unchanged.
- Adapter conformance tests cover structured output, workspace `cwd`, minimal
  environment, result/transcript write paths, nonzero exits, timeout,
  TERM-to-KILL escalation, cancellation, and malformed/unknown trace records.
- Tests must not depend on a live model CLI, webhook sender, Linear, GitHub,
  remote worker, or running event-runtime service.

Examples are `adapters/{claude,pi}.test.mjs` with PATH-local stub CLIs,
`planner.test.mjs` with deterministic envelopes and clocks, and
`intake.test.mjs` with injected timestamps and locally computed signatures.

## Do not introduce

- New transports, brokers, orchestration frameworks, or workspace providers
  without an event type that earns them. `event-runtime.md` explicitly defers
  Kafka, NATS, Kubernetes, remote-worker machinery, declared workflow joins,
  and unused workspace types.
- Ambient mutable global state for authority, clocks, clients, credentials, or
  coordination. Put dependencies in options and durable coordination in the
  database/lease contracts.
- Arbitrary commands, hosts, prompts, mounts, models, or permissions from event
  payloads. Extend the registered definition or closed template instead.
- Imports or test hooks that reach into another module's private internals.
  Extend that module's declared inputs or export a small pure function at the
  boundary where the behavior belongs.
- Adapter behavior inferred from another CLI's flags or stream shape. Confirm
  the actual CLI and add a conformance fixture before registering it.

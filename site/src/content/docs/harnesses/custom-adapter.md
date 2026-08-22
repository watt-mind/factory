---
title: Writing a Harness Adapter
description: Adding support for new coding agent CLIs
---

An event-runtime adapter is an ES module with two required exports: `execute()` and `SANDBOX_SUPPORT`.

```js
export const SANDBOX_SUPPORT = "unsupported";

export async function execute({
  spec,
  def,
  workspaceDir,
  timeoutMs,
  env,
  onTrace,
  onUsage,
  abortSignal,
}) {
  // Spawn the CLI, stream trace and usage, and write the result artifact.
  return { exitCode: 0, timedOut: false };
}
```

`SANDBOX_SUPPORT` must be `"gondolin"` or `"unsupported"`. Declaring Gondolin support means the adapter owns the sandboxed execution path; unsupported adapters are refused before they run when a definition requires sandboxing.

### Required Capabilities

1. **Prompt ingestion:** Accept instructions through the CLI's supported input mechanism.
2. **Workspace and tool policy:** Honor the supplied workspace, mutability, environment, timeout, and abort signal.
3. **Trace capture:** Emit normalized trace events and preserve a transcript artifact.
4. **Result contract:** Write the declared result artifact and return a clean `{ exitCode, timedOut }` outcome.

Built-in adapters live in `event-runtime/lib/adapters/`. Installable adapters can be contributed by a `factory-extension.json` manifest. Validate what the runtime loaded with:

```bash
factory events adapters
factory events extensions validate /path/to/extension
```

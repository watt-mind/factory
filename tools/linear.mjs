#!/usr/bin/env bun
/**
 * Deprecated alias for `tools/ticket.mjs` (WM-1026).
 *
 * The CLI has routed through `loadControlPlane()` since WM-894 and selects a
 * control plane per repo since WM-1007; only the filename still claimed the
 * tracker was Linear. It was renamed rather than deleted-and-replaced because
 * agent prompts, shared commands and every emitted harness bundle still
 * invoke this path, and those are swept separately — a rename that broke them
 * would take the whole dispatch loop down for one commit.
 *
 * Delete this shim once nothing references `tools/linear.mjs`. Until then it
 * must stay behaviourally identical: same exports, same argv, same stdout.
 *
 * The notice goes to **stderr** on purpose. Several verbs print JSON that
 * callers parse (`get --json`, `queue`, `budget`); a deprecation line on
 * stdout would corrupt exactly the machine-readable output the factory
 * depends on.
 */
export * from "./ticket.mjs";

if (import.meta.main) {
  process.stderr.write(
    "tools/linear.mjs is deprecated — use tools/ticket.mjs (or `factory ticket`)\n",
  );
  const { main } = await import("./ticket.mjs");
  await main();
}

/**
 * Registers happy-dom globals for DOM component tests as an import side effect.
 *
 * Do not use a bunfig.toml `[test] preload`. bun only honours a preload when
 * `bun test` is run with that directory as cwd. Verification and CI run
 * `bun test event-runtime` from the repo root, so event-runtime/web/bunfig.toml
 * would be ignored and the test would die with `ReferenceError: document is
 * not defined`. A root-level preload would instead register DOM globals for
 * every pure-logic test in the sweep, which we do not want.
 *
 * Import this module first in every DOM test file so registration runs before
 * `@testing-library/react` (whose module-level `screen` binds to document.body
 * at import time). Use the queries returned by `render()`, not `screen`.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// happy-dom supplies a real fetch and defaults its document origin to
// http://localhost/. An api method that a component test forgot to stub would
// therefore escape to port 80. Fail closed before the network stack sees it;
// tests that intentionally exercise fetch replace globalThis.fetch explicitly.
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const rawUrl = request?.url ?? String(input);
  const url = new URL(rawUrl, document.location.href);
  const path = `${url.pathname}${url.search}`.replace(/^\/api(?=\/)/, "");
  throw new Error(`unmocked api call: ${method} ${path}`);
}) as unknown as typeof fetch;

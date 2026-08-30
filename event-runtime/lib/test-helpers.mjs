/** Shared guardrails for worker tests that can spawn the tracker CLI. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-test-helpers-mjs";

// Preloaded from bunfig.toml so every spawned `tools/ticket.mjs` fails closed
// before it can open a connection to api.linear.app.
process.env.FACTORY_LINEAR_OFFLINE = "1";

const LINEAR_API_HOST = "api.linear.app";

/**
 * Process-wide fail-closed guard for the test process itself. The CLI guard in
 * tools/ticket.mjs only covers spawned children; in-process Linear clients
 * (orchestrator/reaper.mjs `gql`, lib/control-plane/linear.mjs) resolve
 * `globalThis.fetch` at call time, so wrapping it here makes every
 * api.linear.app request from a `bun test` process throw `linear_offline_guard`
 * before a connection opens — regardless of which key is in the environment.
 * `FACTORY_LINEAR_ALLOW_NETWORK=1` is the explicit escape hatch.
 */
export function installTestLinearOfflineGuard(env = process.env) {
  if (globalThis.fetch?.__factoryLinearOfflineGuard) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const guarded = async function factoryLinearOfflineGuardFetch(input, init) {
    const url = String(input?.url ?? input);
    if (
      url.includes(LINEAR_API_HOST) &&
      env.FACTORY_LINEAR_ALLOW_NETWORK !== "1"
    ) {
      const error = new Error(
        "linear_offline_guard: Linear network access is disabled under tests",
      );
      error.code = "linear_offline_guard";
      throw error;
    }
    return originalFetch(input, init);
  };
  guarded.__factoryLinearOfflineGuard = true;
  globalThis.fetch = guarded;
}

installTestLinearOfflineGuard();

/**
 * Put a fake `bun` ahead of PATH while a test exercises an un-injected worker
 * seam. The fake logs argv so callers can assert a tracker CLI did not escape.
 */
export function fakeTrackerCli() {
  const dir = tmpDir("evrt-tracker-cli-");
  const spawnLog = path.join(dir, "spawned.log");
  writeFileSync(
    path.join(dir, "bun"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(spawnLog)}\nexit 0\n`,
    { mode: 0o755 },
  );
  return {
    path: dir,
    calls: () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : ""),
  };
}

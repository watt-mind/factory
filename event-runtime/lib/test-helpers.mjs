/** Shared guardrails for worker tests that can spawn the tracker CLI. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-test-helpers-mjs";

// Preloaded from bunfig.toml so every spawned `tools/ticket.mjs` fails closed
// before it can open a connection to api.linear.app.
process.env.FACTORY_LINEAR_OFFLINE = "1";

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

/**
 * Standalone planner daemon command (WM-1208).
 *
 *   bun event-runtime/cli.mjs plan [--port 7381] [--adapter-override fake] [--poll-ms 250] [--once]
 */
import { openDb } from "../lib/db.mjs";
import { loadRegistry } from "../lib/registry.mjs";
import {
  policyVersion,
  runtimeHome,
  dbPath,
  environmentName,
} from "../lib/config.mjs";
import { runPlannerLoop } from "../lib/planner-loop.mjs";
import { planAdmittedEvents } from "../lib/planner.mjs";
import { flagValue, log } from "./shared.mjs";

export default async function plan(args) {
  const home = runtimeHome();
  const db = openDb(dbPath());
  const registry = loadRegistry();
  const pv = policyVersion();
  const adapterOverride = flagValue(args, "--adapter-override") ?? null;
  const pollMs = Number(flagValue(args, "--poll-ms") ?? 250);
  const once = args.includes("--once");

  log(
    `environment "${environmentName()}" — planner daemon on db ${dbPath()} (policy ${pv})`,
  );
  if (adapterOverride) log(`adapter override: "${adapterOverride}"`);

  if (once) {
    const outcome = planAdmittedEvents(db, registry, {
      now: Date.now(),
      policyVersion: pv,
      adapterOverride,
    });
    log(`planned ${outcome.length} event(s)`);
    return;
  }

  await runPlannerLoop({
    db,
    registry,
    policyVersion: pv,
    adapterOverride,
    pollMs,
    log,
  });
}

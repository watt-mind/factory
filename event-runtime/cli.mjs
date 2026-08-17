#!/usr/bin/env bun
/** Event-runtime CLI argument routing and command dispatch. */
import { COMMANDS } from "./cli/commands.mjs";
import { USAGE } from "./cli/usage.mjs";

// Preserve the small programmatic surface used by runtime tests and tooling.
export {
  PRUNE_INTERVAL_MS,
  TICK_SUBSYSTEMS,
  acquireServeLock,
  isProcessAlive,
  releaseServeLock,
  serveLockPath,
  tick,
} from "./cli/serve.mjs";
export { getAnomalyLines, getPoolLines, status } from "./cli/status.mjs";
export { doctor } from "./cli/doctor.mjs";
export {
  SPAWN_GRACE_MS,
  readPool,
  runDir,
  slotFiles,
} from "./cli/supervise.mjs";
export { COMMAND_NAMES, COMMANDS } from "./cli/commands.mjs";

export async function dispatch(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(USAGE);
    process.exit(1);
  }
  return COMMANDS[command](args);
}

if (import.meta.main || process.argv[1]?.endsWith("cli.mjs")) {
  await dispatch();
}

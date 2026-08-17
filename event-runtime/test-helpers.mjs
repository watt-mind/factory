/**
 * Test isolation and hermetic environment helpers for the event runtime (OPS-425).
 *
 * Ensures all test executions run hermetically inside temporary directories
 * and never touch or mutate the operator's real ~/.factory directory.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os, { homedir } from "node:os";
import path from "node:path";

let defaultIsolatedHome = null;

/**
 * Ensure an isolated temporary directory is used as FACTORY_EVENT_HOME and FACTORY_HOME.
 */
export function ensureHermeticHome() {
  if (!defaultIsolatedHome) {
    defaultIsolatedHome = mkdtempSync(path.join(os.tmpdir(), "evrt-hermetic-home-"));
  }
  process.env.FACTORY_EVENT_HOME = defaultIsolatedHome;
  process.env.FACTORY_HOME = defaultIsolatedHome;
  mkdirSync(path.join(defaultIsolatedHome, "artifacts"), { recursive: true });
  mkdirSync(path.join(defaultIsolatedHome, "workspaces"), { recursive: true });
  mkdirSync(path.join(defaultIsolatedHome, "mirrors"), { recursive: true });
  return defaultIsolatedHome;
}

// Automatically ensure hermetic home is active on module import if unset or pointing to homedir
if (!process.env.FACTORY_EVENT_HOME || process.env.FACTORY_EVENT_HOME.startsWith(homedir())) {
  ensureHermeticHome();
}

/**
 * Create a fresh isolated home directory for a test scope.
 */
export function createIsolatedHome(prefix = "evrt-test-home-") {
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(home, "artifacts"), { recursive: true });
  mkdirSync(path.join(home, "workspaces"), { recursive: true });
  mkdirSync(path.join(home, "mirrors"), { recursive: true });
  return home;
}

/**
 * Execute an async or sync callback with a scoped isolated FACTORY_EVENT_HOME.
 * Restores previous environment variables after execution.
 */
export async function withIsolatedHome(fn, prefix = "evrt-scope-home-") {
  const home = createIsolatedHome(prefix);
  const prevEventHome = process.env.FACTORY_EVENT_HOME;
  const prevFactoryHome = process.env.FACTORY_HOME;
  try {
    process.env.FACTORY_EVENT_HOME = home;
    process.env.FACTORY_HOME = home;
    return await fn(home);
  } finally {
    if (prevEventHome === undefined) delete process.env.FACTORY_EVENT_HOME;
    else process.env.FACTORY_EVENT_HOME = prevEventHome;
    if (prevFactoryHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = prevFactoryHome;
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Returns snapshot stats of ~/.factory to verify hermeticity (guard test).
 */
export function realFactorySnapshot(factoryHome = path.join(homedir(), ".factory")) {
  const eventHome = path.join(factoryHome, "event-runtime");
  let eventStat;
  try {
    eventStat = statSync(eventHome);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, mtime: 0, dbMtime: 0 };
    return { exists: true, mtime: 0, dbMtime: 0 };
  }

  let dbMtime = 0;
  try {
    dbMtime = statSync(path.join(eventHome, "runtime.db")).mtimeMs;
  } catch {
    // A missing or unreadable database has the same stable sentinel value.
  }
  return { exists: true, mtime: eventStat.mtimeMs, dbMtime };
}

import { afterAll, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tracked = new Map();
const registeredTestCleanupOwners = new Set();
let handlingSignal = false;
const defaultTestMarker = `spawn-tracked-${process.pid}`;

function testFileForCaller() {
  const match = new Error().stack?.match(
    /(?:file:\/\/)?[^()\s]+\.test\.mjs(?=:\d+:\d+)/,
  );
  if (!match) return null;
  return match[0].startsWith("file:") ? match[0] : pathToFileURL(match[0]).href;
}

/**
 * Bind process cleanup to the importing test file rather than to this shared
 * module's first loader. Tracked entries retain the same owner, so one file's
 * afterAll cannot tear down another file's suite fixture.
 */
export function registerTestProcessCleanup(owner = testFileForCaller()) {
  if (!owner) {
    throw new Error(
      "registerTestProcessCleanup must be called from a .test.mjs file",
    );
  }
  if (registeredTestCleanupOwners.has(owner)) return;
  registeredTestCleanupOwners.add(owner);
  afterEach(() => cleanupTrackedProcesses({ scope: "test", owner }));
  afterAll(() => cleanupTrackedProcesses({ scope: "all", owner }));
}

function processGroupForPid(pid) {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const pgid = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(pgid) && pgid > 0
    ? pgid
    : null;
}

const testRunnerPgid = processGroupForPid(process.pid);

function keyFor({ pid, group }) {
  return `${group ? "group" : "pid"}:${pid}`;
}

function signalTracked(entry, signal) {
  try {
    if (entry.group && process.platform !== "win32") {
      process.kill(-entry.pid, signal);
    } else {
      process.kill(entry.pid, signal);
    }
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    return false;
  }
}

function isAlive(entry) {
  try {
    if (entry.group && process.platform !== "win32") {
      process.kill(-entry.pid, 0);
    } else {
      process.kill(entry.pid, 0);
    }
    return true;
  } catch (error) {
    return error?.code !== "ESRCH" && error?.code !== "EPERM";
  }
}

/**
 * Register an already-running test process (or detached process group).
 * Adapter tests use this after a fixture reports a PID owned by the adapter's
 * detached group; notifier fixtures use group:false because they have no
 * descendants and share the test runner's process group.
 */
export function trackProcess(
  pid,
  { group = true, scope = "test", owner = testFileForCaller() } = {},
) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    throw new Error(`cannot track invalid test process pid ${pid}`);
  }
  const entry = { pid: Number(pid), group, scope, owner };
  if (entry.group && testRunnerPgid !== null && entry.pid === testRunnerPgid) {
    throw new Error(
      `refusing to track the test runner process group ${testRunnerPgid}`,
    );
  }
  tracked.set(keyFor(entry), entry);
  return entry;
}

/** Find and register the detached process group containing pid. */
export function trackProcessGroupForPid(pid, options = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    throw new Error(
      `cannot track process group for invalid or incomplete test pid ${pid}`,
    );
  }
  // In a PID namespace `ps` can fail to resolve the runner during module
  // initialization. Refuse the runner by PID as well as by its resolved PGID
  // so cleanup can never register (and later signal) its own process group.
  if (Number(pid) === process.pid) {
    throw new Error("refusing to track the test runner process group");
  }
  if (process.platform === "win32")
    return trackProcess(pid, { ...options, group: false });
  const pgid = processGroupForPid(pid);
  if (pgid === null) {
    throw new Error(`could not resolve process group for test pid ${pid}`);
  }
  return trackProcess(pgid, { ...options, group: true });
}

/** Register every process group whose current command contains fragment. */
export function trackProcessGroupsMatching(fragment, options = {}) {
  if (!fragment) throw new Error("process-group command fragment is required");
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error("could not inspect test process groups");
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || !match[3].includes(fragment)) continue;
    const pgid = Number(match[2]);
    if (pgid > 0 && pgid !== testRunnerPgid) {
      trackProcess(pgid, { ...options, group: process.platform !== "win32" });
    }
  }
}

/** Register fake-runtime groups carrying one exact test-owner marker. */
export function trackMarkedFakeRuntimeGroups(marker, options = {}) {
  if (!marker) throw new Error("test process marker is required");
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error("could not inspect marked test process groups");
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, pgid, command] = match;
    if (!/event-runtime\/cli\.mjs\s+(serve|work)(\s|$)/.test(command)) continue;
    if (!/(^|\s)--adapter-override\s+fake(\s|$)/.test(command)) continue;
    if (!command.includes(`factory-test-${marker}`)) {
      const withEnv = spawnSync("ps", ["eww", "-p", pid, "-o", "command="], {
        encoding: "utf8",
      }).stdout;
      if (!withEnv.includes(`FACTORY_TEST_TRACKED_PROCESS=${marker}`)) continue;
    }
    const group = Number(pgid);
    if (group > 0 && group !== testRunnerPgid) trackProcess(group, options);
  }
}

/**
 * Source embedded in detached adapter/wrapper fixtures. A SIGKILLed Bun test
 * process cannot run hooks, so each detached fixture also watches its original
 * owner and destroys its own process group if that owner disappears.
 */
export function processOwnerWatchdogSource(ownerPid = process.pid) {
  if (!Number.isInteger(Number(ownerPid)) || Number(ownerPid) <= 0) {
    throw new Error(`cannot watch invalid test owner pid ${ownerPid}`);
  }
  return [
    `const __factoryTestOwnerPid = ${Number(ownerPid)};`,
    "const __factoryTestOwnerWatch = setInterval(() => {",
    "  try { process.kill(__factoryTestOwnerPid, 0); } catch {",
    '    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }',
    "  }",
    "}, 100);",
    "__factoryTestOwnerWatch.unref?.();",
  ].join("\n");
}

/**
 * Spawn a test-owned child in a new process group and register it immediately.
 * child.kill() is intentionally upgraded to signal the whole group, preserving
 * existing test cleanup while making wrappers and grandchildren impossible to
 * orphan.
 */
export function spawnTracked(command, args = [], options = {}, tracking = {}) {
  const marker = options.env?.FACTORY_TEST_TRACKED_PROCESS ?? defaultTestMarker;
  const childEnv = options.env
    ? { ...options.env, FACTORY_TEST_TRACKED_PROCESS: marker }
    : { ...process.env, FACTORY_TEST_TRACKED_PROCESS: marker };
  const child = spawn(command, args, {
    ...options,
    argv0: options.argv0 ?? `factory-test-${marker}`,
    env: childEnv,
    detached: process.platform !== "win32",
  });
  let entry = null;
  child.once("error", () => {
    if (entry) tracked.delete(keyFor(entry));
  });
  if (!child.pid) return child;
  entry = trackProcess(child.pid, {
    group: process.platform !== "win32",
    scope: tracking.scope ?? "test",
  });
  const originalKill = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    if (process.platform === "win32") return originalKill(signal);
    return signalTracked(entry, signal);
  };
  child.once("exit", () => {
    // A wrapper can exit before its descendants. Sweep the group once more
    // before forgetting it; ESRCH is the normal clean-exit case.
    signalTracked(entry, "SIGKILL");
    tracked.delete(keyFor(entry));
  });
  return child;
}

export async function cleanupTrackedProcesses({
  scope = "all",
  graceMs = 250,
  owner = testFileForCaller(),
} = {}) {
  const entries = [...tracked.values()].filter(
    (entry) =>
      (scope === "all" || entry.scope === scope) &&
      (owner === null || entry.owner === owner),
  );
  for (const entry of entries) signalTracked(entry, "SIGTERM");

  if (graceMs > 0 && entries.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
  }

  for (const entry of entries) {
    if (isAlive(entry)) signalTracked(entry, "SIGKILL");
    tracked.delete(keyFor(entry));
  }
}

function cleanupTrackedProcessesSync() {
  for (const entry of tracked.values()) signalTracked(entry, "SIGKILL");
  tracked.clear();
}

process.once("exit", cleanupTrackedProcessesSync);

// Bun may terminate a timed-out test file with a signal, which does not emit
// "exit" by itself. Re-raise after the synchronous group sweep so the original
// signal semantics and exit status are preserved.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (handlingSignal) return;
    handlingSignal = true;
    cleanupTrackedProcessesSync();
    process.off(signal, handler);
    process.kill(process.pid, signal);
  };
  process.on(signal, handler);
}

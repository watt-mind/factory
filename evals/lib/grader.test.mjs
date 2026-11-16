import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { callClaude } from "./grader.mjs";
import {
  registerTestProcessCleanup,
  trackProcess,
  trackProcessGroupForPid,
} from "../../event-runtime/lib/test-helpers-process.mjs";
import { loadAdjustedTimeout } from "../../event-runtime/lib/test-helpers-timing.mjs";

registerTestProcessCleanup(import.meta.url);

const temporaryDirectories = new Set();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 999_999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.signals = [];
  // Records every process-group signal instead of letting the shared helper
  // reach process.kill(-pid, …) — a fake pid must never signal a live group.
  child.killFn = (pid, signal) => {
    expect(pid).toBe(-child.pid);
    child.signals.push(signal);
    child.emit("signal", signal);
  };
  child.kill = (signal) => {
    throw new Error(
      `child.kill(${signal}) must not be reached: killFn was injected`,
    );
  };
  return child;
}

function waitForSignal(child, signal) {
  if (child.signals.includes(signal)) return Promise.resolve();
  return new Promise((resolve) => {
    child.on("signal", (received) => {
      if (received === signal) resolve();
    });
  });
}

function graderCall(child, options = {}) {
  return callClaude({
    prompt: "grade this",
    model: "test-model",
    cwd: process.cwd(),
    timeoutMs: 10,
    budgetUsd: 1,
    killGraceMs: 10,
    killFn: child.killFn,
    spawnFn: () => child,
    ...options,
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForGrandchildPid(pidFile) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture did not report its grandchild PID");
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(processExists(pid)).toBe(false);
}

function realFixtureCall({ detached }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grader-process-"));
  temporaryDirectories.add(directory);
  const pidFile = path.join(directory, "grandchild.pid");
  const fixture = `
    const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 10000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.write(${JSON.stringify(pidFile)}, String(grandchild.pid));
    setInterval(() => {}, 10000);
  `;

  const spawnFn = (_command, _args, options) => {
    const child = spawn(process.execPath, ["-e", fixture], {
      ...options,
      detached,
    });
    if (detached) {
      trackProcessGroupForPid(child.pid, { owner: import.meta.url });
    } else {
      // The control deliberately shares the test runner's process group, so
      // track the child itself rather than ever registering that whole group.
      trackProcess(child.pid, {
        group: false,
        owner: import.meta.url,
      });
    }
    return child;
  };

  const killFn = detached
    ? process.kill
    : (_pid, _signal) => {
        // Make killProcessGroup's direct-child fallback observable in the
        // non-detached control without signalling the test runner's group.
        throw new Error("force direct-child fallback");
      };

  return {
    pidFile,
    pending: callClaude({
      prompt: "grade this",
      model: "test-model",
      cwd: process.cwd(),
      // Two Bun cold starts race this deadline on a loaded runner.
      timeoutMs: loadAdjustedTimeout(5000),
      budgetUsd: 1,
      killGraceMs: 100,
      killFn,
      spawnFn,
    }),
  };
}

describe("grader process termination", () => {
  test("sends TERM then KILL after the configured grace period", async () => {
    const child = fakeChild();
    const pending = graderCall(child);

    await waitForSignal(child, "SIGKILL");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    child.emit("close", 1);
    await pending;
  });

  test("deduplicates abort and timeout termination", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const pending = graderCall(child, { signal: controller.signal });
    controller.abort();

    await waitForSignal(child, "SIGKILL");
    // Abort and timeout both escalate, yet exactly one TERM and one KILL land.
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signals).toHaveLength(2);

    child.emit("close", 1);
    await pending;
  });

  test(
    "timeout kills a real detached process group without orphaning a grandchild",
    async () => {
      const run = realFixtureCall({ detached: true });
      const grandchildPid = await waitForGrandchildPid(run.pidFile);
      expect(processExists(grandchildPid)).toBe(true);

      const outcome = await run.pending;
      expect(outcome.timedOut).toBe(true);
      await waitForProcessExit(grandchildPid);
    },
    { timeout: loadAdjustedTimeout(20_000) },
  );

  test(
    "non-detached control leaves the real grandchild alive",
    async () => {
      const run = realFixtureCall({ detached: false });
      const grandchildPid = await waitForGrandchildPid(run.pidFile);
      trackProcess(grandchildPid, { group: false, owner: import.meta.url });
      expect(processExists(grandchildPid)).toBe(true);

      const outcome = await run.pending;
      expect(outcome.timedOut).toBe(true);
      expect(processExists(grandchildPid)).toBe(true);
    },
    { timeout: loadAdjustedTimeout(20_000) },
  );
});

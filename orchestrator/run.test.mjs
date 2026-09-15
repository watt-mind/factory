import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  createChildTracker,
  createJobRunner,
  createShutdownController,
} from "./run.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function runnableChild() {
  const child = fakeChild();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function shutdownHarness(childTracker, overrides = {}) {
  const exits = [];
  const logs = [];
  let timersCleared = 0;
  const shutdown = createShutdownController({
    childTracker,
    clearTimers: () => {
      timersCleared++;
    },
    getCounts: () => ({ completed: 2, failed: 0 }),
    getRunningNames: () => ["dispatch"],
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
    ...overrides,
  });
  return {
    shutdown,
    exits,
    logs,
    get timersCleared() {
      return timersCleared;
    },
  };
}

test("active child processes are tracked and removed when they close", async () => {
  const tracker = createChildTracker();
  const first = fakeChild();
  const second = fakeChild();

  expect(tracker.track(first)).toBe(first);
  tracker.track(second);
  expect(tracker.size).toBe(2);
  expect(tracker.active.has(first)).toBe(true);

  first.emit("close", 0);
  expect(tracker.size).toBe(1);
  expect(tracker.active.has(first)).toBe(false);

  second.emit("close", 0);
  expect(tracker.size).toBe(0);
  expect(await tracker.waitForEmpty(20)).toBe(true);
});

test("shutdown forwards SIGTERM and waits for active children to settle", async () => {
  const tracker = createChildTracker();
  const child = fakeChild();
  tracker.track(child);
  const harness = shutdownHarness(tracker);
  let settled = false;

  const pending = harness.shutdown("SIGINT").then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();

  expect(harness.timersCleared).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(settled).toBe(false);
  expect(harness.exits).toEqual([]);

  child.emit("close", 0);
  const result = await pending;
  expect(result).toEqual({ forced: false, drained: true });
  expect(harness.exits).toEqual([0]);
});

test("shutdown stops waiting at its deadline", async () => {
  const tracker = createChildTracker();
  tracker.track(fakeChild());
  const harness = shutdownHarness(tracker, { timeoutMs: 10 });

  const result = await harness.shutdown("SIGTERM");

  expect(result).toEqual({ forced: false, drained: false });
  expect(harness.exits).toEqual([0]);
  expect(harness.logs.some((line) => line.includes("deadline reached"))).toBe(
    true,
  );
});

test("a second interrupt exits immediately with code 130", async () => {
  let terminateCalls = 0;
  const childTracker = {
    size: 1,
    terminateAll: () => {
      terminateCalls++;
    },
    waitForEmpty: () => new Promise(() => {}),
  };
  const harness = shutdownHarness(childTracker);

  void harness.shutdown("SIGINT");
  const result = await harness.shutdown("SIGTERM");

  expect(terminateCalls).toBe(1);
  expect(harness.timersCleared).toBe(1);
  expect(result).toEqual({ forced: true, drained: false });
  expect(harness.exits).toEqual([130]);
});

test("a pending gate reserves its job so overlapping ticks neither probe nor spawn", async () => {
  const running = new Set();
  const logs = [];
  let releaseGate;
  let probes = 0;
  let spawns = 0;
  const child = runnableChild();
  const runJob = createJobRunner({
    running,
    probe: () => {
      probes++;
      return new Promise((resolve) => {
        releaseGate = () => resolve({ code: 0, out: "work found" });
      });
    },
    spawnCommand: () => {
      spawns++;
      return child;
    },
    commandFor: () => "echo work",
    shouldProbeGate: true,
    log: (message) => logs.push(message),
  });
  const job = { name: "dispatch", gate_command: "queue --gate" };

  const first = runJob(job);
  await Promise.resolve();
  await runJob(job);

  expect(probes).toBe(1);
  expect(spawns).toBe(0);
  expect(
    logs.some((message) => message.includes("previous run still going")),
  ).toBe(true);

  releaseGate();
  await Promise.resolve();
  expect(spawns).toBe(1);
  child.emit("close", 0);
  await first;
  expect(running.size).toBe(0);
});

test("an idle gate releases its job for the next tick", async () => {
  const running = new Set();
  let probes = 0;
  const runJob = createJobRunner({
    running,
    probe: () => {
      probes++;
      return Promise.resolve({ code: 1, out: "nothing to do" });
    },
    spawnCommand: () => {
      throw new Error("idle gate must not spawn");
    },
    commandFor: () => "echo work",
    shouldProbeGate: true,
  });
  const job = { name: "dispatch", gate_command: "queue --gate" };

  await runJob(job);
  await runJob(job);

  expect(probes).toBe(2);
  expect(running.size).toBe(0);
});

test("a rejected gate probe releases its job for the next tick", async () => {
  const running = new Set();
  const logs = [];
  let failed = 0;
  let probes = 0;
  const runJob = createJobRunner({
    running,
    probe: () => {
      probes++;
      return Promise.reject(new Error("gate unavailable"));
    },
    spawnCommand: () => {
      throw new Error("failed gate must not spawn");
    },
    commandFor: () => "echo work",
    shouldProbeGate: true,
    log: (message) => logs.push(message),
    onFailed: () => {
      failed++;
    },
  });
  const job = { name: "dispatch", gate_command: "queue --gate" };

  await runJob(job);
  await runJob(job);

  expect(probes).toBe(2);
  expect(failed).toBe(2);
  expect(logs.every((message) => message.includes("GATE FAIL"))).toBe(true);
  expect(running.size).toBe(0);
});

test("a synchronous spawn failure is labeled separately from a gate failure", async () => {
  const running = new Set();
  const logs = [];
  let failed = 0;
  const runJob = createJobRunner({
    running,
    probe: () => Promise.resolve({ code: 0, out: "work found" }),
    spawnCommand: () => {
      throw new Error("spawn unavailable");
    },
    commandFor: () => "echo work",
    shouldProbeGate: false,
    log: (message) => logs.push(message),
    onFailed: () => {
      failed++;
    },
  });

  await runJob({ name: "dispatch" });

  expect(failed).toBe(1);
  expect(logs.some((message) => message.includes("SPAWN FAIL"))).toBe(true);
  expect(logs.some((message) => message.includes("GATE FAIL"))).toBe(false);
  expect(running.size).toBe(0);
});

test("a child error is labeled separately from a gate failure", async () => {
  const running = new Set();
  const logs = [];
  let failed = 0;
  const child = runnableChild();
  const runJob = createJobRunner({
    running,
    probe: () => Promise.resolve({ code: 0, out: "work found" }),
    spawnCommand: () => child,
    commandFor: () => "echo work",
    shouldProbeGate: false,
    log: (message) => logs.push(message),
    onFailed: () => {
      failed++;
    },
  });

  const run = runJob({ name: "dispatch" });
  await Promise.resolve();
  child.emit("error", new Error("ENOENT"));
  await run;

  expect(failed).toBe(1);
  expect(logs.some((message) => message.includes("SPAWN FAIL"))).toBe(true);
  expect(logs.some((message) => message.includes("GATE FAIL"))).toBe(false);
  expect(running.size).toBe(0);
});

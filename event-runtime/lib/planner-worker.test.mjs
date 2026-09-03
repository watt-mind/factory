import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  evaluateMainLoopObservation,
  MAIN_LOOP_HARD_STALL_OBSERVATIONS,
  startPlannerWorker,
} from "./planner-worker.mjs";
import { until } from "./test-helpers-timing.mjs";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-planner-worker-test-mjs";

test("planner worker reports an aged main-loop heartbeat and clears it on recovery", async () => {
  const logs = [];
  const planner = startPlannerWorker({
    eventHome: tmpDir("planner-heartbeat-"),
    heartbeatIntervalMs: 50,
    mainLoopStallAfterMs: 200,
    log: (line) => logs.push(line),
  });
  try {
    planner.heartbeat("reconcile-inbox");
    await until(
      "the worker to receive the main-loop heartbeat",
      () =>
        planner.state().mainLoopHeartbeat?.lastTickStep === "reconcile-inbox",
      { timeoutMs: 5_000 },
    );
    await until(
      "the worker to observe the missing heartbeat",
      () => planner.state().mainLoopHeartbeat?.stalled === true,
      { timeoutMs: 5_000 },
    );
    expect(planner.state().mainLoopHeartbeat).toMatchObject({
      stalled: true,
      staleAfterMs: 200,
      lastTickStep: "reconcile-inbox",
    });
    expect(logs.some((line) => line.includes("heartbeat stalled"))).toBe(true);

    planner.heartbeat("announce-transitions");
    await until(
      "the worker to clear its heartbeat stall",
      () =>
        planner.state().mainLoopHeartbeat?.stalled === false &&
        planner.state().mainLoopHeartbeat?.lastTickStep ===
          "announce-transitions",
      { timeoutMs: 5_000 },
    );
    expect(logs.some((line) => line.includes("heartbeat recovered"))).toBe(
      true,
    );
  } finally {
    await planner.stop();
  }
});

test("an explicitly enabled hard heartbeat threshold terminates the wedged serve process", () => {
  const home = tmpDir("planner-hard-heartbeat-");
  const result = runStarvedWorker(home, {
    heartbeatIntervalMs: 50,
    mainLoopStallAfterMs: 100,
    mainLoopHardStallAfterMs: 200,
    exitAfterMs: 5_000,
  });
  expect(result.error).toBeUndefined();
  // The kill is the contract: a supervisor restarts on the signal, and a
  // clean non-zero exit would be indistinguishable from an ordinary crash.
  expect(result.signal).toBe("SIGKILL");
});

test("the default hard threshold leaves a stalled main loop reported but alive", () => {
  const home = tmpDir("planner-soft-heartbeat-");
  // No mainLoopHardStallAfterMs: the default. 1s is ten soft windows.
  const result = runStarvedWorker(home, {
    heartbeatIntervalMs: 50,
    mainLoopStallAfterMs: 100,
    exitAfterMs: 1_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  // 0 = stalled and alive; 3 = alive but never observed the stall.
  expect(result.status).toBe(0);
});

test("an observation that follows a descheduled worker cannot report a stall", () => {
  const heartbeatIntervalMs = 250;
  // The worker's own timer slipped 9s: heartbeats the main loop posted during
  // that window are still queued, so the raw age is meaningless this round.
  const decision = evaluateMainLoopObservation({
    nowMono: 10_000,
    lastHeartbeatMono: 1_000,
    lastObservationMono: 1_000,
    heartbeatIntervalMs,
    mainLoopStallAfterMs: 5_000,
    mainLoopHardStallAfterMs: 8_000,
    consecutiveStalledObservations: 2,
  });
  expect(decision.workerDescheduled).toBe(true);
  expect(decision.stalled).toBe(false);
  expect(decision.hardStall).toBe(false);
  expect(decision.consecutiveStalledObservations).toBe(0);
  // The blocked window is credited forward, so the next round starts from a
  // fresh age rather than inheriting the worker's own outage.
  expect(decision.ageMs).toBe(heartbeatIntervalMs);
});

test("a hard stall needs consecutive stalled observations, not one unlucky round", () => {
  const base = {
    nowMono: 20_000,
    lastHeartbeatMono: 0,
    lastObservationMono: 19_800,
    heartbeatIntervalMs: 250,
    mainLoopStallAfterMs: 5_000,
    mainLoopHardStallAfterMs: 15_000,
  };
  const first = evaluateMainLoopObservation({
    ...base,
    consecutiveStalledObservations: 0,
  });
  expect(first.stalled).toBe(true);
  expect(first.hardStall).toBe(false);
  expect(first.consecutiveStalledObservations).toBe(1);

  expect(
    evaluateMainLoopObservation({ ...base, consecutiveStalledObservations: 1 })
      .hardStall,
  ).toBe(false);
  expect(
    evaluateMainLoopObservation({
      ...base,
      consecutiveStalledObservations: MAIN_LOOP_HARD_STALL_OBSERVATIONS - 1,
    }).hardStall,
  ).toBe(true);
});

test("a heartbeat within the stall window clears the consecutive count", () => {
  const decision = evaluateMainLoopObservation({
    nowMono: 1_000,
    lastHeartbeatMono: 900,
    lastObservationMono: 750,
    heartbeatIntervalMs: 250,
    mainLoopStallAfterMs: 5_000,
    mainLoopHardStallAfterMs: 15_000,
    consecutiveStalledObservations: 2,
  });
  expect(decision.stalled).toBe(false);
  expect(decision.hardStall).toBe(false);
  expect(decision.consecutiveStalledObservations).toBe(0);
});

/**
 * Run a planner worker in its own process that never sends a main-loop
 * heartbeat, and let it exit on its own after `exitAfterMs`. A hard-stall
 * SIGKILL therefore shows up as a signal, and its absence as status 0/3.
 */
function runStarvedWorker(home, { exitAfterMs, ...options }) {
  const script = `${home}/starved-worker.mjs`;
  writeFileSync(
    script,
    [
      `import { startPlannerWorker } from ${JSON.stringify(new URL("./planner-worker.mjs", import.meta.url).href)};`,
      `const planner = startPlannerWorker({ eventHome: ${JSON.stringify(home)}, ...${JSON.stringify(options)} });`,
      `setTimeout(() => {`,
      `  const stalled = planner.state().mainLoopHeartbeat?.stalled === true;`,
      `  process.exit(stalled ? 0 : 3);`,
      `}, ${exitAfterMs});`,
      "",
    ].join("\n"),
  );

  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

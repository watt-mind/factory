/**
 * Dedicated Bun Worker thread for background planning (WM-1208).
 *
 * Runs planning off the main HTTP event loop so slow tracker reads and
 * synchronous subprocesses never block serve's GET / POST handlers.
 */
import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  evaluateMainLoopObservation,
  MAIN_LOOP_HARD_STALL_OBSERVATIONS,
} from "./planner-worker.mjs";
import { planAdmittedEvents } from "./planner.mjs";

const {
  eventHome,
  policyVersion,
  adapterOverride = null,
  pollMs = 250,
  heartbeatIntervalMs = 250,
  mainLoopStallAfterMs = 5_000,
  mainLoopHardStallAfterMs = null,
} = workerData || {};

const targetDbPath = path.join(eventHome || process.cwd(), "runtime.db");
const db = openDb(targetDbPath);
const registry = loadRegistry();

let busy = false;
// Age arithmetic runs on the monotonic clock; the wall clock is only ever used
// for the human-readable `lastAt` field an operator reads in /health.
let lastMainLoopHeartbeatMono = performance.now();
let lastMainLoopHeartbeatWallMs = Date.now();
let lastObservationMono = null;
let lastMainLoopTickStep = null;
let mainLoopStalled = false;
let consecutiveStalledObservations = 0;
let hardStallTriggered = false;
let hardStallArmed = mainLoopHardStallAfterMs != null;
// The stall/recovered transitions below are posted on their own; echoing every
// observation as well would put four messages a second on the port for no new
// information. Echo at ~1Hz, plus whenever something actually changed.
const echoIntervalMs = Math.max(1_000, heartbeatIntervalMs);
let lastEchoMono = null;
let lastEchoedTickStep = null;

function observationPayload(ageMs, stalled) {
  return {
    lastAt: new Date(lastMainLoopHeartbeatWallMs).toISOString(),
    ageMs: Math.round(ageMs),
    stalled,
    staleAfterMs: mainLoopStallAfterMs,
    lastTickStep: lastMainLoopTickStep,
  };
}

function observeMainLoopHeartbeat() {
  const now = performance.now();
  const decision = evaluateMainLoopObservation({
    nowMono: now,
    lastHeartbeatMono: lastMainLoopHeartbeatMono,
    lastObservationMono,
    heartbeatIntervalMs,
    mainLoopStallAfterMs,
    mainLoopHardStallAfterMs: hardStallArmed ? mainLoopHardStallAfterMs : null,
    consecutiveStalledObservations,
    requiredStalledObservations: MAIN_LOOP_HARD_STALL_OBSERVATIONS,
  });
  lastObservationMono = now;
  lastMainLoopHeartbeatMono = decision.lastHeartbeatMono;
  consecutiveStalledObservations = decision.consecutiveStalledObservations;

  // This round says nothing about the main loop — the worker itself was off
  // CPU. Say nothing, and wait for the queued heartbeats to be delivered.
  if (decision.workerDescheduled) return;

  const observation = observationPayload(decision.ageMs, decision.stalled);
  const transitioned = decision.stalled !== mainLoopStalled;
  if (transitioned) {
    parentPort?.postMessage({
      type: decision.stalled ? "main-loop-stall" : "main-loop-recovered",
      ...observation,
    });
  }
  mainLoopStalled = decision.stalled;

  if (
    transitioned ||
    lastEchoedTickStep !== lastMainLoopTickStep ||
    lastEchoMono == null ||
    now - lastEchoMono >= echoIntervalMs
  ) {
    lastEchoMono = now;
    lastEchoedTickStep = lastMainLoopTickStep;
    parentPort?.postMessage({ type: "main-loop-heartbeat", ...observation });
  }

  if (decision.hardStall && !hardStallTriggered) {
    hardStallTriggered = true;
    parentPort?.postMessage({ type: "main-loop-hard-stall", ...observation });
    // A main-loop wedge cannot service its message queue or signal handlers.
    // This is deliberately opt-in: SIGKILL gives a supervisor an unambiguous
    // non-zero exit so it can restart a genuinely stuck serve process.
    process.kill(process.pid, "SIGKILL");
  }
}

async function tickPlanner() {
  if (busy) return;
  busy = true;
  try {
    const outcome = planAdmittedEvents(db, registry, {
      now: Date.now(),
      policyVersion,
      adapterOverride,
    });
    if (outcome?.planned > 0) {
      parentPort?.postMessage({
        type: "planned",
        count: outcome.planned,
        outcome,
      });
    }
  } catch (err) {
    parentPort?.postMessage({ type: "error", message: err.message });
  } finally {
    busy = false;
  }
}

const interval = setInterval(tickPlanner, pollMs);
const heartbeatInterval = setInterval(
  observeMainLoopHeartbeat,
  heartbeatIntervalMs,
);
tickPlanner();

parentPort?.on("message", (msg) => {
  if (msg?.type === "wake" || msg?.type === "admitted") {
    tickPlanner();
  } else if (msg?.type === "main-loop-heartbeat") {
    lastMainLoopHeartbeatMono = performance.now();
    lastMainLoopHeartbeatWallMs = Date.now();
    lastMainLoopTickStep = msg.currentTickStep ?? null;
    consecutiveStalledObservations = 0;
    hardStallTriggered = false;
  } else if (msg?.type === "main-loop-watchdog-disarm") {
    hardStallArmed = false;
  } else if (msg?.type === "stop") {
    clearInterval(interval);
    clearInterval(heartbeatInterval);
    process.exit(0);
  }
});

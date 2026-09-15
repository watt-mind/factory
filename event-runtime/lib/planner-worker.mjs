/**
 * Planner Worker supervisor for serve (WM-1208).
 *
 * Spawns and supervises a dedicated background Worker thread for event planning.
 */
import { Worker } from "node:worker_threads";
import { runtimeHome } from "./config.mjs";

// Planning normally finishes within the worker's 250ms poll interval. Five
// minutes leaves room for tracker/API slowness while making a wedged planner
// visible well before queued intake becomes operationally surprising.
export const PLANNER_STALE_AFTER_MS = 5 * 60 * 1000;
export const MAIN_LOOP_HEARTBEAT_INTERVAL_MS = 250;
export const MAIN_LOOP_STALL_AFTER_MS = 5_000;
// A hard threshold below a few soft windows would turn ordinary tick slowness
// into a restart, so an operator's value is clamped up to this floor.
export const MAIN_LOOP_HARD_STALL_FLOOR_MS = MAIN_LOOP_STALL_AFTER_MS * 3;
// The hard branch kills the process, so one unlucky observation must never be
// enough: require this many in a row, each spaced by the heartbeat interval.
export const MAIN_LOOP_HARD_STALL_OBSERVATIONS = 3;
// The worker and the main loop share a process. When the worker's own timer
// slips by more than this multiple of its interval the worker — not the main
// loop — is what stopped running, and heartbeats are still queued behind it.
export const WORKER_DESCHEDULED_INTERVALS = 4;

/**
 * Decide what one heartbeat observation means. Pure so the awkward cases —
 * a descheduled worker, a not-yet-repeated stall — are testable without a
 * thread, and so the kill decision has exactly one implementation.
 *
 * All time inputs are monotonic (`performance.now()`): a wall-clock step from
 * NTP or a suspend/resume must not synthesize a stall.
 */
export function evaluateMainLoopObservation({
  nowMono,
  lastHeartbeatMono,
  lastObservationMono = null,
  heartbeatIntervalMs = MAIN_LOOP_HEARTBEAT_INTERVAL_MS,
  mainLoopStallAfterMs = MAIN_LOOP_STALL_AFTER_MS,
  mainLoopHardStallAfterMs = null,
  consecutiveStalledObservations = 0,
  requiredStalledObservations = MAIN_LOOP_HARD_STALL_OBSERVATIONS,
}) {
  const observationGapMs =
    lastObservationMono == null
      ? 0
      : Math.max(0, nowMono - lastObservationMono);

  // The worker's own loop was blocked (a synchronous SQLite pass in
  // tickPlanner, say). Heartbeats the main loop already posted are sitting
  // undelivered in the port queue, and after a long block libuv runs timers
  // before poll — so this observation sees an age the main loop never had.
  // Credit the blocked window forward and skip the decision this round.
  if (observationGapMs > heartbeatIntervalMs * WORKER_DESCHEDULED_INTERVALS) {
    const creditedMono = Math.min(
      nowMono,
      lastHeartbeatMono + (observationGapMs - heartbeatIntervalMs),
    );
    return {
      workerDescheduled: true,
      observationGapMs,
      lastHeartbeatMono: creditedMono,
      ageMs: Math.max(0, nowMono - creditedMono),
      stalled: false,
      hardStall: false,
      consecutiveStalledObservations: 0,
    };
  }

  const ageMs = Math.max(0, nowMono - lastHeartbeatMono);
  const stalled = ageMs >= mainLoopStallAfterMs;
  const nextConsecutive = stalled ? consecutiveStalledObservations + 1 : 0;
  return {
    workerDescheduled: false,
    observationGapMs,
    lastHeartbeatMono,
    ageMs,
    stalled,
    hardStall:
      mainLoopHardStallAfterMs != null &&
      ageMs >= mainLoopHardStallAfterMs &&
      nextConsecutive >= requiredStalledObservations,
    consecutiveStalledObservations: nextConsecutive,
  };
}

export function startPlannerWorker({
  eventHome = runtimeHome(),
  policyVersion = "unknown",
  adapterOverride = null,
  pollMs = 250,
  heartbeatIntervalMs = MAIN_LOOP_HEARTBEAT_INTERVAL_MS,
  mainLoopStallAfterMs = MAIN_LOOP_STALL_AFTER_MS,
  mainLoopHardStallAfterMs = null,
  log = console.log,
} = {}) {
  const workerUrl = new URL("./planner-worker-thread.mjs", import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: {
      eventHome,
      policyVersion,
      adapterOverride,
      pollMs,
      heartbeatIntervalMs,
      mainLoopStallAfterMs,
      mainLoopHardStallAfterMs,
    },
  });
  let lastPlannedAt = null;
  let mainLoopHeartbeat = null;
  let alive = true;
  let stopping = false;

  worker.on("message", (msg) => {
    if (msg?.type === "planned") {
      lastPlannedAt = new Date().toISOString();
      log(`planner worker: planned ${msg.count} event(s)`);
    } else if (msg?.type === "error") {
      log(`planner worker error: ${msg.message}`);
    } else if (msg?.type === "main-loop-heartbeat") {
      mainLoopHeartbeat = {
        lastAt: msg.lastAt,
        ageMs: msg.ageMs,
        stalled: msg.stalled,
        staleAfterMs: msg.staleAfterMs,
        lastTickStep: msg.lastTickStep,
      };
    } else if (msg?.type === "main-loop-stall") {
      mainLoopHeartbeat = {
        lastAt: msg.lastAt,
        ageMs: msg.ageMs,
        stalled: true,
        staleAfterMs: msg.staleAfterMs,
        lastTickStep: msg.lastTickStep,
      };
      log(
        `planner worker: main-loop heartbeat stalled for ${msg.ageMs}ms at step ${msg.lastTickStep ?? "idle"}`,
      );
    } else if (msg?.type === "main-loop-recovered") {
      mainLoopHeartbeat = {
        lastAt: msg.lastAt,
        ageMs: msg.ageMs,
        stalled: false,
        staleAfterMs: msg.staleAfterMs,
        lastTickStep: msg.lastTickStep,
      };
      log("planner worker: main-loop heartbeat recovered");
    }
  });

  worker.on("error", (err) => {
    log(`planner worker thread error: ${err.message}`);
  });

  worker.on("exit", (code) => {
    alive = false;
    if (!(stopping && code === 0)) {
      log(`planner worker thread exited with code ${code}`);
    }
  });

  return {
    worker,
    wake: () => worker.postMessage({ type: "wake" }),
    heartbeat: (currentTickStep = null) =>
      worker.postMessage({ type: "main-loop-heartbeat", currentTickStep }),
    // A graceful shutdown stops heartbeating on purpose, and the bounded stops
    // it then waits on can legitimately take seconds. Disarm first so an
    // orderly exit can never be converted into a SIGKILL before the serve lock
    // is released.
    disarmHardStall: () => {
      try {
        worker.postMessage({ type: "main-loop-watchdog-disarm" });
      } catch {
        /* the thread is already gone; nothing left to disarm */
      }
    },
    state: ({ nowMs = Date.now(), queued = false } = {}) => {
      const plannedMs = lastPlannedAt ? Date.parse(lastPlannedAt) : Number.NaN;
      const ageMs = Number.isNaN(plannedMs)
        ? null
        : Math.max(0, nowMs - plannedMs);
      return {
        lastPlannedAt,
        ageMs,
        stale:
          !alive ||
          (queued && (ageMs === null || ageMs >= PLANNER_STALE_AFTER_MS)),
        staleAfterMs: PLANNER_STALE_AFTER_MS,
        alive,
        mainLoopHeartbeat,
      };
    },
    stop: async () => {
      stopping = true;
      try {
        worker.postMessage({ type: "main-loop-watchdog-disarm" });
        worker.postMessage({ type: "stop" });
        await worker.terminate();
      } catch {
        /* best effort */
      }
    },
  };
}

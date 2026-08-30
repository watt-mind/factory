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

export function startPlannerWorker({
  eventHome = runtimeHome(),
  policyVersion = "unknown",
  adapterOverride = null,
  pollMs = 250,
  log = console.log,
} = {}) {
  const workerUrl = new URL("./planner-worker-thread.mjs", import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: {
      eventHome,
      policyVersion,
      adapterOverride,
      pollMs,
    },
  });
  let lastPlannedAt = null;
  let alive = true;
  let stopping = false;

  worker.on("message", (msg) => {
    if (msg?.type === "planned") {
      lastPlannedAt = new Date().toISOString();
      log(`planner worker: planned ${msg.count} event(s)`);
    } else if (msg?.type === "error") {
      log(`planner worker error: ${msg.message}`);
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
      };
    },
    stop: async () => {
      stopping = true;
      try {
        worker.postMessage({ type: "stop" });
        await worker.terminate();
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Planner Worker supervisor for serve (WM-1208).
 *
 * Spawns and supervises a dedicated background Worker thread for event planning.
 */
import { Worker } from "node:worker_threads";
import { runtimeHome } from "./config.mjs";

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

  worker.on("message", (msg) => {
    if (msg?.type === "planned") {
      log(`planner worker: planned ${msg.count} event(s)`);
    } else if (msg?.type === "error") {
      log(`planner worker error: ${msg.message}`);
    }
  });

  worker.on("error", (err) => {
    log(`planner worker thread error: ${err.message}`);
  });

  return {
    worker,
    wake: () => worker.postMessage({ type: "wake" }),
    stop: async () => {
      try {
        worker.postMessage({ type: "stop" });
        await worker.terminate();
      } catch {
        /* best effort */
      }
    },
  };
}

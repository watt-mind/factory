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
import { planAdmittedEvents } from "./planner.mjs";

const {
  eventHome,
  policyVersion,
  adapterOverride = null,
  pollMs = 250,
} = workerData || {};

const targetDbPath = path.join(eventHome || process.cwd(), "runtime.db");
const db = openDb(targetDbPath);
const registry = loadRegistry();

let busy = false;

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
tickPlanner();

parentPort?.on("message", (msg) => {
  if (msg?.type === "wake" || msg?.type === "admitted") {
    tickPlanner();
  } else if (msg?.type === "stop") {
    clearInterval(interval);
    process.exit(0);
  }
});

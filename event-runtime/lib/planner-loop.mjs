/**
 * Standalone and off-loop planner execution loop (WM-1208).
 *
 * Runs deterministic event planning off the HTTP event loop so slow tracker
 * reads and CPU-bound plan evaluation never block control API request handlers.
 */
import { planAdmittedEvents } from "./planner.mjs";

export async function runPlannerLoop({
  db,
  registry,
  policyVersion,
  adapterOverride,
  pollMs = 250,
  signal = null,
  log = console.log,
} = {}) {
  let running = true;
  let plannedTotal = 0;

  if (signal) {
    signal.addEventListener("abort", () => {
      running = false;
    });
  }

  async function planPass() {
    try {
      const outcome = planAdmittedEvents(db, registry, {
        now: Date.now(),
        policyVersion,
        adapterOverride,
      });
      if (outcome && outcome.length > 0) {
        plannedTotal += outcome.length;
        for (const o of outcome) {
          if (o.proposalId) {
            log(`planned event ${o.eventId} → proposal ${o.proposalId}`);
          } else if (o.decision) {
            log(
              `planned event ${o.eventId} → decision ${o.decision} (${o.reason ?? "-"})`,
            );
          }
        }
      }
      return outcome;
    } catch (err) {
      log(`planner error: ${err.message}`);
      return [];
    }
  }

  while (running) {
    await planPass();
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return { plannedTotal };
}

/**
 * Lease reaper for the event runtime (docs/event-runtime.md §8; OPS-416, OPS-431).
 *
 * Sweeps LEASED, RUNNING, and VERIFYING attempts whose lease has expired.
 * Recovers stranded attempts by re-queuing (if attempts < maxAttempts)
 * or dead-lettering to FAILED (if maxAttempts exhausted).
 * Prunes long-stopped workers during the reap cycle (OPS-431).
 */
import { reapExpiredLeases as reapLeases } from "./worker.mjs";
import { pruneWorkers } from "./workers.mjs";

export function reapExpiredLeases(db, opts = {}) {
  const errors = [];
  const reaped = reapLeases(db, {
    ...opts,
    onError: (error) => errors.push(error),
  });
  pruneWorkers(db, opts);
  return { reaped, errors };
}

export { pruneWorkers };

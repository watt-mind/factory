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

/**
 * Reap expired leases, then prune stale workers.
 *
 * Every per-row failure is logged (so a poisoned row skipped tick after tick
 * is visible in the serve log, whose caller discards the return value) AND
 * collected as `{ runId, error }` with the original Error intact, so callers
 * that do inspect the result keep stack and cause.
 */
export function reapExpiredLeases(db, opts = {}) {
  const errors = [];
  const log = opts.log ?? ((line) => console.error(line));
  const reaped = reapLeases(db, {
    ...opts,
    onError: ({ runId, error }) => {
      errors.push({ runId, error });
      log(
        `[reaper] expired lease ${runId} skipped: ${error?.message ?? String(error)}`,
      );
    },
  });
  pruneWorkers(db, opts);
  return { reaped, errors };
}

export { pruneWorkers };

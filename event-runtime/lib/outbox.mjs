/**
 * Outbox delivery (docs/event-runtime.md §8, §15).
 *
 * Result events are written to the outbox in the same transaction as the
 * accepted result; delivery happens afterwards, at least once. The MVP's only
 * sink is the watched operator terminal — §15: the output is displayed and
 * causes no further action. A row is stamped published only after its sink
 * call returns, so a sink crash re-delivers rather than drops.
 */
import { tx } from "./db.mjs";

export const DEFAULT_OUTBOX_RETENTION_DAYS = 14;
export const DEFAULT_OUTBOX_BATCH_SIZE = 500;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Delete published rows older than the configured retention window. */
export function sweepPublishedOutbox(
  db,
  { retentionDays = DEFAULT_OUTBOX_RETENTION_DAYS, now = Date.now() } = {},
) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("retentionDays must be a positive number of days");
  }
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
  return tx(
    db,
    () =>
      db
        .query(
          `DELETE FROM outbox
           WHERE published_at IS NOT NULL AND published_at < ?`,
        )
        .run(cutoff).changes,
  );
}

/**
 * Deliver one bounded batch of unpublished outbox events to
 * `sink(envelope, row)` in insertion order. Each successful delivery is
 * stamped. Failures retry in order until `maxAttempts`; the final failure is
 * parked, logged, and allows the following row to proceed.
 *
 * Published rows are pruned only after delivery, retaining a configurable
 * bounded window. Unpublished rows are never eligible for pruning.
 *
 * @returns {{ delivered: number, remaining: number }} rows delivered and still pending
 */
export function publishOutbox(
  db,
  {
    sink,
    now = Date.now(),
    retentionDays = DEFAULT_OUTBOX_RETENTION_DAYS,
    batchSize = DEFAULT_OUTBOX_BATCH_SIZE,
    maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
    log = () => {},
  } = {},
) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  const rows = db
    .query(
      `SELECT seq, event_json, delivery_attempts
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY seq
       LIMIT ?`,
    )
    .all(batchSize);
  let delivered = 0;
  for (const row of rows) {
    try {
      sink(JSON.parse(row.event_json), row);
      tx(db, () => {
        db.query(
          `UPDATE outbox
           SET published_at = ?, delivery_error = NULL
           WHERE seq = ?`,
        ).run(new Date(now).toISOString(), row.seq);
      });
      delivered += 1;
    } catch (error) {
      const attempts = row.delivery_attempts + 1;
      const parked = attempts >= maxAttempts;
      const message = String(error?.message ?? error);
      tx(db, () => {
        db.query(
          `UPDATE outbox
           SET delivery_attempts = ?,
               delivery_error = ?,
               published_at = CASE WHEN ? THEN ? ELSE published_at END
           WHERE seq = ?`,
        ).run(
          attempts,
          message,
          parked ? 1 : 0,
          new Date(now).toISOString(),
          row.seq,
        );
      });
      if (!parked) break;
      log(`outbox poison seq=${row.seq}: ${message}`);
    }
  }
  sweepPublishedOutbox(db, { retentionDays, now });
  const remaining = db
    .query(`SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`)
    .get().n;
  return { delivered, remaining };
}

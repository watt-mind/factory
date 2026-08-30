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
export const DEFAULT_OUTBOX_RETRY_BASE_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function transientFailure(message, retryAt) {
  return JSON.stringify({ message, retryAt });
}

function retryAtFromFailure(deliveryError) {
  try {
    const failure = JSON.parse(deliveryError);
    return Number.isFinite(failure?.retryAt) ? failure.retryAt : null;
  } catch {
    return null;
  }
}

export function deliveryErrorMessage(deliveryError) {
  if (deliveryError == null) return null;
  try {
    const failure = JSON.parse(deliveryError);
    return typeof failure?.message === "string"
      ? failure.message
      : deliveryError;
  } catch {
    return deliveryError;
  }
}

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
           WHERE published_at IS NOT NULL
             AND delivery_error IS NULL
             AND published_at < ?`,
        )
        .run(cutoff).changes,
  );
}

/**
 * Deliver one bounded batch of unpublished outbox events to
 * `sink(envelope, row)` in insertion order. Each successful delivery is
 * stamped. Invalid JSON is deterministic poison and parks immediately. Sink
 * failures retry in order with exponential backoff until `maxAttempts`; the
 * final failure is parked, logged, and allows the following row to proceed.
 *
 * Delivered rows without a delivery error are pruned after a configurable
 * bounded window. Unpublished and parked rows are never eligible for pruning.
 *
 * @returns {{ delivered: number, remaining: number }} delivered rows and every
 * unpublished row still pending, including rows delayed by retry backoff
 */
export function publishOutbox(
  db,
  {
    sink,
    now = Date.now(),
    retentionDays = DEFAULT_OUTBOX_RETENTION_DAYS,
    batchSize = DEFAULT_OUTBOX_BATCH_SIZE,
    maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_OUTBOX_RETRY_BASE_MS,
    log = () => {},
  } = {},
) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (
    !Number.isFinite(retryBaseMs) ||
    retryBaseMs < DEFAULT_OUTBOX_RETRY_BASE_MS
  ) {
    throw new Error(
      `retryBaseMs must be at least ${DEFAULT_OUTBOX_RETRY_BASE_MS} milliseconds`,
    );
  }

  const rows = db
    .query(
      `SELECT seq, event_json, delivery_attempts, delivery_error
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY seq
       LIMIT ?`,
    )
    .all(batchSize);
  let delivered = 0;
  for (const row of rows) {
    const retryAt = retryAtFromFailure(row.delivery_error);
    if (retryAt !== null && retryAt > now) break;

    let envelope;
    try {
      envelope = JSON.parse(row.event_json);
    } catch (error) {
      const message = String(error?.message ?? error);
      tx(db, () => {
        db.query(
          `UPDATE outbox
           SET delivery_attempts = ?, delivery_error = ?, published_at = ?
           WHERE seq = ?`,
        ).run(
          row.delivery_attempts + 1,
          message,
          new Date(now).toISOString(),
          row.seq,
        );
      });
      log(`outbox poison seq=${row.seq}: ${message}`);
      continue;
    }

    try {
      sink(envelope, row);
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
          parked
            ? message
            : transientFailure(
                message,
                now + retryBaseMs * 2 ** (attempts - 1),
              ),
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

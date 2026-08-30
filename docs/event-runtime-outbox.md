# Outbox delivery

Result events enter the outbox in the transaction that accepts the result and
are delivered after that transaction commits. Successful rows are stamped with
`published_at` and are eligible for retention sweeping after 14 days.

Malformed event JSON is deterministic poison: it is parked on its first
delivery attempt. Sink failures are treated as transient: retries wait at least
half the current delay and then use jittered exponential backoff before the
configured attempt limit parks the row. The default policy is a 5-second base,
factor 2, 5-minute cap, and 12 attempts. At the capped end of the schedule,
the retry window reaches 30 minutes before a persistently unavailable sink is
parked. `publishOutbox()` accepts `retryBaseMs`, `retryFactor`, `retryCapMs`,
and an injectable `random` source; `retryBaseMs` may be any positive value so
tests and local loops can use short delays.

Delivery is in order, so a backed-off head row delays every subsequent row
until it is delivered or parked. A parked row has both `published_at` and
`delivery_error` set. Its error remains available through `GET /outbox` and it
is excluded from the published-row retention sweep for forensic review.

`GET /outbox` exposes `deliveryAttempts`, `deliveryError`, and `parked` for
each row; a malformed event is returned as `{ "raw": "..." }` so one poison
row cannot hide the rest of the feed. The status view reports both
`unpublishedOutbox` and `parkedOutbox` so delayed deliveries and terminal
delivery failures remain distinguishable.

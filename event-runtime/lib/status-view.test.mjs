import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { statusView } from "./status-view.mjs";

describe("statusView outbox counts", () => {
  test("publishes whether an operator has paused unattended dispatch", () => {
    const db = openDb(":memory:");

    expect(
      statusView(db, { schedules: [] }, Date.now(), {
        dispatchPaused: () => true,
      }).policy,
    ).toEqual({ dispatchPaused: true });
    expect(
      statusView(db, { schedules: [] }, Date.now(), {
        dispatchPaused: () => false,
      }).policy,
    ).toEqual({ dispatchPaused: false });
  });

  test("reports parked rows separately from unpublished rows", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const at = new Date(now).toISOString();
    const insert = db.query(
      `INSERT INTO outbox (event_json, created_at, published_at, delivery_error)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("{}", at, null, null);
    insert.run("{}", at, at, "sink unavailable");
    insert.run("{}", at, at, null);

    expect(statusView(db, { schedules: [] }, now).anomalies).toMatchObject({
      unpublishedOutbox: 1,
      parkedOutbox: 1,
    });
  });

  test("counts only expired run proposals as anomalies", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-30T08:00:00.000Z");
    const createdAt = new Date(now - 61_000).toISOString();
    const insert = db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES (?, 'test', ?, ?, 'open', ?, 60)`,
    );
    insert.run("run-expired", "run-event", "run", createdAt);
    insert.run("parked-past-ttl", "parked-event", "human_needed", createdAt);

    const view = statusView(db, { schedules: [] }, now);
    expect(view.proposals).toEqual({ open: 2, expired: 1 });
    expect(view.anomalies.expiredOpenProposals).toEqual(["run-expired"]);
  });

  test("reports an unconfigured GitHub intake separately from a stale configured intake", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-30T08:00:00.000Z");

    const unconfigured = statusView(db, { schedules: [] }, now, {
      githubSecret: null,
    });
    expect(unconfigured.anomalies.configuration).toContain(
      "FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)",
    );

    // A configured intake with no prior admission is a fresh runtime, not an
    // outage: no staleness anomaly until a delivery has actually been admitted.
    const fresh = statusView(db, { schedules: [] }, now, {
      githubSecret: "configured",
    });
    expect(
      fresh.anomalies.configuration.filter((a) =>
        a.startsWith("GitHub webhook intake is stale"),
      ),
    ).toEqual([]);

    seedGithubEvent(db, "2026-08-29T08:00:00.000Z");
    const configured = statusView(db, { schedules: [] }, now, {
      githubSecret: "configured",
    });
    expect(configured.anomalies.configuration).toContain(
      "GitHub webhook intake is stale (last admission was 86400000ms ago; threshold 43200000ms)",
    );
  });
});

function seedGithubEvent(db, admittedAt) {
  db.query(
    `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at,
       correlation_id, causation_id, envelope_json, payload_hash, admitted_at)
     VALUES ('github', 'old-delivery', 'github.issues.labeled', 'watt-mind/factory',
       ?1, ?1, 'old-delivery', NULL, '{}', 'hash', ?1)`,
  ).run(admittedAt);
}

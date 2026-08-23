import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { publishOutbox, sweepPublishedOutbox } from "./outbox.mjs";

function seedOutbox(db, eventId) {
  db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`).run(
    JSON.stringify({
      schemaVersion: "factory.event/v1",
      eventId,
      type: "t.completed",
      payload: {},
    }),
    new Date(0).toISOString(),
  );
}

describe("publishOutbox", () => {
  test("delivers unpublished rows in order and stamps them", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    seedOutbox(db, "b");
    const seen = [];
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toBe(2);
    expect(seen).toEqual(["a", "b"]);
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toBe(0);
    expect(seen).toEqual(["a", "b"]);
  });

  test("a sink failure leaves the row unpublished for redelivery", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    expect(() =>
      publishOutbox(db, {
        sink: () => {
          throw new Error("sink down");
        },
      }),
    ).toThrow("sink down");
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`)
        .get().n,
    ).toBe(1);
    const seen = [];
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toBe(1);
    expect(seen).toEqual(["a"]);
  });
});

describe("outbox retention and drain index", () => {
  test("retention deletes only published rows outside its bounded window", () => {
    const db = openDb(":memory:");
    const now = 30 * 24 * 60 * 60 * 1000;
    const old = new Date(0).toISOString();
    const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const insert = db.query(
      `INSERT INTO outbox (event_json, created_at, published_at) VALUES (?, ?, ?)`,
    );
    insert.run('{"eventId":"old"}', old, old);
    insert.run('{"eventId":"recent"}', recent, recent);
    insert.run('{"eventId":"pending"}', old, null);

    expect(sweepPublishedOutbox(db, { now, retentionDays: 14 })).toBe(1);
    expect(
      db
        .query(`SELECT event_json, published_at FROM outbox ORDER BY seq`)
        .all(),
    ).toEqual([
      { event_json: '{"eventId":"recent"}', published_at: recent },
      { event_json: '{"eventId":"pending"}', published_at: null },
    ]);
  });

  test("drains a pending row through the published-at index", () => {
    const db = openDb(":memory:");
    const publishedAt = new Date(0).toISOString();
    const insert = db.query(
      `INSERT INTO outbox (event_json, created_at, published_at) VALUES (?, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 200_000; i += 1) {
        insert.run("{}", publishedAt, publishedAt);
      }
      insert.run(JSON.stringify({ eventId: "pending" }), publishedAt, null);
    })();

    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT seq, event_json FROM outbox
         WHERE published_at IS NULL ORDER BY seq`,
      )
      .all()
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("USING INDEX idx_outbox_published_seq");

    const seen = [];
    expect(
      publishOutbox(db, {
        sink: (event) => seen.push(event.eventId),
        now: 24 * 60 * 60 * 1000,
      }),
    ).toBe(1);
    expect(seen).toEqual(["pending"]);
  });
});

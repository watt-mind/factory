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
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toEqual({
      delivered: 2,
      remaining: 0,
    });
    expect(seen).toEqual(["a", "b"]);
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toEqual({
      delivered: 0,
      remaining: 0,
    });
    expect(seen).toEqual(["a", "b"]);
  });

  test("parks a parse-poisoned row on its first failure and delivers its successor", () => {
    const db = openDb(":memory:");
    db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`).run(
      "not JSON",
      new Date(0).toISOString(),
    );
    seedOutbox(db, "successor");
    const logs = [];
    const seen = [];

    expect(
      publishOutbox(db, {
        sink: (event) => seen.push(event.eventId),
        log: (line) => logs.push(line),
      }),
    ).toEqual({ delivered: 1, remaining: 0 });
    expect(seen).toEqual(["successor"]);
    expect(
      db
        .query(
          `SELECT delivery_attempts, delivery_error, published_at
           FROM outbox WHERE seq = 1`,
        )
        .get(),
    ).toEqual({
      delivery_attempts: 1,
      delivery_error: expect.stringContaining("JSON"),
      published_at: expect.any(String),
    });
    expect(logs).toEqual([expect.stringContaining("outbox poison seq=1")]);
  });

  test("caps each call at its batch size and reports pending rows", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    seedOutbox(db, "b");
    seedOutbox(db, "c");
    const seen = [];

    expect(
      publishOutbox(db, {
        sink: (event) => seen.push(event.eventId),
        batchSize: 2,
      }),
    ).toEqual({ delivered: 2, remaining: 1 });
    expect(seen).toEqual(["a", "b"]);
    expect(
      publishOutbox(db, {
        sink: (event) => seen.push(event.eventId),
        batchSize: 2,
      }),
    ).toEqual({ delivered: 1, remaining: 0 });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("uses a default batch size of 500", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 501; i += 1) seedOutbox(db, String(i));

    expect(publishOutbox(db, { sink: () => {} })).toEqual({
      delivered: 500,
      remaining: 1,
    });
  });

  test("backs off transient sink failures before retrying later rows", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    seedOutbox(db, "b");
    const seen = [];
    let fail = true;
    const sink = (event) => {
      if (fail) {
        fail = false;
        throw new Error("sink down");
      }
      seen.push(event.eventId);
    };

    expect(publishOutbox(db, { sink, now: 0 })).toEqual({
      delivered: 0,
      remaining: 2,
    });
    expect(seen).toEqual([]);
    expect(publishOutbox(db, { sink, now: 4_999 })).toEqual({
      delivered: 0,
      remaining: 2,
    });
    expect(publishOutbox(db, { sink, now: 5_000 })).toEqual({
      delivered: 2,
      remaining: 0,
    });
    expect(seen).toEqual(["a", "b"]);
  });

  test("doubles transient retry delays before parking at the attempt limit", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    const sink = () => {
      throw new Error("sink down");
    };

    expect(publishOutbox(db, { sink, now: 0 })).toEqual({
      delivered: 0,
      remaining: 1,
    });
    expect(publishOutbox(db, { sink, now: 5_000 })).toEqual({
      delivered: 0,
      remaining: 1,
    });
    expect(publishOutbox(db, { sink, now: 14_999 })).toEqual({
      delivered: 0,
      remaining: 1,
    });
    expect(publishOutbox(db, { sink, now: 15_000 })).toEqual({
      delivered: 0,
      remaining: 0,
    });
    expect(
      db
        .query(
          `SELECT delivery_attempts, delivery_error, published_at
           FROM outbox WHERE seq = 1`,
        )
        .get(),
    ).toEqual({
      delivery_attempts: 3,
      delivery_error: "sink down",
      published_at: expect.any(String),
    });
  });
});

describe("outbox retention and drain index", () => {
  test("retention deletes only delivered rows outside its bounded window", () => {
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
    db.query(
      `INSERT INTO outbox (event_json, created_at, published_at, delivery_error)
       VALUES (?, ?, ?, ?)`,
    ).run('{"eventId":"parked"}', old, old, "sink unavailable");

    expect(sweepPublishedOutbox(db, { now, retentionDays: 14 })).toBe(1);
    expect(
      db
        .query(`SELECT event_json, published_at FROM outbox ORDER BY seq`)
        .all(),
    ).toEqual([
      { event_json: '{"eventId":"recent"}', published_at: recent },
      { event_json: '{"eventId":"pending"}', published_at: null },
      { event_json: '{"eventId":"parked"}', published_at: old },
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
    ).toEqual({ delivered: 1, remaining: 0 });
    expect(seen).toEqual(["pending"]);
  });
});

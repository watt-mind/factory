import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { statusView } from "./status-view.mjs";

describe("statusView outbox counts", () => {
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
});

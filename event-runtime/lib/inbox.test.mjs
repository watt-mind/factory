import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import {
  INBOX_KINDS,
  ackInboxItem,
  createInboxItem,
  deliverInboxItem,
  getInboxItem,
  inboxCounts,
  listInboxItems,
  reconcileInbox,
  resolveInboxItem,
} from "./inbox.mjs";

function insertEvent(db, { source = "test", eventId, status = "human_needed" }) {
  const at = new Date().toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, status, admitted_at)
     VALUES (?, ?, 'test.event', ?, ?, '{}', 'sha256:x', ?, ?)`,
  ).run(source, eventId, at, at, status, at);
}

function insertProposal(db, { id, status = "open" }) {
  const at = new Date().toISOString();
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
     VALUES (?, 'test', 'evt', 'run', ?, ?, 1800)`,
  ).run(id, status, at);
}

describe("human inbox ledger (WM-285)", () => {
  test("kind is closed and rows expose parsed refs/delivery", () => {
    const db = openDb(":memory:");
    expect(INBOX_KINDS).toContain("BLOCKED");
    expect(INBOX_KINDS).toContain("proposal_expired");
    expect(() => createInboxItem(db, { kind: "routine_progress", title: "claimed" })).toThrow("unknown inbox kind");

    const item = createInboxItem(db, {
      kind: "BLOCKED",
      severity: "high",
      title: "BLOCKED WM-1: choose",
      refs: { issue: "WM-1", runId: "run_1" },
      source: "agent:run_1",
    }, { now: 1000, id: "inbox_test" });
    expect(item).toMatchObject({
      id: "inbox_test",
      kind: "BLOCKED",
      severity: "high",
      refs: { issue: "WM-1", runId: "run_1" },
      delivery: {},
      createdAt: new Date(1000).toISOString(),
    });
    expect(listInboxItems(db, { status: "open" })).toHaveLength(1);
  });

  test("delivery records failure without deleting the item and appends a configured deep link", async () => {
    const db = openDb(":memory:");
    const item = createInboxItem(db, { kind: "CI RED", title: "CI RED PR-4: tests", source: "cli" }, { id: "inbox_delivery" });
    let message;
    const outcome = await deliverInboxItem(db, item.id, {
      command: "/stub",
      webUrl: "http://127.0.0.1:7382/",
      send: async (_command, sent) => {
        message = sent;
        return { ok: false, exitCode: 7, error: "notifier exited 7" };
      },
    });
    expect(outcome.ok).toBe(false);
    expect(message).toBe("CI RED PR-4: tests\nhttp://127.0.0.1:7382/#/inbox/inbox_delivery");
    expect(listInboxItems(db, { status: "all" })[0].delivery.telegram).toMatchObject({
      exit_code: 7,
      error: "notifier exited 7",
    });
  });

  test("ack, resolve, filters, and counts distinguish open from acknowledged", () => {
    const db = openDb(":memory:");
    createInboxItem(db, { kind: "BLOCKED", title: "one" }, { id: "one", now: 1000 });
    createInboxItem(db, { kind: "ESCALATED", title: "two" }, { id: "two", now: 2000 });
    expect(ackInboxItem(db, "one", { now: 3000 }).ackedAt).toBe(new Date(3000).toISOString());
    expect(resolveInboxItem(db, "two", { now: 4000, resolvedBy: "operator" }).resolvedBy).toBe("operator");
    expect(listInboxItems(db, { status: "open" }).map((i) => i.id)).toEqual([]);
    expect(listInboxItems(db, { status: "acked" }).map((i) => i.id)).toEqual(["one"]);
    expect(listInboxItems(db, { status: "resolved" }).map((i) => i.id)).toEqual(["two"]);
    expect(inboxCounts(db)).toEqual({ open: 0, acked: 1, byKind: { BLOCKED: 1 } });
  });

  test("runtime-owned referents auto-resolve after leaving their waiting state", () => {
    const db = openDb(":memory:");
    insertProposal(db, { id: "prop-1" });
    insertEvent(db, { eventId: "evt-1" });
    createInboxItem(db, {
      kind: "decision_needed",
      title: "decision",
      refs: { proposalId: "prop-1" },
      source: "serve:notify",
    }, { id: "decision" });
    createInboxItem(db, {
      kind: "human_needed",
      title: "human",
      refs: { eventSource: "test", eventId: "evt-1" },
      source: "serve:notify",
    }, { id: "human" });

    expect(reconcileInbox(db)).toEqual([]);
    db.query("UPDATE proposals SET status = 'approved' WHERE id = 'prop-1'").run();
    db.query("UPDATE events SET status = 'admitted' WHERE source = 'test' AND event_id = 'evt-1'").run();
    const resolved = reconcileInbox(db, { now: 5000 });
    expect(resolved).toEqual([
      { id: "decision", resolvedBy: "auto:proposal_decided" },
      { id: "human", resolvedBy: "auto:event_requeued" },
    ]);
  });

  test("the serve tick runs auto-resolution as an isolated inbox subsystem", async () => {
    const { tick, TICK_SUBSYSTEMS } = await import("../cli.mjs");
    const db = openDb(":memory:");
    insertProposal(db, { id: "prop-tick", status: "approved" });
    createInboxItem(db, {
      kind: "decision_needed",
      title: "decision",
      refs: { proposalId: "prop-tick" },
      source: "serve:notify",
    }, { id: "tick-item" });
    const noop = () => {};
    await tick({
      db,
      now: 9000,
      lastPrune: 9000,
      subsystems: {
        "tick emit": noop,
        plan: noop,
        "auto-approve": noop,
        announce: noop,
        notify: noop,
        reap: noop,
        "announce-after": noop,
        outbox: noop,
        GC: noop,
        chains: noop,
      },
    });
    expect(TICK_SUBSYSTEMS).toContain("inbox");
    expect(getInboxItem(db, "tick-item").resolvedBy).toBe("auto:proposal_decided");
  });
});

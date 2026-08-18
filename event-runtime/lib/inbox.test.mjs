import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import {
  INBOX_KINDS,
  ackInboxItem,
  createInboxItem,
  decideInboxItem,
  deliverInboxItem,
  getInboxItem,
  inboxCounts,
  listInboxItems,
  reconcileInbox,
  retryInboxDecision,
  resolveInboxItem,
} from "./inbox.mjs";
import { decisionRequestHash } from "./decision.mjs";

function decision(options = [
  { id: "dismiss", label: "Not now", effect: "dismiss" },
]) {
  return {
    schemaVersion: "factory.decision-request/v1",
    question: "What should happen?",
    options,
  };
}

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
  test("decision requests are validated and exposed with decision metadata", () => {
    const db = openDb(":memory:");
    expect(() => createInboxItem(db, {
      kind: "BLOCKED",
      title: "bad",
      decision: decision([
        { id: "retry", label: "Retry", effect: "requeue" },
      ]),
    })).toThrow("requires refs.eventSource");

    const item = createInboxItem(db, {
      kind: "BLOCKED",
      title: "good",
      decision: decision(),
      dedupeKey: "BLOCKED:evt",
    }, { id: "decision_item", now: 1000 });
    expect(item).toMatchObject({
      decision: decision(),
      response: null,
      decidedAt: null,
      decidedBy: null,
      dedupeKey: "BLOCKED:evt",
    });
  });

  test("open dedupe supersedes the request without stacking rows", () => {
    const db = openDb(":memory:");
    const first = createInboxItem(db, {
      kind: "ESCALATED",
      title: "first",
      body: "old",
      refs: { issue: "WM-1", runId: "run_1" },
      source: "agent:run_1",
      decision: decision(),
      dedupeKey: "ESCALATED:WM-1",
    }, { id: "first" });
    const replacement = decision([
      { id: "dismiss", label: "Dismiss this time", effect: "dismiss" },
    ]);
    const second = createInboxItem(db, {
      kind: "ESCALATED",
      title: "second",
      body: "new",
      refs: { issue: "WM-1", runId: "run_2" },
      source: "agent:run_2",
      decision: replacement,
      dedupeKey: "ESCALATED:WM-1",
    }, { id: "second" });
    expect(second.id).toBe(first.id);
    expect(second.body).toBe("new");
    expect(second.refs).toEqual({ issue: "WM-1", runId: "run_2" });
    expect(second.decision).toEqual(replacement);
    expect(second.delivery.supersededDecisions).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(1);

    createInboxItem(db, { kind: "ESCALATED", title: "unkeyed one" });
    createInboxItem(db, { kind: "ESCALATED", title: "unkeyed two" });
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(3);
  });

  test("dedupe supersession clears a stored response to avoid binding it to a new request", () => {
    const db = openDb(":memory:");
    const original = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(db, {
      kind: "ESCALATED",
      title: "first",
      refs: { issue: "WM-1", runId: "run_1" },
      decision: original,
      dedupeKey: "ESCALATED:WM-1",
    }, { id: "first" });
    const answered = decideInboxItem(db, "first", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(original),
      optionId: "triage",
      fields: {},
    });
    expect(answered.effect.outcome).toBe("unsupported");
    expect(answered.item.response).not.toBeNull();

    const replacement = decision();
    const superseded = createInboxItem(db, {
      kind: "ESCALATED",
      title: "second",
      refs: { issue: "WM-1", runId: "run_2" },
      decision: replacement,
      dedupeKey: "ESCALATED:WM-1",
    });
    expect(superseded).toMatchObject({
      id: "first",
      decision: replacement,
      response: null,
      decidedAt: null,
      decidedBy: null,
    });
    expect(superseded.delivery.supersededDecisions).toBe(1);
  });

  test("deciding validates freshness, records the effect, and resolves only applied effects", () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "go", label: "Proceed", effect: "send_to_triage" },
      { id: "dismiss", label: "Not now", effect: "dismiss" },
    ]);
    const item = createInboxItem(db, {
      kind: "ESCALATED",
      title: "decide",
      refs: { issue: "WM-1" },
      decision: request,
    }, { id: "to_decide" });
    expect(() => resolveInboxItem(db, item.id)).toThrow("pending decision");
    expect(() => decideInboxItem(db, item.id, {
      schemaVersion: "factory.decision-response/v1",
      requestHash: "sha256:" + "0".repeat(64),
      optionId: "dismiss",
      fields: {},
    })).toThrow("has changed");
    expect(() => decideInboxItem(db, item.id, {
      requestHash: decisionRequestHash(request),
      optionId: "go",
      fields: {},
    })).toThrow("schemaVersion");

    const unsupported = decideInboxItem(db, item.id, {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "go",
      fields: {},
    }, { now: 2000 });
    expect(unsupported.effect).toEqual({
      kind: "send_to_triage",
      outcome: "unsupported",
    });
    expect(unsupported.item.resolvedAt).toBeNull();
    expect(unsupported.item.response.effect).toEqual(unsupported.effect);
    expect(unsupported.item.decidedAt).toBe(new Date(2000).toISOString());
    expect(() => decideInboxItem(db, item.id, {
      requestHash: decisionRequestHash(request), optionId: "go", fields: {},
    })).toThrow("already decided");

    const retried = retryInboxDecision(db, item.id, {
      now: 3000,
      applyEffect: () => ({ kind: "send_to_triage", outcome: "applied" }),
    });
    expect(retried.item.resolvedBy).toBe("operator:send_to_triage");
    expect(retried.item.resolvedAt).toBe(new Date(3000).toISOString());
    expect(retried.item.response.effect.retryAttempt).toBe(1);
    expect(() => retryInboxDecision(db, item.id)).toThrow("already applied");
  });

  test("each failed retry advances a durable attempt token", () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(db, {
      kind: "ESCALATED",
      title: "retry",
      refs: { issue: "WM-1" },
      decision: request,
    }, { id: "retry_attempts" });
    decideInboxItem(db, "retry_attempts", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    });
    expect(retryInboxDecision(db, "retry_attempts").item.response.effect.retryAttempt).toBe(1);
    expect(retryInboxDecision(db, "retry_attempts").item.response.effect.retryAttempt).toBe(2);
  });

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
      kind: "BLOCKED",
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

  test("a pending decision becomes moot when its event leaves human_needed", () => {
    const db = openDb(":memory:");
    insertEvent(db, { eventId: "evt-2" });
    createInboxItem(db, {
      kind: "BLOCKED",
      title: "parked",
      refs: { eventSource: "test", eventId: "evt-2" },
      source: "serve:notify",
      decision: decision([
        { id: "requeue", label: "Requeue the event", effect: "requeue" },
        { id: "dismiss", label: "Not now", effect: "dismiss" },
      ]),
    }, { id: "parked" });

    expect(reconcileInbox(db)).toEqual([]);
    expect(() => resolveInboxItem(db, "parked", { resolvedBy: "operator" }))
      .toThrow(/pending decision/);

    db.query("UPDATE events SET status = 'admitted' WHERE source = 'test' AND event_id = 'evt-2'").run();
    expect(reconcileInbox(db, { now: 5000 })).toEqual([
      { id: "parked", resolvedBy: "auto:event_requeued" },
    ]);
    const item = getInboxItem(db, "parked");
    expect(item.resolvedBy).toBe("auto:event_requeued");
    expect(item.resolvedAt).toBe(new Date(5000).toISOString());
    expect(item.response).toMatchObject({ superseded: true, reason: "auto:event_requeued" });
    expect(item.decidedBy).toBe("auto:event_requeued");
    // A late operator answer is refused rather than applied.
    expect(() => decideInboxItem(db, "parked", { optionId: "requeue" }))
      .toThrow(/already decided/);
    expect(reconcileInbox(db, { now: 6000 })).toEqual([]);
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

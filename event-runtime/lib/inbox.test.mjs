import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-inbox-test-mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "./db.mjs";
import {
  INBOX_KINDS,
  ackInboxItem,
  bindInboxProposal,
  createInboxItem,
  decideInboxItem,
  deliverInboxItem,
  getInboxItem,
  inboxCounts,
  listInboxItems,
  markInboxDelivered,
  reconcileInbox,
  retryInboxDecision,
  resolveInboxItem,
  fetchLinearInboxIssues,
  linearGql,
} from "./inbox.mjs";
import { decisionRequestHash } from "./decision.mjs";
import { templateFor } from "./decision-templates.mjs";
import { listMemos, MEMO_SCHEMA_VERSION, memoDigest } from "./memos.mjs";

function decision(
  options = [{ id: "dismiss", label: "Not now", effect: "dismiss" }],
) {
  return {
    schemaVersion: "factory.decision-request/v1",
    question: "What should happen?",
    options,
  };
}

function insertEvent(
  db,
  { source = "test", eventId, status = "human_needed" },
) {
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
    expect(() =>
      createInboxItem(db, {
        kind: "BLOCKED",
        title: "bad",
        decision: decision([
          { id: "retry", label: "Retry", effect: "requeue" },
        ]),
      }),
    ).toThrow("requires refs.eventSource");

    const item = createInboxItem(
      db,
      {
        kind: "BLOCKED",
        title: "good",
        decision: decision(),
        dedupeKey: "BLOCKED:evt",
      },
      { id: "decision_item", now: 1000 },
    );
    expect(item).toMatchObject({
      decision: decision(),
      response: null,
      decidedAt: null,
      decidedBy: null,
      dedupeKey: "BLOCKED:evt",
    });
  });

  test("same-question open items attach as waiters instead of stacking rows", () => {
    const db = openDb(":memory:");
    const first = createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "first",
        body: "old",
        refs: { issue: "WM-1", runId: "run_1" },
        source: "agent:run_1",
        decision: decision(),
        dedupeKey: "ESCALATED:WM-1",
      },
      { id: "first" },
    );
    const second = createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "second",
        body: "new",
        refs: { issue: "WM-1", runId: "run_2" },
        source: "agent:run_2",
        decision: decision(),
        dedupeKey: "ESCALATED:WM-1",
      },
      { id: "second" },
    );
    expect(second.id).toBe(first.id);
    expect(second.attached).toBe(true);
    expect(second.body).toBe("old");
    expect(second.refs).toEqual({ issue: "WM-1", runId: "run_1" });
    expect(second.decision).toEqual(decision());
    expect(second.waiters).toEqual([
      { runId: "run_2", at: expect.any(String) },
    ]);
    expect(second.waitingCount).toBe(2);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(1);

    createInboxItem(db, { kind: "ESCALATED", title: "unkeyed one" });
    createInboxItem(db, { kind: "ESCALATED", title: "unkeyed two" });
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(3);
  });

  test("a dispatch proposal item stores the action-first title and why-line (WM-896)", () => {
    const db = openDb(":memory:");
    const refs = {
      proposalId: "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
      issue: "WM-862",
      repo: "factory",
      eventSource: "test",
      eventId: "evt",
    };
    const spec = {
      agent: "dispatch@1",
      model: "cursor-grok-4.6-high",
      input: { ticket: "WM-862", repo: "factory" },
    };
    const created = createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "Dispatch WM-862 · factory · cursor-grok-4.6-high",
        refs,
        source: "serve:notify",
        decision: templateFor("decision_needed", {
          producer: "proposal",
          refs,
          spec,
          reason: "auto_approval_ineligible:dispatch_recheck_failed",
        }),
        dedupeKey: "decision_needed:prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
      },
      { id: "inbox_dispatch" },
    );
    expect(created.title).toBe(
      "Dispatch WM-862 · factory · cursor-grok-4.6-high",
    );
    expect(created.decision.question).toBe(
      "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
    );
    expect(created.decision.context).toContain("Why you're being asked");
    expect(created.refs).toMatchObject({
      issue: "WM-862",
      repo: "factory",
      proposalId: "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
    });
  });

  test("a different decision shape on the same caller key still supersedes", () => {
    const db = openDb(":memory:");
    const first = createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "first",
        body: "old",
        refs: { issue: "WM-1", runId: "run_1" },
        source: "agent:run_1",
        decision: decision(),
        dedupeKey: "ESCALATED:WM-1",
      },
      { id: "first" },
    );
    const replacement = decision([
      { id: "retry", label: "Retry", effect: "requeue" },
    ]);
    const second = createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "second",
        body: "new",
        refs: {
          issue: "WM-1",
          runId: "run_2",
          eventSource: "test",
          eventId: "e",
        },
        source: "agent:run_2",
        decision: replacement,
        dedupeKey: "ESCALATED:WM-1",
      },
      { id: "second" },
    );
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("second");
    expect(second.body).toBe("new");
    expect(second.refs).toEqual({ issue: "WM-1", runId: "run_2" });
    expect(second.decision).toEqual(replacement);
    expect(second.delivery.supersededDecisions).toBe(1);
    expect(second.waiters).toEqual([]);
  });

  test("decideInboxItem fans the effect out across waiters bound to each run", () => {
    const db = openDb(":memory:");
    const request = decision();
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "first",
        refs: { issue: "WM-1", runId: "run_1" },
        decision: request,
        dedupeKey: "ESCALATED:WM-1",
      },
      { id: "first", now: 1000 },
    );
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "second",
        refs: { issue: "WM-1", runId: "run_2" },
        decision: request,
        dedupeKey: "ESCALATED:WM-1",
      },
      { now: 2000 },
    );
    const appliedRuns = [];
    const decided = decideInboxItem(
      db,
      "first",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "dismiss",
        fields: {},
      },
      {
        now: 3000,
        applyEffect: (_db, item) => {
          appliedRuns.push(item.refs.runId);
          return { kind: "dismiss", outcome: "applied" };
        },
      },
    );
    expect(appliedRuns).toEqual(["run_1"]);
    expect(decided.waiterEffects).toEqual([
      {
        runId: "run_2",
        effect: {
          kind: "dismiss",
          outcome: "applied",
          detail: "shared_referent",
        },
      },
    ]);
    expect(decided.item.waitingCount).toBe(2);
    expect(decided.item.waiters[0].effect.detail).toBe("shared_referent");
    expect(decided.item.resolvedAt).toBe(new Date(3000).toISOString());
  });

  test("delivery is not retried once a projection exists", async () => {
    const db = openDb(":memory:");
    const item = createInboxItem(
      db,
      { kind: "CI RED", title: "CI RED PR-4: tests", source: "cli" },
      { id: "inbox_delivery_once" },
    );
    const sends = [];
    await deliverInboxItem(db, item.id, {
      command: "/stub",
      send: async () => {
        sends.push(1);
        return { ok: true, exitCode: 0, error: null };
      },
    });
    const again = await deliverInboxItem(db, item.id, {
      command: "/stub",
      send: async () => {
        sends.push(2);
        return { ok: true, exitCode: 0, error: null };
      },
    });
    expect(sends).toEqual([1]);
    expect(again.skipped).toBe(true);
    expect(again.ok).toBe(true);
  });

  test("dedupe supersession clears a stored response to avoid binding it to a new request", () => {
    const db = openDb(":memory:");
    const original = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "first",
        refs: { issue: "WM-1", runId: "run_1" },
        decision: original,
        dedupeKey: "ESCALATED:WM-1",
      },
      { id: "first" },
    );
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
    const item = createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "decide",
        refs: { issue: "WM-1" },
        decision: request,
      },
      { id: "to_decide" },
    );
    expect(() => resolveInboxItem(db, item.id)).toThrow("pending decision");
    expect(() =>
      decideInboxItem(db, item.id, {
        schemaVersion: "factory.decision-response/v1",
        requestHash: "sha256:" + "0".repeat(64),
        optionId: "dismiss",
        fields: {},
      }),
    ).toThrow("has changed");
    expect(() =>
      decideInboxItem(db, item.id, {
        requestHash: decisionRequestHash(request),
        optionId: "go",
        fields: {},
      }),
    ).toThrow("schemaVersion");

    const unsupported = decideInboxItem(
      db,
      item.id,
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "go",
        fields: {},
      },
      { now: 2000 },
    );
    expect(unsupported.effect).toEqual({
      kind: "send_to_triage",
      outcome: "unsupported",
    });
    expect(unsupported.item.resolvedAt).toBeNull();
    expect(unsupported.item.response.effect).toEqual(unsupported.effect);
    expect(unsupported.item.decidedAt).toBe(new Date(2000).toISOString());
    expect(() =>
      decideInboxItem(db, item.id, {
        requestHash: decisionRequestHash(request),
        optionId: "go",
        fields: {},
      }),
    ).toThrow("already decided");

    const retried = retryInboxDecision(db, item.id, {
      now: 3000,
      applyEffect: () => ({ kind: "send_to_triage", outcome: "applied" }),
      artifactStore: null,
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
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "retry",
        refs: { issue: "WM-1" },
        decision: request,
      },
      { id: "retry_attempts" },
    );
    decideInboxItem(db, "retry_attempts", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    });
    expect(
      retryInboxDecision(db, "retry_attempts").item.response.effect
        .retryAttempt,
    ).toBe(1);
    expect(
      retryInboxDecision(db, "retry_attempts").item.response.effect
        .retryAttempt,
    ).toBe(2);
  });

  test("kind is closed and rows expose parsed refs/delivery", () => {
    const db = openDb(":memory:");
    expect(INBOX_KINDS).toContain("BLOCKED");
    expect(INBOX_KINDS).toContain("proposal_expired");
    expect(() =>
      createInboxItem(db, { kind: "routine_progress", title: "claimed" }),
    ).toThrow("unknown inbox kind");

    const item = createInboxItem(
      db,
      {
        kind: "BLOCKED",
        severity: "high",
        title: "BLOCKED WM-1: choose",
        refs: { issue: "WM-1", runId: "run_1" },
        source: "agent:run_1",
      },
      { now: 1000, id: "inbox_test" },
    );
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
    const item = createInboxItem(
      db,
      { kind: "CI RED", title: "CI RED PR-4: tests", source: "cli" },
      { id: "inbox_delivery" },
    );
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
    expect(message).toBe(
      "CI RED PR-4: tests\nhttp://127.0.0.1:7382/#/inbox/inbox_delivery",
    );
    expect(
      listInboxItems(db, { status: "all" })[0].delivery.telegram,
    ).toMatchObject({
      exit_code: 7,
      error: "notifier exited 7",
    });
  });

  test("markInboxDelivered merges onto delivery_json without deciding", () => {
    const db = openDb(":memory:");
    const request = decision();
    const item = createInboxItem(
      db,
      {
        kind: "BLOCKED",
        title: "buzz delivery",
        decision: request,
      },
      { id: "inbox_mark" },
    );
    expect(item.response).toBeNull();
    expect(item.decidedAt).toBeNull();

    const withTelegram = markInboxDelivered(db, "inbox_mark", {
      telegram: {
        sent_at: "2026-08-20T00:00:00.000Z",
        exit_code: 0,
        error: null,
      },
    });
    expect(withTelegram.delivery.telegram.exit_code).toBe(0);
    expect(withTelegram.response).toBeNull();
    expect(withTelegram.decidedAt).toBeNull();

    const withBuzz = markInboxDelivered(db, "inbox_mark", {
      buzz: { eventId: "nevent1abc", postedAt: "2026-08-20T00:01:00.000Z" },
    });
    expect(withBuzz.delivery.telegram.exit_code).toBe(0);
    expect(withBuzz.delivery.buzz).toEqual({
      eventId: "nevent1abc",
      postedAt: "2026-08-20T00:01:00.000Z",
    });
    expect(withBuzz.response).toBeNull();
    expect(withBuzz.decidedAt).toBeNull();

    const decided = decideInboxItem(db, "inbox_mark", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "dismiss",
      fields: {},
    });
    expect(decided.item.decidedBy).toBe("operator");
    expect(decided.item.delivery.buzz.eventId).toBe("nevent1abc");
    expect(decided.item.delivery.telegram.exit_code).toBe(0);

    const afterDecide = markInboxDelivered(db, "inbox_mark", {
      buzz: { eventId: "nevent1def", postedAt: "2026-08-20T00:02:00.000Z" },
    });
    expect(afterDecide.delivery.buzz.eventId).toBe("nevent1def");
    expect(afterDecide.decidedBy).toBe("operator");
    expect(afterDecide.response.optionId).toBe("dismiss");
  });

  test("markInboxDelivered rejects a missing id and a non-object delivery", () => {
    const db = openDb(":memory:");
    createInboxItem(
      db,
      { kind: "CI RED", title: "exists" },
      { id: "inbox_exists" },
    );
    expect(() => markInboxDelivered(db, "inbox_missing", { buzz: {} })).toThrow(
      "unknown inbox item inbox_missing",
    );
    expect(() => markInboxDelivered(db, "inbox_exists", null)).toThrow(
      "delivery must be an object",
    );
    expect(() => markInboxDelivered(db, "inbox_exists", [])).toThrow(
      "delivery must be an object",
    );
  });

  test("markInboxDelivered survives reopening the database file", () => {
    const file = path.join(tmpDir("inbox-mark-"), "runtime.db");
    const db = openDb(file);
    createInboxItem(
      db,
      { kind: "CI RED", title: "persist me" },
      { id: "inbox_persist" },
    );
    markInboxDelivered(db, "inbox_persist", {
      buzz: { eventId: "nevent1persist", postedAt: "2026-08-20T00:00:00.000Z" },
    });
    db.close();
    const reopened = openDb(file);
    expect(getInboxItem(reopened, "inbox_persist").delivery.buzz).toEqual({
      eventId: "nevent1persist",
      postedAt: "2026-08-20T00:00:00.000Z",
    });
    reopened.close();
  });

  test("ack, resolve, filters, and counts distinguish open from acknowledged", () => {
    const db = openDb(":memory:");
    createInboxItem(
      db,
      { kind: "BLOCKED", title: "one" },
      { id: "one", now: 1000 },
    );
    createInboxItem(
      db,
      { kind: "ESCALATED", title: "two" },
      { id: "two", now: 2000 },
    );
    expect(ackInboxItem(db, "one", { now: 3000 }).ackedAt).toBe(
      new Date(3000).toISOString(),
    );
    const resolved = resolveInboxItem(db, "two", {
      now: 4000,
      resolvedBy: "operator",
      reason: "  Follow-up completed  ",
    });
    expect(resolved).toMatchObject({
      resolvedBy: "operator",
      resolvedReason: "  Follow-up completed  ",
    });
    expect(getInboxItem(db, "two").resolvedReason).toBe(
      "  Follow-up completed  ",
    );
    expect(listInboxItems(db, { status: "open" }).map((i) => i.id)).toEqual([]);
    expect(listInboxItems(db, { status: "acked" }).map((i) => i.id)).toEqual([
      "one",
    ]);
    expect(listInboxItems(db, { status: "resolved" }).map((i) => i.id)).toEqual(
      ["two"],
    );
    expect(inboxCounts(db)).toEqual({
      open: 0,
      acked: 1,
      byKind: { BLOCKED: 1 },
    });
  });

  test("inbox counts omit expired open items", () => {
    const db = openDb(":memory:");
    const expiredAt = new Date(Date.now() - 61_000).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES ('expired-proposal', 'test', 'evt', 'run', 'open', ?, 60)`,
    ).run(expiredAt);
    createInboxItem(db, { kind: "BLOCKED", title: "active" }, { id: "active" });
    createInboxItem(
      db,
      { kind: "proposal_expired", title: "expired by kind" },
      { id: "expired-kind" },
    );
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "expired by proposal",
        refs: { proposalId: "expired-proposal" },
      },
      { id: "expired-proposal-item" },
    );

    expect(inboxCounts(db)).toMatchObject({ open: 1, acked: 0 });
  });

  test("runtime-owned referents auto-resolve after leaving their waiting state", () => {
    const db = openDb(":memory:");
    insertProposal(db, { id: "prop-1" });
    insertEvent(db, { eventId: "evt-1" });
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "decision",
        refs: { proposalId: "prop-1" },
        source: "serve:notify",
      },
      { id: "decision" },
    );
    createInboxItem(
      db,
      {
        kind: "BLOCKED",
        title: "human",
        refs: { eventSource: "test", eventId: "evt-1" },
        source: "serve:notify",
      },
      { id: "human" },
    );

    expect(reconcileInbox(db)).toEqual([]);
    db.query(
      "UPDATE proposals SET status = 'approved' WHERE id = 'prop-1'",
    ).run();
    db.query(
      "UPDATE events SET status = 'admitted' WHERE source = 'test' AND event_id = 'evt-1'",
    ).run();
    const resolved = reconcileInbox(db, { now: 5000 });
    expect(resolved).toEqual([
      { id: "decision", resolvedBy: "auto:proposal_decided" },
      { id: "human", resolvedBy: "auto:event_requeued" },
    ]);
  });

  test("a pending decision becomes moot when its event leaves human_needed", () => {
    const db = openDb(":memory:");
    insertEvent(db, { eventId: "evt-2" });
    createInboxItem(
      db,
      {
        kind: "BLOCKED",
        title: "parked",
        refs: { eventSource: "test", eventId: "evt-2" },
        source: "serve:notify",
        decision: decision([
          { id: "requeue", label: "Requeue the event", effect: "requeue" },
          { id: "dismiss", label: "Not now", effect: "dismiss" },
        ]),
      },
      { id: "parked" },
    );

    expect(reconcileInbox(db)).toEqual([]);
    expect(() =>
      resolveInboxItem(db, "parked", { resolvedBy: "operator" }),
    ).toThrow(/pending decision/);

    db.query(
      "UPDATE events SET status = 'admitted' WHERE source = 'test' AND event_id = 'evt-2'",
    ).run();
    expect(reconcileInbox(db, { now: 5000 })).toEqual([
      { id: "parked", resolvedBy: "auto:event_requeued" },
    ]);
    const item = getInboxItem(db, "parked");
    expect(item.resolvedBy).toBe("auto:event_requeued");
    expect(item.resolvedAt).toBe(new Date(5000).toISOString());
    expect(item.response).toMatchObject({
      superseded: true,
      reason: "auto:event_requeued",
    });
    expect(item.decidedBy).toBe("auto:event_requeued");
    // A late operator answer is refused rather than applied.
    expect(() =>
      decideInboxItem(db, "parked", { optionId: "requeue" }),
    ).toThrow(/already decided/);
    expect(reconcileInbox(db, { now: 6000 })).toEqual([]);
  });

  test("the serve tick runs auto-resolution as an isolated inbox subsystem", async () => {
    const { tick, TICK_SUBSYSTEMS } = await import("../cli.mjs");
    const db = openDb(":memory:");
    insertProposal(db, { id: "prop-tick", status: "approved" });
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "decision",
        refs: { proposalId: "prop-tick" },
        source: "serve:notify",
      },
      { id: "tick-item" },
    );
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
    expect(getInboxItem(db, "tick-item").resolvedBy).toBe(
      "auto:proposal_decided",
    );
  });

  test("Linear referents poll distinct open issues at most once per minute and fail open", async () => {
    const db = openDb(":memory:");
    for (const [id, kind, issue] of [
      ["blocked", "BLOCKED", "WM-10"],
      ["escalated", "ESCALATED", "WM-11"],
      ["duplicate", "BLOCKED", "WM-10"],
    ]) {
      createInboxItem(
        db,
        { kind, title: id, refs: { issue } },
        { id, now: 1000 },
      );
    }
    expect(getInboxItem(db, "duplicate")).toBeNull();
    expect(getInboxItem(db, "blocked").waitingCount).toBe(2);

    const calls = [];
    const linearIssues = async (ids) => {
      calls.push(ids);
      return [
        {
          identifier: "WM-10",
          state: { name: "Todo", type: "unstarted" },
          labels: { nodes: [] },
        },
        {
          identifier: "WM-11",
          state: { name: "In Progress", type: "started" },
          labels: { nodes: [{ name: "ai:escalated" }] },
        },
      ];
    };

    expect(await reconcileInbox(db, { now: 60_000, linearIssues })).toEqual([
      { id: "blocked", resolvedBy: "auto:linear_unblocked" },
    ]);
    expect(calls).toEqual([["WM-10", "WM-11"]]);
    expect(await reconcileInbox(db, { now: 100_000, linearIssues })).toEqual(
      [],
    );
    expect(calls).toHaveLength(1);

    // ESCALATED transition: initial poll with ai:escalated registers seenEscalated without resolving
    expect(getInboxItem(db, "escalated").resolvedAt).toBeNull();
    expect(getInboxItem(db, "escalated").delivery.seenEscalated).toBe(true);

    // ESCALATED transition: subsequent poll with ai:escalated removed resolves the item
    const unescalatedIssues = async () => [
      {
        identifier: "WM-11",
        state: { name: "In Progress", type: "started" },
        labels: { nodes: [] },
      },
    ];
    expect(
      await reconcileInbox(db, {
        now: 180_000,
        linearIssues: unescalatedIssues,
      }),
    ).toEqual([
      { id: "escalated", resolvedBy: "auto:linear_escalation_cleared" },
    ]);
    expect(getInboxItem(db, "escalated").resolvedAt).not.toBeNull();

    // ESCALATED without observed transition: mere absence of label on creation does not resolve
    const unescalatedFromStartDb = openDb(":memory:");
    createInboxItem(
      unescalatedFromStartDb,
      {
        kind: "ESCALATED",
        title: "fresh escalation",
        refs: { issue: "WM-20" },
      },
      { id: "fresh-escalated", now: 1000 },
    );
    const noLabelIssues = async () => [
      {
        identifier: "WM-20",
        state: { name: "In Progress", type: "started" },
        labels: { nodes: [] },
      },
    ];
    expect(
      await reconcileInbox(unescalatedFromStartDb, {
        now: 60_000,
        linearIssues: noLabelIssues,
      }),
    ).toEqual([]);
    expect(
      getInboxItem(unescalatedFromStartDb, "fresh-escalated").resolvedAt,
    ).toBeNull();

    const failingDb = openDb(":memory:");
    createInboxItem(
      failingDb,
      { kind: "BLOCKED", title: "stay open", refs: { issue: "WM-12" } },
      { id: "transport-error", now: 1000 },
    );
    expect(
      await reconcileInbox(failingDb, {
        now: 60_000,
        linearIssues: async () => {
          throw new Error("offline");
        },
      }),
    ).toEqual([]);
    expect(getInboxItem(failingDb, "transport-error").resolvedAt).toBeNull();

    // fetchLinearInboxIssues empty handling and custom safe request function
    expect(await fetchLinearInboxIssues([])).toEqual([]);
    const mockGql = async (query, vars) => {
      expect(query).toContain("query($i0:String!)");
      expect(vars).toEqual({ i0: "WM-99" });
      return {
        i0: {
          identifier: "WM-99",
          state: { name: "Done", type: "completed" },
          labels: { nodes: [] },
        },
      };
    };
    expect(
      await fetchLinearInboxIssues(["WM-99"], { request: mockGql }),
    ).toEqual([
      {
        identifier: "WM-99",
        state: { name: "Done", type: "completed" },
        labels: { nodes: [] },
      },
    ]);
  });

  test("CI success and the proposal spawned by Ship auto-resolve their matching items", async () => {
    const db = openDb(":memory:");
    createInboxItem(
      db,
      {
        kind: "CI RED",
        title: "red",
        refs: { repo: "factory", pr: "PR #607" },
      },
      { id: "ci-red", now: 1000 },
    );
    const successAt = new Date(2000).toISOString();
    const success = {
      schemaVersion: "factory.event/v1",
      eventId: "merge-pr:factory:607:abc",
      type: "factory.merge.requested",
      source: "github",
      subject: "factory",
      occurredAt: successAt,
      correlationId: "merge-pr:factory:607:abc",
      payload: { repo: "factory", prNumbers: [607] },
    };
    db.query(
      `INSERT INTO events
       (source, event_id, type, subject, occurred_at, received_at,
        correlation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES ('github', ?, ?, 'factory', ?, ?, ?, ?, 'sha256:green', 'admitted', ?)`,
    ).run(
      success.eventId,
      success.type,
      successAt,
      successAt,
      success.correlationId,
      JSON.stringify(success),
      successAt,
    );
    const rerunAt = new Date(1500).toISOString();
    db.query(
      `INSERT INTO events
       (source, event_id, type, subject, occurred_at, received_at,
        correlation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES ('inbox', 'rerun-request', 'factory.ci-rerun.requested', 'factory',
               ?, ?, 'ci-red', '{}', 'sha256:rerun', 'planned', ?)`,
    ).run(rerunAt, rerunAt, rerunAt);
    db.query(
      `INSERT INTO proposals
       (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES ('rerun-proposal', 'inbox', 'rerun-request', 'run', 'open', ?, 1800)`,
    ).run(rerunAt);

    createInboxItem(
      db,
      { kind: "RC READY", title: "ready", refs: { repo: "factory" } },
      { id: "rc-ready", now: 1000 },
    );
    expect(
      bindInboxProposal(db, {
        kind: "RC READY",
        repo: "factory",
        proposalId: "ship-proposal",
      })?.refs,
    ).toMatchObject({ repo: "factory", proposalId: "ship-proposal" });
    db.query(
      `INSERT INTO runs
       (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
       VALUES ('ship-run', 'ship-key', '{}', 'sha256:ship', 'COMPLETED', ?, ?)`,
    ).run(successAt, successAt);
    db.query(
      `INSERT INTO proposals
       (id, event_source, event_id, decision, run_id, status, created_at, ttl_seconds)
       VALUES ('ship-proposal', 'operator', 'ship-event', 'run', 'ship-run', 'approved', ?, 1800)`,
    ).run(successAt);

    expect(await reconcileInbox(db, { now: 3000 })).toEqual([
      { id: "ci-red", resolvedBy: "auto:ci_green" },
      { id: "rc-ready", resolvedBy: "auto:ship_completed" },
    ]);
    expect(getInboxItem(db, "ci-red").refs.proposalId).toBe("rerun-proposal");
  });
});

describe("approving an expired proposal retargets its item (WM-714)", () => {
  const OLD = "prop-old";
  const FRESH = "prop-fresh";

  /**
   * The ledger state WM-391 leaves behind: an approve on an expired proposal
   * supersedes it and opens a fresh one, so the operator's answer bought a new
   * question instead of a decision.
   */
  function replanned(db, { id = "retarget", kind = "proposal_expired" } = {}) {
    insertProposal(db, { id: OLD });
    const refs = { proposalId: OLD, eventSource: "test", eventId: "evt" };
    const request = templateFor(kind, { producer: "proposal", refs });
    createInboxItem(
      db,
      {
        kind,
        title: `DECISION NEEDED proposal ${OLD}: expired undecided`,
        refs,
        source: "serve:notify",
        decision: request,
        dedupeKey: `${kind}:${OLD}`,
      },
      { id },
    );
    return {
      id,
      request,
      approve: {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "approve",
        fields: {},
      },
      // What the real effect does to the proposals table alongside its result.
      applyEffect: () => {
        db.query("UPDATE proposals SET status = 'superseded' WHERE id = ?").run(
          OLD,
        );
        insertProposal(db, { id: FRESH });
        return {
          outcome: "applied",
          detail: "replanned_awaiting_approval",
          newProposalId: FRESH,
        };
      },
    };
  }

  test("the item is re-opened against the fresh proposal instead of resolving", () => {
    const db = openDb(":memory:");
    const { id, approve, applyEffect } = replanned(db);

    const decided = decideInboxItem(db, id, approve, {
      now: 2000,
      applyEffect,
    });
    expect(decided.effect).toMatchObject({
      kind: "approve_proposal",
      outcome: "applied",
      detail: "replanned_awaiting_approval",
      newProposalId: FRESH,
    });

    const item = decided.item;
    expect(item.resolvedAt).toBeNull();
    expect(item.resolvedBy).toBeNull();
    expect(item.refs.proposalId).toBe(FRESH);
    // Undecided again: the fresh spec is a question nobody has answered.
    expect(item.response).toBeNull();
    expect(item.decidedAt).toBeNull();
    expect(item.decidedBy).toBeNull();
    expect(item.decision.question).toContain(FRESH);
    expect(item.decision.context).toContain("please re-review");
    expect(item.decision.context).toContain(OLD);
    // The operator's approve is preserved, not discarded.
    expect(item.responseHistory).toHaveLength(1);
    expect(item.responseHistory[0]).toMatchObject({
      retargetedFrom: OLD,
      retargetedTo: FRESH,
      retargetedAt: new Date(2000).toISOString(),
    });
    expect(item.responseHistory[0].response).toMatchObject({
      optionId: "approve",
      decidedBy: "operator",
      effect: { detail: "replanned_awaiting_approval", newProposalId: FRESH },
    });
    // The fresh request is answerable: its hash binds to what is stored now.
    expect(getInboxItem(db, id).decision).toEqual(item.decision);
  });

  test("retry is refused after a retarget and the fresh decision resolves the item", () => {
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    decideInboxItem(db, id, approve, { now: 2000, applyEffect });

    // The recorded answer was consumed by the retarget, so there is nothing to
    // replay — the old bug answered `already_applied` on a resolved item.
    expect(() => retryInboxDecision(db, id)).toThrow(/has not been decided/);

    const retargeted = getInboxItem(db, id);
    const approveFresh = decideInboxItem(
      db,
      id,
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(retargeted.decision),
        optionId: "approve",
        fields: {},
      },
      {
        now: 3000,
        applyEffect: () => ({ outcome: "applied" }),
      },
    );
    expect(approveFresh.item.resolvedBy).toBe("operator:approve_proposal");
    expect(approveFresh.item.resolvedAt).toBe(new Date(3000).toISOString());
    expect(approveFresh.item.responseHistory).toHaveLength(1);
  });

  test("a retargeted item survives reconcile until the fresh proposal is decided", () => {
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    decideInboxItem(db, id, approve, { now: 2000, applyEffect });

    // The superseded proposal no longer governs the item; the fresh open one does.
    expect(
      db.query("SELECT status FROM proposals WHERE id = ?").get(OLD).status,
    ).toBe("superseded");
    expect(reconcileInbox(db, { now: 4000 })).toEqual([]);
    expect(getInboxItem(db, id).resolvedAt).toBeNull();

    db.query("UPDATE proposals SET status = 'approved' WHERE id = ?").run(
      FRESH,
    );
    expect(reconcileInbox(db, { now: 5000 })).toEqual([
      { id, resolvedBy: "auto:proposal_decided" },
    ]);
  });

  test("the serve tick leaves a retargeted item open", async () => {
    const { tick } = await import("../cli.mjs");
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    decideInboxItem(db, id, approve, { now: 2000, applyEffect });
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
    expect(getInboxItem(db, id).resolvedAt).toBeNull();
  });

  test("the dedupe key follows the retarget so the fresh proposal cannot stack a second item", () => {
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    decideInboxItem(db, id, approve, { now: 2000, applyEffect });
    expect(getInboxItem(db, id).dedupeKey).toBe(`proposal_expired:${FRESH}`);

    const refs = { proposalId: FRESH, eventSource: "test", eventId: "evt" };
    const again = createInboxItem(db, {
      kind: "proposal_expired",
      title: `DECISION NEEDED proposal ${FRESH}: expired undecided`,
      refs,
      source: "serve:notify",
      decision: templateFor("proposal_expired", {
        producer: "proposal",
        refs,
      }),
      dedupeKey: `proposal_expired:${FRESH}`,
    });
    expect(again.id).toBe(id);
    expect(again.title).toBe(
      `DECISION NEEDED proposal ${FRESH}: expired undecided`,
    );
    expect(listInboxItems(db).map((item) => item.title)).toEqual([
      `DECISION NEEDED proposal ${FRESH}: expired undecided`,
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(1);
    // Supersession does not lose the retarget the operator already paid for.
    expect(again.responseHistory).toHaveLength(1);
  });

  test("retarget updates the list title to the fresh proposal", () => {
    const db = openDb(":memory:");
    const { id, approve, applyEffect } = replanned(db);
    decideInboxItem(db, id, approve, { now: 2000, applyEffect });
    const listed = listInboxItems(db);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toContain(FRESH);
    expect(listed[0].title).not.toContain(OLD);
    expect(getInboxItem(db, id).title).toContain(FRESH);
  });

  test("applied replanned with no newProposalId is recorded failed and stays retryable", () => {
    const db = openDb(":memory:");
    const { id, approve } = replanned(db);
    const decided = decideInboxItem(db, id, approve, {
      now: 2000,
      applyEffect: () => ({
        outcome: "applied",
        detail: "replanned_awaiting_approval",
      }),
    });
    expect(decided.effect.outcome).toBe("failed");
    expect(decided.item.resolvedAt).toBeNull();
    expect(decided.item.response.effect.outcome).toBe("failed");
    expect(decided.item.response.effect.detail).toBe(
      "replanned_awaiting_approval",
    );

    let invoked = 0;
    const retried = retryInboxDecision(db, id, {
      now: 3000,
      applyEffect: () => {
        invoked += 1;
        return {
          outcome: "applied",
          detail: "replanned_awaiting_approval",
          newProposalId: FRESH,
        };
      },
    });
    expect(invoked).toBe(1);
    expect(retried.item.refs.proposalId).toBe(FRESH);
    expect(retried.item.resolvedAt).toBeNull();
  });

  test("applied replanned with an empty newProposalId is also failed and retryable", () => {
    const db = openDb(":memory:");
    const { id, approve } = replanned(db);
    const decided = decideInboxItem(db, id, approve, {
      now: 2000,
      applyEffect: () => ({
        outcome: "applied",
        detail: "replanned_awaiting_approval",
        newProposalId: "   ",
      }),
    });
    expect(decided.effect.outcome).toBe("failed");
    expect(decided.item.resolvedAt).toBeNull();
    expect(decided.item.response.effect.outcome).toBe("failed");
    let invoked = 0;
    retryInboxDecision(db, id, {
      applyEffect: () => {
        invoked += 1;
        return { outcome: "applied" };
      },
    });
    expect(invoked).toBe(1);
  });
});

describe("inbox decisions register precedent memos (WM-812)", () => {
  const NOW = Date.parse("2026-08-16T12:00:00.000Z");

  function decideDismiss(db, { id, refs, now = NOW, artifactStore, fields }) {
    const request = decision();
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "decide",
        refs,
        decision: request,
      },
      { id },
    );
    return decideInboxItem(
      db,
      id,
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "dismiss",
        fields: fields ?? {},
      },
      { now, artifactStore },
    );
  }

  test("applied decisions register a precedentOnly memo per issue/repo/pr subject and store the bytes", () => {
    const db = openDb(":memory:");
    const store = tmpDir("evrt-inbox-decision-store-");
    const decided = decideDismiss(db, {
      id: "inbox_812",
      refs: { issue: "wm-313", repo: "factory", pr: "612" },
      artifactStore: store,
    });
    expect(decided.effect.outcome).toBe("applied");
    expect(decided.memos).toHaveLength(3);
    expect(decided.memos.every((row) => row.inserted)).toBe(true);

    const ticket = listMemos(
      db,
      { type: "ticket", id: "WM-313" },
      { now: NOW },
    );
    const repo = listMemos(db, { type: "repo", id: "factory" }, { now: NOW });
    const pr = listMemos(db, { type: "pr", id: "factory#612" }, { now: NOW });
    expect(ticket).toHaveLength(1);
    expect(repo).toHaveLength(1);
    expect(pr).toHaveLength(1);
    expect(ticket[0].kind).toBe("decision");
    expect(ticket[0].runId).toBeNull();
    expect(ticket[0].inboxItemId).toBe("inbox_812");

    for (const row of decided.memos) {
      const file = path.join(store, row.sha256);
      expect(existsSync(file)).toBe(true);
      const document = JSON.parse(readFileSync(file, "utf8"));
      expect(document).toMatchObject({
        schemaVersion: MEMO_SCHEMA_VERSION,
        kind: "decision",
        precedentOnly: true,
        refs: { inboxItemId: "inbox_812" },
        provenance: { agent: "runtime:inbox", runId: null },
      });
      expect(document.body).toBe("Operator chose `dismiss` on 2026-08-16.");
      expect(memoDigest(document)).toBe(row.sha256);
    }
    db.close();
  });

  test("failed and unsupported effects do not register; a successful retry does", () => {
    const db = openDb(":memory:");
    const store = tmpDir("evrt-inbox-decision-retry-store-");
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "retry memo",
        refs: { issue: "WM-812" },
        decision: request,
      },
      { id: "retry_memo" },
    );
    const failed = decideInboxItem(
      db,
      "retry_memo",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "triage",
        fields: {},
      },
      {
        now: NOW,
        artifactStore: store,
        applyEffect: () => ({ outcome: "failed", error: "Linear unavailable" }),
      },
    );
    expect(failed.effect.outcome).toBe("failed");
    expect(failed.memos).toEqual([]);
    expect(
      listMemos(db, { type: "ticket", id: "WM-812" }, { now: NOW }),
    ).toEqual([]);

    const retried = retryInboxDecision(db, "retry_memo", {
      now: NOW + 1000,
      artifactStore: store,
      applyEffect: () => ({ kind: "send_to_triage", outcome: "applied" }),
    });
    expect(retried.effect.outcome).toBe("applied");
    expect(retried.memos).toHaveLength(1);
    expect(
      listMemos(db, { type: "ticket", id: "WM-812" }, { now: NOW + 1000 }),
    ).toHaveLength(1);
    db.close();
  });

  test("a proposal re-plan does not register a decision memo", () => {
    const db = openDb(":memory:");
    insertProposal(db, { id: "prop-old" });
    const refs = {
      proposalId: "prop-old",
      eventSource: "test",
      eventId: "evt",
    };
    const request = templateFor("proposal_expired", {
      producer: "proposal",
      refs,
    });
    createInboxItem(
      db,
      {
        kind: "proposal_expired",
        title: "retarget",
        refs,
        source: "serve:notify",
        decision: request,
        dedupeKey: "proposal_expired:prop-old",
      },
      { id: "no_memo_replan" },
    );
    const decided = decideInboxItem(
      db,
      "no_memo_replan",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "approve",
        fields: {},
      },
      {
        now: NOW,
        artifactStore: tmpDir("evrt-inbox-decision-replan-"),
        applyEffect: () => ({
          outcome: "applied",
          detail: "replanned_awaiting_approval",
          newProposalId: "prop-fresh",
        }),
      },
    );
    expect(decided.effect.detail).toBe("replanned_awaiting_approval");
    expect(decided.memos).toBeUndefined();
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(0);
    db.close();
  });

  test("authorise descriptionHash binds only the ticket-subject memo", () => {
    const db = openDb(":memory:");
    const store = tmpDir("evrt-inbox-decision-bind-");
    const request = decision([
      {
        id: "authorise",
        label: "Authorise",
        effect: "authorise",
        scope: { paths: ["pi"], summary: "Use the file secret" },
      },
    ]);
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "authorise",
        refs: { issue: "WM-812", repo: "factory", runId: "run_refused" },
        decision: request,
      },
      { id: "bind_hash" },
    );
    const descriptionHash = `sha256:${"ab".repeat(32)}`;
    const decided = decideInboxItem(
      db,
      "bind_hash",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "authorise",
        fields: {},
      },
      {
        now: NOW,
        artifactStore: store,
        applyEffect: () => ({
          kind: "authorise",
          outcome: "applied",
          descriptionHash,
        }),
      },
    );
    expect(decided.memos).toHaveLength(2);
    const ticketDoc = JSON.parse(
      readFileSync(
        path.join(
          store,
          decided.memos.find((row) => row.subject.type === "ticket").sha256,
        ),
        "utf8",
      ),
    );
    const repoDoc = JSON.parse(
      readFileSync(
        path.join(
          store,
          decided.memos.find((row) => row.subject.type === "repo").sha256,
        ),
        "utf8",
      ),
    );
    expect(ticketDoc.bindings).toEqual({ descriptionHash });
    expect(repoDoc.bindings).toBeUndefined();
    db.close();
  });
});

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
  PENDING_EFFECT_CLAIM_TIMEOUT_MS,
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
  synthesizeInboxItem,
} from "./inbox.mjs";
import { decisionRequestHash } from "./decision.mjs";
import { templateFor } from "./decision-templates.mjs";
import { listMemos, MEMO_SCHEMA_VERSION, memoDigest } from "./memos.mjs";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";

const inboxDocPath = path.resolve(
  import.meta.dir,
  "../../docs/event-runtime-inbox.md",
);
const inboxSourcePath = path.resolve(import.meta.dir, "inbox.mjs");

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last < 0)
    throw new Error(`missing source boundary ${start}`);
  return source.slice(first, last);
}

function decisionErrorCodesFromSource() {
  const source = readFileSync(inboxSourcePath, "utf8");
  const operations = [
    between(source, "function decisionRow", "/** WM-391"),
    between(
      source,
      "function retargetInboxDecision",
      "/**\n * Record the effect outcome",
    ),
    between(
      source,
      "function decideInboxItemInTransaction",
      "export async function decideInboxItem",
    ),
    between(
      source,
      "function retryInboxDecisionInTransaction",
      "export async function retryInboxDecision",
    ),
  ];
  return [
    ...new Set(
      operations.flatMap((operation) =>
        [...operation.matchAll(/new InboxDecisionError\(\s*"([^"]+)"/g)].map(
          ([, code]) => code,
        ),
      ),
    ),
  ].sort();
}

function documentedDecisionErrorCodes() {
  const document = readFileSync(inboxDocPath, "utf8");
  const block = document.match(
    /<!-- inbox-decision-errors:start -->([\s\S]*?)<!-- inbox-decision-errors:end -->/,
  )?.[1];
  if (!block) throw new Error("missing inbox decision error documentation");
  return [...block.matchAll(/^\|\s*`([^`]+)`\s*\|\s*\d{3}\s*\|/gm)]
    .map(([, code]) => code)
    .sort();
}

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

test("the documented decision API errors match decide and retry", () => {
  expect(documentedDecisionErrorCodes()).toEqual(
    decisionErrorCodesFromSource(),
  );
});

describe("human inbox ledger (WM-285)", () => {
  test("synthesizes an operator-readable inbox message and explains decision effects", () => {
    const request = {
      schemaVersion: "factory.decision-request/v1",
      question: "How should the factory proceed with watt-mind/factory#1158?",
      context: "The dispatch run stopped before opening a pull request.",
      options: [
        {
          id: "triage",
          label: "Send back to Triage",
          effect: "send_to_triage",
        },
        { id: "answer", label: "Answer the agent", effect: "answer" },
      ],
    };
    const item = synthesizeInboxItem({
      kind: "BLOCKED",
      title:
        "BLOCKED factory.dispatch.requested run_123-watt-mind/factory#1158: owned_paths_not_closed",
      reasonCode: "owned_paths_not_closed",
      refs: {
        repo: "factory",
        issue: "watt-mind/factory#1158",
        runId: "run_123",
        pr: "42",
      },
      decision: request,
    });

    expect(item.title).toBe(
      "Blocked: factory#1158 — its allowed paths do not cover every required file",
    );
    expect(item.body).toContain("What happened: An item needs attention");
    expect(item.body).toContain("Why it matters: The ticket's allowed paths");
    expect(item.body).toContain("Ticket: watt-mind/factory#1158");
    expect(item.body).toContain("Run: run_123");
    expect(item.body).toContain("PR: 42");
    expect(item.body).toContain("Send back to Triage — removes ai:agent-ready");
    expect(item.body).toContain(
      "Answer the agent — records the operator's reply",
    );
  });

  test("synthesizes titles and bodies for every inbox kind, including unknown reasons", () => {
    for (const kind of INBOX_KINDS) {
      const reason =
        kind === "proposal_expired" ? "proposal_expired" : "novel_reason";
      const item = synthesizeInboxItem({
        kind,
        title: `machine ${kind}: ${reason}`,
        reasonCode: reason,
        refs: { issue: "watt-mind/factory#1158", runId: "run_1", pr: "42" },
      });
      expect(item.title).toMatch(/^[A-Z]|^Blocked:|^Escalated:|^CI failed:/);
      expect(item.body).toContain("What happened:");
      expect(item.body).toContain("Why it matters:");
      expect(item.body).toContain(`Reason code: ${reason}.`);
      expect(item.body).toContain("Ticket: watt-mind/factory#1158");
      expect(item.body).toContain("Run: run_1");
      expect(item.body).toContain("PR: 42");
    }
  });

  test("never invents a reason code out of a producer's free-text title", () => {
    const item = synthesizeInboxItem({
      kind: "BLOCKED",
      // Reads like a reason code, but nothing structured says it is one.
      title: "BLOCKED factory#1158: owned_paths_not_closed",
      refs: { issue: "watt-mind/factory#1158" },
    });
    expect(item.title).toBe("Blocked: factory#1158");
    expect(item.body).not.toContain("Reason code:");
    expect(item.body).not.toContain("allowed paths");
  });

  test('names the event a parked notice refers to instead of "this item"', () => {
    const item = synthesizeInboxItem({
      kind: "BLOCKED",
      title: "BLOCKED linear.ticket.agent_ready evt-park: repo_report_only",
      reasonCode: "repo_report_only",
      eventType: "linear.ticket.agent_ready",
      refs: { eventSource: "linear", eventId: "evt-park" },
    });
    expect(item.body).toContain(
      "What happened: An item needs attention for linear.ticket.agent_ready evt-park (blocked).",
    );
    expect(item.body).toContain("Reason code: repo_report_only.");
    expect(
      synthesizeInboxItem({
        kind: "BLOCKED",
        title: "BLOCKED evt-park",
        refs: { eventSource: "linear", eventId: "evt-park", repo: "factory" },
      }).body,
    ).toContain("for event evt-park (factory) (blocked).");
  });

  test("uses cached ticket titles and proposal subjects in human titles", () => {
    const ticket = synthesizeInboxItem({
      kind: "BLOCKED",
      title: "BLOCKED factory#1158: owned_paths_not_closed",
      reasonCode: "owned_paths_not_closed",
      ticketTitle: "select Opus only for Claude parent runs",
      refs: { issue: "watt-mind/factory#1158" },
    });
    expect(ticket.title).toBe(
      'Blocked: factory#1158 "select Opus only for Claude parent runs" — its allowed paths do not cover every required file',
    );

    const proposal = synthesizeInboxItem({
      kind: "decision_needed",
      title: "Reaper",
      refs: { proposalId: "proposal-1" },
      decision: {
        question: "Run reaper@1 for hourly sweep?",
        options: [{ label: "Approve", effect: "approve_proposal" }],
      },
    });
    expect(proposal.title).toBe("Approve reaper run (hourly sweep)?");
    expect(proposal.body).toContain(
      "Approve — approves the proposal and allows its run to proceed.",
    );
  });

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

  test("synthesizes agent-source presentation inside createInboxItem", () => {
    const db = openDb(":memory:");
    const input = {
      kind: "ESCALATED",
      title: "ESCALATED WM-2047: needs_human",
      body: "The agent needs an operator decision.",
      reasonCode: "needs_human",
      ticketTitle: "consolidate presentation synthesis",
      refs: { issue: "WM-2047", repo: "factory", runId: "run_2047" },
      source: "agent:run_2047",
      decision: decision(),
      dedupeKey: "ESCALATED:WM-2047",
    };
    const expected = synthesizeInboxItem(input);

    const created = createInboxItem(db, input, {
      id: "agent_presentation",
      now: 1000,
    });

    expect({ title: created.title, body: created.body }).toEqual({
      title: expected.title,
      body: expected.body,
    });
    expect(created.decision).toEqual(input.decision);
    expect(created.dedupeKey).toBe(input.dedupeKey);
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
    expect(second.body).toContain("old");
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

  test("a dispatch proposal item stores a human-readable title and decision details", () => {
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
        ticketTitle: "select Opus only for Claude parent runs",
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
      'Approve dispatch run (WM-862 "select Opus only for Claude parent runs")?',
    );
    expect(created.body).toContain("Question: Run dispatch@1 for WM-862");
    expect(created.body).toContain("Approve proposal — approves the proposal");
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
    expect(second.title).toBe("Escalated: WM-1");
    expect(second.body).toContain("new");
    expect(second.refs).toEqual({ issue: "WM-1", runId: "run_2" });
    expect(second.decision).toEqual(replacement);
    expect(second.delivery.supersededDecisions).toBe(1);
    expect(second.waiters).toEqual([]);
  });

  test("decideInboxItem fans the effect out across waiters bound to each run", async () => {
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
    const decided = await decideInboxItem(
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

  test("dedupe supersession clears a stored response to avoid binding it to a new request", async () => {
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
    const answered = await decideInboxItem(db, "first", {
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

  test("deciding validates freshness, records the effect, and resolves only applied effects", async () => {
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
    await expect(
      decideInboxItem(db, item.id, {
        schemaVersion: "factory.decision-response/v1",
        requestHash: "sha256:" + "0".repeat(64),
        optionId: "dismiss",
        fields: {},
      }),
    ).rejects.toThrow("has changed");
    await expect(
      decideInboxItem(db, item.id, {
        requestHash: decisionRequestHash(request),
        optionId: "go",
        fields: {},
      }),
    ).rejects.toThrow("schemaVersion");

    const unsupported = await decideInboxItem(
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
    await expect(
      decideInboxItem(db, item.id, {
        requestHash: decisionRequestHash(request),
        optionId: "go",
        fields: {},
      }),
    ).rejects.toThrow("already decided");

    const retried = await retryInboxDecision(db, item.id, {
      now: 3000,
      applyEffect: () => ({ kind: "send_to_triage", outcome: "applied" }),
      artifactStore: null,
    });
    expect(retried.item.resolvedBy).toBe("operator:send_to_triage");
    expect(retried.item.resolvedAt).toBe(new Date(3000).toISOString());
    expect(retried.item.response.effect.retryAttempt).toBe(1);
    await expect(retryInboxDecision(db, item.id)).rejects.toThrow(
      "already applied",
    );
  });

  test("whitespace-only required text is rejected before a response is recorded", async () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "answer", label: "Answer", effect: "answer" },
    ]);
    request.fields = [
      { id: "reply", kind: "text", label: "Reply", required: true },
    ];
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "answer",
        refs: { issue: "WM-1" },
        decision: request,
      },
      { id: "whitespace_response" },
    );

    try {
      await decideInboxItem(db, "whitespace_response", {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "answer",
        fields: { reply: " \n " },
      });
      throw new Error("expected invalid response");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_response",
        status: 400,
        errors: ["$.fields.reply: required text must not be empty"],
      });
    }
    expect(getInboxItem(db, "whitespace_response").response).toBeNull();
  });

  test("each failed retry advances a durable attempt token", async () => {
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
    await decideInboxItem(db, "retry_attempts", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    });
    expect(
      (await retryInboxDecision(db, "retry_attempts")).item.response.effect
        .retryAttempt,
    ).toBe(1);
    expect(
      (await retryInboxDecision(db, "retry_attempts")).item.response.effect
        .retryAttempt,
    ).toBe(2);
  });

  test("decision effects leave the write lock free while they await transport", async () => {
    const directory = tmpDir("evrt-inbox-effect-lock-");
    const filename = path.join(directory, "inbox.sqlite");
    const db = openDb(filename);
    const other = openDb(filename);
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "slow effect",
        refs: { issue: "WM-1434" },
        decision: request,
      },
      { id: "slow_effect" },
    );
    let effectStarted;
    const started = new Promise((resolve) => {
      effectStarted = resolve;
    });
    let releaseEffect;
    const effectFinished = new Promise((resolve) => {
      releaseEffect = resolve;
    });
    let deciding;
    try {
      deciding = decideInboxItem(
        db,
        "slow_effect",
        {
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(request),
          optionId: "triage",
          fields: {},
        },
        {
          applyEffect: async () => {
            effectStarted();
            await effectFinished;
            return { outcome: "applied" };
          },
        },
      );
      await started;

      expect(() =>
        createInboxItem(other, { kind: "BLOCKED", title: "other writer" }),
      ).not.toThrow();
      await expect(
        decideInboxItem(db, "slow_effect", {
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(request),
          optionId: "triage",
          fields: {},
        }),
      ).rejects.toMatchObject({ code: "already_decided" });
      await expect(retryInboxDecision(db, "slow_effect")).rejects.toMatchObject(
        { code: "effect_pending" },
      );
      expect(getInboxItem(db, "slow_effect").response.effect).toMatchObject({
        kind: "send_to_triage",
        outcome: "pending",
        retryAttempt: 0,
        claimedAt: expect.any(String),
      });

      releaseEffect();
      await deciding;
      expect(getInboxItem(db, "slow_effect").response.effect).toEqual({
        kind: "send_to_triage",
        outcome: "applied",
      });
    } finally {
      releaseEffect?.();
      await deciding;
      other.close();
      db.close();
    }
  });

  test("a failed decision effect leaves the item open and decidable (AC3b)", async () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "linear is down",
        refs: { issue: "WM-1500" },
        decision: request,
      },
      { id: "failed_effect_item" },
    );
    const response = {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    };
    const decided = await decideInboxItem(db, "failed_effect_item", response, {
      now: 1_000,
      applyEffect: () => ({ outcome: "failed", error: "linear unreachable" }),
    });
    expect(decided.effect).toEqual({
      kind: "send_to_triage",
      outcome: "failed",
      error: "linear unreachable",
    });
    // The control-API path must not resolve the item on a failed effect —
    // it stays open (unresolved) so the operator can retry the decision.
    expect(decided.item.resolvedAt).toBeNull();
    expect(decided.item.resolvedBy).toBeNull();
    const stored = getInboxItem(db, "failed_effect_item");
    expect(stored.resolvedAt).toBeNull();
    expect(stored.response.effect).toMatchObject({
      outcome: "failed",
      error: "linear unreachable",
    });

    // Still decidable: a retry with a successful effect resolves it.
    const retried = await retryInboxDecision(db, "failed_effect_item", {
      now: 2_000,
      applyEffect: () => ({ outcome: "applied" }),
    });
    expect(retried.item.resolvedAt).toBe(new Date(2_000).toISOString());
  });

  test("a retry takes over a pending claim once it is older than the transport timeout", async () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "crashed mid-effect",
        refs: { issue: "WM-1434" },
        decision: request,
      },
      { id: "stale_claim" },
    );
    const response = {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    };
    // Simulate serve dying between the claim and the settle: the claim commits
    // and the effect never returns.
    const crashed = decideInboxItem(db, "stale_claim", response, {
      now: 1_000,
      applyEffect: () => new Promise(() => {}),
    });
    await Promise.resolve();
    expect(getInboxItem(db, "stale_claim").response.effect).toMatchObject({
      outcome: "pending",
      retryAttempt: 0,
      claimedAt: new Date(1_000).toISOString(),
    });

    // Inside the window the claim is still owned.
    await expect(
      retryInboxDecision(db, "stale_claim", {
        now: 1_000 + PENDING_EFFECT_CLAIM_TIMEOUT_MS - 1,
      }),
    ).rejects.toMatchObject({ code: "effect_pending", status: 409 });
    await expect(
      decideInboxItem(db, "stale_claim", response, { now: 2_000 }),
    ).rejects.toMatchObject({ code: "already_decided" });

    // Past the window a retry takes the claim over and settles the item.
    const takeoverAt = 1_000 + PENDING_EFFECT_CLAIM_TIMEOUT_MS;
    const retried = await retryInboxDecision(db, "stale_claim", {
      now: takeoverAt,
      applyEffect: () => ({ outcome: "applied" }),
    });
    expect(retried.effect).toEqual({
      kind: "send_to_triage",
      outcome: "applied",
    });
    expect(retried.item.response.effect).toEqual({
      kind: "send_to_triage",
      outcome: "applied",
      retryAttempt: 1,
    });
    expect(retried.item.resolvedAt).toBe(new Date(takeoverAt).toISOString());
    expect(retried.item.resolvedBy).toBe("operator:send_to_triage");
    await expect(retryInboxDecision(db, "stale_claim")).rejects.toMatchObject({
      code: "already_applied",
    });
    void crashed;
  });

  test("a stale owner cannot overwrite the settlement from its takeover", async () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "starved owner",
        refs: { issue: "WM-1434" },
        decision: request,
      },
      { id: "taken_over_claim" },
    );
    const response = {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    };
    let finishStaleEffect;
    const stale = decideInboxItem(db, "taken_over_claim", response, {
      now: 1_000,
      applyEffect: () =>
        new Promise((resolve) => {
          finishStaleEffect = () => resolve({ outcome: "applied" });
        }),
    });
    await Promise.resolve();

    const takeoverAt = 1_000 + PENDING_EFFECT_CLAIM_TIMEOUT_MS;
    const takeover = await retryInboxDecision(db, "taken_over_claim", {
      now: takeoverAt,
      applyEffect: () => ({ outcome: "applied" }),
    });
    expect(takeover.item.response.effect).toEqual({
      kind: "send_to_triage",
      outcome: "applied",
      retryAttempt: 1,
    });

    finishStaleEffect();
    await expect(stale).resolves.toMatchObject({
      claimLost: true,
      effect: { kind: "send_to_triage", outcome: "claim_lost" },
    });
    expect(getInboxItem(db, "taken_over_claim")).toMatchObject({
      resolvedAt: new Date(takeoverAt).toISOString(),
      resolvedBy: "operator:send_to_triage",
      response: {
        effect: {
          kind: "send_to_triage",
          outcome: "applied",
          retryAttempt: 1,
        },
      },
    });
  });

  test("a retry claim that dies mid-effect can be taken over as well", async () => {
    const db = openDb(":memory:");
    const request = decision([
      { id: "triage", label: "Triage", effect: "send_to_triage" },
    ]);
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "crashed mid-retry",
        refs: { issue: "WM-1434" },
        decision: request,
      },
      { id: "stale_retry_claim" },
    );
    await decideInboxItem(
      db,
      "stale_retry_claim",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "triage",
        fields: {},
      },
      { now: 1_000, applyEffect: () => ({ outcome: "failed", error: "down" }) },
    );
    const crashed = retryInboxDecision(db, "stale_retry_claim", {
      now: 5_000,
      applyEffect: () => new Promise(() => {}),
    });
    await Promise.resolve();
    expect(getInboxItem(db, "stale_retry_claim").response.effect).toMatchObject(
      {
        outcome: "pending",
        retryAttempt: 1,
        claimedAt: new Date(5_000).toISOString(),
      },
    );
    await expect(
      retryInboxDecision(db, "stale_retry_claim", { now: 6_000 }),
    ).rejects.toMatchObject({ code: "effect_pending" });
    const retried = await retryInboxDecision(db, "stale_retry_claim", {
      now: 5_000 + PENDING_EFFECT_CLAIM_TIMEOUT_MS,
      applyEffect: () => ({ outcome: "applied" }),
    });
    expect(retried.item.response.effect).toMatchObject({
      outcome: "applied",
      retryAttempt: 2,
    });
    expect(retried.item.resolvedAt).toBe(
      new Date(5_000 + PENDING_EFFECT_CLAIM_TIMEOUT_MS).toISOString(),
    );
    void crashed;
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

  test("markInboxDelivered merges onto delivery_json without deciding", async () => {
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

    const decided = await decideInboxItem(db, "inbox_mark", {
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

  test("list items and counts share the expired-open predicate", () => {
    const db = openDb(":memory:");
    const expiredAt = new Date(Date.now() - 61_000).toISOString();
    const liveAt = new Date().toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES ('expired-proposal', 'test', 'evt', 'run', 'open', ?, 60)`,
    ).run(expiredAt);
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES ('live-proposal', 'test', 'live-evt', 'run', 'open', ?, 60)`,
    ).run(liveAt);
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES ('parked-proposal', 'test', 'parked-evt', 'human_needed', 'open', ?, 60)`,
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
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "live by proposal",
        refs: { proposalId: "live-proposal" },
      },
      { id: "live-proposal-item" },
    );
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "parked by proposal",
        refs: { proposalId: "parked-proposal" },
      },
      { id: "parked-proposal-item" },
    );

    const items = listInboxItems(db, { status: "all" });
    expect(
      items.find((item) => item.id === "expired-proposal-item"),
    ).toMatchObject({
      expired: true,
    });
    expect(getInboxItem(db, "expired-proposal-item")).toMatchObject({
      expired: true,
    });
    expect(
      items.find((item) => item.id === "live-proposal-item"),
    ).toMatchObject({
      expired: false,
    });
    expect(
      items.find((item) => item.id === "parked-proposal-item"),
    ).toMatchObject({
      expired: false,
    });
    expect(getInboxItem(db, "parked-proposal-item")).toMatchObject({
      expired: false,
    });
    expect(inboxCounts(db)).toMatchObject({
      open: items.filter(
        (item) =>
          item.resolvedAt === null && item.ackedAt === null && !item.expired,
      ).length,
      acked: 0,
    });
  });

  test("inbox expiry lookups use the proposals primary-key index", () => {
    const db = openDb(":memory:");
    const expiredAt = new Date(Date.now() - 61_000).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES ('expired-proposal', 'test', 'evt', 'run', 'open', ?, 60)`,
    ).run(expiredAt);
    createInboxItem(
      db,
      {
        kind: "decision_needed",
        title: "expired by proposal",
        refs: { proposalId: "expired-proposal" },
      },
      { id: "expired-proposal-item" },
    );

    const expiryPredicate = `(i.kind = 'proposal_expired' OR EXISTS (
      SELECT 1 FROM proposals p
       WHERE p.id = i.proposal_id
         AND p.status = 'open'
         AND p.ttl_seconds > 0
         AND unixepoch(p.created_at) + p.ttl_seconds <= unixepoch()
    ))`;
    const planFor = (sql) =>
      db
        .query(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join(" ");
    const listPlan = planFor(`
      SELECT i.*, i.rowid AS list_rowid, ${expiryPredicate} AS expired
      FROM inbox_items i
      WHERE 1 = 1
      ORDER BY i.created_at DESC, i.rowid DESC
      LIMIT 101
    `);
    const countsPlan = planFor(`
      SELECT SUM(CASE WHEN i.resolved_at IS NULL AND i.acked_at IS NULL
                           AND NOT ${expiryPredicate}
                      THEN 1 ELSE 0 END) AS open
      FROM inbox_items i
    `);

    for (const plan of [listPlan, countsPlan]) {
      expect(plan).toContain(
        "SEARCH p USING INDEX sqlite_autoindex_proposals_1 (id=?)",
      );
      expect(plan).not.toContain("SCAN p");
    }
    db.close();
  });

  test("inbox counts complete within 200ms for 10k inbox rows and proposals", () => {
    const db = openDb(":memory:");
    const createdAt = new Date().toISOString();
    const insertProposal = db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES (?, 'test', ?, 'run', 'open', ?, 3600)`,
    );
    const insertInbox = db.query(
      `INSERT INTO inbox_items
         (id, kind, severity, title, refs_json, proposal_id, source, created_at)
       VALUES (?, 'decision_needed', 'normal', 'inbox item', ?, ?, 'cli', ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 10_000; i += 1) {
        const proposalId = `proposal-${i}`;
        insertProposal.run(proposalId, `event-${i}`, createdAt);
        insertInbox.run(
          `inbox-${i}`,
          JSON.stringify({ proposalId }),
          proposalId,
          createdAt,
        );
      }
    })();

    const started = performance.now();
    expect(inboxCounts(db).open).toBe(10_000);
    expect(performance.now() - started).toBeLessThan(loadAdjustedTimeout(200));
    db.close();
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

  test("a run-progress notice for a finished run and a closed ticket auto-resolve as stale", async () => {
    const db = openDb(":memory:");
    const now = new Date(1000).toISOString();
    db.query(
      `INSERT INTO runs
         (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES ('run-terminal', 'terminal-key', '{}', 'sha256:test', 'COMPLETED', 1, ?, ?)`,
    ).run(now, now);
    createInboxItem(
      db,
      {
        kind: "CI RED",
        title: "terminal run",
        refs: { runId: "run-terminal" },
        source: "serve:notify",
      },
      { id: "terminal-run", now: 1000 },
    );
    createInboxItem(
      db,
      {
        kind: "RC READY",
        title: "closed ticket",
        refs: { issue: "WM-closed" },
      },
      { id: "closed-ticket", now: 1000 },
    );

    expect(
      await reconcileInbox(db, {
        now: 60_000,
        linearIssues: async () => [
          {
            identifier: "WM-closed",
            state: { name: "Done", type: "completed" },
            labels: { nodes: [] },
          },
        ],
      }),
    ).toEqual([
      { id: "terminal-run", resolvedBy: "auto:stale_ref" },
      { id: "closed-ticket", resolvedBy: "auto:stale_ref" },
    ]);
    expect(getInboxItem(db, "terminal-run")).toMatchObject({
      resolvedReason: "stale_ref",
    });
    expect(getInboxItem(db, "closed-ticket")).toMatchObject({
      resolvedReason: "stale_ref",
    });
  });

  test("GitHub ticket lookups are deduped per ticket and fail open per row", async () => {
    const db = openDb(":memory:");
    // Two distinct items naming the same ticket — the shape that used to cost
    // one un-batched GitHub read per open item, every poll.
    for (const [id, kind, issue] of [
      ["gh-a", "BLOCKED", "watt-mind/factory#1"],
      ["gh-b", "RC READY", "watt-mind/factory#1"],
      ["gh-c", "BLOCKED", "watt-mind/factory#2"],
    ]) {
      createInboxItem(
        db,
        { kind, title: id, refs: { issue, repo: "factory" } },
        { id, now: 1000 },
      );
    }
    const looked = [];
    const resolved = await reconcileInbox(db, {
      now: 60_000,
      linearIssues: async () => {
        throw new Error("GitHub rows must not reach the Linear batch");
      },
      controlPlane: () => ({
        kind: "github",
        getTicket: async (issue) => {
          looked.push(issue);
          // One unreadable ticket must not sink the whole poll.
          if (issue === "watt-mind/factory#2") throw new Error("rate limited");
          return { state: { name: "Closed", type: "completed" }, labels: [] };
        },
      }),
    });

    // Two rows share one ticket: one lookup, not one per open item.
    expect(looked).toEqual(["watt-mind/factory#1", "watt-mind/factory#2"]);
    expect(resolved).toEqual([
      { id: "gh-a", resolvedBy: "auto:stale_ref" },
      { id: "gh-b", resolvedBy: "auto:stale_ref" },
    ]);
    expect(getInboxItem(db, "gh-c").resolvedAt).toBeNull();
  });

  test("an escalation on a REFUSED run survives reconcile — it is born terminal", async () => {
    const db = openDb(":memory:");
    const at = new Date(1000).toISOString();
    db.query(
      `INSERT INTO runs
         (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES ('run-refused', 'refused-key', '{}', 'sha256:test', 'REFUSED', 1, ?, ?)`,
    ).run(at, at);
    const refs = { runId: "run-refused", issue: "WM-901", repo: "factory" };
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "How should the factory proceed with WM-901?",
        refs,
        source: "agent:run-refused",
        decision: templateFor("ESCALATED", { producer: "escalation", refs }),
      },
      { id: "live-escalation", now: 1000 },
    );
    // A parked ask whose event is still parked must survive the same sweep.
    db.query(
      `INSERT INTO runs
         (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES ('run-done', 'done-key', '{}', 'sha256:test', 'COMPLETED', 1, ?, ?)`,
    ).run(at, at);
    createInboxItem(
      db,
      {
        kind: "human_needed",
        title: "an unanswered ask about a finished run",
        refs: { runId: "run-done" },
        source: "serve:notify",
      },
      { id: "live-ask", now: 1000 },
    );

    expect(
      await reconcileInbox(db, {
        now: 60_000,
        linearIssues: async () => [
          {
            identifier: "WM-901",
            state: { name: "In Progress", type: "started" },
            labels: { nodes: [{ name: "ai:agent-ready" }] },
          },
        ],
      }),
    ).toEqual([]);
    expect(getInboxItem(db, "live-escalation").resolvedAt).toBeNull();
    expect(getInboxItem(db, "live-ask").resolvedAt).toBeNull();
  });

  test("a pending decision becomes moot when its event leaves human_needed", async () => {
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
    await expect(
      decideInboxItem(db, "parked", { optionId: "requeue" }),
    ).rejects.toThrow(/already decided/);
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

  test("CI success reads merge requests once and resolves only its matching CI RED item", async () => {
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
    createInboxItem(
      db,
      {
        kind: "CI RED",
        title: "different PR stays red",
        refs: { repo: "factory", pr: "PR #608" },
      },
      { id: "ci-red-other", now: 1000 },
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

    let mergeRequestedReads = 0;
    const instrumented = new Proxy(db, {
      get(target, property) {
        if (property === "query") {
          return (sql) => {
            if (
              /SELECT admitted_at, subject, envelope_json FROM events\s+WHERE source = 'github'/s.test(
                sql,
              )
            ) {
              mergeRequestedReads += 1;
            }
            return target.query(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(await reconcileInbox(instrumented, { now: 3000 })).toEqual([
      { id: "ci-red", resolvedBy: "auto:ci_green" },
      { id: "rc-ready", resolvedBy: "auto:ship_completed" },
    ]);
    expect(mergeRequestedReads).toBe(1);
    expect(getInboxItem(db, "ci-red").refs.proposalId).toBe("rerun-proposal");
    expect(getInboxItem(db, "ci-red-other").resolvedAt).toBeNull();
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

  test("the item is re-opened against the fresh proposal instead of resolving", async () => {
    const db = openDb(":memory:");
    const { id, approve, applyEffect } = replanned(db);

    const decided = await decideInboxItem(db, id, approve, {
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

  test("retry is refused after a retarget and the fresh decision resolves the item", async () => {
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    await decideInboxItem(db, id, approve, { now: 2000, applyEffect });

    // The recorded answer was consumed by the retarget, so there is nothing to
    // replay — the old bug answered `already_applied` on a resolved item.
    await expect(retryInboxDecision(db, id)).rejects.toThrow(
      /has not been decided/,
    );

    const retargeted = getInboxItem(db, id);
    const approveFresh = await decideInboxItem(
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

  test("a retargeted item survives reconcile until the fresh proposal is decided", async () => {
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    await decideInboxItem(db, id, approve, { now: 2000, applyEffect });

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
    await decideInboxItem(db, id, approve, { now: 2000, applyEffect });
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

  test("the dedupe key follows the retarget so the fresh proposal cannot stack a second item", async () => {
    const db = openDb(":memory:");
    const { id, applyEffect, approve } = replanned(db);
    await decideInboxItem(db, id, approve, { now: 2000, applyEffect });
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
      `Proposal expired: proposal ${FRESH} — The proposal expired before an operator approved or rejected it`,
    );
    expect(listInboxItems(db).map((item) => item.title)).toEqual([
      `Proposal expired: proposal ${FRESH} — The proposal expired before an operator approved or rejected it`,
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(1);
    // Supersession does not lose the retarget the operator already paid for.
    expect(again.responseHistory).toHaveLength(1);
  });

  test("retarget updates the list title to the fresh proposal", async () => {
    const db = openDb(":memory:");
    const { id, approve, applyEffect } = replanned(db);
    await decideInboxItem(db, id, approve, { now: 2000, applyEffect });
    const listed = listInboxItems(db);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toContain(FRESH);
    expect(listed[0].title).not.toContain(OLD);
    expect(getInboxItem(db, id).title).toContain(FRESH);
  });

  test("applied replanned with no newProposalId is recorded failed and stays retryable", async () => {
    const db = openDb(":memory:");
    const { id, approve } = replanned(db);
    const decided = await decideInboxItem(db, id, approve, {
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
    const retried = await retryInboxDecision(db, id, {
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

  test("applied replanned with an empty newProposalId is also failed and retryable", async () => {
    const db = openDb(":memory:");
    const { id, approve } = replanned(db);
    const decided = await decideInboxItem(db, id, approve, {
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
    await retryInboxDecision(db, id, {
      applyEffect: () => {
        invoked += 1;
        return { outcome: "applied" };
      },
    });
    expect(invoked).toBe(1);
  });

  test("a starved approve that loses its claim to a takeover does not retarget", async () => {
    const db = openDb(":memory:");
    const { id, approve, applyEffect } = replanned(db);
    let finishStaleEffect;
    const stale = decideInboxItem(db, id, approve, {
      now: 1_000,
      applyEffect: () =>
        new Promise((resolve) => {
          finishStaleEffect = () => resolve(applyEffect());
        }),
    });
    await Promise.resolve();

    // The owner starves past the claim timeout and a retry takes the claim
    // over, settling the item as a plain approval.
    const takeoverAt = 1_000 + PENDING_EFFECT_CLAIM_TIMEOUT_MS;
    const takeover = await retryInboxDecision(db, id, {
      now: takeoverAt,
      applyEffect: () => ({ outcome: "applied" }),
    });
    expect(takeover.claimLost).toBeUndefined();
    expect(takeover.item.resolvedAt).toBe(new Date(takeoverAt).toISOString());
    expect(takeover.item.refs.proposalId).toBe(OLD);

    // The stale owner's re-plan lands late: it must lose, not re-open the item.
    finishStaleEffect();
    await expect(stale).resolves.toMatchObject({
      claimLost: true,
      effect: { kind: "approve_proposal", outcome: "claim_lost" },
    });
    const item = getInboxItem(db, id);
    expect(item.refs.proposalId).toBe(OLD);
    expect(item.title).toContain(OLD);
    expect(item.title).not.toContain(FRESH);
    expect(item.resolvedAt).toBe(new Date(takeoverAt).toISOString());
    expect(item.resolvedBy).toBe("operator:approve_proposal");
    expect(item.response.effect).toMatchObject({
      outcome: "applied",
      retryAttempt: 1,
    });
    expect(item.response.effect.detail).toBeUndefined();
    expect(item.responseHistory ?? []).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(1);
  });
});

describe("inbox decisions register precedent memos (WM-812)", () => {
  const NOW = Date.parse("2026-08-16T12:00:00.000Z");

  async function decideDismiss(
    db,
    { id, refs, now = NOW, artifactStore, fields },
  ) {
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
    return await decideInboxItem(
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

  test("applied decisions register a precedentOnly memo per issue/repo/pr subject and store the bytes", async () => {
    const db = openDb(":memory:");
    const store = tmpDir("evrt-inbox-decision-store-");
    const decided = await decideDismiss(db, {
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

  test("failed and unsupported effects do not register; a successful retry does", async () => {
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
    const failed = await decideInboxItem(
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

    const retried = await retryInboxDecision(db, "retry_memo", {
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

  test("a proposal re-plan does not register a decision memo", async () => {
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
    const decided = await decideInboxItem(
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

  test("authorise descriptionHash binds only the ticket-subject memo", async () => {
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
    const decided = await decideInboxItem(
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

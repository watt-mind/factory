import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-notify-test-mjs";
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "./db.mjs";
import {
  DEFAULT_NOTIFY_CMD,
  ensureNotifyLog,
  notifyCommand,
  notifyEnabled,
  notifyPending,
  pendingNotifications,
  sendNotification,
  sweepNotifyLog,
} from "./notify.mjs";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";
import { fileURLToPath } from "node:url";

// Repo root: this file is event-runtime/lib/notify.test.mjs, so two dirs up.
const FACTORY_ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const tmp = (p) => tmpDir(p);

/** A stub notifier that appends its message argument to `outFile`. */
function stubNotifier(dir, { exitCode = 0 } = {}) {
  const outFile = path.join(dir, "pushes.txt");
  const bin = path.join(dir, "notify-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${outFile}\nexit ${exitCode}\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    outFile,
    pushes: () =>
      Bun.file(outFile).size > 0
        ? readFileSync(outFile, "utf8").trim().split("\n")
        : [],
  };
}

function insertEvent(
  db,
  {
    source = "test",
    eventId,
    type = "linear.ticket.agent_ready",
    status = "admitted",
    lastPlanError = null,
  },
) {
  const at = new Date().toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, status, last_plan_error, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source,
    eventId,
    type,
    at,
    at,
    "{}",
    "sha256:x",
    status,
    lastPlanError,
    at,
  );
}

function insertProposal(
  db,
  {
    id,
    eventId,
    decision = "run",
    status = "open",
    reason = null,
    agent = "worktree-ticket@1",
    input,
    model,
    createdAt,
    ttlSeconds = 1800,
  },
) {
  const spec =
    decision === "run"
      ? {
          agent,
          ...(input ? { input } : {}),
          ...(model ? { model } : {}),
        }
      : null;
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, run_id, decision, spec_json, spec_hash, status, reason, created_at, ttl_seconds)
     VALUES (?, 'test', ?, ?, ?, ?, 'sha256:x', ?, ?, ?, ?)`,
  ).run(
    id,
    eventId,
    decision === "run" ? `run_${id}` : null,
    decision,
    spec ? JSON.stringify(spec) : null,
    status,
    reason,
    createdAt ?? new Date().toISOString(),
    ttlSeconds,
  );
}

describe("notify (WM-65)", () => {
  test("config: off by default, FACTORY_EVENT_NOTIFY=1 enables, CMD overrides the resolved default", () => {
    expect(notifyEnabled({})).toBe(false);
    expect(notifyEnabled({ FACTORY_EVENT_NOTIFY: "0" })).toBe(false);
    expect(notifyEnabled({ FACTORY_EVENT_NOTIFY: "1" })).toBe(true);
    expect(notifyEnabled({ FACTORY_EVENT_NOTIFY: "true" })).toBe(true);
    expect(notifyCommand({})).toBe(DEFAULT_NOTIFY_CMD);
    // WM-879: no in-tree default. Whatever config/policy.yaml resolves to, or
    // null in a clone that configured nothing — never a hardcoded private path.
    expect(
      DEFAULT_NOTIFY_CMD === null || typeof DEFAULT_NOTIFY_CMD === "string",
    ).toBe(true);
    // The "no hardcoded private path" guarantee is about the TRACKED tree, not
    // the operator's gitignored instance config. DEFAULT_NOTIFY_CMD resolves
    // from config/policy.yaml, which on the operator's own machine (and the
    // self-hosted CI runner, same box, user `hdkiller`) legitimately points at
    // a personal notify script — asserting on that resolved value tests the
    // instance, not the tree, and fails wherever an instance config is present.
    // Assert the guarantee where it belongs: the committed example config and
    // this module's source carry no personal path.
    const trackedSources = [
      readFileSync(
        path.join(FACTORY_ROOT_DIR, "config/policy.example.yaml"),
        "utf8",
      ),
      readFileSync(
        path.join(FACTORY_ROOT_DIR, "event-runtime/lib/notify.mjs"),
        "utf8",
      ),
    ].join("\n");
    // No personal home path (e.g. ~/Develop/hdkiller/… or /home/hdkiller/…) may
    // ship in the tracked tree. A doc comment naming "notify.py" as a concept
    // is fine; a hardcoded operator directory is not.
    expect(trackedSources).not.toMatch(/[/~]hdkiller[/"']|\/home\/[a-z]+\//i);
    expect(notifyCommand({ FACTORY_EVENT_NOTIFY_CMD: "/x/stub" })).toBe(
      "/x/stub",
    );
  });

  test("disabled (the default): inbox remains durable while the Telegram projection stays off", () => {
    const db = openDb(":memory:");
    insertEvent(db, { eventId: "evt-1", status: "human_needed" });
    insertProposal(db, {
      id: "prop-hn-1",
      eventId: "evt-1",
      decision: "human_needed",
      reason: "repo_unknown",
    });
    const spawned = [];
    const out = notifyPending(db, {
      enabled: false,
      send: (cmd, msg) => (
        spawned.push(msg),
        Promise.resolve({ ok: true, exitCode: 0, error: null })
      ),
    });
    expect(out.sent).toEqual([]);
    expect(spawned).toEqual([]);
    const item = db
      .query(
        "SELECT kind, delivery_json, decision_json, dedupe_key FROM inbox_items",
      )
      .get();
    expect(item.kind).toBe("BLOCKED");
    expect(JSON.parse(item.delivery_json)).toEqual({});
    expect(
      JSON.parse(item.decision_json).options.map((option) => option.effect),
    ).toEqual(["requeue", "dismiss"]);
    expect(item.dedupe_key).toBe("BLOCKED:test/evt-1");
    expect(db.query("SELECT COUNT(*) AS n FROM notify_log").get().n).toBe(1);
    // The next tick dedups the ledger item even though no projection ran.
    expect(notifyPending(db, { enabled: false }).sent).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(1);
  });

  test("a human_needed park pushes exactly once — with event type, id, and reason — and never again, across restarts", async () => {
    const dir = tmp("evrt-notify-");
    const dbFile = path.join(dir, "runtime.db");
    const stub = stubNotifier(dir);

    let db = openDb(dbFile);
    insertEvent(db, {
      eventId: "evt-park",
      type: "linear.ticket.agent_ready",
      status: "human_needed",
    });
    insertProposal(db, {
      id: "prop-park",
      eventId: "evt-park",
      decision: "human_needed",
      reason: "repo_report_only",
    });

    const first = notifyPending(db, {
      enabled: true,
      command: stub.bin,
      webUrl: "http://127.0.0.1:7382",
    });
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0].message).toBe(
      "BLOCKED linear.ticket.agent_ready evt-park: repo_report_only",
    );
    await first.deliveries;
    expect(stub.pushes()).toEqual([
      "BLOCKED linear.ticket.agent_ready evt-park: repo_report_only",
      "Should this parked event be requeued?",
      "1. Requeue the event",
      "2. Not now",
      `http://127.0.0.1:7382/#/inbox/${first.sent[0].inboxItemId}`,
    ]);
    const item = db
      .query("SELECT kind, refs_json, source, delivery_json FROM inbox_items")
      .get();
    expect(item.kind).toBe("BLOCKED");
    expect(JSON.parse(item.refs_json)).toEqual({
      eventSource: "test",
      eventId: "evt-park",
    });
    expect(item.source).toBe("serve:notify");
    expect(JSON.parse(item.delivery_json).telegram.error).toBeNull();
    expect(
      db.query("SELECT inbox_item_id FROM notify_log").get().inbox_item_id,
    ).toBe(first.sent[0].inboxItemId);

    // Same serve process, next tick: nothing new.
    const second = notifyPending(db, { enabled: true, command: stub.bin });
    expect(second.sent).toEqual([]);

    // Serve restart: the marker is in the database, not in process memory.
    db.close();
    db = openDb(dbFile);
    const afterRestart = notifyPending(db, {
      enabled: true,
      command: stub.bin,
    });
    expect(afterRestart.sent).toEqual([]);
    await afterRestart.deliveries;
    expect(stub.pushes()).toHaveLength(5);
    db.close();
  });

  test("an open watched proposal notifies once at 50% TTL and once more on expiry; a young one not at all", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const ttlSeconds = 1800;
    insertEvent(db, { eventId: "evt-p" });
    // 16 of 30 minutes gone → past 50%, 14m left.
    insertProposal(db, {
      id: "prop-aging",
      eventId: "evt-p",
      agent: "ci-doctor@2",
      createdAt: new Date(now - 16 * 60_000).toISOString(),
      ttlSeconds,
    });
    // 5 of 30 minutes gone → below threshold.
    insertProposal(db, {
      id: "prop-young",
      eventId: "evt-p",
      createdAt: new Date(now - 5 * 60_000).toISOString(),
      ttlSeconds,
    });

    const sent = (at) =>
      notifyPending(db, {
        now: at,
        enabled: true,
        command: "/x/stub",
        send: () => Promise.resolve({ ok: true, exitCode: 0, error: null }),
      }).sent;

    const first = sent(now);
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe("Ci-Doctor");
    expect(first[0].message).toBe(
      "DECISION NEEDED proposal prop-aging (ci-doctor@2): expires in 14m",
    );
    const proposalItem = db
      .query(
        "SELECT title, decision_json, dedupe_key FROM inbox_items WHERE kind = 'decision_needed'",
      )
      .get();
    expect(proposalItem.title).toBe("Ci-Doctor");
    expect(
      JSON.parse(proposalItem.decision_json).options.map(
        (option) => option.effect,
      ),
    ).toEqual(["approve_proposal", "reject_proposal", "dismiss"]);
    expect(proposalItem.dedupe_key).toBe("decision_needed:prop-aging");

    // Later ticks before expiry: silent.
    expect(sent(now + 60_000)).toEqual([]);

    // prop-young is decided before it ever reaches 50%: no push, ever.
    db.query(
      `UPDATE proposals SET status = 'approved' WHERE id = 'prop-young'`,
    ).run();

    // Past TTL: one final push, then silence.
    const expired = sent(now + 15 * 60_000);
    expect(expired).toHaveLength(1);
    expect(expired[0].title).toBe("Ci-Doctor");
    expect(expired[0].message).toBe(
      "DECISION NEEDED proposal prop-aging (ci-doctor@2): expired undecided",
    );
    expect(sent(now + 16 * 60_000)).toEqual([]);
    expect(sent(now + 60 * 60_000)).toEqual([]);
  });

  test("a dispatch proposal inbox title is action-first; Telegram keeps DECISION NEEDED (WM-896)", async () => {
    const dir = tmp("evrt-notify-dispatch-");
    const stub = stubNotifier(dir);
    const db = openDb(":memory:");
    const now = Date.now();
    insertEvent(db, { eventId: "evt-dispatch" });
    insertProposal(db, {
      id: "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
      eventId: "evt-dispatch",
      agent: "dispatch@1",
      model: "cursor-grok-4.6-high",
      input: { ticket: "WM-862", repo: "factory" },
      reason: "auto_approval_ineligible:dispatch_recheck_failed",
      createdAt: new Date(now - 16 * 60_000).toISOString(),
      ttlSeconds: 1800,
    });

    const out = notifyPending(db, {
      now,
      enabled: true,
      command: stub.bin,
      webUrl: "http://127.0.0.1:7382",
    });
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0].title).toBe(
      "Dispatch WM-862 · factory · cursor-grok-4.6-high",
    );
    expect(out.sent[0].message).toBe(
      "DECISION NEEDED proposal prop_2dda1ca8-2469-4aab-8908-79c31a5df55b (dispatch@1): expires in 14m",
    );
    const item = db
      .query(
        "SELECT title, refs_json, decision_json FROM inbox_items WHERE kind = 'decision_needed'",
      )
      .get();
    expect(item.title).toBe("Dispatch WM-862 · factory · cursor-grok-4.6-high");
    expect(JSON.parse(item.refs_json)).toMatchObject({
      proposalId: "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
      issue: "WM-862",
      repo: "factory",
    });
    const decision = JSON.parse(item.decision_json);
    expect(decision.question).toBe(
      "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
    );
    expect(decision.context).toContain("Why you're being asked");
    expect(decision.context).toContain(
      "Auto-approval re-check failed (see proposal)",
    );
    await out.deliveries;
    expect(stub.pushes()[0]).toBe(
      "DECISION NEEDED proposal prop_2dda1ca8-2469-4aab-8908-79c31a5df55b (dispatch@1): expires in 14m",
    );
    expect(stub.pushes()[1]).toBe(
      "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
    );
  });

  test("a proposal approved or rejected before the threshold never notifies", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    insertEvent(db, { eventId: "evt-d" });
    insertProposal(db, {
      id: "prop-approved",
      eventId: "evt-d",
      status: "approved",
      createdAt: new Date(now - 60 * 60_000).toISOString(),
    });
    insertProposal(db, {
      id: "prop-rejected",
      eventId: "evt-d",
      status: "rejected",
      createdAt: new Date(now - 60 * 60_000).toISOString(),
    });
    expect(pendingNotifications(db, { now })).toEqual([]);
  });

  test("sweeps stale markers for resolved referents but preserves parked-event dedup", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const old = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    ensureNotifyLog(db);
    insertEvent(db, { eventId: "evt-resolved", status: "completed" });
    insertEvent(db, { eventId: "evt-parked", status: "human_needed" });
    insertProposal(db, {
      id: "prop-decided",
      eventId: "evt-resolved",
      status: "approved",
    });
    insertProposal(db, { id: "prop-open", eventId: "evt-parked" });
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'old marker', ?)`,
    ).run("human_needed", "test/evt-resolved", old);
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'old marker', ?)`,
    ).run("human_needed", "test/evt-parked", old);
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'old marker', ?)`,
    ).run("proposal_ttl", "prop-decided", old);
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'old marker', ?)`,
    ).run("proposal_ttl", "prop-open", old);

    expect(sweepNotifyLog(db, { now })).toBe(2);
    expect(
      db.query("SELECT kind, target FROM notify_log ORDER BY target").all(),
    ).toEqual([
      { kind: "proposal_ttl", target: "prop-open" },
      { kind: "human_needed", target: "test/evt-parked" },
    ]);

    // A sweep must not remove the marker for an eligible park: no duplicate.
    expect(
      notifyPending(db, { now, enabled: true, command: "/x/stub" }).sent,
    ).toEqual([]);
  });

  test("a recent marker for an already-resolved referent survives the sweep", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    ensureNotifyLog(db);
    insertEvent(db, { eventId: "evt-done", status: "completed" });
    insertProposal(db, {
      id: "prop-done",
      eventId: "evt-done",
      status: "rejected",
    });
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'recent marker', ?)`,
    ).run("human_needed", "test/evt-done", recent);
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'recent marker', ?)`,
    ).run("proposal_ttl", "prop-done", recent);

    expect(sweepNotifyLog(db, { now })).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM notify_log").get().n).toBe(2);
  });

  test("an event id containing '/' still matches its parked event", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const old = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    ensureNotifyLog(db);
    insertEvent(db, {
      source: "github",
      eventId: "issue/42/comment",
      status: "human_needed",
    });
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES (?, ?, 'old marker', ?)`,
    ).run("human_needed", "github/issue/42/comment", old);

    expect(sweepNotifyLog(db, { now })).toBe(0);
  });

  test("sweepNotifyLog rejects a non-positive retention", () => {
    const db = openDb(":memory:");
    for (const retentionDays of [0, -1, NaN, Infinity]) {
      expect(() => sweepNotifyLog(db, { retentionDays })).toThrow(
        /retentionDays must be a positive number of days/,
      );
    }
  });

  test("a notifier that exits non-zero is recorded on notify_log and logged, not thrown", async () => {
    const dir = tmp("evrt-notify-fail-");
    const stub = stubNotifier(dir, { exitCode: 3 });
    const db = openDb(":memory:");
    insertEvent(db, {
      eventId: "evt-f",
      status: "human_needed",
      lastPlanError: "plan exploded",
    });

    const logs = [];
    const out = notifyPending(db, {
      enabled: true,
      command: stub.bin,
      log: (l) => logs.push(l),
    });
    expect(out.sent).toHaveLength(1);
    const results = await out.deliveries;
    expect(results[0].ok).toBe(false);
    expect(results[0].exitCode).toBe(3);
    const row = db
      .query(
        `SELECT exit_code, error, inbox_item_id FROM notify_log WHERE kind = 'human_needed'`,
      )
      .get();
    expect(row.exit_code).toBe(3);
    expect(row.error).toContain("exited 3");
    const inbox = db
      .query("SELECT delivery_json FROM inbox_items WHERE id = ?")
      .get(row.inbox_item_id);
    expect(JSON.parse(inbox.delivery_json).telegram.error).toContain(
      "exited 3",
    );
    expect(
      logs.some((l) =>
        l.includes("notify BLOCKED test/evt-f failed: notifier exited 3"),
      ),
    ).toBe(true);

    // Failed delivery does NOT retry: once means once.
    expect(
      notifyPending(db, { enabled: true, command: stub.bin }).sent,
    ).toEqual([]);
  });

  test("a hanging notifier is killed at the timeout and never delays the caller", async () => {
    const dir = tmp("evrt-notify-hang-");
    const bin = path.join(dir, "hang.sh");
    writeFileSync(bin, "#!/bin/sh\nsleep 60\n");
    chmodSync(bin, 0o755);

    const before = Date.now();
    const delivery = sendNotification(bin, "msg", { timeoutMs: 250 });
    // The spawn call itself returns immediately — the tick is never blocked.
    // Load-adjust the ceiling: under shared-host contention, process spawn
    // can exceed 200ms without the notifier having been awaited.
    expect(delivery).toBeInstanceOf(Promise);
    expect(Date.now() - before).toBeLessThan(loadAdjustedTimeout(1000));
    const outcome = await delivery;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("timed out after 250ms");
  });

  test("a missing notifier binary resolves as a failure instead of throwing", async () => {
    const outcome = await sendNotification(
      "/nonexistent/notifier-binary",
      "msg",
      { timeoutMs: 2000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });
});

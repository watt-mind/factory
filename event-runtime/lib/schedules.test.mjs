import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents, planEvent } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  autoApproveScheduled,
  dueSlots,
  emitDueTicks,
  lastAdmittedSlot,
  parseCadence,
  scheduleView,
  slotFor,
  tickEventId,
} from "./schedules.mjs";
import { runOnce } from "./worker.mjs";

const PV = "git:test-pv";
const base = loadRegistry();
const db = () => openDb(path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-sched-")), "runtime.db"));

/** The real registry with one loop overridden — schedules are just data. */
const withLoop = (overrides = {}) => ({
  ...base,
  schedules: {
    reaper: {
      every: "60m",
      eventType: "clock.tick.reaper",
      catchUp: "none",
      singleton: true,
      approval: "watched",
      enabled: true,
      ...overrides,
    },
  },
});

const at = (iso) => Date.parse(iso);

function planMergeRequest(d, registry, {
  eventId,
  source = "operator",
  now = at("2026-08-17T10:30:45Z"),
} = {}) {
  const admitted = admitEvent(d, registry, {
    schemaVersion: "factory.event/v1",
    eventId,
    type: "factory.merge.requested",
    source,
    subject: "factory",
    occurredAt: new Date(now).toISOString(),
    correlationId: eventId,
    causationId: source === "chain" ? "run-parent" : null,
    payload: { repo: "factory" },
  }, { now });
  expect(admitted.admitted).toBe(true);
  return planEvent(d, registry, { source, eventId }, { now, policyVersion: PV });
}

describe("cadence and slots", () => {
  test("parses the interval forms and rejects everything else", () => {
    expect(parseCadence("30s")).toBe(30);
    expect(parseCadence("60m")).toBe(3600);
    expect(parseCadence("2h")).toBe(7200);
    expect(parseCadence("1d")).toBe(86400);
    for (const bad of ["", "60", "0m", "5 minutes", "* * * * *", "-1h", null]) {
      expect(() => parseCadence(bad)).toThrow();
    }
  });

  test("a slot is the interval floor, so every moment inside it maps to one id", () => {
    const hour = 3600;
    expect(slotFor(at("2026-08-13T21:00:00Z"), hour)).toBe("2026-08-13T21:00:00.000Z");
    expect(slotFor(at("2026-08-13T21:59:59Z"), hour)).toBe("2026-08-13T21:00:00.000Z");
    expect(slotFor(at("2026-08-13T22:00:00Z"), hour)).toBe("2026-08-13T22:00:00.000Z");
  });
});

describe("dueSlots — catch-up policy (§4)", () => {
  const hour = 3600;
  const now = at("2026-08-14T04:30:00Z");

  test("a loop that never fired fires once, for the current slot", () => {
    expect(dueSlots({ lastSlot: null, nowMs: now, cadenceSeconds: hour })).toEqual({
      slots: ["2026-08-14T04:00:00.000Z"],
      skipped: 0,
    });
  });

  test("already fired this slot → nothing due (the restart case)", () => {
    expect(
      dueSlots({ lastSlot: "2026-08-14T04:00:00.000Z", nowMs: now, cadenceSeconds: hour }),
    ).toEqual({ slots: [], skipped: 0 });
  });

  test("none: six missed slots collapse to one run that says so", () => {
    const outcome = dueSlots({
      lastSlot: "2026-08-13T22:00:00.000Z",
      nowMs: now,
      cadenceSeconds: hour,
      catchUp: "none",
    });
    expect(outcome.slots).toEqual(["2026-08-14T04:00:00.000Z"]);
    expect(outcome.skipped).toBe(5);
  });

  test("last: fires the most recent missed slot rather than the current one", () => {
    const outcome = dueSlots({
      lastSlot: "2026-08-13T22:00:00.000Z",
      nowMs: now,
      cadenceSeconds: hour,
      catchUp: "last",
    });
    expect(outcome.slots).toEqual(["2026-08-14T04:00:00.000Z"]);
  });

  test("all: every missed slot fires, in order, nothing skipped", () => {
    const outcome = dueSlots({
      lastSlot: "2026-08-14T01:00:00.000Z",
      nowMs: now,
      cadenceSeconds: hour,
      catchUp: "all",
    });
    expect(outcome.slots).toEqual([
      "2026-08-14T02:00:00.000Z",
      "2026-08-14T03:00:00.000Z",
      "2026-08-14T04:00:00.000Z",
    ]);
    expect(outcome.skipped).toBe(0);
  });

  test("all: large downtime gap caps at maxCatchUp (default 24) and reports skipped older slots (OPS-452)", () => {
    // 30 days downtime on a 60s loop = 30 * 24 * 60 = 43,200 intervals
    const sixtySec = 60;
    const monthAgo = at("2026-07-15T04:00:00Z");
    const outcome = dueSlots({
      lastSlot: new Date(monthAgo).toISOString(),
      nowMs: now, // 2026-08-14T04:30:00Z -> slot is 2026-08-14T04:30:00.000Z
      cadenceSeconds: sixtySec,
      catchUp: "all",
    });
    expect(outcome.slots).toHaveLength(24);
    // last slot is the current slot
    expect(outcome.slots[outcome.slots.length - 1]).toBe("2026-08-14T04:30:00.000Z");
    // slots are strictly in chronological order
    for (let i = 1; i < outcome.slots.length; i++) {
      expect(Date.parse(outcome.slots[i])).toBeGreaterThan(Date.parse(outcome.slots[i - 1]));
    }
    // Total intervals: (nowMs slot - monthAgo) / 60s = 43230 intervals -> skipped = 43230 - 24 = 43206
    expect(outcome.skipped).toBe(43206);

    // Custom maxCatchUp configuration
    const custom = dueSlots({
      lastSlot: new Date(monthAgo).toISOString(),
      nowMs: now,
      cadenceSeconds: sixtySec,
      catchUp: "all",
      maxCatchUp: 5,
    });
    expect(custom.slots).toHaveLength(5);
    expect(custom.skipped).toBe(43230 - 5);
  });
});

describe("emitDueTicks (§3)", () => {
  test("restarting serve inside one interval admits exactly one tick", () => {
    const d = db();
    const registry = withLoop();
    const now = at("2026-08-13T21:10:00Z");

    const first = emitDueTicks(d, registry, { now });
    expect(first.emitted).toHaveLength(1);
    expect(first.emitted[0].slot).toBe("2026-08-13T21:00:00.000Z");

    // Three more "restarts" later in the same hour: nothing new.
    for (const minutes of [20, 40, 59]) {
      const again = emitDueTicks(d, registry, { now: at(`2026-08-13T21:${minutes}:00Z`) });
      expect(again.emitted).toEqual([]);
    }
    expect(d.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(1);

    // Next hour fires once.
    expect(emitDueTicks(d, registry, { now: at("2026-08-13T22:05:00Z") }).emitted).toHaveLength(1);
  });

  test("the tick carries its loop, slot and how many slots it stands for", () => {
    const d = db();
    const registry = withLoop();
    emitDueTicks(d, registry, { now: at("2026-08-13T22:00:00Z") });
    emitDueTicks(d, registry, { now: at("2026-08-14T04:00:00Z") });

    const row = d.query(`SELECT envelope_json FROM events ORDER BY event_id DESC LIMIT 1`).get();
    const envelope = JSON.parse(row.envelope_json);
    expect(envelope.payload).toMatchObject({ loop: "reaper", skippedSlots: 5 });
    expect(envelope.eventId).toBe(tickEventId("reaper", "2026-08-14T04:00:00.000Z"));
    expect(envelope.source).toBe("schedule");
  });

  test("a static payload rides on the tick and the planner proposes the routed run (WM-72)", () => {
    const d = db();
    const registry = withLoop({ eventType: "factory.reconcile.requested", payload: { repo: "bj29" } });
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });

    const row = d.query(`SELECT envelope_json FROM events ORDER BY event_id DESC LIMIT 1`).get();
    const envelope = JSON.parse(row.envelope_json);
    expect(envelope.type).toBe("factory.reconcile.requested");
    // Tick identity fields always win the merge over the static payload.
    expect(envelope.payload).toMatchObject({ repo: "bj29", loop: "reaper", slot: "2026-08-13T21:00:00.000Z" });

    planAdmittedEvents(d, registry, { policyVersion: PV });
    const proposal = openProposals(d, {}).find((p) => p.spec?.agent === "reconcile@1");
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe("open");
  });

  test("a disabled loop never fires", () => {
    const d = db();
    expect(emitDueTicks(d, withLoop({ enabled: false }), { now: Date.now() }).emitted).toEqual([]);
  });

  test("lastAdmittedSlot reads back the newest slot", () => {
    const d = db();
    const registry = withLoop();
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    emitDueTicks(d, registry, { now: at("2026-08-13T22:00:00Z") });
    expect(lastAdmittedSlot(d, "reaper")).toBe("2026-08-13T22:00:00.000Z");
  });

  test("a future-dated schedule row does not halt due-slot emission (OPS-437)", () => {
    const d = db();
    const registry = withLoop();
    // Directly insert a rogue future-dated event row (e.g. year 9999)
    d.query(
      `INSERT INTO events
         (source, event_id, type, subject, occurred_at, received_at,
          correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?)`,
    ).run(
      "schedule",
      "clock:reaper:9999-01-01T00:00:00.000Z",
      "clock.tick.reaper",
      "reaper",
      "9999-01-01T00:00:00.000Z",
      "2026-08-13T21:00:00.000Z",
      null,
      null,
      JSON.stringify({}),
      "sha256:fake",
      "2026-08-13T21:00:00.000Z",
    );

    const now = at("2026-08-13T21:00:00Z");
    // lastAdmittedSlot bounded by now ignores the future-dated row
    expect(lastAdmittedSlot(d, "reaper", { now })).toBeNull();

    // emitDueTicks fires normally for the current slot
    const ticks = emitDueTicks(d, registry, { now });
    expect(ticks.emitted).toHaveLength(1);
    expect(ticks.emitted[0].slot).toBe("2026-08-13T21:00:00.000Z");
  });

  test("live merge-factory shape: lastAdmittedSlot finds emitted event with configured eventType (WM-421)", () => {
    const d = db();
    const registry = {
      ...base,
      schedules: {
        "merge-factory": {
          every: "30s",
          eventType: "factory.merge.requested",
          payload: { repo: "factory" },
          catchUp: "none",
          singleton: true,
          approval: "auto",
          enabled: true,
        },
        "merge-other": {
          every: "30s",
          eventType: "factory.merge.requested",
          payload: { repo: "other" },
          catchUp: "none",
          singleton: true,
          approval: "auto",
          enabled: true,
        },
      },
    };

    const t1 = at("2026-08-16T15:30:00.000Z");
    const t1Ticks = emitDueTicks(d, registry, { now: t1 });
    expect(t1Ticks.emitted).toHaveLength(2);
    expect(t1Ticks.emitted.find((e) => e.loop === "merge-factory")?.slot).toBe("2026-08-16T15:30:00.000Z");

    // lastAdmittedSlot must resolve the slot despite eventType being factory.merge.requested
    expect(lastAdmittedSlot(d, "merge-factory", { now: t1 })).toBe("2026-08-16T15:30:00.000Z");
    expect(lastAdmittedSlot(d, "merge-other", { now: t1 })).toBe("2026-08-16T15:30:00.000Z");

    // scheduleView reports correct lastSlot, nextDue, and stopped state
    const view = scheduleView(d, registry, { now: t1 });
    const mfView = view.find((v) => v.loop === "merge-factory");
    expect(mfView).toBeTruthy();
    expect(mfView.lastSlot).toBe("2026-08-16T15:30:00.000Z");
    expect(mfView.nextDue).toBe("2026-08-16T15:30:30.000Z");
    expect(mfView.stopped).toBe(false);

    // Repeated tick evaluation in the same slot attempts no admission
    const retryTicks = emitDueTicks(d, registry, { now: t1 + 5000 });
    expect(retryTicks.emitted).toHaveLength(0);

    // Advancing by one cadence fires the next slot and updates lastSlot
    const t2 = at("2026-08-16T15:30:30.000Z");
    const t2Ticks = emitDueTicks(d, registry, { now: t2 });
    expect(t2Ticks.emitted).toHaveLength(2);
    expect(lastAdmittedSlot(d, "merge-factory", { now: t2 })).toBe("2026-08-16T15:30:30.000Z");

    // Loop isolation: inserting only a merge-other event does not affect merge-factory
    const dIsolated = db();
    emitDueTicks(dIsolated, {
      ...base,
      schedules: {
        "merge-other": registry.schedules["merge-other"],
      },
    }, { now: t1 });
    expect(lastAdmittedSlot(dIsolated, "merge-factory", { now: t1 })).toBeNull();
    expect(lastAdmittedSlot(dIsolated, "merge-other", { now: t1 })).toBe("2026-08-16T15:30:00.000Z");
  });
});

describe("planning a tick (§5, §6)", () => {
  const adapters = { command: fake, claude: fake };
  const workerOpts = () => ({
    workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-sched-ws-")),
    artifactStore: mkdtempSync(path.join(os.tmpdir(), "evrt-sched-store-")),
    owner: "w",
    policyVersion: PV,
  });

  test("a watched loop proposes and runs nothing until approved", () => {
    const d = db();
    const registry = withLoop();
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });

    const proposal = openProposals(d, {}).find((p) => p.spec?.agent === "reaper@1");
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe("open");
    expect(d.query(`SELECT state FROM runs`).get().state).toBe("PROPOSED");

    // Auto-approval must not touch a watched loop.
    expect(autoApproveScheduled(d, registry, approveProposal, { policyVersion: PV }).approved).toEqual([]);
    expect(openProposals(d, {}).find((p) => p.spec?.agent === "reaper@1").status).toBe("open");
  });

  test("an auto loop is approved by the scheduler — and the journal says so", () => {
    const d = db();
    const registry = withLoop({ approval: "auto" });
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });

    const outcome = autoApproveScheduled(d, registry, approveProposal, { policyVersion: PV });
    expect(outcome.approved).toHaveLength(1);
    const runId = outcome.approved[0].runId;
    expect(d.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId).state).toBe("QUEUED");

    // The distinction that is the whole audit trail: nobody looked at this.
    const approval = d
      .query(`SELECT actor FROM lifecycle_events WHERE run_id = ? AND to_state = 'APPROVED'`)
      .get(runId);
    expect(approval.actor).toBe("schedule");
    expect(approval.actor).not.toBe("operator");
  });

  test("singleton: a loop whose previous run is in flight plans a NOOP, not a queue", async () => {
    const d = db();
    const registry = withLoop({ approval: "auto" });
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });
    autoApproveScheduled(d, registry, approveProposal, { policyVersion: PV });
    // The run is QUEUED — in flight, not terminal.

    emitDueTicks(d, registry, { now: at("2026-08-13T22:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });

    const noop = d
      .query(`SELECT decision, reason FROM proposals WHERE decision = 'noop' ORDER BY rowid DESC LIMIT 1`)
      .get();
    expect(noop.reason).toBe("previous_run_in_flight");
    expect(d.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("scheduled merge in flight makes an operator request a named typed NOOP", () => {
    const d = db();
    const registry = withLoop({
      eventType: "factory.merge.requested",
      payload: { repo: "factory" },
      approval: "auto",
    });
    emitDueTicks(d, registry, { now: at("2026-08-17T10:30:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });
    const [approved] = autoApproveScheduled(d, registry, approveProposal, { policyVersion: PV }).approved;

    const operator = planMergeRequest(d, registry, { eventId: "operator-merge-overlap" });
    expect(operator).toMatchObject({
      decision: "noop",
      reason: "previous_run_in_flight",
      runId: approved.runId,
    });
    expect(operator.proposal.run_id).toBe(approved.runId);
    expect(d.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("operator merge in flight makes a scheduled request a named NOOP via max_concurrent_merges", () => {
    const d = db();
    const registry = withLoop({
      eventType: "factory.merge.requested",
      payload: { repo: "factory" },
      singleton: false,
      approval: "auto",
    });
    const operator = planMergeRequest(d, registry, { eventId: "operator-merge-first" });
    approveProposal(d, registry, operator.proposal.id, { actor: "operator", policyVersion: PV });

    const tickAt = at("2026-08-17T11:00:00Z");
    emitDueTicks(d, registry, { now: tickAt });
    const scheduled = planEvent(
      d,
      registry,
      { source: "schedule", eventId: tickEventId("reaper", "2026-08-17T11:00:00.000Z") },
      { now: tickAt, policyVersion: PV },
    );
    expect(scheduled).toMatchObject({
      decision: "noop",
      reason: "previous_run_in_flight",
      runId: operator.runId,
    });
    expect(scheduled.proposal.run_id).toBe(operator.runId);
    expect(d.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("chain-originated merge request uses the same named singleton NOOP", () => {
    const d = db();
    const registry = withLoop({
      eventType: "factory.merge.requested",
      payload: { repo: "factory" },
      approval: "auto",
    });
    const operator = planMergeRequest(d, registry, { eventId: "operator-before-chain" });
    approveProposal(d, registry, operator.proposal.id, { actor: "operator", policyVersion: PV });

    const chained = planMergeRequest(d, registry, {
      eventId: "chain-merge-overlap",
      source: "chain",
      now: at("2026-08-17T10:31:00Z"),
    });
    expect(chained).toMatchObject({
      decision: "noop",
      reason: "previous_run_in_flight",
      runId: operator.runId,
    });
    expect(chained.proposal.run_id).toBe(operator.runId);
    expect(d.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("once the previous run finishes, the next tick plans normally", async () => {
    const d = db();
    const registry = withLoop({ approval: "auto" });
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });
    autoApproveScheduled(d, registry, approveProposal, { policyVersion: PV });
    await runOnce(d, registry, adapters, workerOpts());

    emitDueTicks(d, registry, { now: at("2026-08-13T22:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });
    expect(d.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
  });

  test("unapproved first proposal does not silence subsequent slots on watched loop (OPS-436)", async () => {
    const d = db();
    const registry = withLoop({ approval: "watched" });

    // First slot arrives and is planned into an open proposal (PROPOSED run)
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });

    const props1 = openProposals(d, {}).filter((p) => p.spec?.agent === "reaper@1");
    expect(props1).toHaveLength(1);
    expect(props1[0].status).toBe("open");

    // Operator never approves it. Next slot arrives.
    emitDueTicks(d, registry, { now: at("2026-08-13T22:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });

    // Both proposals exist and are open / proposed — NOT silenced into a NOOP!
    const props2 = openProposals(d, {}).filter((p) => p.spec?.agent === "reaper@1");
    expect(props2).toHaveLength(2);
    expect(d.query(`SELECT COUNT(*) AS n FROM runs WHERE state = 'PROPOSED'`).get().n).toBe(2);
    expect(d.query(`SELECT COUNT(*) AS n FROM proposals WHERE decision = 'noop'`).get().n).toBe(0);
  });
});

describe("scheduleView (§9)", () => {
  const adapters = { command: fake, claude: fake };
  const workerOpts = () => ({
    workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-sched-ws-")),
    artifactStore: mkdtempSync(path.join(os.tmpdir(), "evrt-sched-store-")),
    owner: "w",
    policyVersion: PV,
  });

  test("reports cadence, last fire, next due — and a stopped clock", () => {
    const d = db();
    const registry = withLoop();
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });

    const soon = scheduleView(d, registry, { now: at("2026-08-13T21:30:00Z") })[0];
    expect(soon).toMatchObject({ loop: "reaper", every: "60m", enabled: true, stopped: false });
    expect(soon.lastSlot).toBe("2026-08-13T21:00:00.000Z");
    expect(soon.nextDue).toBe("2026-08-13T22:00:00.000Z");

    // Five hours of silence on an hourly loop: the clock is not turning.
    const later = scheduleView(d, registry, { now: at("2026-08-14T02:00:00Z") })[0];
    expect(later.stopped).toBe(true);
    expect(later.intervalsLate).toBe(5);
  });

  test("distinguishes ticking from running and flags neverCompleted loops (OPS-436)", async () => {
    const d = db();
    const registry = withLoop({ approval: "auto" });

    // Before ticking: no slots, not neverCompleted
    expect(scheduleView(d, registry, { now: at("2026-08-13T21:00:00Z") })[0]).toMatchObject({
      lastSlot: null,
      lastCompletedSlot: null,
      neverCompleted: false,
    });

    // Ticked and planned: lastSlot exists, but neverCompleted is true because run hasn't completed
    emitDueTicks(d, registry, { now: at("2026-08-13T21:00:00Z") });
    planAdmittedEvents(d, registry, { policyVersion: PV });
    autoApproveScheduled(d, registry, approveProposal, { policyVersion: PV });

    const ticking = scheduleView(d, registry, { now: at("2026-08-13T21:10:00Z") })[0];
    expect(ticking.lastSlot).toBe("2026-08-13T21:00:00.000Z");
    expect(ticking.lastCompletedSlot).toBeNull();
    expect(ticking.neverCompleted).toBe(true);

    // Run completes
    await runOnce(d, registry, adapters, workerOpts());

    const running = scheduleView(d, registry, { now: at("2026-08-13T21:20:00Z") })[0];
    expect(running.lastSlot).toBe("2026-08-13T21:00:00.000Z");
    expect(running.lastCompletedSlot).toBe("2026-08-13T21:00:00.000Z");
    expect(running.neverCompleted).toBe(false);
  });

  test("a disabled loop is never reported stopped", () => {
    const d = db();
    const registry = withLoop({ enabled: false });
    expect(scheduleView(d, registry, { now: Date.now() })[0].stopped).toBe(false);
  });
});

describe("registry validation of schedules.json", () => {
  test("the shipped reaper loop is registered, watched, and off by default", () => {
    expect(base.schedules.reaper).toMatchObject({
      every: "60m",
      eventType: "clock.tick.reaper",
      approval: "watched",
      enabled: false,
    });
    // Enabling it must stay a deliberate act, not a default someone inherits.
    expect(base.schedules.reaper.enabled).toBe(false);
  });

  test("the reaper agent is a closed command template, not a model", () => {
    const def = base.agents.get("reaper@1");
    expect(def.mutating).toBe(true);
    expect(def.command[0]).toBe("bun");
    expect(def.command.join(" ")).toContain("orchestrator/reaper.mjs");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { openDb } from "./db.mjs";
import { planAdmittedEvents } from "./planner.mjs";
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
});

describe("scheduleView (§9)", () => {
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

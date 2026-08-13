/**
 * Scheduled clock events (docs/event-runtime-schedules.md; OPS-381).
 *
 * A tick is an event, not a job: `serve` emits `clock.tick.<loop>` on a
 * cadence and the ordinary intake → planner → proposal path takes over. The
 * scheduler knows nothing about agents, and the planner knows nothing about
 * time.
 *
 * Everything here is pure except `dueTicks`'s database read, so slot maths —
 * the part that decides whether a restart double-fires — is testable without
 * a clock or a runtime.
 */
import { admitEvent } from "./intake.mjs";

export const SCHEDULE_SOURCE = "schedule";
export const CATCH_UP_MODES = ["none", "last", "all"];
export const APPROVAL_MODES = ["watched", "auto"];

/** "60m" / "30s" / "2h" / "1d" → seconds. Intervals only: no cron, no timezone. */
export function parseCadence(every) {
  const match = /^(\d+)([smhd])$/.exec(String(every ?? "").trim());
  if (!match) throw new Error(`unparseable cadence "${every}" — use 30s, 15m, 2h or 1d`);
  const value = Number(match[1]);
  if (value <= 0) throw new Error(`cadence "${every}" must be positive`);
  return value * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
}

/**
 * The slot a moment belongs to: the interval floor from the epoch. Identity
 * comes from the slot, never from the instant a tick was emitted — that is
 * what makes a restart mid-interval a no-op instead of a second run.
 */
export function slotFor(nowMs, cadenceSeconds) {
  const period = cadenceSeconds * 1000;
  return new Date(Math.floor(nowMs / period) * period).toISOString();
}

export const tickEventId = (loop, slot) => `clock:${loop}:${slot}`;

/**
 * Which slots to fire, given the last one already admitted (§4 catch-up).
 *
 * `none` collapses an outage to a single run — for an idempotent maintenance
 * loop, reaping once now is what reaping six times would have achieved —
 * while still reporting how many slots it stands for, so a six-hour gap
 * reads as a decision rather than as silence.
 *
 * @returns {{ slots: string[], skipped: number }}
 */
export function dueSlots({ lastSlot, nowMs, cadenceSeconds, catchUp = "none" }) {
  const current = slotFor(nowMs, cadenceSeconds);
  if (!lastSlot) return { slots: [current], skipped: 0 };
  if (Date.parse(lastSlot) >= Date.parse(current)) return { slots: [], skipped: 0 };

  const period = cadenceSeconds * 1000;
  const missed = [];
  for (let t = Date.parse(lastSlot) + period; t <= Date.parse(current); t += period) {
    missed.push(new Date(t).toISOString());
  }
  if (catchUp === "all") return { slots: missed, skipped: 0 };
  // "none" and "last" both fire exactly one tick here; they differ only in
  // which slot it claims to be, and therefore in what a replay would mean.
  const slots = [catchUp === "last" ? missed[missed.length - 1] : current];
  return { slots, skipped: Math.max(0, missed.length - 1) };
}

/** The newest slot already admitted for a loop, or null if it never fired. */
export function lastAdmittedSlot(db, loop) {
  const row = db
    .query(
      `SELECT event_id FROM events
       WHERE source = ? AND type = ?
       ORDER BY event_id DESC LIMIT 1`,
    )
    .get(SCHEDULE_SOURCE, `clock.tick.${loop}`);
  // eventId is clock:<loop>:<ISO slot>; ISO sorts lexicographically, so the
  // newest row is the newest slot without parsing every payload.
  return row ? row.event_id.slice(`clock:${loop}:`.length) : null;
}

/**
 * Emit every due tick for every enabled loop. Idempotent by construction:
 * the eventId is the slot, so a `serve` restarted three times in one interval
 * admits one tick.
 *
 * @returns {{ emitted: Array<{loop: string, slot: string, skipped: number}>, errors: string[] }}
 */
export function emitDueTicks(db, registry, { now = Date.now() } = {}) {
  const emitted = [];
  const errors = [];
  for (const [loop, schedule] of Object.entries(registry.schedules ?? {})) {
    if (!schedule.enabled) continue;
    try {
      const cadenceSeconds = parseCadence(schedule.every);
      const { slots, skipped } = dueSlots({
        lastSlot: lastAdmittedSlot(db, loop),
        nowMs: now,
        cadenceSeconds,
        catchUp: schedule.catchUp,
      });
      for (const slot of slots) {
        const outcome = admitEvent(
          db,
          registry,
          {
            schemaVersion: "factory.event/v1",
            eventId: tickEventId(loop, slot),
            type: schedule.eventType,
            source: SCHEDULE_SOURCE,
            subject: loop,
            occurredAt: slot,
            correlationId: tickEventId(loop, slot),
            causationId: null,
            // skippedSlots travels on the tick that did fire: the audit trail
            // says "this run stands for 5 slots nobody was awake for".
            payload: { loop, slot, cadenceSeconds, skippedSlots: skipped },
          },
          { now },
        );
        if (outcome.admitted) emitted.push({ loop, slot, skipped });
        else if (!outcome.duplicate) errors.push(`${loop}@${slot}: ${outcome.errors.join("; ")}`);
      }
    } catch (err) {
      errors.push(`${loop}: ${err.message}`);
    }
  }
  return { emitted, errors };
}

/** Is a run for this loop's agent still in flight? (§5 singleton) */
export function loopInFlight(db, agentRef) {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM runs
       WHERE state NOT IN ('COMPLETED','REFUSED','FAILED','TIMED_OUT','CANCELLED')
         AND json_extract(spec_json, '$.agent') = ?`,
    )
    .get(agentRef);
  return row.n > 0;
}

/**
 * Operator view (§9): what is scheduled, when it last fired, when it is due,
 * and whether the clock has stopped — the question a scheduler must always be
 * able to answer, and the one a launchd plist cannot.
 */
export function scheduleView(db, registry, { now = Date.now() } = {}) {
  return Object.entries(registry.schedules ?? {}).map(([loop, schedule]) => {
    let cadenceSeconds = null;
    let error = null;
    try {
      cadenceSeconds = parseCadence(schedule.every);
    } catch (err) {
      error = err.message;
    }
    const lastSlot = lastAdmittedSlot(db, loop);
    const nextDue =
      cadenceSeconds && lastSlot
        ? new Date(Date.parse(lastSlot) + cadenceSeconds * 1000).toISOString()
        : cadenceSeconds
          ? slotFor(now, cadenceSeconds)
          : null;
    const intervalsLate =
      cadenceSeconds && lastSlot
        ? Math.floor((now - Date.parse(lastSlot)) / (cadenceSeconds * 1000))
        : null;
    return {
      loop,
      every: schedule.every,
      cadenceSeconds,
      eventType: schedule.eventType,
      approval: schedule.approval ?? "watched",
      catchUp: schedule.catchUp ?? "none",
      singleton: schedule.singleton !== false,
      enabled: Boolean(schedule.enabled),
      lastSlot,
      nextDue,
      intervalsLate,
      // Enabled, has fired before, and more than two intervals have passed:
      // the clock is not turning (serve down, machine asleep, bad cadence).
      stopped: Boolean(schedule.enabled) && intervalsLate !== null && intervalsLate > 2,
      error,
    };
  });
}

/**
 * Approve open proposals belonging to loops that declare `approval: auto`
 * (§6). Separate from planning on purpose: auto-approval is the step that
 * changes what the runtime may do unattended, so it is one explicit call
 * that can be read, tested, and turned off.
 *
 * The actor is "schedule", never "operator". A run nobody looked at must
 * never be indistinguishable from one a human approved — that distinction is
 * the audit trail.
 */
export function autoApproveScheduled(db, registry, approve, { now = Date.now(), policyVersion } = {}) {
  const approved = [];
  const errors = [];
  const autoLoops = new Set(
    Object.entries(registry.schedules ?? {})
      .filter(([, s]) => s.enabled && (s.approval ?? "watched") === "auto")
      .map(([loop]) => loop),
  );
  if (autoLoops.size === 0) return { approved, errors };

  const rows = db
    .query(
      `SELECT p.id, e.envelope_json FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.status = 'open' AND p.decision = 'run' AND e.source = ?`,
    )
    .all(SCHEDULE_SOURCE);
  for (const row of rows) {
    const loop = JSON.parse(row.envelope_json).payload?.loop;
    if (!autoLoops.has(loop)) continue;
    try {
      const outcome = approve(db, registry, row.id, { actor: SCHEDULE_SOURCE, now, policyVersion });
      if (outcome.approved) approved.push({ loop, proposalId: row.id, runId: outcome.runId });
    } catch (err) {
      errors.push(`${loop}: ${err.message}`);
    }
  }
  return { approved, errors };
}

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
import { canonicalJson } from "./canonical.mjs";
import { admitEvent } from "./intake.mjs";
import { rejectProposal } from "./proposals.mjs";
import { getAgent, getEventType } from "./registry.mjs";

export const SCHEDULE_SOURCE = "schedule";
/** Fields emitDueTicks always stamps itself, overriding a static payload. */
const TICK_PAYLOAD_FIELDS = new Set([
  "loop",
  "slot",
  "cadenceSeconds",
  "skippedSlots",
]);
export const CATCH_UP_MODES = ["none", "last", "all"];
export const APPROVAL_MODES = ["watched", "auto"];

/** "60m" / "30s" / "2h" / "1d" → seconds. Intervals only: no cron, no timezone. */
export function parseCadence(every) {
  const match = /^(\d+)([smhd])$/.exec(String(every ?? "").trim());
  if (!match)
    throw new Error(`unparseable cadence "${every}" — use 30s, 15m, 2h or 1d`);
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

export const DEFAULT_MAX_CATCH_UP = 24;

/**
 * Which slots to fire, given the last one already admitted (§4 catch-up).
 *
 * `none` collapses an outage to a single run — for an idempotent maintenance
 * loop, reaping once now is what reaping six times would have achieved —
 * while still reporting how many slots it stands for, so a six-hour gap
 * reads as a decision rather than as silence.
 *
 * Under `all`, at most `maxCatchUp` newest slots are returned in order (default
 * 24), and any older missed slots are reported in `skipped` (OPS-452).
 *
 * @returns {{ slots: string[], skipped: number }}
 */
export function dueSlots({
  lastSlot,
  nowMs,
  cadenceSeconds,
  catchUp = "none",
  maxCatchUp = DEFAULT_MAX_CATCH_UP,
}) {
  const current = slotFor(nowMs, cadenceSeconds);
  if (!lastSlot) return { slots: [current], skipped: 0 };
  if (Date.parse(lastSlot) >= Date.parse(current))
    return { slots: [], skipped: 0 };

  const period = cadenceSeconds * 1000;
  const totalMissed = Math.round(
    (Date.parse(current) - Date.parse(lastSlot)) / period,
  );
  if (totalMissed <= 0) return { slots: [], skipped: 0 };

  if (catchUp === "all") {
    const cap = Math.max(1, maxCatchUp ?? DEFAULT_MAX_CATCH_UP);
    const count = Math.min(totalMissed, cap);
    const skipped = totalMissed - count;
    const slots = [];
    const startT = Date.parse(current) - (count - 1) * period;
    for (let t = startT; t <= Date.parse(current); t += period) {
      slots.push(new Date(t).toISOString());
    }
    return { slots, skipped };
  }

  if (catchUp === "last" && totalMissed > 1) {
    // The current slot is not missed yet. Emit its immediate predecessor —
    // the newest missed slot — and leave the current one for the next tick.
    return {
      slots: [new Date(Date.parse(current) - period).toISOString()],
      skipped: totalMissed - 2,
    };
  }

  // `none`, and `last` when the previous slot is already the last admitted
  // one, fire the current slot. There is no missed slot to replay in that
  // `last` case.
  const slots = [current];
  return { slots, skipped: Math.max(0, totalMissed - 1) };
}

/** The newest slot already admitted for a loop at or before now, or null if it never fired (OPS-437, WM-421). */
export function lastAdmittedSlot(
  db,
  loop,
  { now = Date.now(), eventType } = {},
) {
  const nowMs =
    typeof now === "number"
      ? now
      : typeof now === "string"
        ? Date.parse(now)
        : Date.now();
  const maxIso = new Date(nowMs).toISOString();
  const minEventId = `clock:${loop}:`;
  const maxEventId = tickEventId(loop, maxIso);
  const row = db
    .query(
      `SELECT event_id FROM events
       WHERE source = ?
         AND event_id >= ? AND event_id <= ?
         AND (subject = ? OR type = ? OR (? IS NOT NULL AND type = ?))
       ORDER BY event_id DESC LIMIT 1`,
    )
    .get(
      SCHEDULE_SOURCE,
      minEventId,
      maxEventId,
      loop,
      `clock.tick.${loop}`,
      eventType ?? null,
      eventType ?? "",
    );
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
        lastSlot: lastAdmittedSlot(db, loop, {
          now,
          eventType: schedule.eventType,
        }),
        nowMs: now,
        cadenceSeconds,
        catchUp: schedule.catchUp,
        maxCatchUp: schedule.maxCatchUp,
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
            // A schedule's static payload (e.g. {repo}) rides along under the
            // tick fields, which always win — a schedule must not be able to
            // forge which slot it claims to be.
            payload: {
              ...(schedule.payload ?? {}),
              loop,
              slot,
              cadenceSeconds,
              skippedSlots: skipped,
            },
          },
          { now },
        );
        if (outcome.admitted) emitted.push({ loop, slot, skipped });
        else if (!outcome.duplicate)
          errors.push(`${loop}@${slot}: ${outcome.errors.join("; ")}`);
      }
    } catch (err) {
      errors.push(`${loop}: ${err.message}`);
    }
  }
  return { emitted, errors };
}

/**
 * Runs for an agent that are still in flight, oldest first. PROPOSED remains
 * excluded (OPS-436): an unapproved watched proposal must not silence later
 * schedule slots. Returning the rows lets singleton NOOPs identify the run
 * they deferred to instead of dropping that audit evidence.
 */
export function inFlightRunsForAgent(db, agentRef) {
  return db
    .query(
      `SELECT run_id, state, created_at FROM runs
       WHERE state NOT IN ('PROPOSED','COMPLETED','REFUSED','FAILED','TIMED_OUT','CANCELLED')
         AND json_extract(spec_json, '$.agent') = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(agentRef);
}

/** The newest slot that successfully completed for a loop, or null if never completed (OPS-436). */
export function lastCompletedSlot(db, loop) {
  const row = db
    .query(
      `SELECT e.event_id FROM runs r
       JOIN proposals p ON p.run_id = r.run_id
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE e.source = ? AND (e.type = ? OR e.subject = ?) AND r.state = 'COMPLETED'
       ORDER BY e.event_id DESC LIMIT 1`,
    )
    .get(SCHEDULE_SOURCE, `clock.tick.${loop}`, loop);
  return row ? row.event_id.slice(`clock:${loop}:`.length) : null;
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
    const lastSlot = lastAdmittedSlot(db, loop, {
      now,
      eventType: schedule.eventType,
    });
    const lastCompleted = lastCompletedSlot(db, loop);
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
    const neverCompleted =
      Boolean(schedule.enabled) && lastSlot !== null && lastCompleted === null;
    return {
      loop,
      every: schedule.every,
      source: registry.scheduleSources?.[loop] ?? "kernel",
      cadenceSeconds,
      eventType: schedule.eventType,
      approval: schedule.approval ?? "watched",
      catchUp: schedule.catchUp ?? "none",
      singleton: schedule.singleton !== false,
      enabled: Boolean(schedule.enabled),
      lastSlot,
      lastCompletedSlot: lastCompleted,
      neverCompleted,
      nextDue,
      intervalsLate,
      // Enabled, has fired before, and more than two intervals have passed:
      // the clock is not turning (serve down, machine asleep, bad cadence).
      stopped:
        Boolean(schedule.enabled) &&
        intervalsLate !== null &&
        intervalsLate > 2,
      error,
    };
  });
}

/**
 * Does this admitted event look exactly like the tick `emitDueTicks` would
 * have emitted for `loop`? Auto-approval is the one path that runs work with
 * nobody watching, so it binds to the configured event type, the
 * `clock:<loop>:<slot>` identity the tick loop mints, and the schedule's
 * static payload — a stored event that drifts from any of those is left as an
 * ordinary open proposal for a human.
 */
function matchesConfiguredTick(envelope, row, loop, schedule) {
  const slot = envelope.payload?.slot;
  if (typeof slot !== "string" || slot === "") return false;
  if (row.event_id !== tickEventId(loop, slot)) return false;
  if (row.type !== schedule.eventType) return false;
  const payload = envelope.payload ?? {};
  for (const [key, value] of Object.entries(schedule.payload ?? {})) {
    // The tick fields always win over a schedule's static payload
    // (see emitDueTicks), so they are not part of the static binding.
    if (TICK_PAYLOAD_FIELDS.has(key)) continue;
    if (value === undefined) continue;
    if (!Object.hasOwn(payload, key)) return false;
    try {
      if (canonicalJson(payload[key]) !== canonicalJson(value)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** A missing event mapping or target definition has no valid re-plan path. */
function cannotReplanScheduledDefinition(registry, eventType) {
  const mapping = getEventType(registry, eventType);
  if (!mapping) return true;
  try {
    getAgent(registry, mapping.agent);
    return false;
  } catch {
    return true;
  }
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
export function autoApproveScheduled(
  db,
  registry,
  approve,
  { now = Date.now(), policyVersion } = {},
) {
  const approved = [];
  const expired = [];
  const errors = [];
  const autoLoops = new Map(
    Object.entries(registry.schedules ?? {}).filter(
      ([, s]) => s.enabled && (s.approval ?? "watched") === "auto",
    ),
  );
  const rows = db
    .query(
      `SELECT p.id, p.run_id, e.event_id, e.type, e.envelope_json FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.status = 'open' AND p.decision = 'run' AND e.source = ?`,
    )
    .all(SCHEDULE_SOURCE);
  for (const row of rows) {
    // A scheduler can outlive its mapped event or target definition across a
    // registry deploy. Approving this row would only re-plan and throw, so
    // resolve it once rather than reconsidering it on every serve tick.
    if (cannotReplanScheduledDefinition(registry, row.type)) {
      try {
        rejectProposal(db, row.id, {
          actor: SCHEDULE_SOURCE,
          reason: "registry_stale",
          now,
          policyVersion,
        });
        expired.push({ proposalId: row.id, runId: row.run_id });
      } catch (err) {
        errors.push(`registry_stale ${row.id}: ${err.message}`);
      }
      continue;
    }

    let envelope;
    try {
      envelope = JSON.parse(row.envelope_json);
    } catch {
      continue;
    }
    const loop = envelope.payload?.loop;
    const schedule = autoLoops.get(loop);
    if (!schedule) continue;
    // Defense in depth (#960): reserved `schedule` provenance is the primary
    // control, but auto-approval also refuses anything that is not shaped like
    // the tick this loop's configuration emits — its event type, its
    // `clock:<loop>:<slot>` identity, and its static payload verbatim.
    if (!matchesConfiguredTick(envelope, row, loop, schedule)) continue;
    try {
      const outcome = approve(db, registry, row.id, {
        actor: SCHEDULE_SOURCE,
        now,
        policyVersion,
      });
      if (outcome.approved)
        approved.push({ loop, proposalId: row.id, runId: outcome.runId });
    } catch (err) {
      errors.push(`${loop}: ${err.message}`);
    }
  }
  return { approved, expired, errors };
}

export const DEFAULT_PROPOSALS_PILING_THRESHOLD = 3;

/**
 * Detect open proposals for scheduled loops that pile up beyond threshold (WM-124).
 * A watched loop with more than `threshold` open proposals is either mis-cadenced
 * or nobody is watching it (docs/event-runtime-schedules.md §9).
 *
 * @returns {Array<{ loop: string, count: number, threshold: number }>}
 */
export function proposalsPilingUp(
  db,
  registry,
  { threshold = DEFAULT_PROPOSALS_PILING_THRESHOLD } = {},
) {
  const rows = db
    .query(
      `SELECT e.subject, e.envelope_json
       FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.status = 'open' AND e.source = ?`,
    )
    .all(SCHEDULE_SOURCE);

  const countsByLoop = new Map();
  for (const row of rows) {
    let loop = row.subject;
    if (!loop && row.envelope_json) {
      try {
        loop = JSON.parse(row.envelope_json).payload?.loop;
      } catch {
        // ignore
      }
    }
    if (!loop) continue;
    countsByLoop.set(loop, (countsByLoop.get(loop) ?? 0) + 1);
  }

  const piling = [];
  for (const [loop, count] of countsByLoop.entries()) {
    const schedule = registry?.schedules?.[loop];
    const loopThreshold = schedule?.proposalsThreshold ?? threshold;
    if (count > loopThreshold) {
      piling.push({
        loop,
        count,
        threshold: loopThreshold,
      });
    }
  }
  piling.sort((a, b) => a.loop.localeCompare(b.loop));
  return piling;
}

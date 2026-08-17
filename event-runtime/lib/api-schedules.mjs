/** Schedule listing and ad-hoc trigger endpoints. */
import { admitEvent } from "./intake.mjs";
import { planEvent } from "./planner.mjs";
import { parseCadence, scheduleView } from "./schedules.mjs";

export async function handleScheduleApiRoute({
  route,
  url,
  req,
  db,
  registry,
  send,
  readBody,
  parseJson,
  nowMs,
  actor,
  policyVersion,
  onEvent,
}) {
  if (route === "GET /schedules") {
    const schedules = scheduleView(db, registry, { now: nowMs }).map((item) => {
      const repo = registry.schedules?.[item.loop]?.payload?.repo;
      return {
        ...item,
        repo: typeof repo === "string" && repo !== "" ? repo : null,
      };
    });
    return send(200, { schedules });
  }

  const schedulePost = url.pathname.match(
    /^\/schedules\/([^/]+)\/(run|trigger)$/,
  );
  if (req.method === "POST" && schedulePost) {
    const loop = decodeURIComponent(schedulePost[1]);
    const schedule = registry.schedules?.[loop];
    if (!schedule) {
      return send(404, {
        error: `unknown schedule "${loop}"`,
        schedules: Object.keys(registry.schedules ?? {}),
      });
    }
    const raw = await readBody(req);
    const parsed = raw.length === 0 ? { value: {} } : parseJson(raw);
    if (parsed.error) return send(422, { error: parsed.error });
    const triggerInput = parsed.value;
    if (
      !triggerInput ||
      typeof triggerInput !== "object" ||
      Array.isArray(triggerInput)
    ) {
      return send(422, { error: "trigger body must be an object" });
    }

    const isMergeSchedule = schedule.eventType === "factory.merge.requested";
    const inputKeys = Object.keys(triggerInput);
    if (!isMergeSchedule && inputKeys.length > 0) {
      return send(422, {
        error: `schedule "${loop}" does not accept trigger input`,
      });
    }
    const unknownKeys = inputKeys.filter((key) => key !== "prNumbers");
    if (isMergeSchedule && unknownKeys.length > 0) {
      return send(422, {
        error: `merge schedule trigger accepts only prNumbers; unexpected: ${unknownKeys.join(", ")}`,
      });
    }

    const schedulePayload = { ...(schedule.payload ?? {}) };
    // Manual selection is operator input only. A static schedule payload
    // cannot turn recurring or blank manual scans into targeted scans.
    delete schedulePayload.prNumbers;

    let prNumbers;
    if (isMergeSchedule && triggerInput.prNumbers !== undefined) {
      prNumbers = triggerInput.prNumbers;
      if (!Array.isArray(prNumbers) || prNumbers.length === 0) {
        return send(422, { error: "prNumbers must be a nonempty array" });
      }
      if (
        !prNumbers.every((number) => Number.isInteger(number) && number > 0)
      ) {
        return send(422, {
          error: "prNumbers must contain only positive integers",
        });
      }
      if (new Set(prNumbers).size !== prNumbers.length) {
        return send(422, { error: "prNumbers must not contain duplicates" });
      }
    }

    let cadenceSeconds;
    try {
      cadenceSeconds = parseCadence(schedule.every);
    } catch {
      // Cadence might have parse error in bad config.
    }
    const isoNow = new Date(nowMs).toISOString();
    let eventId = `manual:${loop}:${isoNow}`;
    let seq = 0;
    while (
      db
        .query(`SELECT 1 FROM events WHERE source = ? AND event_id = ?`)
        .get(actor, eventId)
    ) {
      seq += 1;
      eventId = `manual:${loop}:${isoNow}:${seq}`;
    }
    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId,
      type: schedule.eventType,
      source: actor,
      subject: loop,
      occurredAt: isoNow,
      correlationId: eventId,
      causationId: null,
      payload: {
        ...schedulePayload,
        loop,
        slot: isoNow,
        ...(cadenceSeconds ? { cadenceSeconds } : {}),
        skippedSlots: 0,
        ...(prNumbers ? { prNumbers } : {}),
      },
    };
    const outcome = admitEvent(db, registry, envelope, { now: nowMs });
    if (!outcome.admitted && !outcome.duplicate)
      return send(422, { errors: outcome.errors });
    if (outcome.admitted) onEvent("admitted");
    const plan = planEvent(
      db,
      registry,
      { source: actor, eventId },
      { now: nowMs, policyVersion },
    );
    return send(200, {
      admitted: outcome.admitted,
      duplicate: outcome.duplicate,
      eventId,
      proposalId: plan.proposal?.id ?? null,
      runId: plan.runId ?? null,
      decision: plan.decision,
      reason: plan.reason ?? null,
      disabled: !schedule.enabled,
      loop,
    });
  }

  return false;
}

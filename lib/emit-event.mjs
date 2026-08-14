/**
 * Fire-and-forget lifecycle event emitter (WM-75).
 *
 * Orchestrator scripts report what they did — a ticket dispatched, a claim
 * reaped, a worktree reclaimed — into the event runtime's intake, so the
 * factory's own lifecycle lands in the same audited event log as webhooks and
 * clock ticks, and chains can hang off it later.
 *
 * Two properties are load-bearing:
 *
 * - **The runtime being down must never affect the orchestrator.** One
 *   attempt, a short timeout, every failure swallowed. Dispatch worked for
 *   months without an event log; an event log must not become a dependency.
 * - **eventId is deterministic per occurrence**, supplied by the caller, so a
 *   retried script re-admits nothing (intake dedups on it) while a genuinely
 *   new occurrence gets a new id.
 *
 * Transport is the loopback control API's `POST /replay` — the same
 * unsigned admission path as `cli.mjs inject` (loopback only, §13).
 */

const DEFAULT_PORT = 7381;

export function buildEnvelope(type, payload, { eventId, subject = null, occurredAt } = {}) {
  if (!eventId) throw new Error("emit-event: a deterministic eventId is required");
  if (!type) throw new Error("emit-event: type is required");
  return {
    schemaVersion: "factory.event/v1",
    eventId,
    type,
    source: "orchestrator",
    subject,
    occurredAt: occurredAt ?? new Date().toISOString(),
    correlationId: eventId,
    causationId: null,
    payload: payload ?? {},
  };
}

/**
 * @returns {Promise<object|null>} the intake's response, or null if the
 *   runtime is unreachable / refused — callers must not branch on this.
 */
export async function emitFactoryEvent(type, payload, opts = {}) {
  const port = Number(opts.port ?? process.env.FACTORY_EVENT_PORT ?? DEFAULT_PORT);
  const timeoutMs = opts.timeoutMs ?? 1000;
  let envelope;
  try {
    envelope = buildEnvelope(type, payload, opts);
  } catch {
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

/**
 * Chain trace endpoint (WM-527): everything that shares one correlation id.
 *
 * A chain instance is stitched by two ids the emitter writes on every hop
 * (lib/chain.mjs): `correlationId` — inherited unchanged from the origin
 * event, falling back to the origin's own eventId when it carried none — and
 * `causationId` — the run id that produced the derived event. So the whole
 * tree is one `correlation_id` lookup, and the tree shape is
 * `run → proposal → event.causation_id → parent run` — reconstructed here as
 * flat event + run lists; the client builds the graph.
 */
import { repoNamesFromInput } from "./api-runs.mjs";

/** The id that names an event's chain: its correlation id, else its own id. */
export function chainKeyOf(event) {
  return event?.correlationId ?? event?.correlation_id ?? event?.eventId ?? event?.event_id ?? null;
}

export function chainView(db, correlationId) {
  const eventRows = db
    .query(
      `SELECT e.source, e.event_id, e.type, e.subject, e.status, e.occurred_at,
              e.received_at, e.admitted_at, e.correlation_id, e.causation_id,
              e.envelope_json,
              p.id AS proposal_id, p.status AS proposal_status,
              p.decision AS proposal_decision, p.run_id AS run_id
       FROM events e
       LEFT JOIN proposals p ON p.rowid = (
         SELECT p2.rowid FROM proposals p2
         WHERE p2.event_source = e.source AND p2.event_id = e.event_id
         ORDER BY p2.created_at DESC, p2.rowid DESC
         LIMIT 1
       )
       WHERE e.correlation_id = ?1
          OR (e.correlation_id IS NULL AND e.event_id = ?1)
       ORDER BY e.admitted_at ASC, e.rowid ASC`,
    )
    .all(correlationId);
  if (eventRows.length === 0) return null;

  const events = eventRows.map((row) => {
    let payload = null;
    try {
      payload = JSON.parse(row.envelope_json)?.payload ?? null;
    } catch {
      payload = null;
    }
    return {
      source: row.source,
      eventId: row.event_id,
      type: row.type,
      subject: row.subject,
      status: row.status,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      admittedAt: row.admitted_at,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      proposalId: row.proposal_id ?? null,
      proposalStatus: row.proposal_status ?? null,
      proposalDecision: row.proposal_decision ?? null,
      runId: row.run_id ?? null,
      repos: repoNamesFromInput(payload),
    };
  });

  // Runs the events produced, plus any parent named by a causation id that is
  // not otherwise in the set — the client draws those as roots so a chain
  // whose origin lives under a different correlation still traces.
  const runIds = new Set();
  for (const e of events) {
    if (e.runId) runIds.add(e.runId);
    if (e.causationId) runIds.add(e.causationId);
  }
  const runs = [];
  for (const runId of runIds) {
    const row = db
      .query(
        `SELECT r.run_id, r.state, r.attempts, r.spec_json, r.created_at, r.updated_at,
                a.reason_code, a.started_at, a.finished_at,
                p.event_id, p.event_source
         FROM runs r
         LEFT JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
         LEFT JOIN proposals p ON p.run_id = r.run_id AND p.decision = 'run'
         WHERE r.run_id = ?
         LIMIT 1`,
      )
      .get(runId);
    if (!row) continue;
    let spec = {};
    try {
      spec = JSON.parse(row.spec_json) ?? {};
    } catch {
      spec = {};
    }
    runs.push({
      runId: row.run_id,
      state: row.state,
      attempts: row.attempts,
      agent: spec.agent ?? null,
      adapter: spec.adapter ?? null,
      reasonCode: row.reason_code ?? null,
      eventId: row.event_id ?? null,
      eventSource: row.event_source ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      repos: repoNamesFromInput(spec.input),
    });
  }
  runs.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return { correlationId, events, runs };
}

export function handleChainApiRoute({ route, url, send, db }) {
  const match = url.pathname.match(/^\/chain\/([^/]+)$/);
  if (!match || route !== `GET ${url.pathname}`) return false;
  const correlationId = decodeURIComponent(match[1]);
  const view = chainView(db, correlationId);
  if (!view) return send(404, { error: "chain not found" });
  return send(200, view);
}

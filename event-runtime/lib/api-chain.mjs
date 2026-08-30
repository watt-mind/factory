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
import { ApiParameterError, parseListLimit } from "./api-params.mjs";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The id that names an event's chain: its correlation id, else its own id. */
export function chainKeyOf(event) {
  return (
    event?.correlationId ??
    event?.correlation_id ??
    event?.eventId ??
    event?.event_id ??
    null
  );
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
      /* malformed envelope: payload stays null from the initializer */
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
      /* malformed spec_json: spec stays {} from the initializer */
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

/** Number of derived-event hops from the origin to the deepest event. */
function maxChainDepth(events, runs) {
  const eventKey = (source, eventId) => `${source}\0${eventId}`;
  const parentEventByRun = new Map();
  for (const run of runs) {
    if (run.eventSource && run.eventId) {
      parentEventByRun.set(run.runId, eventKey(run.eventSource, run.eventId));
    }
  }
  const byId = new Map(
    events.map((event) => [eventKey(event.source, event.eventId), event]),
  );
  const memo = new Map();

  function depth(key, visiting = new Set()) {
    if (memo.has(key)) return memo.get(key);
    const event = byId.get(key);
    if (!event?.causationId) return 0;
    if (visiting.has(key)) return 0;
    const parentEventKey = parentEventByRun.get(event.causationId);
    if (!parentEventKey || !byId.has(parentEventKey)) return 1;
    visiting.add(key);
    const value = depth(parentEventKey, visiting) + 1;
    visiting.delete(key);
    memo.set(key, value);
    return value;
  }

  return events.reduce(
    (max, event) => Math.max(max, depth(eventKey(event.source, event.eventId))),
    0,
  );
}

function chainSummary(view) {
  const origin =
    view.events.find((event) => !event.causationId) ?? view.events[0];
  const states = {};
  const repos = new Set();
  let lastActivityAt = origin.admittedAt;
  for (const event of view.events) {
    if (event.admittedAt > lastActivityAt) lastActivityAt = event.admittedAt;
    for (const repo of event.repos) repos.add(repo);
  }
  for (const run of view.runs) {
    states[run.state] = (states[run.state] ?? 0) + 1;
    if (run.updated_at > lastActivityAt) lastActivityAt = run.updated_at;
    for (const repo of run.repos) repos.add(repo);
  }
  return {
    correlationId: view.correlationId,
    origin: {
      source: origin.source,
      eventId: origin.eventId,
      type: origin.type,
      subject: origin.subject,
      admittedAt: origin.admittedAt,
    },
    eventCount: view.events.length,
    runCount: view.runs.length,
    maxDepth: maxChainDepth(view.events, view.runs),
    states,
    lastActivityAt,
    repos: [...repos].sort(),
    single: view.events.length === 1 && view.runs.length === 0,
  };
}

/** Recent chain instances, newest activity first. */
export function chainsView(
  db,
  {
    windowMs = DEFAULT_WINDOW_MS,
    limit = DEFAULT_LIMIT,
    nowMs = Date.now(),
  } = {},
) {
  const cutoff = new Date(nowMs - windowMs).toISOString();
  // Find recent keys in SQL before expanding each complete trace. Run activity
  // counts even when the last event is old, including a causation parent run.
  const candidates = db
    .query(
      `WITH event_activity AS (
         SELECT COALESCE(correlation_id, event_id) AS chain_key,
                MAX(admitted_at) AS event_last
         FROM events
         GROUP BY COALESCE(correlation_id, event_id)
       ), proposal_activity AS (
         SELECT COALESCE(e.correlation_id, e.event_id) AS chain_key,
                MAX(r.updated_at) AS run_last
         FROM events e
         JOIN proposals p ON p.event_source = e.source AND p.event_id = e.event_id
         JOIN runs r ON r.run_id = p.run_id
         GROUP BY COALESCE(e.correlation_id, e.event_id)
       ), causation_activity AS (
         SELECT COALESCE(e.correlation_id, e.event_id) AS chain_key,
                MAX(r.updated_at) AS cause_last
         FROM events e
         JOIN runs r ON r.run_id = e.causation_id
         GROUP BY COALESCE(e.correlation_id, e.event_id)
       )
       SELECT ea.chain_key,
              MAX(ea.event_last, COALESCE(pa.run_last, ''), COALESCE(ca.cause_last, '')) AS last_activity
       FROM event_activity ea
       LEFT JOIN proposal_activity pa ON pa.chain_key = ea.chain_key
       LEFT JOIN causation_activity ca ON ca.chain_key = ea.chain_key
       WHERE MAX(ea.event_last, COALESCE(pa.run_last, ''), COALESCE(ca.cause_last, '')) >= ?
       ORDER BY last_activity DESC, ea.chain_key ASC
       LIMIT ?`,
    )
    .all(cutoff, limit);

  return candidates
    .map(({ chain_key }) => chainView(db, chain_key))
    .filter(Boolean)
    .map(chainSummary)
    .sort(
      (a, b) =>
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.correlationId.localeCompare(b.correlationId),
    );
}

function windowMs(value) {
  if (value == null || value === "") return DEFAULT_WINDOW_MS;
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const result = Number(match[1]) * unit;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function handleChainApiRoute({ route, url, send, db, nowMs }) {
  if (route === "GET /chains") {
    const parsedWindow = windowMs(url.searchParams.get("window"));
    if (parsedWindow == null)
      return send(422, {
        error: "invalid_window",
        message: "window must be a positive duration such as 24h",
      });
    let parsedLimit;
    try {
      parsedLimit = parseListLimit(url, {
        defaultLimit: DEFAULT_LIMIT,
        maxLimit: MAX_LIMIT,
      });
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      throw err;
    }
    return send(200, {
      chains: chainsView(db, {
        windowMs: parsedWindow,
        limit: parsedLimit,
        nowMs,
      }),
    });
  }
  const match = url.pathname.match(/^\/chain\/([^/]+)$/);
  if (!match || route !== `GET ${url.pathname}`) return false;
  const correlationId = decodeURIComponent(match[1]);
  const view = chainView(db, correlationId);
  if (!view) return send(404, { error: "chain not found" });
  return send(200, view);
}

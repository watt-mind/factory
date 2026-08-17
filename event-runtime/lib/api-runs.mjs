/** Event, proposal, run, journal, outbox, and worker-action endpoints. */
import { artifactHead } from "./api-artifacts.mjs";
import { runUsage } from "./db.mjs";
import { IllegalTransition, lifecycleOf } from "./lifecycle.mjs";
import { archiveDeadLetteredEvent, requeueEvent } from "./planner.mjs";
import {
  approveProposal,
  openProposals,
  rejectProposal,
} from "./proposals.mjs";
import { traceOf } from "./trace.mjs";
import { cancelRun, releaseStalledWorkerLease, retryRun } from "./worker.mjs";

/** Optional repository names named by a run/event input (OPS-356). */
export function repoNamesFromInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const names = [];
  const add = (value) => {
    if (typeof value === "string" && value !== "" && !names.includes(value))
      names.push(value);
  };
  if (input.repoPin && typeof input.repoPin === "object")
    add(input.repoPin.repo);
  add(input.repo);
  if (Array.isArray(input.repos)) {
    for (const entry of input.repos) {
      if (typeof entry === "string") add(entry);
      else if (entry && typeof entry === "object") add(entry.name);
    }
  }
  return names;
}

function proposalView(row) {
  return {
    id: row.id,
    decision: row.decision,
    status: row.status,
    expired: row.expired ?? false,
    created_at: row.created_at,
    ttl_seconds: row.ttl_seconds,
    decided_at: row.decided_at ?? null,
    decided_by: row.decided_by ?? null,
    reason: row.reason,
    runId: row.run_id,
    eventId: row.event_id,
    eventSource: row.event_source,
    agent: row.spec?.agent ?? null,
    spec: row.spec,
    repos: repoNamesFromInput(row.spec?.input),
  };
}

function proposalHistory(db, status) {
  const rows = status
    ? db
        .query(
          `SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(status)
    : db
        .query(`SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC`)
        .all();
  return rows.map((row) =>
    proposalView({
      ...row,
      spec: row.spec_json ? JSON.parse(row.spec_json) : null,
    }),
  );
}

function eventsView(db, status) {
  const sql = `
    SELECT e.*, p.id AS proposal_id, p.run_id AS run_id
    FROM events e
    LEFT JOIN proposals p ON p.rowid = (
      SELECT p2.rowid FROM proposals p2
      WHERE p2.event_source = e.source AND p2.event_id = e.event_id
      ORDER BY p2.created_at DESC, p2.rowid DESC
      LIMIT 1
    )
    ${status ? "WHERE e.status = ?" : ""}
    ORDER BY e.admitted_at DESC, e.rowid DESC`;
  const rows = status ? db.query(sql).all(status) : db.query(sql).all();
  return rows.map((row) => {
    const envelope = JSON.parse(row.envelope_json);
    return {
      source: row.source,
      eventId: row.event_id,
      type: row.type,
      subject: row.subject,
      status: row.status,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      planFailures: row.plan_failures,
      lastPlanError: row.last_plan_error,
      admittedAt: row.admitted_at,
      proposalId: row.proposal_id ?? null,
      runId: row.run_id ?? null,
      envelope,
      repos: repoNamesFromInput(envelope.payload),
    };
  });
}

const TICKET_ID = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

function objectNamesTicket(value, ticket) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => objectNamesTicket(entry, ticket));
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^(ticket|ticketId|issue|issueId|linearId)$/i.test(key) &&
      typeof entry === "string" &&
      entry.toUpperCase() === ticket
    )
      return true;
    if (entry && typeof entry === "object" && objectNamesTicket(entry, ticket))
      return true;
  }
  return false;
}

function parseObject(json) {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function collectPrRefs(value, refs = { numbers: new Set(), urls: new Set() }) {
  if (!value || typeof value !== "object") return refs;
  if (Array.isArray(value)) {
    for (const entry of value) collectPrRefs(entry, refs);
    return refs;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      const match = entry.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:$|[/?#])/);
      if (match) {
        refs.urls.add(entry);
        refs.numbers.add(Number(match[1]));
      }
    }
    if (/^(pr|prNumber|pullRequest|pullRequestNumber)$/i.test(key)) {
      const number = Number(entry);
      if (Number.isInteger(number) && number > 0) refs.numbers.add(number);
    }
    if (entry && typeof entry === "object") collectPrRefs(entry, refs);
  }
  return refs;
}

function hasPrRef(value, refs) {
  const own = collectPrRefs(value);
  for (const number of own.numbers) if (refs.numbers.has(number)) return true;
  for (const url of own.urls) if (refs.urls.has(url)) return true;
  return false;
}

function namedString(values, names) {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of names) {
      if (typeof value[name] === "string" && value[name].trim()) return value[name].trim();
    }
  }
  return null;
}

/**
 * Everything the ticket journey needs in one bounded server-side join. The
 * existing `/runs` route carries `?ticket=` so this stays inside the run API
 * module and does not add another top-level router branch. Matching starts on
 * explicit ticket fields (never arbitrary prose), then closes over linked
 * event/proposal/run ids and PR references emitted by dispatch/merge results.
 */
export function ticketJourneyView(db, rawTicket, options = {}) {
  const ticket = String(rawTicket ?? "").trim().toUpperCase();
  if (!TICKET_ID.test(ticket)) return null;

  const eventRows = db.query(`SELECT * FROM events ORDER BY admitted_at, rowid`).all();
  const proposalRows = db.query(`SELECT * FROM proposals ORDER BY created_at, rowid`).all();
  const runRows = db.query(`SELECT * FROM runs ORDER BY created_at, rowid`).all();
  const resultRows = db.query(`SELECT * FROM results ORDER BY rowid`).all();
  const resultByRun = new Map();
  for (const row of resultRows) {
    const result = parseObject(row.result_json);
    if (!resultByRun.has(row.run_id)) resultByRun.set(row.run_id, []);
    resultByRun.get(row.run_id).push(result);
  }

  const events = new Set();
  const proposals = new Set();
  const runs = new Set();
  for (const row of eventRows) {
    const envelope = parseObject(row.envelope_json);
    if (
      String(row.subject ?? "").toUpperCase() === ticket ||
      objectNamesTicket(envelope, ticket)
    )
      events.add(`${row.source}\0${row.event_id}`);
  }
  for (const row of proposalRows) {
    const spec = parseObject(row.spec_json);
    if (objectNamesTicket(spec.input, ticket)) proposals.add(row.id);
  }
  for (const row of runRows) {
    const spec = parseObject(row.spec_json);
    const results = resultByRun.get(row.run_id) ?? [];
    if (
      objectNamesTicket(spec.input, ticket) ||
      results.some((result) => objectNamesTicket(result, ticket))
    )
      runs.add(row.run_id);
  }

  // Link closure catches runs that name only their proposal/event and events
  // whose payload names only a PR emitted by the original dispatch attempt.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of proposalRows) {
      const eventKey = `${row.event_source}\0${row.event_id}`;
      if (
        proposals.has(row.id) ||
        events.has(eventKey) ||
        (row.run_id && runs.has(row.run_id))
      ) {
        if (!proposals.has(row.id)) { proposals.add(row.id); changed = true; }
        if (!events.has(eventKey)) { events.add(eventKey); changed = true; }
        if (row.run_id && !runs.has(row.run_id)) { runs.add(row.run_id); changed = true; }
      }
    }
  }

  const prRefs = { numbers: new Set(), urls: new Set() };
  for (const runId of runs) {
    for (const result of resultByRun.get(runId) ?? []) collectPrRefs(result, prRefs);
  }
  if (prRefs.numbers.size || prRefs.urls.size) {
    for (const row of runRows) {
      const spec = parseObject(row.spec_json);
      const results = resultByRun.get(row.run_id) ?? [];
      if (hasPrRef(spec.input, prRefs) || results.some((result) => hasPrRef(result, prRefs)))
        runs.add(row.run_id);
    }
    for (const row of eventRows) {
      if (hasPrRef(parseObject(row.envelope_json), prRefs))
        events.add(`${row.source}\0${row.event_id}`);
    }
  }

  const matchedEvents = eventsView(db).filter((event) =>
    events.has(`${event.source}\0${event.eventId}`),
  );
  const matchedProposals = proposalHistory(db).filter((proposal) => proposals.has(proposal.id));
  const matchedRuns = [...runs]
    .map((runId) => runView(db, runId, options))
    .filter(Boolean)
    .sort((a, b) => a.run.created_at.localeCompare(b.run.created_at));

  const metadata = [
    ...matchedEvents.map((event) => event.envelope?.payload),
    ...matchedProposals.map((proposal) => proposal.spec?.input),
    ...matchedRuns.map((run) => run.run.spec?.input),
    ...matchedRuns.map((run) => run.result?.artifact),
  ];
  const title = namedString(metadata, ["ticketTitle", "linearTitle", "issueTitle"]);
  const recordedState = namedString(metadata, ["ticketState", "linearState", "issueState"]);
  const createdAt = namedString(metadata, ["ticketCreatedAt", "linearCreatedAt", "issueCreatedAt"]);
  const active = matchedRuns.find((run) =>
    ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(run.run.state),
  );
  const merged = matchedRuns.some((run) =>
    /merged/i.test(JSON.stringify(run.result?.artifact ?? {})),
  );
  const inferredState = merged
    ? "Done"
    : active
      ? "In Progress"
      : matchedProposals.some((proposal) => proposal.decision === "noop")
        ? "Todo"
        : matchedRuns.length
          ? "In Review"
          : null;

  return {
    ticket: {
      id: ticket,
      title,
      state: recordedState ?? inferredState,
      createdAt,
      url: `https://linear.app/watt-mind/issue/${encodeURIComponent(ticket)}`,
    },
    activity: matchedEvents.length > 0 || matchedProposals.length > 0 || matchedRuns.length > 0,
    events: matchedEvents,
    proposals: matchedProposals,
    runs: matchedRuns,
  };
}

function runsView(db, state) {
  const where = state ? `WHERE r.state = ?` : ``;
  const rows = db
    .query(
      `SELECT r.*, a.reason_code, a.terminal_state AS attempt_terminal, p.event_id, p.event_source
       FROM runs r
       LEFT JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       LEFT JOIN proposals p ON p.run_id = r.run_id AND p.decision = 'run'
       ${where}
       ORDER BY r.created_at DESC, r.rowid DESC`,
    )
    .all(...(state ? [state] : []));
  return rows.map((row) => {
    const spec = JSON.parse(row.spec_json);
    return {
      runId: row.run_id,
      state: row.state,
      attempts: row.attempts,
      maxAttempts: spec.maxAttempts,
      agent: spec.agent,
      adapter: spec.adapter,
      reasonCode: row.reason_code ?? null,
      eventId: row.event_id ?? null,
      eventSource: row.event_source ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      modelTier: spec.modelTier ?? null,
      model: spec.model ?? null,
      repos: repoNamesFromInput(spec.input),
    };
  });
}

function journalView(db, since, limit) {
  const rows = db
    .query(
      `SELECT * FROM lifecycle_events WHERE seq > ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(since, limit);
  const head =
    db.query(`SELECT MAX(seq) AS m FROM lifecycle_events`).get().m ?? 0;
  return {
    head,
    entries: rows.map((row) => ({
      seq: row.seq,
      runId: row.run_id,
      from: row.from_state,
      to: row.to_state,
      actor: row.actor,
      reason: row.reason,
      attempt: row.attempt,
      at: row.at,
    })),
  };
}

function outboxView(db, limit) {
  return db
    .query(
      `SELECT seq, event_json, created_at, published_at FROM outbox ORDER BY seq DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      seq: row.seq,
      event: JSON.parse(row.event_json),
      created_at: row.created_at,
      published_at: row.published_at,
    }));
}

export function observedModelFromTranscript(head) {
  if (typeof head !== "string" || head === "") return null;
  const lines = head.split("\n");
  lines.pop();
  for (const line of lines) {
    if (!line.includes(`"model"`)) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== "object") continue;
    if (
      msg.type === "system" &&
      msg.subtype === "init" &&
      typeof msg.model === "string" &&
      msg.model !== ""
    ) {
      return msg.model;
    }
    const message = msg.message;
    if (
      message &&
      typeof message === "object" &&
      typeof message.model === "string" &&
      message.model !== ""
    ) {
      const provider =
        typeof message.provider === "string" ? message.provider : "";
      return provider && !message.model.includes("/")
        ? `${provider}/${message.model}`
        : message.model;
    }
  }
  return null;
}

function runView(db, runId, { artifactsDir } = {}) {
  const row = db.query(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
  if (!row) return null;
  const attempts = db
    .query(`SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt`)
    .all(runId);
  const resultRow = db
    .query(
      `SELECT * FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
    )
    .get(runId);
  const result = resultRow ? JSON.parse(resultRow.result_json) : null;
  const transcript = (result?.artifacts ?? []).find(
    (a) => a.kind === "transcript",
  );
  const latest = attempts[attempts.length - 1];
  return {
    run: {
      runId: row.run_id,
      state: row.state,
      attempts: row.attempts,
      idempotencyKey: row.idempotency_key,
      specHash: row.spec_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      spec: JSON.parse(row.spec_json),
    },
    lifecycle: lifecycleOf(db, runId),
    attempts,
    result,
    receipt: resultRow ? JSON.parse(resultRow.receipt_json) : null,
    workspace: latest?.workspace_path ?? null,
    observedModel:
      artifactsDir && transcript?.sha256
        ? observedModelFromTranscript(
            artifactHead(artifactsDir, transcript.sha256),
          )
        : null,
    usage: runUsage(db, runId),
  };
}

export async function handleRunApiRoute({
  route,
  req,
  url,
  db,
  registry,
  send,
  readBody,
  parseJson,
  nowMs,
  actor,
  policyVersion,
  artifactsDir,
  onEvent,
}) {
  if (route === "GET /events") {
    return send(200, {
      events: eventsView(db, url.searchParams.get("status")),
    });
  }

  if (route === "GET /proposals") {
    const status = url.searchParams.get("status");
    if (status)
      return send(200, {
        proposals: proposalHistory(db, status === "all" ? null : status),
      });
    return send(200, {
      proposals: openProposals(db, { now: nowMs }).map(proposalView),
    });
  }

  if (route === "GET /journal") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    return send(
      200,
      journalView(db, Number.isFinite(since) ? since : 0, limit),
    );
  }

  if (route === "GET /outbox") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    return send(200, { outbox: outboxView(db, limit) });
  }

  if (route === "POST /events/requeue" || route === "POST /events/archive") {
    const body = parseJson(await readBody(req)).value ?? {};
    if (!body.source || !body.eventId)
      return send(422, { error: "source and eventId required" });
    try {
      if (route === "POST /events/archive") {
        return send(
          200,
          archiveDeadLetteredEvent(
            db,
            { source: body.source, eventId: body.eventId },
            { now: nowMs },
          ),
        );
      }
      requeueEvent(
        db,
        { source: body.source, eventId: body.eventId },
        { actor, now: nowMs },
      );
      onEvent("requeued");
      return send(200, { requeued: true });
    } catch (err) {
      const status = String(err.message).startsWith("unknown event")
        ? 404
        : 409;
      return send(status, { error: err.message });
    }
  }

  const workerRelease = url.pathname.match(/^\/workers\/([^/]+)\/release$/);
  if (req.method === "POST" && workerRelease) {
    const workerId = decodeURIComponent(workerRelease[1]);
    const body = parseJson(await readBody(req)).value ?? {};
    if (!body.runId) return send(422, { error: "runId required" });
    try {
      return send(
        200,
        releaseStalledWorkerLease(
          db,
          { workerId, runId: body.runId },
          { actor, now: nowMs, policyVersion },
        ),
      );
    } catch (err) {
      const status = String(err.message).startsWith("unknown worker")
        ? 404
        : 409;
      return send(status, { error: err.message });
    }
  }

  const proposalVerb = url.pathname.match(
    /^\/proposals\/([^/]+)\/(approve|reject)$/,
  );
  if (req.method === "POST" && proposalVerb) {
    const [, id, verb] = proposalVerb;
    const body = parseJson(await readBody(req)).value ?? {};
    try {
      if (verb === "approve") {
        const outcome = approveProposal(db, registry, id, {
          actor,
          now: nowMs,
          policyVersion,
        });
        if (outcome.approved)
          return send(200, { approved: true, runId: outcome.runId });
        return send(200, {
          approved: false,
          replanned: true,
          proposal: proposalView({ ...outcome.proposal, expired: false }),
        });
      }
      const outcome = rejectProposal(db, id, {
        actor,
        reason: body.reason,
        now: nowMs,
        policyVersion,
      });
      return send(200, { rejected: true, runId: outcome.runId });
    } catch (err) {
      const status = String(err.message).startsWith("unknown proposal")
        ? 404
        : 409;
      return send(status, { error: err.message });
    }
  }

  if (route === "GET /runs") {
    const ticket = url.searchParams.get("ticket");
    if (ticket) {
      const journey = ticketJourneyView(db, ticket, { artifactsDir });
      if (!journey) return send(422, { error: "ticket must look like WM-123" });
      return send(200, journey);
    }
    return send(200, { runs: runsView(db, url.searchParams.get("state")) });
  }

  const runVerb = url.pathname.match(/^\/runs\/([^/]+)\/(cancel|retry)$/);
  if (req.method === "POST" && runVerb) {
    const [, runId, verb] = runVerb;
    if (!db.query(`SELECT run_id FROM runs WHERE run_id = ?`).get(runId)) {
      return send(404, { error: `unknown run ${runId}` });
    }
    const body = parseJson(await readBody(req)).value ?? {};
    try {
      if (verb === "cancel") {
        const outcome = cancelRun(db, runId, {
          actor,
          reason: body.reason ?? "operator_cancel",
          now: nowMs,
          policyVersion,
        });
        if (outcome.proposalClose?.ambiguous) {
          return send(200, {
            cancelled: true,
            ambiguousOpenProposals: [
              { runId, count: outcome.proposalClose.count },
            ],
          });
        }
        return send(200, { cancelled: true });
      }
      retryRun(db, runId, {
        actor,
        force: body.force === true,
        now: nowMs,
        policyVersion,
      });
      return send(200, { queued: true });
    } catch (err) {
      if (
        err instanceof IllegalTransition ||
        err.message === "attempts_exhausted"
      ) {
        return send(409, { error: err.message });
      }
      throw err;
    }
  }

  const traceGet = url.pathname.match(/^\/runs\/([^/]+)\/trace$/);
  if (req.method === "GET" && traceGet) {
    const runId = traceGet[1];
    if (!db.query(`SELECT run_id FROM runs WHERE run_id = ?`).get(runId)) {
      return send(404, { error: `unknown run ${runId}` });
    }
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    return send(
      200,
      traceOf(db, runId, {
        since: Number.isFinite(since) ? since : 0,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    );
  }

  const runGet = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (req.method === "GET" && runGet) {
    const view = runView(db, runGet[1], { artifactsDir });
    if (!view) return send(404, { error: `unknown run ${runGet[1]}` });
    return send(200, view);
  }

  return false;
}

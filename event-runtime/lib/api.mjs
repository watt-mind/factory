/**
 * Loopback control API (docs/event-runtime.md §12–§14).
 *
 * Every operator read and verb goes through these endpoints — the TUI/CLI is
 * a client, never the database. The server binds to 127.0.0.1 only: in the
 * MVP the control API is a local trust surface, so there is no authentication
 * story beyond local user access. Webhook intake (§14) verifies the HMAC over
 * the raw body bytes before anything is parsed or written; the replay verb
 * (§13) shares the exact same admission path but, being loopback-only, needs
 * no signature. Operator verbs record "operator" as actor — authenticated
 * actor identity is the web-app step, not this one.
 */
import { createReadStream, readFileSync } from "node:fs";
import http from "node:http";
import { findArtifact } from "./artifacts.mjs";
import { API_HOST, DEFAULT_PORT, artifactsRoot, environmentName, runtimeHome, webhookSecret } from "./config.mjs";
import { admitEvent, verifyWebhook } from "./intake.mjs";
import { IllegalTransition, lifecycleOf } from "./lifecycle.mjs";
import { requeueEvent } from "./planner.mjs";
import { approveProposal, openProposals, rejectProposal } from "./proposals.mjs";
import { cancelRun, retryRun } from "./worker.mjs";

/** §14 size limit: a control-plane payload has no business being megabytes. */
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function parseJson(buffer) {
  try {
    return { value: JSON.parse(buffer.toString("utf8")) };
  } catch (err) {
    return { error: `invalid JSON body: ${err.message}` };
  }
}

/** Shape one proposal row for the list view (§12) — origin event included. */
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
  };
}

/** Decision history (§12): every proposal, newest first, optional status filter. */
function proposalHistory(db, status) {
  const rows = status
    ? db.query(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC`).all(status)
    : db.query(`SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC`).all();
  return rows.map((row) => proposalView({ ...row, spec: row.spec_json ? JSON.parse(row.spec_json) : null }));
}

function eventCounts(db) {
  const counts = { admitted: 0, planned: 0, noop: 0, human_needed: 0, dead_lettered: 0 };
  for (const row of db.query(`SELECT status, COUNT(*) AS n FROM events GROUP BY status`).all()) {
    counts[row.status] = row.n;
  }
  return counts;
}

function runCounts(db) {
  const byState = {};
  for (const row of db.query(`SELECT state, COUNT(*) AS n FROM runs GROUP BY state`).all()) {
    byState[row.state] = row.n;
  }
  return { byState };
}

/** §13 status + doctor view: aggregates plus anomalies, all read-only SQL. */
function statusView(db, nowMs) {
  const open = openProposals(db, { now: nowMs });
  const expiredOpen = open.filter((p) => p.expired);
  const staleLeases = db
    .query(
      `SELECT COUNT(*) AS n FROM runs r
       JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       WHERE r.state IN ('LEASED', 'RUNNING') AND a.lease_expires_at < ?`,
    )
    .get(new Date(nowMs).toISOString()).n;
  const unpublishedOutbox = db
    .query(`SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`)
    .get().n;
  const deadLettered = db
    .query(`SELECT source, event_id, last_plan_error FROM events WHERE status = 'dead_lettered'`)
    .all()
    .map((row) => ({ source: row.source, eventId: row.event_id, lastError: row.last_plan_error }));

  return {
    events: eventCounts(db),
    proposals: { open: open.length, expired: expiredOpen.length },
    runs: runCounts(db),
    anomalies: {
      expiredOpenProposals: expiredOpen.map((p) => p.id),
      staleLeases,
      unpublishedOutbox,
      deadLettered,
    },
  };
}

/**
 * Admitted-event rows with their stored envelope (§13, webui spec §7): the
 * doctor panel's replay verb needs the body, and counts alone cannot show an
 * inbox. Read-only, like every other view here.
 */
function eventsView(db, status) {
  const rows = status
    ? db.query(`SELECT * FROM events WHERE status = ? ORDER BY admitted_at DESC, rowid DESC`).all(status)
    : db.query(`SELECT * FROM events ORDER BY admitted_at DESC, rowid DESC`).all();
  return rows.map((row) => ({
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
    envelope: JSON.parse(row.envelope_json),
  }));
}

/**
 * Runs list with the columns a list view actually renders: latest attempt's
 * reason, the originating event, and the agent — one query, no N+1.
 */
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
    };
  });
}

/** Append-only activity feed (§13): lifecycle journal after `since`. */
function journalView(db, since, limit) {
  const rows = db
    .query(`SELECT * FROM lifecycle_events WHERE seq > ? ORDER BY seq DESC LIMIT ?`)
    .all(since, limit);
  const head = db.query(`SELECT MAX(seq) AS m FROM lifecycle_events`).get().m ?? 0;
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

/** Result-event feed (§8 outbox): what the runtime published, newest first. */
function outboxView(db, limit) {
  return db
    .query(`SELECT seq, event_json, created_at, published_at FROM outbox ORDER BY seq DESC LIMIT ?`)
    .all(limit)
    .map((row) => ({
      seq: row.seq,
      event: JSON.parse(row.event_json),
      created_at: row.created_at,
      published_at: row.published_at,
    }));
}

/**
 * The agent registry, fully readable (§6, webui): definition, prompt text,
 * schemas, pins, and which event types route to each agent. An operator
 * approving a RunSpec should be able to read exactly what `agent@version`
 * means without opening the repo.
 */
function agentsView(registry) {
  return {
    agents: [...registry.agents.values()].map((def) => ({
      ref: def.ref,
      id: def.id,
      version: def.version,
      outputContract: def.output_contract,
      workspace: def.workspace,
      capabilities: def.capabilities,
      limits: def.limits,
      mutating: def.mutating,
      promptFile: def.prompt,
      prompt: readFileSync(def.promptPath, "utf8"),
      inputSchemaFile: def.input_schema,
      inputSchema: def.inputSchema,
      outputSchemaFile: def.output_schema,
      outputSchema: def.outputSchema,
      pins: def.pins,
      // Closed-execution shape (OPS-223/OPS-208): what a mutating definition
      // is actually allowed to run. Null for LLM agents.
      command: def.command ?? null,
      actionRegistry: def.actionRegistry ?? null,
      hosts: def.hosts ? Object.keys(def.hosts) : null,
      eventTypes: Object.entries(registry.eventTypes)
        .filter(([, mapping]) => mapping.agent === def.ref)
        .map(([type, mapping]) => ({
          type,
          adapter: mapping.adapter,
          idempotencyScope: mapping.idempotencyScope,
          proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
        })),
    })),
    // Recommendation edges (OPS-223) — the capability map's defining relation:
    // which artifact value on which agent routes to which follow-up event type.
    edges: registry.edges ?? {},
    // Every registered route, including types whose agent has no edges — the
    // graph needs the full topology, not just what agents happen to mention.
    eventTypes: Object.entries(registry.eventTypes).map(([type, mapping]) => ({
      type,
      agent: mapping.agent,
      adapter: mapping.adapter,
      idempotencyScope: mapping.idempotencyScope,
      proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
    })),
    contracts: {
      "factory.event/v1": registry.schemas.envelope,
      "factory.agent-result/v1": registry.schemas.agentResult,
    },
  };
}

/** Crude but honest content-type: render text in the browser, download the rest. */
function looksLikeText(file) {
  const head = readFileSync(file).subarray(0, 512);
  return !head.includes(0);
}

function runView(db, runId) {
  const row = db.query(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
  if (!row) return null;
  const attempts = db
    .query(`SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt`)
    .all(runId);
  const result = db
    .query(`SELECT * FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`)
    .get(runId);
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
    result: result ? JSON.parse(result.result_json) : null,
    receipt: result ? JSON.parse(result.receipt_json) : null,
    workspace: latest?.workspace_path ?? null,
  };
}

/**
 * Both admission routes converge here — the §15 requirement that webhook and
 * replay call the same intake function. onEvent("admitted") lets a foreground
 * serve loop plan immediately instead of waiting a tick.
 */
function admit(db, registry, res, buffer, nowMs, onEvent) {
  const parsed = parseJson(buffer);
  if (parsed.error) return send(res, 422, { errors: [parsed.error] });
  const outcome = admitEvent(db, registry, parsed.value, { now: nowMs });
  if (!outcome.admitted && !outcome.duplicate) return send(res, 422, { errors: outcome.errors });
  if (outcome.admitted) onEvent("admitted");
  return send(res, 200, {
    admitted: outcome.admitted,
    duplicate: outcome.duplicate,
    eventId: outcome.event.event_id,
  });
}

/**
 * Build the request handler. Returned directly (rather than only inside a
 * server) so tests can compose it however they like.
 */
export function createApi({
  db,
  registry,
  secret = webhookSecret(),
  now = () => Date.now(),
  policyVersion = "unknown",
  env = { name: environmentName(), home: runtimeHome(), adapter: null },
  onEvent = () => {},
} = {}) {
  const ACTOR = "operator"; // one local operator in the MVP (§14)

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${API_HOST}`);
      const route = `${req.method} ${url.pathname}`;
      const nowMs = now();

      if (route === "GET /health") {
        return send(res, 200, { ok: true, policyVersion, env });
      }

      if (route === "POST /events") {
        const raw = await readBody(req);
        const verdict = verifyWebhook({
          rawBody: raw,
          signature: req.headers["x-factory-signature"],
          timestamp: req.headers["x-factory-timestamp"],
          secret,
          now: nowMs,
        });
        // Fail closed: nothing is parsed, nothing is written (§14).
        if (!verdict.ok) return send(res, 401, { error: verdict.reason });
        return admit(db, registry, res, raw, nowMs, onEvent);
      }

      if (route === "POST /replay") {
        const raw = await readBody(req);
        return admit(db, registry, res, raw, nowMs, onEvent);
      }

      if (route === "GET /status") {
        return send(res, 200, { env, ...statusView(db, nowMs) });
      }

      if (route === "GET /events") {
        return send(res, 200, { events: eventsView(db, url.searchParams.get("status")) });
      }

      if (route === "GET /proposals") {
        const status = url.searchParams.get("status");
        if (status) return send(res, 200, { proposals: proposalHistory(db, status === "all" ? null : status) });
        return send(res, 200, { proposals: openProposals(db, { now: nowMs }).map(proposalView) });
      }

      if (route === "GET /agents") {
        return send(res, 200, agentsView(registry));
      }

      const artifactGet = url.pathname.match(/^\/artifacts\/([0-9a-f]{64})$/);
      if (req.method === "GET" && artifactGet) {
        const found = findArtifact(artifactsRoot(env.home), artifactGet[1]);
        if (!found) return send(res, 404, { error: `no artifact ${artifactGet[1]}` });
        res.writeHead(200, {
          "content-type": looksLikeText(found.file) ? "text/plain; charset=utf-8" : "application/octet-stream",
          "content-length": found.sizeBytes,
        });
        createReadStream(found.file).pipe(res);
        return;
      }

      if (route === "GET /journal") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
        return send(res, 200, journalView(db, Number.isFinite(since) ? since : 0, limit));
      }

      if (route === "GET /outbox") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
        return send(res, 200, { outbox: outboxView(db, limit) });
      }

      if (route === "POST /events/requeue") {
        const body = parseJson(await readBody(req)).value ?? {};
        if (!body.source || !body.eventId) return send(res, 422, { error: "source and eventId required" });
        try {
          requeueEvent(db, { source: body.source, eventId: body.eventId }, { actor: ACTOR, now: nowMs });
          onEvent("requeued"); // plan again right away, like a fresh admission
          return send(res, 200, { requeued: true });
        } catch (err) {
          const status = String(err.message).startsWith("unknown event") ? 404 : 409;
          return send(res, status, { error: err.message });
        }
      }

      const proposalVerb = url.pathname.match(/^\/proposals\/([^/]+)\/(approve|reject)$/);
      if (req.method === "POST" && proposalVerb) {
        const [, id, verb] = proposalVerb;
        const body = parseJson(await readBody(req)).value ?? {};
        try {
          if (verb === "approve") {
            const outcome = approveProposal(db, registry, id, { actor: ACTOR, now: nowMs, policyVersion });
            if (outcome.approved) return send(res, 200, { approved: true, runId: outcome.runId });
            return send(res, 200, { approved: false, replanned: true, proposal: proposalView({ ...outcome.proposal, expired: false }) });
          }
          const outcome = rejectProposal(db, id, { actor: ACTOR, reason: body.reason, now: nowMs, policyVersion });
          return send(res, 200, { rejected: true, runId: outcome.runId });
        } catch (err) {
          const status = String(err.message).startsWith("unknown proposal") ? 404 : 409;
          return send(res, status, { error: err.message });
        }
      }

      if (route === "GET /runs") {
        return send(res, 200, { runs: runsView(db, url.searchParams.get("state")) });
      }

      const runVerb = url.pathname.match(/^\/runs\/([^/]+)\/(cancel|retry)$/);
      if (req.method === "POST" && runVerb) {
        const [, runId, verb] = runVerb;
        if (!db.query(`SELECT run_id FROM runs WHERE run_id = ?`).get(runId)) {
          return send(res, 404, { error: `unknown run ${runId}` });
        }
        const body = parseJson(await readBody(req)).value ?? {};
        try {
          if (verb === "cancel") {
            cancelRun(db, runId, { actor: ACTOR, reason: body.reason ?? "operator_cancel", now: nowMs, policyVersion });
            return send(res, 200, { cancelled: true });
          }
          retryRun(db, runId, { actor: ACTOR, force: body.force === true, now: nowMs, policyVersion });
          return send(res, 200, { queued: true });
        } catch (err) {
          if (err instanceof IllegalTransition || err.message === "attempts_exhausted") {
            return send(res, 409, { error: err.message });
          }
          throw err;
        }
      }

      const runGet = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && runGet) {
        const view = runView(db, runGet[1]);
        if (!view) return send(res, 404, { error: `unknown run ${runGet[1]}` });
        return send(res, 200, view);
      }

      return send(res, 404, { error: `no route: ${route}` });
    } catch (err) {
      // Never leak a stack trace across the API boundary.
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      else res.end();
    }
  };
}

/**
 * Start the control API. Loopback only (§14) — `host` exists for symmetry but
 * defaults to 127.0.0.1 and nothing in the MVP passes anything else.
 */
export function startApi({ port = DEFAULT_PORT, host = API_HOST, ...opts } = {}) {
  const server = http.createServer(createApi(opts));
  server.listen(port, host);
  return server;
}

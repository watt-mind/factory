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
import { closeSync, createReadStream, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { findArtifact, listArtifacts, pruneArtifacts, storeStats } from "./artifacts.mjs";
import { API_HOST, DEFAULT_PORT, artifactsRoot, environmentName, runtimeHome, webhookSecret } from "./config.mjs";
import { runUsage, usageSpend } from "./db.mjs";
import { admitEvent, githubWebhookSecret, translateGitHubEvent, verifyGitHubWebhook, verifyWebhook } from "./intake.mjs";
import { janitorArgv, spawnFactoryJanitor } from "./janitor.mjs";
import { IllegalTransition, lifecycleOf } from "./lifecycle.mjs";
import { MetricsQueryError, metricsBreakdownView, metricsView } from "./metrics.mjs";
import { planEvent, requeueEvent } from "./planner.mjs";
import { ambiguousOpenProposalRuns, approveProposal, openProposals, rejectProposal } from "./proposals.mjs";
import { resolveModel } from "./registry.mjs";
import { loadRepos, RepoError, reposRoot, reposView } from "./repos.mjs";
import { traceOf } from "./trace.mjs";
import { cancelRun, retryRun } from "./worker.mjs";
import { parseCadence, proposalsPilingUp, scheduleView } from "./schedules.mjs";
import { listWorkers, loadWorkerPolicy, satisfiesPlacement, stalledWorkers } from "./workers.mjs";

/**
 * Repo names a run or event actually names — optional spec input, not a
 * foreign key (OPS-356). Unscoped work is `[]` and belongs only under All.
 */
export function repoNamesFromInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const names = [];
  const add = (value) => {
    if (typeof value === "string" && value !== "" && !names.includes(value)) names.push(value);
  };
  if (input.repoPin && typeof input.repoPin === "object") add(input.repoPin.repo);
  add(input.repo);
  if (Array.isArray(input.repos)) {
    for (const entry of input.repos) {
      if (typeof entry === "string") add(entry);
      else if (entry && typeof entry === "object") add(entry.name);
    }
  }
  return names;
}

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
    repos: repoNamesFromInput(row.spec?.input),
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

/** Node-local pool state: pidfile liveness and workers carrying drain requests. */
function runtimePoolState(runDir) {
  const drainingIds = new Set();
  let names = [];
  try {
    names = readdirSync(runDir);
  } catch {
    return { drainingIds, supervisor: "absent" };
  }
  for (const name of names) {
    const match = /^(worker-\d+)\.drain$/.exec(name);
    if (!match) continue;
    try {
      const workerId = readFileSync(path.join(runDir, `${match[1]}.id`), "utf8").trim();
      if (workerId) drainingIds.add(workerId);
    } catch {
      // A slot can disappear between directory read and id read; next poll heals it.
    }
  }
  let supervisor = "absent";
  try {
    const pid = Number(readFileSync(path.join(runDir, "supervisor.pid"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        supervisor = "active";
      } catch (err) {
        // EPERM still proves the process exists; only ESRCH means a stale pid.
        supervisor = err?.code === "EPERM" ? "active" : "stopped";
      }
    }
  } catch {
    // No pidfile means the fixed-worker fallback, not an error.
  }
  return { drainingIds, supervisor };
}

/**
 * One projection powers both API surfaces so Overview and Workers cannot show
 * contradictory numbers. Policy max is the concurrency ceiling after WM-226;
 * without pool policy the live registry remains the honest capacity fallback.
 */
export function workerCapacityView(db, nowMs, { workerPolicy = () => loadWorkerPolicy(), runDir } = {}) {
  const pool = runtimePoolState(runDir ?? process.env.FACTORY_RUN_DIR ?? path.join(homedir(), ".factory", "run"));
  const workers = listWorkers(db, { now: nowMs }).map((worker) => ({
    ...worker,
    draining: !worker.stale && worker.state !== "stopped" && pool.drainingIds.has(worker.workerId),
  }));
  const liveWorkers = workers.filter((worker) => worker.state !== "stopped" && !worker.stale);
  const running = liveWorkers.filter((worker) => worker.state === "busy").length;
  const draining = liveWorkers.filter((worker) => worker.draining).length;
  const idle = liveWorkers.filter((worker) => worker.state !== "busy" && !worker.draining).length;
  const queued = db.query(`SELECT COUNT(*) AS n FROM runs WHERE state = 'QUEUED'`).get().n;

  let policy = null;
  let policyError = null;
  try {
    policy = workerPolicy?.() ?? null;
  } catch (err) {
    policyError = `worker policy unavailable: ${err.message}`;
  }
  const hasPolicy = Number.isInteger(policy?.max) && policy.max > 0;
  const supervised = pool.supervisor === "active" && hasPolicy;
  const capacity = supervised ? policy.max : liveWorkers.length;
  const target = Math.max(0, liveWorkers.length - draining);
  let limitingFactor = null;
  if (queued > 0 && idle === 0) {
    limitingFactor = supervised && liveWorkers.length >= capacity ? "at worker max" : "no idle worker";
  }

  const classes = [];
  if (policy?.classes && typeof policy.classes === "object" && !Array.isArray(policy.classes)) {
    for (const [name, config] of Object.entries(policy.classes)) {
      const classCapacity = Number.isInteger(config) ? config : config?.max;
      if (!Number.isInteger(classCapacity) || classCapacity < 0) continue;
      classes.push({
        name,
        capacity: classCapacity,
        running: liveWorkers.filter((worker) => worker.state === "busy" && worker.labels?.class === name).length,
      });
    }
  }

  return {
    workers,
    policyError,
    capacity: {
      running,
      capacity,
      queued,
      live: liveWorkers.length,
      idle,
      draining,
      target,
      min: hasPolicy && Number.isInteger(policy.min) ? policy.min : null,
      max: hasPolicy ? policy.max : null,
      supervisor: pool.supervisor,
      source: supervised ? "worker-policy" : "live-workers",
      limitingFactor,
      classes,
    },
  };
}

/** §13 status + doctor view: aggregates plus anomalies, all read-only SQL. */
function statusView(db, registry, nowMs, { secret, githubSecret, policyVersion, env, getStoreStats, workerPolicy, workerRunDir } = {}) {
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

  const fleet = workerCapacityView(db, nowMs, { workerPolicy, runDir: workerRunDir });
  const workers = fleet.workers;
  const liveWorkers = workers.filter((worker) => worker.state !== "stopped" && !worker.stale);
  const unmatchedPlacementRuns = db
    .query(`SELECT run_id, spec_json FROM runs WHERE state = 'QUEUED' ORDER BY created_at, rowid`)
    .all()
    .flatMap((row) => {
      const placement = JSON.parse(row.spec_json).placement;
      // Unconstrained runs are covered by noWorkers; this anomaly explains why
      // an apparently healthy fleet still cannot claim a constrained run.
      if (!placement || Object.keys(placement).length === 0) return [];
      if (liveWorkers.some((worker) => satisfiesPlacement(worker.labels, placement))) return [];
      return [{ runId: row.run_id, placement }];
    });
  const schedules = scheduleView(db, registry, { now: nowMs });
  const store = getStoreStats
    ? getStoreStats(nowMs)
    : storeStats(db, artifactsRoot(env?.home), { now: nowMs });
  const stalled = stalledWorkers(db, { now: nowMs });
  const runs = { ...runCounts(db), spend: usageSpend(db, { now: nowMs }) };

  const configAnomalies = [];
  if (!secret) {
    configAnomalies.push("FACTORY_EVENT_SECRET is unset (webhook intake disabled)");
  }
  if (!githubSecret) {
    configAnomalies.push("FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)");
  }
  if (policyVersion === "unknown") {
    configAnomalies.push("policyVersion is unknown");
  }
  if (fleet.policyError) configAnomalies.push(fleet.policyError);

  return {
    events: eventCounts(db),
    proposals: { open: open.length, expired: expiredOpen.length },
    runs,
    workers: {
      live: fleet.capacity.live,
      busy: fleet.capacity.running,
      stale: workers.filter((w) => w.stale).length,
    },
    capacity: fleet.capacity,
    artifacts: {
      files: store.files,
      bytes: store.bytes,
      orphans: store.orphans,
      orphanBytes: store.orphanBytes,
      ...(store.at ? { at: store.at } : {}),
    },
    anomalies: {
      configuration: configAnomalies,
      expiredOpenProposals: expiredOpen.map((p) => p.id),
      staleLeases,
      unpublishedOutbox,
      deadLettered,
      // A worker holding a run whose heartbeat stopped: its lease may still be
      // valid, so nothing has reclaimed the run yet (OPS-233).
      stalledWorkers: stalled.map((w) => ({ workerId: w.workerId, host: w.host, runId: w.currentRun, lastSeen: w.lastSeen })),
      // A scheduler's worst failure mode is silence (§9): an enabled loop
      // that has not ticked for more than two intervals is not running.
      stoppedSchedules: schedules
        .filter((s) => s.stopped || s.error)
        .map((s) => ({ loop: s.loop, every: s.every, lastSlot: s.lastSlot, intervalsLate: s.intervalsLate, error: s.error })),
      unmatchedPlacementRuns,
      noWorkers: liveWorkers.length === 0 && (runs.byState.QUEUED ?? 0) > 0,
      // Two or more open proposals on one run: cancel fail-closes and leaves
      // them open (OPS-245). Unreachable on the TTL replan path.
      ambiguousOpenProposals: ambiguousOpenProposalRuns(db),
      proposalsPilingUp: proposalsPilingUp(db, registry),
    },
  };
}

/**
 * Admitted-event rows with their stored envelope (§13, webui spec §7): the
 * doctor panel's replay verb needs the body, and counts alone cannot show an
 * inbox. Read-only, like every other view here.
 */
function eventsView(db, status) {
  // Latest proposal (and its run) for each event — an event is a node, not a
  // leaf. Unplanned admissions have both ids null.
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
      // What the planner pinned (WM-135), so the list can carry a Model column
      // beside Adapter (WM-221). Absent on a spec whose definition declared no
      // intent — `null`, never omitted, so the column never renders a hole.
      modelTier: spec.modelTier ?? null,
      model: spec.model ?? null,
      repos: repoNamesFromInput(spec.input),
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
      // Per-agent repo scope (WM-64), the repo analogue of hosts. Null means
      // unrestricted.
      repos: def.repos ?? null,
      // Model-tier routing (WM-135): declared intent (tier), the exact-id
      // override, and — per routed adapter below — what the planner would pin.
      modelTier: def.model_tier ?? null,
      model: def.model ?? null,
      eventTypes: Object.entries(registry.eventTypes)
        .filter(([, mapping]) => mapping.agent === def.ref)
        .map(([type, mapping]) => ({
          type,
          adapter: mapping.adapter,
          idempotencyScope: mapping.idempotencyScope,
          proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
          // Resolved at load, so this can no longer throw here. Null when the
          // adapter takes no model or the definition declares nothing.
          resolvedModel: resolveModel(def, mapping.adapter, registry.modelTiers),
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

/**
 * How much of a transcript to read looking for the model id (WM-221).
 *
 * Both harnesses name the model in their opening handshake — claude in the
 * `system`/`init` line, pi on its first assistant message — so the answer is
 * always in the first few KB of a file that routinely runs to megabytes.
 * Reading a bounded head keeps `GET /runs/:id` a constant-cost read.
 */
export const TRANSCRIPT_MODEL_SCAN_BYTES = 64 * 1024;

/**
 * The model the CLI actually ran on, read out of the stored transcript
 * (WM-221). The spec's pinned value cannot answer this: `default` means
 * "whatever the CLI picks", and only the harness's own handshake says what
 * that was on the day.
 *
 * Neither adapter puts the id in the trace — `mapStreamEvent` maps text, tool
 * calls, and token usage, and nothing else — so the transcript artifact is
 * where it is stored, in two shapes:
 *
 * - claude: `{"type":"system","subtype":"init","model":"claude-opus-5[1m]"}`
 * - pi:     `{"type":"message_start","message":{"provider":"openai-codex","model":"gpt-5.6-terra"}}`
 *
 * pi splits what the spec pins as one string (`openai-codex/gpt-5.6-terra`),
 * so the provider is joined back on — an observed model an operator cannot
 * compare to the pinned one answers nothing. Returns null rather than a guess
 * for anything unrecognized, truncated, or unparseable.
 *
 * @param {string} head - the first bytes of a `.transcript.json` NDJSON stream
 * @returns {string | null}
 */
export function observedModelFromTranscript(head) {
  if (typeof head !== "string" || head === "") return null;
  const lines = head.split("\n");
  // The last line of a bounded read is almost always a partial JSON object.
  lines.pop();
  for (const line of lines) {
    if (!line.includes(`"model"`)) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a line longer than the scan window, or not JSON at all
    }
    if (!msg || typeof msg !== "object") continue;
    if (msg.type === "system" && msg.subtype === "init" && typeof msg.model === "string" && msg.model !== "") {
      return msg.model;
    }
    const message = msg.message;
    if (message && typeof message === "object" && typeof message.model === "string" && message.model !== "") {
      const provider = typeof message.provider === "string" ? message.provider : "";
      return provider && !message.model.includes("/") ? `${provider}/${message.model}` : message.model;
    }
  }
  return null;
}

/** Bounded head of a stored artifact; null when it is missing or unreadable. */
function artifactHead(artifactsDir, sha256, bytes = TRANSCRIPT_MODEL_SCAN_BYTES) {
  const found = findArtifact(artifactsDir, sha256);
  if (!found) return null;
  let fd;
  try {
    fd = openSync(found.file, "r");
    const buf = Buffer.alloc(Math.min(bytes, found.sizeBytes));
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    // A pruned or half-written artifact is a missing observation, not a 500.
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runView(db, runId, { artifactsDir } = {}) {
  const row = db.query(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
  if (!row) return null;
  const attempts = db
    .query(`SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt`)
    .all(runId);
  const resultRow = db
    .query(`SELECT * FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`)
    .get(runId);
  const result = resultRow ? JSON.parse(resultRow.result_json) : null;
  const transcript = (result?.artifacts ?? []).find((a) => a.kind === "transcript");
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
    // Not part of the immutable spec — an observation about the attempt that
    // ran, alongside `workspace` (WM-221). Null for a run with no transcript
    // yet, a non-model adapter, or a harness that named no model.
    observedModel:
      artifactsDir && transcript?.sha256
        ? observedModelFromTranscript(artifactHead(artifactsDir, transcript.sha256))
        : null,
    usage: runUsage(db, runId),
  };
}

export { janitorArgv, spawnFactoryJanitor } from "./janitor.mjs";

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
 * Loopback host validation (OPS-408): only loopback addresses are accepted.
 * Defends against DNS rebinding attacks.
 */
export function isLoopbackHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  const raw = hostHeader.trim();
  let host;
  if (raw.startsWith("[")) {
    const closeBracket = raw.indexOf("]");
    if (closeBracket === -1) return false;
    host = raw.slice(1, closeBracket);
  } else {
    host = raw.split(":")[0];
  }
  const lower = host.toLowerCase();
  return (
    lower === "127.0.0.1" ||
    lower.startsWith("127.") ||
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower.endsWith(".local")
  );
}

/**
 * Loopback origin validation (OPS-408, WM-61): allows loopback origins (e.g. from local Web UI).
 * Defends against cross-origin CSRF from foreign origins (e.g. evil.com).
 */
export function isLoopbackOrigin(originHeader) {
  if (!originHeader || typeof originHeader !== "string") return false;
  try {
    const url = new URL(originHeader);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "127.0.0.1" ||
      host.startsWith("127.") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/**
 * Build the request handler. Returned directly (rather than only inside a
 * server) so tests can compose it however they like.
 */
export function createApi({
  db,
  registry,
  secret = webhookSecret(),
  githubSecret = githubWebhookSecret(),
  now = () => Date.now(),
  policyVersion = "unknown",
  env = { name: environmentName(), home: runtimeHome(), adapter: null },
  onEvent = () => {},
  // Read per request, not once at startup: repos.yaml is a file an operator
  // edits, and a registry cached at boot would answer with yesterday's config
  // until someone restarted serve. Injectable so tests can point at a fixture
  // instead of whichever repos exist on the machine.
  repos = () => loadRepos(),
  workerPolicy = () => loadWorkerPolicy(),
  workerRunDir = process.env.FACTORY_RUN_DIR ?? path.join(homedir(), ".factory", "run"),
  // Host-side janitor spawn (OPS-301). Tests inject a fake; production
  // shells out to orchestrator/janitor.mjs --json, never --force.
  janitor = spawnFactoryJanitor,
} = {}) {
  const ACTOR = "operator"; // one local operator in the MVP (§14)
  const STORE_STATS_TTL_MS = 10_000;
  let cachedStoreStats = null;
  let cachedStoreStatsAt = 0;

  function getStoreStats(nowMs) {
    if (cachedStoreStats && nowMs - cachedStoreStatsAt < STORE_STATS_TTL_MS) {
      return cachedStoreStats;
    }
    const root = artifactsRoot(env?.home);
    const stats = storeStats(db, root, { now: nowMs });
    cachedStoreStats = stats;
    cachedStoreStatsAt = nowMs;
    return stats;
  }

  return async function handle(req, res) {
    try {
      // Security confinement (OPS-408, WM-61): loopback Host check & cross-origin CSRF protection.
      const hostHeader = req.headers["host"];
      if (!isLoopbackHost(hostHeader)) {
        return send(res, 403, { error: "invalid_host" });
      }

      const originHeader = req.headers["origin"];
      if (originHeader && !isLoopbackOrigin(originHeader)) {
        return send(res, 403, { error: "cross_origin_rejected" });
      }

      const url = new URL(req.url, `http://${API_HOST}`);
      const route = `${req.method} ${url.pathname}`;
      const nowMs = now();

      if (route === "GET /health") {
        return send(res, 200, {
          ok: true,
          policyVersion,
          env,
          webhookSecret: secret ? "set" : "absent",
          githubWebhookSecret: githubSecret ? "set" : "absent",
        });
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

      // GitHub webhook intake (WM-112). The route seam lives here because
      // intake.mjs has no HTTP layer; verification and translation are
      // intake's. GitHub signs the raw body only (no timestamp) with its own
      // header, so this is a separate path with a dedicated secret — the
      // factory-envelope path above is byte-for-byte unchanged. Benign
      // non-events answer 2xx `ignored` so GitHub does not disable the hook.
      if (route === "POST /github") {
        const raw = await readBody(req);
        const verdict = verifyGitHubWebhook({
          rawBody: raw,
          signature: req.headers["x-hub-signature-256"],
          secret: githubSecret,
        });
        if (!verdict.ok) return send(res, 401, { error: verdict.reason });
        const parsed = parseJson(raw);
        if (parsed.error) return send(res, 422, { errors: [parsed.error] });
        let repoRegistry;
        try {
          repoRegistry = repos();
        } catch (err) {
          if (err instanceof RepoError) return send(res, 500, { error: err.message });
          throw err;
        }
        const translated = translateGitHubEvent({
          event: req.headers["x-github-event"],
          deliveryId: req.headers["x-github-delivery"],
          payload: parsed.value,
          repos: repoRegistry,
          now: nowMs,
        });
        if (!translated.ok) {
          if (translated.ignored) return send(res, 200, { admitted: false, ignored: true, reason: translated.reason });
          return send(res, 422, { errors: [translated.reason] });
        }
        const outcome = admitEvent(db, registry, translated.envelope, { now: nowMs });
        if (!outcome.admitted && !outcome.duplicate) return send(res, 422, { errors: outcome.errors });
        if (outcome.admitted) onEvent("admitted");
        return send(res, 200, {
          admitted: outcome.admitted,
          duplicate: outcome.duplicate,
          eventId: outcome.event.event_id,
        });
      }

      if (route === "POST /replay") {
        const raw = await readBody(req);
        return admit(db, registry, res, raw, nowMs, onEvent);
      }

      if (route === "GET /status") {
        return send(res, 200, {
          env,
          ...statusView(db, registry, nowMs, {
            secret, githubSecret, policyVersion, env, getStoreStats, workerPolicy, workerRunDir,
          }),
        });
      }

      if (route === "GET /metrics") {
        try {
          return send(res, 200, metricsView(db, {
            now: nowMs,
            window: url.searchParams.get("window") ?? "24h",
            bucket: url.searchParams.get("bucket") ?? "1h",
            series: url.searchParams.get("series"),
          }));
        } catch (err) {
          if (err instanceof MetricsQueryError) return send(res, 422, err.body);
          throw err;
        }
      }

      if (route === "GET /metrics/breakdown") {
        try {
          return send(res, 200, metricsBreakdownView(db, {
            now: nowMs,
            window: url.searchParams.get("window") ?? "24h",
            by: url.searchParams.get("by"),
            metric: url.searchParams.get("metric"),
            limit: url.searchParams.get("limit"),
          }));
        } catch (err) {
          if (err instanceof MetricsQueryError) return send(res, 422, err.body);
          throw err;
        }
      }

      if (route === "GET /events") {
        return send(res, 200, { events: eventsView(db, url.searchParams.get("status")) });
      }

      if (route === "GET /proposals") {
        const status = url.searchParams.get("status");
        if (status) return send(res, 200, { proposals: proposalHistory(db, status === "all" ? null : status) });
        return send(res, 200, { proposals: openProposals(db, { now: nowMs }).map(proposalView) });
      }

      if (route === "GET /schedules") {
        return send(res, 200, { schedules: scheduleView(db, registry, { now: nowMs }) });
      }

      // Ad-hoc loop trigger (OPS-401): distinct from slot ticks (source="operator",
      // unique manual:<loop>:<now> ID, watched approval, never advances lastSlot).
      const schedulePost = url.pathname.match(/^\/schedules\/([^/]+)\/(run|trigger)$/);
      if (req.method === "POST" && schedulePost) {
        const loop = decodeURIComponent(schedulePost[1]);
        const schedule = registry.schedules?.[loop];
        if (!schedule) {
          return send(res, 404, {
            error: `unknown schedule "${loop}"`,
            schedules: Object.keys(registry.schedules ?? {}),
          });
        }
        let cadenceSeconds;
        try {
          cadenceSeconds = parseCadence(schedule.every);
        } catch {
          // Cadence might have parse error in bad config
        }
        const isoNow = new Date(nowMs).toISOString();
        let eventId = `manual:${loop}:${isoNow}`;
        let seq = 0;
        while (db.query(`SELECT 1 FROM events WHERE source = ? AND event_id = ?`).get(ACTOR, eventId)) {
          seq += 1;
          eventId = `manual:${loop}:${isoNow}:${seq}`;
        }
        const envelope = {
          schemaVersion: "factory.event/v1",
          eventId,
          type: schedule.eventType,
          source: ACTOR,
          subject: loop,
          occurredAt: isoNow,
          correlationId: eventId,
          causationId: null,
          payload: {
            loop,
            slot: isoNow,
            ...(cadenceSeconds ? { cadenceSeconds } : {}),
            skippedSlots: 0,
          },
        };
        const outcome = admitEvent(db, registry, envelope, { now: nowMs });
        if (!outcome.admitted && !outcome.duplicate) {
          return send(res, 422, { errors: outcome.errors });
        }
        if (outcome.admitted) onEvent("admitted");
        const plan = planEvent(
          db,
          registry,
          { source: ACTOR, eventId },
          { now: nowMs, policyVersion },
        );
        return send(res, 200, {
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

      if (route === "GET /workers") {
        const fleet = workerCapacityView(db, nowMs, { workerPolicy, runDir: workerRunDir });
        return send(res, 200, { workers: fleet.workers, capacity: fleet.capacity });
      }

      if (route === "GET /agents") {
        return send(res, 200, agentsView(registry));
      }

      // The factory repo registry (OPS-299): which projects exist, which are
      // dispatch targets, and where their worktrees live.
      if (route === "GET /repos") {
        try {
          return send(res, 200, { repos: reposView(repos()) });
        } catch (err) {
          // A missing or malformed repos.yaml is an operator-fixable config
          // problem; the generic 500 below would hide it behind
          // "internal_error" and send them reading the runtime's source.
          if (err instanceof RepoError) return send(res, 500, { error: err.message });
          throw err;
        }
      }

      // Loopback janitor (OPS-301): Dry is the default; Apply never --force.
      // Same actor as every other operator verb. UI confirm lives in OPS-362.
      const janitorPost = url.pathname.match(/^\/repos\/([^/]+)\/janitor$/);
      if (req.method === "POST" && janitorPost) {
        const name = decodeURIComponent(janitorPost[1]);
        let registry;
        try {
          registry = repos();
        } catch (err) {
          if (err instanceof RepoError) return send(res, 500, { error: err.message });
          throw err;
        }
        const repo = registry.get(name);
        if (!repo) return send(res, 404, { error: `unknown repo ${name}` });
        const body = parseJson(await readBody(req)).value ?? {};
        if (body.apply !== undefined && typeof body.apply !== "boolean") {
          return send(res, 422, { error: "apply must be a boolean" });
        }
        const apply = body.apply === true;
        if (apply && repo.reportOnly && !repo.worktreeDown) {
          return send(res, 409, {
            error: `report-only repo "${name}" has no worktree_down script; refusing apply`,
          });
        }
        try {
          const result = await janitor(name, { apply, repo, actor: ACTOR });
          return send(res, 200, { actor: ACTOR, apply, ...result });
        } catch (err) {
          const status = Number.isInteger(err.status) ? err.status : 500;
          if (status === 500) return send(res, 500, { error: "internal_error" });
          return send(res, status, { error: err.message });
        }
      }

      if (route === "GET /artifacts") {
        const orphanParam = url.searchParams.get("orphan");
        if (orphanParam !== null && orphanParam !== "true" && orphanParam !== "false") {
          return send(res, 422, { error: "orphan must be true or false" });
        }
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam === null ? undefined : Number(limitParam);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
          return send(res, 422, { error: "limit must be an integer between 1 and 500" });
        }
        const artifacts = listArtifacts(db, artifactsRoot(env.home), {
          orphan: orphanParam === null ? undefined : orphanParam === "true",
          kind: url.searchParams.has("kind") ? url.searchParams.get("kind") : undefined,
          search: url.searchParams.has("search") ? url.searchParams.get("search") : undefined,
          limit,
        });
        return send(res, 200, { artifacts });
      }

      if (route === "POST /artifacts/prune") {
        const raw = await readBody(req);
        const parsed = raw.length === 0 ? { value: {} } : parseJson(raw);
        if (parsed.error) return send(res, 422, { error: parsed.error });
        const body = parsed.value ?? {};
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 422, { error: "body must be an object" });
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          return send(res, 422, { error: "dryRun must be a boolean" });
        }
        if (body.apply !== undefined && typeof body.apply !== "boolean") {
          return send(res, 422, { error: "apply must be a boolean" });
        }
        if (body.apply === true && body.dryRun === true) {
          return send(res, 422, { error: "apply and dryRun cannot both be true" });
        }
        const apply = body.apply === true;
        const result = pruneArtifacts(db, artifactsRoot(env.home), {
          now: nowMs,
          dryRun: !apply,
        });
        if (apply) {
          cachedStoreStats = null;
          cachedStoreStatsAt = 0;
        }
        return send(res, 200, result);
      }

      const artifactGet = url.pathname.match(/^\/artifacts\/([0-9a-f]{64})$/);
      if (req.method === "GET" && artifactGet) {
        const found = findArtifact(artifactsRoot(env.home), artifactGet[1]);
        if (!found) return send(res, 404, { error: `no artifact ${artifactGet[1]}` });
        // Optional ?name= gives the browser a save-as filename instead of the
        // bare hash. Sanitized to a header-safe charset; the sha12 suffix keeps
        // two same-named artifacts distinguishable on disk.
        const rawName = url.searchParams.get("name");
        const safeName = rawName ? rawName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) : "";
        res.writeHead(200, {
          "content-type": looksLikeText(found.file) ? "text/plain; charset=utf-8" : "application/octet-stream",
          "content-length": found.sizeBytes,
          ...(safeName
            ? { "content-disposition": `inline; filename="${safeName}-${artifactGet[1].slice(0, 12)}"` }
            : {}),
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
            const outcome = cancelRun(db, runId, { actor: ACTOR, reason: body.reason ?? "operator_cancel", now: nowMs, policyVersion });
            if (outcome.proposalClose?.ambiguous) {
              return send(res, 200, {
                cancelled: true,
                ambiguousOpenProposals: [{ runId, count: outcome.proposalClose.count }],
              });
            }
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

      // Live agent trace (factory.trace/v1): incremental read via ?since=.
      const traceGet = url.pathname.match(/^\/runs\/([^/]+)\/trace$/);
      if (req.method === "GET" && traceGet) {
        const runId = traceGet[1];
        if (!db.query(`SELECT run_id FROM runs WHERE run_id = ?`).get(runId)) {
          return send(res, 404, { error: `unknown run ${runId}` });
        }
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
        return send(res, 200, traceOf(db, runId, {
          since: Number.isFinite(since) ? since : 0,
          limit: Number.isFinite(limit) ? limit : 100,
        }));
      }

      const runGet = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && runGet) {
        const view = runView(db, runGet[1], { artifactsDir: artifactsRoot(env?.home) });
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

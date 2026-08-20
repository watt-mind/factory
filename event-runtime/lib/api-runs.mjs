/** Event, proposal, run, journal, outbox, and worker-action endpoints. */
import { ControlPlaneError } from "../../lib/control-plane/types.mjs";
import { artifactHead } from "./api-artifacts.mjs";
import { DEFAULT_MAX_IN_FLIGHT, FACTORY_ROOT } from "./config.mjs";
import { loadRepos, RepoError } from "./repos.mjs";
import { runUsage } from "./db.mjs";
import { hookDecisionsFor } from "./hooks.mjs";
import { IllegalTransition, lifecycleOf } from "./lifecycle.mjs";
import { archiveDeadLetteredEvent, requeueEvent } from "./planner.mjs";
import {
  approveProposal,
  openProposals,
  rejectProposal,
} from "./proposals.mjs";
import { traceOf } from "./trace.mjs";
import {
  attemptDeadline,
  cancelRun,
  extendRunDeadline,
  policyMaxRunMinutes,
  releaseStalledWorkerLease,
  retryRun,
} from "./worker.mjs";
import { proposalSubject } from "./proposal-subject.mjs";

export const MAX_EXTENSION_SECONDS = 3600;

export { policyMaxRunMinutes };

function extensionRefusal(send, status, code, detail = {}) {
  return send(status, {
    error: code,
    extended: false,
    refusal: { code, retryable: false, ...detail },
  });
}

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

function proposalView(row, registry) {
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
    subject: registry ? proposalSubject(registry, row.spec) : null,
    repos: repoNamesFromInput(row.spec?.input),
  };
}

function proposalHistory(db, status, filters = {}) {
  const filteredDecision = filters.population === "decision";
  const rows =
    status && !filteredDecision
      ? db
          .query(
            `SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC`,
          )
          .all(status)
      : db
          .query(`SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC`)
          .all();
  return rows.flatMap((row) => {
    let decisionAt = row.decided_at ?? null;
    let effectiveStatus = row.status;
    if (filteredDecision && row.status === "open") {
      const expiresAt =
        Date.parse(row.created_at) + Number(row.ttl_seconds) * 1000;
      if (Number.isFinite(expiresAt) && expiresAt < filters.nowMs) {
        decisionAt = new Date(expiresAt).toISOString();
        effectiveStatus = "expired";
      }
    }
    if (filteredDecision) {
      const at = Date.parse(decisionAt ?? "");
      if (!Number.isFinite(at) || at < filters.fromMs || at >= filters.toMs)
        return [];
      if (filters.decisionStatus && effectiveStatus !== filters.decisionStatus)
        return [];
    }
    return [
      proposalView(
        {
          ...row,
          status: effectiveStatus,
          decided_at: decisionAt,
          expired: effectiveStatus === "expired",
          spec: row.spec_json ? JSON.parse(row.spec_json) : null,
        },
        filters.registry,
      ),
    ];
  });
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
  if (Array.isArray(value))
    return value.some((entry) => objectNamesTicket(entry, ticket));
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
      const match = entry.match(
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:$|[/?#])/,
      );
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
      if (typeof value[name] === "string" && value[name].trim())
        return value[name].trim();
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
  const ticket = String(rawTicket ?? "")
    .trim()
    .toUpperCase();
  if (!TICKET_ID.test(ticket)) return null;

  const eventRows = db
    .query(`SELECT * FROM events ORDER BY admitted_at, rowid`)
    .all();
  const proposalRows = db
    .query(`SELECT * FROM proposals ORDER BY created_at, rowid`)
    .all();
  const runRows = db
    .query(`SELECT * FROM runs ORDER BY created_at, rowid`)
    .all();
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
        if (!proposals.has(row.id)) {
          proposals.add(row.id);
          changed = true;
        }
        if (!events.has(eventKey)) {
          events.add(eventKey);
          changed = true;
        }
        if (row.run_id && !runs.has(row.run_id)) {
          runs.add(row.run_id);
          changed = true;
        }
      }
    }
  }

  const prRefs = { numbers: new Set(), urls: new Set() };
  for (const runId of runs) {
    for (const result of resultByRun.get(runId) ?? [])
      collectPrRefs(result, prRefs);
  }
  if (prRefs.numbers.size || prRefs.urls.size) {
    for (const row of runRows) {
      const spec = parseObject(row.spec_json);
      const results = resultByRun.get(row.run_id) ?? [];
      if (
        hasPrRef(spec.input, prRefs) ||
        results.some((result) => hasPrRef(result, prRefs))
      )
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
  const matchedProposals = proposalHistory(db).filter((proposal) =>
    proposals.has(proposal.id),
  );
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
  const title = namedString(metadata, [
    "ticketTitle",
    "linearTitle",
    "issueTitle",
  ]);
  const recordedState = namedString(metadata, [
    "ticketState",
    "linearState",
    "issueState",
  ]);
  const createdAt = namedString(metadata, [
    "ticketCreatedAt",
    "linearCreatedAt",
    "issueCreatedAt",
  ]);
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
    activity:
      matchedEvents.length > 0 ||
      matchedProposals.length > 0 ||
      matchedRuns.length > 0,
    events: matchedEvents,
    proposals: matchedProposals,
    runs: matchedRuns,
  };
}

/** Short TTL so Ticket Journey can poll without exhausting Linear. */
export const TICKET_DETAIL_CACHE_TTL_MS = 30_000;
const ticketDetailCache = new Map();
let injectedTicketDetailControlPlane = null;

/** Test seam: inject a ControlPlane (typically `memoryControlPlane`) or clear. */
export function setTicketDetailControlPlane(plane) {
  injectedTicketDetailControlPlane = plane ?? null;
}

export function clearTicketDetailCache() {
  ticketDetailCache.clear();
}

function trackerStateName(state) {
  if (typeof state === "string" && state.trim()) return state.trim();
  if (state && typeof state === "object" && typeof state.name === "string") {
    const name = state.name.trim();
    if (name) return name;
  }
  return null;
}

async function ticketDetailControlPlane(override) {
  if (override) return override;
  if (injectedTicketDetailControlPlane) return injectedTicketDetailControlPlane;
  const { loadControlPlane } =
    await import("../../lib/control-plane/index.mjs");
  return loadControlPlane({ root: FACTORY_ROOT });
}

/**
 * Live tracker snapshot for Ticket Journey (WM-914): title, state, markdown
 * description, and comments. Cached briefly so a 5s UI poll does not become a
 * Linear request storm.
 */
export async function ticketDetailView(rawTicket, options = {}) {
  const ticket = String(rawTicket ?? "")
    .trim()
    .toUpperCase();
  if (!TICKET_ID.test(ticket)) return { error: "invalid_ticket" };

  const nowMs = options.nowMs ?? Date.now();
  const cacheKey = ticket;
  if (options.noCache !== true) {
    const cached = ticketDetailCache.get(cacheKey);
    if (cached && nowMs - cached.timestamp < TICKET_DETAIL_CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }
  }

  try {
    const plane = await ticketDetailControlPlane(options.controlPlane);
    const [issue, comments] = await Promise.all([
      plane.getTicket(ticket),
      plane.listComments(ticket),
    ]);
    const identifier = issue.identifier ?? ticket;
    const data = {
      ticket: {
        id: identifier,
        identifier,
        title:
          typeof issue.title === "string" && issue.title.trim()
            ? issue.title.trim()
            : null,
        state: trackerStateName(issue.state),
        description:
          typeof issue.description === "string" ? issue.description : "",
        url:
          typeof issue.url === "string" && issue.url.trim()
            ? issue.url.trim()
            : `https://linear.app/watt-mind/issue/${encodeURIComponent(ticket)}`,
        assignee: issue.assignee ? { name: issue.assignee.name ?? null } : null,
      },
      comments: (Array.isArray(comments) ? comments : []).map((comment) => ({
        id: comment?.id ?? null,
        body: typeof comment?.body === "string" ? comment.body : "",
        createdAt:
          typeof comment?.createdAt === "string" ? comment.createdAt : null,
        user: comment?.user
          ? {
              id: comment.user.id ?? null,
              name: comment.user.name ?? null,
            }
          : null,
      })),
      fetchedAt: new Date(nowMs).toISOString(),
      cached: false,
    };
    ticketDetailCache.set(cacheKey, { timestamp: nowMs, data });
    return data;
  } catch (err) {
    const message = err?.message ? String(err.message) : "tracker read failed";
    if (err instanceof ControlPlaneError && /no such issue/i.test(message)) {
      return { error: "not_found", message };
    }
    return { error: "tracker_unavailable", message };
  }
}

/** States whose attempt deadline is live and render-relevant on the run list. */
const IN_FLIGHT_STATES = new Set(["LEASED", "RUNNING", "VERIFYING"]);

const RUN_POPULATIONS = new Set([
  "created",
  "terminal",
  "started",
  "retried",
  "leased",
  "finished",
  "usage",
]);

export const RUN_LIST_DEFAULT_LIMIT = 100;
export const RUN_LIST_MAX_LIMIT = 200;

class ListQueryError extends Error {
  constructor(error, details = {}) {
    super(error);
    this.body = { error, ...details };
  }
}

export function parseSinceDuration(since, nowMs = Date.now()) {
  if (since == null || since === "") {
    return nowMs - 14 * 24 * 60 * 60 * 1000;
  }
  if (typeof since === "number") {
    if (!Number.isFinite(since) || since <= 0) {
      throw new ListQueryError("invalid_since", { since });
    }
    if (since > 1e11) return since;
    return nowMs - since;
  }
  if (typeof since !== "string") {
    throw new ListQueryError("invalid_since", { since });
  }
  const trimmed = since.trim();
  const match = trimmed.match(
    /^(\d+)\s*(d|day|days|h|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|w|week|weeks)$/i,
  );
  if (match) {
    const count = Number(match[1]);
    if (!Number.isFinite(count) || count <= 0) {
      throw new ListQueryError("invalid_since", { since });
    }
    const unit = match[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith("w")) ms = count * 7 * 24 * 60 * 60 * 1000;
    else if (unit.startsWith("d")) ms = count * 24 * 60 * 60 * 1000;
    else if (unit.startsWith("h")) ms = count * 60 * 60 * 1000;
    else if (unit.startsWith("m")) ms = count * 60 * 1000;
    else if (unit.startsWith("s")) ms = count * 1000;
    return nowMs - ms;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate) && !/^\d+$/.test(trimmed)) {
    return parsedDate;
  }
  throw new ListQueryError("invalid_since", { since });
}

function collectTicketIds(value, targetSet = new Set()) {
  if (!value) return targetSet;
  if (typeof value === "string") {
    const matches = value.match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g);
    if (matches) {
      for (const m of matches) targetSet.add(m.toUpperCase());
    }
    return targetSet;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTicketIds(entry, targetSet);
    return targetSet;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(ticket|ticketId|issue|issueId|linearId)$/i.test(key) &&
        typeof entry === "string" &&
        TICKET_ID.test(entry.trim().toUpperCase())
      ) {
        targetSet.add(entry.trim().toUpperCase());
      }
      collectTicketIds(entry, targetSet);
    }
  }
  return targetSet;
}

const TICKET_INDEX_CACHE_TTL_MS = 5000;
const ticketIndexCache = new Map();

export function clearTicketIndexCache() {
  ticketIndexCache.clear();
}

/**
 * Aggregates unique tickets touched by events, proposals, runs, and results
 * within a given time window (default 14 days) (WM-821).
 */
export function ticketIndexView(db, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const sinceMs = parseSinceDuration(options.since, nowMs);
  const sinceIso = new Date(sinceMs).toISOString();
  const limit = options.limit
    ? Math.min(Math.max(1, Number(options.limit) || 50), 200)
    : 50;
  const repoFilter =
    typeof options.repo === "string" && options.repo.trim() !== ""
      ? options.repo.trim().toLowerCase()
      : null;

  const cacheKey = `${db.filename ?? "mem"}:${sinceMs}:${limit}:${repoFilter ?? ""}`;
  if (options.noCache !== true) {
    const cached = ticketIndexCache.get(cacheKey);
    if (cached && nowMs - cached.timestamp < TICKET_INDEX_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const eventRows = db
    .query(`SELECT * FROM events ORDER BY admitted_at, rowid`)
    .all();
  const proposalRows = db
    .query(`SELECT * FROM proposals ORDER BY created_at, rowid`)
    .all();
  const runRows = db
    .query(`SELECT * FROM runs ORDER BY created_at, rowid`)
    .all();
  const resultRows = db.query(`SELECT * FROM results ORDER BY rowid`).all();
  const lifecycleRows = db
    .query(`SELECT * FROM lifecycle_events ORDER BY rowid`)
    .all();

  const resultByRun = new Map();
  for (const row of resultRows) {
    const result = parseObject(row.result_json);
    if (!resultByRun.has(row.run_id)) resultByRun.set(row.run_id, []);
    resultByRun.get(row.run_id).push(result);
  }

  // Collect candidate ticket IDs across all entities
  const allTicketIds = new Set();
  for (const row of eventRows) {
    if (
      row.subject &&
      TICKET_ID.test(String(row.subject).trim().toUpperCase())
    ) {
      allTicketIds.add(String(row.subject).trim().toUpperCase());
    }
    const env = parseObject(row.envelope_json);
    collectTicketIds(env, allTicketIds);
  }
  for (const row of proposalRows) {
    const spec = parseObject(row.spec_json);
    collectTicketIds(spec.input, allTicketIds);
    collectTicketIds(row.reason, allTicketIds);
  }
  for (const row of runRows) {
    const spec = parseObject(row.spec_json);
    collectTicketIds(spec.input, allTicketIds);
    for (const res of resultByRun.get(row.run_id) ?? []) {
      collectTicketIds(res, allTicketIds);
    }
  }
  for (const row of lifecycleRows) {
    collectTicketIds(row.reason, allTicketIds);
  }

  const summaries = [];

  for (const ticket of allTicketIds) {
    const events = new Set();
    const proposals = new Set();
    const runs = new Set();

    for (const row of eventRows) {
      const envelope = parseObject(row.envelope_json);
      if (
        String(row.subject ?? "").toUpperCase() === ticket ||
        objectNamesTicket(envelope, ticket)
      ) {
        events.add(`${row.source}\0${row.event_id}`);
      }
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
      ) {
        runs.add(row.run_id);
      }
    }

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
          if (!proposals.has(row.id)) {
            proposals.add(row.id);
            changed = true;
          }
          if (!events.has(eventKey)) {
            events.add(eventKey);
            changed = true;
          }
          if (row.run_id && !runs.has(row.run_id)) {
            runs.add(row.run_id);
            changed = true;
          }
        }
      }
    }

    const prRefs = { numbers: new Set(), urls: new Set() };
    for (const runId of runs) {
      for (const result of resultByRun.get(runId) ?? []) {
        collectPrRefs(result, prRefs);
      }
    }
    if (prRefs.numbers.size || prRefs.urls.size) {
      for (const row of runRows) {
        const spec = parseObject(row.spec_json);
        const results = resultByRun.get(row.run_id) ?? [];
        if (
          hasPrRef(spec.input, prRefs) ||
          results.some((result) => hasPrRef(result, prRefs))
        ) {
          runs.add(row.run_id);
        }
      }
      for (const row of eventRows) {
        if (hasPrRef(parseObject(row.envelope_json), prRefs)) {
          events.add(`${row.source}\0${row.event_id}`);
        }
      }
    }

    const matchedEventRows = eventRows.filter((row) =>
      events.has(`${row.source}\0${row.event_id}`),
    );
    const matchedProposalRows = proposalRows.filter((row) =>
      proposals.has(row.id),
    );
    const matchedRunRows = runRows.filter((row) => runs.has(row.run_id));

    const metadata = [
      ...matchedEventRows.map((e) => parseObject(e.envelope_json)?.payload),
      ...matchedProposalRows.map((p) => parseObject(p.spec_json)?.input),
      ...matchedRunRows.map((r) => parseObject(r.spec_json)?.input),
      ...matchedRunRows.flatMap((r) =>
        (resultByRun.get(r.run_id) ?? []).map((res) => res?.artifact),
      ),
    ];

    // Repo
    const repo =
      namedString(metadata, ["repo"]) ??
      metadata.flatMap((m) => repoNamesFromInput(m))[0] ??
      null;

    if (repoFilter && (!repo || repo.toLowerCase() !== repoFilter)) {
      continue;
    }

    // Title
    const title = namedString(metadata, [
      "ticketTitle",
      "linearTitle",
      "issueTitle",
      "title",
    ]);

    // PR
    let pr = null;
    let foundPrUrl = null;
    let foundPrNumber = null;
    let foundCi = undefined;
    for (const meta of metadata) {
      if (!meta || typeof meta !== "object") continue;
      if (!foundPrUrl) {
        if (typeof meta.prUrl === "string") foundPrUrl = meta.prUrl;
        else if (typeof meta.url === "string" && meta.url.includes("/pull/"))
          foundPrUrl = meta.url;
      }
      if (foundPrNumber == null) {
        if (typeof meta.pr === "number") foundPrNumber = meta.pr;
        else if (typeof meta.prNumber === "number")
          foundPrNumber = meta.prNumber;
      }
      if (foundCi === undefined && meta.ci) {
        foundCi = meta.ci;
      }
    }
    if (!foundPrNumber && foundPrUrl) {
      const match = foundPrUrl.match(/\/pull\/(\d+)/);
      if (match) foundPrNumber = Number(match[1]);
    }
    if (!foundPrUrl && foundPrNumber) {
      const orgRepo = repo
        ? repo.includes("/")
          ? repo
          : `watt-mind/${repo}`
        : "watt-mind/factory";
      foundPrUrl = `https://github.com/${orgRepo}/pull/${foundPrNumber}`;
    }
    if (foundPrNumber || foundPrUrl) {
      pr = {
        number: foundPrNumber ?? 0,
        url: foundPrUrl ?? "",
        ...(foundCi ? { ci: foundCi } : {}),
      };
    }

    // Merged
    const merged = matchedRunRows.some((run) => {
      const results = resultByRun.get(run.run_id) ?? [];
      const spec = parseObject(run.spec_json);
      return (
        results.some(
          (res) =>
            res?.artifact?.outcome === "MERGED" ||
            res?.artifact?.merged === true ||
            /merged/i.test(JSON.stringify(res?.artifact ?? {})),
        ) ||
        (spec.agent?.startsWith("merge-") && run.state === "COMPLETED")
      );
    });

    // Active run
    const activeRunRow = matchedRunRows
      .slice()
      .reverse()
      .find((r) =>
        ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(r.state),
      );
    const activeRun = activeRunRow
      ? {
          runId: activeRunRow.run_id,
          state: activeRunRow.state,
          agent: parseObject(activeRunRow.spec_json).agent ?? null,
        }
      : null;

    // Last decision
    const sortedProposals = matchedProposalRows.slice().sort((a, b) => {
      const atA = a.decided_at ?? a.created_at;
      const atB = b.decided_at ?? b.created_at;
      return atA.localeCompare(atB);
    });
    const lastProposal = sortedProposals.at(-1);
    const lastDecision = lastProposal?.decision ?? null;

    // Attempts
    const attempts = matchedRunRows.reduce(
      (acc, r) => acc + (r.attempts || 1),
      0,
    );

    // Activities
    const activities = [];
    for (const e of matchedEventRows) {
      activities.push({
        at: e.occurred_at || e.admitted_at,
        kind: "event",
      });
    }
    for (const p of matchedProposalRows) {
      activities.push({
        at: p.decided_at || p.created_at,
        kind: "proposal",
      });
    }
    for (const r of matchedRunRows) {
      const results = resultByRun.get(r.run_id) ?? [];
      const spec = parseObject(r.spec_json);
      for (const res of results) {
        const isMerge =
          res?.artifact?.outcome === "MERGED" ||
          spec.agent?.startsWith("merge-");
        const isPr =
          res?.artifact?.outcome === "PR_OPEN" || Boolean(res?.artifact?.prUrl);
        activities.push({
          at: res.accepted_at || r.updated_at || r.created_at,
          kind: isMerge ? "merge" : isPr ? "pr" : "run",
        });
      }
      if (results.length === 0) {
        activities.push({
          at: r.updated_at || r.created_at,
          kind: spec.agent?.startsWith("merge-") ? "merge" : "run",
        });
      }
    }

    if (activities.length === 0) continue;

    activities.sort((a, b) => a.at.localeCompare(b.at));
    const latestActivity = activities.at(-1);
    const lastActivityAt = latestActivity.at;
    const lastActivityKind = latestActivity.kind;

    if (lastActivityAt < sinceIso) {
      continue;
    }

    // State calculation
    const recordedState = namedString(metadata, [
      "ticketState",
      "linearState",
      "issueState",
    ]);

    let state;
    if (merged) {
      state = "Done";
    } else if (activeRun) {
      state =
        activeRun.state === "RUNNING" ||
        activeRun.state === "VERIFYING" ||
        activeRun.state === "LEASED" ||
        activeRun.state === "QUEUED"
          ? "Running"
          : "In Progress";
    } else {
      const latestRun = matchedRunRows
        .slice()
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .at(-1);
      if (
        latestRun &&
        (latestRun.state === "FAILED" || latestRun.state === "CANCELLED")
      ) {
        state = "Failed";
      } else if (
        pr ||
        matchedRunRows.some((r) =>
          (resultByRun.get(r.run_id) ?? []).some(
            (res) => res?.artifact?.outcome === "PR_OPEN",
          ),
        )
      ) {
        state = "In Review";
      } else if (
        matchedProposalRows.some(
          (p) => p.decision === "human_needed" && p.status === "open",
        ) ||
        matchedEventRows.some((e) => e.status === "dead_lettered")
      ) {
        state = "Blocked";
      } else if (recordedState) {
        state = recordedState;
      } else if (matchedProposalRows.some((p) => p.decision === "noop")) {
        state = "Todo";
      } else if (matchedRunRows.length > 0) {
        state = "In Review";
      } else {
        state = "Todo";
      }
    }

    summaries.push({
      id: ticket,
      repo,
      title,
      state,
      lastActivityAt,
      lastActivityKind,
      attempts,
      activeRun,
      lastDecision,
      pr,
      merged,
    });
  }

  summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const result = summaries.slice(0, limit);
  if (options.noCache !== true) {
    ticketIndexCache.set(cacheKey, { timestamp: nowMs, data: result });
    if (ticketIndexCache.size > 100) {
      for (const [k, v] of ticketIndexCache.entries()) {
        if (nowMs - v.timestamp >= TICKET_INDEX_CACHE_TTL_MS * 2) {
          ticketIndexCache.delete(k);
        }
      }
    }
  }
  return result;
}

const WORK_PLAN_RECOMMENDATIONS = new Set(["DISPATCH", "LOW_SUPPLY", "NOOP"]);
const STATUS_REPORT_ACTIONS = new Set([
  "dispatch",
  "triage",
  "merge",
  "unblock",
  "wait",
]);
const WORK_PLAN_NOOPS = new Set(["queue_empty", "cap_full", "all_overlapping"]);

function asCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function isWorkPlanArtifact(artifact) {
  return (
    artifact &&
    typeof artifact === "object" &&
    !Array.isArray(artifact) &&
    WORK_PLAN_RECOMMENDATIONS.has(artifact.recommendation) &&
    typeof artifact.repo === "string" &&
    artifact.repo !== ""
  );
}

function isStatusReportArtifact(artifact) {
  return (
    artifact &&
    typeof artifact === "object" &&
    !Array.isArray(artifact) &&
    Array.isArray(artifact.repos) &&
    STATUS_REPORT_ACTIONS.has(artifact.recommendedAction)
  );
}

function laterScan(current, next) {
  if (!current) return next;
  if (!next) return current;
  return String(next.asOf ?? "") > String(current.asOf ?? "") ? next : current;
}

function deriveRecommendedAction(repos) {
  let anyTriage = false;
  let anyBlocked = false;
  for (const repo of repos) {
    const ready = repo.ready ?? 0;
    const cap = repo.cap ?? 0;
    const inFlight = repo.inFlight ?? 0;
    if (ready > 0 && (cap === 0 || inFlight < cap)) return "dispatch";
    if ((repo.triage ?? 0) > 0) anyTriage = true;
    if ((repo.blocked ?? 0) > 0) anyBlocked = true;
  }
  if (anyTriage) return "triage";
  if (anyBlocked) return "unblock";
  return "wait";
}

/**
 * Latest work-plan and status-report artifacts per configured repo (WM-823).
 * Counts are null when no scan has produced that figure yet — never invented.
 */
export function ticketSupplyView(db, options = {}) {
  const repoRegistry = options.repos ?? loadRepos();
  const configured = [...repoRegistry.values()];
  const configuredNames = new Set(configured.map((repo) => repo.name));
  const rows = db
    .query(
      `SELECT r.run_id, r.spec_json, res.result_json, res.accepted_at
       FROM results res
       JOIN runs r ON r.run_id = res.run_id
       WHERE r.state = 'COMPLETED'
         AND json_extract(r.spec_json, '$.outputContract') IN (
           'factory.work-plan/v1',
           'factory.status-report/v1'
         )
       ORDER BY res.accepted_at DESC, res.rowid DESC`,
    )
    .all();

  const latestPlanByRepo = new Map();
  const latestReportByRepo = new Map();
  let latestReport = null;

  for (const row of rows) {
    const spec = parseObject(row.spec_json);
    const result = parseObject(row.result_json);
    const artifact =
      result.artifact &&
      typeof result.artifact === "object" &&
      !Array.isArray(result.artifact)
        ? result.artifact
        : null;
    if (!artifact) continue;
    if (result.terminalState && result.terminalState !== "completed") continue;
    const scan = {
      artifact,
      runId: row.run_id,
      asOf: row.accepted_at,
    };
    const contract = spec.outputContract;
    if (contract === "factory.work-plan/v1" || isWorkPlanArtifact(artifact)) {
      const name =
        (typeof artifact.repo === "string" && artifact.repo) ||
        (typeof spec.input?.repo === "string" && spec.input.repo) ||
        null;
      if (!name || !configuredNames.has(name) || latestPlanByRepo.has(name))
        continue;
      latestPlanByRepo.set(name, scan);
      continue;
    }
    if (
      contract === "factory.status-report/v1" ||
      isStatusReportArtifact(artifact)
    ) {
      let touchesConfigured = false;
      for (const entry of artifact.repos ?? []) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          continue;
        if (typeof entry.name !== "string" || entry.name === "") continue;
        if (!configuredNames.has(entry.name)) continue;
        touchesConfigured = true;
        if (latestReportByRepo.has(entry.name)) continue;
        latestReportByRepo.set(entry.name, {
          repo: entry,
          runId: scan.runId,
          asOf: scan.asOf,
        });
      }
      if (touchesConfigured && !latestReport) latestReport = scan;
    }
  }

  const repos = configured.map((repo) => {
    const plan = latestPlanByRepo.get(repo.name);
    const report = latestReportByRepo.get(repo.name);
    const planReady = asCount(plan?.artifact?.readyCandidates);
    const reportTriage = asCount(report?.repo?.triage);
    const reportReady = asCount(report?.repo?.agentReady);
    const planTriage = asCount(plan?.artifact?.triageBacklog);
    // work-plan leaves triageBacklog at 0 when it skipped the Triage read.
    const triage =
      reportTriage ??
      (planReady != null && planReady > 0 ? null : planTriage) ??
      null;
    const ready = planReady ?? reportReady;
    const inFlight = asCount(report?.repo?.inProgress);
    const blocked = asCount(report?.repo?.blocked);
    const noopReason = WORK_PLAN_NOOPS.has(plan?.artifact?.noopReason)
      ? plan.artifact.noopReason
      : null;
    const newest = laterScan(
      plan ? { runId: plan.runId, asOf: plan.asOf } : null,
      report ? { runId: report.runId, asOf: report.asOf } : null,
    );
    return {
      name: repo.name,
      team: repo.team ?? null,
      triage,
      ready,
      inFlight,
      cap: repo.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      blocked,
      noopReason,
      asOf: newest?.asOf ?? null,
      sourceRunId: newest?.runId ?? null,
    };
  });

  const recommendedAction = STATUS_REPORT_ACTIONS.has(
    latestReport?.artifact?.recommendedAction,
  )
    ? latestReport.artifact.recommendedAction
    : deriveRecommendedAction(repos);

  return { repos, recommendedAction };
}

function listFilters(url, { proposal = false, nowMs = Date.now() } = {}) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const population = url.searchParams.get("population");
  if (!from && !to && !population) return {};
  if (!from || !to || !population) {
    throw new ListQueryError("incomplete_time_filter", {
      required: ["from", "to", "population"],
    });
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new ListQueryError("invalid_time_filter", { from, to });
  }
  const valid = proposal ? new Set(["decision"]) : RUN_POPULATIONS;
  if (!valid.has(population)) {
    throw new ListQueryError("invalid_population", {
      population,
      valid: [...valid],
    });
  }
  return { from, to, fromMs, toMs, population, nowMs };
}

function encodeRunCursor(row) {
  return Buffer.from(
    JSON.stringify({ createdAt: row.created_at, rowid: row.list_rowid }),
  ).toString("base64url");
}

function runPage(url) {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? RUN_LIST_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_LIST_MAX_LIMIT) {
    throw new ListQueryError("invalid_limit", {
      message: `limit must be an integer between 1 and ${RUN_LIST_MAX_LIMIT}`,
    });
  }

  const before = url.searchParams.get("before");
  if (!before) return { limit, before: null };
  try {
    const cursor = JSON.parse(
      Buffer.from(before, "base64url").toString("utf8"),
    );
    if (
      !cursor ||
      typeof cursor.createdAt !== "string" ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      !Number.isSafeInteger(cursor.rowid) ||
      cursor.rowid < 1
    ) {
      throw new Error("invalid cursor");
    }
    return { limit, before: cursor };
  } catch {
    throw new ListQueryError("invalid_before");
  }
}

function runsView(db, filters = {}, page = {}) {
  const { state, agent, from, to, population } = filters;
  const clauses = [];
  const params = [];
  if (agent) {
    clauses.push(`json_extract(r.spec_json, '$.agent') = ?`);
    params.push(agent);
  }
  if (!population || population === "created") {
    if (state) {
      clauses.push("r.state = ?");
      params.push(state);
    }
    if (population === "created") {
      clauses.push("r.created_at >= ? AND r.created_at < ?");
      params.push(from, to);
    }
  } else if (population === "terminal") {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM lifecycle_events metric_event
        WHERE metric_event.run_id = r.run_id
          AND metric_event.at >= ? AND metric_event.at < ?
          AND metric_event.to_state IN ('COMPLETED', 'FAILED', 'REFUSED', 'TIMED_OUT', 'CANCELLED')
          ${state ? "AND metric_event.to_state = ?" : ""}
      )`,
    );
    params.push(from, to, ...(state ? [state] : []));
  } else if (population === "started" || population === "leased") {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM lifecycle_events metric_event
        WHERE metric_event.run_id = r.run_id
          AND metric_event.to_state = ?
          AND metric_event.at >= ? AND metric_event.at < ?
      )`,
    );
    params.push(population === "started" ? "RUNNING" : "LEASED", from, to);
  } else if (population === "retried") {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM attempts metric_attempt
        WHERE metric_attempt.run_id = r.run_id AND metric_attempt.attempt > 1
          AND metric_attempt.started_at >= ? AND metric_attempt.started_at < ?
      )`,
    );
    params.push(from, to);
  } else if (population === "finished") {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM attempts metric_attempt
        WHERE metric_attempt.run_id = r.run_id
          AND metric_attempt.finished_at >= ? AND metric_attempt.finished_at < ?
      )`,
    );
    params.push(from, to);
  } else if (population === "usage") {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM run_usage metric_usage
        WHERE metric_usage.run_id = r.run_id
          AND metric_usage.recorded_at >= ? AND metric_usage.recorded_at < ?
      )`,
    );
    params.push(from, to);
  }
  if (page.before) {
    clauses.push("(r.created_at < ? OR (r.created_at = ? AND r.rowid < ?))");
    params.push(
      page.before.createdAt,
      page.before.createdAt,
      page.before.rowid,
    );
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT r.*, r.rowid AS list_rowid, a.reason_code, a.terminal_state AS attempt_terminal,
              a.started_at, a.lease_expires_at, p.event_id, p.event_source
       FROM runs r
       LEFT JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       LEFT JOIN proposals p ON p.run_id = r.run_id AND p.decision = 'run'
       ${where}
       ORDER BY r.created_at DESC, r.rowid DESC
       LIMIT ?`,
    )
    .all(...params, page.limit + 1);
  const hasNextPage = rows.length > page.limit;
  const pageRows = hasNextPage ? rows.slice(0, -1) : rows;
  return {
    runs: pageRows.map((row) => {
      const spec = JSON.parse(row.spec_json);
      return {
        runId: row.run_id,
        state: row.state,
        attempts: row.attempts,
        agent: spec.agent,
        adapter: spec.adapter,
        created_at: row.created_at,
        updated_at: row.updated_at,
        modelTier: spec.modelTier ?? null,
        model: spec.model ?? null,
        idempotencyKey: row.idempotency_key,
      };
    }),
    nextBefore: hasNextPage ? encodeRunCursor(pageRows.at(-1)) : null,
  };
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

function runView(db, runId, { artifactsDir, registry } = {}) {
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
  const spec = JSON.parse(row.spec_json);
  const deadline = latest
    ? attemptDeadline(db, runId, latest.attempt, spec)
    : null;
  return {
    run: {
      runId: row.run_id,
      state: row.state,
      attempts: row.attempts,
      idempotencyKey: row.idempotency_key,
      specHash: row.spec_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      spec,
    },
    subject: registry ? proposalSubject(registry, spec) : null,
    lifecycle: lifecycleOf(db, runId),
    attempts,
    result,
    receipt: resultRow ? JSON.parse(resultRow.receipt_json) : null,
    workspace: latest?.workspace_path ?? null,
    deadlineAt: Number.isFinite(deadline)
      ? new Date(deadline).toISOString()
      : null,
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
  policyRoot = FACTORY_ROOT,
  controlPlane,
  repos: loadReposFn,
}) {
  if (route === "GET /events") {
    return send(200, {
      events: eventsView(db, url.searchParams.get("status")),
    });
  }

  if (route === "GET /proposals") {
    const status = url.searchParams.get("status");
    try {
      const filters = {
        ...listFilters(url, { proposal: true, nowMs }),
        decisionStatus: url.searchParams.get("decisionStatus") ?? undefined,
        registry,
      };
      if (status || filters.population)
        return send(200, {
          proposals: proposalHistory(
            db,
            status === "all" ? null : status,
            filters,
          ),
        });
      return send(200, {
        proposals: openProposals(db, { now: nowMs }).map((row) =>
          proposalView(row, registry),
        ),
      });
    } catch (err) {
      if (err instanceof ListQueryError) return send(422, err.body);
      throw err;
    }
  }

  // One proposal with its `approve.before` audit trail (lib/hooks.mjs,
  // WM-842): every hook decision recorded for it, oldest first. `expired` is
  // computed the way the open list computes it.
  const proposalDetail = url.pathname.match(/^\/proposals\/([^/]+)$/);
  if (req.method === "GET" && proposalDetail) {
    const id = decodeURIComponent(proposalDetail[1]);
    const row = db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
    if (!row) return send(404, { error: `unknown proposal ${id}` });
    const expiresAt =
      Date.parse(row.created_at) + Number(row.ttl_seconds) * 1000;
    return send(200, {
      proposal: proposalView(
        {
          ...row,
          spec: row.spec_json ? JSON.parse(row.spec_json) : null,
          expired:
            row.status === "open" &&
            Number.isFinite(expiresAt) &&
            expiresAt < nowMs,
        },
        registry,
      ),
      hookDecisions: hookDecisionsFor(db, id),
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
          proposal: proposalView(
            { ...outcome.proposal, expired: false },
            registry,
          ),
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

  const ticketDetail = url.pathname.match(/^\/tickets\/([^/]+)\/detail$/);
  if (req.method === "GET" && ticketDetail) {
    const result = await ticketDetailView(decodeURIComponent(ticketDetail[1]), {
      nowMs,
      controlPlane,
    });
    if (result.error === "invalid_ticket") {
      return send(422, { error: "ticket must look like WM-123" });
    }
    if (result.error === "not_found") {
      return send(404, { error: result.message });
    }
    if (result.error === "tracker_unavailable") {
      return send(502, {
        error: "tracker_unavailable",
        message: result.message,
      });
    }
    return send(200, result);
  }

  if (route === "GET /tickets/supply") {
    try {
      const repoRegistry =
        typeof loadReposFn === "function" ? loadReposFn() : loadRepos();
      return send(200, ticketSupplyView(db, { repos: repoRegistry }));
    } catch (err) {
      if (err instanceof RepoError) return send(500, { error: err.message });
      throw err;
    }
  }

  if (route === "GET /tickets") {
    const since = url.searchParams.get("since") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const repo = url.searchParams.get("repo") ?? undefined;
    let limit = 50;
    if (limitParam !== null && limitParam !== undefined && limitParam !== "") {
      const parsedLimit = Number(limitParam);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return send(422, {
          error: "invalid_limit",
          message: "limit must be a positive integer",
        });
      }
      limit = Math.min(parsedLimit, 200);
    }
    try {
      const tickets = ticketIndexView(db, { since, limit, repo, nowMs });
      return send(200, { tickets });
    } catch (err) {
      if (err instanceof ListQueryError) return send(422, err.body);
      throw err;
    }
  }

  if (route === "GET /runs") {
    const ticket = url.searchParams.get("ticket");
    if (ticket) {
      const journey = ticketJourneyView(db, ticket, { artifactsDir });
      if (!journey) return send(422, { error: "ticket must look like WM-123" });
      return send(200, journey);
    }
    try {
      const filters = {
        ...listFilters(url, { nowMs }),
        state: url.searchParams.get("state") ?? undefined,
        agent: url.searchParams.get("agent") ?? undefined,
      };
      return send(200, runsView(db, filters, runPage(url)));
    } catch (err) {
      if (err instanceof ListQueryError) return send(422, err.body);
      throw err;
    }
  }

  const runExtend = url.pathname.match(/^\/runs\/([^/]+)\/extend$/);
  if (req.method === "POST" && runExtend) {
    const runId = decodeURIComponent(runExtend[1]);
    const body = parseJson(await readBody(req)).value ?? {};
    const seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return extensionRefusal(send, 422, "invalid_extension_seconds", {
        message: "seconds must be a positive integer",
      });
    }
    if (seconds > MAX_EXTENSION_SECONDS) {
      return extensionRefusal(send, 422, "extension_too_large", {
        message: `seconds must be <= ${MAX_EXTENSION_SECONDS}`,
        maxSeconds: MAX_EXTENSION_SECONDS,
      });
    }

    const row = db
      .query(
        `SELECT r.state, r.attempts, a.started_at
         FROM runs r
         LEFT JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
        WHERE r.run_id = ?`,
      )
      .get(runId);
    if (!row) return extensionRefusal(send, 404, "unknown_run", { runId });

    const override = body.override === true;
    const maxMinutes = policyMaxRunMinutes(policyRoot);
    if (!override && !Number.isFinite(maxMinutes)) {
      return extensionRefusal(send, 409, "run_limit_policy_unavailable");
    }
    const startedMs = Date.parse(row.started_at ?? "");
    const maxDeadlineMs =
      Number.isFinite(startedMs) && Number.isFinite(maxMinutes)
        ? startedMs + maxMinutes * 60 * 1000
        : null;
    const outcome = extendRunDeadline(db, runId, {
      seconds,
      actor,
      override,
      maxDeadlineMs,
      policyVersion,
      now: nowMs,
    });
    if (outcome.refused) {
      return extensionRefusal(send, outcome.status ?? 409, outcome.code, {
        state: outcome.state,
        adapter: outcome.adapter,
        deadlineAt: outcome.deadlineAt,
        maxDeadlineAt: outcome.maxDeadlineAt,
      });
    }
    return send(200, { extended: true, ...outcome });
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
    const view = runView(db, runGet[1], { artifactsDir, registry });
    if (!view) return send(404, { error: `unknown run ${runGet[1]}` });
    return send(200, view);
  }

  return false;
}

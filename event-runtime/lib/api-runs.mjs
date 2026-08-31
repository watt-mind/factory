/** Event, proposal, run, journal, outbox, and worker-action endpoints. */
import { ControlPlaneError } from "../../lib/control-plane/types.mjs";
import { artifactHead } from "./api-artifacts.mjs";
import { DEFAULT_MAX_IN_FLIGHT, FACTORY_ROOT } from "./config.mjs";
import { STALE_SCAN_MS, loadLinearSupply } from "./linear.mjs";
import { deliveryErrorMessage } from "./outbox.mjs";
import { loadRepos, RepoError } from "./repos.mjs";
import { isBusyError, retryBusy, runUsage } from "./db.mjs";
import { hookDecisionsFor } from "./hooks.mjs";
import {
  IllegalTransition,
  lifecycleOf,
  TERMINAL_STATES,
} from "./lifecycle.mjs";
import { archiveDeadLetteredEvent, requeueEvent } from "./planner.mjs";
import {
  approveProposal,
  isProposalExpired,
  proposalExpiresAt,
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
import { agentFamily, proposalSubject } from "./proposal-subject.mjs";
import {
  ApiParameterError,
  parseListLimit,
  parseNonNegativeSince,
} from "./api-params.mjs";

export const MAX_EXTENSION_SECONDS = 3600;
export const OBSERVED_MODEL_CACHE_LIMIT = 512;
export const RUN_STATE_GROUPS = Object.freeze({
  ACTIVE: Object.freeze(["QUEUED", "LEASED", "RUNNING", "VERIFYING"]),
  FAILED: Object.freeze(["FAILED", "TIMED_OUT", "REFUSED"]),
});

// Transcript artifacts are content-addressed, so a model observed for a hash
// cannot change. Keep this module-local FIFO bounded because run detail views
// poll frequently and artifactHead performs synchronous I/O.
const observedModelCache = new Map();

export function clearObservedModelCache() {
  observedModelCache.clear();
}

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

function proposalHistory(
  db,
  status,
  filters = {},
  page = { limit: Number.MAX_SAFE_INTEGER, before: null },
) {
  const filteredDecision = filters.population === "decision";
  const clauses = [];
  const params = [];
  if (status && !filteredDecision) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (page.before) {
    clauses.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
    params.push(
      page.before.createdAt,
      page.before.createdAt,
      page.before.rowid,
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT *, rowid AS list_rowid FROM proposals ${where}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, page.limit + 1);
  const hasNextPage = rows.length > page.limit;
  const pageRows = hasNextPage ? rows.slice(0, -1) : rows;
  const proposals = pageRows.flatMap((row) => {
    let decisionAt = row.decided_at ?? null;
    let effectiveStatus = row.status;
    const expired =
      row.status === "open" &&
      isProposalExpired(row, filters.nowMs ?? Date.now());
    if (filteredDecision && expired) {
      decisionAt = new Date(proposalExpiresAt(row)).toISOString();
      effectiveStatus = "expired";
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
          expired,
          spec: row.spec_json ? JSON.parse(row.spec_json) : null,
        },
        filters.registry,
      ),
    ];
  });
  const last = pageRows.at(-1);
  return {
    proposals,
    nextBefore: hasNextPage ? encodeListCursor(last) : null,
  };
}

function eventsView(
  db,
  status,
  page = { limit: Number.MAX_SAFE_INTEGER, before: null },
) {
  const sql = `
    SELECT e.*, e.rowid AS list_rowid, p.id AS proposal_id, p.run_id AS run_id
    FROM events e
    LEFT JOIN proposals p ON p.rowid = (
      SELECT p2.rowid FROM proposals p2
      WHERE p2.event_source = e.source AND p2.event_id = e.event_id
      ORDER BY p2.created_at DESC, p2.rowid DESC
      LIMIT 1
    )
    ${status ? "WHERE e.status = ?" : ""}${page.before ? `${status ? " AND" : " WHERE"} (e.admitted_at < ? OR (e.admitted_at = ? AND e.rowid < ?))` : ""}
    ORDER BY e.admitted_at DESC, e.rowid DESC LIMIT ?`;
  const params = status ? [status] : [];
  if (page.before)
    params.push(
      page.before.createdAt,
      page.before.createdAt,
      page.before.rowid,
    );
  const rows = db.query(sql).all(...params, page.limit + 1);
  const hasNextPage = rows.length > page.limit;
  const pageRows = hasNextPage ? rows.slice(0, -1) : rows;
  const events = pageRows.map((row) => {
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
  return {
    events,
    nextBefore: hasNextPage
      ? encodeListCursor(pageRows.at(-1), "admitted_at")
      : null,
  };
}

const LINEAR_TICKET_ID = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const GITHUB_TICKET_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,9}$/;

function normalizeTicketId(value) {
  const ticket = String(value ?? "").trim();
  const linear = ticket.toUpperCase();
  if (LINEAR_TICKET_ID.test(linear)) return linear;
  if (GITHUB_TICKET_ID.test(ticket)) return ticket.toLowerCase();
  return null;
}

function objectNamesTicket(value, ticket) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((entry) => objectNamesTicket(entry, ticket));
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^(ticket|ticketId|issue|issueId|linearId|subject)$/i.test(key) &&
      typeof entry === "string" &&
      normalizeTicketId(entry) === ticket
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
  const ticket = normalizeTicketId(rawTicket);
  if (!ticket) return null;
  const nowMs = options.nowMs ?? Date.now();

  const events = new Set();
  const proposals = new Set();
  const runs = new Set();

  // Keep only the small connected component for this ticket in memory. JSON
  // LIKE is deliberately a broad prefilter for legacy event/proposal/result
  // payloads and direct runs that named their ticket only in a nested input
  // field. Newer runs also carry a normalized, indexed subject.
  const ticketQuery = ticket.toUpperCase();
  const ticketLike = `%${ticketQuery}%`;
  const eventRows = new Map();
  const proposalRows = new Map();
  const runRows = new Map();
  const resultRows = new Map();
  const eventKey = (row) => `${row.source}\0${row.event_id}`;
  const addRows = (rows, into, key) => {
    for (const row of rows) into.set(key(row), row);
  };
  const placeholders = (values) => [...values].map(() => "?").join(", ");
  // Stay well under SQLite's bind-variable cap (999 on older builds) when a
  // ticket's component grows large; each chunk is one bounded query.
  const chunked = (values, size = 400) => {
    const list = [...values];
    const chunks = [];
    for (let i = 0; i < list.length; i += size)
      chunks.push(list.slice(i, i + size));
    return chunks;
  };

  const addEvents = (keys) => {
    const pairs = [...keys]
      .filter((key) => !eventRows.has(key))
      .map((key) => key.split("\0"));
    for (const chunk of chunked(pairs)) {
      const where = chunk
        .map(() => "(source = ? AND event_id = ?)")
        .join(" OR ");
      addRows(
        db
          .query(`SELECT *, rowid AS list_rowid FROM events WHERE ${where}`)
          .all(...chunk.flat()),
        eventRows,
        eventKey,
      );
    }
  };
  const addRuns = (ids) => {
    const missing = [...ids].filter((id) => !runRows.has(id));
    for (const chunk of chunked(missing)) {
      addRows(
        db
          .query(`SELECT * FROM runs WHERE run_id IN (${placeholders(chunk)})`)
          .all(...chunk),
        runRows,
        (row) => row.run_id,
      );
    }
  };
  const addResults = (ids) => {
    const missing = [...ids].filter((id) => !resultRows.has(id));
    for (const chunk of chunked(missing)) {
      addRows(
        db
          .query(
            `SELECT * FROM results WHERE run_id IN (${placeholders(chunk)})`,
          )
          .all(...chunk),
        resultRows,
        (row) => `${row.run_id}\0${row.attempt}`,
      );
    }
  };
  const addProposals = (eventKeys, runIds) => {
    const byKey = (row) => row.id;
    for (const chunk of chunked(eventKeys)) {
      const where = chunk
        .map(() => "(event_source = ? AND event_id = ?)")
        .join(" OR ");
      addRows(
        db
          .query(`SELECT *, rowid AS list_rowid FROM proposals WHERE ${where}`)
          .all(...chunk.flatMap((key) => key.split("\0"))),
        proposalRows,
        byKey,
      );
    }
    for (const chunk of chunked(runIds)) {
      addRows(
        db
          .query(
            `SELECT *, rowid AS list_rowid FROM proposals WHERE run_id IN (${placeholders(chunk)})`,
          )
          .all(...chunk),
        proposalRows,
        byKey,
      );
    }
  };

  addRows(
    db
      .query(
        `SELECT *, rowid AS list_rowid FROM events
         WHERE UPPER(subject) = ? OR UPPER(correlation_id) = ? OR UPPER(envelope_json) LIKE ?`,
      )
      .all(ticketQuery, ticketQuery, ticketLike),
    eventRows,
    eventKey,
  );
  addRows(
    db
      .query(
        `SELECT *, rowid AS list_rowid FROM proposals WHERE UPPER(spec_json) LIKE ?`,
      )
      .all(ticketLike),
    proposalRows,
    (row) => row.id,
  );
  addRows(
    db
      .query(
        `SELECT * FROM runs WHERE UPPER(subject) = ? OR UPPER(spec_json) LIKE ?`,
      )
      .all(ticketQuery, ticketLike),
    runRows,
    (row) => row.run_id,
  );
  addRows(
    db
      .query(`SELECT * FROM results WHERE UPPER(result_json) LIKE ?`)
      .all(ticketLike),
    resultRows,
    (row) => `${row.run_id}\0${row.attempt}`,
  );

  for (const row of eventRows.values()) {
    const envelope = parseObject(row.envelope_json);
    if (
      normalizeTicketId(row.subject) === ticket ||
      normalizeTicketId(row.correlation_id) === ticket ||
      objectNamesTicket(envelope, ticket)
    )
      events.add(eventKey(row));
  }
  for (const row of proposalRows.values()) {
    if (objectNamesTicket(parseObject(row.spec_json).input, ticket))
      proposals.add(row.id);
  }
  for (const row of runRows.values()) {
    if (
      normalizeTicketId(row.subject) === ticket ||
      objectNamesTicket(parseObject(row.spec_json).input, ticket)
    )
      runs.add(row.run_id);
  }
  for (const row of resultRows.values()) {
    if (objectNamesTicket(parseObject(row.result_json), ticket))
      runs.add(row.run_id);
  }

  const closeOverLinks = () => {
    let changed = true;
    while (changed) {
      const before = `${events.size}/${proposals.size}/${runs.size}`;
      addEvents(events);
      addProposals(events, runs);
      addRuns(runs);
      addResults(runs);
      for (const row of proposalRows.values()) {
        const linkedEvent = `${row.event_source}\0${row.event_id}`;
        if (
          proposals.has(row.id) ||
          events.has(linkedEvent) ||
          (row.run_id && runs.has(row.run_id))
        ) {
          proposals.add(row.id);
          events.add(linkedEvent);
          if (row.run_id) runs.add(row.run_id);
        }
      }
      changed = before !== `${events.size}/${proposals.size}/${runs.size}`;
    }
  };
  closeOverLinks();

  const resultByRun = new Map();
  for (const row of resultRows.values()) {
    const result = parseObject(row.result_json);
    if (!resultByRun.has(row.run_id)) resultByRun.set(row.run_id, []);
    resultByRun.get(row.run_id).push(result);
  }

  const prRefs = { numbers: new Set(), urls: new Set() };
  for (const runId of runs) {
    for (const result of resultByRun.get(runId) ?? [])
      collectPrRefs(result, prRefs);
  }
  if (prRefs.numbers.size || prRefs.urls.size) {
    // The prefilters compare UPPER(json), so the patterns must be uppercased
    // too; hasPrRef below still matches the parsed, exact references.
    const prLike = [...prRefs.urls, ...prRefs.numbers].map(
      (reference) => `%${String(reference).toUpperCase()}%`,
    );
    const where = prLike.map(() => "UPPER(spec_json) LIKE ?").join(" OR ");
    addRows(
      db.query(`SELECT * FROM runs WHERE ${where}`).all(...prLike),
      runRows,
      (row) => row.run_id,
    );
    const resultWhere = prLike
      .map(() => "UPPER(result_json) LIKE ?")
      .join(" OR ");
    addRows(
      db.query(`SELECT * FROM results WHERE ${resultWhere}`).all(...prLike),
      resultRows,
      (row) => `${row.run_id}\0${row.attempt}`,
    );
    const eventWhere = prLike
      .map(() => "UPPER(envelope_json) LIKE ?")
      .join(" OR ");
    addRows(
      db
        .query(`SELECT *, rowid AS list_rowid FROM events WHERE ${eventWhere}`)
        .all(...prLike),
      eventRows,
      eventKey,
    );
    for (const row of runRows.values()) {
      if (hasPrRef(parseObject(row.spec_json).input, prRefs))
        runs.add(row.run_id);
    }
    for (const row of resultRows.values()) {
      if (hasPrRef(parseObject(row.result_json), prRefs)) runs.add(row.run_id);
    }
    for (const row of eventRows.values()) {
      if (hasPrRef(parseObject(row.envelope_json), prRefs))
        events.add(eventKey(row));
    }
    closeOverLinks();
  }

  const latestProposalByEvent = new Map();
  for (const row of proposalRows.values()) {
    const key = `${row.event_source}\0${row.event_id}`;
    const current = latestProposalByEvent.get(key);
    if (
      !current ||
      row.created_at > current.created_at ||
      (row.created_at === current.created_at &&
        row.list_rowid > current.list_rowid)
    )
      latestProposalByEvent.set(key, row);
  }
  const matchedEvents = [...eventRows.values()]
    .filter((row) => events.has(eventKey(row)))
    .sort(
      (a, b) =>
        b.admitted_at.localeCompare(a.admitted_at) ||
        b.list_rowid - a.list_rowid,
    )
    .map((row) => {
      const proposal = latestProposalByEvent.get(eventKey(row));
      const envelope = parseObject(row.envelope_json);
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
        proposalId: proposal?.id ?? null,
        runId: proposal?.run_id ?? null,
        envelope,
        repos: repoNamesFromInput(envelope.payload),
      };
    });
  const matchedProposals = [...proposalRows.values()]
    .filter((row) => proposals.has(row.id))
    .sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.list_rowid - a.list_rowid,
    )
    .map((row) => {
      return proposalView({
        ...row,
        expired: row.status === "open" && isProposalExpired(row, nowMs),
        spec: row.spec_json ? JSON.parse(row.spec_json) : null,
      });
    });
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
  const ticket = normalizeTicketId(rawTicket);
  if (!ticket) return { error: "invalid_ticket" };

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
export const RUN_SUBJECT_CACHE_TTL_MS = 30_000;
// A cold cache can face up to RUN_LIST_MAX_LIMIT distinct unresolved tickets
// in a single list request. Resolving all of them inline would fan out one
// tracker read per row, every poll, from every open tab -- exactly the shape
// that has caused two tracker rate-limit incidents. Cap the synchronous
// resolution per request and let the rest fill in on later polls (misses are
// not cached, so they stay eligible next time around).
const RUN_SUBJECT_RESOLVE_MAX_PER_REQUEST = 8;
const RUN_SUBJECT_RESOLVE_CONCURRENCY = 4;

// GET /runs is polled frequently. Resolve each distinct ticket once per short
// window (including misses) so duplicate rows and the detail view never turn a
// browser poll into one tracker request per row.
const runSubjectCache = new Map();

export function clearRunSubjectCache() {
  runSubjectCache.clear();
}

function runSubjectLabel(subject) {
  const ticket = normalizeTicketId(subject);
  if (!ticket)
    return typeof subject === "string" && subject.trim()
      ? subject.trim()
      : null;
  const github = ticket.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  return github ? `${github[2]}#${github[3]}` : ticket;
}

function runSubjectUrl(subject) {
  const ticket = normalizeTicketId(subject);
  if (!ticket) return null;
  const github = ticket.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (github)
    return `https://github.com/${github[1]}/${github[2]}/issues/${github[3]}`;
  return `https://linear.app/watt-mind/issue/${encodeURIComponent(ticket)}`;
}

function runOriginLabel(type) {
  if (typeof type !== "string" || !type.trim()) return null;
  const parts = type.trim().split(".").filter(Boolean);
  if (parts[0] === "factory") parts.shift();
  if (["requested", "request", "tick"].includes(parts.at(-1))) parts.pop();
  return parts.join(" ") || type.trim();
}

function embeddedRunSubjectTitle(spec) {
  const candidates = [
    spec?.approvalPolicy?.dispatchEvidence?.ticket?.title,
    spec?.input?.ticketTitle,
    spec?.input?.issueTitle,
  ];
  return (
    candidates
      .find((value) => typeof value === "string" && value.trim())
      ?.trim() ?? null
  );
}

function runIdentity(row, spec) {
  return {
    agentKind: agentFamily(spec.agent),
    ticketSubject: row.subject ?? null,
    subjectLabel: runSubjectLabel(row.subject),
    subjectTitle: embeddedRunSubjectTitle(spec),
    subjectUrl: runSubjectUrl(row.subject),
    originType: row.event_type ?? null,
    originLabel: runOriginLabel(row.event_type),
  };
}

async function resolveRunSubjects(
  runs,
  { nowMs = Date.now(), controlPlane } = {},
) {
  const unresolved = new Set();
  for (const run of runs) {
    const ticket = normalizeTicketId(run.ticketSubject);
    if (!ticket || run.subjectTitle) continue;
    const cached = runSubjectCache.get(ticket);
    if (cached && nowMs - cached.timestamp < RUN_SUBJECT_CACHE_TTL_MS) {
      Object.assign(run, cached.data);
    } else {
      unresolved.add(ticket);
    }
  }
  if (unresolved.size === 0) return runs;

  let plane;
  try {
    plane = await ticketDetailControlPlane(controlPlane);
  } catch {
    plane = null;
  }

  const toResolve = [...unresolved].slice(
    0,
    RUN_SUBJECT_RESOLVE_MAX_PER_REQUEST,
  );

  async function resolveOne(ticket) {
    let data = { subjectTitle: null, subjectUrl: runSubjectUrl(ticket) };
    try {
      const issue = await plane?.getTicket(ticket);
      data = {
        subjectTitle:
          typeof issue?.title === "string" && issue.title.trim()
            ? issue.title.trim()
            : null,
        subjectUrl:
          typeof issue?.url === "string" && issue.url.trim()
            ? issue.url.trim()
            : runSubjectUrl(ticket),
      };
    } catch {
      // A tracker outage degrades to the bare persisted subject. Cache the
      // miss briefly as well, otherwise every 5s poll retries the outage.
    }
    runSubjectCache.set(ticket, { timestamp: nowMs, data });
  }

  // Chunked loop: at most RUN_SUBJECT_RESOLVE_CONCURRENCY in flight at once,
  // and never more than RUN_SUBJECT_RESOLVE_MAX_PER_REQUEST tickets total for
  // this request. Anything left in `unresolved` beyond the cap is simply not
  // resolved here -- it stays a bare subject until a later poll picks it up.
  for (let i = 0; i < toResolve.length; i += RUN_SUBJECT_RESOLVE_CONCURRENCY) {
    const chunk = toResolve.slice(i, i + RUN_SUBJECT_RESOLVE_CONCURRENCY);
    await Promise.all(chunk.map((ticket) => resolveOne(ticket)));
  }
  for (const run of runs) {
    const ticket = normalizeTicketId(run.ticketSubject);
    const cached = ticket ? runSubjectCache.get(ticket) : null;
    if (cached && !run.subjectTitle) Object.assign(run, cached.data);
  }
  return runs;
}

class ListQueryError extends Error {
  constructor(error, details = {}) {
    super(error);
    this.body = { error, ...details };
  }
}

function encodeListCursor(row, timestampKey = "created_at") {
  return Buffer.from(
    JSON.stringify({
      createdAt: row[timestampKey],
      rowid: row.list_rowid ?? row.rowid,
    }),
  ).toString("base64url");
}

/** Shared WM-976 cursor convention for newest-first table collections. */
function collectionPage(url) {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? RUN_LIST_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_LIST_MAX_LIMIT) {
    throw new ListQueryError("invalid_limit", {
      message: `limit must be an integer between 1 and ${RUN_LIST_MAX_LIMIT}`,
    });
  }
  const rawBefore = url.searchParams.get("before");
  if (!rawBefore) return { limit, before: null };
  try {
    const before = JSON.parse(
      Buffer.from(rawBefore, "base64url").toString("utf8"),
    );
    if (
      !before ||
      typeof before.createdAt !== "string" ||
      !Number.isFinite(Date.parse(before.createdAt)) ||
      !Number.isSafeInteger(before.rowid) ||
      before.rowid < 1
    ) {
      throw new Error("invalid cursor");
    }
    return { limit, before };
  } catch {
    throw new ListQueryError("invalid_before");
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
      for (const match of matches) {
        const ticket = normalizeTicketId(match);
        if (ticket) targetSet.add(ticket);
      }
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
        /^(ticket|ticketId|issue|issueId|linearId|subject)$/i.test(key) &&
        typeof entry === "string" &&
        normalizeTicketId(entry)
      ) {
        targetSet.add(normalizeTicketId(entry));
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

  // The activity window only decides WHICH tickets are candidates: a ticket is
  // listed when any event, proposal, run, or lifecycle row touching it landed in
  // the window. Every JSON-bearing read here is bounded by that window through
  // the indexed `admitted_at` / `created_at` / `at` columns.
  //
  // Once the candidate set is known, each ticket is re-enriched with bounded,
  // indexed lookups (runs by `subject`, proposals by `run_id` and event key,
  // events/runs/results by primary key) so that title, repo, PR, merge state,
  // attempts, and the last decision stay complete even when the ticket's
  // history predates the window.
  const eventRows = db
    .query(
      `SELECT * FROM events WHERE admitted_at >= ? ORDER BY admitted_at, rowid`,
    )
    .all(sinceIso);
  const proposalRows = db
    .query(
      `SELECT * FROM proposals WHERE created_at >= ? ORDER BY created_at, rowid`,
    )
    .all(sinceIso);
  const runRows = db
    .query(
      `SELECT * FROM runs WHERE created_at >= ? ORDER BY created_at, rowid`,
    )
    .all(sinceIso);
  const lifecycleRunIds = db
    .query(
      `SELECT DISTINCT run_id FROM lifecycle_events WHERE at >= ? ORDER BY run_id`,
    )
    .all(sinceIso)
    .map((row) => row.run_id);
  const chunked = (values, size = 400) => {
    const chunks = [];
    for (let i = 0; i < values.length; i += size)
      chunks.push(values.slice(i, i + size));
    return chunks;
  };
  const placeholders = (values) => values.map(() => "?").join(", ");
  const eventKey = (row) => `${row.source}\0${row.event_id}`;
  const runIds = new Set(runRows.map((row) => row.run_id));
  const eventKeys = new Set(eventRows.map(eventKey));
  const proposalIds = new Set(proposalRows.map((row) => row.id));
  const addRuns = (rows) => {
    for (const row of rows) {
      if (runIds.has(row.run_id)) continue;
      runIds.add(row.run_id);
      runRows.push(row);
    }
  };
  const addEvents = (rows) => {
    for (const row of rows) {
      const key = eventKey(row);
      if (eventKeys.has(key)) continue;
      eventKeys.add(key);
      eventRows.push(row);
    }
  };
  const addProposals = (rows) => {
    for (const row of rows) {
      if (proposalIds.has(row.id)) continue;
      proposalIds.add(row.id);
      proposalRows.push(row);
    }
  };
  const fetchRunsById = (ids) => {
    for (const chunk of chunked(ids.filter((id) => !runIds.has(id)))) {
      addRuns(
        db
          .query(`SELECT * FROM runs WHERE run_id IN (${placeholders(chunk)})`)
          .all(...chunk),
      );
    }
  };
  fetchRunsById(lifecycleRunIds);

  // Lifecycle rows are read only inside the window: they can surface a ticket
  // (via reasons) and they carry recent activity, but older transitions never
  // outrank in-window activity and add nothing to the enrichment below.
  const lifecycleRows = [];
  for (const chunk of chunked([...runIds])) {
    lifecycleRows.push(
      ...db
        .query(
          `SELECT * FROM lifecycle_events
           WHERE at >= ? AND run_id IN (${placeholders(chunk)}) ORDER BY rowid`,
        )
        .all(sinceIso, ...chunk),
    );
  }
  const lifecycleByRun = new Map();
  for (const row of lifecycleRows) {
    if (!lifecycleByRun.has(row.run_id)) lifecycleByRun.set(row.run_id, []);
    lifecycleByRun.get(row.run_id).push(row);
  }

  const resultByRun = new Map();
  const fetchResults = () => {
    const missing = [...runIds].filter((id) => !resultByRun.has(id));
    for (const chunk of chunked(missing)) {
      for (const row of db
        .query(
          `SELECT * FROM results WHERE run_id IN (${placeholders(chunk)}) ORDER BY rowid`,
        )
        .all(...chunk)) {
        if (!resultByRun.has(row.run_id)) resultByRun.set(row.run_id, []);
        resultByRun.get(row.run_id).push(parseObject(row.result_json));
      }
      for (const id of chunk) {
        if (!resultByRun.has(id)) resultByRun.set(id, []);
      }
    }
  };
  fetchResults();

  // Collect candidate ticket IDs across all in-window entities
  const allTicketIds = new Set();
  for (const row of eventRows) {
    if (normalizeTicketId(row.subject)) {
      allTicketIds.add(normalizeTicketId(row.subject));
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

  // Enrichment: pull the full history of every candidate ticket through
  // indexed lookups, independent of the window. Subjects are matched by their
  // normalized id plus every raw spelling seen in-window (GitHub refs keep
  // their original case in `runs.subject` / `events.subject`).
  const subjectKeys = new Set(allTicketIds);
  for (const row of [...runRows, ...eventRows]) {
    if (
      typeof row.subject === "string" &&
      allTicketIds.has(normalizeTicketId(row.subject))
    ) {
      subjectKeys.add(row.subject);
    }
  }
  for (const chunk of chunked([...subjectKeys])) {
    addRuns(
      db
        .query(`SELECT * FROM runs WHERE subject IN (${placeholders(chunk)})`)
        .all(...chunk),
    );
    addEvents(
      db
        .query(`SELECT * FROM events WHERE subject IN (${placeholders(chunk)})`)
        .all(...chunk),
    );
  }
  // Close the event ↔ proposal ↔ run graph: proposals by run_id and by event
  // key, then the runs/events those proposals reference, until stable.
  const proposalsByEvent = db.query(
    `SELECT * FROM proposals WHERE event_source = ? AND event_id = ?`,
  );
  const eventsByKey = db.query(
    `SELECT * FROM events WHERE source = ? AND event_id = ?`,
  );
  const seenRunLookups = new Set();
  const seenEventLookups = new Set();
  const seenEventFetches = new Set();
  for (let pass = 0; pass < 8; pass += 1) {
    const before = proposalIds.size + runIds.size + eventKeys.size;
    const newRunIds = [...runIds].filter((id) => !seenRunLookups.has(id));
    for (const chunk of chunked(newRunIds)) {
      addProposals(
        db
          .query(
            `SELECT * FROM proposals WHERE run_id IN (${placeholders(chunk)})`,
          )
          .all(...chunk),
      );
      for (const id of chunk) seenRunLookups.add(id);
    }
    for (const row of eventRows) {
      const key = eventKey(row);
      if (seenEventLookups.has(key)) continue;
      seenEventLookups.add(key);
      addProposals(proposalsByEvent.all(row.source, row.event_id));
    }
    fetchRunsById(
      proposalRows.map((row) => row.run_id).filter((id) => id != null),
    );
    for (const row of proposalRows) {
      const key = `${row.event_source}\0${row.event_id}`;
      if (eventKeys.has(key) || seenEventFetches.has(key)) continue;
      seenEventFetches.add(key);
      addEvents(eventsByKey.all(row.event_source, row.event_id));
    }
    if (proposalIds.size + runIds.size + eventKeys.size === before) break;
  }
  fetchResults();
  eventRows.sort((a, b) => a.admitted_at.localeCompare(b.admitted_at));
  proposalRows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  runRows.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const summaries = [];

  for (const ticket of allTicketIds) {
    const events = new Set();
    const proposals = new Set();
    const runs = new Set();

    for (const row of eventRows) {
      const envelope = parseObject(row.envelope_json);
      if (
        normalizeTicketId(row.subject) === ticket ||
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
      // A run's activity kind is its strongest outcome (merge > pr > run);
      // lifecycle transitions inherit it so a later state change never
      // downgrades a merge/pr activity to a plain "run".
      let runKind = spec.agent?.startsWith("merge-") ? "merge" : "run";
      for (const res of results) {
        const isMerge =
          res?.artifact?.outcome === "MERGED" ||
          spec.agent?.startsWith("merge-");
        const isPr =
          res?.artifact?.outcome === "PR_OPEN" || Boolean(res?.artifact?.prUrl);
        const kind = isMerge ? "merge" : isPr ? "pr" : "run";
        if (kind === "merge" || (kind === "pr" && runKind === "run")) {
          runKind = kind;
        }
        activities.push({
          at: res.accepted_at || r.updated_at || r.created_at,
          kind,
        });
      }
      if (results.length === 0) {
        activities.push({
          at: r.updated_at || r.created_at,
          kind: runKind,
        });
      }
      for (const lifecycle of lifecycleByRun.get(r.run_id) ?? []) {
        activities.push({ at: lifecycle.at, kind: runKind });
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
export function scanTicketSupply(db, options = {}) {
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

/**
 * Overlay a Linear snapshot onto scan figures. Linear counts win when the
 * fetch succeeded; otherwise the scan remains and stale (>1h) scan age is
 * flagged so it is not confused with Linear freshness (WM-824).
 */
export function mergeTicketSupply(scan, linear, { nowMs = Date.now() } = {}) {
  if (linear?.ok) {
    const repos = scan.repos.map((repo) => {
      const live = linear.byRepo?.[repo.name];
      if (!live) {
        return { ...repo, source: repo.asOf ? "scan" : null };
      }
      return {
        ...repo,
        triage: live.triage,
        ready: live.ready,
        inFlight: live.inFlight,
        blocked: live.blocked,
        asOf: linear.asOf,
        sourceRunId: null,
        source: "linear",
      };
    });
    return {
      repos,
      recommendedAction: deriveRecommendedAction(repos),
      source: "linear",
      asOf: linear.asOf ?? null,
      stale: false,
      linearError: null,
      budget: linear.budget ?? null,
      cached: linear.cached === true,
    };
  }

  let newest = null;
  for (const repo of scan.repos ?? []) {
    if (repo.asOf && (!newest || repo.asOf > newest)) newest = repo.asOf;
  }
  const ageMs = newest ? nowMs - Date.parse(newest) : null;
  const stale = Number.isFinite(ageMs) && ageMs > STALE_SCAN_MS;
  return {
    ...scan,
    repos: (scan.repos ?? []).map((repo) => ({
      ...repo,
      source: repo.asOf ? "scan" : null,
    })),
    source: "scan",
    asOf: newest,
    stale,
    linearError: linear?.error ?? "linear_unavailable",
    budget: linear?.budget ?? null,
    cached: false,
  };
}

/**
 * Operator supply for GET /tickets/supply: Linear on demand, scan fallback.
 */
export async function ticketSupplyView(db, options = {}) {
  const scan = scanTicketSupply(db, options);
  const linear = await loadLinearSupply(options.repos ?? loadRepos(), {
    refresh: options.refresh === true,
    nowMs: options.nowMs,
    gql: options.gql,
  });
  return mergeTicketSupply(scan, linear, {
    nowMs: options.nowMs ?? Date.now(),
  });
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
  return collectionPage(url);
}

function stateFilterValues(state) {
  return RUN_STATE_GROUPS[state] ?? [state];
}

function stateFilterClause(column, state) {
  return `${column} IN (${stateFilterValues(state)
    .map(() => "?")
    .join(", ")})`;
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
      clauses.push(stateFilterClause("r.state", state));
      params.push(...stateFilterValues(state));
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
          ${state ? `AND ${stateFilterClause("metric_event.to_state", state)}` : ""}
      )`,
    );
    params.push(from, to, ...(state ? stateFilterValues(state) : []));
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
              a.started_at, a.lease_expires_at, p.event_id, p.event_source,
              e.type AS event_type
       FROM runs r
       LEFT JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       LEFT JOIN proposals p ON p.rowid = (
         SELECT p2.rowid FROM proposals p2
         WHERE p2.run_id = r.run_id AND p2.decision = 'run'
         ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1
       )
       LEFT JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
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
        ...runIdentity(row, spec),
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
      `SELECT seq, event_json, created_at, published_at, delivery_attempts, delivery_error
       FROM outbox ORDER BY seq DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => {
      let event;
      try {
        event = JSON.parse(row.event_json);
      } catch {
        // Parse-poison rows are intentionally retained for inspection. Keep
        // one malformed row from making the entire outbox endpoint fail.
        event = { raw: row.event_json };
      }
      return {
        seq: row.seq,
        event,
        created_at: row.created_at,
        published_at: row.published_at,
        deliveryAttempts: row.delivery_attempts,
        deliveryError: deliveryErrorMessage(row.delivery_error),
        parked: row.published_at !== null && row.delivery_error !== null,
      };
    });
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

function observedModelForRun({
  artifactsDir,
  sha256,
  state,
  readArtifactHead = artifactHead,
}) {
  if (!artifactsDir || !sha256) return null;
  const terminal = TERMINAL_STATES.has(state);
  // Keyed by store root as well as hash: a test or a relocated store must not
  // serve an observation read from a different artifacts directory.
  const cacheKey = `${artifactsDir} ${sha256}`;
  if (observedModelCache.has(cacheKey)) return observedModelCache.get(cacheKey);

  const observedModel = observedModelFromTranscript(
    readArtifactHead(artifactsDir, sha256),
  );
  // A growing transcript may gain its model line later, but a terminal one
  // cannot. Cache null only for terminal runs while caching all model values.
  if (observedModel !== null || terminal) {
    if (observedModelCache.size >= OBSERVED_MODEL_CACHE_LIMIT) {
      observedModelCache.delete(observedModelCache.keys().next().value);
    }
    observedModelCache.set(cacheKey, observedModel);
  }
  return observedModel;
}

function runView(
  db,
  runId,
  { artifactsDir, registry, readArtifactHead = artifactHead } = {},
) {
  const row = db
    .query(
      `SELECT r.*,
              (SELECT e.type
               FROM proposals p
               JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
               WHERE p.run_id = r.run_id AND p.decision = 'run'
               ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1) AS event_type
       FROM runs r WHERE r.run_id = ?`,
    )
    .get(runId);
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
    identity: runIdentity(row, spec),
    lifecycle: lifecycleOf(db, runId),
    attempts,
    result,
    receipt: resultRow ? JSON.parse(resultRow.receipt_json) : null,
    workspace: latest?.workspace_path ?? null,
    deadlineAt: Number.isFinite(deadline)
      ? new Date(deadline).toISOString()
      : null,
    observedModel: observedModelForRun({
      artifactsDir,
      sha256: transcript?.sha256,
      state: row.state,
      readArtifactHead,
    }),
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
  readArtifactHead = artifactHead,
  onEvent,
  policyRoot = FACTORY_ROOT,
  controlPlane,
  repos: loadReposFn,
}) {
  if (route === "GET /events") {
    try {
      return send(
        200,
        eventsView(db, url.searchParams.get("status"), collectionPage(url)),
      );
    } catch (err) {
      if (err instanceof ListQueryError) return send(422, err.body);
      throw err;
    }
  }

  if (route === "GET /proposals") {
    const status = url.searchParams.get("status");
    try {
      const filters = {
        ...listFilters(url, { proposal: true, nowMs }),
        decisionStatus: url.searchParams.get("decisionStatus") ?? undefined,
        registry,
      };
      const page = collectionPage(url);
      return send(
        200,
        proposalHistory(
          db,
          status === "all" ? null : (status ?? "open"),
          filters,
          page,
        ),
      );
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
    return send(200, {
      proposal: proposalView(
        {
          ...row,
          spec: row.spec_json ? JSON.parse(row.spec_json) : null,
          expired: row.status === "open" && isProposalExpired(row, nowMs),
        },
        registry,
      ),
      hookDecisions: hookDecisionsFor(db, id),
    });
  }

  if (route === "GET /journal") {
    try {
      return send(
        200,
        journalView(
          db,
          parseNonNegativeSince(url),
          parseListLimit(url, { defaultLimit: 100, maxLimit: 500 }),
        ),
      );
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      throw err;
    }
  }

  if (route === "GET /outbox") {
    try {
      const limit = parseListLimit(url, { defaultLimit: 50, maxLimit: 500 });
      return send(200, { outbox: outboxView(db, limit) });
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      throw err;
    }
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
        const outcome = await retryBusy(db, () =>
          approveProposal(db, registry, id, {
            actor,
            now: nowMs,
            policyVersion,
          }),
        );
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
      const outcome = await retryBusy(db, () =>
        rejectProposal(db, id, {
          actor,
          reason: body.reason,
          now: nowMs,
          policyVersion,
        }),
      );
      return send(200, { rejected: true, runId: outcome.runId });
    } catch (err) {
      if (isBusyError(err))
        return send(503, { error: "db_busy", retryable: true });
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
      return send(422, {
        error: "ticket must look like WM-123 or owner/repo#123",
      });
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
      const refresh = url.searchParams.get("refresh") === "1";
      return send(
        200,
        await ticketSupplyView(db, {
          repos: repoRegistry,
          refresh,
          nowMs,
        }),
      );
    } catch (err) {
      if (err instanceof RepoError) return send(500, { error: err.message });
      throw err;
    }
  }

  if (route === "GET /tickets") {
    const since = url.searchParams.get("since") ?? undefined;
    const repo = url.searchParams.get("repo") ?? undefined;
    try {
      const limit = parseListLimit(url, { defaultLimit: 50, maxLimit: 200 });
      const tickets = ticketIndexView(db, { since, limit, repo, nowMs });
      return send(200, { tickets });
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      if (err instanceof ListQueryError) return send(422, err.body);
      throw err;
    }
  }

  if (route === "GET /runs") {
    const ticket = url.searchParams.get("ticket");
    if (ticket) {
      const journey = ticketJourneyView(db, ticket, { artifactsDir });
      if (!journey)
        return send(422, {
          error: "ticket must look like WM-123 or owner/repo#123",
        });
      return send(200, journey);
    }
    try {
      const filters = {
        ...listFilters(url, { nowMs }),
        state: url.searchParams.get("state") ?? undefined,
        agent: url.searchParams.get("agent") ?? undefined,
      };
      const view = runsView(db, filters, runPage(url));
      await resolveRunSubjects(view.runs, { nowMs });
      return send(200, view);
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
    try {
      return send(
        200,
        traceOf(db, runId, {
          since: parseNonNegativeSince(url),
          limit: parseListLimit(url, { defaultLimit: 100, maxLimit: 500 }),
        }),
      );
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      throw err;
    }
  }

  const runGet = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (req.method === "GET" && runGet) {
    const view = runView(db, runGet[1], {
      artifactsDir,
      registry,
      readArtifactHead,
    });
    if (!view) return send(404, { error: `unknown run ${runGet[1]}` });
    await resolveRunSubjects([view.identity], { nowMs });
    return send(200, view);
  }

  return false;
}

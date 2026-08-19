/**
 * Durable human inbox ledger (WM-285).
 *
 * An inbox row is written before its Telegram projection is attempted. The
 * ledger therefore remains authoritative even when the transport is absent or
 * broken, while notify_log continues to provide runtime-notification dedup.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  decisionRequestHash,
  validateDecisionRequest,
  validateDecisionResponse,
} from "./decision.mjs";
import { applyDecisionEffect } from "./decision-effects.mjs";
import {
  replannedProposalContext,
  templateFor,
} from "./decision-templates.mjs";
import { txImmediate } from "./db.mjs";
import { registerInboxDecisionMemos } from "./memos.mjs";

export const INBOX_KINDS = Object.freeze([
  "BLOCKED",
  "ESCALATED",
  "CI RED",
  "SMOKE RED",
  "CIRCUIT BREAKER",
  "RC READY",
  "human_needed",
  "decision_needed",
  "proposal_expired",
]);

const KIND_SET = new Set(INBOX_KINDS);
const STATUSES = new Set(["open", "acked", "resolved", "all"]);
const REF_KEYS = new Set([
  "runId",
  "proposalId",
  "eventSource",
  "eventId",
  "issue",
  "pr",
  "repo",
]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function normalizeRefs(refs) {
  if (refs === undefined || refs === null) return {};
  if (typeof refs !== "object" || Array.isArray(refs))
    throw new Error("refs must be an object");
  const normalized = {};
  for (const [key, value] of Object.entries(refs)) {
    if (!REF_KEYS.has(key)) throw new Error(`unknown inbox ref ${key}`);
    if (value === undefined || value === null) continue;
    normalized[key] = requiredString(value, `refs.${key}`);
  }
  return normalized;
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseNullableObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export class InboxDecisionError extends Error {
  constructor(code, message, status = 400, errors = undefined) {
    super(message);
    this.name = "InboxDecisionError";
    this.code = code;
    this.status = status;
    if (errors) this.errors = errors;
  }
}

export function itemView(row) {
  if (!row) return null;
  // Answers that were archived rather than kept (retargets, §6) ride in
  // delivery_json: the v6 ledger has no column for them, and that blob already
  // carries WM-390's supersededDecisions counter. Lift them out so the view
  // reads as a ledger field and `delivery` stays about the projection.
  const { responseHistory, ...delivery } = parseObject(row.delivery_json);
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body ?? null,
    refs: parseObject(row.refs_json),
    source: row.source,
    createdAt: row.created_at,
    ackedAt: row.acked_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    resolvedReason: row.resolved_reason ?? null,
    delivery: parseObject(row.delivery_json),
    decision: parseNullableObject(row.decision_json),
    response: parseNullableObject(row.response_json),
    responseHistory: Array.isArray(responseHistory) ? responseHistory : [],
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    dedupeKey: row.dedupe_key ?? null,
  };
}

export function getInboxItem(db, id) {
  return itemView(db.query("SELECT * FROM inbox_items WHERE id = ?").get(id));
}

function supersedeInboxDecision(db, row, { body, refs, decision }) {
  const updated = db
    .query(
      `UPDATE inbox_items
     SET decision_json = ?, response_json = NULL, decided_at = NULL,
         decided_by = NULL, body = ?,
         refs_json = CASE WHEN ? IS NULL THEN refs_json ELSE json_set(
           CASE WHEN json_valid(refs_json) THEN refs_json ELSE '{}' END,
           '$.runId', ?
         ) END,
         delivery_json = json_set(
           CASE WHEN json_valid(delivery_json) THEN delivery_json ELSE '{}' END,
           '$.supersededDecisions',
           COALESCE(json_extract(
             CASE WHEN json_valid(delivery_json) THEN delivery_json ELSE '{}' END,
             '$.supersededDecisions'
           ), 0) + 1
         )
     WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(
      decision === null ? null : JSON.stringify(decision),
      body,
      refs.runId ?? null,
      refs.runId ?? null,
      row.id,
    );
  if (updated.changes !== 1) return null;
  return getInboxItem(db, row.id);
}

export function createInboxItem(
  db,
  input,
  { id = `inbox_${randomUUID()}`, now = Date.now() } = {},
) {
  const kind = requiredString(input?.kind, "kind");
  if (!KIND_SET.has(kind)) throw new Error(`unknown inbox kind: ${kind}`);
  const title = requiredString(input?.title, "title");
  const body = optionalString(input?.body, "body");
  const severity = optionalString(input?.severity, "severity") ?? "normal";
  const source = optionalString(input?.source, "source") ?? "cli";
  if (
    source !== "cli" &&
    source !== "serve:notify" &&
    !/^agent:.+/.test(source)
  ) {
    throw new Error(`unknown inbox source: ${source}`);
  }
  const refs = normalizeRefs(input?.refs);
  const decision = input?.decision ?? null;
  if (decision !== null) {
    const checked = validateDecisionRequest(decision, { refs });
    if (!checked.valid) {
      throw new InboxDecisionError(
        "invalid_decision",
        `invalid decision request: ${checked.errors.join("; ")}`,
        400,
        checked.errors,
      );
    }
  }
  const dedupeKey = optionalString(input?.dedupeKey, "dedupeKey");
  const createdAt = new Date(now).toISOString();

  if (dedupeKey) {
    const existing = db
      .query(
        `SELECT * FROM inbox_items
       WHERE dedupe_key = ? AND resolved_at IS NULL
       LIMIT 1`,
      )
      .get(dedupeKey);
    if (existing) {
      const superseded = supersedeInboxDecision(db, existing, {
        body,
        refs,
        decision,
      });
      if (superseded) return superseded;
    }
  }

  let insertError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      db.query(
        `INSERT INTO inbox_items
           (id, kind, severity, title, body, refs_json, source, created_at,
            delivery_json, decision_json, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      ).run(
        id,
        kind,
        severity,
        title,
        body,
        JSON.stringify(refs),
        source,
        createdAt,
        decision === null ? null : JSON.stringify(decision),
        dedupeKey,
      );
      return getInboxItem(db, id);
    } catch (err) {
      insertError = err;
      // A second connection can win the partial-unique-index race after the
      // lookup above. In that case the collision has the same semantics as an
      // item that was already present; unrelated insert failures still escape.
      const winner = dedupeKey
        ? db
            .query(
              `SELECT * FROM inbox_items
           WHERE dedupe_key = ? AND resolved_at IS NULL
           LIMIT 1`,
            )
            .get(dedupeKey)
        : null;
      if (!winner) break;
      const superseded = supersedeInboxDecision(db, winner, {
        body,
        refs,
        decision,
      });
      if (superseded) return superseded;
      // The winner resolved between the read and update, releasing the
      // partial unique key. Retry the insert once as a new ledger item.
    }
  }
  throw insertError;
}

function decisionRow(db, id) {
  const row = db.query("SELECT * FROM inbox_items WHERE id = ?").get(id);
  if (!row) {
    throw new InboxDecisionError("not_found", `unknown inbox item ${id}`, 404);
  }
  return row;
}

/** WM-391: the approve found the proposal expired and re-planned it instead. */
const REPLANNED_DETAIL = "replanned_awaiting_approval";

/**
 * Move the WM-390 v5 dedupe key (`<kind>:<primary ref>`) onto the fresh
 * proposal, so the next producer for it supersedes this item instead of
 * stacking a second one. A key that is not the proposal formula is left alone
 * rather than guessed at.
 */
function retargetedDedupeKey(db, row, previousProposalId, proposalId) {
  const current = row.dedupe_key ?? null;
  const suffix = previousProposalId ? `:${previousProposalId}` : null;
  if (!current || !suffix || !current.endsWith(suffix)) return current;
  const next = `${current.slice(0, -suffix.length)}:${proposalId}`;
  // inbox_items_open_dedupe is unique across open rows. Taking a key another
  // open item already holds would abort the transaction and lose the answer,
  // so leave ours behind and let that item own the fresh proposal.
  const taken = db
    .query(
      `SELECT id FROM inbox_items
     WHERE dedupe_key = ? AND resolved_at IS NULL AND id <> ?
     LIMIT 1`,
    )
    .get(next, row.id);
  return taken ? current : next;
}

/**
 * Point a decided item at the proposal a re-plan opened, and re-open it.
 *
 * One statement moves refs, the fresh request, the dedupe key, and the
 * archived answer together while clearing `decided_at`/`decided_by`, so no
 * reader sees the item half-retargeted — pointing at the superseded proposal
 * with the new request installed, or decided against a question nobody asked.
 */
function retargetInboxDecision(db, id, answer, proposalId, { now }) {
  const row = decisionRow(db, id);
  const refs = parseObject(row.refs_json);
  const previousProposalId = refs.proposalId ?? null;
  const nextRefs = { ...refs, proposalId };
  const request = templateFor(row.kind, {
    producer: "proposal",
    refs: nextRefs,
    context: replannedProposalContext(previousProposalId, proposalId),
  });
  const checked = validateDecisionRequest(request, { refs: nextRefs });
  if (!checked.valid) {
    // Fail closed. Rolling the whole decision back leaves the operator on the
    // original, answerable request; installing this would leave them holding
    // an item nobody can decide.
    throw new InboxDecisionError(
      "retarget_failed",
      `inbox item ${id} could not be retargeted to ${proposalId}: ${checked.errors.join("; ")}`,
      500,
      checked.errors,
    );
  }

  const { responseHistory, ...delivery } = parseObject(row.delivery_json);
  const history = Array.isArray(responseHistory) ? responseHistory : [];
  db.query(
    `UPDATE inbox_items
     SET refs_json = ?, decision_json = ?, dedupe_key = ?, delivery_json = ?,
         response_json = NULL, decided_at = NULL, decided_by = NULL
     WHERE id = ?`,
  ).run(
    JSON.stringify(nextRefs),
    JSON.stringify(request),
    retargetedDedupeKey(db, row, previousProposalId, proposalId),
    JSON.stringify({
      ...delivery,
      responseHistory: [
        ...history,
        {
          retargetedFrom: previousProposalId,
          retargetedTo: proposalId,
          retargetedAt: new Date(now).toISOString(),
          response: answer,
        },
      ],
    }),
    id,
  );
  return getInboxItem(db, id);
}

/**
 * Record the effect outcome on the answer and settle the item.
 *
 * An `approve_proposal` on an expired proposal re-plans rather than approves
 * (WM-391), so the operator bought a fresh undecided proposal, not a decision.
 * Resolving on that `applied` outcome dropped the approve and left the new
 * proposal with no inbox item (WM-714); retarget the row instead.
 */
function settleInboxDecision(
  db,
  id,
  response,
  effect,
  { now, recordedEffect = effect, artifactStore },
) {
  const answer = { ...response, effect: recordedEffect };
  const replanned =
    effect.outcome === "applied" && effect.detail === REPLANNED_DETAIL;
  if (
    replanned &&
    typeof effect.newProposalId === "string" &&
    effect.newProposalId.trim() !== ""
  ) {
    return {
      item: retargetInboxDecision(db, id, answer, effect.newProposalId, {
        now,
      }),
      effect,
    };
  }
  db.query("UPDATE inbox_items SET response_json = ? WHERE id = ?").run(
    JSON.stringify(answer),
    id,
  );
  // A re-plan with no fresh id is a broken effect — WM-391 throws on it rather
  // than returning one. Leave the item open and retryable instead of resolving
  // on a detail the ledger cannot act on.
  if (effect.outcome === "applied" && !replanned) {
    db.query(
      `UPDATE inbox_items
       SET resolved_at = COALESCE(resolved_at, ?),
           resolved_by = COALESCE(resolved_by, ?)
       WHERE id = ?`,
    ).run(new Date(now).toISOString(), `operator:${effect.kind}`, id);
  }
  const item = getInboxItem(db, id);
  let memos = [];
  if (effect.outcome === "applied" && !replanned) {
    memos = registerInboxDecisionMemos(db, item, response, {
      now,
      artifactStore,
      descriptionHash: effect.descriptionHash,
    });
  }
  return { item, effect, memos };
}

function normalizeEffect(effect, item, response) {
  const kind =
    item.decision.options.find((option) => option.id === response.optionId)
      ?.effect ?? "unknown";
  if (!effect || typeof effect !== "object" || Array.isArray(effect)) {
    return {
      kind,
      outcome: "failed",
      error: "decision effect returned no outcome",
    };
  }
  return { ...effect, kind };
}

/** Validate, record, and apply one response to a stored decision request. */
function decideInboxItemInTransaction(
  db,
  id,
  response,
  {
    now = Date.now(),
    decidedBy = "operator",
    applyEffect = applyDecisionEffect,
    artifactStore,
  } = {},
) {
  const row = decisionRow(db, id);
  const decision = parseNullableObject(row.decision_json);
  if (!decision) {
    throw new InboxDecisionError(
      "decision_missing",
      `inbox item ${id} has no decision request`,
      400,
    );
  }
  if (row.response_json || row.decided_at) {
    throw new InboxDecisionError(
      "already_decided",
      `inbox item ${id} is already decided`,
      409,
    );
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new InboxDecisionError(
      "invalid_response",
      "response must be an object",
      400,
    );
  }
  const expectedHash = decisionRequestHash(decision);
  if (
    typeof response.requestHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(response.requestHash) &&
    response.requestHash !== expectedHash
  ) {
    throw new InboxDecisionError(
      "stale_request",
      `inbox item ${id} decision request has changed`,
      409,
    );
  }

  const decidedAt = new Date(now).toISOString();
  const storedResponse = {
    ...response,
    decidedBy,
    decidedAt,
  };
  const checked = validateDecisionResponse(storedResponse, decision);
  if (!checked.valid) {
    throw new InboxDecisionError(
      "invalid_response",
      `invalid decision response: ${checked.errors.join("; ")}`,
      400,
      checked.errors,
    );
  }

  // Persist the answer before invoking the seam. A throwing effect must not
  // lose what the operator entered; retry uses this exact stored response.
  const recorded = db
    .query(
      `UPDATE inbox_items
     SET response_json = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND response_json IS NULL AND decided_at IS NULL`,
    )
    .run(JSON.stringify(storedResponse), decidedAt, decidedBy, id);
  if (recorded.changes !== 1) {
    throw new InboxDecisionError(
      "already_decided",
      `inbox item ${id} is already decided`,
      409,
    );
  }

  const item = getInboxItem(db, id);
  let effect;
  try {
    effect = normalizeEffect(
      applyEffect(db, item, storedResponse),
      item,
      storedResponse,
    );
  } catch (err) {
    effect = normalizeEffect(
      { outcome: "failed", error: err?.message ?? String(err) },
      item,
      storedResponse,
    );
  }
  return settleInboxDecision(db, id, storedResponse, effect, {
    now,
    artifactStore,
  });
}

export function decideInboxItem(db, id, response, options = {}) {
  // Serialize request claim, effect application, and finalization against
  // concurrent answers and dedupe supersession on other connections.
  return txImmediate(db, () =>
    decideInboxItemInTransaction(db, id, response, options),
  );
}

/** Retry the effect for an answer that was already recorded. */
function retryInboxDecisionInTransaction(
  db,
  id,
  {
    now = Date.now(),
    applyEffect = applyDecisionEffect,
    expectedResponseJson,
    artifactStore,
  } = {},
) {
  const row = decisionRow(db, id);
  if (row.response_json !== expectedResponseJson) {
    throw new InboxDecisionError(
      "retry_superseded",
      `inbox item ${id} decision retry was superseded`,
      409,
    );
  }
  const decision = parseNullableObject(row.decision_json);
  const recorded = parseNullableObject(row.response_json);
  if (!decision || !recorded || !row.decided_at) {
    throw new InboxDecisionError(
      "not_decided",
      `inbox item ${id} has not been decided`,
      409,
    );
  }
  if (row.resolved_at || recorded.effect?.outcome === "applied") {
    throw new InboxDecisionError(
      "already_applied",
      `inbox item ${id} decision effect is already applied`,
      409,
    );
  }
  const retryAttempt = Number(recorded.effect?.retryAttempt ?? 0) + 1;
  const { effect: _priorEffect, ...response } = recorded;
  const item = getInboxItem(db, id);
  let effect;
  try {
    effect = normalizeEffect(applyEffect(db, item, response), item, response);
  } catch (err) {
    effect = normalizeEffect(
      { outcome: "failed", error: err?.message ?? String(err) },
      item,
      response,
    );
  }
  return settleInboxDecision(db, id, response, effect, {
    now,
    recordedEffect: { ...effect, retryAttempt },
    artifactStore,
  });
}

export function retryInboxDecision(db, id, options = {}) {
  // Capture the exact failed outcome before waiting for the write lock. A
  // concurrent retry increments retryAttempt, so a waiter cannot replay the
  // same effect after that first retry commits; a later deliberate retry can.
  const expectedResponseJson =
    db.query("SELECT response_json FROM inbox_items WHERE id = ?").get(id)
      ?.response_json ?? null;
  // The same lock prevents two operators from retrying one effect at once.
  return txImmediate(db, () =>
    retryInboxDecisionInTransaction(db, id, {
      ...options,
      expectedResponseJson,
    }),
  );
}

export function listInboxItems(db, { status = "open" } = {}) {
  if (!STATUSES.has(status)) throw new Error(`unknown inbox status: ${status}`);
  const where = {
    open: "resolved_at IS NULL AND acked_at IS NULL",
    acked: "resolved_at IS NULL AND acked_at IS NOT NULL",
    resolved: "resolved_at IS NOT NULL",
    all: "1 = 1",
  }[status];
  return db
    .query(
      `SELECT * FROM inbox_items WHERE ${where} ORDER BY created_at DESC, rowid DESC`,
    )
    .all()
    .map(itemView);
}

export function ackInboxItem(db, id, { now = Date.now() } = {}) {
  const row = db
    .query("SELECT resolved_at FROM inbox_items WHERE id = ?")
    .get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  if (row.resolved_at) throw new Error(`inbox item ${id} is already resolved`);
  db.query(
    "UPDATE inbox_items SET acked_at = COALESCE(acked_at, ?) WHERE id = ?",
  ).run(new Date(now).toISOString(), id);
  return getInboxItem(db, id);
}

export function resolveInboxItem(
  db,
  id,
  { now = Date.now(), resolvedBy = "operator", reason } = {},
) {
  requiredString(resolvedBy, "resolvedBy");
  const resolvedReason = optionalString(reason, "reason");
  if (
    resolvedBy !== "operator" &&
    !resolvedBy.startsWith("auto:") &&
    !resolvedBy.startsWith("operator:")
  ) {
    throw new Error(`invalid inbox resolver: ${resolvedBy}`);
  }
  const row = db
    .query(
      "SELECT id, decision_json, response_json FROM inbox_items WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  const resolvedAt = new Date(now).toISOString();
  if (row.decision_json && !row.response_json) {
    if (!resolvedBy.startsWith("auto:")) {
      const err = new Error(`inbox item ${id} has a pending decision`);
      err.code = "decision_pending";
      throw err;
    }
    // The runtime observed the referent leave its waiting state, so the ask is
    // moot. Record a superseded response so a late operator answer is refused
    // as already_decided instead of applying an effect nobody wants any more.
    db.query(
      `UPDATE inbox_items
       SET response_json = ?, decided_at = ?, decided_by = ?
       WHERE id = ? AND response_json IS NULL AND decided_at IS NULL`,
    ).run(
      JSON.stringify({
        superseded: true,
        reason: resolvedBy,
        decidedBy: resolvedBy,
        decidedAt: resolvedAt,
      }),
      resolvedAt,
      resolvedBy,
      id,
    );
  }
  db.query(
    `UPDATE inbox_items
     SET resolved_at = COALESCE(resolved_at, ?),
         resolved_by = COALESCE(resolved_by, ?),
         resolved_reason = COALESCE(resolved_reason, ?)
     WHERE id = ?`,
  ).run(resolvedAt, resolvedBy, resolvedReason, id);
  return getInboxItem(db, id);
}

export function inboxCounts(db) {
  const totals = db
    .query(
      `SELECT
       SUM(CASE WHEN resolved_at IS NULL AND acked_at IS NULL THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN resolved_at IS NULL AND acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked
     FROM inbox_items`,
    )
    .get();
  const byKind = {};
  for (const row of db
    .query(
      `SELECT kind, COUNT(*) AS n FROM inbox_items
     WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind`,
    )
    .all()) {
    byKind[row.kind] = row.n;
  }
  return {
    open: Number(totals.open ?? 0),
    acked: Number(totals.acked ?? 0),
    byKind,
  };
}

/** Attach an ad-hoc schedule's watched proposal to the open item that spawned it. */
export function bindInboxProposal(db, { kind, repo, proposalId }) {
  requiredString(kind, "kind");
  requiredString(repo, "repo");
  requiredString(proposalId, "proposalId");
  const row = db
    .query(
      `SELECT id FROM inbox_items
       WHERE kind = ? AND resolved_at IS NULL
         AND json_extract(refs_json, '$.repo') = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(kind, repo);
  if (!row) return null;
  return bindProposalToItem(db, row.id, proposalId);
}

function bindProposalToItem(db, id, proposalId) {
  db.query(
    `UPDATE inbox_items
     SET refs_json = json_set(
       CASE WHEN json_valid(refs_json) THEN refs_json ELSE '{}' END,
       '$.proposalId', ?
     )
     WHERE id = ? AND resolved_at IS NULL`,
  ).run(proposalId, id);
  return getInboxItem(db, id);
}

function correlatedProposal(db, inboxItemId) {
  return (
    db
      .query(
        `SELECT p.id FROM events e
         JOIN proposals p
           ON p.event_source = e.source AND p.event_id = e.event_id
         WHERE e.correlation_id = ?
         ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`,
      )
      .get(inboxItemId)?.id ?? null
  );
}

function telegramMessage(item, webUrl) {
  const lines = [item.title];
  if (item.body) lines.push(item.body);
  if (item.decision) {
    lines.push(item.decision.question);
    item.decision.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option.label}`);
    });
  }
  const content = lines.join("\n");
  if (!webUrl) return content;
  return `${content}\n${String(webUrl).replace(/\/$/, "")}/#/inbox/${encodeURIComponent(item.id)}`;
}

/** Attempt the Telegram projection and persist its outcome on the existing row. */
export async function deliverInboxItem(
  db,
  id,
  {
    command,
    send,
    webUrl = process.env.FACTORY_WEB_URL,
    now = Date.now(),
  } = {},
) {
  const item = getInboxItem(db, id);
  if (!item) throw new Error(`unknown inbox item ${id}`);
  if (typeof send !== "function")
    throw new Error("inbox delivery transport is required");
  let outcome;
  try {
    outcome = await send(command, telegramMessage(item, webUrl));
  } catch (err) {
    outcome = { ok: false, exitCode: null, error: err.message };
  }
  // Read the stored blob rather than the view: the view lifts responseHistory
  // out of it, and writing the view back would drop the archived answers.
  const stored = parseObject(
    db.query("SELECT delivery_json FROM inbox_items WHERE id = ?").get(id)
      ?.delivery_json,
  );
  const delivery = {
    ...stored,
    telegram: {
      sent_at: new Date(now).toISOString(),
      exit_code: outcome.exitCode ?? null,
      error: outcome.error ?? null,
    },
  };
  db.query("UPDATE inbox_items SET delivery_json = ? WHERE id = ?").run(
    JSON.stringify(delivery),
    id,
  );
  return {
    ok: outcome.ok === true,
    exitCode: outcome.exitCode ?? null,
    error: outcome.error ?? null,
    item: getInboxItem(db, id),
  };
}

const LINEAR_POLL_INTERVAL_MS = 60_000;
const linearPollAt = new WeakMap();

function prNumber(ref) {
  if (typeof ref !== "string") return null;
  const match =
    /^(?:PR\s*)?#?(\d+)$/i.exec(ref.trim()) ??
    /\/pull\/(\d+)(?:[/?#]|$)/.exec(ref);
  return match ? Number(match[1]) : null;
}

function completedShipProposal(db, proposalId) {
  return Boolean(
    db
      .query(
        `SELECT 1 FROM proposals p
         JOIN runs r ON r.run_id = p.run_id
         WHERE p.id = ? AND r.state = 'COMPLETED'`,
      )
      .get(proposalId),
  );
}

function laterCiSuccess(db, row, refs) {
  const pr = prNumber(refs.pr);
  if (!refs.repo || !pr) return false;
  const events = db
    .query(
      `SELECT subject, envelope_json FROM events
       WHERE source = 'github'
         AND type = 'factory.merge.requested'
         AND admitted_at > ?
       ORDER BY admitted_at, rowid`,
    )
    .all(row.created_at);
  return events.some((event) => {
    const envelope = parseObject(event.envelope_json);
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return false;
    const repo = payload.repo ?? event.subject;
    return (
      repo === refs.repo &&
      Array.isArray(payload.prNumbers) &&
      payload.prNumbers.some((number) => Number(number) === pr)
    );
  });
}

const LINEAR_API_URL = "https://api.linear.app/graphql";

function resolveLinearApiKey({
  env = process.env,
  envFile = path.join(homedir(), "Develop", "hdkiller", ".env"),
} = {}) {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  if (!existsSync(envFile)) return null;

  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
        continue;
      const idx = trimmed.indexOf("=");
      if (trimmed.slice(0, idx).trim() !== "LINEAR_API_KEY") continue;
      const value = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (!value) return null;
      env.LINEAR_API_KEY = value;
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

export async function linearGql(query, variables = {}) {
  const apiKey = resolveLinearApiKey();
  if (!apiKey) {
    throw new Error(
      "Linear API error: LINEAR_API_KEY not found in env or ~/Develop/hdkiller/.env",
    );
  }
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status}: ${res.statusText}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(
      `Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return body.data;
}

/** One bounded GraphQL request for the distinct Linear referents in this poll. */
export async function fetchLinearInboxIssues(
  issueIds,
  { request = linearGql } = {},
) {
  if (!Array.isArray(issueIds) || issueIds.length === 0) return [];
  const declarations = issueIds.map((_, index) => `$i${index}:String!`);
  const fields = issueIds.map(
    (_, index) =>
      `i${index}: issue(id:$i${index}) { identifier state { name type } labels { nodes { name } } }`,
  );
  const variables = Object.fromEntries(
    issueIds.map((issue, index) => [`i${index}`, issue]),
  );
  const data = await request(
    `query(${declarations.join(",")}) { ${fields.join("\n")} }`,
    variables,
  );
  return issueIds
    .map((issue, index) => data?.[`i${index}`] ?? null)
    .filter(Boolean);
}

function linearIssueResolved(row, issue, db) {
  const state = issue?.state?.name;
  if (typeof state !== "string" || state === "") return false;
  if (row.kind === "BLOCKED") return state !== "Blocked";
  if (row.kind === "ESCALATED") {
    const delivery = parseObject(row.delivery_json);
    const labels = (issue?.labels?.nodes ?? []).map((label) => label.name);
    const hasEscalatedLabel = labels.includes("ai:escalated");
    if (hasEscalatedLabel && !delivery.seenEscalated) {
      delivery.seenEscalated = true;
      if (db) {
        db.query("UPDATE inbox_items SET delivery_json = ? WHERE id = ?").run(
          JSON.stringify(delivery),
          row.id,
        );
        row.delivery_json = JSON.stringify(delivery);
      }
    }
    return (
      Boolean(delivery.seenEscalated) &&
      (issue?.state?.type === "completed" || !hasEscalatedLabel)
    );
  }
  return false;
}

/** Resolve asks when their runtime-owned or externally polled referent moves on. */
export function reconcileInbox(
  db,
  { now = Date.now(), linearIssues = fetchLinearInboxIssues } = {},
) {
  const resolved = [];
  const rows = db
    .query(
      `SELECT id, kind, refs_json, decision_json, response_json, delivery_json, created_at FROM inbox_items
     WHERE resolved_at IS NULL
       AND kind IN (
         'decision_needed', 'proposal_expired', 'human_needed', 'BLOCKED',
         'ESCALATED', 'CI RED', 'RC READY'
       )
     ORDER BY created_at, rowid`,
    )
    .all();
  const linearRows = [];
  for (const row of rows) {
    // Pending decisions are not skipped: once the referent stops waiting the
    // ask is moot and resolveInboxItem records it as superseded (auto:*).
    const refs = parseObject(row.refs_json);
    let resolvedBy = null;
    if (row.kind === "decision_needed" || row.kind === "proposal_expired") {
      if (!refs.proposalId) continue;
      const proposal = db
        .query("SELECT status FROM proposals WHERE id = ?")
        .get(refs.proposalId);
      if (proposal && proposal.status !== "open")
        resolvedBy = "auto:proposal_decided";
    } else if (row.kind === "CI RED") {
      if (!refs.proposalId) {
        const proposalId = correlatedProposal(db, row.id);
        if (proposalId) {
          bindProposalToItem(db, row.id, proposalId);
          refs.proposalId = proposalId;
        }
      }
      if (laterCiSuccess(db, row, refs)) resolvedBy = "auto:ci_green";
    } else if (row.kind === "RC READY") {
      if (refs.proposalId && completedShipProposal(db, refs.proposalId))
        resolvedBy = "auto:ship_completed";
    } else if (refs.eventSource && refs.eventId) {
      const event = db
        .query("SELECT status FROM events WHERE source = ? AND event_id = ?")
        .get(refs.eventSource, refs.eventId);
      if (event && event.status !== "human_needed")
        resolvedBy = "auto:event_requeued";
    } else if (
      (row.kind === "BLOCKED" || row.kind === "ESCALATED") &&
      refs.issue
    ) {
      linearRows.push({ row, refs });
    }
    if (!resolvedBy) continue;
    resolveInboxItem(db, row.id, { now, resolvedBy });
    resolved.push({ id: row.id, resolvedBy });
  }

  if (linearRows.length === 0) return resolved;
  const lastPoll = linearPollAt.get(db) ?? -Infinity;
  if (now - lastPoll < LINEAR_POLL_INTERVAL_MS) return resolved;
  linearPollAt.set(db, now);
  const issueIds = [...new Set(linearRows.map(({ refs }) => refs.issue))];
  return Promise.resolve(linearIssues(issueIds))
    .then((issues) => {
      const byId = new Map(issues.map((issue) => [issue.identifier, issue]));
      for (const { row, refs } of linearRows) {
        const issue = byId.get(refs.issue);
        if (!issue || !linearIssueResolved(row, issue, db)) continue;
        const resolvedBy =
          row.kind === "BLOCKED"
            ? "auto:linear_unblocked"
            : "auto:linear_escalation_cleared";
        resolveInboxItem(db, row.id, { now, resolvedBy });
        resolved.push({ id: row.id, resolvedBy });
      }
      return resolved;
    })
    .catch(() => resolved);
}

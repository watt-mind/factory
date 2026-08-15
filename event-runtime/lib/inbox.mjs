/**
 * Durable human inbox ledger (WM-285).
 *
 * An inbox row is written before its Telegram projection is attempted. The
 * ledger therefore remains authoritative even when the transport is absent or
 * broken, while notify_log continues to provide runtime-notification dedup.
 */
import { randomUUID } from "node:crypto";

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
  if (typeof refs !== "object" || Array.isArray(refs)) throw new Error("refs must be an object");
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function itemView(row) {
  if (!row) return null;
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
    delivery: parseObject(row.delivery_json),
  };
}

export function getInboxItem(db, id) {
  return itemView(db.query("SELECT * FROM inbox_items WHERE id = ?").get(id));
}

export function createInboxItem(db, input, {
  id = `inbox_${randomUUID()}`,
  now = Date.now(),
} = {}) {
  const kind = requiredString(input?.kind, "kind");
  if (!KIND_SET.has(kind)) throw new Error(`unknown inbox kind: ${kind}`);
  const title = requiredString(input?.title, "title");
  const body = optionalString(input?.body, "body");
  const severity = optionalString(input?.severity, "severity") ?? "normal";
  const source = optionalString(input?.source, "source") ?? "cli";
  if (source !== "cli" && source !== "serve:notify" && !/^agent:.+/.test(source)) {
    throw new Error(`unknown inbox source: ${source}`);
  }
  const refs = normalizeRefs(input?.refs);
  const createdAt = new Date(now).toISOString();

  db.query(
    `INSERT INTO inbox_items
       (id, kind, severity, title, body, refs_json, source, created_at, delivery_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(id, kind, severity, title, body, JSON.stringify(refs), source, createdAt);
  return getInboxItem(db, id);
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
    .query(`SELECT * FROM inbox_items WHERE ${where} ORDER BY created_at DESC, rowid DESC`)
    .all()
    .map(itemView);
}

export function ackInboxItem(db, id, { now = Date.now() } = {}) {
  const row = db.query("SELECT resolved_at FROM inbox_items WHERE id = ?").get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  if (row.resolved_at) throw new Error(`inbox item ${id} is already resolved`);
  db.query("UPDATE inbox_items SET acked_at = COALESCE(acked_at, ?) WHERE id = ?")
    .run(new Date(now).toISOString(), id);
  return getInboxItem(db, id);
}

export function resolveInboxItem(db, id, {
  now = Date.now(),
  resolvedBy = "operator",
} = {}) {
  requiredString(resolvedBy, "resolvedBy");
  if (resolvedBy !== "operator" && !resolvedBy.startsWith("auto:")) {
    throw new Error(`invalid inbox resolver: ${resolvedBy}`);
  }
  const row = db.query("SELECT id FROM inbox_items WHERE id = ?").get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  db.query(
    `UPDATE inbox_items
     SET resolved_at = COALESCE(resolved_at, ?), resolved_by = COALESCE(resolved_by, ?)
     WHERE id = ?`,
  ).run(new Date(now).toISOString(), resolvedBy, id);
  return getInboxItem(db, id);
}

export function inboxCounts(db) {
  const totals = db.query(
    `SELECT
       SUM(CASE WHEN resolved_at IS NULL AND acked_at IS NULL THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN resolved_at IS NULL AND acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked
     FROM inbox_items`,
  ).get();
  const byKind = {};
  for (const row of db.query(
    `SELECT kind, COUNT(*) AS n FROM inbox_items
     WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind`,
  ).all()) {
    byKind[row.kind] = row.n;
  }
  return { open: Number(totals.open ?? 0), acked: Number(totals.acked ?? 0), byKind };
}

function telegramMessage(item, webUrl) {
  const content = item.body ? `${item.title}\n${item.body}` : item.title;
  if (!webUrl) return content;
  return `${content}\n${String(webUrl).replace(/\/$/, "")}/#/inbox/${encodeURIComponent(item.id)}`;
}

/** Attempt the Telegram projection and persist its outcome on the existing row. */
export async function deliverInboxItem(db, id, {
  command,
  send,
  webUrl = process.env.FACTORY_WEB_URL,
  now = Date.now(),
} = {}) {
  const item = getInboxItem(db, id);
  if (!item) throw new Error(`unknown inbox item ${id}`);
  if (typeof send !== "function") throw new Error("inbox delivery transport is required");
  let outcome;
  try {
    outcome = await send(command, telegramMessage(item, webUrl));
  } catch (err) {
    outcome = { ok: false, exitCode: null, error: err.message };
  }
  const delivery = {
    ...item.delivery,
    telegram: {
      sent_at: new Date(now).toISOString(),
      exit_code: outcome.exitCode ?? null,
      error: outcome.error ?? null,
    },
  };
  db.query("UPDATE inbox_items SET delivery_json = ? WHERE id = ?")
    .run(JSON.stringify(delivery), id);
  return {
    ok: outcome.ok === true,
    exitCode: outcome.exitCode ?? null,
    error: outcome.error ?? null,
    item: getInboxItem(db, id),
  };
}

/** Resolve runtime-owned asks when their authoritative referent stops waiting. */
export function reconcileInbox(db, { now = Date.now() } = {}) {
  const resolved = [];
  const rows = db.query(
    `SELECT id, kind, refs_json FROM inbox_items
     WHERE resolved_at IS NULL
       AND kind IN ('decision_needed', 'proposal_expired', 'human_needed')
     ORDER BY created_at, rowid`,
  ).all();
  for (const row of rows) {
    const refs = parseObject(row.refs_json);
    let resolvedBy = null;
    if (row.kind === "decision_needed" || row.kind === "proposal_expired") {
      if (!refs.proposalId) continue;
      const proposal = db.query("SELECT status FROM proposals WHERE id = ?").get(refs.proposalId);
      if (proposal && proposal.status !== "open") resolvedBy = "auto:proposal_decided";
    } else if (refs.eventSource && refs.eventId) {
      const event = db.query("SELECT status FROM events WHERE source = ? AND event_id = ?")
        .get(refs.eventSource, refs.eventId);
      if (event && event.status !== "human_needed") resolvedBy = "auto:event_requeued";
    }
    if (!resolvedBy) continue;
    resolveInboxItem(db, row.id, { now, resolvedBy });
    resolved.push({ id: row.id, resolvedBy });
  }
  return resolved;
}

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
import { loadControlPlane } from "../../lib/control-plane/index.mjs";
import { makeGhApi } from "../../lib/control-plane/github.mjs";
import { hashJson } from "./canonical.mjs";
import { ApiParameterError } from "./api-params.mjs";
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
import { loadRepos } from "./repos.mjs";

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

function parseWaiters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (waiter) =>
        waiter && typeof waiter === "object" && !Array.isArray(waiter),
    );
  } catch {
    return [];
  }
}

const INBOX_REASON_GLOSSARY = Object.freeze({
  owned_paths_not_closed:
    "The ticket's allowed paths do not cover every required file, so the change cannot be safely completed as scoped.",
  needs_human:
    "The runtime stopped because an operator decision is required before it can proceed.",
  ticket_untrusted_author:
    "The ticket author is not trusted by this repository's dispatch policy.",
  proposal_expired:
    "The proposal expired before an operator approved or rejected it.",
  proposal_terminal:
    "The proposal is no longer open, so the requested decision would have no effect.",
  stale_ref:
    "The referenced ticket, run, or proposal is already terminal, so this item no longer needs action.",
});

const INBOX_KIND_LABELS = Object.freeze({
  BLOCKED: "Blocked",
  ESCALATED: "Escalated",
  "CI RED": "CI failed",
  "SMOKE RED": "Smoke check failed",
  "CIRCUIT BREAKER": "Circuit breaker",
  "RC READY": "Release candidate ready",
  human_needed: "Human action needed",
  decision_needed: "Decision needed",
  proposal_expired: "Proposal expired",
});

const DECISION_EFFECTS = Object.freeze({
  authorise: "authorizes the scoped work and dispatches a new run",
  send_to_triage: "removes ai:agent-ready so a human can re-scope the ticket",
  answer: "records the operator's reply for the agent",
  requeue: "puts the parked event back into planning",
  approve_proposal: "approves the proposal and allows its run to proceed",
  reject_proposal: "rejects the proposal and stops that requested run",
  dismiss: "keeps the item resolved without changing the referenced work",
});

function readableSubject(refs, ticketTitle, eventType) {
  if (refs.issue) {
    const match = /(?:^|\/)([^/\s#]+)#(\d+)$/.exec(refs.issue);
    if (match) {
      const ticket = `${match[1]}#${match[2]}`;
      return ticketTitle ? `${ticket} "${ticketTitle}"` : ticket;
    }
    return ticketTitle ? `${refs.issue} "${ticketTitle}"` : refs.issue;
  }
  if (refs.pr) return `PR ${refs.pr.replace(/^PR\s*/i, "")}`;
  if (refs.proposalId) return `proposal ${refs.proposalId}`;
  if (refs.runId) return `run ${refs.runId}`;
  // Parked-event notices carry only their event coordinates. Name the event
  // rather than degrading to "this item"; the repo qualifies it when known.
  if (refs.eventId) {
    const named = eventType
      ? `${eventType} ${refs.eventId}`
      : `event ${refs.eventId}`;
    return refs.repo ? `${named} (${refs.repo})` : named;
  }
  if (refs.repo) return refs.repo;
  return "this item";
}

/**
 * Reason codes are structured input, never scraped out of a producer's title:
 * a machine title is prose, and guessing a code from it invents facts (an
 * English word or a ticket slug rendered as if it were a runtime reason).
 * Producers that know their reason pass `reasonCode`; the rest render none.
 */
function reasonCodeFor(input) {
  if (typeof input?.reasonCode === "string" && input.reasonCode.trim())
    return input.reasonCode.trim();
  if (input?.kind === "proposal_expired") return "proposal_expired";
  return null;
}

function humanReason(reason) {
  if (!reason) return "The runtime needs an operator to review what happened.";
  return (
    INBOX_REASON_GLOSSARY[reason] ??
    `The runtime reported “${reason.replaceAll("_", " ")}” and needs an operator to decide what happens next.`
  );
}

function titleReason(reason) {
  if (reason === "owned_paths_not_closed")
    return "its allowed paths do not cover every required file";
  return humanReason(reason)
    .replace(/^The runtime /, "")
    .replace(/\.$/, "");
}

function linksFor(refs) {
  const links = [];
  if (refs.issue) links.push(`Ticket: ${refs.issue}`);
  if (refs.runId) links.push(`Run: ${refs.runId}`);
  if (refs.pr) links.push(`PR: ${refs.pr}`);
  if (refs.proposalId) links.push(`Proposal: ${refs.proposalId}`);
  return links;
}

function proposalSubject(decision) {
  const question = decision?.question;
  const match =
    typeof question === "string"
      ? /^Run\s+([^\s]+)(?:\s+for\s+(.+?))?\?$/i.exec(question.trim())
      : null;
  if (!match) return null;
  return {
    agent: match[1].replace(/@\d+$/, ""),
    subject: match[2]?.trim() ?? null,
  };
}

function optionEffect(option) {
  return (
    DECISION_EFFECTS[option.effect] ??
    `asks the runtime to ${String(option.effect ?? "continue").replaceAll("_", " ")}`
  );
}

/**
 * The durable body restates the ask and what each option does. The Telegram
 * push renders that request itself (question plus numbered options), so it
 * strips exactly these paragraphs back out and the operator reads it once.
 */
function decisionParagraphs(decision) {
  const effects = Array.isArray(decision?.options)
    ? decision.options.map(
        (option) => `${option.label} — ${optionEffect(option)}.`,
      )
    : [];
  return [
    typeof decision?.question === "string" && decision.question.trim()
      ? `Question: ${decision.question.trim()}`
      : null,
    typeof decision?.context === "string" && decision.context.trim()
      ? `Context: ${decision.context.trim()}`
      : null,
    effects.length ? `Option effects:\n${effects.join("\n")}` : null,
  ].filter(Boolean);
}

/**
 * Convert producer-oriented inbox data into an operator-readable message.
 * Producers retain their concise machine title as an input signal, while the
 * persisted title/body explain what happened, why it matters, and where the
 * operator can inspect the referenced work.
 */
export function synthesizeInboxItem(input) {
  const refs = input?.refs ?? {};
  const kind = input?.kind ?? "human_needed";
  const reason = reasonCodeFor(input);
  const label = INBOX_KIND_LABELS[kind] ?? String(kind).replaceAll("_", " ");
  const ticketTitle =
    typeof input?.ticketTitle === "string" && input.ticketTitle.trim()
      ? input.ticketTitle.trim()
      : null;
  const eventType =
    typeof input?.eventType === "string" && input.eventType.trim()
      ? input.eventType.trim()
      : null;
  const subject = readableSubject(refs, ticketTitle, eventType);
  const why = humanReason(reason);
  const originalBody =
    typeof input?.body === "string" && input.body.trim()
      ? input.body.trim()
      : null;
  const decision = input?.decision;
  const proposal = proposalSubject(decision);
  // Keep the serialized request untouched. It is hashed by decision responses,
  // so rewriting its context after a producer has handed it off would make a
  // valid response look stale. The durable body carries the same information.
  const body = [
    `What happened: An item needs attention for ${subject} (${label.toLowerCase()}).`,
    `Why it matters: ${why}`,
    reason ? `Reason code: ${reason}.` : null,
    linksFor(refs).length ? `Links:\n${linksFor(refs).join("\n")}` : null,
    ...decisionParagraphs(decision),
    originalBody,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...input,
    title:
      proposal && (kind === "decision_needed" || kind === "proposal_expired")
        ? `Approve ${proposal.agent} run (${ticketTitle ? subject : (proposal.subject ?? subject)})?`
        : reason
          ? `${label}: ${subject} — ${titleReason(reason)}`
          : `${label}: ${subject}`,
    body,
  };
}

/** Option id+effect (+ authorise paths); free text is not part of "same question". */
function decisionShape(decision) {
  if (!decision || !Array.isArray(decision.options)) return null;
  return decision.options.map((option) => ({
    id: option.id,
    effect: option.effect,
    ...(Array.isArray(option.scope?.paths)
      ? { paths: [...option.scope.paths].sort() }
      : {}),
  }));
}

function hasDedupSubject(refs) {
  return Boolean(
    refs.issue || refs.pr || refs.repo || refs.proposalId || refs.eventId,
  );
}

/**
 * Identity of "the same question" (WM-813 / memos §7): kind + subject refs
 * +, for a decision request, the option/effect shape. proposalId and the
 * event pair are included when present so two proposals (or two parked
 * events) in one repo do not share a waiter list.
 */
export function inboxDedupKey(kind, refs = {}, decision = null) {
  const subject = {
    kind,
    issue: refs.issue ?? null,
    pr: refs.pr ?? null,
    repo: refs.repo ?? null,
  };
  if (refs.proposalId) subject.proposalId = refs.proposalId;
  if (refs.eventSource || refs.eventId) {
    subject.eventSource = refs.eventSource ?? null;
    subject.eventId = refs.eventId ?? null;
  }
  if (decision) subject.shape = decisionShape(decision);
  return hashJson(subject);
}

function computedKeyOfRow(row) {
  return inboxDedupKey(
    row.kind,
    parseObject(row.refs_json),
    parseNullableObject(row.decision_json),
  );
}

function findOpenMatch(db, { callerKey, computedKey }) {
  if (callerKey) {
    const keyed = db
      .query(
        `SELECT * FROM inbox_items
       WHERE dedupe_key = ? AND resolved_at IS NULL
       LIMIT 1`,
      )
      .get(callerKey);
    if (keyed) return keyed;
  }
  if (!computedKey) return null;
  const rows = db
    .query(`SELECT * FROM inbox_items WHERE resolved_at IS NULL`)
    .all();
  return rows.find((row) => computedKeyOfRow(row) === computedKey) ?? null;
}

function rowIsUndecided(row) {
  return !row.response_json && !row.decided_at;
}

function attachWaiter(db, row, { refs, now }) {
  const runId = refs.runId ?? null;
  const owner = parseObject(row.refs_json);
  const waiters = parseWaiters(row.waiters_json);
  if (
    runId &&
    (runId === owner.runId || waiters.some((waiter) => waiter.runId === runId))
  ) {
    return { ...getInboxItem(db, row.id), attached: true };
  }
  const waiter = { at: new Date(now).toISOString() };
  if (runId) waiter.runId = runId;
  const extra = {};
  for (const key of ["proposalId", "eventSource", "eventId"]) {
    if (refs[key] && refs[key] !== owner[key]) extra[key] = refs[key];
  }
  if (Object.keys(extra).length) waiter.refs = extra;
  waiters.push(waiter);
  db.query(`UPDATE inbox_items SET waiters_json = ? WHERE id = ?`).run(
    JSON.stringify(waiters),
    row.id,
  );
  return { ...getInboxItem(db, row.id), attached: true };
}

function waiterReferentKey(effectKind, refs) {
  switch (effectKind) {
    case "dismiss":
      return "dismiss";
    case "authorise":
    case "send_to_triage":
    case "answer":
      return `issue:${refs.issue ?? ""}`;
    case "requeue":
      return `event:${refs.eventSource ?? ""}:${refs.eventId ?? ""}`;
    case "approve_proposal":
    case "reject_proposal":
      return `proposal:${refs.proposalId ?? ""}`;
    default:
      return `run:${refs.runId ?? ""}`;
  }
}

async function fanOutWaiterEffects(db, item, response, waiters, applyEffect) {
  const option = item.decision?.options?.find(
    (candidate) => candidate.id === response?.optionId,
  );
  const effectKind = option?.effect ?? "unknown";
  const seen = new Set([waiterReferentKey(effectKind, item.refs)]);
  const outcomes = [];
  const nextWaiters = waiters.map((waiter) => ({ ...waiter }));
  for (const waiter of nextWaiters) {
    const refs = {
      ...item.refs,
      ...(waiter.refs ?? {}),
      ...(waiter.runId ? { runId: waiter.runId } : {}),
    };
    const referent = waiterReferentKey(effectKind, refs);
    if (seen.has(referent)) {
      const effect = {
        kind: effectKind,
        outcome: "applied",
        detail: "shared_referent",
      };
      waiter.effect = effect;
      outcomes.push({ runId: waiter.runId ?? null, effect });
      continue;
    }
    seen.add(referent);
    const waiterItem = { ...item, refs };
    let effect;
    try {
      effect = normalizeEffect(
        await applyEffect(db, waiterItem, response),
        waiterItem,
        response,
      );
    } catch (err) {
      effect = normalizeEffect(
        { outcome: "failed", error: err?.message ?? String(err) },
        waiterItem,
        response,
      );
    }
    waiter.effect = effect;
    outcomes.push({ runId: waiter.runId ?? null, effect });
  }
  // `waiters` was read in the claim transaction and the effects above awaited
  // outside the lock. `attachWaiter` only appends, and only to undecided rows
  // (this item has been decided since the claim), so nothing should have
  // changed; re-read anyway and keep any entry appended after the snapshot.
  txImmediate(db, () => {
    const current = parseWaiters(
      db.query(`SELECT waiters_json FROM inbox_items WHERE id = ?`).get(item.id)
        ?.waiters_json,
    );
    db.query(`UPDATE inbox_items SET waiters_json = ? WHERE id = ?`).run(
      JSON.stringify([...nextWaiters, ...current.slice(nextWaiters.length)]),
      item.id,
    );
  });
  return outcomes;
}

/**
 * How long a `pending` effect claim may stay unsettled before `/decide/retry`
 * may take it over. The claim is held while the effect runs outside the write
 * lock; the CLI transport gives up after 20 s
 * (`decision-effects.mjs:applyDecisionEffect`), so a claim older than this
 * belongs to a serve that died mid-effect, not to a slow effect still in
 * flight. Keep it comfortably above the transport timeout so a late settle
 * cannot race a takeover.
 */
export const PENDING_EFFECT_CLAIM_TIMEOUT_MS = 60_000;

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
    expired: row.expired === 1,
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
    waiters: parseWaiters(row.waiters_json),
    waitingCount: 1 + parseWaiters(row.waiters_json).length,
  };
}

/** Shared by inbox projections and the open-count query. */
function inboxExpiredPredicate(item = "i") {
  return `(${item}.kind = 'proposal_expired' OR EXISTS (
    SELECT 1 FROM proposals p
     WHERE p.id = ${item}.proposal_id
       AND p.status = 'open'
       AND p.decision = 'run'
       AND p.ttl_seconds > 0
       AND unixepoch(p.created_at) + p.ttl_seconds <= unixepoch()
  ))`;
}

export function getInboxItem(db, id) {
  return itemView(
    db
      .query(
        `SELECT i.*, ${inboxExpiredPredicate("i")} AS expired
         FROM inbox_items i WHERE i.id = ?`,
      )
      .get(id),
  );
}

function supersedeInboxDecision(db, row, { title, body, refs, decision }) {
  const updated = db
    .query(
      `UPDATE inbox_items
     SET decision_json = ?, response_json = NULL, decided_at = NULL,
         decided_by = NULL, body = ?, title = ?,
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
      title,
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
  // Runtime notifications and agent-produced items begin as machine-oriented
  // events. Synthesize their durable presentation here so producers do not
  // need to duplicate this policy before the item reaches the operator.
  const presentation =
    source === "serve:notify" || source.startsWith("agent:")
      ? synthesizeInboxItem({ ...input, kind, refs, source })
      : input;
  const title = requiredString(presentation?.title, "title");
  const body = optionalString(presentation?.body, "body");
  const decision = presentation?.decision ?? null;
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
  const callerKey = optionalString(input?.dedupeKey, "dedupeKey");
  const computedKey = hasDedupSubject(refs)
    ? inboxDedupKey(kind, refs, decision)
    : null;
  const dedupeKey = callerKey ?? computedKey;
  const createdAt = new Date(now).toISOString();

  const existing = findOpenMatch(db, { callerKey, computedKey });
  if (existing) {
    const sameQuestion =
      Boolean(computedKey) && computedKeyOfRow(existing) === computedKey;
    if (sameQuestion && rowIsUndecided(existing)) {
      return attachWaiter(db, existing, { refs, now });
    }
    if (existing.dedupe_key && existing.dedupe_key === callerKey) {
      const superseded = supersedeInboxDecision(db, existing, {
        title,
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
            proposal_id, delivery_json, decision_json, dedupe_key, waiters_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, '[]')`,
      ).run(
        id,
        kind,
        severity,
        title,
        body,
        JSON.stringify(refs),
        source,
        createdAt,
        refs.proposalId ?? null,
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
      const sameQuestion =
        Boolean(computedKey) && computedKeyOfRow(winner) === computedKey;
      if (sameQuestion && rowIsUndecided(winner)) {
        return attachWaiter(db, winner, { refs, now });
      }
      const superseded = supersedeInboxDecision(db, winner, {
        title,
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
 * One statement moves refs, the fresh request, the dedupe key, the list
 * title, and the archived answer together while clearing `decided_at`/
 * `decided_by`, so no reader sees the item half-retargeted — pointing at the
 * superseded proposal with the new request installed, or decided against a
 * question nobody asked.
 */
function retargetInboxDecision(
  db,
  id,
  answer,
  proposalId,
  { now, claimEffect },
) {
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
  const nextTitle =
    previousProposalId && row.title.includes(previousProposalId)
      ? row.title.split(previousProposalId).join(proposalId)
      : row.title;
  const retargeted = db
    .query(
      `UPDATE inbox_items
     SET refs_json = ?, proposal_id = ?, decision_json = ?, dedupe_key = ?, delivery_json = ?,
         title = ?,
         response_json = NULL, decided_at = NULL, decided_by = NULL
     WHERE id = ?
       AND json_extract(response_json, '$.effect.claimedAt') = ?
       AND json_extract(response_json, '$.effect.retryAttempt') = ?`,
    )
    .run(
      JSON.stringify(nextRefs),
      proposalId,
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
      nextTitle,
      id,
      claimEffect.claimedAt,
      claimEffect.retryAttempt,
    );
  return retargeted.changes === 1 ? getInboxItem(db, id) : null;
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
  { now, claimEffect, recordedEffect = effect, artifactStore },
) {
  const replanned =
    effect.outcome === "applied" && effect.detail === REPLANNED_DETAIL;
  const newProposalId =
    typeof effect.newProposalId === "string" &&
    effect.newProposalId.trim() !== ""
      ? effect.newProposalId
      : null;
  // A re-plan with no fresh id is a broken effect — WM-391 throws on it rather
  // than returning one. Coerce to failed before recording so retry sees a
  // failed outcome instead of already_applied (WM-783).
  if (replanned && !newProposalId) {
    const error =
      recordedEffect.error ??
      "replanned_awaiting_approval without newProposalId";
    effect = { ...effect, outcome: "failed", error };
    recordedEffect = { ...recordedEffect, outcome: "failed", error };
  }
  const answer = { ...response, effect: recordedEffect };
  if (replanned && newProposalId) {
    const item = retargetInboxDecision(db, id, answer, newProposalId, {
      now,
      claimEffect,
    });
    if (!item) return lostInboxDecisionClaim(db, id, effect);
    return {
      item,
      effect,
    };
  }
  const resolves = effect.outcome === "applied" && !replanned;
  const settled = db
    .query(
      `UPDATE inbox_items
       SET response_json = ?${
         resolves
           ? `,
           resolved_at = COALESCE(resolved_at, ?),
           resolved_by = COALESCE(resolved_by, ?)`
           : ""
       }
       WHERE id = ?
         AND json_extract(response_json, '$.effect.claimedAt') = ?
         AND json_extract(response_json, '$.effect.retryAttempt') = ?`,
    )
    .run(
      JSON.stringify(answer),
      ...(resolves
        ? [new Date(now).toISOString(), `operator:${effect.kind}`]
        : []),
      id,
      claimEffect.claimedAt,
      claimEffect.retryAttempt,
    );
  if (settled.changes !== 1) return lostInboxDecisionClaim(db, id, effect);
  const item = getInboxItem(db, id);
  let memos = [];
  if (resolves) {
    memos = registerInboxDecisionMemos(db, item, response, {
      now,
      artifactStore,
      descriptionHash: effect.descriptionHash,
    });
  }
  return { item, effect, memos };
}

/** A late owner must not overwrite the newer claim's settlement. */
function lostInboxDecisionClaim(db, id, effect) {
  return {
    item: getInboxItem(db, id),
    effect: { ...effect, outcome: "claim_lost" },
    claimLost: true,
    memos: [],
  };
}

/** The effect record held while the effect runs outside the write lock. */
function pendingEffect(decision, response, { retryAttempt, claimedAt }) {
  const kind =
    decision?.options?.find((option) => option.id === response.optionId)
      ?.effect ?? "unknown";
  return { kind, outcome: "pending", retryAttempt, claimedAt };
}

/** Age of a pending claim in ms; a claim with no readable stamp counts as stale. */
function pendingClaimAge(effect, now) {
  const claimedAt = Date.parse(effect?.claimedAt ?? "");
  return Number.isFinite(claimedAt) ? now - claimedAt : Infinity;
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

/** Validate and claim one response in a short write transaction. */
function decideInboxItemInTransaction(
  db,
  id,
  response,
  { now = Date.now(), decidedBy = "operator" } = {},
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
  // The effect runs after this transaction commits, so stamp the claim as
  // `pending` with its start time: if serve dies before settling, a retry can
  // take the claim over once it is older than PENDING_EFFECT_CLAIM_TIMEOUT_MS.
  const pendingResponse = {
    ...storedResponse,
    effect: pendingEffect(decision, storedResponse, {
      retryAttempt: 0,
      claimedAt: decidedAt,
    }),
  };
  const recorded = db
    .query(
      `UPDATE inbox_items
     SET response_json = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND response_json IS NULL AND decided_at IS NULL`,
    )
    .run(JSON.stringify(pendingResponse), decidedAt, decidedBy, id);
  if (recorded.changes !== 1) {
    throw new InboxDecisionError(
      "already_decided",
      `inbox item ${id} is already decided`,
      409,
    );
  }

  return {
    item: getInboxItem(db, id),
    response: storedResponse,
    waiters: parseWaiters(row.waiters_json),
  };
}

async function applyInboxEffect(db, item, response, applyEffect) {
  let effect;
  try {
    effect = normalizeEffect(
      await applyEffect(db, item, response),
      item,
      response,
    );
  } catch (err) {
    effect = normalizeEffect(
      { outcome: "failed", error: err?.message ?? String(err) },
      item,
      response,
    );
  }
  return effect;
}

async function settleClaimedInboxDecision(
  db,
  { item, response, waiters },
  effect,
  { now, applyEffect, artifactStore, recordedEffect = effect },
) {
  const settled = txImmediate(db, () =>
    settleInboxDecision(db, item.id, response, effect, {
      now,
      artifactStore,
      claimEffect: item.response.effect,
      recordedEffect,
    }),
  );
  if (
    waiters.length > 0 &&
    settled.effect.outcome === "applied" &&
    settled.effect.detail !== REPLANNED_DETAIL
  ) {
    settled.waiterEffects = await fanOutWaiterEffects(
      db,
      settled.item,
      response,
      waiters,
      applyEffect,
    );
    settled.item = getInboxItem(db, item.id);
  }
  return settled;
}

export async function decideInboxItem(db, id, response, options = {}) {
  const {
    now = Date.now(),
    applyEffect = applyDecisionEffect,
    artifactStore,
  } = options;
  const claim = txImmediate(db, () =>
    decideInboxItemInTransaction(db, id, response, {
      now,
      decidedBy: options.decidedBy,
    }),
  );
  const effect = await applyInboxEffect(
    db,
    claim.item,
    claim.response,
    applyEffect,
  );
  return settleClaimedInboxDecision(db, claim, effect, {
    now,
    applyEffect,
    artifactStore,
  });
}

/** Retry the effect for an answer that was already recorded. */
function retryInboxDecisionInTransaction(
  db,
  id,
  { now = Date.now(), expectedResponseJson } = {},
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
  if (!recorded.effect) {
    throw new InboxDecisionError(
      "not_decided",
      `inbox item ${id} has no decision effect to retry`,
      409,
    );
  }
  // A pending claim belongs to an effect still running outside the lock, or
  // to a serve that died mid-effect. Only the latter may be taken over.
  if (
    recorded.effect.outcome === "pending" &&
    pendingClaimAge(recorded.effect, now) < PENDING_EFFECT_CLAIM_TIMEOUT_MS
  ) {
    throw new InboxDecisionError(
      "effect_pending",
      `inbox item ${id} decision effect is still being applied`,
      409,
    );
  }
  const retryAttempt = Number(recorded.effect?.retryAttempt ?? 0) + 1;
  const { effect: _priorEffect, ...response } = recorded;
  const pendingResponse = {
    ...response,
    effect: pendingEffect(decision, response, {
      retryAttempt,
      claimedAt: new Date(now).toISOString(),
    }),
  };
  const claimed = db
    .query(
      `UPDATE inbox_items SET response_json = ? WHERE id = ? AND response_json = ?`,
    )
    .run(JSON.stringify(pendingResponse), id, expectedResponseJson);
  if (claimed.changes !== 1) {
    throw new InboxDecisionError(
      "retry_superseded",
      `inbox item ${id} decision retry was superseded`,
      409,
    );
  }
  return {
    item: getInboxItem(db, id),
    response,
    waiters: parseWaiters(row.waiters_json),
    retryAttempt,
  };
}

export async function retryInboxDecision(db, id, options = {}) {
  // Capture the exact failed outcome before waiting for the write lock. A
  // concurrent retry increments retryAttempt, so a waiter cannot replay the
  // same effect after that first retry commits; a later deliberate retry can.
  const expectedResponseJson =
    db.query("SELECT response_json FROM inbox_items WHERE id = ?").get(id)
      ?.response_json ?? null;
  const {
    now = Date.now(),
    applyEffect = applyDecisionEffect,
    artifactStore,
  } = options;
  const claim = txImmediate(db, () =>
    retryInboxDecisionInTransaction(db, id, { now, expectedResponseJson }),
  );
  const effect = await applyInboxEffect(
    db,
    claim.item,
    claim.response,
    applyEffect,
  );
  return settleClaimedInboxDecision(db, claim, effect, {
    now,
    applyEffect,
    artifactStore,
    recordedEffect: { ...effect, retryAttempt: claim.retryAttempt },
  });
}

export function listInboxItems(db, { status = "open" } = {}) {
  return listInboxPage(db, { status, limit: Number.MAX_SAFE_INTEGER }).items;
}

/**
 * Newest-first keyset page for the inbox ledger.  Keep listInboxItems above
 * for internal callers that intentionally need the complete local ledger;
 * the HTTP surface always uses this bounded projection.
 */
export function listInboxPage(
  db,
  { status = "open", limit = 100, before = null } = {},
) {
  if (!STATUSES.has(status)) {
    throw new ApiParameterError(
      "invalid_status",
      `unknown inbox status: ${status}`,
    );
  }
  const where = {
    open: "resolved_at IS NULL AND acked_at IS NULL",
    acked: "resolved_at IS NULL AND acked_at IS NOT NULL",
    resolved: "resolved_at IS NOT NULL",
    all: "1 = 1",
  }[status];
  const cursor = before
    ? " AND (created_at < ? OR (created_at = ? AND rowid < ?))"
    : "";
  const params = before
    ? [before.createdAt, before.createdAt, before.rowid, limit + 1]
    : [limit + 1];
  const rows = db
    .query(
      `SELECT i.*, i.rowid AS list_rowid, ${inboxExpiredPredicate("i")} AS expired
       FROM inbox_items i
       WHERE ${where}${cursor}
       ORDER BY i.created_at DESC, i.rowid DESC
       LIMIT ?`,
    )
    .all(...params);
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, -1) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(itemView),
    nextBefore: hasNextPage
      ? Buffer.from(
          JSON.stringify({
            createdAt: last.created_at,
            rowid: last.list_rowid,
          }),
        ).toString("base64url")
      : null,
  };
}

/**
 * Merge a connector (or other) projection onto the stored delivery blob
 * without deciding or resolving the item. Shallow-merge of top-level keys
 * so `delivery.buzz` can land next to Telegram's `delivery.telegram` and
 * the ledger's `responseHistory`. Reads the stored JSON, not the view, so
 * writing back does not drop archived answers.
 */
export function markInboxDelivered(db, id, delivery) {
  requiredString(id, "id");
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("delivery must be an object");
  }
  const row = db
    .query("SELECT delivery_json FROM inbox_items WHERE id = ?")
    .get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  const stored = parseObject(row.delivery_json);
  const patch = { ...delivery };
  delete patch.responseHistory;
  const next = { ...stored, ...patch };
  if (Object.hasOwn(stored, "responseHistory")) {
    next.responseHistory = stored.responseHistory;
  } else {
    delete next.responseHistory;
  }
  db.query("UPDATE inbox_items SET delivery_json = ? WHERE id = ?").run(
    JSON.stringify(next),
    id,
  );
  return getInboxItem(db, id);
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
  // Use the same expiry predicate projected by `listInboxItems` and
  // `getInboxItem`, so the badge and the Open tab count agree.
  const totals = db
    .query(
      `SELECT
       SUM(CASE WHEN i.resolved_at IS NULL AND i.acked_at IS NULL
                      AND NOT ${inboxExpiredPredicate("i")}
                      THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN i.resolved_at IS NULL AND i.acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked
     FROM inbox_items i`,
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
     ), proposal_id = ?
     WHERE id = ? AND resolved_at IS NULL`,
  ).run(proposalId, proposalId, id);
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
  if (item.body) {
    // The push renders the ask below; drop the body's restatement of it.
    const duplicated = new Set(decisionParagraphs(item.decision));
    const kept = item.body
      .split("\n\n")
      .filter((paragraph) => !duplicated.has(paragraph))
      .join("\n\n");
    if (kept) lines.push(kept);
  }
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
  // One Telegram per question (WM-813): waiters attach to the existing
  // item instead of projecting a second push.
  if (item.delivery?.telegram) {
    return {
      ok:
        item.delivery.telegram.error == null &&
        (item.delivery.telegram.exit_code === null ||
          item.delivery.telegram.exit_code === 0),
      skipped: true,
      exitCode: item.delivery.telegram.exit_code,
      error: item.delivery.telegram.error,
      item,
    };
  }
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
/** Unactionable parked notices must not remain in the operator queue forever. */
export const MAX_PARKED_INBOX_AGE_MS = 48 * 60 * 60 * 1000;
const TERMINAL_RUN_STATES = new Set([
  "COMPLETED",
  "FAILED",
  "REFUSED",
  "TIMED_OUT",
  "CANCELLED",
]);
// Notices that only report how a run went. Their referent is the run itself,
// so a terminal run makes them stale. Asks are deliberately excluded: an
// ESCALATED item is *born* on a REFUSED run, and a decision the operator has
// not answered stays open no matter what the run it names went on to do.
const RUN_PROGRESS_KINDS = new Set(["CI RED", "SMOKE RED", "CIRCUIT BREAKER"]);
// Notices parked on work the factory itself owns. Only these may be retired
// automatically when the ticket moves on; an ESCALATED ask or any other kind
// names something an operator still has to look at.
const PARKED_KINDS = new Set(["BLOCKED", "human_needed"]);
// A busy inbox must not read every distinct PR on every poll. The cursor is
// kept per database and holds the last `owner/repo#pr` key actually read, so
// the next poll resumes after it in sorted key order. Keying on the referent
// rather than a numeric offset keeps the rotation stable when the pending set
// grows, shrinks or reorders between polls.
const PR_FETCH_LIMIT = 8;
const prFetchCursor = new WeakMap();

/** An ask the operator has been handed and has not answered yet. */
function hasPendingDecision(row) {
  return row.decision_json != null && row.response_json == null;
}

function prNumber(ref) {
  if (typeof ref !== "string") return null;
  const match =
    /^(?:PR\s*)?#?(\d+)$/i.exec(ref.trim()) ??
    /\/pull\/(\d+)(?:[/?#]|$)/.exec(ref);
  return match ? Number(match[1]) : null;
}

function githubRepoFor(refs) {
  const issueRepo =
    typeof refs.issue === "string"
      ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#\d+$/.exec(refs.issue.trim())?.[1]
      : null;
  if (issueRepo) return issueRepo;
  if (typeof refs.repo !== "string" || refs.repo.trim() === "") return null;
  if (refs.repo.includes("/")) return refs.repo;
  try {
    return loadRepos().get(refs.repo)?.github ?? null;
  } catch {
    // A missing or malformed local repository registry must not make an
    // otherwise unrelated inbox sweep fail.
    return null;
  }
}

/**
 * REST reports `state` as "open"/"closed" and flags a merge only via
 * `merged_at`; the reconciler speaks the GraphQL vocabulary. Normalise here so
 * a merged pull request is never mistaken for a still-open one.
 */
export function normalizePullRequestState(pull) {
  if (pull?.merged_at || pull?.merged === true) return "MERGED";
  const state = typeof pull?.state === "string" ? pull.state.toUpperCase() : "";
  if (state === "CLOSED" || state === "MERGED") return state;
  return "OPEN";
}

export async function defaultFetchPullRequest({ github, pr, api }) {
  // makeGhApi uses ghSpawn, rather than the forge's spawnSync transport, so
  // the serve loop yields while GitHub answers this read.
  const pull = await (api ?? makeGhApi())("GET", `repos/${github}/pulls/${pr}`);
  return { state: normalizePullRequestState(pull) };
}

async function fetchReferencedInboxPullRequests(rows, fetchPullRequest, db) {
  const unique = new Map();
  for (const { refs } of rows) {
    const pr = prNumber(refs.pr);
    const github = githubRepoFor(refs);
    if (pr && github) unique.set(`${github}#${pr}`, { github, pr });
  }
  const fetchOne = async ([key, request]) => {
    try {
      return [key, await fetchPullRequest(request)];
    } catch {
      // A deleted PR or rate-limited repository must not stall unrelated
      // inbox reconciliation. The next poll can retry this one referent.
      return [key, null];
    }
  };
  const entries = [...unique.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) return new Map();
  const cursor = prFetchCursor.get(db);
  // Resume after the last key actually read. A key that has since disappeared
  // still orders the remainder correctly, and an unseen list simply starts at
  // the beginning.
  const resumeAt =
    typeof cursor === "string" ? entries.findIndex(([key]) => key > cursor) : 0;
  const start = resumeAt === -1 ? 0 : resumeAt;
  const selected = Array.from(
    { length: Math.min(PR_FETCH_LIMIT, entries.length) },
    (_, index) => entries[(start + index) % entries.length],
  );
  prFetchCursor.set(db, selected[selected.length - 1][0]);
  const fetched = await Promise.all(selected.map(fetchOne));
  return new Map(fetched.filter(([, pull]) => pull));
}

function hasNewerSubjectRun(db, subject, createdAt) {
  if (typeof subject !== "string" || subject.trim() === "") return false;
  const newerRun = db
    .query(
      `SELECT 1 FROM runs
       WHERE subject = ? AND created_at > ?
       LIMIT 1`,
    )
    .get(subject, createdAt);
  if (newerRun) return true;
  return Boolean(
    db
      .query(
        `SELECT 1 FROM events
         WHERE subject = ? AND admitted_at > ?
           AND status IN ('admitted', 'planned', 'human_needed')
         LIMIT 1`,
      )
      .get(subject, createdAt),
  );
}

function staleParkedItem(db, row, refs, now) {
  if (!PARKED_KINDS.has(row.kind)) return false;
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt) || now - createdAt < MAX_PARKED_INBOX_AGE_MS)
    return false;
  if (refs.eventSource && refs.eventId) {
    const event = db
      .query("SELECT 1 FROM events WHERE source = ? AND event_id = ?")
      .get(refs.eventSource, refs.eventId);
    return !event;
  }
  // A parked row without an event, ticket, PR, proposal, or run cannot be
  // acted on or reconciled later. Keep referent-backed asks for their normal
  // reconciliation paths instead of expiring them merely because they age.
  return !refs.issue && !refs.pr && !refs.proposalId && !refs.runId;
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

function laterCiSuccess(row, refs, candidates) {
  const pr = prNumber(refs.pr);
  if (!refs.repo || !pr) return false;
  return candidates.some(({ admittedAt, subject, payload }) => {
    if (admittedAt <= row.created_at) return false;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return false;
    const repo = payload.repo ?? subject;
    return (
      repo === refs.repo &&
      Array.isArray(payload.prNumbers) &&
      payload.prNumbers.some((number) => Number(number) === pr)
    );
  });
}

/**
 * Tracker request, through the control-plane adapter (WM-962).
 *
 * This used to be a second, complete Linear HTTP client living here: its own
 * `fetch` to api.linear.app, its own key resolution, and no retries or
 * rate-limit backoff. Two transports to the same API drift — this one also
 * hardcoded a personal path (`~/Develop/hdkiller/.env`) that has no business
 * in a public repo, and it bypassed the per-repo control-plane selection
 * WM-1007 added, so it would still have talked to Linear for a repo
 * configured for GitHub.
 *
 * `raw()` rather than a typed verb: the inbox asks for a batched
 * `issue(id:)` projection that the neutral contract does not model. Keeping
 * it on the adapter still puts it behind one transport with one credential
 * path, which is the point of the invariant in tools/ticket.test.mjs.
 */
export async function linearGql(query, variables = {}) {
  return loadControlPlane().raw(query, variables);
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

/**
 * GitHub Issues cannot answer Linear's batched `issue(id:)` query. Resolve
 * those rows through their repository-selected adapter, while preserving one
 * bounded batch for the Linear rows and the injectable test seam.
 */
async function fetchReferencedInboxIssues(rows, fallback, controlPlane) {
  const linearIds = [];
  // One lookup per distinct ticket, not per open item: several inbox rows
  // routinely name the same ticket, and each GitHub lookup is its own
  // un-batched API call against a shared token budget.
  const githubRows = new Map();
  for (const entry of rows) {
    const repoName = entry.refs.repo;
    if (!repoName) {
      linearIds.push(entry.refs.issue);
      continue;
    }
    try {
      const plane = controlPlane({ repoName });
      if (plane.kind === "github") {
        if (!githubRows.has(entry.refs.issue))
          githubRows.set(entry.refs.issue, plane);
        continue;
      }
    } catch {
      // The existing poll is fail-open. A stale/missing repo config should not
      // make unrelated Linear inbox rows stop reconciling.
    }
    linearIds.push(entry.refs.issue);
  }
  const githubIssues = await Promise.all(
    [...githubRows].map(async ([issue, plane]) => {
      // Per-row fail-open: one deleted ticket or one rate-limited read must
      // not reject the whole batch and stall every other row's reconcile.
      try {
        const ticket = await plane.getTicket(issue);
        return {
          identifier: issue,
          state: ticket.state,
          labels: ticket.labels,
          title: ticket.title,
        };
      } catch {
        return null;
      }
    }),
  );
  const linearIssues =
    linearIds.length > 0 ? await fallback([...new Set(linearIds)]) : [];
  return [...githubIssues.filter(Boolean), ...linearIssues];
}

function linearIssueResolved(row, issue, db) {
  const state = issue?.state?.name;
  if (typeof state !== "string" || state === "") return false;
  if (row.kind === "BLOCKED") return state !== "Blocked";
  if (row.kind === "ESCALATED") {
    const delivery = parseObject(row.delivery_json);
    const labels = (
      Array.isArray(issue?.labels) ? issue.labels : (issue?.labels?.nodes ?? [])
    ).map((label) => label.name); // WM-978: both label shapes
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

function issueIsClosed(issue) {
  return issue?.state?.type === "completed";
}

/** Resolve asks when their runtime-owned or externally polled referent moves on. */
export function reconcileInbox(
  db,
  {
    now = Date.now(),
    linearIssues = fetchLinearInboxIssues,
    controlPlane = loadControlPlane,
    fetchPullRequest = defaultFetchPullRequest,
  } = {},
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
  const ciRows = rows.filter((row) => row.kind === "CI RED");
  const earliestCiCreatedAt = ciRows.reduce(
    (earliest, row) =>
      earliest === null || row.created_at < earliest
        ? row.created_at
        : earliest,
    null,
  );
  const mergeRequestedCandidates =
    earliestCiCreatedAt === null
      ? []
      : db
          .query(
            `SELECT admitted_at, subject, envelope_json FROM events
             WHERE source = 'github'
               AND type = 'factory.merge.requested'
               AND admitted_at > ?
             ORDER BY admitted_at, rowid`,
          )
          .all(earliestCiCreatedAt)
          .map((event) => {
            const envelope = parseObject(event.envelope_json);
            return {
              admittedAt: event.admitted_at,
              subject: event.subject,
              payload: envelope.payload,
            };
          });
  const linearRows = [];
  const prRows = [];
  for (const row of rows) {
    // Pending decisions are not skipped: once the referent stops waiting the
    // ask is moot and resolveInboxItem records it as superseded (auto:*).
    const refs = parseObject(row.refs_json);
    let resolvedBy = null;
    let resolvedReason = null;
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
      if (laterCiSuccess(row, refs, mergeRequestedCandidates))
        resolvedBy = "auto:ci_green";
    } else if (row.kind === "RC READY") {
      if (refs.proposalId && completedShipProposal(db, refs.proposalId))
        resolvedBy = "auto:ship_completed";
    } else if (refs.eventSource && refs.eventId) {
      const event = db
        .query("SELECT status FROM events WHERE source = ? AND event_id = ?")
        .get(refs.eventSource, refs.eventId);
      if (event && event.status !== "human_needed")
        resolvedBy = "auto:event_requeued";
    }
    // A parked notice about a ticket the factory has already picked back up is
    // stale. This never applies to an open ask or an escalation: a newer run
    // does not answer a decision the operator still owes, and silently
    // resolving one would discard it.
    if (
      !resolvedBy &&
      PARKED_KINDS.has(row.kind) &&
      !hasPendingDecision(row) &&
      hasNewerSubjectRun(db, refs.issue, row.created_at)
    ) {
      resolvedBy = "auto:superseded";
    }
    // A run-progress notice about a run that has already finished is stale.
    // This never applies to an open ask: the operator still owes an answer.
    if (
      !resolvedBy &&
      refs.runId &&
      RUN_PROGRESS_KINDS.has(row.kind) &&
      !hasPendingDecision(row)
    ) {
      const run = db
        .query("SELECT state FROM runs WHERE run_id = ?")
        .get(refs.runId);
      if (run && TERMINAL_RUN_STATES.has(run.state)) {
        resolvedBy = "auto:stale_ref";
        resolvedReason = "stale_ref";
      }
    }
    if (!resolvedBy && staleParkedItem(db, row, refs, now)) {
      resolvedBy = "auto:stale_ref";
      resolvedReason = "stale_ref";
    }
    if (!resolvedBy) continue;
    resolveInboxItem(db, row.id, {
      now,
      resolvedBy,
      ...(resolvedReason ? { reason: resolvedReason } : {}),
    });
    resolved.push({ id: row.id, resolvedBy });
  }

  // A ticket can be referenced by any inbox kind. The kind-specific branches
  // above handle local proposal/event state first; a closed external ticket is
  // stale regardless of whether the item was BLOCKED, RC READY, or a decision.
  for (const row of rows) {
    const refs = parseObject(row.refs_json);
    if (
      refs.pr &&
      row.kind !== "CI RED" &&
      !resolved.some((entry) => entry.id === row.id) &&
      !prRows.some((entry) => entry.row.id === row.id)
    ) {
      prRows.push({ row, refs });
    }
    if (
      refs.issue &&
      !resolved.some((entry) => entry.id === row.id) &&
      !linearRows.some((entry) => entry.row.id === row.id)
    ) {
      linearRows.push({ row, refs });
    }
  }

  if (linearRows.length === 0 && prRows.length === 0) return resolved;
  const lastPoll = linearPollAt.get(db) ?? -Infinity;
  if (now - lastPoll < LINEAR_POLL_INTERVAL_MS) return resolved;
  linearPollAt.set(db, now);
  return Promise.all([
    linearRows.length
      ? fetchReferencedInboxIssues(linearRows, linearIssues, controlPlane)
      : [],
    prRows.length
      ? fetchReferencedInboxPullRequests(prRows, fetchPullRequest, db)
      : new Map(),
  ])
    .then(([issues, pulls]) => {
      const byId = new Map(issues.map((issue) => [issue.identifier, issue]));
      // Only the rows collected for the PR sweep are eligible here: a CI RED
      // row that happens to share a PR reference with another item must not be
      // retired by that item's fetch.
      for (const { row, refs } of prRows) {
        if (resolved.some((entry) => entry.id === row.id)) continue;
        const pr = prNumber(refs.pr);
        const github = githubRepoFor(refs);
        const pull = pr && github ? pulls.get(`${github}#${pr}`) : null;
        if (!["MERGED", "CLOSED"].includes(pull?.state)) continue;
        const resolvedBy =
          pull.state === "MERGED" ? "auto:pr_merged" : "auto:pr_closed";
        resolveInboxItem(db, row.id, { now, resolvedBy });
        resolved.push({ id: row.id, resolvedBy });
      }
      for (const { row, refs } of linearRows) {
        if (resolved.some((entry) => entry.id === row.id)) continue;
        const issue = byId.get(refs.issue);
        if (!issue) continue;
        const stale = issueIsClosed(issue);
        if (!stale && !linearIssueResolved(row, issue, db)) continue;
        const resolvedBy =
          stale || (row.kind !== "BLOCKED" && row.kind !== "ESCALATED")
            ? "auto:stale_ref"
            : row.kind === "BLOCKED"
              ? "auto:linear_unblocked"
              : "auto:linear_escalation_cleared";
        resolveInboxItem(db, row.id, {
          now,
          resolvedBy,
          ...(resolvedBy === "auto:stale_ref" ? { reason: "stale_ref" } : {}),
        });
        resolved.push({ id: row.id, resolvedBy });
      }
      return resolved;
    })
    .catch(() => resolved);
}

/**
 * Push notifications for runtime states that are waiting on a human (WM-65).
 *
 * The watched runtime fails silently for an operator who is not looking at
 * the web UI: an event parked `human_needed` sits invisibly, and a watched
 * proposal nobody decides just expires at TTL. This module wires the serve
 * tick to the existing `notify.py` Telegram transport for exactly those two
 * states — and nothing else. Routine flow (admissions, approvals, clean
 * completions) never notifies: the channel is only for things awaiting a
 * human, or it gets muted.
 *
 * WM-795 gave the rest of the factory (`lib/notify.mjs`, `factory notify`) a
 * policy-configurable transport with no in-tree default, and this module now
 * resolves through the same path (WM-879). `DEFAULT_NOTIFY_CMD` is whatever
 * `config/policy.yaml` `notify.command` says, or null in a clone that has
 * configured nothing — silence on an unconfigured channel, never a spawn of a
 * path that exists on one operator's machine only.
 *
 * Design (ticket WM-65):
 *   - Off by default; FACTORY_EVENT_NOTIFY=1 enables, FACTORY_EVENT_NOTIFY_CMD
 *     replaces the transport (tests point it at a stub binary).
 *   - Once, not per tick: dedup markers live in the module-owned `notify_log`
 *     table so they survive serve restarts. The marker is written *before*
 *     the spawn — exactly-once beats at-least-once for a push channel; a
 *     failing notifier must not re-push on every subsequent 1s tick.
 *   - A notify failure never breaks the tick (OPS-412 isolation): the spawn
 *     is fire-and-forget with a kill timeout; a non-zero exit, spawn error,
 *     or hang is recorded on the notify_log row and logged, never thrown.
 */
import { spawn } from "node:child_process";
import { createInboxItem, deliverInboxItem } from "./inbox.mjs";
import { loadRepos } from "./repos.mjs";
import { txImmediate } from "./db.mjs";
import { templateFor } from "./decision-templates.mjs";
import { proposalSubject } from "./proposal-subject.mjs";
import { notifyCommand as resolveNotifyCommand } from "../../lib/notify.mjs";

export const DEFAULT_NOTIFY_CMD = resolveNotifyCommand() ?? null;

/** A notifier that has not exited by then is killed and recorded as failed. */
export const NOTIFY_TIMEOUT_MS = 30_000;

export function notifyEnabled(env = process.env) {
  return (
    env.FACTORY_EVENT_NOTIFY === "1" || env.FACTORY_EVENT_NOTIFY === "true"
  );
}

/**
 * The notifier command, split on whitespace; the message is appended as one
 * final argv entry (no shell involved, so no quoting pitfalls).
 */
export function notifyCommand(env = process.env) {
  return env.FACTORY_EVENT_NOTIFY_CMD || DEFAULT_NOTIFY_CMD;
}

/**
 * Dedup ledger, owned by this module (Owned Paths exclude db.mjs, and an
 * auxiliary marker table is not core schema). Idempotent by construction;
 * one row per (kind, target) is the once-only guarantee.
 */
export function ensureNotifyLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notify_log (
    kind          TEXT NOT NULL,
    target        TEXT NOT NULL,
    message       TEXT NOT NULL,
    sent_at       TEXT NOT NULL,
    exit_code     INTEGER,
    error         TEXT,
    inbox_item_id TEXT,
    PRIMARY KEY (kind, target)
  );`);
  const columns = new Set(
    db
      .query("PRAGMA table_info(notify_log)")
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("inbox_item_id"))
    db.exec("ALTER TABLE notify_log ADD COLUMN inbox_item_id TEXT;");
}

const KIND_HUMAN_NEEDED = "human_needed";
// Keep the legacy notify_log kind for upgrade-safe dedup while the inbox uses
// the closed-set name from WM-285.
const DEDUP_PROPOSAL_TTL = "proposal_ttl";
const KIND_DECISION_NEEDED = "decision_needed";
const KIND_PROPOSAL_EXPIRED = "proposal_expired";
export const DEFAULT_NOTIFY_LOG_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove expired dedup markers only after their referent can no longer notify.
 * Open proposals and still-parked events retain their markers regardless of
 * age, preserving the once-only push guarantee.
 */
export function sweepNotifyLog(
  db,
  { retentionDays = DEFAULT_NOTIFY_LOG_RETENTION_DAYS, now = Date.now() } = {},
) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("retentionDays must be a positive number of days");
  }
  ensureNotifyLog(db);
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
  // The human_needed target is `${source}/${event_id}`; split it on the
  // notify_log side so the events probe is plain column equality and can use
  // the (source, event_id) primary key. Sources never contain '/', event ids
  // may, hence the split on the first separator.
  return txImmediate(
    db,
    () =>
      db
        .query(
          `DELETE FROM notify_log
         WHERE sent_at < ?
           AND (
             (kind = ? AND NOT EXISTS (
               SELECT 1 FROM events e
               WHERE e.source = substr(notify_log.target, 1, instr(notify_log.target, '/') - 1)
                 AND e.event_id = substr(notify_log.target, instr(notify_log.target, '/') + 1)
                 AND e.status = 'human_needed'
             ))
             OR
             (kind IN (?, ?, ?) AND NOT EXISTS (
               SELECT 1 FROM proposals
               WHERE proposals.id = notify_log.target
                 AND proposals.status = 'open'
             ))
           )`,
        )
        .run(
          cutoff,
          KIND_HUMAN_NEEDED,
          DEDUP_PROPOSAL_TTL,
          KIND_DECISION_NEEDED,
          KIND_PROPOSAL_EXPIRED,
        ).changes,
  );
}

function alreadyNotified(db, kind, target) {
  return !!db
    .query(`SELECT 1 FROM notify_log WHERE kind = ? AND target = ?`)
    .get(kind, target);
}

/**
 * What should be pushed right now, given DB state and the dedup ledger:
 *
 *   - every `human_needed` event not yet notified —
 *     `BLOCKED <event-type> <eventId>: <reason>`
 *   - every open watched 'run' proposal past 50% of its TTL —
 *     inbox title from `proposalSubject(spec)`; Telegram
 *     `DECISION NEEDED proposal <id> (<agent>): expires in <n>m`
 *   - every open watched 'run' proposal past its full TTL, once more —
 *     same inbox title; Telegram `… expired undecided`
 *
 * A proposal decided before the 50% threshold is no longer `status = 'open'`
 * and never appears here. Scheduled auto-approved proposals are decided
 * within a tick of creation, so they never age into either threshold.
 *
 * @returns {Array<{ kind: string, dedupKind?: string, target: string, title: string, message?: string, refs: object, source: string }>}
 */
const COMPOUND_EVENT_ISSUE =
  /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)(?:$|[\s:)\]])/g;

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function issueFromEventId(eventId) {
  if (typeof eventId !== "string") return {};
  // Event coordinates prefix a configured GitHub issue with an opaque chain
  // id. Resolve against the registry rather than greedily treating that
  // prefix as part of an owner name (owners themselves may contain hyphens).
  let issue;
  try {
    const github = [...loadRepos().values()]
      .map((repo) => repo.github)
      .filter(
        (repo) =>
          typeof repo === "string" &&
          new RegExp(`${regexEscape(repo)}#\\d+$`).test(eventId),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (github)
      issue = eventId.match(new RegExp(`(${regexEscape(github)}#\\d+)$`))?.[1];
  } catch {
    // Registry availability is not required for direct GitHub coordinates.
  }
  if (!issue) {
    const matches = [...eventId.matchAll(COMPOUND_EVENT_ISSUE)];
    const candidate = matches.at(-1)?.[1];
    if (candidate && candidate === eventId) issue = candidate;
  }
  if (!issue) return {};
  return { issue, repo: issue.slice(0, issue.lastIndexOf("#")) };
}

/** Ticket/repo the parked event's own envelope or coordinate names, if any. */
function eventRefs(row) {
  let payload;
  try {
    payload = JSON.parse(row.envelopeJson ?? "{}")?.payload;
  } catch {
    return issueFromEventId(row.eventId);
  }
  const coordinate = issueFromEventId(row.eventId);
  if (!payload || typeof payload !== "object") return coordinate;
  return {
    ...(typeof payload.ticket === "string" && payload.ticket
      ? { issue: payload.ticket }
      : coordinate.issue
        ? { issue: coordinate.issue }
        : {}),
    ...(typeof payload.repo === "string" && payload.repo
      ? { repo: payload.repo }
      : coordinate.repo
        ? { repo: coordinate.repo }
        : {}),
  };
}

export function pendingNotifications(db, { now = Date.now() } = {}) {
  ensureNotifyLog(db);
  const pending = [];

  const parked = db
    .query(
      `SELECT e.source, e.event_id AS eventId, e.type, e.envelope_json AS envelopeJson,
              e.last_plan_error AS lastPlanError,
              (SELECT p.reason FROM proposals p
                WHERE p.event_source = e.source AND p.event_id = e.event_id
                  AND p.decision = 'human_needed'
                ORDER BY p.rowid DESC LIMIT 1) AS reason
       FROM events e
       WHERE e.status = 'human_needed'
       ORDER BY e.admitted_at, e.rowid`,
    )
    .all();
  for (const e of parked) {
    const target = `${e.source}/${e.eventId}`;
    if (alreadyNotified(db, KIND_HUMAN_NEEDED, target)) continue;
    const reason = e.reason ?? e.lastPlanError ?? "human_needed";
    // A parked event knows only its own coordinates. Lift whatever the
    // envelope already names so the operator's item can say which repo and
    // ticket stalled instead of "this item".
    const refs = { eventSource: e.source, eventId: e.eventId, ...eventRefs(e) };
    pending.push({
      kind: "BLOCKED",
      dedupKind: KIND_HUMAN_NEEDED,
      target,
      title: `BLOCKED ${e.type} ${e.eventId}: ${reason}`,
      message: `BLOCKED ${e.type} ${e.eventId}: ${reason}`,
      refs,
      // Structured presentation inputs: the reason is a code, not scraped
      // back out of the title above.
      reasonCode: reason,
      eventType: e.type,
      source: "serve:notify",
      decision: templateFor("BLOCKED", {
        producer: "parked",
        refs,
      }),
      dedupeKey: `BLOCKED:${target}`,
    });
  }

  const open = db
    .query(
      `SELECT * FROM proposals WHERE status = 'open' AND decision = 'run' ORDER BY created_at, rowid`,
    )
    .all();
  for (const p of open) {
    const ageMs = now - Date.parse(p.created_at);
    const ttlMs = p.ttl_seconds * 1000;
    if (ageMs < ttlMs / 2) continue;
    const spec = p.spec_json ? JSON.parse(p.spec_json) : null;
    const agent = spec?.agent ?? "?";
    const title = proposalSubject(spec);
    const ticketTitle =
      typeof spec?.approvalPolicy?.dispatchEvidence?.ticket?.title === "string"
        ? spec.approvalPolicy.dispatchEvidence.ticket.title
        : null;
    const issue =
      typeof spec?.input?.ticket === "string" ? spec.input.ticket : null;
    const repo = typeof spec?.input?.repo === "string" ? spec.input.repo : null;
    const refs = {
      proposalId: p.id,
      eventSource: p.event_source,
      eventId: p.event_id,
      ...(issue ? { issue } : {}),
      ...(repo ? { repo } : {}),
    };
    const decision = templateFor(
      ageMs > ttlMs ? KIND_PROPOSAL_EXPIRED : KIND_DECISION_NEEDED,
      {
        producer: "proposal",
        refs,
        spec,
        reason: p.reason,
      },
    );
    if (ageMs > ttlMs) {
      if (!alreadyNotified(db, KIND_PROPOSAL_EXPIRED, p.id)) {
        pending.push({
          kind: KIND_PROPOSAL_EXPIRED,
          target: p.id,
          title,
          ...(ticketTitle ? { ticketTitle } : {}),
          message: `DECISION NEEDED proposal ${p.id} (${agent}): expired undecided`,
          refs,
          source: "serve:notify",
          decision,
          dedupeKey: `${KIND_PROPOSAL_EXPIRED}:${p.id}`,
        });
      }
    } else if (!alreadyNotified(db, DEDUP_PROPOSAL_TTL, p.id)) {
      const minutesLeft = Math.max(1, Math.ceil((ttlMs - ageMs) / 60_000));
      pending.push({
        kind: KIND_DECISION_NEEDED,
        dedupKind: DEDUP_PROPOSAL_TTL,
        target: p.id,
        title,
        ...(ticketTitle ? { ticketTitle } : {}),
        message: `DECISION NEEDED proposal ${p.id} (${agent}): expires in ${minutesLeft}m`,
        refs,
        source: "serve:notify",
        decision,
        dedupeKey: `${KIND_DECISION_NEEDED}:${p.id}`,
      });
    }
  }

  return pending;
}

/**
 * Spawn the notifier once with `message` as its final argument. Resolves —
 * never rejects — with the delivery outcome; a notifier still running after
 * `timeoutMs` is killed and reported as failed.
 *
 * @returns {Promise<{ ok: boolean, exitCode: number|null, error: string|null }>}
 */
export function sendNotification(
  command,
  message,
  { timeoutMs = NOTIFY_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), message], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (err) {
      resolve({ ok: false, exitCode: null, error: err.message });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      settle({
        ok: false,
        exitCode: null,
        error: `notifier timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) =>
      settle({ ok: false, exitCode: null, error: err.message }),
    );
    child.on("exit", (code, signal) => {
      settle({
        ok: code === 0,
        exitCode: code,
        error:
          code === 0
            ? null
            : `notifier exited ${code ?? `on signal ${signal}`}`,
      });
    });
  });
}

/**
 * The tick subsystem: compute pending pushes, mark them notified, and fire
 * the notifier for each without awaiting delivery. Returns synchronously as
 * far as the tick is concerned; `deliveries` is only there so tests (and
 * curious callers) can await the actual outcomes.
 *
 * The ledger is always populated. `enabled` gates only the Telegram
 * projection, so turning pushes off never makes human work invisible.
 *
 * @returns {{ sent: Array<{kind, target, message}>, deliveries: Promise<Array> }}
 */
export function notifyPending(
  db,
  {
    now = Date.now(),
    enabled = notifyEnabled(),
    command = notifyCommand(),
    log = () => {},
    send = sendNotification,
    webUrl = process.env.FACTORY_WEB_URL,
  } = {},
) {
  const pending = pendingNotifications(db, { now });
  const at = new Date(now).toISOString();
  const deliveries = [];
  const sent = [];
  for (const n of pending) {
    const dedupKind = n.dedupKind ?? n.kind;
    const created = txImmediate(db, () => {
      // Recheck inside the write transaction so two tick triggers cannot both
      // create a row for one referent.
      if (alreadyNotified(db, dedupKind, n.target)) return null;
      const item = createInboxItem(db, n, { now });
      const pushMessage = n.message ?? n.title;
      db.query(
        `INSERT INTO notify_log (kind, target, message, sent_at, inbox_item_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(dedupKind, n.target, pushMessage, at, item.id);
      return item;
    });
    if (!created) continue;
    const pushMessage = n.message ?? n.title;
    const notification = {
      ...n,
      message: pushMessage,
      inboxItemId: created.id,
    };
    log(`inbox ${n.kind} ${n.target}: ${n.title}`);
    if (!enabled) continue;
    if (!command) {
      // Enabled but unconfigured. The inbox row above is the durable record,
      // so the human can still see this in the UI; only the push leg is off.
      log(
        `notify ${n.kind} ${n.target}: no transport configured — set notify.command in config/policy.yaml`,
      );
      continue;
    }
    sent.push(notification);
    log(`notify ${n.kind} ${n.target}: ${pushMessage}`);
    deliveries.push(
      deliverInboxItem(db, created.id, {
        command,
        send: (cmd, content) => {
          const lines = String(content).split("\n");
          if (lines[0] === created.title && pushMessage !== created.title) {
            lines[0] = pushMessage;
          }
          return send(cmd, lines.join("\n"));
        },
        webUrl,
        now,
      }).then((outcome) => {
        try {
          db.query(
            `UPDATE notify_log SET exit_code = ?, error = ? WHERE kind = ? AND target = ?`,
          ).run(outcome.exitCode, outcome.error, dedupKind, n.target);
        } catch {
          // db already closed (shutdown mid-delivery) — the log line below is the record
        }
        if (!outcome.ok)
          log(`notify ${n.kind} ${n.target} failed: ${outcome.error}`);
        return { ...notification, ...outcome };
      }),
    );
  }
  return { sent, deliveries: Promise.all(deliveries) };
}

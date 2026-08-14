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
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_NOTIFY_CMD = `python3 ${path.join(homedir(), "Develop", "hdkiller", "scripts", "notify.py")}`;

/** A notifier that has not exited by then is killed and recorded as failed. */
export const NOTIFY_TIMEOUT_MS = 30_000;

export function notifyEnabled(env = process.env) {
  return env.FACTORY_EVENT_NOTIFY === "1" || env.FACTORY_EVENT_NOTIFY === "true";
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
    kind      TEXT NOT NULL,
    target    TEXT NOT NULL,
    message   TEXT NOT NULL,
    sent_at   TEXT NOT NULL,
    exit_code INTEGER,
    error     TEXT,
    PRIMARY KEY (kind, target)
  );`);
}

const KIND_HUMAN_NEEDED = "human_needed";
const KIND_PROPOSAL_TTL = "proposal_ttl";
const KIND_PROPOSAL_EXPIRED = "proposal_expired";

function alreadyNotified(db, kind, target) {
  return !!db.query(`SELECT 1 FROM notify_log WHERE kind = ? AND target = ?`).get(kind, target);
}

/**
 * What should be pushed right now, given DB state and the dedup ledger:
 *
 *   - every `human_needed` event not yet notified —
 *     `BLOCKED <event-type> <eventId>: <reason>`
 *   - every open watched 'run' proposal past 50% of its TTL —
 *     `DECISION NEEDED proposal <id> (<agent>): expires in <n>m`
 *   - every open watched 'run' proposal past its full TTL, once more —
 *     `DECISION NEEDED proposal <id> (<agent>): expired undecided`
 *
 * A proposal decided before the 50% threshold is no longer `status = 'open'`
 * and never appears here. Scheduled auto-approved proposals are decided
 * within a tick of creation, so they never age into either threshold.
 *
 * @returns {Array<{ kind: string, target: string, message: string }>}
 */
export function pendingNotifications(db, { now = Date.now() } = {}) {
  ensureNotifyLog(db);
  const pending = [];

  const parked = db
    .query(
      `SELECT e.source, e.event_id AS eventId, e.type, e.last_plan_error AS lastPlanError,
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
    pending.push({
      kind: KIND_HUMAN_NEEDED,
      target,
      message: `BLOCKED ${e.type} ${e.eventId}: ${e.reason ?? e.lastPlanError ?? "human_needed"}`,
    });
  }

  const open = db
    .query(`SELECT * FROM proposals WHERE status = 'open' AND decision = 'run' ORDER BY created_at, rowid`)
    .all();
  for (const p of open) {
    const ageMs = now - Date.parse(p.created_at);
    const ttlMs = p.ttl_seconds * 1000;
    if (ageMs < ttlMs / 2) continue;
    const spec = p.spec_json ? JSON.parse(p.spec_json) : null;
    const agent = spec?.agent ?? "?";
    if (ageMs > ttlMs) {
      if (!alreadyNotified(db, KIND_PROPOSAL_EXPIRED, p.id)) {
        pending.push({
          kind: KIND_PROPOSAL_EXPIRED,
          target: p.id,
          message: `DECISION NEEDED proposal ${p.id} (${agent}): expired undecided`,
        });
      }
    } else if (!alreadyNotified(db, KIND_PROPOSAL_TTL, p.id)) {
      const minutesLeft = Math.max(1, Math.ceil((ttlMs - ageMs) / 60_000));
      pending.push({
        kind: KIND_PROPOSAL_TTL,
        target: p.id,
        message: `DECISION NEEDED proposal ${p.id} (${agent}): expires in ${minutesLeft}m`,
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
export function sendNotification(command, message, { timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), message], { stdio: ["ignore", "ignore", "ignore"] });
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
      settle({ ok: false, exitCode: null, error: `notifier timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => settle({ ok: false, exitCode: null, error: err.message }));
    child.on("exit", (code, signal) => {
      settle({
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? null : `notifier exited ${code ?? `on signal ${signal}`}`,
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
 * With the feature disabled (the default) this returns before touching the
 * database or spawning anything.
 *
 * @returns {{ sent: Array<{kind, target, message}>, deliveries: Promise<Array> }}
 */
export function notifyPending(db, {
  now = Date.now(),
  enabled = notifyEnabled(),
  command = notifyCommand(),
  log = () => {},
  send = sendNotification,
} = {}) {
  if (!enabled) return { sent: [], deliveries: Promise.resolve([]) };

  const pending = pendingNotifications(db, { now });
  const at = new Date(now).toISOString();
  const deliveries = [];
  for (const n of pending) {
    db.query(`INSERT OR IGNORE INTO notify_log (kind, target, message, sent_at) VALUES (?, ?, ?, ?)`)
      .run(n.kind, n.target, n.message, at);
    log(`notify ${n.kind} ${n.target}: ${n.message}`);
    deliveries.push(
      send(command, n.message).then((outcome) => {
        try {
          db.query(`UPDATE notify_log SET exit_code = ?, error = ? WHERE kind = ? AND target = ?`)
            .run(outcome.exitCode, outcome.error, n.kind, n.target);
        } catch {
          // db already closed (shutdown mid-delivery) — the log line below is the record
        }
        if (!outcome.ok) log(`notify ${n.kind} ${n.target} failed: ${outcome.error}`);
        return { ...n, ...outcome };
      }),
    );
  }
  return { sent: pending, deliveries: Promise.all(deliveries) };
}

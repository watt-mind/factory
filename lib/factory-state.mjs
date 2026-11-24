/**
 * Append-only session journal for interactive factory slash-command loops.
 *
 * Linear/GitHub stay authoritative for work. This records what stages ran in
 * which harness, when, and with what outcome — the gap transcripts fill only
 * for orchestrator-dispatched runs.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const STATE_DIR = path.join(homedir(), ".factory/state");
export const EVENTS_FILE = path.join(STATE_DIR, "events.jsonl");
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

/** @param {Date} d */
export function sessionStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * @param {{ harness?: string, repo: string, now?: number }} opts
 */
export function newSessionId({ harness = "unknown", repo, now = Date.now() }) {
  return `${harness}-${repo}-${sessionStamp(new Date(now))}`;
}

function readLines(file = EVENTS_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @param {{ repo?: string, harness?: string, session?: string, since?: number, limit?: number, file?: string }} opts
 */
export function readEvents({
  repo,
  harness,
  session,
  since = 0,
  limit,
  file = EVENTS_FILE,
} = {}) {
  let events = readLines(file);
  if (repo) events = events.filter((e) => e.repo === repo);
  if (harness) events = events.filter((e) => e.harness === harness);
  if (session) events = events.filter((e) => e.session === session);
  if (since) events = events.filter((e) => Date.parse(e.ts) >= since);
  if (limit != null && limit >= 0) events = events.slice(-limit);
  return events;
}

/**
 * Resolve session id: explicit env/event > active session > new.
 *
 * @param {{ repo: string, harness?: string, session?: string, now?: number, file?: string, idleMs?: number }} ctx
 */
export function resolveSessionId(ctx) {
  if (ctx.session) return ctx.session;
  if (process.env.FACTORY_SESSION_ID) return process.env.FACTORY_SESSION_ID;
  const active = activeSession({
    repo: ctx.repo,
    harness: ctx.harness,
    now: ctx.now,
    file: ctx.file,
    idleMs: ctx.idleMs,
  });
  if (active) return active.id;
  return newSessionId({ harness: ctx.harness, repo: ctx.repo, now: ctx.now });
}

/**
 * @param {{ repo: string, harness?: string, now?: number, file?: string, idleMs?: number }} opts
 */
export function activeSession({
  repo,
  harness,
  now = Date.now(),
  file = EVENTS_FILE,
  idleMs = SESSION_IDLE_MS,
}) {
  const events = readEvents({ repo, harness, file });
  const sessions = sessionsFromEvents(events);
  if (!sessions.length) return null;

  const last = sessions[sessions.length - 1];
  if (last.events.some((e) => e.type === "session-end")) return null;
  if (now - last.lastAt > idleMs) return null;

  return {
    id: last.id,
    repo,
    harness: last.harness ?? harness ?? "unknown",
    startedAt: last.startedAt,
    lastAt: last.lastAt,
    events: last.events,
  };
}

function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    const st = lstatSync(dirPath);
    if (!st.isSymbolicLink() && st.isDirectory() && (st.mode & 0o077) !== 0) {
      chmodSync(dirPath, 0o700);
    }
  } catch {
    /* ignore transient race */
  }
}

function ensurePrivateFile(filePath) {
  if (process.platform === "win32") return;
  try {
    const st = lstatSync(filePath);
    if (!st.isSymbolicLink() && st.isFile() && (st.mode & 0o177) !== 0) {
      chmodSync(filePath, 0o600);
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} event
 * @param {{ file?: string, now?: number }} opts
 */
export function appendEvent(
  event,
  { file = EVENTS_FILE, now = Date.now() } = {},
) {
  ensurePrivateDir(path.dirname(file));

  const session =
    event.session ??
    process.env.FACTORY_SESSION_ID ??
    resolveSessionId({ repo: event.repo, harness: event.harness, now, file });

  const prior = event.repo
    ? readEvents({ repo: event.repo, session, file })
    : [];
  const needsSessionStart =
    event.repo &&
    event.type !== "session-start" &&
    event.type !== "session-end" &&
    !prior.length;

  if (needsSessionStart) {
    appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date(now).toISOString(),
        type: "session-start",
        repo: event.repo,
        harness: event.harness ?? "unknown",
        session,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  const row = { ts: new Date(now).toISOString(), ...event, session };
  appendFileSync(file, `${JSON.stringify(row)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  ensurePrivateFile(file);
  return row;
}

/** Group events by session id, newest sessions last. */
export function sessionsFromEvents(events) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  for (const e of events) {
    if (!e.session) continue;
    const list = map.get(e.session) ?? [];
    list.push(e);
    map.set(e.session, list);
  }
  return [...map.entries()].map(([id, evs]) => ({
    id,
    repo: evs.find((e) => e.repo)?.repo,
    harness: evs.find((e) => e.harness)?.harness,
    startedAt: Date.parse(evs[0].ts),
    lastAt: Date.parse(evs[evs.length - 1].ts),
    events: evs,
  }));
}

export function formatClock(isoOrMs) {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  return d.toTimeString().slice(0, 5);
}

export function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Human label for an event row. */
export function eventLabel(e) {
  switch (e.type) {
    case "recommend": {
      const slash =
        e.slash ??
        (e.command
          ? `/factory-${String(e.command).replace(/^factory-/, "")}${e.args ? ` ${e.args}` : ""}`
          : "(wait)");
      return `recommend   ${slash}`;
    }
    case "start": {
      const cmd = e.command
        ? `/factory-${String(e.command).replace(/^factory-/, "")}${e.args ? ` ${e.args}` : ""}`
        : (e.exec ?? "?");
      return `start       ${cmd}`;
    }
    case "complete":
      return `complete    ${e.summary ?? (e.ok ? "ok" : "failed")}`;
    case "friction":
      return `friction    ${(e.issues ?? []).join(", ") || "none"}`;
    case "session-start":
      return `session     started (${e.harness ?? "?"})`;
    case "session-end":
      return `session     ended`;
    default:
      return e.type;
  }
}

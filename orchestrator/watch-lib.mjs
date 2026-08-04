/**
 * Pure helpers for orchestrator/watch.jsx — kept apart from the Ink rendering
 * so the parsing logic (the part actually worth getting wrong) has real tests.
 *
 * Log lines come from two harnesses in two different shapes: Claude's
 * stream-json ({type:"assistant"|"result", ...}) and agy's step-update
 * envelope ({event:"step_update"|"result", ...}). tick.mjs normalises both
 * inline for its own console output; this mirrors that same normalisation
 * read-only, from the .jsonl files tick.mjs already writes to ~/.factory/logs.
 */
import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

const trim = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

function resultEntry(ok, turns, cost, said) {
  return { kind: "result", ok, turns: turns ?? 0, cost: cost ?? 0, said: trim(said, 120) };
}

/** One raw .jsonl line -> zero or more display entries. Never throws. */
export function parseLogLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (!line.startsWith("{")) return [];
  let e;
  try { e = JSON.parse(line); } catch { return []; }

  if (e.type === "assistant") {
    return (e.message?.content ?? [])
      .filter((p) => p.type === "tool_use")
      .map((p) => ({ kind: "tool", tool: p.name, detail: trim(p.input?.command ?? p.input?.file_path ?? p.input?.description, 66) }));
  }
  if (e.type === "result" || (typeof e.num_turns === "number" && "subtype" in e)) {
    return [resultEntry(e.subtype === "success" && !e.is_error && (e.num_turns ?? 0) > 0, e.num_turns, e.total_cost_usd, e.result)];
  }

  if (e.event === "step_update") {
    const s = e.step_update ?? {};
    if (s.step_type === "tool" && s.state === "ACTIVE") {
      const par = s.tool_info?.parameters ?? {};
      return [{ kind: "tool", tool: s.tool_name ?? "tool", detail: trim(par.CommandLine ?? par.command ?? par.AbsolutePath ?? par.path, 66) }];
    }
    return [];
  }
  const env = e.event === "result" ? e.result : ("status" in e && "num_turns" in e ? e : null);
  if (env) return [resultEntry(String(env.status).toLowerCase() === "success", env.num_turns, env.total_cost_usd, env.response)];

  return [];
}

/** A display entry -> one line of text for the log-tail pane. */
export function formatEntry(entry) {
  if (entry.kind === "tool") return entry.detail ? `${entry.tool} ${entry.detail}` : entry.tool;
  const cost = `${entry.turns} turns ~$${entry.cost.toFixed(2)}`;
  if (entry.ok) return `done — ${cost}`;
  return entry.said ? `FAILED — ${cost} — ${entry.said}` : `FAILED — ${cost}`;
}

/** Newest log file for a ticket, by mtime — a ticket can be retried, leaving older logs behind. */
export function latestLogForTicket(logDir, repo, identifier) {
  let best = null;
  let bestMtime = -Infinity;
  let files;
  try { files = new Bun.Glob(`${repo}-${identifier}-*.jsonl`).scanSync(logDir); } catch { return null; }
  for (const f of files) {
    const full = path.join(logDir, f);
    const mtime = Bun.file(full).lastModified;
    if (mtime > bestMtime) { bestMtime = mtime; best = full; }
  }
  return best;
}

/** Last `maxEntries` formatted lines from a log file. Missing/unreadable file -> []. */
export function tailFormattedLines(filePath, maxEntries = 40) {
  if (!filePath) return [];
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch { return []; }
  const entries = text.split("\n").flatMap(parseLogLine);
  return entries.slice(-maxEntries).map(formatEntry);
}

/** Running + in-review tickets from one queue.mjs --json summary entry, in display order. */
export function buildTicketRows(summary) {
  const running = (summary?.inProgressTickets ?? []).map((t) => ({ ...t, status: "running" }));
  const review = (summary?.inReviewTickets ?? []).map((t) => ({ ...t, status: "review" }));
  return [...running, ...review];
}

export function formatSpend(spent, perDay) {
  return `$${(spent ?? 0).toFixed(2)} / $${(perDay ?? 0).toFixed(2)}`;
}

/** Project progress for the stat strip. `capped` means the counts are floors (a 250-issue page filled up). */
export function formatIssueCounts(done, total, capped) {
  return `${done ?? 0}/${total ?? 0}${capped ? "+" : ""}`;
}

/**
 * The pipeline stages, in pipeline order. Kept here so the TUI and the status
 * scan below can never disagree about what a "stage" is.
 */
export const STAGES = ["triage", "dispatch", "merge"];

// Newest-result parses are cached per (file, mtime) so the 3s poll re-reads a
// finished stage log zero times instead of every tick.
const stageResultCache = new Map();

/**
 * What each stage is doing right now, from log mtimes alone — no process
 * tracking. tick.mjs streams jsonl continuously while an agent runs, so a
 * stage log touched within `activeMs` means that stage is running this moment.
 * triage/merge write `<repo>-factory-<stage>-*.jsonl`; dispatch writes the
 * per-ticket `<repo>-<ID>-*.jsonl` logs, so its footprint is any ticket log.
 *
 * Returns [{ stage, active, ageMs, lastResult }] in STAGES order; ageMs is
 * null when a stage has never run, lastResult only filled for idle stages.
 */
export function stageStatuses(logDir, repo, { now = Date.now(), activeMs = 90_000 } = {}) {
  return STAGES.map((stage) => {
    const glob = stage === "dispatch" ? `${repo}-*-*.jsonl` : `${repo}-factory-${stage}-*.jsonl`;
    let best = null;
    let bestMtime = -Infinity;
    try {
      for (const f of new Bun.Glob(glob).scanSync(logDir)) {
        if (stage === "dispatch" && f.includes("-factory-")) continue;
        const full = path.join(logDir, f);
        const mtime = Bun.file(full).lastModified;
        if (mtime > bestMtime) { bestMtime = mtime; best = full; }
      }
    } catch { /* no log dir yet */ }
    if (!best) return { stage, active: false, ageMs: null, lastResult: null };

    const ageMs = Math.max(0, now - bestMtime);
    const active = ageMs < activeMs;
    let lastResult = null;
    if (!active) {
      const key = `${best}:${bestMtime}`;
      if (stageResultCache.has(key)) {
        lastResult = stageResultCache.get(key);
      } else {
        try {
          const entries = readFileSync(best, "utf8").split("\n").flatMap(parseLogLine);
          lastResult = [...entries].reverse().find((e) => e.kind === "result") ?? null;
        } catch { lastResult = null; }
        stageResultCache.set(key, lastResult);
        if (stageResultCache.size > 64) stageResultCache.delete(stageResultCache.keys().next().value);
      }
    }
    return { stage, active, ageMs, lastResult };
  });
}

/**
 * The [start, end) slice of a list that fits `max` rows while keeping
 * `selected` visible — the selection stays centred once the list scrolls.
 * This is what keeps a long ticket list scrolling INSIDE the TUI instead of
 * overflowing the terminal and pushing frames into scrollback.
 */
export function visibleWindow(count, selected, max) {
  if (max <= 0) return [0, 0];
  if (count <= max) return [0, count];
  const start = Math.max(0, Math.min(selected - Math.floor(max / 2), count - max));
  return [start, start + max];
}

/** "42s" / "7m" / "3h12m" / "never" — coarse on purpose, it's a glance. */
export function formatAge(ms) {
  if (ms == null) return "never";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return `${Math.floor(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  return `${Math.floor(mins / 60)}h${rest ? `${rest}m` : ""}`;
}

/**
 * The desktop-app deep link for a Linear issue URL. Linear's macOS app
 * registers the linear:// scheme; handing `open` an https://linear.app URL
 * lands in the browser instead. Anything that isn't a linear.app URL comes
 * back null so the caller falls back to opening the https URL as-is.
 */
export function linearDeepLink(url) {
  const m = /^https:\/\/linear\.app\/(.+)$/.exec(String(url ?? ""));
  return m ? `linear://${m[1]}` : null;
}

/**
 * What a reaper.mjs run concluded, parsed from its stdout. The number gates the
 * TUI's confirm step: --apply is only offered when the dry run found something
 * to reclaim, so a stray keypress on a clean queue can never write to Linear.
 */
export function parseReaperOutput(text) {
  const s = String(text ?? "");
  const m = /===\s+(?:Would reclaim|Reclaimed):\s+(\d+)/.exec(s);
  if (m) return { stale: Number(m[1]) };
  return { stale: 0 };
}

/**
 * One entry per agent running RIGHT NOW: every log under logDir for `repo`
 * whose mtime is within `activeMs`. The filename says which stage invoked it —
 * `<repo>-factory-<stage>-<stamp>.jsonl` is the stage's own agent (triage,
 * merge, …); `<repo>-<TICKET-ID>-<stamp>.jsonl` is a dispatch agent working
 * that ticket. Sorted most-recently-active first.
 */
export function activeAgents(logDir, repo, { now = Date.now(), activeMs = 90_000 } = {}) {
  const out = [];
  try {
    for (const f of new Bun.Glob(`${repo}-*.jsonl`).scanSync(logDir)) {
      const full = path.join(logDir, f);
      const ageMs = Math.max(0, now - Bun.file(full).lastModified);
      if (ageMs >= activeMs) continue;
      // Stamps appear as 20260804-164848, 20260804164848, and a trailing-dot
      // variant (…143850..jsonl) — tolerate all three.
      const rest = f.slice(repo.length + 1).replace(/\.jsonl$/, "");
      const stage = /^factory-(.+?)-\d{8}-?\d{6}\.?$/.exec(rest);
      const ticket = /^(.+?)-\d{8}-?\d{6}\.?$/.exec(rest);
      if (stage) out.push({ stage: stage[1], label: stage[1], identifier: null, file: full, ageMs, harness: peekHarness(full) });
      else if (ticket) out.push({ stage: "dispatch", label: ticket[1], identifier: ticket[1], file: full, ageMs, harness: peekHarness(full) });
    }
  } catch { /* no log dir yet */ }
  return out.sort((a, b) => a.ageMs - b.ageMs);
}

/**
 * Which harness wrote this log, from its first bytes: Claude's stream-json
 * opens with {"type":"system","subtype":"init"}, agy's envelope with
 * {"event":…}. 160 bytes is enough for either and cheap to re-peek.
 */
export function peekHarness(file) {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(160);
    const n = readSync(fd, buf, 0, 160, 0);
    closeSync(fd);
    const head = buf.toString("utf8", 0, n);
    if (head.includes('"type":"system"') || head.includes('"type":"assistant"')) return "claude";
    if (head.includes('"event"') || head.includes("step_update")) return "agy";
  } catch { /* unreadable — unknown */ }
  return null;
}

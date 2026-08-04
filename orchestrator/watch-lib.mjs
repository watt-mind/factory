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
import { readFileSync } from "node:fs";
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

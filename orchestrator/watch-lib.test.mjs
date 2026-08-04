/**
 * bun test
 *
 * The log parser is the one part of watch.jsx that can silently show nothing
 * (or crash on a malformed line) without anyone noticing until they need it —
 * it gets real tests. Fixtures are trimmed real lines from both harnesses'
 * ~/.factory/logs output.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseLogLine, formatEntry, tailFormattedLines, latestLogForTicket, buildTicketRows, formatSpend,
  formatIssueCounts, parseReaperOutput, linearDeepLink, stageStatuses, formatAge, visibleWindow,
  activeAgents,
} from "./watch-lib.mjs";

test("ignores blank lines and non-JSON noise", () => {
  expect(parseLogLine("")).toEqual([]);
  expect(parseLogLine("   ")).toEqual([]);
  expect(parseLogLine("not json")).toEqual([]);
});

test("ignores malformed JSON instead of throwing", () => {
  expect(() => parseLogLine('{"type":"assistant", broken')).not.toThrow();
  expect(parseLogLine('{"type":"assistant", broken')).toEqual([]);
});

test("claude: extracts a tool_use call from an assistant message", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm run lint" } }] },
  });
  expect(parseLogLine(line)).toEqual([{ kind: "tool", tool: "Bash", detail: "npm run lint" }]);
});

test("claude: a text-only assistant message yields no entries", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } });
  expect(parseLogLine(line)).toEqual([]);
});

test("claude: a successful result", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 12, total_cost_usd: 1.5, result: "done" });
  const [entry] = parseLogLine(line);
  expect(entry.kind).toBe("result");
  expect(entry.ok).toBe(true);
  expect(formatEntry(entry)).toBe("done — 12 turns ~$1.50");
});

test("claude: a failed result includes the trimmed message", () => {
  const line = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3, total_cost_usd: 0.4, result: "Unknown command" });
  const [entry] = parseLogLine(line);
  expect(entry.ok).toBe(false);
  expect(formatEntry(entry)).toBe("FAILED — 3 turns ~$0.40 — Unknown command");
});

test("agy: extracts an ACTIVE tool step_update", () => {
  const line = JSON.stringify({
    event: "step_update",
    step_update: { step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { CommandLine: "bun test" } } },
  });
  expect(parseLogLine(line)).toEqual([{ kind: "tool", tool: "run_command", detail: "bun test" }]);
});

test("agy: a DONE step_update produces no entry (only ACTIVE tool steps do)", () => {
  const line = JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "run_command" } });
  expect(parseLogLine(line)).toEqual([]);
});

test("agy: a wrapped result event", () => {
  const line = JSON.stringify({ event: "result", result: { status: "SUCCESS", num_turns: 5, total_cost_usd: 2, response: "ok" } });
  const [entry] = parseLogLine(line);
  expect(entry.ok).toBe(true);
  expect(formatEntry(entry)).toBe("done — 5 turns ~$2.00");
});

test("agy: an ERROR status formats as failed", () => {
  const line = JSON.stringify({ event: "result", result: { status: "ERROR", num_turns: 1, total_cost_usd: 0, error: "quota reached" } });
  const [entry] = parseLogLine(line);
  expect(entry.ok).toBe(false);
});

test("tailFormattedLines reads a file, formats every entry, and caps at maxEntries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  const file = path.join(dir, "sample.jsonl");
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `f${i}.ts` } }] } }));
  }
  writeFileSync(file, lines.join("\n"));
  expect(tailFormattedLines(file, 2)).toEqual(["Read f3.ts", "Read f4.ts"]);
  rmSync(dir, { recursive: true, force: true });
});

test("tailFormattedLines returns [] for a missing file rather than throwing", () => {
  expect(tailFormattedLines("/no/such/file.jsonl")).toEqual([]);
  expect(tailFormattedLines(null)).toEqual([]);
});

test("latestLogForTicket picks the newest matching file by mtime", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  writeFileSync(path.join(dir, "bj29-CLNT-1-20260101000000..jsonl"), "{}");
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(path.join(dir, "bj29-CLNT-1-20260102000000..jsonl"), "{}");
  writeFileSync(path.join(dir, "bj29-CLNT-2-20260103000000..jsonl"), "{}"); // different ticket, must not match
  const found = latestLogForTicket(dir, "bj29", "CLNT-1");
  expect(found).toBe(path.join(dir, "bj29-CLNT-1-20260102000000..jsonl"));
  rmSync(dir, { recursive: true, force: true });
});

test("latestLogForTicket returns null when nothing matches", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  expect(latestLogForTicket(dir, "bj29", "CLNT-999")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("buildTicketRows tags running and in-review tickets and preserves order", () => {
  const summary = {
    inProgressTickets: [{ identifier: "CLNT-1", title: "a" }],
    inReviewTickets: [{ identifier: "CLNT-2", title: "b" }, { identifier: "CLNT-3", title: "c" }],
  };
  expect(buildTicketRows(summary)).toEqual([
    { identifier: "CLNT-1", title: "a", status: "running" },
    { identifier: "CLNT-2", title: "b", status: "review" },
    { identifier: "CLNT-3", title: "c", status: "review" },
  ]);
});

test("buildTicketRows tolerates a summary with no tickets", () => {
  expect(buildTicketRows({})).toEqual([]);
});

test("formatSpend rounds to cents", () => {
  expect(formatSpend(4.2, 40)).toBe("$4.20 / $40.00");
  expect(formatSpend(7 * 1.1, 10)).toBe("$7.70 / $10.00");
});

test("formatIssueCounts renders done/total and marks capped counts as floors", () => {
  expect(formatIssueCounts(41, 57, false)).toBe("41/57");
  expect(formatIssueCounts(250, 400, true)).toBe("250/400+");
  expect(formatIssueCounts(undefined, undefined, false)).toBe("0/0");
});

test("parseReaperOutput reads the reclaim count from a dry run", () => {
  const out = "=== Stale-claim reaper [DRY RUN] threshold=45min ===\n\n  STALE CW-12  61m  agent  title\n\n=== Would reclaim: 2 | Healthy: 3 ===\nRun again with --apply to reclaim these.";
  expect(parseReaperOutput(out)).toEqual({ stale: 2 });
});

test("parseReaperOutput reads the count from an --apply run", () => {
  expect(parseReaperOutput("=== Reclaimed: 1 | Healthy: 0 ===")).toEqual({ stale: 1 });
});

test("parseReaperOutput treats a clean queue or garbage as nothing to reclaim", () => {
  expect(parseReaperOutput("=== No stale claims among 4 in progress. ===")).toEqual({ stale: 0 });
  expect(parseReaperOutput("")).toEqual({ stale: 0 });
  expect(parseReaperOutput(null)).toEqual({ stale: 0 });
});

test("linearDeepLink maps linear.app URLs to the desktop scheme, null otherwise", () => {
  expect(linearDeepLink("https://linear.app/watt-mind/issue/CLNT-810/clean-up-blog-routing"))
    .toBe("linear://watt-mind/issue/CLNT-810/clean-up-blog-routing");
  expect(linearDeepLink("https://example.com/issue/X-1")).toBeNull();
  expect(linearDeepLink(undefined)).toBeNull();
});

test("stageStatuses: fresh log = active, old log = idle with the last result", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 4, total_cost_usd: 0.5, result: "ok" });
  writeFileSync(path.join(dir, "bj29-factory-triage-20260804-120000.jsonl"), result);
  writeFileSync(path.join(dir, "bj29-CLNT-1-20260804-120000.jsonl"), result);
  const now = Date.now();

  // Written milliseconds ago -> triage and dispatch active, merge never ran.
  const live = stageStatuses(dir, "bj29", { now });
  expect(live.map((s) => [s.stage, s.active])).toEqual([["triage", true], ["dispatch", true], ["merge", false]]);
  expect(live[2].ageMs).toBeNull();

  // Same files viewed from 10 minutes later -> idle, with the parsed result.
  const idle = stageStatuses(dir, "bj29", { now: now + 10 * 60_000 });
  expect(idle[0].active).toBe(false);
  expect(idle[0].lastResult?.ok).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("stageStatuses: dispatch ignores factory-stage logs; failures surface", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  const fail = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, total_cost_usd: 0.1, result: "boom" });
  writeFileSync(path.join(dir, "bj29-factory-merge-20260804-120000.jsonl"), fail);
  const later = { now: Date.now() + 10 * 60_000 };
  const s = stageStatuses(dir, "bj29", later);
  expect(s[1]).toEqual({ stage: "dispatch", active: false, ageMs: null, lastResult: null });
  expect(s[2].lastResult?.ok).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("stageStatuses tolerates a missing log dir", () => {
  expect(stageStatuses("/no/such/dir", "bj29").every((s) => s.ageMs === null)).toBe(true);
});

test("formatAge is coarse and never negative-weird", () => {
  expect(formatAge(null)).toBe("never");
  expect(formatAge(42_000)).toBe("42s");
  expect(formatAge(7 * 60_000)).toBe("7m");
  expect(formatAge(3 * 3600_000 + 12 * 60_000)).toBe("3h12m");
  expect(formatAge(2 * 3600_000)).toBe("2h");
});

test("visibleWindow keeps the selection in view and clamps at both ends", () => {
  expect(visibleWindow(5, 2, 10)).toEqual([0, 5]);      // fits — no scrolling
  expect(visibleWindow(20, 0, 6)).toEqual([0, 6]);      // top
  expect(visibleWindow(20, 10, 6)).toEqual([7, 13]);    // centred mid-list
  expect(visibleWindow(20, 19, 6)).toEqual([14, 20]);   // bottom clamp
  expect(visibleWindow(20, 5, 0)).toEqual([0, 0]);      // degenerate pane
});

test("activeAgents labels stage vs dispatch agents and drops stale logs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  writeFileSync(path.join(dir, "bj29-factory-triage-20260804-164848.jsonl"), "{}");
  writeFileSync(path.join(dir, "bj29-CLNT-810-20260804143850..jsonl"), "{}"); // double-dot stamp variant
  writeFileSync(path.join(dir, "bj29-factory-merge-20260804120000.jsonl"), "{}"); // dashless stamp
  const live = activeAgents(dir, "bj29");
  expect(live.map((a) => [a.stage, a.label, a.identifier]).sort()).toEqual([
    ["dispatch", "CLNT-810", "CLNT-810"],
    ["merge", "merge", null],
    ["triage", "triage", null],
  ]);
  // The same files 10 minutes later are nobody's live agent.
  expect(activeAgents(dir, "bj29", { now: Date.now() + 10 * 60_000 })).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("activeAgents tolerates a missing log dir and foreign repos", () => {
  expect(activeAgents("/no/such/dir", "bj29")).toEqual([]);
  const dir = mkdtempSync(path.join(tmpdir(), "watch-lib-"));
  writeFileSync(path.join(dir, "legalease-CLNT-1-20260804-120000.jsonl"), "{}");
  expect(activeAgents(dir, "bj29")).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

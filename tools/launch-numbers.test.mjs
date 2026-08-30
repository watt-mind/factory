import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  harnessTokenTotals,
  loadTranscriptRuns,
} from "../orchestrator/economics.mjs";
import {
  classifyIssues,
  collectLaunchNumbers,
  dispatchedInWindow,
  formatDuration,
  formatReport,
  isDispatched,
  isEscalated,
  median,
  mergedWithoutHumanTouch,
  parseSince,
  visitedState,
  weeksUnattended,
} from "./launch-numbers.mjs";

const ROOT = path.resolve(import.meta.dir, "..");

function runTool(name, args = []) {
  return Bun.spawnSync({
    cmd: [process.execPath, path.join(ROOT, "tools", name), ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(proc, stream) {
  return proc[stream]?.toString().trim() ?? "";
}

test("launch-numbers help prints usage and argument errors exit 2", () => {
  const help = runTool("launch-numbers.mjs", ["--help"]);
  expect(help.exitCode).toBe(0);
  expect(output(help, "stdout")).toStartWith("usage:");
  expect(output(help, "stderr")).toBe("");

  for (const args of [["--unknown"], ["--since"]]) {
    const invalid = runTool("launch-numbers.mjs", args);
    expect(invalid.exitCode).toBe(2);
    expect(output(invalid, "stderr").split("\n")).toHaveLength(1);
    expect(output(invalid, "stderr")).toStartWith("usage:");
  }
});

const issue = (over = {}) => ({
  identifier: "WM-1",
  createdAt: "2026-08-04T10:00:00.000Z",
  startedAt: "2026-08-04T11:00:00.000Z",
  completedAt: "2026-08-04T13:00:00.000Z",
  updatedAt: "2026-08-04T13:00:00.000Z",
  state: { name: "Done", type: "completed" },
  team: { key: "WM" },
  labels: { nodes: [{ name: "agent:claude-code" }] },
  history: { nodes: [] },
  ...over,
});

test("parseSince accepts a calendar day and an ISO timestamp", () => {
  expect(parseSince("2026-08-03").iso).toBe("2026-08-03T00:00:00.000Z");
  expect(parseSince("2026-08-03T12:00:00.000Z").ms).toBe(
    Date.parse("2026-08-03T12:00:00.000Z"),
  );
  expect(() => parseSince("last-week")).toThrow(/invalid since/);
});

test("median is the middle value, averaging the pair on even length", () => {
  expect(median([])).toBeNull();
  expect(median([3])).toBe(3);
  expect(median([1, 3, 2])).toBe(2);
  expect(median([2, 8])).toBe(5);
});

test("weeksUnattended floors whole weeks and keeps remainder days", () => {
  const since = "2026-08-03T00:00:00.000Z";
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  expect(weeksUnattended(since, now)).toEqual({
    days: 17,
    weeks: 2,
    remainderDays: 3,
  });
});

test("a Done ticket with agent:* is dispatched, merged, and untouched", () => {
  const i = issue();
  expect(isDispatched(i)).toBe(true);
  expect(isEscalated(i)).toBe(false);
  expect(mergedWithoutHumanTouch(i)).toBe(true);
});

test("ai:escalated in history is human touch even after the label is gone", () => {
  const i = issue({
    labels: { nodes: [{ name: "agent:claude-code" }] },
    history: {
      nodes: [
        {
          addedLabels: [{ name: "ai:escalated" }],
          removedLabels: [{ name: "ai:escalated" }],
        },
      ],
    },
  });
  expect(isEscalated(i)).toBe(true);
  expect(mergedWithoutHumanTouch(i)).toBe(false);
});

test("a Blocked detour is human touch", () => {
  const i = issue({
    history: {
      nodes: [
        {
          fromState: { name: "In Progress" },
          toState: { name: "Blocked" },
          addedLabels: [{ name: "ai:blocked" }],
          removedLabels: [],
        },
        {
          fromState: { name: "Blocked" },
          toState: { name: "In Progress" },
          addedLabels: [],
          removedLabels: [{ name: "ai:blocked" }],
        },
      ],
    },
  });
  expect(visitedState(i, "Blocked")).toBe(true);
  expect(mergedWithoutHumanTouch(i)).toBe(false);
});

test("ai:agent-ready alone is not dispatched", () => {
  const i = issue({
    completedAt: null,
    state: { name: "Todo", type: "unstarted" },
    labels: { nodes: [{ name: "ai:agent-ready" }, { name: "type:docs" }] },
  });
  expect(isDispatched(i)).toBe(false);
});

test("pre-window tickets are ignored when sinceMs is set", () => {
  const old = issue({
    identifier: "WM-OLD",
    createdAt: "2026-07-01T00:00:00.000Z",
    startedAt: "2026-07-01T01:00:00.000Z",
    completedAt: "2026-07-02T00:00:00.000Z",
  });
  const fresh = issue({ identifier: "WM-NEW" });
  const sinceMs = Date.parse("2026-08-03T00:00:00.000Z");
  expect(dispatchedInWindow(old, sinceMs)).toBe(false);
  expect(dispatchedInWindow(fresh, sinceMs)).toBe(true);
  const stats = classifyIssues([old, fresh], { sinceMs });
  expect(stats.dispatched).toBe(1);
  expect(stats.merged).toBe(1);
});

test("classifyIssues rolls dispatched/merged/escalated and the human-touch rate", () => {
  const stats = classifyIssues([
    issue({ identifier: "WM-1" }),
    issue({
      identifier: "WM-2",
      team: { key: "CLNT" },
      labels: {
        nodes: [{ name: "agent:codex" }, { name: "ai:escalated" }],
      },
    }),
    issue({
      identifier: "WM-3",
      completedAt: null,
      startedAt: "2026-08-10T00:00:00.000Z",
      state: { name: "In Progress", type: "started" },
      labels: { nodes: [{ name: "ai:in-progress" }, { name: "agent:pi" }] },
    }),
    issue({
      identifier: "HUMAN-1",
      completedAt: "2026-08-05T00:00:00.000Z",
      labels: { nodes: [{ name: "type:docs" }] },
    }),
  ]);
  expect(stats.dispatched).toBe(3);
  expect(stats.merged).toBe(2);
  expect(stats.escalated).toBe(1);
  expect(stats.mergedWithoutHumanTouch).toBe(1);
  expect(stats.mergedWithoutHumanTouchPct).toBe(50);
  expect(stats.medianTicketToMergeMs).toBe(3 * 3_600_000);
  expect(stats.byTeam.map((r) => r.team).sort()).toEqual(["CLNT", "WM"]);
});

test("formatDuration picks minutes, hours, then days", () => {
  expect(formatDuration(30_000)).toBe("1 min");
  expect(formatDuration(90 * 60_000)).toBe("1.5 h");
  expect(formatDuration(72 * 3_600_000)).toBe("3 d");
  expect(formatDuration(null)).toBe("n/a");
});

test("collectLaunchNumbers joins Linear classification with harness tokens", () => {
  const metrics = collectLaunchNumbers({
    issues: [issue()],
    runs: [
      {
        harness: "claude",
        ok: true,
        in: 100,
        out: 20,
        cacheRead: 800,
        cacheWrite: 10,
        cost: 0.01,
        estCost: 0.01,
      },
      {
        harness: "codex",
        ok: false,
        in: 50,
        out: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        estCost: 0.002,
      },
    ],
    sinceIso: "2026-08-03T00:00:00.000Z",
    nowMs: Date.parse("2026-08-20T00:00:00.000Z"),
    generatedAt: "2026-08-20T00:00:00.000Z",
  });
  expect(metrics.window.days).toBe(17);
  expect(metrics.tickets.merged).toBe(1);
  expect(metrics.tokens.totals.runs).toBe(2);
  expect(metrics.tokens.totals.tokens).toBe(175);
  expect(metrics.tokens.byHarness[0].harness).toBe("claude");
  const text = formatReport(metrics);
  expect(text).toContain("merged without human touch 1");
  expect(text).toContain("does not publish");
});

test("loadTranscriptRuns and harnessTokenTotals share economics' parser", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-numbers-"));
  writeFileSync(
    path.join(dir, "factory-WM-1-20260804.jsonl"),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      duration_ms: 1000,
      total_cost_usd: 0.02,
    }) + "\n",
  );
  try {
    const loaded = loadTranscriptRuns({ logDir: dir, sinceMs: 0 });
    expect(loaded.ok).toBe(true);
    expect(loaded.runs).toHaveLength(1);
    const totals = harnessTokenTotals(loaded.runs);
    expect(totals[0].harness).toBe("claude");
    expect(totals[0].runs).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTranscriptRuns reports a missing directory instead of throwing", () => {
  const loaded = loadTranscriptRuns({
    logDir: path.join(os.tmpdir(), "no-such-factory-logs-wm-802"),
  });
  expect(loaded.ok).toBe(false);
  expect(loaded.code).toBe("no-dir");
});

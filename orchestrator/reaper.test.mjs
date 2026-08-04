import { describe, expect, test } from "bun:test";
import {
  parseArgs,
  isAgentClaim,
  lastActivity,
  parseTs,
  HEARTBEAT_LABEL,
  AGENT_LABEL_PREFIX,
} from "./reaper.mjs";

describe("reaper argument parser", () => {
  test("default arguments", () => {
    const opts = parseArgs([]);
    expect(opts.apply).toBe(false);
    expect(opts.minutes).toBe(45);
    expect(opts.team).toBeNull();
    expect(opts.anyAssignee).toBe(false);
    expect(opts.help).toBe(false);
  });

  test("parses flags correctly", () => {
    const opts = parseArgs([
      "--apply",
      "--minutes",
      "90",
      "--team",
      "CW",
      "--any-assignee",
    ]);
    expect(opts.apply).toBe(true);
    expect(opts.minutes).toBe(90);
    expect(opts.team).toBe("CW");
    expect(opts.anyAssignee).toBe(true);
  });
});

describe("isAgentClaim predicate", () => {
  test("returns true for ai:in-progress label", () => {
    const issue = {
      labels: { nodes: [{ name: HEARTBEAT_LABEL }] },
    };
    expect(isAgentClaim(issue)).toBe(true);
  });

  test("returns true for agent:* prefix label", () => {
    const issue = {
      labels: { nodes: [{ name: `${AGENT_LABEL_PREFIX}gemini` }] },
    };
    expect(isAgentClaim(issue)).toBe(true);
  });

  test("returns false for human work without agent labels", () => {
    const issue = {
      labels: { nodes: [{ name: "type:bug" }, { name: "area:infra" }] },
    };
    expect(isAgentClaim(issue)).toBe(false);
  });
});

describe("lastActivity timestamp parsing", () => {
  test("uses newest timestamp between startedAt and comments", () => {
    const issue = {
      startedAt: "2026-08-03T10:00:00Z",
      comments: {
        nodes: [{ createdAt: "2026-08-03T10:30:00Z" }],
      },
      updatedAt: "2026-08-03T09:00:00Z",
    };
    const activity = lastActivity(issue);
    expect(activity).toEqual(new Date("2026-08-03T10:30:00Z"));
  });

  test("falls back to updatedAt if no startedAt or comments", () => {
    const issue = {
      startedAt: null,
      comments: { nodes: [] },
      updatedAt: "2026-08-03T11:00:00Z",
    };
    const activity = lastActivity(issue);
    expect(activity).toEqual(new Date("2026-08-03T11:00:00Z"));
  });
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { latestReaperRunMs } from "./reaper.mjs";

describe("reaper run log discovery", () => {
  test("latestReaperRunMs picks the newest reaper log and ignores other files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reaper-"));
    writeFileSync(path.join(dir, "reaper-20260804-120000.log"), "old");
    writeFileSync(path.join(dir, "bj29-factory-merge-20260804-120000.jsonl"), "not a reaper log");
    const t0 = latestReaperRunMs(dir);
    expect(t0).not.toBeNull();
    writeFileSync(path.join(dir, "reaper-20260804-130000.log"), "new");
    expect(latestReaperRunMs(dir)).toBeGreaterThanOrEqual(t0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("latestReaperRunMs returns null when the dir is missing or empty", () => {
    expect(latestReaperRunMs("/no/such/dir")).toBeNull();
    const dir = mkdtempSync(path.join(tmpdir(), "reaper-"));
    expect(latestReaperRunMs(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

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

import { buildIssueFilter } from "./reaper.mjs";

describe("issue fetch filter (OPS-63)", () => {
  test("default filter is the union of the heartbeat label and In Progress state", () => {
    const f = buildIssueFilter();
    // Both halves present: a ticket claimed with only `agent:*` sits in
    // In Progress with no heartbeat label, and must still be fetched.
    expect(f).toContain(`labels: { name: { eq: "${HEARTBEAT_LABEL}" } }`);
    expect(f).toContain(`state: { name: { eq: "In Progress" } }`);
    expect(f.startsWith("or: [")).toBe(true);
  });

  test("default filter no longer excludes agent-labelled tickets lacking the heartbeat label", () => {
    // The regression itself: the old filter was the label clause ALONE, so a
    // ticket isAgentClaim() accepts via `agent:*` was never returned.
    const agentOnly = { labels: { nodes: [{ name: "agent:claude-code" }] }, state: { name: "In Progress" } };
    expect(isAgentClaim(agentOnly)).toBe(true);
    expect(buildIssueFilter()).not.toBe(`labels: { name: { eq: "${HEARTBEAT_LABEL}" } }`);
  });

  test("--any-assignee still queries by state alone, so it can surface human work", () => {
    const f = buildIssueFilter(null, true);
    expect(f).toBe(`state: { name: { eq: "In Progress" } }`);
    expect(f).not.toContain(HEARTBEAT_LABEL);
  });

  test("team scoping is ANDed onto both variants", () => {
    expect(buildIssueFilter("CLNT")).toContain(`team: { key: { eq: "CLNT" } }`);
    expect(buildIssueFilter("CW", true)).toContain(`team: { key: { eq: "CW" } }`);
    expect(buildIssueFilter(null)).not.toContain("team:");
  });
});

import {
  computeReclaimLabelIds,
  reclaim,
  AGENT_READY_LABEL,
} from "./reaper.mjs";
import {
  countPriorDispatchFailures,
  isRepeatedDispatchFailure,
  computeUnclaimAction,
  preserveWip,
  DISPATCH_FAILURE_THRESHOLD,
} from "./tick.mjs";
import { spawnSync } from "node:child_process";

describe("reclaim label computation (WM-14)", () => {
  test("restores ai:agent-ready when returning In Progress ticket to Todo", () => {
    const issue = {
      labels: {
        nodes: [
          { id: "lbl-prog", name: HEARTBEAT_LABEL },
          { id: "lbl-agent", name: "agent:claude-code" },
          { id: "lbl-bug", name: "type:bug" },
        ],
      },
    };
    const kept = computeReclaimLabelIds(issue, true, "lbl-ready");
    expect(kept).toEqual(["lbl-bug", "lbl-ready"]);
    expect(kept).not.toContain("lbl-prog");
    expect(kept).not.toContain("lbl-agent");
  });

  test("does not duplicate ai:agent-ready if already present on issue", () => {
    const issue = {
      labels: {
        nodes: [
          { id: "lbl-prog", name: HEARTBEAT_LABEL },
          { id: "lbl-ready", name: AGENT_READY_LABEL },
          { id: "lbl-bug", name: "type:bug" },
        ],
      },
    };
    const kept = computeReclaimLabelIds(issue, true, "lbl-ready");
    expect(kept).toEqual(["lbl-ready", "lbl-bug"]);
  });

  test("does NOT add ai:agent-ready when clearing claim markers on non-In Progress ticket (e.g. Triage)", () => {
    const issue = {
      labels: {
        nodes: [
          { id: "lbl-prog", name: HEARTBEAT_LABEL },
          { id: "lbl-agent", name: "agent:claude-code" },
          { id: "lbl-triage", name: "area:infra" },
        ],
      },
    };
    const kept = computeReclaimLabelIds(issue, false, "lbl-ready");
    expect(kept).toEqual(["lbl-triage"]);
    expect(kept).not.toContain("lbl-ready");
    expect(kept).not.toContain("lbl-prog");
  });

  test("reclaim dry-run returns payload with restored ai:agent-ready when returning to Todo", async () => {
    const issue = {
      id: "iss-1",
      labels: {
        nodes: [
          { id: "lbl-prog", name: HEARTBEAT_LABEL },
          { id: "lbl-bug", name: "type:bug" },
        ],
      },
    };
    const res = await reclaim(issue, "state-todo", 45, false, false, "lbl-ready");
    expect(res).toBeDefined();
    expect(res.stateId).toBe("state-todo");
    expect(res.labelIds).toContain("lbl-ready");
    expect(res.labelIds).toContain("lbl-bug");
    expect(res.labelIds).not.toContain("lbl-prog");
  });
});

describe("dispatch unclaim & repeated failure detection (WM-14 & WM-12)", () => {
  test("countPriorDispatchFailures counts consecutive dispatch failure comments", () => {
    const comments = [
      { body: "Claimed ticket", createdAt: "2026-08-01T10:00:00Z" },
      { body: "Dispatch run failed, claim released back to Todo.\n\n**Why:** fail 1", createdAt: "2026-08-01T10:05:00Z" },
      { body: "Dispatch run failed, claim released back to Todo.\n\n**Why:** fail 2", createdAt: "2026-08-01T10:10:00Z" },
    ];
    expect(countPriorDispatchFailures(comments)).toBe(2);
    expect(isRepeatedDispatchFailure(comments, 3)).toBe(true); // 2 prior + 1 current = 3 >= 3
  });

  test("countPriorDispatchFailures resets streak on intervening non-failure comment", () => {
    const comments = [
      { body: "Dispatch run failed, claim released back to Todo.", createdAt: "2026-08-01T09:00:00Z" },
      { body: "Dispatch run failed, claim released back to Todo.", createdAt: "2026-08-01T09:10:00Z" },
      { body: "Human checked and fixed repo config", createdAt: "2026-08-01T09:20:00Z" },
      { body: "Dispatch run failed, claim released back to Todo.", createdAt: "2026-08-01T09:30:00Z" },
    ];
    expect(countPriorDispatchFailures(comments)).toBe(1);
    expect(isRepeatedDispatchFailure(comments, 3)).toBe(false); // 1 prior + 1 current = 2 < 3
  });

  test("computeUnclaimAction restores ai:agent-ready when returning to Todo under failure threshold", () => {
    const allLabels = [
      { id: "lbl-ready", name: "ai:agent-ready" },
      { id: "lbl-blocked", name: "ai:blocked" },
      { id: "lbl-prog", name: "ai:in-progress" },
      { id: "lbl-agent", name: "agent:claude-code" },
    ];
    const issue = {
      labels: {
        nodes: [
          { id: "lbl-prog", name: "ai:in-progress" },
          { id: "lbl-agent", name: "agent:claude-code" },
          { id: "lbl-feat", name: "type:feature" },
        ],
      },
      comments: {
        nodes: [
          { body: "Dispatch run failed, claim released back to Todo.", createdAt: "2026-08-01T10:00:00Z" },
        ],
      },
    };
    const action = computeUnclaimAction({
      issue,
      why: "test suite timeout",
      log: null,
      todoStateId: "state-todo",
      blockedStateId: "state-blocked",
      allLabels,
      threshold: 3,
    });
    expect(action.repeated).toBe(false);
    expect(action.totalFailures).toBe(2);
    expect(action.stateId).toBe("state-todo");
    expect(action.labelIds).toContain("lbl-ready");
    expect(action.labelIds).toContain("lbl-feat");
    expect(action.labelIds).not.toContain("lbl-prog");
    expect(action.labelIds).not.toContain("lbl-agent");
    expect(action.labelIds).not.toContain("lbl-blocked");
    expect(action.commentBody).toContain("claim released back to Todo");
  });

  test("computeUnclaimAction demotes to Blocked with ai:blocked on repeated dispatch failures (>= 3)", () => {
    const allLabels = [
      { id: "lbl-ready", name: "ai:agent-ready" },
      { id: "lbl-blocked", name: "ai:blocked" },
      { id: "lbl-prog", name: "ai:in-progress" },
      { id: "lbl-agent", name: "agent:claude-code" },
    ];
    const issue = {
      labels: {
        nodes: [
          { id: "lbl-prog", name: "ai:in-progress" },
          { id: "lbl-agent", name: "agent:claude-code" },
          { id: "lbl-feat", name: "type:feature" },
        ],
      },
      comments: {
        nodes: [
          { body: "Dispatch run failed, claim released back to Todo.", createdAt: "2026-08-01T10:00:00Z" },
          { body: "Dispatch run failed, claim released back to Todo.", createdAt: "2026-08-01T10:05:00Z" },
        ],
      },
    };
    const action = computeUnclaimAction({
      issue,
      why: "worktree-up failed",
      log: "/Users/test/.factory/logs/test.jsonl",
      todoStateId: "state-todo",
      blockedStateId: "state-blocked",
      allLabels,
      threshold: 3,
    });
    expect(action.repeated).toBe(true);
    expect(action.totalFailures).toBe(3);
    expect(action.stateId).toBe("state-blocked");
    expect(action.labelIds).toContain("lbl-blocked");
    expect(action.labelIds).toContain("lbl-feat");
    expect(action.labelIds).not.toContain("lbl-ready");
    expect(action.labelIds).not.toContain("lbl-prog");
    expect(action.labelIds).not.toContain("lbl-agent");
    expect(action.commentBody).toContain("Dispatch run failed repeatedly (3 consecutive dispatch failures), moved to Blocked");
    expect(action.commentBody).toContain("ai:blocked");
  });
});

describe("WIP preservation (WM-12)", () => {
  test("preserveWip returns no-op when worktree does not exist", () => {
    const res = preserveWip("/no/such/worktree/path", "WM-12");
    expect(res.preserved).toBe(false);
    expect(res.reason).toBe("no_worktree");
  });

  test("preserveWip returns clean when worktree is clean", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wip-clean-"));
    spawnSync("git", ["init"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    writeFileSync(path.join(dir, "file.txt"), "committed content\n");
    spawnSync("git", ["add", "file.txt"], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

    const res = preserveWip(dir, "WM-12");
    expect(res.preserved).toBe(false);
    expect(res.reason).toBe("clean");
    rmSync(dir, { recursive: true, force: true });
  });

  test("preserveWip commits uncommitted modifications and untracked files safely", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wip-dirty-"));
    spawnSync("git", ["init"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    writeFileSync(path.join(dir, "file.txt"), "initial\n");
    spawnSync("git", ["add", "file.txt"], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

    // Make worktree dirty with both modification and new file
    writeFileSync(path.join(dir, "file.txt"), "initial + edits\n");
    writeFileSync(path.join(dir, "new-wip.txt"), "wip file\n");

    const res = preserveWip(dir, "CLNT-518");
    expect(res.preserved).toBe(true);
    expect(res.method).toBe("commit");
    expect(res.message).toBe("wip: CLNT-518 uncommitted progress");
    expect(res.hash).toBeDefined();

    // Verify git log and clean status
    const log = spawnSync("git", ["log", "-1", "--pretty=%B"], { cwd: dir, encoding: "utf8" });
    expect(log.stdout.trim()).toBe("wip: CLNT-518 uncommitted progress");

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });
});

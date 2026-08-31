import { describe, expect, test } from "bun:test";
import {
  parseArgs,
  isAgentClaim,
  lastActivity,
  parseTs,
  HEARTBEAT_LABEL,
  AGENT_LABEL_PREFIX,
  gql,
} from "./reaper.mjs";

describe("Linear GraphQL cancellation", () => {
  test("forwards an AbortSignal to fetch and stops retrying when aborted", async () => {
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.LINEAR_API_KEY;
    const previousAllow = process.env.FACTORY_LINEAR_ALLOW_NETWORK;
    const controller = new AbortController();
    let observed;
    process.env.LINEAR_API_KEY = "test-key";
    process.env.FACTORY_LINEAR_ALLOW_NETWORK = "1";
    globalThis.fetch = (_url, options) => {
      observed = options.signal;
      return new Promise((_, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    };

    try {
      const request = gql(
        "query { ping }",
        {},
        {
          retries: 1,
          signal: controller.signal,
        },
      );
      controller.abort(new Error("timeout"));
      await expect(request).rejects.toThrow("timeout");
      expect(observed).toBe(controller.signal);
      expect(observed.aborted).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousKey;
      if (previousAllow === undefined)
        delete process.env.FACTORY_LINEAR_ALLOW_NETWORK;
      else process.env.FACTORY_LINEAR_ALLOW_NETWORK = previousAllow;
    }
  });
});

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
    writeFileSync(
      path.join(dir, "bj29-factory-merge-20260804-120000.jsonl"),
      "not a reaper log",
    );
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
    const agentOnly = {
      labels: { nodes: [{ name: "agent:claude-code" }] },
      state: { name: "In Progress" },
    };
    expect(isAgentClaim(agentOnly)).toBe(true);
    expect(buildIssueFilter()).not.toBe(
      `labels: { name: { eq: "${HEARTBEAT_LABEL}" } }`,
    );
  });

  test("--any-assignee still queries by state alone, so it can surface human work", () => {
    const f = buildIssueFilter(null, true);
    expect(f).toBe(`state: { name: { eq: "In Progress" } }`);
    expect(f).not.toContain(HEARTBEAT_LABEL);
  });

  test("team scoping is ANDed onto both variants", () => {
    expect(buildIssueFilter("CLNT")).toContain(`team: { key: { eq: "CLNT" } }`);
    expect(buildIssueFilter("CW", true)).toContain(
      `team: { key: { eq: "CW" } }`,
    );
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
import { memoryControlPlane } from "../lib/control-plane/memory.mjs";
import { runReaper } from "./reaper.mjs";
import { Database } from "bun:sqlite";
import { reapDeadDispatchWorktrees, ticketHasLiveRun } from "./reaper.mjs";
import { reapDeadWorkers, workerIsPrunable, localPidAlive } from "./reaper.mjs";
import { HEARTBEAT_STALE_MS } from "../event-runtime/lib/workers.mjs";

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
    const res = await reclaim(
      issue,
      "state-todo",
      45,
      false,
      false,
      "lbl-ready",
    );
    expect(res).toBeDefined();
    expect(res.stateId).toBe("state-todo");
    expect(res.labelIds).toContain("lbl-ready");
    expect(res.labelIds).toContain("lbl-bug");
    expect(res.labelIds).not.toContain("lbl-prog");
  });
});

const REAPER_NOW = new Date("2026-08-28T12:00:00Z");
const staleAt = "2026-08-28T10:00:00Z";

function reaperPlane(ticket, kind = "memory") {
  const cp = memoryControlPlane({
    team: { id: "team-wm", key: "WM" },
    labels: [
      { id: "ready", name: "ai:agent-ready" },
      { id: "progress", name: "ai:in-progress" },
      { id: "agent", name: "agent:claude-code" },
      { id: "bug", name: "type:bug" },
    ],
    tickets: [ticket],
  });
  cp.kind = kind;
  return cp;
}

function staleClaim(overrides = {}) {
  return {
    id: "ticket-1",
    identifier: "WM-1",
    title: "abandoned work",
    state: { id: "s-progress", name: "In Progress" },
    assignee: { id: "agent", name: "Agent" },
    team: { key: "WM" },
    project: { name: "Factory" },
    labels: [
      { id: "progress", name: "ai:in-progress" },
      { id: "agent", name: "agent:claude-code" },
      { id: "bug", name: "type:bug" },
    ],
    updatedAt: staleAt,
    ...overrides,
  };
}

function reaperArgs(...argv) {
  return parseArgs(["--minutes", "45", ...argv]);
}

async function runWithPlanes(args, planes) {
  const selected = [];
  const logs = [];
  const repos = new Map(
    Object.keys(planes).map((name) => [
      name,
      { name, team: "WM", project: "Factory" },
    ]),
  );
  const totals = await runReaper(args, {
    repos,
    loadPlane({ repoName }) {
      selected.push(repoName);
      return planes[repoName];
    },
    now: REAPER_NOW,
    emit: async () => {},
    log: (...parts) => logs.push(parts.join(" ")),
  });
  return { selected, logs, totals };
}

describe("plane-aware reaper (GH-1044)", () => {
  test("selects an adapter for every configured GitHub and Linear repository", async () => {
    const github = reaperPlane(
      staleClaim({ identifier: "acme/widget#1" }),
      "github",
    );
    const linear = reaperPlane(staleClaim({ identifier: "WM-2" }), "linear");
    const { selected } = await runWithPlanes(reaperArgs(), { github, linear });
    expect(selected).toEqual(["github", "linear"]);
    expect(github.calls.some((c) => c.op === "listTickets")).toBe(true);
    expect(linear.calls.some((c) => c.op === "listTickets")).toBe(true);
  });

  test("dry-run reports a stale GitHub claim without mutating it", async () => {
    const cp = reaperPlane(
      staleClaim({ identifier: "acme/widget#1" }),
      "github",
    );
    const { logs } = await runWithPlanes(reaperArgs(), { github: cp });
    expect(logs.join("\n")).toContain("STALE acme/widget#1");
    expect(
      cp.calls.some((c) =>
        ["transition", "setLabels", "comment"].includes(c.op),
      ),
    ).toBe(false);
  });

  test("apply returns a stale GitHub implementation claim to ready Todo", async () => {
    const cp = reaperPlane(
      staleClaim({ identifier: "acme/widget#1" }),
      "github",
    );
    await runWithPlanes(reaperArgs("--apply"), { github: cp });
    const ticket = cp.seed.tickets[0];
    expect(ticket.state.name).toBe("Todo");
    expect(ticket.assignee).toBeNull();
    expect(ticket.labels.map((l) => l.name)).toContain("ai:agent-ready");
    expect(ticket.labels.map((l) => l.name)).not.toContain("ai:in-progress");
    expect(ticket.comments[0].body).toContain(
      "Reclaimed by the stale-claim reaper",
    );
  });

  test("a human In Progress ticket without claim markers is never mutated", async () => {
    const cp = reaperPlane(
      staleClaim({ labels: [{ id: "bug", name: "type:bug" }] }),
      "github",
    );
    await runWithPlanes(reaperArgs("--apply", "--any-assignee"), {
      github: cp,
    });
    expect(
      cp.calls.some((c) =>
        ["transition", "setLabels", "comment"].includes(c.op),
      ),
    ).toBe(false);
  });

  test("a stale marker outside In Progress only loses claim labels", async () => {
    const cp = reaperPlane(
      staleClaim({ state: { id: "s-triage", name: "Triage" } }),
      "github",
    );
    await runWithPlanes(reaperArgs("--apply"), { github: cp });
    const ticket = cp.seed.tickets[0];
    expect(ticket.state.name).toBe("Triage");
    expect(ticket.assignee).toEqual({ id: "agent", name: "Agent" });
    expect(ticket.labels.map((l) => l.name)).toEqual(["type:bug"]);
    expect(ticket.comments ?? []).toEqual([]);
  });

  test("Linear marker cleanup still sees canceled/custom states", async () => {
    const cp = reaperPlane(
      staleClaim({ state: { id: "s-canceled", name: "Canceled" } }),
      "linear",
    );
    await runWithPlanes(reaperArgs("--apply"), { linear: cp });
    const ticket = cp.seed.tickets[0];
    expect(ticket.state.name).toBe("Canceled");
    expect(ticket.labels.map((l) => l.name)).toEqual(["type:bug"]);
    expect(ticket.comments ?? []).toEqual([]);
  });

  test("an open PR protects the claim and lookup failure also fails closed", async () => {
    const protectedCp = reaperPlane(
      staleClaim({ openPullRequest: true }),
      "github",
    );
    const failingCp = reaperPlane(
      staleClaim({ identifier: "acme/widget#2" }),
      "github",
    );
    failingCp.hasOpenPullRequest = async () => {
      throw new Error("forge unavailable");
    };
    const { logs, totals } = await runWithPlanes(reaperArgs("--apply"), {
      protected: protectedCp,
      failing: failingCp,
    });
    expect(logs.join("\n")).toContain("open pull request");
    expect(logs.join("\n")).toContain("failed closed: forge unavailable");
    expect(totals.failed).toBe(1);
    expect(totals.considered).toBe(0);
    expect(logs.filter((line) => line.includes("STALE"))).toEqual([]);
    for (const cp of [protectedCp, failingCp]) {
      expect(
        cp.calls.some((c) =>
          ["transition", "setLabels", "comment"].includes(c.op),
        ),
      ).toBe(false);
    }
  });
});

describe("dispatch unclaim & repeated failure detection (WM-14 & WM-12)", () => {
  test("countPriorDispatchFailures counts consecutive dispatch failure comments", () => {
    const comments = [
      { body: "Claimed ticket", createdAt: "2026-08-01T10:00:00Z" },
      {
        body: "Dispatch run failed, claim released back to Todo.\n\n**Why:** fail 1",
        createdAt: "2026-08-01T10:05:00Z",
      },
      {
        body: "Dispatch run failed, claim released back to Todo.\n\n**Why:** fail 2",
        createdAt: "2026-08-01T10:10:00Z",
      },
    ];
    expect(countPriorDispatchFailures(comments)).toBe(2);
    expect(isRepeatedDispatchFailure(comments, 3)).toBe(true); // 2 prior + 1 current = 3 >= 3
  });

  test("countPriorDispatchFailures resets streak on intervening non-failure comment", () => {
    const comments = [
      {
        body: "Dispatch run failed, claim released back to Todo.",
        createdAt: "2026-08-01T09:00:00Z",
      },
      {
        body: "Dispatch run failed, claim released back to Todo.",
        createdAt: "2026-08-01T09:10:00Z",
      },
      {
        body: "Human checked and fixed repo config",
        createdAt: "2026-08-01T09:20:00Z",
      },
      {
        body: "Dispatch run failed, claim released back to Todo.",
        createdAt: "2026-08-01T09:30:00Z",
      },
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
          {
            body: "Dispatch run failed, claim released back to Todo.",
            createdAt: "2026-08-01T10:00:00Z",
          },
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
          {
            body: "Dispatch run failed, claim released back to Todo.",
            createdAt: "2026-08-01T10:00:00Z",
          },
          {
            body: "Dispatch run failed, claim released back to Todo.",
            createdAt: "2026-08-01T10:05:00Z",
          },
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
    expect(action.commentBody).toContain(
      "Dispatch run failed repeatedly (3 consecutive dispatch failures), moved to Blocked",
    );
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
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
    });
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
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
    });
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
    const log = spawnSync("git", ["log", "-1", "--pretty=%B"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(log.stdout.trim()).toBe("wip: CLNT-518 uncommitted progress");

    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(status.stdout.trim()).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("dead-dispatch worktree reaper (WM-1066)", () => {
  const DB_FILE = "/runtime/factory.db";
  const repos = () =>
    new Map([
      [
        "factory",
        {
          name: "factory",
          path: "/repo/factory",
          worktreeRoot: "/wt/factory",
          worktreeDown: "bin/worktree-down.sh",
        },
      ],
    ]);

  function ledgerWith(runs) {
    const db = new Database(":memory:");
    db.run(
      `CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        idempotency_key TEXT,
        spec_json TEXT,
        spec_hash TEXT,
        state TEXT,
        attempts INTEGER,
        created_at TEXT,
        updated_at TEXT
      )`,
    );
    const insert = db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of runs) {
      const spec = {
        input: { repo: r.repo, ticket: r.ticket },
        workspace: { type: r.workspace ?? "worktree" },
        maxAttempts: r.maxAttempts ?? 1,
      };
      insert.run(
        r.runId,
        `${r.runId}-key`,
        JSON.stringify(spec),
        "hash",
        r.state,
        r.attempts ?? 0,
        "2026-08-29T00:00:00Z",
        "2026-08-29T00:00:00Z",
      );
    }
    return db;
  }

  function reapWith(db, args, overrides = {}) {
    const spawned = [];
    const logs = [];
    const promise = reapDeadDispatchWorktrees(args, {
      repos: repos(),
      databasePath: DB_FILE,
      openDatabase: () => db,
      fileExists: (p) => p === DB_FILE || p === "/wt/factory/WM-1066",
      spawn: (cmd, argv, opts) => {
        spawned.push({ cmd, argv, opts });
        return { status: 0, stdout: "", stderr: "" };
      },
      log: (...parts) => logs.push(parts.join(" ")),
      ...overrides,
    });
    return { promise, spawned, logs };
  }

  test("tears down the stale worktree of an attempts-exhausted FAILED dispatch", async () => {
    const db = ledgerWith([
      {
        runId: "run_dead",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 1,
        maxAttempts: 1,
      },
    ]);
    const { promise, spawned } = reapWith(db, parseArgs(["--apply"]));
    const totals = await promise;
    expect(totals.cleaned).toBe(1);
    expect(totals.failed).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe("/bin/bash");
    expect(spawned[0].argv).toEqual([
      "/repo/factory/bin/worktree-down.sh",
      "WM-1066",
    ]);
    // Never --force: a dirty or unpushed tree must refuse, not be nuked.
    expect(spawned[0].argv).not.toContain("--force");
    expect(spawned[0].opts.cwd).toBe("/repo/factory");
  });

  test("dry run reports the reclaimable worktree without spawning teardown", async () => {
    const db = ledgerWith([
      {
        runId: "run_dead",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 1,
        maxAttempts: 1,
      },
    ]);
    const { promise, spawned, logs } = reapWith(db, parseArgs([]));
    const totals = await promise;
    expect(totals.considered).toBe(1);
    expect(totals.cleaned).toBe(0);
    expect(spawned).toHaveLength(0);
    expect(logs.join("\n")).toContain("STALE factory/WM-1066");
  });

  test("a still-retryable FAILED dispatch keeps its worktree (not attempts-exhausted)", async () => {
    const db = ledgerWith([
      {
        runId: "run_retryable",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 0,
        maxAttempts: 1,
      },
    ]);
    const { promise, spawned } = reapWith(db, parseArgs(["--apply"]));
    const totals = await promise;
    expect(totals.considered).toBe(0);
    expect(totals.cleaned).toBe(0);
    expect(spawned).toHaveLength(0);
  });

  test("a live run for the same ticket holds the worktree", async () => {
    const db = ledgerWith([
      {
        runId: "run_dead",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 1,
        maxAttempts: 1,
      },
      {
        runId: "run_live",
        repo: "factory",
        ticket: "WM-1066",
        state: "RUNNING",
        attempts: 1,
        maxAttempts: 1,
      },
    ]);
    const { promise, spawned, logs } = reapWith(db, parseArgs(["--apply"]));
    const totals = await promise;
    expect(totals.held).toBe(1);
    expect(totals.cleaned).toBe(0);
    expect(spawned).toHaveLength(0);
    expect(logs.join("\n")).toContain("a live run still owns");
  });

  test("an open pull request protects the worktree and lookup failure fails closed", async () => {
    const db = ledgerWith([
      {
        runId: "run_dead",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 1,
        maxAttempts: 1,
      },
    ]);
    const held = reapWith(db, parseArgs(["--apply"]), {
      hasOpenPullRequest: async () => true,
    });
    const heldTotals = await held.promise;
    expect(heldTotals.held).toBe(1);
    expect(heldTotals.cleaned).toBe(0);
    expect(held.spawned).toHaveLength(0);

    const db2 = ledgerWith([
      {
        runId: "run_dead",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 1,
        maxAttempts: 1,
      },
    ]);
    const failing = reapWith(db2, parseArgs(["--apply"]), {
      hasOpenPullRequest: async () => {
        throw new Error("forge unavailable");
      },
    });
    const failingTotals = await failing.promise;
    expect(failingTotals.failed).toBe(1);
    expect(failingTotals.cleaned).toBe(0);
    expect(failing.spawned).toHaveLength(0);
    expect(failing.logs.join("\n")).toContain(
      "failed closed: forge unavailable",
    );
  });

  test("no runtime ledger on disk is a safe no-op", async () => {
    const db = ledgerWith([]);
    let spawned = 0;
    const totals = await reapDeadDispatchWorktrees(parseArgs(["--apply"]), {
      repos: repos(),
      databasePath: DB_FILE,
      openDatabase: () => db,
      fileExists: () => false,
      spawn: () => {
        spawned += 1;
        return { status: 0 };
      },
      log: () => {},
    });
    expect(totals).toEqual({
      considered: 0,
      cleaned: 0,
      held: 0,
      failed: 0,
    });
    expect(spawned).toBe(0);
  });

  test("ticketHasLiveRun ignores the exhausted dead run but sees a queued sibling", () => {
    const db = ledgerWith([
      {
        runId: "run_dead",
        repo: "factory",
        ticket: "WM-1066",
        state: "FAILED",
        attempts: 1,
        maxAttempts: 1,
      },
    ]);
    expect(ticketHasLiveRun(db, "factory", "WM-1066")).toBe(false);
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_queued",
      "run_queued-key",
      JSON.stringify({
        input: { repo: "factory", ticket: "WM-1066" },
        workspace: { type: "worktree" },
        maxAttempts: 1,
      }),
      "hash",
      "QUEUED",
      0,
      "2026-08-29T00:00:00Z",
      "2026-08-29T00:00:00Z",
    );
    expect(ticketHasLiveRun(db, "factory", "WM-1066")).toBe(true);
  });
});

describe("dead-worker registry prune (WM-1125)", () => {
  const DB_FILE = "/runtime/factory.db";
  const HOST = "operator-box";
  const NOW = Date.parse("2026-08-29T12:00:00Z");
  const fresh = new Date(NOW - 5_000).toISOString(); // 5s ago — heartbeating
  const laggy = new Date(NOW - (HEARTBEAT_STALE_MS - 5_000)).toISOString(); // just inside window
  const expired = new Date(NOW - 60 * 60 * 1000).toISOString(); // an hour ago

  function registryWith(rows) {
    const db = new Database(":memory:");
    db.run(
      `CREATE TABLE workers (
        worker_id   TEXT PRIMARY KEY,
        host        TEXT NOT NULL,
        pid         INTEGER NOT NULL,
        labels_json TEXT NOT NULL DEFAULT '{}',
        adapters    TEXT NOT NULL DEFAULT '',
        started_at  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'idle',
        current_run TEXT,
        stopped_at  TEXT
      )`,
    );
    const insert = db.query(
      `INSERT INTO workers (worker_id, host, pid, started_at, last_seen, state, current_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.worker_id,
        r.host ?? HOST,
        r.pid,
        r.started_at ?? r.last_seen,
        r.last_seen,
        r.state ?? "idle",
        r.current_run ?? null,
      );
    }
    return db;
  }

  function reapWith(db, args, overrides = {}) {
    const logs = [];
    // Keep the in-memory db open so the test can inspect it after the reap;
    // production still closes the handle it opens.
    db.close = () => {};
    const totals = reapDeadWorkers(args, {
      databasePath: DB_FILE,
      openDatabase: () => db,
      fileExists: (p) => p === DB_FILE,
      now: NOW,
      localHost: HOST,
      // Default: every pid is dead unless the row opts into `alivePids`.
      pidAlive: (pid) => (overrides.alivePids ?? []).includes(pid),
      log: (...parts) => logs.push(parts.join(" ")),
      ...overrides,
    });
    return { totals, logs };
  }

  test("prunes a table of live + dead rows down to only the live set", () => {
    const db = registryWith([
      // live: fresh heartbeat, pid running
      { worker_id: "live-1", pid: 1001, last_seen: fresh, state: "idle" },
      { worker_id: "live-2", pid: 1002, last_seen: fresh, state: "busy" },
      // dead: crashed process, heartbeat long expired
      { worker_id: "dead-idle", pid: 2001, last_seen: expired, state: "idle" },
      {
        worker_id: "dead-busy",
        pid: 2002,
        last_seen: expired,
        state: "busy",
        current_run: "run_terminal",
      },
      {
        worker_id: "dead-stop",
        pid: 2003,
        last_seen: expired,
        state: "stopped",
      },
    ]);
    const { totals } = reapWith(db, parseArgs(["--apply"]), {
      alivePids: [1001, 1002],
    });
    expect(totals.pruned).toBe(3);
    expect(totals.live).toBe(2);
    const remaining = db
      .query(`SELECT worker_id FROM workers ORDER BY worker_id`)
      .all()
      .map((r) => r.worker_id);
    expect(remaining).toEqual(["live-1", "live-2"]);
  });

  test("never prunes a worker whose heartbeat briefly lagged within the threshold", () => {
    const db = registryWith([
      // pid reported dead, but heartbeat is still inside the stale window
      { worker_id: "lagging", pid: 3001, last_seen: laggy, state: "busy" },
    ]);
    const { totals } = reapWith(db, parseArgs(["--apply"]), { alivePids: [] });
    expect(totals.pruned).toBe(0);
    expect(totals.live).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM workers`).get().n).toBe(1);
  });

  test("keeps a hung-but-alive local process (expired heartbeat, pid still up)", () => {
    const db = registryWith([
      { worker_id: "hung", pid: 4001, last_seen: expired, state: "busy" },
    ]);
    const { totals } = reapWith(db, parseArgs(["--apply"]), {
      alivePids: [4001],
    });
    expect(totals.pruned).toBe(0);
    expect(totals.live).toBe(1);
  });

  test("prunes an expired remote worker whose pid cannot be probed from here", () => {
    const db = registryWith([
      {
        worker_id: "remote-dead",
        host: "worker-node-2",
        pid: 5001,
        last_seen: expired,
        state: "idle",
      },
    ]);
    // pidAlive would say alive for 5001, but it must not be consulted for a
    // different host — the row still prunes on its expired heartbeat alone.
    const { totals } = reapWith(db, parseArgs(["--apply"]), {
      alivePids: [5001],
    });
    expect(totals.pruned).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM workers`).get().n).toBe(0);
  });

  test("dry run reports the prunable rows without deleting anything", () => {
    const db = registryWith([
      { worker_id: "dead-1", pid: 6001, last_seen: expired, state: "idle" },
    ]);
    const { totals, logs } = reapWith(db, parseArgs([]), { alivePids: [] });
    expect(totals.considered).toBe(1);
    expect(totals.pruned).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM workers`).get().n).toBe(1);
    expect(logs.join("\n")).toContain("STALE worker dead-1");
  });

  test("no runtime registry on disk is a safe no-op", () => {
    const totals = reapDeadWorkers(parseArgs(["--apply"]), {
      databasePath: DB_FILE,
      openDatabase: () => {
        throw new Error("should not open");
      },
      fileExists: () => false,
      log: () => {},
    });
    expect(totals).toEqual({ considered: 0, pruned: 0, live: 0, failed: 0 });
  });

  test("workerIsPrunable gates on the heartbeat before the pid verdict", () => {
    // Fresh heartbeat is never prunable, whatever the pid probe says.
    expect(
      workerIsPrunable({ last_seen: fresh }, { now: NOW, alive: false }),
    ).toBe(false);
    // Expired + dead pid → prune; expired + alive pid → keep.
    expect(
      workerIsPrunable({ last_seen: expired }, { now: NOW, alive: false }),
    ).toBe(true);
    expect(
      workerIsPrunable({ last_seen: expired }, { now: NOW, alive: true }),
    ).toBe(false);
    // Expired + unprobeable (remote, alive undefined/null) → prune.
    expect(
      workerIsPrunable({ last_seen: expired }, { now: NOW, alive: null }),
    ).toBe(true);
  });

  test("localPidAlive: dead pid is false, EPERM-owned pid counts as alive", () => {
    expect(localPidAlive(999999)).toBe(false);
    expect(localPidAlive(0)).toBe(false);
    expect(localPidAlive(-1)).toBe(false);
    expect(localPidAlive(process.pid)).toBe(true);
    // A kernel EPERM means the process exists but is another user's — alive.
    const eperm = () => {
      const err = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    };
    expect(localPidAlive(4242, eperm)).toBe(true);
  });
});

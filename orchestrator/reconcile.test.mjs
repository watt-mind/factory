/**
 * bun test orchestrator/reconcile.test.mjs
 */
import { test, expect, describe } from "bun:test";
import {
  prNumbers,
  prState,
  settledLabelIds,
  evaluateTicketDrift,
  reconcileRepo,
  parseArgs,
  LIFECYCLE_LABELS,
} from "./reconcile.mjs";

describe("parseArgs", () => {
  test("parses default flags", () => {
    const opts = parseArgs([]);
    expect(opts.apply).toBe(false);
    expect(opts.gate).toBe(false);
    expect(opts.quietMin).toBe(25);
    expect(opts.only).toEqual([]);
  });

  test("parses provided arguments", () => {
    const opts = parseArgs(["--apply", "--gate", "--quiet-minutes", "40", "--repo", "bj29,legalease"]);
    expect(opts.apply).toBe(true);
    expect(opts.gate).toBe(true);
    expect(opts.quietMin).toBe(40);
    expect(opts.only).toEqual(["bj29", "legalease"]);
  });
});

describe("prNumbers", () => {
  test("extracts PR numbers matching repo github owner/name", () => {
    const issue = {
      attachments: {
        nodes: [
          { url: "https://github.com/watt-mind/factory/pull/110" },
          { url: "https://github.com/watt-mind/factory/pull/110" },
          { url: "https://github.com/other-org/other-repo/pull/999" },
          { url: "https://linear.app/issue/123" },
        ],
      },
    };
    expect(prNumbers(issue, "watt-mind/factory")).toEqual([110]);
  });

  test("returns empty array when no attachments match", () => {
    expect(prNumbers({}, "watt-mind/factory")).toEqual([]);
    expect(prNumbers({ attachments: { nodes: [] } }, "watt-mind/factory")).toEqual([]);
  });
});

describe("prState", () => {
  test("returns parsed JSON state, isDraft, and labels on exit 0", () => {
    const mockRun = () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        state: "OPEN",
        isDraft: false,
        labels: [{ name: "escalated" }],
      })),
    });
    const state = prState("watt-mind/factory", 110, mockRun);
    expect(state).toEqual({
      state: "OPEN",
      isDraft: false,
      labels: [{ name: "escalated" }],
    });
  });

  test("returns null on non-zero exit or invalid json", () => {
    expect(prState("watt-mind/factory", 110, () => ({ exitCode: 1, stdout: "" }))).toBeNull();
    expect(prState("watt-mind/factory", 110, () => ({ exitCode: 0, stdout: "invalid" }))).toBeNull();
  });
});

describe("settledLabelIds (WM-16)", () => {
  test("strips all lifecycle labels and preserves project/type labels", () => {
    const issue = {
      labels: {
        nodes: [
          { id: "1", name: "type:bug" },
          { id: "2", name: "area:infra" },
          { id: "3", name: "ai:in-progress" },
          { id: "4", name: "ai:needs-review" },
          { id: "5", name: "ai:agent-ready" },
          { id: "6", name: "ai:escalated" },
          { id: "7", name: "ai:blocked" },
          { id: "8", name: "agent:claude-code" },
          { id: "9", name: "source:agent" },
        ],
      },
    };
    const ids = settledLabelIds(issue);
    expect(ids).toEqual(["1", "2", "9"]);
  });
});

describe("evaluateTicketDrift (WM-11, WM-16)", () => {
  test("Done ticket with OPEN PR detects drift (WM-11)", () => {
    const issue = {
      identifier: "CLNT-522",
      state: { name: "Done", type: "completed" },
    };
    const prStates = [
      { number: 203, state: "OPEN", labels: [{ name: "escalated" }] },
    ];
    const res = evaluateTicketDrift(issue, "watt-mind/legalease", prStates);
    expect(res).not.toBeNull();
    expect(res.type).toBe("done-with-open-pr");
    expect(res.open).toEqual([203]);
    expect(res.isEscalated).toBe(true);
    expect(res.targetState).toBe("In Review");
  });

  test("Done ticket with MERGED/CLOSED PR detects no drift", () => {
    const issue = {
      identifier: "CLNT-522",
      state: { name: "Done", type: "completed" },
    };
    const prStates = [
      { number: 203, state: "MERGED", labels: [] },
    ];
    expect(evaluateTicketDrift(issue, "watt-mind/legalease", prStates)).toBeNull();
  });

  test.each(["In Review", "In Progress"])(
    "%s ticket with MERGED PR detects drift to Done",
    (stateName) => {
      const issue = {
        identifier: "CLNT-400",
        state: { name: stateName, type: "started" },
      };
      const prStates = [{ number: 100, state: "MERGED" }];

      const res = evaluateTicketDrift(issue, "watt-mind/legalease", prStates);
      expect(res).not.toBeNull();
      expect(res.type).toBe("merged-not-done");
      expect(res.merged).toEqual([100]);
      expect(res.targetState).toBe("Done");
    },
  );

  test.each(["Todo", "Triage", "Backlog", "Blocked"])(
    "%s ticket with MERGED PR is ignored",
    (stateName) => {
      const issue = {
        identifier: "CLNT-401",
        state: { name: stateName, type: "unstarted" },
      };
      const prStates = [{ number: 100, state: "MERGED" }];

      expect(evaluateTicketDrift(issue, "watt-mind/legalease", prStates)).toBeNull();
    },
  );

  test("In Progress ticket with OPEN PR and quiet time >= quietMin detects drift to In Review", () => {
    const issue = {
      identifier: "CLNT-415",
      state: { name: "In Progress", type: "started" },
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      comments: { nodes: [] },
    };
    const prStates = [
      { number: 150, state: "OPEN", labels: [] },
    ];
    const res = evaluateTicketDrift(issue, "watt-mind/legalease", prStates, { quietMin: 25 });
    expect(res).not.toBeNull();
    expect(res.type).toBe("in-progress-with-open-pr");
    expect(res.open).toEqual([150]);
    expect(res.targetState).toBe("In Review");
  });

  test("In Progress ticket with recent activity (< quietMin) is still active (not drift)", () => {
    const issue = {
      identifier: "CLNT-415",
      state: { name: "In Progress", type: "started" },
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      comments: { nodes: [] },
    };
    const prStates = [
      { number: 150, state: "OPEN", labels: [] },
    ];
    const res = evaluateTicketDrift(issue, "watt-mind/legalease", prStates, { quietMin: 25 });
    expect(res).not.toBeNull();
    expect(res.type).toBe("still-active");
  });
});

describe("reconcileRepo (WM-11)", () => {
  const repo = {
    name: "legalease",
    team: "CLNT",
    project: "LegalEase",
    github: "watt-mind/legalease",
  };

  const states = [
    { id: "s-in-review", name: "In Review", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
  ];

  const labels = [
    { id: "l-nr", name: "ai:needs-review" },
    { id: "l-esc", name: "ai:escalated" },
    { id: "l-bug", name: "type:bug" },
  ];

  test("detects Done ticket with open escalated PR and updates state and labels when applying (WM-11)", async () => {
    const issue = {
      id: "issue-1",
      identifier: "CLNT-522",
      title: "Something failed",
      state: { id: "s-done", name: "Done", type: "completed" },
      labels: { nodes: [{ id: "l-bug", name: "type:bug" }] },
      attachments: { nodes: [{ url: "https://github.com/watt-mind/legalease/pull/203" }] },
    };

    const mutations = [];
    const mockGql = async (q, vars) => {
      mutations.push({ query: q, vars });
      return { success: true };
    };

    const mockPrState = (repoPath, num) => ({
      state: "OPEN",
      isDraft: false,
      labels: [{ name: "escalated" }],
    });

    const res = await reconcileRepo(repo, { apply: true, gate: false }, {
      gql: mockGql,
      prState: mockPrState,
      issues: [issue],
      states,
      labels,
    });

    expect(res.drift).toBe(1);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0].type).toBe("done-with-open-pr");

    // Check issueUpdate mutation
    const updateMut = mutations.find((m) => m.query.includes("issueUpdate"));
    expect(updateMut).toBeDefined();
    expect(updateMut.vars.id).toBe("issue-1");
    expect(updateMut.vars.in.stateId).toBe("s-in-review");
    expect(updateMut.vars.in.labelIds).toContain("l-bug");
    expect(updateMut.vars.in.labelIds).toContain("l-nr");
    expect(updateMut.vars.in.labelIds).toContain("l-esc");

    // Check commentCreate mutation
    const commentMut = mutations.find((m) => m.query.includes("commentCreate"));
    expect(commentMut).toBeDefined();
    expect(commentMut.vars.in.body).toContain("WM-11");
    expect(commentMut.vars.in.body).toContain("ai:escalated");
  });

  test("gate mode reports drift without executing mutations", async () => {
    const issue = {
      id: "issue-1",
      identifier: "CLNT-522",
      title: "Something failed",
      state: { id: "s-done", name: "Done", type: "completed" },
      labels: { nodes: [] },
      attachments: { nodes: [{ url: "https://github.com/watt-mind/legalease/pull/203" }] },
    };

    const mutations = [];
    const mockGql = async (q, vars) => {
      mutations.push({ query: q, vars });
      return { success: true };
    };

    const res = await reconcileRepo(repo, { apply: false, gate: true }, {
      gql: mockGql,
      prState: () => ({ state: "OPEN", labels: [] }),
      issues: [issue],
      states,
      labels,
    });

    expect(res.drift).toBe(1);
    expect(mutations).toHaveLength(0);
  });
});

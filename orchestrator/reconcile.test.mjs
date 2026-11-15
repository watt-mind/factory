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
  fetchAllPages,
  parseFixesLines,
  evaluateFixesLines,
  recentMergedPrs,
  Q,
  Q_DONE,
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
    const opts = parseArgs([
      "--apply",
      "--gate",
      "--quiet-minutes",
      "40",
      "--repo",
      "bj29,legalease",
    ]);
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
    expect(
      prNumbers({ attachments: { nodes: [] } }, "watt-mind/factory"),
    ).toEqual([]);
  });
});

describe("prState", () => {
  test("returns parsed JSON state, isDraft, and labels on exit 0", () => {
    const mockRun = () => ({
      exitCode: 0,
      stdout: Buffer.from(
        JSON.stringify({
          state: "OPEN",
          isDraft: false,
          labels: [{ name: "escalated" }],
        }),
      ),
    });
    const state = prState("watt-mind/factory", 110, mockRun);
    expect(state).toEqual({
      state: "OPEN",
      isDraft: false,
      labels: [{ name: "escalated" }],
    });
  });

  test("returns null on non-zero exit or invalid json", () => {
    expect(
      prState("watt-mind/factory", 110, () => ({ exitCode: 1, stdout: "" })),
    ).toBeNull();
    expect(
      prState("watt-mind/factory", 110, () => ({
        exitCode: 0,
        stdout: "invalid",
      })),
    ).toBeNull();
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
    const prStates = [{ number: 203, state: "MERGED", labels: [] }];
    expect(
      evaluateTicketDrift(issue, "watt-mind/legalease", prStates),
    ).toBeNull();
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

      expect(
        evaluateTicketDrift(issue, "watt-mind/legalease", prStates),
      ).toBeNull();
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
    const prStates = [{ number: 150, state: "OPEN", labels: [] }];
    const res = evaluateTicketDrift(issue, "watt-mind/legalease", prStates, {
      quietMin: 25,
    });
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
    const prStates = [{ number: 150, state: "OPEN", labels: [] }];
    const res = evaluateTicketDrift(issue, "watt-mind/legalease", prStates, {
      quietMin: 25,
    });
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
      attachments: {
        nodes: [{ url: "https://github.com/watt-mind/legalease/pull/203" }],
      },
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

    const res = await reconcileRepo(
      repo,
      { apply: true, gate: false },
      {
        gql: mockGql,
        prState: mockPrState,
        issues: [issue],
        mergedPrs: [],
        states,
        labels,
      },
    );

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
      attachments: {
        nodes: [{ url: "https://github.com/watt-mind/legalease/pull/203" }],
      },
    };

    const mutations = [];
    const mockGql = async (q, vars) => {
      mutations.push({ query: q, vars });
      return { success: true };
    };

    const res = await reconcileRepo(
      repo,
      { apply: false, gate: true },
      {
        gql: mockGql,
        prState: () => ({ state: "OPEN", labels: [] }),
        issues: [issue],
        mergedPrs: [],
        states,
        labels,
      },
    );

    expect(res.drift).toBe(1);
    expect(mutations).toHaveLength(0);
  });
});

describe("reconcile pagination (WM-1139)", () => {
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
  const mk = (id, withPr) => ({
    id,
    identifier: id.toUpperCase(),
    title: id,
    state: { id: "s-in-review", name: "In Review", type: "started" },
    labels: { nodes: [] },
    attachments: {
      nodes: withPr
        ? [{ url: "https://github.com/watt-mind/legalease/pull/77" }]
        : [],
    },
  });

  test("evaluates tickets from page 2 of a two-page response", async () => {
    const seen = [];
    const gql = async (q, vars) => {
      if (q.includes("issueUpdate") || q.includes("commentCreate"))
        return { success: true };
      if (q === Q) {
        seen.push(vars.after);
        return vars.after === null
          ? {
              issues: {
                nodes: [mk("clnt-1", false)],
                pageInfo: { hasNextPage: true, endCursor: "cur-1" },
              },
            }
          : {
              issues: {
                nodes: [mk("clnt-2", true)],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            };
      }
      if (q === Q_DONE)
        return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
      return {};
    };
    const res = await reconcileRepo(
      repo,
      { apply: false, gate: true },
      {
        gql,
        states,
        mergedPrs: [],
        labels: [],
        prState: () => ({ state: "MERGED", isDraft: false, labels: [] }),
      },
    );
    expect(seen).toEqual([null, "cur-1"]);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0].type).toBe("merged-not-done");
    expect(res.actions[0].issue.identifier).toBe("CLNT-2");
  });

  test("stops at the page bound and warns", async () => {
    let calls = 0;
    const gql = async () => {
      calls++;
      return {
        issues: {
          nodes: [mk(`t-${calls}`, false)],
          pageInfo: { hasNextPage: true, endCursor: `c${calls}` },
        },
      };
    };
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(String(m));
    try {
      const nodes = await fetchAllPages(gql, Q, {}, 3, "open-ticket");
      expect(nodes).toHaveLength(3);
      expect(calls).toBe(3);
    } finally {
      console.warn = orig;
    }
    expect(warns.join("")).toContain("3-page bound");
  });
});

describe("Fixes lines on merged PRs (WM-1140)", () => {
  const repo = {
    name: "legalease",
    team: "CLNT",
    project: "LegalEase",
    github: "watt-mind/legalease",
    base: "develop",
  };
  const states = [
    { id: "s-in-review", name: "In Review", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
  ];
  const labels = [{ id: "l-bug", name: "type:bug" }];
  const lbl = (...names) => ({
    nodes: names.map((n) => ({ id: `id-${n}`, name: n })),
  });
  const mk = (identifier, stateName, type, labelNames = []) => ({
    id: `i-${identifier}`,
    identifier,
    title: `t ${identifier}`,
    state: { id: "x", name: stateName, type },
    labels: lbl(...labelNames),
    attachments: { nodes: [] },
  });
  const pr = (number, body, extra = {}) => ({
    number,
    body,
    mergedAt: "2026-11-12T10:00:00Z",
    baseRefName: "develop",
    ...extra,
  });
  const run = async (issues, mergedPrs, opts = { apply: true }) => {
    const mutations = [];
    const res = await reconcileRepo(repo, opts, {
      gql: async (q, v) => {
        mutations.push({ query: q, vars: v });
        return { success: true };
      },
      prState: () => ({}),
      issues,
      mergedPrs,
      states,
      labels,
    });
    return { res, mutations };
  };

  describe("parseFixesLines", () => {
    test("matches Fixes/Closes/Resolves in any case, one per own line", () => {
      const body =
        "Summary\n\nFixes CLNT-1\ncloses clnt-2.\nRESOLVES CLNT-3\n- Fixes CLNT-4\n";
      expect(parseFixesLines(body).map((m) => m.id)).toEqual([
        "CLNT-1",
        "CLNT-2",
        "CLNT-3",
        "CLNT-4",
      ]);
    });
    test("never matches bare mentions or lines with other text", () => {
      const body = [
        "See CLNT-5138 for context",
        "This does not fix CLNT-9 yet",
        "Fixes CLNT-10 partially",
        "Related: Fixes CLNT-11",
        "Fixes #12",
        "CLNT-13",
      ].join("\n");
      expect(parseFixesLines(body)).toEqual([]);
    });
    test("ignores fenced code, other teams when scoped, and duplicates", () => {
      const body =
        "```\nFixes CLNT-1\n```\nFixes OPS-2\nFixes CLNT-3\nFixes CLNT-3";
      expect(parseFixesLines(body, "CLNT").map((m) => m.id)).toEqual([
        "CLNT-3",
      ]);
    });
    test("tolerates null bodies and CRLF", () => {
      expect(parseFixesLines(null)).toEqual([]);
      expect(parseFixesLines("Fixes CLNT-5\r\n").map((m) => m.id)).toEqual([
        "CLNT-5",
      ]);
    });
  });

  test("a Fixes line closes a Blocked ticket and strips lifecycle labels", async () => {
    const issue = mk("CLNT-5353", "Blocked", "started", [
      "ai:blocked",
      "ai:in-progress",
      "ai:needs-review",
      "type:bug",
    ]);
    const { res, mutations } = await run(
      [issue],
      [pr(2434, "Body\n\nFixes CLNT-5353\n")],
    );
    expect(res.drift).toBe(1);
    expect(res.actions[0].type).toBe("merged-fixes-line");
    const upd = mutations.find((m) => m.query.includes("issueUpdate"));
    expect(upd.vars.in.stateId).toBe("s-done");
    expect(upd.vars.in.labelIds).toEqual(["id-type:bug"]);
    const body = mutations.find((m) => m.query.includes("commentCreate")).vars
      .in.body;
    expect(body).toContain("#2434");
    expect(body).toContain("2026-11-12T10:00:00Z");
    expect(body).toContain("Fixes CLNT-5353");
  });

  test("works for Todo, Backlog and Triage tickets too", async () => {
    const issues = [
      mk("CLNT-1", "Todo", "unstarted"),
      mk("CLNT-2", "Backlog", "backlog"),
      mk("CLNT-3", "Triage", "triage"),
    ];
    const { res } = await run(issues, [
      pr(1, "Fixes CLNT-1\nCloses CLNT-2\nresolves CLNT-3"),
    ]);
    expect(res.drift).toBe(3);
  });

  test("a bare mention does not close the ticket", async () => {
    const { res, mutations } = await run(
      [mk("CLNT-5138", "Blocked", "started")],
      [pr(5, "Caveat: CLNT-5138 is NOT fixed here.\nSee CLNT-5138.")],
    );
    expect(res.drift).toBe(0);
    expect(mutations).toHaveLength(0);
  });

  test("an already-Done ticket is a no-op", async () => {
    const { res, mutations } = await run(
      [mk("CLNT-7", "Done", "completed")],
      [pr(7, "Fixes CLNT-7")],
    );
    expect(res.drift).toBe(0);
    expect(mutations).toHaveLength(0);
  });

  test("dry run and gate mode report drift without mutating", async () => {
    const issue = mk("CLNT-8", "In Review", "started");
    for (const opts of [{ apply: false }, { apply: false, gate: true }]) {
      const { res, mutations } = await run(
        [issue],
        [pr(8, "Fixes CLNT-8")],
        opts,
      );
      expect(res.drift).toBe(1);
      expect(mutations).toHaveLength(0);
    }
  });

  test("does not double-process a ticket the attachment rule also matches", async () => {
    const issue = {
      ...mk("CLNT-9", "In Review", "started"),
      attachments: {
        nodes: [{ url: "https://github.com/watt-mind/legalease/pull/9" }],
      },
    };
    const mutations = [];
    const res = await reconcileRepo(
      repo,
      { apply: true },
      {
        gql: async (q, v) => (mutations.push(q), { success: true }),
        prState: () => ({ state: "MERGED" }),
        issues: [issue],
        mergedPrs: [pr(9, "Fixes CLNT-9")],
        states,
        labels,
      },
    );
    expect(res.drift).toBe(1);
    expect(mutations.filter((q) => q.includes("issueUpdate"))).toHaveLength(1);
  });

  test("the attachment-only rule is unchanged: a Blocked ticket with a merged attached PR but no Fixes line stays", async () => {
    const issue = {
      ...mk("CLNT-10", "Blocked", "started"),
      attachments: {
        nodes: [{ url: "https://github.com/watt-mind/legalease/pull/10" }],
      },
    };
    const res = await reconcileRepo(
      repo,
      { apply: true },
      {
        gql: async () => ({ success: true }),
        prState: () => ({ state: "MERGED" }),
        issues: [issue],
        mergedPrs: [],
        states,
        labels,
      },
    );
    expect(res.drift).toBe(0);
  });

  test("recentMergedPrs keeps only in-window merges into the base branch", () => {
    const now = Date.parse("2026-11-13T00:00:00Z");
    const forge = {
      prList: () => [
        pr(1, "a"),
        pr(2, "b", { mergedAt: "2026-10-01T00:00:00Z" }),
        pr(3, "c", { baseRefName: "main" }),
        pr(4, "d", { mergedAt: null }),
      ],
    };
    expect(recentMergedPrs(repo, { now }, forge).map((p) => p.number)).toEqual([
      1,
    ]);
  });

  test("a forge failure yields no PRs rather than throwing", () => {
    const forge = {
      prList: () => {
        throw new Error("rate limited");
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(recentMergedPrs(repo, {}, forge)).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });
});

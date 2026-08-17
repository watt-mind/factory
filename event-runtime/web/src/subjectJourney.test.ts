import { describe, expect, test } from "bun:test";
import {
  buildTicketJourney,
  formatDuration,
  humanizeReason,
  parsePrRef,
  prNumbersIn,
  scanVerdictFor,
  selectPrSource,
  subjectJourney,
  ticketIdsIn,
  type JourneyEvent,
  type JourneyRun,
  type SubjectJourneySource,
  type TicketJourneySource,
} from "./subjectJourney";

const lifecycle = (runId: string, start: string, end: string) => [
  {
    seq: 1,
    run_id: runId,
    from_state: null,
    to_state: "QUEUED",
    actor: "planner",
    reason: null,
    attempt: null,
    at: start,
  },
  {
    seq: 2,
    run_id: runId,
    from_state: "QUEUED",
    to_state: "COMPLETED",
    actor: "worker_demo",
    reason: "ok",
    attempt: 1,
    at: end,
  },
];

function run(
  id: string,
  created: string,
  finished: string,
  cost: number | null,
  artifact: Record<string, unknown> = {},
): JourneyRun {
  return {
    run: {
      runId: id,
      state: "COMPLETED",
      attempts: 1,
      created_at: created,
      updated_at: finished,
      spec: { agent: "dispatch@1", adapter: "pi", model: "openai/gpt-test" },
    },
    lifecycle: lifecycle(id, created, finished),
    result: { terminalState: "completed", artifact },
    usage:
      cost == null
        ? { totals: { attempts: 0, totalTokens: 0, costUSD: 0 }, attempts: [] }
        : { totals: { attempts: 1, totalTokens: 1200, costUSD: cost }, attempts: [{}] },
  };
}

function fixture(): TicketJourneySource {
  return {
    ticket: {
      id: "WM-542",
      title: "Keep main focused",
      state: "Done",
      createdAt: "2026-01-01T09:00:00.000Z",
      url: "https://linear.app/watt-mind/issue/WM-542",
    },
    activity: true,
    events: [
      {
        source: "operator",
        eventId: "dispatch-WM-542",
        type: "factory.ticket.dispatched",
        subject: "WM-542",
        status: "planned",
        occurredAt: "2026-01-01T09:10:00.000Z",
        admittedAt: "2026-01-01T09:10:01.000Z",
        proposalId: "prop_1",
        runId: "run_1",
        envelope: { payload: { ticket: "WM-542" } },
      },
    ],
    proposals: [
      {
        id: "prop_1",
        decision: "run",
        status: "approved",
        reason: null,
        created_at: "2026-01-01T09:10:02.000Z",
        decided_at: "2026-01-01T09:11:00.000Z",
        runId: "run_1",
        eventId: "dispatch-WM-542",
        eventSource: "operator",
        agent: "dispatch@1",
        spec: null,
      },
    ],
    runs: [
      run(
        "run_1",
        "2026-01-01T09:11:00.000Z",
        "2026-01-01T09:23:00.000Z",
        0.77,
        { outcome: "PR_OPEN", prUrl: "https://github.com/watt-mind/factory/pull/499" },
      ),
      run(
        "run_2",
        "2026-01-01T10:00:00.000Z",
        "2026-01-01T10:07:00.000Z",
        0.23,
        { pr: 499, action: "merge_pr", checksGreen: true, outcome: "MERGED" },
      ),
    ],
  };
}

describe("buildTicketJourney", () => {
  test("orders milestones, groups lifecycle rows under runs, and computes header aggregates", () => {
    const journey = buildTicketJourney(fixture());
    expect(journey.timeline[0].label).toBe("filed");
    expect(journey.timeline.map((item) => item.label)).toContain("dispatch requested");
    const firstRun = journey.timeline.find((item) => item.id === "run:run_1");
    expect(firstRun?.children?.map((item) => item.label)).toEqual(["QUEUED", "COMPLETED"]);
    expect(firstRun?.children?.[1].durationMs).toBe(12 * 60 * 1000);
    expect(journey.timeline.map((item) => item.label)).toContain("PR #499 opened");
    expect(journey.timeline.map((item) => item.label)).toContain("CI checks green");
    expect(journey.timeline.map((item) => item.label)).toContain("merged");
    expect(journey.timeline.at(-1)?.label).toBe("Done");
    expect(journey.totalCost).toBeCloseTo(1);
    expect(journey.totalTokens).toBe(2400);
    expect(journey.leadTimeMs).toBe(67 * 60 * 1000);
    expect(journey.runCount).toBe(2);
    expect(journey.prUrls).toEqual(["https://github.com/watt-mind/factory/pull/499"]);
  });

  test("derives PR, CI, merge, and approval-next-action milestones from an open merge plan", () => {
    const source = fixture();
    source.runs = [
      {
        ...source.runs[0],
        run: { ...source.runs[0].run, runId: "run_merge", state: "PROPOSED", spec: { agent: "merge-apply@2", adapter: "fake" } },
        lifecycle: [],
        result: null,
        usage: { totals: { attempts: 0, totalTokens: 0, costUSD: 0 }, attempts: [] },
      },
    ];
    source.events[0] = {
      ...source.events[0],
      type: "factory.merge-apply.requested",
      envelope: {
        payload: {
          github: "watt-mind/factory",
          ticket: "WM-542",
          plan: [{ action: "merge_pr", pr: 42, checksGreen: true, reason: "reviewed" }],
        },
      },
    };
    source.proposals[0] = { ...source.proposals[0], id: "prop_merge", status: "open", runId: "run_merge" };
    const journey = buildTicketJourney(source);
    expect(journey.prUrls).toEqual(["https://github.com/watt-mind/factory/pull/42"]);
    expect(journey.timeline.map((item) => item.label)).toContain("PR #42 referenced");
    expect(journey.timeline.map((item) => item.label)).toContain("CI checks green");
    expect(journey.timeline.map((item) => item.label)).toContain("merge requested");
    expect(journey.currentRun).toMatchObject({ runId: "run_merge", state: "PROPOSED" });
    expect(journey.nextAction).toBe("Awaiting approval for prop_merge");
  });

  test("shows unknown aggregates as null and surfaces the latest noop", () => {
    const source = fixture();
    source.ticket.state = "Todo";
    source.ticket.createdAt = null;
    source.runs = [];
    source.events[0].status = "noop";
    source.proposals[0] = {
      ...source.proposals[0],
      decision: "noop",
      status: "resolved",
      reason: "owned_paths_overlap:WM-544:run_held",
      runId: null,
    };
    const journey = buildTicketJourney(source);
    expect(journey.totalCost).toBeNull();
    expect(journey.leadTimeMs).toBeNull();
    expect(journey.blockingReason).toBe("Owned paths overlap — WM-544 · run_held");
    expect(journey.nextAction).toContain("Owned paths overlap");
  });
});

describe("buildTicketJourney concurrent rows", () => {
  test("only the ticket's own runs interleave as ↔ rows; neighbours the server join carried do not", () => {
    const { scan, fix, dispatch } = prFixture();
    const neighbour: JourneyRun = {
      ...dispatch,
      run: { ...dispatch.run, runId: "run_neighbour", spec: { agent: "dispatch@1", adapter: "pi", input: { repo: "factory", ticket: "WM-547" } } },
      result: { terminalState: "completed", artifact: { outcome: "PR_OPEN", ticket: "WM-547", prUrl: "https://github.com/watt-mind/factory/pull/504" } },
    };
    const source: TicketJourneySource = {
      ticket: { id: "WM-627", title: null, state: "In Review", createdAt: null, url: "https://linear.app/watt-mind/issue/WM-627" },
      activity: true,
      events: [],
      proposals: [],
      runs: [neighbour, dispatch, scan, fix],
    };
    const journey = buildTicketJourney(source);
    const concurrent = journey.timeline.filter((item) => item.kind === "concurrent").map((item) => item.label);
    expect(concurrent).toEqual(["↔ WM-627 dispatch pushed 7b2b695 (run_dispatch)"]);
    expect(journey.timeline.map((item) => item.label)).toContain("merge-fix refused · PR head moved since the scan (merge_fix_pr_moved)");
    // Ticket-journey PR rows route to the PR journey.
    expect(journey.timeline.find((item) => item.label === "PR #541 opened")?.href).toBe("#/prs/541");
  });
});

describe("ticket journey helpers", () => {
  test("formats durations and ticket ids without guessing from prose", () => {
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(formatDuration(null)).toBe("—");
    expect(ticketIdsIn({ subject: "wm-542", payload: { ticket: "WM-544" } })).toEqual([
      "WM-542",
      "WM-544",
    ]);
    expect(ticketIdsIn({ note: "mentions WM-999 in prose" })).toEqual([]);
  });

  test("humanizes known and unknown reason codes", () => {
    expect(humanizeReason("ticket_assigned")).toBe("Ticket is already assigned");
    expect(humanizeReason("foreign_reason:WM-1")).toBe("Foreign reason — WM-1");
  });
});

/**
 * The 2026-08-17 19:06 case (WM-640): the 18:45 merge-scan reviewed PR #541
 * at head 6dbaab4 while the WM-627 dispatch pushed 7b2b695; the fix planned
 * from the stale finding was refused `merge_fix_pr_moved`.
 */
function prFixture(): { source: SubjectJourneySource; scan: JourneyRun; fix: JourneyRun; dispatch: JourneyRun } {
  const scan: JourneyRun = {
    run: {
      runId: "run_scan",
      state: "COMPLETED",
      attempts: 1,
      created_at: "2026-08-17T18:45:00.445Z",
      updated_at: "2026-08-17T19:06:02.939Z",
      spec: { agent: "merge-scan@2", adapter: "cursor", input: { repo: "factory", loop: "merge-factory", repoPin: { github: "watt-mind/factory" } } },
    },
    lifecycle: [
      { seq: 1, from_state: null, to_state: "QUEUED", actor: "schedule", reason: null, attempt: null, at: "2026-08-17T18:45:00.445Z" },
      { seq: 2, from_state: "QUEUED", to_state: "COMPLETED", actor: "worker_a", reason: "ok", attempt: 1, at: "2026-08-17T19:06:02.939Z" },
    ],
    result: {
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        recommendation: "ESCALATE",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        plan: [{ pr: 529, headSha: "69b0d96d58a5ab7fc0294e069ff78246ccd5e559", ticket: "WM-613", action: "merge_pr", checksGreen: true, mergeable: true }],
        fix: [
          {
            pr: 541,
            headSha: "6dbaab46a7f362ea66f907b630e57849e2631915",
            headRef: "feat/WM-627",
            ticket: "WM-627",
            finding: "Fix the failing owned worktree test so Verify completes.",
            round: 1,
            mechanical: true,
          },
        ],
        escalate: [{ pr: 479, headSha: "1062773ce3dd37dab9e9fc83e84b1e00c2a90574", ticket: "WM-470", reason: "CONFLICTING against develop." }],
      },
    },
    usage: { totals: { attempts: 1, totalTokens: 5000, costUSD: 1.5 }, attempts: [{}] },
  };
  const fix: JourneyRun = {
    run: {
      runId: "run_fix",
      state: "REFUSED",
      attempts: 1,
      created_at: "2026-08-17T19:06:04.284Z",
      updated_at: "2026-08-17T19:06:05.657Z",
      spec: {
        agent: "merge-fix@1",
        adapter: "cursor",
        input: { repo: "factory", github: "watt-mind/factory", pr: 541, headSha: "6dbaab46a7f362ea66f907b630e57849e2631915", headRef: "feat/WM-627", ticket: "WM-627", round: 1 },
      },
    },
    lifecycle: [
      { seq: 1, from_state: null, to_state: "QUEUED", actor: "chain-auto-approval", reason: "auto_approved:chain-policy@1", attempt: null, at: "2026-08-17T19:06:04.284Z" },
      { seq: 2, from_state: "QUEUED", to_state: "RUNNING", actor: "worker_b", reason: "started", attempt: 1, at: "2026-08-17T19:06:05.105Z" },
      { seq: 3, from_state: "RUNNING", to_state: "REFUSED", actor: "worker_b", reason: "merge_fix_pr_moved", attempt: 1, at: "2026-08-17T19:06:05.657Z" },
    ],
    result: { terminalState: "refused", reasonCode: "merge_fix_pr_moved", artifacts: [] },
    usage: { totals: { attempts: 1, totalTokens: 0, costUSD: 0 }, attempts: [{}] },
  };
  const dispatch: JourneyRun = {
    run: {
      runId: "run_dispatch",
      state: "COMPLETED",
      attempts: 1,
      created_at: "2026-08-17T18:27:40.824Z",
      updated_at: "2026-08-17T19:05:41.000Z",
      spec: { agent: "dispatch@1", adapter: "pi", input: { repo: "factory", ticket: "WM-627" } },
    },
    lifecycle: [
      { seq: 1, from_state: null, to_state: "QUEUED", actor: "operator", reason: "approved", attempt: null, at: "2026-08-17T18:27:40.824Z" },
      { seq: 2, from_state: "QUEUED", to_state: "COMPLETED", actor: "worker_c", reason: "ok", attempt: 1, at: "2026-08-17T19:05:41.000Z" },
    ],
    result: {
      terminalState: "completed",
      artifact: { outcome: "PR_OPEN", ticket: "WM-627", repo: "factory", prNumber: 541, prUrl: "https://github.com/watt-mind/factory/pull/541", headSha: "7b2b6957c0ffee0000000000000000000000dead", summary: "pushed" },
    },
    usage: { totals: { attempts: 1, totalTokens: 100, costUSD: 0.5 }, attempts: [{}] },
  };
  const events: JourneyEvent[] = [
    {
      source: "chain",
      eventId: "chain-run_scan-fix-541",
      type: "factory.merge-fix.requested",
      subject: "merge-scan@2",
      status: "planned",
      occurredAt: "2026-08-17T19:06:03.283Z",
      admittedAt: "2026-08-17T19:06:03.300Z",
      proposalId: "prop_fix",
      runId: "run_fix",
      correlationId: "clock:merge-factory:2026-08-17T18:45:00.000Z",
      envelope: {
        payload: { repo: "factory", github: "watt-mind/factory", pr: 541, headSha: "6dbaab46a7f362ea66f907b630e57849e2631915", headRef: "feat/WM-627", ticket: "WM-627", round: 1, finding: "Fix the failing owned worktree test." },
      },
    },
  ];
  const source: SubjectJourneySource = {
    subject: { kind: "pr", id: "541", title: null, state: null, createdAt: null, url: "#/prs/541" },
    activity: true,
    events,
    proposals: [
      { id: "prop_fix", decision: "run", status: "approved", reason: null, created_at: "2026-08-17T19:06:04.284Z", decided_at: "2026-08-17T19:06:04.284Z", runId: "run_fix", eventId: "chain-run_scan-fix-541", eventSource: "chain", agent: "merge-fix@1", spec: null },
    ],
    runs: [dispatch, scan, fix],
    schedules: [
      { loop: "merge-factory", repo: "factory", eventType: "factory.merge.requested", nextDue: "2026-08-17T19:30:00.000Z", enabled: true },
      { loop: "merge-bj29", repo: "bj29", eventType: "factory.merge.requested", nextDue: "2026-08-17T19:15:00.000Z", enabled: true },
    ],
  };
  return { source, scan, fix, dispatch };
}

describe("subjectJourney(pr)", () => {
  test("interleaves the concurrent dispatch push under the scan and puts the humanized refusal right after it", () => {
    const { source } = prFixture();
    const journey = subjectJourney("pr", "541", source);
    const labels = journey.timeline.map((item) => item.label);
    const at = (needle: string) => labels.findIndex((label) => label.includes(needle));
    expect(journey.pr).toMatchObject({ number: 541, github: "watt-mind/factory", ticket: "WM-627", headRef: "feat/WM-627", url: "https://github.com/watt-mind/factory/pull/541" });
    expect(journey.subject.title).toBe("feat/WM-627");
    // scan run row → ↔ push (inside the scan window) → scan verdict at 6dbaab4 → fix requested → fix run → refusal
    expect(at("run_scan · COMPLETED")).toBeGreaterThanOrEqual(0);
    expect(at("↔ WM-627 dispatch pushed 7b2b695 (run_dispatch)")).toBeGreaterThan(at("run_scan · COMPLETED"));
    expect(at("merge-scan: FIX · reviewed at 6dbaab4 · round 1")).toBeGreaterThan(at("↔ WM-627 dispatch pushed 7b2b695"));
    expect(at("merge-fix requested · at 6dbaab4")).toBeGreaterThan(at("merge-scan: FIX"));
    expect(at("merge-fix refused · PR head moved since the scan (merge_fix_pr_moved)")).toBeGreaterThan(at("run_fix · REFUSED"));
    // The push happened during the fix window too? No — it finished before the fix started; only the scan gets the ↔ row.
    expect(labels.filter((label) => label.startsWith("↔")).length).toBe(1);
    const concurrent = journey.timeline.find((item) => item.kind === "concurrent");
    expect(concurrent?.href).toBe("#/run/run_dispatch");
    expect(concurrent?.detail).toContain("merge-scan run_scan");
    // The refusal is the last run activity → it is the blocking reason, and the schedule tells when the loop comes back.
    expect(journey.blockingReason).toBe("PR head moved since the scan (merge_fix_pr_moved)");
    expect(journey.nextVisit).toEqual({ loop: "merge-factory", at: "2026-08-17T19:30:00.000Z" });
    expect(labels.at(-1)).toMatch(/^next: merge-factory at \d\d:\d\d$/);
    expect(journey.nextAction).toContain("Waiting: PR head moved since the scan");
    expect(journey.nextAction).toContain("merge-factory revisits at");
    // PR opened row links out to GitHub on a PR journey.
    const opened = journey.timeline.find((item) => item.id.startsWith("pr:"));
    expect(opened?.label).toBe("PR #541 opened");
    expect(opened?.href).toBe("https://github.com/watt-mind/factory/pull/541");
    expect(journey.runCount).toBe(3);
    // #529's green checks in the same scan artifact are not #541's.
    expect(labels).not.toContain("CI checks green");
  });

  test("a same-ticket run without a push artifact still surfaces as concurrent activity from its overlap", () => {
    const { source, dispatch } = prFixture();
    dispatch.run.state = "FAILED";
    dispatch.run.updated_at = "2026-08-17T19:10:30.000Z";
    dispatch.lifecycle[1] = { ...dispatch.lifecycle[1], to_state: "FAILED", at: "2026-08-17T19:10:30.000Z" };
    dispatch.result = null;
    source.runs = source.runs.filter((run) => run !== dispatch);
    source.contextRuns = [dispatch];
    const journey = subjectJourney("pr", "541", source);
    const concurrent = journey.timeline.filter((item) => item.kind === "concurrent");
    expect(concurrent.map((item) => item.label)).toEqual([
      "↔ WM-627 dispatch run_dispatch was active during merge-scan",
      "↔ WM-627 dispatch run_dispatch was active during merge-fix",
    ]);
    expect(concurrent[1].detail).toContain("failed");
    const labels = journey.timeline.map((item) => item.label);
    // The fix-window row sits between the fix run row and its refusal.
    expect(labels.indexOf(concurrent[1].label)).toBeGreaterThan(labels.indexOf("run_fix · REFUSED"));
    expect(labels.indexOf(concurrent[1].label)).toBeLessThan(labels.findIndex((label) => label.startsWith("merge-fix refused")));
    // Context runs are evidence, not the subject's own work.
    expect(journey.runCount).toBe(2);
    expect(journey.totalCost).toBeCloseTo(1.5);
  });

  test("selectPrSource keys on structural PR references and closes over the ticket's runs", () => {
    const { source, dispatch, scan, fix } = prFixture();
    const other: JourneyRun = {
      ...dispatch,
      run: { ...dispatch.run, runId: "run_other", spec: { agent: "dispatch@1", adapter: "pi", input: { repo: "factory", ticket: "WM-999" } } },
      result: { terminalState: "completed", artifact: { outcome: "PR_OPEN", prUrl: "https://github.com/watt-mind/factory/pull/5410", summary: "mentions #541 in prose only" } },
    };
    const failedRetry: JourneyRun = {
      ...dispatch,
      run: { ...dispatch.run, runId: "run_retry", state: "FAILED" },
      result: null,
    };
    const selected = selectPrSource(541, {
      events: source.events,
      proposals: source.proposals,
      runs: [other, dispatch, scan, fix, failedRetry],
      inbox: [
        { id: "inbox_1", kind: "CI RED", title: "CI RED PR #541", createdAt: "2026-08-17T19:20:00.000Z", refs: { pr: "PR#541", issue: "WM-627" } },
        { id: "inbox_2", kind: "CI RED", title: "other", createdAt: "2026-08-17T19:20:00.000Z", refs: { pr: "PR#5410" } },
      ],
    });
    expect(selected.runs.map((run) => run.run.runId)).toEqual(["run_dispatch", "run_scan", "run_fix"]);
    expect(selected.contextRuns?.map((run) => run.run.runId)).toEqual(["run_retry"]);
    expect(selected.inbox?.map((item) => item.id)).toEqual(["inbox_1"]);
    expect(selected.subject).toMatchObject({ kind: "pr", id: "541" });
    const journey = subjectJourney("pr", "541", selected);
    expect(journey.timeline.map((item) => item.label)).toContain("CI RED: CI RED PR #541");
  });

  test("a merged PR reads as merged and asks for nothing", () => {
    const { source } = prFixture();
    source.events.push({
      source: "internal",
      eventId: "merge-landed:watt-mind/factory:541:abc",
      type: "factory.merge-landed",
      subject: "factory",
      status: "planned",
      occurredAt: "2026-08-17T19:40:00.000Z",
      admittedAt: "2026-08-17T19:40:00.000Z",
      proposalId: null,
      runId: null,
      envelope: { payload: { github: "watt-mind/factory", pr: 541, ticket: "WM-627", headSha: "7b2b6957c0ffee0000000000000000000000dead", mergeCommitSha: "d657c9ed47d27cfe45e65ec768616608ae85579d" } },
    });
    const journey = subjectJourney("pr", "541", source);
    expect(journey.timeline.map((item) => item.label)).toContain("merged as d657c9e");
    expect(journey.pr?.mergeState).toBe("MERGED");
    expect(journey.nextAction).toBe("Merged — no further action");
    expect(journey.timeline.some((item) => item.kind === "schedule")).toBe(false);
  });
});

describe("PR reference helpers", () => {
  test("parsePrRef accepts operator spellings and rejects bare numbers", () => {
    expect(parsePrRef("#541")).toBe(541);
    expect(parsePrRef("PR 541")).toBe(541);
    expect(parsePrRef("pr:541")).toBe(541);
    expect(parsePrRef("pull/541")).toBe(541);
    expect(parsePrRef("541")).toBeNull();
    expect(parsePrRef("WM-541")).toBeNull();
  });

  test("prNumbersIn keys on fields and pull URLs, never prose", () => {
    expect(prNumbersIn({ payload: { pr: 541, plan: [{ pr: 529 }], prUrl: "https://github.com/o/r/pull/544" } }).sort()).toEqual([529, 541, 544]);
    expect(prNumbersIn({ refs: { pr: "PR#475" } })).toEqual([475]);
    expect(prNumbersIn({ summary: "PR #541 mentioned in prose" })).toEqual([]);
    expect(scanVerdictFor({ escalate: [{ pr: 7, headSha: "abc", ticket: "wm-1", reason: "MERGEABLE but UNSTABLE" }] }, 7)).toMatchObject({ bucket: "ESCALATE", ticket: "WM-1" });
    expect(scanVerdictFor({ escalate: [] }, 7)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildTicketJourney,
  formatDuration,
  humanizeReason,
  ticketIdsIn,
  type JourneyRun,
  type TicketJourneySource,
} from "./ticketJourney";

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

import "../test-dom";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { prCandidateRunIds, PullRequest, Ticket } from "./Ticket";
import { changeInput } from "../test-render";
import type {
  JourneyRun,
  TicketJourneySource,
  TicketTrackerDetail,
} from "../subjectJourney";
import * as subjectJourneyModel from "../subjectJourney";

const realFetch = globalThis.fetch;

function run(
  id: string,
  at: string,
  artifact: Record<string, unknown> = {},
): JourneyRun {
  return {
    run: {
      runId: id,
      state: "COMPLETED",
      attempts: 1,
      created_at: at,
      updated_at: new Date(Date.parse(at) + 60_000).toISOString(),
      spec: {
        agent: id === "run_merge" ? "merge-apply@1" : "dispatch@1",
        adapter: "pi",
      },
    },
    lifecycle: [
      {
        seq: 1,
        from_state: null,
        to_state: "QUEUED",
        actor: "planner",
        reason: null,
        attempt: null,
        at,
      },
      {
        seq: 2,
        from_state: "QUEUED",
        to_state: "COMPLETED",
        actor: "worker_demo",
        reason: "ok",
        attempt: 1,
        at: new Date(Date.parse(at) + 60_000).toISOString(),
      },
    ],
    result: { terminalState: "completed", artifact },
    usage: {
      totals: { attempts: 1, totalTokens: 100, costUSD: 0.5 },
      attempts: [{}],
    },
  };
}

function source(): TicketJourneySource {
  return {
    ticket: {
      id: "WM-542",
      title: "Ticket journey fixture",
      state: "In Review",
      createdAt: "2026-01-01T09:00:00.000Z",
      url: "https://linear.app/watt-mind/issue/WM-542",
    },
    activity: true,
    events: [
      {
        source: "operator",
        eventId: "dispatch-542",
        type: "factory.ticket.dispatched",
        subject: "WM-542",
        status: "planned",
        occurredAt: "2026-01-01T09:01:00.000Z",
        admittedAt: "2026-01-01T09:01:01.000Z",
        proposalId: "prop_1",
        runId: "run_dispatch",
        envelope: { payload: { ticket: "WM-542" } },
      },
    ],
    proposals: [
      {
        id: "prop_1",
        decision: "run",
        status: "approved",
        reason: null,
        created_at: "2026-01-01T09:01:02.000Z",
        decided_at: null,
        runId: "run_dispatch",
        eventId: "dispatch-542",
        eventSource: "operator",
        agent: "dispatch@1",
        spec: null,
      },
    ],
    runs: [
      run("run_dispatch", "2026-01-01T09:02:00.000Z", {
        outcome: "PR_OPEN",
        prUrl: "https://github.com/watt-mind/factory/pull/499",
      }),
      run("run_merge", "2026-01-01T10:00:00.000Z", {
        pr: 499,
        checksGreen: true,
        outcome: "MERGED",
      }),
    ],
  };
}

function trackerDetail(
  overrides: Partial<TicketTrackerDetail> = {},
): TicketTrackerDetail {
  return {
    ticket: {
      id: "WM-542",
      identifier: "WM-542",
      title: "Live Linear title",
      state: "In Progress",
      description: "## Acceptance Criteria\n\n- ship the overlay",
      url: "https://linear.app/watt-mind/issue/WM-542",
      assignee: { name: "Ada" },
    },
    comments: [
      {
        id: "c1",
        body: "Looks good from Linear",
        createdAt: "2026-08-18T12:00:00.000Z",
        user: { name: "Ada" },
      },
    ],
    fetchedAt: "2026-08-19T12:00:00.000Z",
    cached: false,
    ...overrides,
  };
}

function journeyFetch(
  data: TicketJourneySource,
  detail?: TicketTrackerDetail | null,
  detailStatus = 200,
) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/tickets\/[^/]+\/detail/.test(url)) {
      if (detail === undefined) {
        return new Response(JSON.stringify({ error: "no such issue" }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(detail), {
        status: detailStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/api\/schedules/.test(url)) {
      return new Response(JSON.stringify({ schedules: [] }), { status: 200 });
    }
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
}

function renderTicket(
  data: TicketJourneySource,
  detail?: TicketTrackerDetail | null,
) {
  globalThis.fetch = journeyFetch(data, detail);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Ticket ticketId="WM-542" onNavigate={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
});

describe("Ticket journey view", () => {
  test("renders a two-run journey, PR, aggregates, timeline sources, and current-state block", async () => {
    const view = renderTicket(source());
    await view.findByRole("heading", { name: "WM-542" });
    expect(view.getAllByText("Ticket journey fixture").length).toBeGreaterThan(
      0,
    );
    expect(view.getByText("$1.00")).toBeTruthy();
    expect(view.getByText("2", { selector: "div" })).toBeTruthy();
    expect(view.getByText("PR #499 opened")).toBeTruthy();
    expect(view.getByText("CI checks green")).toBeTruthy();
    expect(view.getByText("merged")).toBeTruthy();
    expect(
      view
        .getByRole("link", { name: "run_dispatch · COMPLETED" })
        .getAttribute("href"),
    ).toBe("#/run/run_dispatch");
    const timeline = view.getByRole("tabpanel", { name: /timeline/i });
    expect(within(timeline).getAllByText("QUEUED").length).toBeGreaterThan(0);
    expect(view.getByRole("heading", { name: "Where it is now" })).toBeTruthy();
  });

  test("renders a noop-only ticket with an actionable blocking reason and unknown aggregates", async () => {
    const data = source();
    data.runs = [];
    data.ticket.state = "Todo";
    data.ticket.createdAt = null;
    data.events[0].status = "noop";
    data.proposals[0] = {
      ...data.proposals[0],
      decision: "noop",
      reason: "owned_paths_overlap:WM-544",
      runId: null,
    };
    const view = renderTicket(data);
    await view.findByRole("heading", { name: "WM-542" });
    expect(view.getAllByText("—").length).toBeGreaterThan(0);
    // The blocking reason names the ticket in the way; it linkifies inline, so
    // the text is now split across the anchor rather than one text node.
    const reason = view.getByText("Blocking reason")
      .nextElementSibling as HTMLElement;
    expect(reason.textContent).toBe("Owned paths overlap — WM-544");
    expect(
      within(reason).getByRole("link", { name: "WM-544" }).getAttribute("href"),
    ).toBe("#/tickets/WM-544");
    expect(view.getByText(/Waiting: Owned paths overlap/)).toBeTruthy();
    expect(view.container.textContent).not.toContain("$0.00");
  });

  /** An id Linear never heard of: no title, no state, no runtime activity. */
  function unindexed(id: string): TicketJourneySource {
    return {
      ticket: {
        id,
        title: null,
        state: null,
        createdAt: null,
        url: `https://linear.app/watt-mind/issue/${id}`,
      },
      activity: false,
      events: [],
      proposals: [],
      runs: [],
    };
  }

  function renderId(
    id: string,
    data: TicketJourneySource,
    detail?: TicketTrackerDetail | null,
  ) {
    globalThis.fetch = journeyFetch(data, detail);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={id} onNavigate={() => {}} />
      </QueryClientProvider>,
    );
  }

  test("an unindexed id reads as unknown or external, with a direct Linear link", async () => {
    const view = renderId("WM-999", unindexed("WM-999"));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "Unknown or external ticket",
      ),
    );
    expect(view.getByRole("status").textContent).toContain("WM-999");
    expect(
      view.getByRole("link", { name: "Open in Linear ↗" }).getAttribute("href"),
    ).toBe("https://linear.app/watt-mind/issue/WM-999");
  });

  test("a ticket from a team this factory does not run reads the same way", async () => {
    const view = renderId("FOO-12", unindexed("FOO-12"));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "Unknown or external ticket",
      ),
    );
    expect(
      view.getByRole("link", { name: "Open in Linear ↗" }).getAttribute("href"),
    ).toBe("https://linear.app/watt-mind/issue/FOO-12");
  });

  test("a ticket Linear knows but nothing has run keeps the no-activity notice", async () => {
    const data = source();
    data.activity = false;
    data.events = [];
    data.proposals = [];
    data.runs = [];
    const view = renderId("WM-542", data);
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "no runtime activity for WM-542",
      ),
    );
  });

  test("header prefers live tracker title and state over runtime metadata", async () => {
    const data = source();
    data.ticket.title = null;
    data.ticket.state = null;
    const view = renderTicket(data, trackerDetail());
    await view.findByRole("heading", { name: "WM-542" });
    expect(view.getByText("Live Linear title")).toBeTruthy();
    expect(view.getAllByText("In Progress").length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("title not recorded");
    const linear = view.getByRole("link", { name: "Open in Linear ↗" });
    expect(linear.className).toContain("rounded-md");
    expect(linear.className).toContain("border");
  });

  test("Spec & Comments tab renders the issue description and comments", async () => {
    const view = renderTicket(source(), trackerDetail());
    await view.findByRole("heading", { name: "WM-542" });
    fireEvent.click(view.getByRole("tab", { name: "Spec & Comments" }));
    expect(
      view.getByRole("tabpanel", { name: /spec and comments/i }),
    ).toBeTruthy();
    expect(view.getByText("Acceptance Criteria")).toBeTruthy();
    expect(view.getByText("Looks good from Linear")).toBeTruthy();
    expect(view.getByText("Ada")).toBeTruthy();
  });

  test("o shortcut opens the Linear issue in a new tab", async () => {
    let openedUrl = "";
    const origOpen = window.open;
    Object.defineProperty(window, "open", {
      writable: true,
      value: (url: string) => {
        openedUrl = url;
        return null;
      },
    });
    try {
      const view = renderTicket(source(), trackerDetail());
      await view.findByRole("heading", { name: "WM-542" });
      fireEvent.keyDown(document.body, { key: "o" });
      expect(openedUrl).toBe("https://linear.app/watt-mind/issue/WM-542");
    } finally {
      Object.defineProperty(window, "open", {
        writable: true,
        value: origOpen,
      });
    }
  });

  test("an unindexed id Linear still knows shows the live title and spec tab", async () => {
    const view = renderId(
      "WM-999",
      unindexed("WM-999"),
      trackerDetail({
        ticket: {
          id: "WM-999",
          identifier: "WM-999",
          title: "External but real",
          state: "Todo",
          description: "Brought in from Linear.",
          url: "https://linear.app/watt-mind/issue/WM-999",
          assignee: null,
        },
      }),
    );
    await view.findByRole("heading", { name: "WM-999" });
    expect(view.getByText("External but real")).toBeTruthy();
    expect(view.queryByText("Unknown or external ticket")).toBeNull();
    expect(view.getByText(/no runtime activity for WM-999/)).toBeTruthy();
    fireEvent.click(view.getByRole("tab", { name: "Spec & Comments" }));
    expect(view.getByText("Brought in from Linear.")).toBeTruthy();
  });
});

/** `/api/*` router for the PR journey: lists plus one detail per run. */
function prFetch(data: {
  events: unknown[];
  proposals: unknown[];
  runs: Record<string, JourneyRun>;
  inbox?: unknown[];
  schedules?: unknown[];
}) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (/\/api\/events/.test(url)) return json({ events: data.events });
    if (/\/api\/proposals/.test(url))
      return json({ proposals: data.proposals });
    if (/\/api\/inbox/.test(url)) return json({ items: data.inbox ?? [] });
    if (/\/api\/schedules/.test(url))
      return json({ schedules: data.schedules ?? [] });
    const detail = url.match(/\/api\/runs\/([^/?]+)$/);
    if (detail) {
      const run = data.runs[decodeURIComponent(detail[1])];
      return run ? json(run) : json({ error: "unknown run" }, 404);
    }
    if (/\/api\/runs(\?|$)/.test(url)) {
      return json({
        runs: Object.values(data.runs).map((run) => ({
          runId: run.run.runId,
          state: run.run.state,
          attempts: 1,
          maxAttempts: 1,
          agent: run.run.spec.agent,
          adapter: run.run.spec.adapter,
          reasonCode: run.result?.reasonCode ?? null,
          eventId: null,
          eventSource: null,
          created_at: run.run.created_at,
          updated_at: run.run.updated_at,
          repos: ["factory"],
        })),
      });
    }
    return json({ error: `unexpected ${url}` }, 404);
  }) as unknown as typeof fetch;
}

function prData() {
  const scan = run("run_scan", "2026-08-17T18:45:00.000Z", {
    github: "watt-mind/factory",
    repo: "factory",
    fix: [
      {
        pr: 541,
        headSha: "6dbaab46a7f362ea66f907b630e57849e2631915",
        headRef: "feat/WM-627",
        ticket: "WM-627",
        finding: "Fix the failing owned test.",
        round: 1,
      },
    ],
  });
  scan.run.spec = {
    agent: "merge-scan@2",
    adapter: "cursor",
    input: { repo: "factory", repoPin: { github: "watt-mind/factory" } },
  };
  scan.run.updated_at = "2026-08-17T19:06:02.000Z";
  scan.lifecycle[1].at = "2026-08-17T19:06:02.000Z";
  const dispatch = run("run_dispatch", "2026-08-17T18:27:40.000Z");
  dispatch.run.spec = {
    agent: "dispatch@1",
    adapter: "pi",
    input: { repo: "factory", ticket: "WM-627" },
  };
  dispatch.run.state = "FAILED";
  dispatch.run.updated_at = "2026-08-17T19:10:30.000Z";
  dispatch.lifecycle[1] = {
    ...dispatch.lifecycle[1],
    to_state: "FAILED",
    at: "2026-08-17T19:10:30.000Z",
  };
  dispatch.result = null;
  const fix = run("run_fix", "2026-08-17T19:06:04.000Z");
  fix.run.spec = {
    agent: "merge-fix@1",
    adapter: "cursor",
    input: {
      repo: "factory",
      github: "watt-mind/factory",
      pr: 541,
      headSha: "6dbaab46a7f362ea66f907b630e57849e2631915",
      ticket: "WM-627",
    },
  };
  fix.run.state = "REFUSED";
  fix.run.updated_at = "2026-08-17T19:06:05.000Z";
  fix.lifecycle[1] = {
    ...fix.lifecycle[1],
    to_state: "REFUSED",
    reason: "merge_fix_pr_moved",
    at: "2026-08-17T19:06:05.000Z",
  };
  fix.result = { terminalState: "refused", reasonCode: "merge_fix_pr_moved" };
  const events = [
    {
      source: "schedule",
      eventId: "clock:merge-factory:2026-08-17T18:45:00.000Z",
      type: "factory.merge.requested",
      subject: "merge-factory",
      status: "planned",
      occurredAt: "2026-08-17T18:45:00.000Z",
      admittedAt: "2026-08-17T18:45:00.000Z",
      correlationId: "clock:merge-factory:2026-08-17T18:45:00.000Z",
      proposalId: null,
      runId: "run_scan",
      envelope: { payload: { repo: "factory", loop: "merge-factory" } },
      repos: ["factory"],
    },
    {
      source: "chain",
      eventId: "chain-run_scan-fix-541",
      type: "factory.merge-fix.requested",
      subject: "merge-scan@2",
      status: "planned",
      occurredAt: "2026-08-17T19:06:03.000Z",
      admittedAt: "2026-08-17T19:06:03.000Z",
      correlationId: "clock:merge-factory:2026-08-17T18:45:00.000Z",
      proposalId: "prop_fix",
      runId: "run_fix",
      envelope: {
        payload: {
          repo: "factory",
          github: "watt-mind/factory",
          pr: 541,
          headSha: "6dbaab46a7f362ea66f907b630e57849e2631915",
          headRef: "feat/WM-627",
          ticket: "WM-627",
          round: 1,
        },
      },
      repos: ["factory"],
    },
    {
      source: "operator",
      eventId: "operator:dispatch:WM-627",
      type: "factory.dispatch.requested",
      subject: "WM-627",
      status: "planned",
      occurredAt: "2026-08-17T18:27:40.000Z",
      admittedAt: "2026-08-17T18:27:40.000Z",
      correlationId: null,
      proposalId: null,
      runId: "run_dispatch",
      envelope: { payload: { repo: "factory", ticket: "WM-627" } },
      repos: ["factory"],
    },
  ];
  const proposals = [
    {
      id: "prop_fix",
      decision: "run",
      status: "approved",
      reason: null,
      created_at: "2026-08-17T19:06:04.000Z",
      decided_at: null,
      runId: "run_fix",
      eventId: "chain-run_scan-fix-541",
      eventSource: "chain",
      agent: "merge-fix@1",
      spec: null,
      expired: false,
      ttl_seconds: 0,
      decided_by: null,
      repos: [],
    },
  ];
  return {
    events,
    proposals,
    runs: { run_scan: scan, run_dispatch: dispatch, run_fix: fix },
    schedules: [
      {
        loop: "merge-factory",
        repo: "factory",
        eventType: "factory.merge.requested",
        nextDue: "2026-08-17T19:30:00.000Z",
        enabled: true,
      },
    ],
  };
}

describe("PR journey view", () => {
  test("renders #/prs/541 with the scan verdict, the concurrent dispatch, and the humanized refusal", async () => {
    const data = prData();
    globalThis.fetch = prFetch(data);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <PullRequest number="541" onNavigateTicket={() => {}} />
      </QueryClientProvider>,
    );
    await view.findByRole("heading", { name: "#541" });
    expect(view.getByText("feat/WM-627")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "WM-627" }).getAttribute("href"),
    ).toBe("#/tickets/WM-627");
    expect(
      view.getByRole("link", { name: "Open on GitHub ↗" }).getAttribute("href"),
    ).toBe("https://github.com/watt-mind/factory/pull/541");
    expect(
      view.getByText("merge-scan: FIX · reviewed at 6dbaab4 · round 1"),
    ).toBeTruthy();
    expect(
      view.getByText(
        "↔ WM-627 dispatch run_dispatch was active during merge-scan",
      ),
    ).toBeTruthy();
    expect(
      view.getByText(
        "merge-fix refused · PR head moved since the scan (merge_fix_pr_moved)",
      ),
    ).toBeTruthy();
    expect(view.getByText(/^next: merge-factory at/)).toBeTruthy();
    expect(
      view.getByText(/Waiting: PR head moved since the scan/),
    ).toBeTruthy();
    // The failed dispatch is context, not one of the PR's own runs.
    expect(view.getByText("2", { selector: "div" })).toBeTruthy();
  });

  test("derives an unchanged PR journey only once across a rerender", async () => {
    const data = prData();
    globalThis.fetch = prFetch(data);
    const deriveJourney = jest.spyOn(subjectJourneyModel, "subjectJourney");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <PullRequest number="541" />
      </QueryClientProvider>,
    );
    await view.findByRole("heading", { name: "#541" });
    view.rerender(
      <QueryClientProvider client={client}>
        <PullRequest number="541" />
      </QueryClientProvider>,
    );
    expect(deriveJourney).toHaveBeenCalledTimes(1);
  });

  test("an unknown PR reads as no runtime activity, and a bad reference as an inline error", async () => {
    globalThis.fetch = prFetch({ events: [], proposals: [], runs: {} });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <PullRequest number="9999" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain(
        "no runtime activity for PR #9999",
      ),
    );
    cleanup();
    const bad = render(
      <QueryClientProvider client={client}>
        <PullRequest number="not-a-pr" />
      </QueryClientProvider>,
    );
    expect(bad.getByRole("alert").textContent).toContain(
      "Invalid PR reference",
    );
  });

  test("prCandidateRunIds is bounded to the PR's chains and its ticket, never the whole registry", () => {
    const data = prData();
    const runs = Object.values(data.runs).map((run) => ({
      runId: run.run.runId,
      state: run.run.state,
      attempts: 1,
      maxAttempts: 1,
      agent: run.run.spec.agent,
      adapter: run.run.spec.adapter,
      reasonCode: null,
      eventId: null,
      eventSource: null,
      created_at: run.run.created_at,
      updated_at: run.run.updated_at,
      repos: ["factory"],
    }));
    runs.push({ ...runs[0], runId: "run_unrelated", agent: "dispatch@1" });
    const ids = prCandidateRunIds(541, {
      events: data.events as any,
      proposals: data.proposals as any,
      runs: runs as any,
    });
    expect(ids.sort()).toEqual(["run_dispatch", "run_fix", "run_scan"]);
  });
});

describe("Tickets hub landing view", () => {
  const ticketsFixture = [
    {
      id: "WM-772",
      title: "Auto approval workflow fix",
      state: "Done",
      repo: "factory",
      repos: ["factory"],
      lastActivityAt: "2026-08-18T19:00:00.000Z",
      lastActivityDescription: "merged into develop",
      lastActivityKind: "merge",
      attempts: 23,
      pr: {
        number: 772,
        url: "https://github.com/watt-mind/factory/pull/772",
        ci: "green",
      },
      prUrl: "https://github.com/watt-mind/factory/pull/772",
      checksGreen: true,
      ciStatus: "green",
      url: "https://linear.app/watt-mind/issue/WM-772",
    },
    {
      id: "WM-822",
      title: "Tickets hub landing view",
      state: "In Progress",
      repo: "factory",
      repos: ["factory"],
      lastActivityAt: "2026-08-18T18:00:00.000Z",
      lastActivityDescription: "dispatch@1 leased",
      lastActivityKind: "run",
      attempts: 2,
      pr: 542,
      prUrl: "https://github.com/watt-mind/factory/pull/542",
      checksGreen: true,
      ciStatus: "green",
      url: "https://linear.app/watt-mind/issue/WM-822",
    },
    {
      id: "WM-821",
      title: "Fix broken build",
      state: "Done",
      repo: "bj29",
      repos: ["bj29"],
      lastActivityAt: "2026-08-18T17:00:00.000Z",
      lastActivityDescription: "merged into master",
      lastActivityKind: "merge",
      attempts: 1,
      pr: 101,
      prUrl: "https://github.com/watt-mind/bj29/pull/101",
      checksGreen: true,
      ciStatus: "green",
      url: "https://linear.app/watt-mind/issue/WM-821",
    },
    {
      id: "OPS-91",
      title: "Uptime monitoring setup",
      state: "Todo",
      repo: "hdkiller",
      repos: ["hdkiller"],
      lastActivityAt: "2026-08-18T16:00:00.000Z",
      lastActivityDescription: "triage-scan@1 planned",
      lastActivityKind: "event",
      attempts: 0,
      pr: null,
      prUrl: null,
      checksGreen: null,
      ciStatus: null,
      url: "https://linear.app/watt-mind/issue/OPS-91",
    },
  ];

  function ticketsFetch(data = ticketsFixture) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (/\/api\/repos/.test(url)) {
        return json({
          repos: [
            { name: "factory", team: "WM" },
            { name: "bj29", team: "WM" },
            { name: "hdkiller", team: "OPS" },
          ],
        });
      }
      if (/\/api\/tickets\/supply/.test(url)) {
        return json({
          repos: [
            {
              name: "factory",
              team: "WM",
              triage: 2,
              ready: 1,
              inFlight: 0,
              cap: 2,
              blocked: 0,
              noopReason: null,
              asOf: "2026-08-20T18:00:00.000Z",
              sourceRunId: null,
              source: "linear",
            },
            {
              name: "ghost",
              team: "OPS",
              triage: null,
              ready: null,
              inFlight: null,
              cap: 2,
              blocked: null,
              noopReason: null,
              asOf: null,
              sourceRunId: null,
              source: null,
            },
          ],
          recommendedAction: "dispatch",
          source: "linear",
          asOf: "2026-08-20T18:00:00.000Z",
          stale: false,
          linearError: null,
        });
      }
      if (/\/api\/tickets/.test(url)) {
        return json({ tickets: data });
      }
      return json({ error: `unexpected ${url}` }, 404);
    }) as unknown as typeof fetch;
  }

  test("renders tickets hub table with columns, jump bar, and filters when ticketId is null", async () => {
    globalThis.fetch = ticketsFetch();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} onNavigatePr={() => {}} />
      </QueryClientProvider>,
    );

    // Should display ticket hub title / jump bar
    await view.findByPlaceholderText(/WM-542/i);
    // Table should contain ticket entries
    await view.findByText("WM-822");
    expect(view.getByText("WM-772")).toBeTruthy();
    expect(view.getByText("WM-821")).toBeTruthy();
    expect(view.getByText("OPS-91")).toBeTruthy();
    expect(view.getByText("Tickets hub landing view")).toBeTruthy();
    expect(view.getAllByText("In Progress").length).toBeGreaterThan(0);
    expect(view.getAllByText("factory").length).toBeGreaterThan(0);
    expect(view.getByText("#772")).toBeTruthy();
    expect(view.getByText("#542")).toBeTruthy();
    expect(view.container.textContent).not.toContain("[object Object]");
    expect(view.getByText("2", { selector: "td" })).toBeTruthy(); // attempts
  });

  test("jump bar navigates to ticket or PR upon Enter", async () => {
    globalThis.fetch = ticketsFetch();
    let navigatedTicket = "";
    let navigatedPr = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket
          ticketId={null}
          onNavigate={(id) => {
            navigatedTicket = id;
          }}
          onNavigatePr={(pr) => {
            navigatedPr = pr;
          }}
        />
      </QueryClientProvider>,
    );

    const input = await view.findByPlaceholderText(/WM-542/i);
    fireEvent.change(input, { target: { value: "WM-999" } });
    fireEvent.submit(input.closest("form")!);
    expect(navigatedTicket).toBe("WM-999");

    fireEvent.change(input, { target: { value: "#541" } });
    fireEvent.submit(input.closest("form")!);
    expect(navigatedPr).toBe(541);
  });

  test("filtering by repo and state works in tickets hub", async () => {
    globalThis.fetch = ticketsFetch();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    await view.findByText("WM-822");
    expect(view.getByText("WM-821")).toBeTruthy();

    const repoSelect = view.getByLabelText(/filter by repo/i);
    fireEvent.change(repoSelect, { target: { value: "bj29" } });

    await waitFor(() => {
      expect(view.queryByText("WM-822")).toBeNull();
    });
    expect(view.getByText("WM-821")).toBeTruthy();
  });

  test("keyboard navigation j/k and opening ticket in linear with 'o'", async () => {
    globalThis.fetch = ticketsFetch();
    let openedUrl = "";
    const origOpen = window.open;
    Object.defineProperty(window, "open", {
      writable: true,
      value: (url: string) => {
        openedUrl = url;
        return null;
      },
    });

    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchInterval: false } },
      });
      const view = render(
        <QueryClientProvider client={client}>
          <Ticket ticketId={null} onNavigate={() => {}} />
        </QueryClientProvider>,
      );

      await view.findByText("WM-822");
      // Fire keydown 'j' to move selection down
      fireEvent.keyDown(document.body, { key: "j" });
      // Fire keydown 'o' to open in linear
      fireEvent.keyDown(document.body, { key: "o" });
      expect(openedUrl).toContain("linear.app");
    } finally {
      Object.defineProperty(window, "open", {
        writable: true,
        value: origOpen,
      });
    }
  });

  test("displays empty state when no tickets match", async () => {
    globalThis.fetch = ticketsFetch([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    await view.findByText(/No tickets found/i);
  });

  test("row click navigates to ticket journey and PR link navigates to PR", async () => {
    globalThis.fetch = ticketsFetch();
    let navigatedTicket = "";
    let navigatedPr = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket
          ticketId={null}
          onNavigate={(id) => {
            navigatedTicket = id;
          }}
          onNavigatePr={(pr) => {
            navigatedPr = pr;
          }}
        />
      </QueryClientProvider>,
    );

    await view.findByText("WM-822");
    // Click row
    fireEvent.click(view.getByText("Tickets hub landing view"));
    expect(navigatedTicket).toBe("WM-822");

    // Click PR link
    fireEvent.click(view.getByText("#542"));
    expect(navigatedPr).toBe(542);
  });

  test("search text filter filters tickets by query", async () => {
    globalThis.fetch = ticketsFetch();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    await view.findByText("WM-822");
    const searchInput = view.getByRole("combobox", { name: "Filter tickets" });
    changeInput(searchInput, "OPS-91");

    await waitFor(() => {
      expect(view.queryByText("WM-822")).toBeNull();
    });
    expect(view.getByText("OPS-91")).toBeTruthy();
    expect(view.queryByText("WM-821")).toBeNull();
  });

  test("g k shortcut focuses the jump bar input", async () => {
    globalThis.fetch = ticketsFetch();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    const jumpInput = await view.findByPlaceholderText(/WM-542 or #541/i);
    const openBtn = view.getByRole("button", { name: "Open" });
    openBtn.focus();
    expect(document.activeElement).toBe(openBtn);

    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "k" });
    expect(document.activeElement).toBe(jumpInput);
  });

  test("hub rows use py-1.5 and keep id/title and activity/Ago on one line each (WM-843)", async () => {
    globalThis.fetch = ticketsFetch();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    const id = await view.findByText("WM-822");
    const row = id.closest("tr");
    expect(row).toBeTruthy();
    const cells = [...row!.querySelectorAll("td")];
    expect(cells.length).toBeGreaterThan(0);
    for (const td of cells) {
      const tokens = td.className.split(/\s+/);
      expect(tokens).toContain("py-1.5");
      expect(tokens).not.toContain("py-2");
      expect(tokens).toContain("whitespace-nowrap");
    }

    const idCell = id.closest("td")!;
    expect(idCell.querySelector("div")).toBeNull();
    expect(view.getByText("Tickets hub landing view").closest("td")).toBe(
      idCell,
    );

    const activity = view.getByText("dispatch@1 leased");
    const activityCell = activity.closest("td")!;
    expect(activityCell.querySelector("div")).toBeNull();
    expect(activityCell.textContent).toMatch(/ago/i);
  });

  test("hub is a height-capped pane so the table scrolls above the status bar (WM-981)", async () => {
    globalThis.fetch = ticketsFetch();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    const hub = await view.findByTestId("tickets-hub");
    expect(hub.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "h-full", "min-w-0"]),
    );
    const scroller = hub.querySelector(".overflow-auto");
    expect(scroller).toBeTruthy();
    const tokens = scroller!.className.split(/\s+/);
    expect(tokens).toContain("pb-8");
    expect(tokens).not.toContain("pb-5");
  });

  test("supply matrix refreshes Linear on demand and collapses repos without a snapshot (WM-824)", async () => {
    const urls: string[] = [];
    const base = ticketsFetch();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      urls.push(String(input));
      return base(input, init);
    }) as typeof fetch;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Ticket ticketId={null} onNavigate={() => {}} />
      </QueryClientProvider>,
    );

    const supply = await view.findByTestId("ticket-supply");
    expect(within(supply).getByText("Refresh")).toBeTruthy();
    expect(within(supply).getByText("factory")).toBeTruthy();
    expect(within(supply).getByText("2")).toBeTruthy();
    expect(within(supply).getAllByText("dispatch").length).toBeGreaterThan(0);
    expect(within(supply).getByRole("table").textContent).not.toContain(
      "ghost",
    );
    expect(within(supply).getByText(/without a snapshot/)).toBeTruthy();

    fireEvent.click(within(supply).getByText("Refresh"));
    await waitFor(() => {
      expect(
        urls.some((url) => url.includes("/api/tickets/supply?refresh=1")),
      ).toBe(true);
    });
  });
});

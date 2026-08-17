import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { prCandidateRunIds, PullRequest, Ticket } from "./Ticket";
import type { JourneyRun, TicketJourneySource } from "../subjectJourney";

const realFetch = globalThis.fetch;

function run(id: string, at: string, artifact: Record<string, unknown> = {}): JourneyRun {
  return {
    run: {
      runId: id,
      state: "COMPLETED",
      attempts: 1,
      created_at: at,
      updated_at: new Date(Date.parse(at) + 60_000).toISOString(),
      spec: { agent: id === "run_merge" ? "merge-apply@1" : "dispatch@1", adapter: "pi" },
    },
    lifecycle: [
      { seq: 1, from_state: null, to_state: "QUEUED", actor: "planner", reason: null, attempt: null, at },
      { seq: 2, from_state: "QUEUED", to_state: "COMPLETED", actor: "worker_demo", reason: "ok", attempt: 1, at: new Date(Date.parse(at) + 60_000).toISOString() },
    ],
    result: { terminalState: "completed", artifact },
    usage: { totals: { attempts: 1, totalTokens: 100, costUSD: 0.5 }, attempts: [{}] },
  };
}

function source(): TicketJourneySource {
  return {
    ticket: { id: "WM-542", title: "Ticket journey fixture", state: "In Review", createdAt: "2026-01-01T09:00:00.000Z", url: "https://linear.app/watt-mind/issue/WM-542" },
    activity: true,
    events: [{
      source: "operator", eventId: "dispatch-542", type: "factory.ticket.dispatched", subject: "WM-542", status: "planned",
      occurredAt: "2026-01-01T09:01:00.000Z", admittedAt: "2026-01-01T09:01:01.000Z", proposalId: "prop_1", runId: "run_dispatch",
      envelope: { payload: { ticket: "WM-542" } },
    }],
    proposals: [{ id: "prop_1", decision: "run", status: "approved", reason: null, created_at: "2026-01-01T09:01:02.000Z", decided_at: null, runId: "run_dispatch", eventId: "dispatch-542", eventSource: "operator", agent: "dispatch@1", spec: null }],
    runs: [
      run("run_dispatch", "2026-01-01T09:02:00.000Z", { outcome: "PR_OPEN", prUrl: "https://github.com/watt-mind/factory/pull/499" }),
      run("run_merge", "2026-01-01T10:00:00.000Z", { pr: 499, checksGreen: true, outcome: "MERGED" }),
    ],
  };
}

function renderTicket(data: TicketJourneySource) {
  globalThis.fetch = (async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  return render(<QueryClientProvider client={queryClient}><Ticket ticketId="WM-542" onNavigate={() => {}} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("Ticket journey view", () => {
  test("renders a two-run journey, PR, aggregates, timeline sources, and current-state block", async () => {
    const view = renderTicket(source());
    await view.findByRole("heading", { name: "WM-542" });
    expect(view.getAllByText("Ticket journey fixture").length).toBeGreaterThan(0);
    expect(view.getByText("$1.00")).toBeTruthy();
    expect(view.getByText("2", { selector: "div" })).toBeTruthy();
    expect(view.getByText("PR #499 opened")).toBeTruthy();
    expect(view.getByText("CI checks green")).toBeTruthy();
    expect(view.getByText("merged")).toBeTruthy();
    expect(view.getByRole("link", { name: "run_dispatch · COMPLETED" }).getAttribute("href")).toBe("#/run/run_dispatch");
    const timeline = view.getByRole("region", { name: /timeline/i });
    expect(within(timeline).getAllByText("QUEUED").length).toBeGreaterThan(0);
    expect(view.getByRole("heading", { name: "Where it is now" })).toBeTruthy();
  });

  test("renders a noop-only ticket with an actionable blocking reason and unknown aggregates", async () => {
    const data = source();
    data.runs = [];
    data.ticket.state = "Todo";
    data.ticket.createdAt = null;
    data.events[0].status = "noop";
    data.proposals[0] = { ...data.proposals[0], decision: "noop", reason: "owned_paths_overlap:WM-544", runId: null };
    const view = renderTicket(data);
    await view.findByRole("heading", { name: "WM-542" });
    expect(view.getAllByText("—").length).toBeGreaterThan(0);
    expect(view.getByText("Owned paths overlap — WM-544")).toBeTruthy();
    expect(view.getByText(/Waiting: Owned paths overlap/)).toBeTruthy();
    expect(view.container.textContent).not.toContain("$0.00");
  });

  test("unknown ids render an inline no-activity notice instead of a blank page", async () => {
    const data = source();
    data.ticket.id = "WM-999";
    data.ticket.title = null;
    data.ticket.state = null;
    data.ticket.createdAt = null;
    data.ticket.url = "https://linear.app/watt-mind/issue/WM-999";
    data.activity = false;
    data.events = [];
    data.proposals = [];
    data.runs = [];
    globalThis.fetch = (async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    const view = render(<QueryClientProvider client={client}><Ticket ticketId="WM-999" onNavigate={() => {}} /></QueryClientProvider>);
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("no runtime activity for WM-999"));
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
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (/\/api\/events/.test(url)) return json({ events: data.events });
    if (/\/api\/proposals/.test(url)) return json({ proposals: data.proposals });
    if (/\/api\/inbox/.test(url)) return json({ items: data.inbox ?? [] });
    if (/\/api\/schedules/.test(url)) return json({ schedules: data.schedules ?? [] });
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
    fix: [{ pr: 541, headSha: "6dbaab46a7f362ea66f907b630e57849e2631915", headRef: "feat/WM-627", ticket: "WM-627", finding: "Fix the failing owned test.", round: 1 }],
  });
  scan.run.spec = { agent: "merge-scan@2", adapter: "cursor", input: { repo: "factory", repoPin: { github: "watt-mind/factory" } } };
  scan.run.updated_at = "2026-08-17T19:06:02.000Z";
  scan.lifecycle[1].at = "2026-08-17T19:06:02.000Z";
  const dispatch = run("run_dispatch", "2026-08-17T18:27:40.000Z");
  dispatch.run.spec = { agent: "dispatch@1", adapter: "pi", input: { repo: "factory", ticket: "WM-627" } };
  dispatch.run.state = "FAILED";
  dispatch.run.updated_at = "2026-08-17T19:10:30.000Z";
  dispatch.lifecycle[1] = { ...dispatch.lifecycle[1], to_state: "FAILED", at: "2026-08-17T19:10:30.000Z" };
  dispatch.result = null;
  const fix = run("run_fix", "2026-08-17T19:06:04.000Z");
  fix.run.spec = { agent: "merge-fix@1", adapter: "cursor", input: { repo: "factory", github: "watt-mind/factory", pr: 541, headSha: "6dbaab46a7f362ea66f907b630e57849e2631915", ticket: "WM-627" } };
  fix.run.state = "REFUSED";
  fix.run.updated_at = "2026-08-17T19:06:05.000Z";
  fix.lifecycle[1] = { ...fix.lifecycle[1], to_state: "REFUSED", reason: "merge_fix_pr_moved", at: "2026-08-17T19:06:05.000Z" };
  fix.result = { terminalState: "refused", reasonCode: "merge_fix_pr_moved" };
  const events = [
    {
      source: "schedule", eventId: "clock:merge-factory:2026-08-17T18:45:00.000Z", type: "factory.merge.requested", subject: "merge-factory", status: "planned",
      occurredAt: "2026-08-17T18:45:00.000Z", admittedAt: "2026-08-17T18:45:00.000Z", correlationId: "clock:merge-factory:2026-08-17T18:45:00.000Z", proposalId: null, runId: "run_scan",
      envelope: { payload: { repo: "factory", loop: "merge-factory" } }, repos: ["factory"],
    },
    {
      source: "chain", eventId: "chain-run_scan-fix-541", type: "factory.merge-fix.requested", subject: "merge-scan@2", status: "planned",
      occurredAt: "2026-08-17T19:06:03.000Z", admittedAt: "2026-08-17T19:06:03.000Z", correlationId: "clock:merge-factory:2026-08-17T18:45:00.000Z", proposalId: "prop_fix", runId: "run_fix",
      envelope: { payload: { repo: "factory", github: "watt-mind/factory", pr: 541, headSha: "6dbaab46a7f362ea66f907b630e57849e2631915", headRef: "feat/WM-627", ticket: "WM-627", round: 1 } }, repos: ["factory"],
    },
    {
      source: "operator", eventId: "operator:dispatch:WM-627", type: "factory.dispatch.requested", subject: "WM-627", status: "planned",
      occurredAt: "2026-08-17T18:27:40.000Z", admittedAt: "2026-08-17T18:27:40.000Z", correlationId: null, proposalId: null, runId: "run_dispatch",
      envelope: { payload: { repo: "factory", ticket: "WM-627" } }, repos: ["factory"],
    },
  ];
  const proposals = [
    { id: "prop_fix", decision: "run", status: "approved", reason: null, created_at: "2026-08-17T19:06:04.000Z", decided_at: null, runId: "run_fix", eventId: "chain-run_scan-fix-541", eventSource: "chain", agent: "merge-fix@1", spec: null, expired: false, ttl_seconds: 0, decided_by: null, repos: [] },
  ];
  return { events, proposals, runs: { run_scan: scan, run_dispatch: dispatch, run_fix: fix }, schedules: [{ loop: "merge-factory", repo: "factory", eventType: "factory.merge.requested", nextDue: "2026-08-17T19:30:00.000Z", enabled: true }] };
}

describe("PR journey view", () => {
  test("renders #/prs/541 with the scan verdict, the concurrent dispatch, and the humanized refusal", async () => {
    const data = prData();
    globalThis.fetch = prFetch(data);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    const view = render(<QueryClientProvider client={client}><PullRequest number="541" onNavigateTicket={() => {}} /></QueryClientProvider>);
    await view.findByRole("heading", { name: "#541" });
    expect(view.getByText("feat/WM-627")).toBeTruthy();
    expect(view.getByRole("link", { name: "WM-627" }).getAttribute("href")).toBe("#/tickets/WM-627");
    expect(view.getByRole("link", { name: "Open on GitHub ↗" }).getAttribute("href")).toBe("https://github.com/watt-mind/factory/pull/541");
    expect(view.getByText("merge-scan: FIX · reviewed at 6dbaab4 · round 1")).toBeTruthy();
    expect(view.getByText("↔ WM-627 dispatch run_dispatch was active during merge-scan")).toBeTruthy();
    expect(view.getByText("merge-fix refused · PR head moved since the scan (merge_fix_pr_moved)")).toBeTruthy();
    expect(view.getByText(/^next: merge-factory at/)).toBeTruthy();
    expect(view.getByText(/Waiting: PR head moved since the scan/)).toBeTruthy();
    // The failed dispatch is context, not one of the PR's own runs.
    expect(view.getByText("2", { selector: "div" })).toBeTruthy();
  });

  test("an unknown PR reads as no runtime activity, and a bad reference as an inline error", async () => {
    globalThis.fetch = prFetch({ events: [], proposals: [], runs: {} });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    const view = render(<QueryClientProvider client={client}><PullRequest number="9999" /></QueryClientProvider>);
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("no runtime activity for PR #9999"));
    cleanup();
    const bad = render(<QueryClientProvider client={client}><PullRequest number="not-a-pr" /></QueryClientProvider>);
    expect(bad.getByRole("alert").textContent).toContain("Invalid PR reference");
  });

  test("prCandidateRunIds is bounded to the PR's chains and its ticket, never the whole registry", () => {
    const data = prData();
    const runs = Object.values(data.runs).map((run) => ({
      runId: run.run.runId, state: run.run.state, attempts: 1, maxAttempts: 1, agent: run.run.spec.agent, adapter: run.run.spec.adapter,
      reasonCode: null, eventId: null, eventSource: null, created_at: run.run.created_at, updated_at: run.run.updated_at, repos: ["factory"],
    }));
    runs.push({ ...runs[0], runId: "run_unrelated", agent: "dispatch@1" });
    const ids = prCandidateRunIds(541, { events: data.events as any, proposals: data.proposals as any, runs: runs as any });
    expect(ids.sort()).toEqual(["run_dispatch", "run_fix", "run_scan"]);
  });
});

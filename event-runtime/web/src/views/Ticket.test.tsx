import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { Ticket } from "./Ticket";
import type { JourneyRun, TicketJourneySource } from "../ticketJourney";

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

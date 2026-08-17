import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Chain } from "./Chain";
import { CHAIN_VIEW_STORAGE_KEY } from "../chainTimeline";
import { createRunDetailFixture, renderWithClient, restoreApi } from "../test-render";
import type { ChainView, LifecycleEvent, Proposal } from "../types";

const CORR = "clock:merge-factory:2026-08-17T18:45:00.000Z";
const FIX_RUN = "run_643c2c35-838d-47fd-ae37-4051214269ba";
const FIX_EVENT = "chain-run_30f0f8b7-fix-541";

function chainView(): ChainView {
  return {
    correlationId: CORR,
    events: [
      {
        source: "chain",
        eventId: FIX_EVENT,
        type: "factory.merge-fix.requested",
        subject: "factory",
        status: "planned",
        occurredAt: "2026-08-17T19:05:58.000Z",
        receivedAt: "2026-08-17T19:05:58.100Z",
        admittedAt: "2026-08-17T19:05:58.283Z",
        correlationId: CORR,
        causationId: null,
        proposalId: "prop_1",
        proposalStatus: "approved",
        proposalDecision: "run",
        runId: FIX_RUN,
        repos: ["factory"],
      },
    ],
    runs: [
      {
        runId: FIX_RUN,
        state: "REFUSED",
        attempts: 1,
        agent: "merge-fix@1",
        adapter: "pi",
        reasonCode: "merge_fix_pr_moved",
        eventId: FIX_EVENT,
        eventSource: "chain",
        created_at: "2026-08-17T19:06:04.284Z",
        updated_at: "2026-08-17T19:06:07.657Z",
        startedAt: "2026-08-17T19:06:05.105Z",
        finishedAt: "2026-08-17T19:06:07.657Z",
        repos: ["factory"],
      },
    ],
  };
}

function lc(seq: number, from: string | null, to: string, actor: string, reason: string | null, at: string): LifecycleEvent {
  return { seq, run_id: FIX_RUN, from_state: from, to_state: to, actor, reason, attempt: null, at };
}

const runDetail = createRunDetailFixture({
  run: {
    runId: FIX_RUN,
    state: "REFUSED",
    spec: { agent: "merge-fix@1", input: { github: "watt-mind/factory", pr: 541, ticket: "WM-627", headSha: "6dbaab46a7f362ea66f907b630e57849e2631915" } },
  } as any,
  lifecycle: [
    lc(1, null, "PROPOSED", "planner", "planned", "2026-08-17T19:06:04.284Z"),
    lc(2, "PROPOSED", "APPROVED", "chain-auto-approval", "auto_approved:chain-policy@1", "2026-08-17T19:06:04.284Z"),
    lc(3, "APPROVED", "QUEUED", "chain-auto-approval", "auto_approved:chain-policy@1", "2026-08-17T19:06:04.284Z"),
    lc(4, "QUEUED", "LEASED", "worker_30596_69", "claimed", "2026-08-17T19:06:05.102Z"),
    lc(5, "LEASED", "RUNNING", "worker_30596_69", "started", "2026-08-17T19:06:05.105Z"),
    lc(6, "RUNNING", "VERIFYING", "worker_30596_69", "merge_fix_pr_moved", "2026-08-17T19:06:07.657Z"),
    lc(7, "VERIFYING", "REFUSED", "worker_30596_69", "merge_fix_pr_moved", "2026-08-17T19:06:07.657Z"),
  ],
});

const proposal: Proposal = {
  id: "prop_1",
  decision: "run",
  status: "approved",
  expired: false,
  created_at: "2026-08-17T19:06:04.284Z",
  ttl_seconds: 1800,
  decided_at: "2026-08-17T19:06:04.284Z",
  decided_by: "chain-auto-approval",
  reason: null,
  runId: FIX_RUN,
  eventId: FIX_EVENT,
  eventSource: "chain",
  agent: "merge-fix@1",
  spec: null,
  repos: ["factory"],
};

function renderChain(props: Partial<React.ComponentProps<typeof Chain>> = {}) {
  const selected: Array<string | null> = [];
  const view = renderWithClient(
    <Chain
      correlationId={CORR}
      focusNodeId={null}
      onSelectNode={(id) => selected.push(id)}
      onJumpEvent={() => {}}
      onJumpRun={() => {}}
      onOpenRunFull={() => {}}
      onJumpProposal={() => {}}
      onJumpAgent={() => {}}
      {...props}
    />,
    {
      apiMocks: {
        chain: async () => chainView(),
        run: async () => runDetail,
        proposalHistory: async () => ({ proposals: [proposal] }),
        schedules: async () => ({
          schedules: [
            {
              loop: "merge-factory",
              repo: "factory",
              every: "15m",
              cadenceSeconds: 900,
              eventType: "factory.merge.requested",
              approval: "auto",
              catchUp: "last",
              singleton: true,
              enabled: true,
              lastSlot: null,
              lastCompletedSlot: null,
              neverCompleted: false,
              nextDue: new Date(Date.now() + 9 * 60_000).toISOString(),
              intervalsLate: 0,
              stopped: false,
              error: null,
            },
          ],
        }),
        inbox: async () => ({ items: [] }),
      },
    },
  );
  return { ...view, selected };
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = `#/chain/${encodeURIComponent(CORR)}`;
});

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
  window.location.hash = "";
});

describe("Chain view — Timeline mode (WM-639)", () => {
  test("Graph | Timeline toggle persists and renders the narrative rows", async () => {
    const view = renderChain();
    const timelineTab = await view.findByRole("tab", { name: "Timeline" });
    expect(view.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(timelineTab);
    expect(localStorage.getItem(CHAIN_VIEW_STORAGE_KEY)).toBe("timeline");

    const list = await view.findByRole("list", { name: "Chain timeline" });
    await waitFor(() => expect(list.textContent).toContain("PR head moved after the plan"));
    const text = list.textContent ?? "";
    expect(text).toContain("factory.merge-fix.requested (PR #541, WM-627)");
    expect(text).toContain("merge-fix@1 → run_643c2c35 (auto-approved: chain-policy@1)");
    expect(text).toContain("worker_30596_69");
    expect(text).toContain("+6s");
    // origin is a merge-fix request (not the schedule's event type) → uncovered.
    expect(text).toContain("no automatic retry — needs a decision");
    // Raw reason code rides the title for the humanized text.
    expect(view.getByTitle("merge_fix_pr_moved")).toBeTruthy();
    // Jump links: PR opens GitHub, ticket opens the journey.
    const prLinks = view.getAllByTitle("https://github.com/watt-mind/factory/pull/541") as HTMLAnchorElement[];
    expect(prLinks.length).toBeGreaterThan(0);
    expect(prLinks[0].href).toBe("https://github.com/watt-mind/factory/pull/541");
    const ticketLinks = view.getAllByTitle("Open ticket journey WM-627") as HTMLAnchorElement[];
    expect(ticketLinks[0].getAttribute("href")).toBe("#/tickets/WM-627");
  });

  test("`t` toggles the mode and the persisted mode is restored on mount", async () => {
    localStorage.setItem(CHAIN_VIEW_STORAGE_KEY, "timeline");
    const view = renderChain();
    await view.findByRole("list", { name: "Chain timeline" });
    expect(view.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(document.body, { key: "t" });
    await waitFor(() => expect(view.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected")).toBe("true"));
    expect(localStorage.getItem(CHAIN_VIEW_STORAGE_KEY)).toBe("graph");
    expect(view.queryByRole("list", { name: "Chain timeline" })).toBeNull();
  });

  test("deep link ?view=timeline&node= opens the timeline, lifts the node into the selection, and highlights its rows", async () => {
    const nodeId = `run:${FIX_RUN}`;
    window.location.hash = `#/chain/${encodeURIComponent(CORR)}?view=timeline&node=${encodeURIComponent(nodeId)}`;
    const view = renderChain({ focusNodeId: null });
    await view.findByRole("list", { name: "Chain timeline" });
    expect(view.selected).toEqual([nodeId]);
    // The mode came from the URL, not the store — the persisted preference is untouched.
    expect(localStorage.getItem(CHAIN_VIEW_STORAGE_KEY)).toBeNull();

    cleanup();
    const focused = renderChain({ focusNodeId: nodeId });
    const list = await focused.findByRole("list", { name: "Chain timeline" });
    await waitFor(() => expect(list.querySelectorAll('[aria-current="true"]').length).toBeGreaterThan(0));
    for (const li of list.querySelectorAll('[aria-current="true"]')) {
      expect(li.getAttribute("data-node-id")).toBe(nodeId);
    }
    // Enter re-asserts the selection (opens the pane as in graph mode).
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(focused.selected).toContain(nodeId);
    // The detail pane shows the run, with the reveal action renamed for the mode.
    expect(await focused.findByRole("button", { name: /Show in timeline/ })).toBeTruthy();
    expect(focused.getByRole("button", { name: "Open run" })).toBeTruthy();
  });

  test("j/k in timeline mode walk the narrative order of nodes", async () => {
    localStorage.setItem(CHAIN_VIEW_STORAGE_KEY, "timeline");
    const view = renderChain();
    const list = await view.findByRole("list", { name: "Chain timeline" });
    await waitFor(() => expect(list.textContent).toContain("REFUSED"));
    fireEvent.keyDown(document.body, { key: "j" });
    expect(view.selected).toEqual([`event:chain:${FIX_EVENT}`]);
  });
});

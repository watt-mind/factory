import "../test-dom";
import { useEffect } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { CHAIN_VIEW_STORAGE_KEY } from "../chainTimeline";
import {
  createRunDetailFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { ChainEvent, ChainView, LifecycleEvent, Proposal } from "../types";

const fitView = mock((_options: unknown) => {});

// `mock.module` persists for the whole `bun test` process, so this overrides
// only the one export Chain's own tests actually need faked — the real
// `<ReactFlow>` needs full viewport/DOM measurement this environment can't
// give it. Everything else (Handle, Background, Position, ReactFlowProvider,
// applyNodeChanges, …) stays the genuine module, so files that happen to run
// in the same process (graph/nodes.test.tsx, graph/layout.test.ts) still see
// real behavior. The fake `<ReactFlow>` renders node components straight
// into a real `<ReactFlowProvider>` so `Handle` still has the store context
// it needs.
const actualXyflow = (await import("@xyflow/react")) as Record<
  string,
  unknown
> & {
  ReactFlowProvider: React.ComponentType<{ children?: React.ReactNode }>;
};
mock.module("@xyflow/react", () => ({
  ...actualXyflow,
  ReactFlow: ({ nodes, nodeTypes, onInit }: any) => {
    useEffect(() => {
      onInit({ fitView, getZoom: () => 1 });
    }, []);
    return (
      <actualXyflow.ReactFlowProvider>
        <div data-testid="chain-flow">
          {nodes.map((node: any) => {
            const NodeComponent = nodeTypes[node.type];
            return <NodeComponent key={node.id} {...node} />;
          })}
        </div>
      </actualXyflow.ReactFlowProvider>
    );
  },
}));

const { Chain } = await import("./Chain");

// Belt-and-braces: put the real `ReactFlow` back once this file's own tests
// are done, in case any later-running file in the same process renders it.
afterAll(() => {
  mock.module("@xyflow/react", () => actualXyflow);
});

const noop = () => {};
const NOW = new Date().toISOString();

function chainEvent(
  eventId: string,
  overrides: Partial<ChainEvent> = {},
): ChainEvent {
  return {
    source: "factory",
    eventId,
    type: "factory.dispatch.requested",
    subject: "WM-273",
    status: "noop",
    occurredAt: NOW,
    receivedAt: NOW,
    admittedAt: NOW,
    correlationId: "operator:dispatch:WM-518",
    causationId: null,
    proposalId: null,
    proposalStatus: null,
    proposalDecision: null,
    runId: null,
    envelope: {
      schemaVersion: "factory.event/v1",
      eventId,
      type: "factory.dispatch.requested",
      source: "factory",
      subject: "WM-273",
      occurredAt: NOW,
      correlationId: "operator:dispatch:WM-518",
      causationId: null,
      payload: {},
    },
    repos: [],
    ...overrides,
  };
}

function renderChainGraph() {
  return renderWithClient(
    <Chain
      correlationId="operator:dispatch:WM-518"
      focusNodeId={null}
      onSelectNode={noop}
      onJumpEvent={noop}
      onJumpRun={noop}
      onOpenRunFull={noop}
      onJumpProposal={noop}
      onJumpAgent={noop}
    />,
  );
}

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
        envelope: {
          schemaVersion: "factory.event/v1",
          eventId: FIX_EVENT,
          type: "factory.merge-fix.requested",
          source: "chain",
          subject: "factory",
          occurredAt: "2026-08-17T19:05:58.000Z",
          correlationId: CORR,
          causationId: null,
          payload: { repo: "factory" },
        },
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

function lc(
  seq: number,
  from: string | null,
  to: string,
  actor: string,
  reason: string | null,
  at: string,
): LifecycleEvent {
  return {
    seq,
    run_id: FIX_RUN,
    from_state: from,
    to_state: to,
    actor,
    reason,
    attempt: null,
    at,
  };
}

const runDetail = createRunDetailFixture({
  run: {
    runId: FIX_RUN,
    state: "REFUSED",
    spec: {
      agent: "merge-fix@1",
      input: {
        github: "watt-mind/factory",
        pr: 541,
        ticket: "WM-627",
        headSha: "6dbaab46a7f362ea66f907b630e57849e2631915",
      },
    },
  } as any,
  lifecycle: [
    lc(1, null, "PROPOSED", "planner", "planned", "2026-08-17T19:06:04.284Z"),
    lc(
      2,
      "PROPOSED",
      "APPROVED",
      "chain-auto-approval",
      "auto_approved:chain-policy@1",
      "2026-08-17T19:06:04.284Z",
    ),
    lc(
      3,
      "APPROVED",
      "QUEUED",
      "chain-auto-approval",
      "auto_approved:chain-policy@1",
      "2026-08-17T19:06:04.284Z",
    ),
    lc(
      4,
      "QUEUED",
      "LEASED",
      "worker_30596_69",
      "claimed",
      "2026-08-17T19:06:05.102Z",
    ),
    lc(
      5,
      "LEASED",
      "RUNNING",
      "worker_30596_69",
      "started",
      "2026-08-17T19:06:05.105Z",
    ),
    lc(
      6,
      "RUNNING",
      "VERIFYING",
      "worker_30596_69",
      "merge_fix_pr_moved",
      "2026-08-17T19:06:07.657Z",
    ),
    lc(
      7,
      "VERIFYING",
      "REFUSED",
      "worker_30596_69",
      "merge_fix_pr_moved",
      "2026-08-17T19:06:07.657Z",
    ),
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
  const openedRuns: string[] = [];
  const jumpedRuns: string[] = [];
  const jumpedEvents: string[] = [];
  const view = renderWithClient(
    <Chain
      correlationId={CORR}
      focusNodeId={null}
      onSelectNode={(id) => selected.push(id)}
      onJumpEvent={(source, id) => jumpedEvents.push(`${source}:${id}`)}
      onJumpRun={(id) => jumpedRuns.push(id)}
      onOpenRunFull={(id) => openedRuns.push(id)}
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
  return { ...view, selected, openedRuns, jumpedRuns, jumpedEvents };
}

afterEach(() => {
  cleanup();
  restoreApi();
  fitView.mockClear();
});

describe("Chain", () => {
  test("fits the graph on mount with the chain padding", async () => {
    const view: ChainView = {
      correlationId: "operator:dispatch:WM-518",
      events: [chainEvent("chain-run_5b20cfd4")],
      runs: [],
    };

    await withApi({ chain: async () => view }, async () => {
      renderChainGraph();
      await waitFor(() => expect(fitView).toHaveBeenCalled());
      expect(fitView.mock.calls[0]?.[0]).toEqual({ padding: "24px" });
    });
  });

  test("orders event labels by subject, type, then age and numbers identical siblings", async () => {
    const view: ChainView = {
      correlationId: "operator:dispatch:WM-518",
      events: [
        chainEvent("chain-run_5b20cfd4"),
        chainEvent("chain-run_8c91aa20"),
      ],
      runs: [],
    };

    await withApi({ chain: async () => view }, async () => {
      const rendered = renderChainGraph();
      await waitFor(() => expect(rendered.getByText("WM-273 #1")).toBeTruthy());
      expect(rendered.getByText("WM-273 #2")).toBeTruthy();

      const card = rendered
        .getAllByRole("button", {
          name: /event factory\.dispatch\.requested, noop/i,
        })
        .find(
          (candidate) =>
            candidate.getAttribute("title") === "chain-run_5b20cfd4",
        )!;
      const text = card.textContent ?? "";
      expect(text.indexOf("WM-273 #1")).toBeLessThan(
        text.indexOf("factory.dispatch.requested"),
      );
      expect(card.getAttribute("title")).toBe("chain-run_5b20cfd4");
      expect(text).not.toContain("chain-run_5b20cfd4");
    });
  });
});

describe("Chain view — Timeline mode (WM-639)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = `#/chain/${encodeURIComponent(CORR)}`;
  });

  afterEach(() => {
    localStorage.clear();
    window.location.hash = "";
  });

  test("Graph | Timeline toggle persists and renders the narrative rows", async () => {
    const view = renderChain();
    const timelineTab = await view.findByRole("tab", { name: "Timeline" });
    expect(
      view.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(timelineTab);
    expect(localStorage.getItem(CHAIN_VIEW_STORAGE_KEY)).toBe("timeline");

    const list = await view.findByRole("list", { name: "Chain timeline" });
    await waitFor(() =>
      expect(list.textContent).toContain("PR head moved after the plan"),
    );
    const text = list.textContent ?? "";
    expect(text).toContain("factory.merge-fix.requested (PR #541, WM-627)");
    expect(text).toContain(
      "merge-fix@1 → run_643c2c35 (auto-approved: chain-policy@1)",
    );
    expect(text).toContain("worker_30596_69");
    expect(text).toContain("+6s");
    // origin is a merge-fix request (not the schedule's event type) → uncovered.
    expect(text).toContain("no automatic retry — needs a decision");
    // Raw reason code rides the title for the humanized text.
    expect(view.getByTitle("merge_fix_pr_moved")).toBeTruthy();
    // Jump links: PR opens GitHub, ticket opens the journey.
    const prLinks = view.getAllByTitle(
      "https://github.com/watt-mind/factory/pull/541",
    ) as HTMLAnchorElement[];
    expect(prLinks.length).toBeGreaterThan(0);
    expect(prLinks[0].href).toBe(
      "https://github.com/watt-mind/factory/pull/541",
    );
    const ticketLinks = view.getAllByTitle(
      "Open ticket journey WM-627",
    ) as HTMLAnchorElement[];
    expect(ticketLinks[0].getAttribute("href")).toBe("#/tickets/WM-627");
  });

  test("`t` toggles the mode and the persisted mode is restored on mount", async () => {
    localStorage.setItem(CHAIN_VIEW_STORAGE_KEY, "timeline");
    const view = renderChain();
    await view.findByRole("list", { name: "Chain timeline" });
    expect(
      view.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(document.body, { key: "t" });
    await waitFor(() =>
      expect(
        view.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
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
    await waitFor(() =>
      expect(
        list.querySelectorAll('[aria-current="true"]').length,
      ).toBeGreaterThan(0),
    );
    for (const li of list.querySelectorAll('[aria-current="true"]')) {
      expect(li.getAttribute("data-node-id")).toBe(nodeId);
    }
    // Enter triggers Open run on selected run node (WM-875).
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(focused.openedRuns).toContain(FIX_RUN);
    // The detail pane shows the run, with the reveal action renamed for the mode.
    expect(
      await focused.findByRole("button", { name: /Show in timeline/ }),
    ).toBeTruthy();
    expect(focused.getByRole("button", { name: /Open run/ })).toBeTruthy();
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

describe("Chain header state bar (WM-832)", () => {
  test("mixed-state chain shows ChainStateBar, not header StateBadges", async () => {
    const view: ChainView = {
      correlationId: "operator:dispatch:WM-518",
      events: [chainEvent("chain-run_5b20cfd4")],
      runs: [
        {
          runId: "run_completed_a",
          state: "COMPLETED",
          attempts: 1,
          agent: "agent-a",
          adapter: "pi",
          reasonCode: null,
          eventId: "chain-run_5b20cfd4",
          eventSource: "factory",
          created_at: NOW,
          updated_at: NOW,
          startedAt: NOW,
          finishedAt: NOW,
          repos: [],
        },
        {
          runId: "run_completed_b",
          state: "COMPLETED",
          attempts: 1,
          agent: "agent-b",
          adapter: "pi",
          reasonCode: null,
          eventId: "chain-run_5b20cfd4",
          eventSource: "factory",
          created_at: NOW,
          updated_at: NOW,
          startedAt: NOW,
          finishedAt: NOW,
          repos: [],
        },
        {
          runId: "run_failed_a",
          state: "FAILED",
          attempts: 1,
          agent: "agent-c",
          adapter: "pi",
          reasonCode: null,
          eventId: "chain-run_5b20cfd4",
          eventSource: "factory",
          created_at: NOW,
          updated_at: NOW,
          startedAt: NOW,
          finishedAt: NOW,
          repos: [],
        },
      ],
    };

    await withApi({ chain: async () => view }, async () => {
      const rendered = renderChainGraph();
      await waitFor(() =>
        expect(rendered.getByText(/1 event · 3 runs/)).toBeTruthy(),
      );

      const bar = rendered.getByRole("img", {
        name: /COMPLETED 2.*FAILED 1/,
      });
      expect(bar.getAttribute("aria-label")).toContain("COMPLETED");
      expect(bar.getAttribute("aria-label")).toContain("FAILED");
      expect(rendered.queryByText("FAILED ×1")).toBeNull();
      expect(rendered.queryByText("COMPLETED ×2")).toBeNull();
    });
  });
});

describe("Chain navigation shortcuts (WM-875)", () => {
  test("when run node is selected, o / Enter triggers onOpenRunFull and r triggers onJumpRun", async () => {
    const runNodeId = `run:${FIX_RUN}`;
    const view = renderChain({ focusNodeId: runNodeId });

    const openRunBtn = await waitFor(() =>
      view.getByRole("button", { name: /Open run/ }),
    );
    expect(openRunBtn.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "o",
    );
    const showInRunsBtn = view.getByRole("button", { name: /Show in Runs/ });
    expect(
      showInRunsBtn.querySelector('[aria-hidden="true"]')?.textContent,
    ).toBe("r");

    // Open run via 'o'
    fireEvent.keyDown(document.body, { key: "o" });
    expect(view.openedRuns).toContain(FIX_RUN);

    // Open run via 'Enter'
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(view.openedRuns.filter((id) => id === FIX_RUN).length).toBe(2);

    // Jump to runs via 'r'
    fireEvent.keyDown(document.body, { key: "r" });
    expect(view.jumpedRuns).toContain(FIX_RUN);
  });

  test("when event node is selected, e triggers onJumpEvent", async () => {
    const evtNodeId = `event:chain:${FIX_EVENT}`;
    const view = renderChain({ focusNodeId: evtNodeId });

    const openInEventsBtn = await waitFor(() =>
      view.getByRole("button", { name: /Open in Events/ }),
    );
    expect(
      openInEventsBtn.querySelector('[aria-hidden="true"]')?.textContent,
    ).toBe("e");

    // Open in Events via 'e'
    fireEvent.keyDown(document.body, { key: "e" });
    expect(view.jumpedEvents).toContain(`chain:${FIX_EVENT}`);
  });

  test("when an old event node is selected, renders its chain envelope without a recent-events lookup", async () => {
    localStorage.clear();
    const evtNodeId = `event:chain:${FIX_EVENT}`;
    const events = mock(async () => {
      throw new Error("recent event window must not be queried");
    });
    await withApi({ events }, async () => {
      const view = renderChain({ focusNodeId: evtNodeId });
      await waitFor(() => {
        expect(view.getByText("Envelope")).toBeTruthy();
        expect(
          view.getAllByText("factory.merge-fix.requested").length,
        ).toBeGreaterThan(0);
      });
      expect(events).not.toHaveBeenCalled();
    });
  });

  test("names the safe malformed envelope fallback", async () => {
    const evtNodeId = `event:chain:${FIX_EVENT}`;
    const view = renderWithClient(
      <Chain
        correlationId={CORR}
        focusNodeId={evtNodeId}
        onSelectNode={noop}
        onJumpEvent={noop}
        onJumpRun={noop}
        onOpenRunFull={noop}
        onJumpProposal={noop}
        onJumpAgent={noop}
      />,
      {
        apiMocks: {
          chain: async () => ({
            ...chainView(),
            events: [
              chainEvent(FIX_EVENT, {
                source: "chain",
                correlationId: CORR,
                envelope: { __malformed: true },
              }),
            ],
          }),
        },
      },
    );
    await waitFor(() => {
      expect(
        view.getByText(
          "Stored envelope is malformed; its raw form cannot be shown.",
        ),
      ).toBeTruthy();
    });
  });
});

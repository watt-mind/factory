import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { useRef } from "react";
import {
  AgentNode,
  EventTypeNode,
  ProposalNode,
  TerminalNode,
  nodeAccessibleName,
} from "./nodes";
import type { GraphNode } from "./model";
import { Graph, focusedNodeFit, useSelectedNodeReveal } from "../views/Graph";
import {
  changeInput,
  createAgentsFixture,
  createProposalFixture,
  createStatusFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { AgentsView } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
});

function renderNode(ui: React.ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

const nodeProps = (node: GraphNode, extra: Record<string, unknown> = {}) =>
  ({
    id: node.id,
    data: { node, ...extra },
    selected: false,
    type: node.kind,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    selectable: true,
    deletable: false,
    draggable: false,
  }) as any;

describe("AgentNode", () => {
  test("renders basic agent details and contract when no active runs exist", () => {
    const node: GraphNode = {
      id: "agent:doctor@1",
      kind: "agent",
      label: "doctor@1",
      adapter: "claude",
      mutating: false,
      execution: "model",
      contract: "contract/ci-doctor/v1",
      capabilities: ["ci:read"],
      actions: [],
      hosts: [],
    };

    const { getByText } = renderNode(<AgentNode {...nodeProps(node)} />);
    expect(getByText("doctor@1")).toBeTruthy();
    expect(getByText("agent · model")).toBeTruthy();
    expect(getByText("contract/ci-doctor/v1")).toBeTruthy();
    expect(getByText("ci:read")).toBeTruthy();
  });

  test("renders active run state indicators (RUNNING, QUEUED) using StateBadge styling", () => {
    const node: GraphNode = {
      id: "agent:doctor@1",
      kind: "agent",
      label: "doctor@1",
      adapter: "claude",
      mutating: true,
      execution: "command",
      contract: "contract/ci-doctor/v1",
      capabilities: [],
      actions: [],
      hosts: [],
      activeRuns: [
        { state: "RUNNING", count: 1 },
        { state: "QUEUED", count: 3 },
      ],
    };

    const { getByText } = renderNode(<AgentNode {...nodeProps(node)} />);
    expect(getByText("RUNNING")).toBeTruthy();
    expect(getByText("QUEUED 3")).toBeTruthy();
    expect(getByText("mutating")).toBeTruthy();
    expect(getByText("agent · command")).toBeTruthy();
  });
});

describe("EventTypeNode", () => {
  test("renders event type without counts when no events exist", () => {
    const node: GraphNode = {
      id: "event:gh.failed",
      kind: "eventType",
      label: "gh.failed",
      adapter: "claude",
      scope: ["repo", "sha"],
      ttl: 1800,
    };

    const { getByText } = renderNode(<EventTypeNode {...nodeProps(node)} />);
    expect(getByText("gh.failed")).toBeTruthy();
    expect(getByText("dedup: repo + sha")).toBeTruthy();
    expect(getByText("ttl: 30m")).toBeTruthy();
  });

  test("renders admitted and planned counts when live events exist", () => {
    const node: GraphNode = {
      id: "event:gh.failed",
      kind: "eventType",
      label: "gh.failed",
      adapter: "claude",
      scope: ["repo"],
      ttl: null,
      admittedCount: 4,
      plannedCount: 2,
    };

    const { getByText } = renderNode(<EventTypeNode {...nodeProps(node)} />);
    expect(getByText("4 admitted")).toBeTruthy();
    expect(getByText("2 planned")).toBeTruthy();
    expect(getByText("4 admitted · 2 planned")).toBeTruthy();
  });
});

describe("ProposalNode", () => {
  test("renders open proposal with decision StateBadge and agent ref", () => {
    const node: GraphNode = {
      id: "proposal:prop_123",
      kind: "proposal",
      label: "pending: ci-rerun@1",
      proposalId: "prop_123",
      decision: "run",
      agentRef: "ci-rerun@1",
      eventType: "ci.rerun",
      proposal: {
        id: "prop_123",
        decision: "run",
        status: "open",
        expired: false,
        created_at: new Date().toISOString(),
        ttl_seconds: 600,
        decided_at: null,
        decided_by: null,
        reason: null,
        runId: "run_456",
        eventId: "ev_789",
        eventSource: "gh",
        agent: "ci-rerun@1",
        spec: null,
        repos: [],
      },
    };

    const { getByText } = renderNode(<ProposalNode {...nodeProps(node)} />);
    expect(getByText("pending: ci-rerun@1")).toBeTruthy();
    expect(getByText("run")).toBeTruthy();
    expect(getByText("agent: ci-rerun@1")).toBeTruthy();
    expect(getByText(/ttl: 600s remaining/)).toBeTruthy();
  });
});

describe("node accessible names and selection", () => {
  const eventNode: GraphNode = {
    id: "event:gh.failed",
    kind: "eventType",
    label: "gh.failed",
    adapter: "claude",
    scope: ["repo"],
    ttl: null,
    admittedCount: 4,
    plannedCount: 2,
  };
  const agentNode: GraphNode = {
    id: "agent:doctor@1",
    kind: "agent",
    label: "doctor@1",
    adapter: "claude",
    mutating: false,
    execution: "model",
    contract: "c/v1",
    capabilities: [],
    actions: [],
    hosts: [],
    activeRuns: [{ state: "RUNNING", count: 1 }],
  };
  const terminalNode: GraphNode = {
    id: "terminal:doctor@1",
    kind: "terminal",
    label: "chain ends",
    reason: "TICKET, ENV",
  };
  const proposalNode: GraphNode = {
    id: "proposal:prop_123",
    kind: "proposal",
    label: "pending: ci-rerun@1",
    proposalId: "prop_123",
    decision: "run",
    agentRef: "ci-rerun@1",
    eventType: "ci.rerun",
    proposal: {
      id: "prop_123",
      decision: "run",
      status: "open",
      expired: false,
      created_at: new Date().toISOString(),
      ttl_seconds: 600,
      decided_at: null,
      decided_by: null,
      reason: null,
      runId: "run_456",
      eventId: "ev_789",
      eventSource: "gh",
      agent: "ci-rerun@1",
      spec: null,
      repos: [],
    },
  };

  test("names include kind, label, and material state for every node kind", () => {
    expect(nodeAccessibleName(eventNode)).toContain("event type");
    expect(nodeAccessibleName(eventNode)).toContain("gh.failed");
    expect(nodeAccessibleName(eventNode)).toMatch(/4 admitted/);
    expect(nodeAccessibleName(agentNode)).toContain("agent");
    expect(nodeAccessibleName(agentNode)).toContain("doctor@1");
    expect(nodeAccessibleName(agentNode)).toContain("RUNNING");
    expect(nodeAccessibleName(terminalNode)).toContain("terminal");
    expect(nodeAccessibleName(terminalNode)).toContain("chain ends");
    expect(nodeAccessibleName(terminalNode)).toContain("TICKET, ENV");
    expect(nodeAccessibleName(proposalNode)).toContain("proposal");
    expect(nodeAccessibleName(proposalNode)).toContain("pending: ci-rerun@1");
    expect(nodeAccessibleName(proposalNode)).toContain("run");
  });

  test("each kind exposes the accessible name and aria-selected on the node", () => {
    const cases: Array<{ ui: React.ReactElement; name: RegExp }> = [
      {
        ui: <EventTypeNode {...nodeProps(eventNode)} selected />,
        name: /event type/i,
      },
      { ui: <AgentNode {...nodeProps(agentNode)} selected />, name: /agent/i },
      {
        ui: <TerminalNode {...nodeProps(terminalNode)} selected />,
        name: /terminal/i,
      },
      {
        ui: <ProposalNode {...nodeProps(proposalNode)} selected />,
        name: /proposal/i,
      },
    ];
    for (const { ui, name } of cases) {
      const { getByRole, unmount } = renderNode(ui);
      const node = getByRole("button", { name });
      expect(node.getAttribute("aria-selected")).toBe("true");
      expect(node.getAttribute("aria-pressed")).toBe("true");
      unmount();
    }
  });

  test("unselected nodes set aria-selected false", () => {
    const { getByRole } = renderNode(
      <EventTypeNode {...nodeProps(eventNode)} />,
    );
    expect(
      getByRole("button", { name: /event type/i }).getAttribute(
        "aria-selected",
      ),
    ).toBe("false");
    expect(
      getByRole("button", { name: /event type/i }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("the current search match is visually distinct from other hits", () => {
    const hit = renderNode(
      <EventTypeNode {...nodeProps(eventNode, { searchHit: true })} />,
    );
    const hitEl = hit.getByRole("button", { name: /event type/i });
    expect(hitEl.getAttribute("data-search-hit")).toBe("true");
    expect(hitEl.getAttribute("data-search-current")).toBeNull();
    const hitStyle = (hitEl as HTMLElement).style.outlineStyle;
    hit.unmount();

    const current = renderNode(
      <EventTypeNode
        {...nodeProps(eventNode, { searchHit: true, searchCurrent: true })}
      />,
    );
    const currentEl = current.getByRole("button", { name: /event type/i });
    expect(currentEl.getAttribute("data-search-current")).toBe("true");
    expect((currentEl as HTMLElement).style.outlineStyle).not.toBe(hitStyle);
  });
});

describe("TerminalNode", () => {
  test("renders terminal node with reason", () => {
    const node: GraphNode = {
      id: "terminal:doctor@1",
      kind: "terminal",
      label: "chain ends",
      reason: "TICKET, ENV",
    };

    const { getByText } = renderNode(<TerminalNode {...nodeProps(node)} />);
    expect(getByText("chain ends")).toBeTruthy();
    expect(getByText("TICKET, ENV")).toBeTruthy();
  });
});

const stubAgent = (ref: string): AgentsView["agents"][number] =>
  ({
    ref,
    id: ref.split("@")[0],
    version: 1,
    outputContract: "c/v1",
    workspace: { type: "ephemeral" },
    capabilities: { services: [] },
    limits: { timeout_seconds: 60, attempts: 1 },
    mutating: false,
    promptFile: "p.md",
    prompt: "",
    inputSchemaFile: "i.json",
    inputSchema: {},
    outputSchemaFile: "o.json",
    outputSchema: {},
    pins: {},
    command: null,
    actionRegistry: null,
    hosts: null,
    modelTier: null,
    model: null,
    eventTypes: [],
  }) as AgentsView["agents"][number];

const graphAgents = (): AgentsView =>
  createAgentsFixture({
    agents: [stubAgent("doctor@1"), stubAgent("rerun@1")],
    eventTypes: [
      {
        type: "gh.failed",
        agent: "doctor@1",
        adapter: "claude",
        idempotencyScope: [],
        proposalTtlSeconds: null,
      },
      {
        type: "ci.rerun",
        agent: "rerun@1",
        adapter: "command",
        idempotencyScope: [],
        proposalTtlSeconds: null,
      },
    ],
  });

function SelectedNodeRevealHarness({
  focusNodeId,
  overlayVersion,
  fitView,
}: {
  focusNodeId: string | null;
  overlayVersion: number;
  fitView: (options: unknown) => void;
}) {
  const flowRef = useRef({ getZoom: () => 1, fitView });
  useSelectedNodeReveal(focusNodeId, 1, flowRef);
  return <div>overlay {overlayVersion}</div>;
}

function renderGraph(props: Partial<Parameters<typeof Graph>[0]> = {}) {
  return renderWithClient(
    <Graph
      context={{ kind: "all" }}
      focusNodeId={null}
      onSelectNode={() => {}}
      onJumpAgent={() => {}}
      onJumpEvents={() => {}}
      onJumpProposal={() => {}}
      {...props}
    />,
  );
}

describe("Graph view inspect loop", () => {
  test("deep-link focus fit centres only the requested node at the current zoom", () => {
    expect(focusedNodeFit("event:gh.failed", 0.8)).toEqual({
      nodes: [{ id: "event:gh.failed" }],
      padding: 0.45,
      duration: 180,
      minZoom: 0.8,
      maxZoom: 0.8,
    });
  });

  test("search input is mounted before layout so / does not leave Graph", async () => {
    await withApi(
      {
        agents: async () => createAgentsFixture(),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText } = renderGraph();
        const input = await waitFor(() => getByLabelText("Search graph nodes"));
        expect(input.hasAttribute("data-view-filter")).toBe(true);
      },
    );
  });

  test("search input carries data-view-filter so / can focus it", async () => {
    await withApi(
      {
        agents: async () => graphAgents(),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText } = renderGraph();
        const input = await waitFor(() => getByLabelText("Search graph nodes"));
        expect(input.hasAttribute("data-view-filter")).toBe(true);
      },
    );
  });

  test("match counter follows the input without participating in toolbar layout", async () => {
    await withApi(
      {
        agents: async () => graphAgents(),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText, getByText } = renderGraph();
        const input = (await waitFor(() =>
          getByLabelText("Search graph nodes"),
        )) as HTMLInputElement;

        changeInput(input, "agent:");
        const counter = await waitFor(() => getByText("1 / 2"));
        expect(input.nextElementSibling).toBe(counter);
        expect(counter.className).toContain("absolute");
        expect(input.parentElement?.className).toContain("w-52");

        changeInput(input, "missing");
        await waitFor(() => expect(getByText("no matches")).toBe(counter));
      },
    );
  });

  test("Escape clears a search before blurring an empty input", async () => {
    await withApi(
      {
        agents: async () => graphAgents(),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText } = renderGraph();
        const input = (await waitFor(() =>
          getByLabelText("Search graph nodes"),
        )) as HTMLInputElement;
        input.focus();
        changeInput(input, "agent:");

        fireEvent.keyDown(input, { key: "Escape" });
        expect(input.value).toBe("");
        expect(document.activeElement).toBe(input);

        fireEvent.keyDown(input, { key: "Escape" });
        expect(document.activeElement).not.toBe(input);
      },
    );
  });

  test("Enter selects match 1 of N instead of skipping to match 2", async () => {
    const onSelectNode = mock(() => {});
    await withApi(
      {
        agents: async () => graphAgents(),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText } = renderGraph({ onSelectNode });
        const input = (await waitFor(() =>
          getByLabelText("Search graph nodes"),
        )) as HTMLInputElement;
        changeInput(input, "agent:");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onSelectNode).toHaveBeenCalledWith("agent:doctor@1");
        expect(onSelectNode).not.toHaveBeenCalledWith("agent:rerun@1");
      },
    );
  });

  test("stale deep-link shows Node not found with a control that clears to #/graph", async () => {
    const onSelectNode = mock(() => {});
    await withApi(
      {
        agents: async () => graphAgents(),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByRole, getByText } = renderGraph({
          focusNodeId: "event:does-not-exist",
          onSelectNode,
        });
        await waitFor(() => getByText("Node not found"));
        fireEvent.click(getByRole("button", { name: "Show graph" }));
        expect(onSelectNode).toHaveBeenCalledWith(null);
      },
    );
  });

  test("background overlay rerenders do not re-center an unchanged focused node", async () => {
    const fitView = mock((_options: unknown) => {});
    const view = render(
      <SelectedNodeRevealHarness
        focusNodeId="event:gh.failed"
        overlayVersion={0}
        fitView={fitView}
      />,
    );
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1));
    expect(fitView.mock.calls[0]?.[0]).toMatchObject({
      nodes: [{ id: "event:gh.failed" }],
      duration: 180,
    });

    view.rerender(
      <SelectedNodeRevealHarness
        focusNodeId="event:gh.failed"
        overlayVersion={1}
        fitView={fitView}
      />,
    );
    expect(view.getByText("overlay 1")).toBeTruthy();
    expect(fitView).toHaveBeenCalledTimes(1);
  });

  test("selected proposal node delegates Open in Proposals to onJumpProposal", async () => {
    const proposal = createProposalFixture({
      id: "prop_abc",
      agent: "doctor@1",
    });
    const onJumpProposal = mock((_id: string) => {});
    await withApi(
      {
        agents: async () => graphAgents(),
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByRole } = renderGraph({
          focusNodeId: "proposal:prop_abc",
          onJumpProposal,
        });
        const btn = await waitFor(() =>
          getByRole("button", { name: "Open in Proposals" }),
        );
        fireEvent.click(btn);
        expect(onJumpProposal).toHaveBeenCalledWith("prop_abc");
      },
    );
  });
});

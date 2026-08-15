import "../test-dom";
import { describe, expect, test } from "bun:test";
import {
  graphIdentity,
  layoutGraph,
  layoutGraphIfIdentityChanged,
  LAYOUT_TIMEOUT_MS,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "./layout";
import type { CapabilityGraph, GraphNode } from "./model";

function sampleGraph(): CapabilityGraph {
  return {
    nodes: [
      { id: "event:gh.failed", kind: "eventType", label: "gh.failed", adapter: "claude", scope: [], ttl: null },
      {
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
      },
    ],
    edges: [
      { id: "routes:gh.failed", source: "event:gh.failed", target: "agent:doctor@1", kind: "routes" },
    ],
  };
}

describe("layoutGraph", () => {
  test("exports layout constants", () => {
    expect(NODE_WIDTH).toBe(236);
    expect(NODE_HEIGHT).toBe(92);
    expect(LAYOUT_TIMEOUT_MS).toBe(3000);
  });

  test("calculates positions for nodes and edges in a graph", async () => {
    const graph: CapabilityGraph = {
      nodes: [
        { id: "event:gh.failed", kind: "eventType", label: "gh.failed", adapter: "claude", scope: [], ttl: null },
        {
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
        },
      ],
      edges: [
        { id: "routes:gh.failed", source: "event:gh.failed", target: "agent:doctor@1", kind: "routes" },
      ],
    };

    const positions = await layoutGraph(graph);
    expect(positions.has("event:gh.failed")).toBe(true);
    expect(positions.has("agent:doctor@1")).toBe(true);
    const eventPos = positions.get("event:gh.failed")!;
    const agentPos = positions.get("agent:doctor@1")!;
    expect(typeof eventPos.x).toBe("number");
    expect(typeof eventPos.y).toBe("number");
    expect(typeof agentPos.x).toBe("number");
    expect(typeof agentPos.y).toBe("number");
    // Left-to-right direction means target agent is positioned to the right of source event
    expect(agentPos.x).toBeGreaterThan(eventPos.x);
  });

  test("graphIdentity ignores overlay-only count and badge fields", () => {
    const base = sampleGraph();
    const overlay: CapabilityGraph = {
      nodes: base.nodes.map((n) =>
        n.kind === "eventType"
          ? { ...n, admittedCount: 9, plannedCount: 4 }
          : n.kind === "agent"
            ? { ...n, activeRuns: [{ state: "RUNNING", count: 2 }] }
            : n,
      ),
      edges: base.edges.map((e) => ({ ...e, label: "routes (3)", invocations: 3 })),
    };
    expect(graphIdentity(overlay)).toBe(graphIdentity(base));
  });

  test("graphIdentity changes when a node or edge is added or removed", () => {
    const base = sampleGraph();
    const extraNode: GraphNode = {
      id: "terminal:doctor@1",
      kind: "terminal",
      label: "chain ends",
      reason: "TICKET",
    };
    expect(
      graphIdentity({ ...base, nodes: [...base.nodes, extraNode] }),
    ).not.toBe(graphIdentity(base));
    expect(
      graphIdentity({
        ...base,
        edges: [...base.edges, { id: "rec:x", source: "agent:doctor@1", target: "event:gh.failed", kind: "recommends" }],
      }),
    ).not.toBe(graphIdentity(base));
  });

  test("overlay-only changes do not call layoutGraph", async () => {
    const base = sampleGraph();
    const overlay: CapabilityGraph = {
      nodes: base.nodes.map((n) =>
        n.kind === "eventType" ? { ...n, admittedCount: 12 } : n,
      ),
      edges: base.edges,
    };
    let calls = 0;
    const layout = async () => {
      calls += 1;
      return new Map(base.nodes.map((n) => [n.id, { x: 0, y: 0 }] as const));
    };
    const first = await layoutGraphIfIdentityChanged(base, null, layout);
    expect(calls).toBe(1);
    expect(first.positions).not.toBeNull();
    const second = await layoutGraphIfIdentityChanged(overlay, first.identity, layout);
    expect(calls).toBe(1);
    expect(second.positions).toBeNull();
    expect(second.identity).toBe(first.identity);
  });

  test("rejects when layout calculation exceeds bounded timeout", async () => {
    const graph: CapabilityGraph = {
      nodes: [
        { id: "event:e1", kind: "eventType", label: "e1", adapter: "a", scope: [], ttl: null },
      ],
      edges: [],
    };

    // With timeoutMs = 0 (or 1ms), it must reject with a timeout error
    await expect(layoutGraph(graph, 0)).rejects.toThrow(/timed out/i);
  });
});

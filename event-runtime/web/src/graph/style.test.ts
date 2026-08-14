import { describe, expect, test } from "bun:test";
import { EDGE_STYLES, NODE_STYLES, legendEntries, nodeStyleKey } from "./style";
import type { CapabilityGraph, GraphNode } from "./model";

const agent = (ref: string, mutating: boolean): GraphNode => ({
  id: `agent:${ref}`,
  kind: "agent",
  label: ref,
  adapter: "claude",
  mutating,
  execution: "model",
  contract: "c/v1",
  capabilities: [],
  actions: [],
  hosts: [],
});

describe("nodeStyleKey", () => {
  test("splits agents by mutating flag, passes other kinds through", () => {
    expect(nodeStyleKey(agent("a@1", false))).toBe("agentReadOnly");
    expect(nodeStyleKey(agent("a@1", true))).toBe("agentMutating");
    expect(
      nodeStyleKey({ id: "terminal:a@1", kind: "terminal", label: "chain ends", reason: "done" }),
    ).toBe("terminal");
  });
});

describe("legendEntries", () => {
  test("lists only styles the graph actually uses", () => {
    const graph: CapabilityGraph = {
      nodes: [
        { id: "event:a", kind: "eventType", label: "a", adapter: "claude", scope: [], ttl: null },
        agent("a@1", false),
      ],
      edges: [{ id: "routes:a", source: "event:a", target: "agent:a@1", kind: "routes" }],
    };
    const legend = legendEntries(graph);
    expect(legend.nodes.map((n) => n.key)).toEqual(["eventType", "agentReadOnly"]);
    expect(legend.edges.map((e) => e.kind)).toEqual(["routes"]);
  });

  test("full graph advertises every style, carrying the shared constants", () => {
    const graph: CapabilityGraph = {
      nodes: [
        { id: "event:a", kind: "eventType", label: "a", adapter: "claude", scope: [], ttl: null },
        agent("a@1", false),
        agent("b@1", true),
        { id: "terminal:b@1", kind: "terminal", label: "chain ends", reason: "done" },
      ],
      edges: [
        { id: "routes:a", source: "event:a", target: "agent:a@1", kind: "routes" },
        { id: "rec:b@1:x", source: "agent:b@1", target: "event:a", kind: "recommends" },
      ],
    };
    const legend = legendEntries(graph);
    expect(legend.nodes).toEqual([
      { key: "eventType", ...NODE_STYLES.eventType },
      { key: "agentReadOnly", ...NODE_STYLES.agentReadOnly },
      { key: "agentMutating", ...NODE_STYLES.agentMutating },
      { key: "terminal", ...NODE_STYLES.terminal },
    ]);
    expect(legend.edges).toEqual([
      { kind: "routes", ...EDGE_STYLES.routes },
      { kind: "recommends", ...EDGE_STYLES.recommends },
    ]);
  });

  test("empty graph yields an empty legend", () => {
    expect(legendEntries({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });
});

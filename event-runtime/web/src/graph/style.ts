import type { CapabilityGraph, GraphEdge, GraphNode } from "./model";

// The single source of truth for what node/edge colors and dashes *mean*
// (WM-99). Node components, edge mapping, and the legend all read from here,
// so the legend can never drift from what the canvas actually draws.

export type NodeStyleKey = "eventType" | "agentReadOnly" | "agentMutating" | "terminal";

export const NODE_STYLES: Record<NodeStyleKey, { label: string; accent: string; dashed: boolean }> = {
  eventType: { label: "event type", accent: "var(--hue-info)", dashed: false },
  agentReadOnly: { label: "agent · read-only", accent: "var(--hue-ok)", dashed: false },
  agentMutating: { label: "agent · mutating", accent: "var(--hue-warn)", dashed: false },
  terminal: { label: "chain ends", accent: "var(--hue-idle)", dashed: true },
};

export const nodeStyleKey = (node: GraphNode): NodeStyleKey =>
  node.kind === "agent" ? (node.mutating ? "agentMutating" : "agentReadOnly") : node.kind;

export const EDGE_STYLES: Record<
  GraphEdge["kind"],
  { label: string; stroke: string; strokeDasharray?: string }
> = {
  routes: { label: "routes to agent", stroke: "var(--border-strong)" },
  recommends: { label: "recommendation", stroke: "var(--accent)", strokeDasharray: "4 3" },
};

export interface LegendEntries {
  nodes: Array<{ key: NodeStyleKey } & (typeof NODE_STYLES)[NodeStyleKey]>;
  edges: Array<{ kind: GraphEdge["kind"] } & (typeof EDGE_STYLES)[GraphEdge["kind"]]>;
}

/**
 * Legend entries for the styles this graph actually uses — a map with no
 * mutating agents does not advertise the mutating color.
 */
export function legendEntries(graph: CapabilityGraph): LegendEntries {
  const usedNodes = new Set(graph.nodes.map(nodeStyleKey));
  const usedEdges = new Set(graph.edges.map((e) => e.kind));
  return {
    nodes: (Object.keys(NODE_STYLES) as NodeStyleKey[])
      .filter((key) => usedNodes.has(key))
      .map((key) => ({ key, ...NODE_STYLES[key] })),
    edges: (Object.keys(EDGE_STYLES) as GraphEdge["kind"][])
      .filter((kind) => usedEdges.has(kind))
      .map((kind) => ({ kind, ...EDGE_STYLES[kind] })),
  };
}

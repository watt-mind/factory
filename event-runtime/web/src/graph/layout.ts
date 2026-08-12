import ELK from "elkjs/lib/elk.bundled.js";
import type { CapabilityGraph } from "./model";

// Layered left-to-right layout via elk. Hand-rolling DAG layout is where
// these views die; elk does it properly and runs in a worker-free bundle.

const elk = new ELK();

export const NODE_WIDTH = 236;
export const NODE_HEIGHT = 92;

const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "150",
  "elk.spacing.nodeNode": "44",
  "elk.spacing.edgeLabel": "8",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.edgeRouting": "SPLINES",
};

export async function layoutGraph(graph: CapabilityGraph): Promise<Map<string, { x: number; y: number }>> {
  const result = await elk.layout({
    id: "root",
    layoutOptions: OPTIONS,
    children: graph.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}

import ELK from "elkjs/lib/elk.bundled.js";
import type { CapabilityGraph } from "./model";

// Layered left-to-right layout via elk. Hand-rolling DAG layout is where
// these views die; elk does it properly and runs in a worker-free bundle.

const elk = new ELK();

export const NODE_WIDTH = 236;
export const NODE_HEIGHT = 92;
export const LAYOUT_TIMEOUT_MS = 3000;

const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "150",
  "elk.spacing.nodeNode": "44",
  "elk.spacing.edgeLabel": "8",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.edgeRouting": "SPLINES",
};

/**
 * Topology fingerprint: node ids and edge id/source/target. Overlay fields
 * (counts, badges, invocation labels) are ignored so live polls do not
 * re-run ELK.
 */
export function graphIdentity(graph: CapabilityGraph): string {
  const nodes = graph.nodes.map((n) => n.id).sort();
  const edges = graph.edges.map((e) => `${e.id}\t${e.source}\t${e.target}`).sort();
  return `${nodes.join("\n")}\n--\n${edges.join("\n")}`;
}

export type LayoutFn = (
  graph: CapabilityGraph,
  timeoutMs?: number,
) => Promise<Map<string, { x: number; y: number }>>;

/**
 * Run `layout` only when node/edge identity changed (or `prevIdentity` is
 * null). Overlay-only updates return `positions: null`.
 */
export async function layoutGraphIfIdentityChanged(
  graph: CapabilityGraph,
  prevIdentity: string | null,
  layout: LayoutFn = layoutGraph,
): Promise<{ identity: string; positions: Map<string, { x: number; y: number }> | null }> {
  const identity = graphIdentity(graph);
  if (prevIdentity !== null && identity === prevIdentity) {
    return { identity, positions: null };
  }
  return { identity, positions: await layout(graph) };
}

export async function layoutGraph(
  graph: CapabilityGraph,
  timeoutMs: number = LAYOUT_TIMEOUT_MS,
): Promise<Map<string, { x: number; y: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ELK layout calculation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const layoutPromise = elk.layout({
      id: "root",
      layoutOptions: OPTIONS,
      children: graph.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
      edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    });

    const result = await Promise.race([layoutPromise, timeoutPromise]);
    const positions = new Map<string, { x: number; y: number }>();
    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
    return positions;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

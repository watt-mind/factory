import ELK from "elkjs/lib/elk.bundled.js";

/** The topology ELK needs — the capability map and the chain trace both fit. */
export interface LayoutGraph {
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

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
export function graphIdentity<G extends LayoutGraph>(graph: G): string {
  const nodes = graph.nodes.map((n) => n.id).sort();
  const edges = graph.edges.map((e) => `${e.id}\t${e.source}\t${e.target}`).sort();
  return `${nodes.join("\n")}\n--\n${edges.join("\n")}`;
}

/** Chain traces are long and thin: tighter layers keep a 6-hop chain on one screen. */
export const CHAIN_LAYOUT_OPTIONS: Record<string, string> = {
  ...OPTIONS,
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "28",
};

export type LayoutFn = <G extends LayoutGraph>(
  graph: G,
  timeoutMs?: number,
) => Promise<Map<string, { x: number; y: number }>>;

/**
 * Run `layout` only when node/edge identity changed (or `prevIdentity` is
 * null). Overlay-only updates return `positions: null`.
 */
export async function layoutGraphIfIdentityChanged<G extends LayoutGraph>(
  graph: G,
  prevIdentity: string | null,
  layout: LayoutFn = layoutGraph,
): Promise<{ identity: string; positions: Map<string, { x: number; y: number }> | null }> {
  const identity = graphIdentity(graph);
  if (prevIdentity !== null && identity === prevIdentity) {
    return { identity, positions: null };
  }
  return { identity, positions: await layout(graph) };
}

export async function layoutGraph<G extends LayoutGraph>(
  graph: G,
  timeoutMs: number = LAYOUT_TIMEOUT_MS,
  layoutOptions: Record<string, string> = OPTIONS,
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
      layoutOptions,
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

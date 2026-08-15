import type { CapabilityGraph, GraphNode } from "./model";

// Pure view helpers for the Graph page (WM-99): node search and the
// initial-fit target. No React Flow types here so both stay unit-testable.

/**
 * Case-insensitive substring match on node label and id, in the order the
 * nodes appear in the graph. A blank query matches nothing — an empty search
 * box must not highlight the whole canvas.
 */
export function matchNodes(nodes: GraphNode[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return nodes
    .filter((n) => n.label.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle))
    .map((n) => n.id);
}

/**
 * Enter on a non-empty query selects the current match (match 1 of N first).
 * A second Enter while that match is already selected advances to the next.
 */
export function searchEnter(
  matches: string[],
  matchIdx: number,
  selectedId: string | null,
): { selectId: string; nextIdx: number } | null {
  if (matches.length === 0) return null;
  const idx = ((matchIdx % matches.length) + matches.length) % matches.length;
  const current = matches[idx]!;
  if (selectedId === current && matches.length > 1) {
    const nextIdx = (idx + 1) % matches.length;
    return { selectId: matches[nextIdx]!, nextIdx };
  }
  return { selectId: current, nextIdx: idx };
}

/**
 * Stale `#/graph/:nodeId`: the hash names a node that is not in the loaded
 * graph. While loading, this is false so the banner does not flash.
 */
export function missingFocusNode(
  nodes: Array<{ id: string }> | null | undefined,
  focusNodeId: string | null,
  loaded: boolean,
): boolean {
  if (!loaded || !focusNodeId || !nodes) return false;
  return !nodes.some((n) => n.id === focusNodeId);
}

/**
 * Node ids of the largest connected component (undirected), edges winning
 * ties — the initial view centers here instead of fitting every stray island
 * on screen at once.
 */
export function largestComponentIds(graph: CapabilityGraph): string[] {
  const adjacency = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }

  const seen = new Set<string>();
  let best: { ids: string[]; edges: number } = { ids: [], edges: 0 };
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const ids: string[] = [];
    let edgeEndpoints = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop() as string;
      ids.push(id);
      const neighbors = adjacency.get(id) ?? [];
      edgeEndpoints += neighbors.length;
      for (const next of neighbors) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    const edges = edgeEndpoints / 2;
    if (ids.length > best.ids.length || (ids.length === best.ids.length && edges > best.edges)) {
      best = { ids, edges };
    }
  }
  return best.ids;
}

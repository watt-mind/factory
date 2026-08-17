import type { ChainEvent, ChainRun, ChainView } from "../types";

/**
 * Chain trace graph (WM-527): one correlation id → the DAG of events and
 * runs that actually happened. Contrast with ./model (the capability map,
 * "what can happen"): here every node is an instance.
 *
 * Edges follow the runtime's own provenance:
 *   event ─produced→ run        (event.runId, via its proposal)
 *   run   ─emitted→  event      (event.causationId = run.runId)
 *
 * The root is whichever event has no causation parent — normally the origin
 * webhook/schedule tick. A run named only by a causationId (its own event
 * lives under a different correlation) is drawn as a root run so the trace
 * still starts somewhere.
 */

export type ChainNode =
  | { kind: "chainEvent"; id: string; event: ChainEvent; root: boolean; depth: number }
  | { kind: "chainRun"; id: string; run: ChainRun; root: boolean; depth: number };

export interface ChainEdge {
  id: string;
  source: string;
  target: string;
  kind: "produced" | "emitted";
}

export interface ChainGraph {
  nodes: ChainNode[];
  edges: ChainEdge[];
  /** Node ids with no incoming edge, in admission order. */
  rootIds: string[];
  /** Longest root→leaf path length in hops (0 for a single node). */
  maxDepth: number;
}

export const eventNodeId = (source: string, eventId: string) => `event:${source}:${eventId}`;
export const runNodeId = (runId: string) => `run:${runId}`;

export function buildChainGraph(view: Pick<ChainView, "events" | "runs">): ChainGraph {
  const nodes = new Map<string, ChainNode>();
  const edges: ChainEdge[] = [];
  const runsById = new Map(view.runs.map((r) => [r.runId, r]));

  for (const event of view.events) {
    const id = eventNodeId(event.source, event.eventId);
    nodes.set(id, { kind: "chainEvent", id, event, root: false, depth: 0 });
  }
  for (const run of view.runs) {
    const id = runNodeId(run.runId);
    nodes.set(id, { kind: "chainRun", id, run, root: false, depth: 0 });
  }

  const incoming = new Set<string>();
  const seenEdge = new Set<string>();
  const addEdge = (edge: ChainEdge) => {
    if (seenEdge.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target)) return;
    if (edge.source === edge.target) return;
    seenEdge.add(edge.id);
    edges.push(edge);
    incoming.add(edge.target);
  };

  for (const event of view.events) {
    const eid = eventNodeId(event.source, event.eventId);
    if (event.runId && runsById.has(event.runId)) {
      addEdge({ id: `produced:${eid}`, source: eid, target: runNodeId(event.runId), kind: "produced" });
    }
    if (event.causationId && runsById.has(event.causationId)) {
      addEdge({
        id: `emitted:${eid}`,
        source: runNodeId(event.causationId),
        target: eid,
        kind: "emitted",
      });
    }
  }
  // A run whose own origin event is in the set but whose proposal join was
  // missed (event.runId null) still hangs off that event.
  for (const run of view.runs) {
    if (!run.eventSource || !run.eventId) continue;
    const eid = eventNodeId(run.eventSource, run.eventId);
    if (nodes.has(eid)) {
      addEdge({ id: `produced:${eid}`, source: eid, target: runNodeId(run.runId), kind: "produced" });
    }
  }

  const rootIds = [...nodes.keys()].filter((id) => !incoming.has(id));
  for (const id of rootIds) nodes.get(id)!.root = true;

  // Depth = longest path from a root. Causation ids always point at strictly
  // earlier runs, so this is a DAG; the `visiting` set turns a malformed cycle
  // into a truncated depth instead of a hang.
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    const list = parents.get(e.target) ?? [];
    list.push(e.source);
    parents.set(e.target, list);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const parent of parents.get(id) ?? []) depth = Math.max(depth, depthOf(parent) + 1);
    visiting.delete(id);
    memo.set(id, depth);
    return depth;
  };
  let maxDepth = 0;
  for (const node of nodes.values()) {
    node.depth = depthOf(node.id);
    if (node.depth > maxDepth) maxDepth = node.depth;
  }

  return { nodes: [...nodes.values()], edges, rootIds, maxDepth };
}

/** The chain key an event belongs to — mirrors lib/api-chain.mjs `chainKeyOf`. */
export function chainKeyOfEvent(event: { correlationId?: string | null; eventId: string }): string {
  return event.correlationId ?? event.eventId;
}

/** Human summary of the origin, for headers: "clock.tick.merge-scan · schedule". */
export function chainOriginLabel(graph: ChainGraph): string | null {
  const root = graph.nodes.find((n) => n.root && n.kind === "chainEvent");
  if (root && root.kind === "chainEvent") return `${root.event.type} · ${root.event.source}`;
  const rootRun = graph.nodes.find((n) => n.root && n.kind === "chainRun");
  if (rootRun && rootRun.kind === "chainRun") return `${rootRun.run.agent ?? rootRun.run.runId} · run`;
  return null;
}

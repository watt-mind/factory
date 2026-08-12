import type { AgentsView } from "../types";

// The capability map: what this runtime can do, derived purely from the
// registry (OPS-224 phase 1). No runtime state here — phase 2 overlays that.
// Kept as plain data, separate from React Flow, so it stays testable and the
// rendering layer can be swapped without touching the topology rules.

export type GraphNode =
  | { id: string; kind: "eventType"; label: string; adapter: string; scope: string[]; ttl: number | null }
  | {
      id: string;
      kind: "agent";
      label: string;
      adapter: string;
      mutating: boolean;
      execution: "model" | "command" | "actions";
      contract: string;
      capabilities: string[];
      actions: string[];
      hosts: string[];
    }
  | { id: string; kind: "terminal"; label: string; reason: string };

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "routes" | "recommends";
  label?: string;
};

export interface CapabilityGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const eventNodeId = (type: string) => `event:${type}`;
export const agentNodeId = (ref: string) => `agent:${ref}`;

/** How an agent actually executes — the honest distinction for the map. */
function executionOf(def: AgentsView["agents"][number]): "model" | "command" | "actions" {
  if (def.actionRegistry) return "actions";
  if (def.command) return "command";
  return "model";
}

/**
 * Build the capability map. Nodes: registered event types, registered agents,
 * and one terminal per agent that produces recommendations but has values
 * leading nowhere — "the chain ends here" is topology worth drawing, not an
 * omission.
 */
export function buildCapabilityGraph(view: AgentsView): CapabilityGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const routes = view.eventTypes ?? [];
  const byRef = new Map(view.agents.map((a) => [a.ref, a]));

  for (const route of routes) {
    nodes.push({
      id: eventNodeId(route.type),
      kind: "eventType",
      label: route.type,
      adapter: route.adapter,
      scope: route.idempotencyScope ?? [],
      ttl: route.proposalTtlSeconds,
    });
  }

  for (const def of view.agents) {
    nodes.push({
      id: agentNodeId(def.ref),
      kind: "agent",
      label: def.ref,
      adapter: def.eventTypes[0]?.adapter ?? "—",
      mutating: def.mutating,
      execution: executionOf(def),
      contract: def.outputContract,
      capabilities: def.capabilities?.services ?? [],
      actions: def.actionRegistry ? Object.keys(def.actionRegistry) : [],
      hosts: def.hosts ?? [],
    });
  }

  // event type → agent (the planner's registered mapping)
  for (const route of routes) {
    if (!byRef.has(route.agent)) continue; // registry guarantees this, but never draw a dangling edge
    edges.push({
      id: `routes:${route.type}`,
      source: eventNodeId(route.type),
      target: agentNodeId(route.agent),
      kind: "routes",
    });
  }

  // agent --recommendation--> follow-up event type (the chain edges)
  for (const [agentRef, rule] of Object.entries(view.edges ?? {})) {
    const source = agentNodeId(agentRef);
    if (!byRef.has(agentRef)) continue;
    for (const [value, edge] of Object.entries(rule.edges ?? {})) {
      const target = eventNodeId(edge.eventType);
      if (!nodes.some((n) => n.id === target)) continue;
      edges.push({
        id: `rec:${agentRef}:${value}`,
        source,
        target,
        kind: "recommends",
        label: `${rule.recommendationField} = ${value}`,
      });
    }
  }

  // Terminals: an agent whose output enum has values with no edge ends there.
  for (const def of view.agents) {
    const rule = view.edges?.[def.ref];
    if (!rule) continue;
    const schema = def.outputSchema as
      | { properties?: Record<string, { enum?: string[] }> }
      | undefined;
    const declared = schema?.properties?.[rule.recommendationField]?.enum ?? [];
    const unmapped = declared.filter((value) => !(value in (rule.edges ?? {})));
    if (unmapped.length === 0) continue;
    const id = `terminal:${def.ref}`;
    nodes.push({
      id,
      kind: "terminal",
      label: "chain ends",
      reason: unmapped.join(", "),
    });
    edges.push({
      id: `rec:${def.ref}:terminal`,
      source: agentNodeId(def.ref),
      target: id,
      kind: "recommends",
      label: `${rule.recommendationField} = ${unmapped.join(" | ")}`,
    });
  }

  return { nodes, edges };
}

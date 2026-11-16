import type {
  AdmittedEvent,
  AgentsView,
  Proposal,
  RunListItem,
  StatusView,
} from "../types";
import type { GraphOverlay } from "../displayOptions";

// The capability map: what this runtime can do, derived from the registry,
// overlaid with live runtime state (OPS-227 phase 2): active run state badges,
// admitted/planned event counts, causation-correlated recommendation fire counts,
// and pending proposal ghost nodes.
// Kept as plain data, separate from React Flow, so it stays testable and the
// rendering layer can be swapped without touching the topology rules.

export interface HistoricalOverlayValue {
  mode: Exclude<GraphOverlay, "live">;
  /** Value displayed to the operator: count, rate, dollars, or milliseconds. */
  value: number;
  /** 0–1 position within this response's visible ramp. */
  intensity: number;
  formatted: string;
  label: string;
  /** Activity fades zero-use topology; every overlay fades a no-data node. */
  faint: boolean;
  /**
   * The window produced no measurement for this key (no runs at all, or — for
   * Health — a zero denominator). Distinct from a measured zero: `0%` at the
   * healthy end of the ramp and `0.00s` at the fastest end are both claims the
   * data does not support, so these render `—`, stay out of the legend ramp,
   * and never take a ramp colour.
   */
  noData: boolean;
}

export type GraphNode = (
  | {
      id: string;
      kind: "eventType";
      label: string;
      adapter: string;
      scope: string[];
      ttl: number | null;
      admittedCount?: number;
      plannedCount?: number;
    }
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
      pack?: string | null;
      activeRuns?: Array<{ state: string; count: number }>;
    }
  | { id: string; kind: "terminal"; label: string; reason: string }
  | {
      id: string;
      kind: "proposal";
      label: string;
      proposalId: string;
      decision: string;
      agentRef: string | null;
      eventType: string | null;
      proposal: Proposal;
    }
) & { historical?: HistoricalOverlayValue };

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "routes" | "recommends" | "proposal";
  label?: string;
  invocations?: number;
  historical?: HistoricalOverlayValue;
};

export interface CapabilityGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LiveGraphState {
  runs?: RunListItem[];
  events?: AdmittedEvent[];
  proposals?: Proposal[];
  status?: StatusView;
}

export interface BreakdownRows {
  rows: Array<{ key: string; value: number }>;
}

/** All server-side aggregates needed for one historical overlay refresh. */
export interface HistoricalBreakdowns {
  agents?: BreakdownRows;
  eventTypes?: BreakdownRows;
  edges?: BreakdownRows;
  agentRuns?: BreakdownRows;
  eventTypeRuns?: BreakdownRows;
  edgeRuns?: BreakdownRows;
}

export const eventNodeId = (type: string) => `event:${type}`;
export const agentNodeId = (ref: string) => `agent:${ref}`;
export const proposalNodeId = (id: string) => `proposal:${id}`;

const rowsMap = (data?: BreakdownRows) =>
  new Map((data?.rows ?? []).map((row) => [row.key, Number(row.value) || 0]));

function overlayFormat(
  mode: Exclude<GraphOverlay, "live">,
  value: number,
): string {
  if (mode === "health") return `${Math.round(value * 100)}%`;
  if (mode === "cost")
    return `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`;
  if (mode === "latency")
    return `${value < 1000 ? (value / 1000).toFixed(2) : (value / 1000).toFixed(1)}s`;
  return String(Math.round(value));
}

const overlayLabel = (mode: Exclude<GraphOverlay, "live">) =>
  mode === "activity"
    ? "runs"
    : mode === "health"
      ? "failure rate"
      : mode === "cost"
        ? "spend"
        : "p95 execution";

/**
 * The measured value for one key, or `null` when the window measured nothing.
 *
 * Activity is the one overlay where an absent row is a real answer — the
 * breakdown endpoint omits empty groups, and "0 runs" is exactly what makes a
 * dead route visible. Every other overlay has no honest reading without a
 * denominator: a missing Health row is not a 0% failure rate, and a missing
 * Latency row is not a 0.00s p95.
 */
function valueFor(
  mode: Exclude<GraphOverlay, "live">,
  values: Map<string, number>,
  totals: Map<string, number>,
  key: string,
): number | null {
  if (mode === "activity") return values.get(key) ?? 0;
  if (mode === "health") {
    const runs = totals.get(key) ?? 0;
    if (runs <= 0) return null;
    // The server counts failures by `updated_at` and runs by `created_at`
    // (lib/metrics.mjs), so the ratio can exceed 1.0 across a window boundary.
    // Clamp rather than render "140%" — the server-side fix is separate.
    return Math.min(1, Math.max(0, (values.get(key) ?? 0) / runs));
  }
  return values.has(key) ? values.get(key)! : null;
}

function overlayValues(
  mode: Exclude<GraphOverlay, "live">,
  keyed: Array<{ key: string; value: number | null }>,
): Map<string, HistoricalOverlayValue> {
  const measured = keyed.flatMap((entry) =>
    entry.value == null ? [] : [entry.value],
  );
  const max = Math.max(0, ...measured);
  const min = Math.min(...measured, 0);
  const span = max - min;
  return new Map(
    keyed.map(({ key, value }) => [
      key,
      {
        mode,
        value: value ?? 0,
        intensity: value == null || span <= 0 ? 0 : (value - min) / span,
        formatted: value == null ? "—" : overlayFormat(mode, value),
        label: overlayLabel(mode),
        faint: value == null || (mode === "activity" && value === 0),
        noData: value == null,
      },
    ]),
  );
}

/**
 * Add a historical overlay without changing topology. Under Activity a missing
 * row is a real zero (the breakdown endpoint omits empty groups), which is what
 * makes dead routes visible instead of silently leaving them uncoloured; under
 * every other overlay it is no data, and says so rather than inventing a
 * best-in-class reading (see `valueFor`).
 */
export function applyHistoricalOverlay(
  graph: CapabilityGraph,
  mode: Exclude<GraphOverlay, "live">,
  breakdowns: HistoricalBreakdowns,
): CapabilityGraph {
  const agents = rowsMap(breakdowns.agents);
  const eventTypes = rowsMap(breakdowns.eventTypes);
  const edgeValues = rowsMap(breakdowns.edges);
  const agentRuns = rowsMap(breakdowns.agentRuns);
  const eventTypeRuns = rowsMap(breakdowns.eventTypeRuns);
  const edgeRuns = rowsMap(breakdowns.edgeRuns);

  const rawNodes = graph.nodes.map((node) => {
    const eligible = node.kind === "agent" || node.kind === "eventType";
    const key = node.label;
    const value =
      node.kind === "agent"
        ? valueFor(mode, agents, agentRuns, key)
        : node.kind === "eventType"
          ? valueFor(mode, eventTypes, eventTypeRuns, key)
          : null;
    return { node, key: node.id, value, eligible };
  });
  const nodeOverlay = overlayValues(
    mode,
    rawNodes
      .filter(({ eligible }) => eligible)
      .map(({ key, value }) => ({ key, value })),
  );

  // Only routing and recommendation edges carry a server-side metric. A ghost
  // proposal edge has no key in any breakdown, so it has no reading — mirroring
  // the node guard above. Left unmeasured it kept its `var(--hue-info)` stroke;
  // colouring it would paint "pending" as the healthy end of the Health ramp.
  const rawEdges = graph.edges.map((edge) => {
    const eligible = edge.kind === "recommends" || edge.kind === "routes";
    let metricKey = "";
    if (edge.kind === "recommends") {
      const source = edge.source.replace(/^agent:/, "");
      const target = edge.target.replace(/^event:/, "");
      metricKey = `${source}→${target}`;
    } else if (edge.kind === "routes") {
      metricKey = edge.source.replace(/^event:/, "");
    }
    const values = edge.kind === "routes" ? eventTypes : edgeValues;
    const totals = edge.kind === "routes" ? eventTypeRuns : edgeRuns;
    return {
      edge,
      key: edge.id,
      value: eligible ? valueFor(mode, values, totals, metricKey) : null,
      eligible,
    };
  });
  const edgeOverlay = overlayValues(
    mode,
    rawEdges
      .filter(({ eligible }) => eligible)
      .map(({ key, value }) => ({ key, value })),
  );

  return {
    nodes: rawNodes.map(({ node, eligible }) =>
      eligible ? { ...node, historical: nodeOverlay.get(node.id) } : node,
    ),
    edges: rawEdges.map(({ edge, eligible }) =>
      eligible ? { ...edge, historical: edgeOverlay.get(edge.id) } : edge,
    ),
  };
}

/** How an agent actually executes — the honest distinction for the map. */
function executionOf(
  def: AgentsView["agents"][number],
): "model" | "command" | "actions" {
  if (def.actionRegistry) return "actions";
  if (def.command) return "command";
  return "model";
}

/** Active run states to highlight on agent nodes in priority order */
const ACTIVE_RUN_STATES = [
  "RUNNING",
  "QUEUED",
  "LEASED",
  "VERIFYING",
  "APPROVED",
  "PROPOSED",
];

/**
 * Build the capability map overlaid with optional live state.
 * Nodes: registered event types (with admitted/planned counts), registered agents
 * (with active run badges), terminals for unmapped recommendations, and open
 * proposal ghost nodes.
 * Edges: routing, recommendations (with causation invocation counts), and ghost proposal edges.
 */
export function buildCapabilityGraph(
  view: AgentsView,
  live?: LiveGraphState,
): CapabilityGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const routes = view.eventTypes ?? [];
  const byRef = new Map(view.agents.map((a) => [a.ref, a]));
  const runsByRunId = new Map(live?.runs?.map((r) => [r.runId, r]) ?? []);

  // 1. Registered event types
  for (const route of routes) {
    const admittedCount = live?.events
      ? live.events.filter(
          (e) => e.type === route.type && e.status === "admitted",
        ).length
      : undefined;
    const plannedCount = live?.events
      ? live.events.filter(
          (e) => e.type === route.type && e.status === "planned",
        ).length
      : undefined;

    nodes.push({
      id: eventNodeId(route.type),
      kind: "eventType",
      label: route.type,
      adapter: route.adapter ?? "—",
      scope: route.idempotencyScope ?? [],
      ttl: route.proposalTtlSeconds ?? null,
      admittedCount,
      plannedCount,
    });
  }

  // 2. Registered agents with active run counts
  for (const def of view.agents) {
    let activeRuns: Array<{ state: string; count: number }> | undefined;
    if (live?.runs) {
      const stateCounts = new Map<string, number>();
      for (const r of live.runs) {
        if (r.agent === def.ref && ACTIVE_RUN_STATES.includes(r.state)) {
          stateCounts.set(r.state, (stateCounts.get(r.state) ?? 0) + 1);
        }
      }
      if (stateCounts.size > 0) {
        activeRuns = [];
        for (const s of ACTIVE_RUN_STATES) {
          const count = stateCounts.get(s);
          if (count) activeRuns.push({ state: s, count });
        }
      }
    }

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
      pack: def.pack ?? null,
      activeRuns,
    });
  }

  // 3. event type → agent (the planner's registered mapping)
  for (const route of routes) {
    if (!route.agent || !byRef.has(route.agent)) continue; // registry guarantees this, but never draw a dangling edge
    edges.push({
      id: `routes:${route.type}`,
      source: eventNodeId(route.type),
      target: agentNodeId(route.agent),
      kind: "routes",
    });
  }

  // 4. agent --recommendation--> follow-up event type (the chain edges with causation counts)
  for (const [agentRef, rule] of Object.entries(view.edges ?? {})) {
    const source = agentNodeId(agentRef);
    if (!byRef.has(agentRef)) continue;
    for (const [value, edge] of Object.entries(rule.edges ?? {})) {
      const target = eventNodeId(edge.eventType);
      if (!nodes.some((n) => n.id === target)) continue;

      let invocations = 0;
      if (live?.events) {
        for (const ev of live.events) {
          if (ev.type === edge.eventType) {
            const causation =
              (ev as { causationId?: string | null }).causationId ??
              (ev.envelope as { causationId?: string | null } | undefined)
                ?.causationId;
            if (causation) {
              const run = runsByRunId.get(causation);
              if (run ? run.agent === agentRef : ev.subject === agentRef) {
                invocations++;
              }
            }
          }
        }
      }

      const baseLabel = `${rule.recommendationField} = ${value}`;
      const label =
        invocations > 0 ? `${baseLabel} (${invocations})` : baseLabel;

      edges.push({
        id: `rec:${agentRef}:${value}`,
        source,
        target,
        kind: "recommends",
        label,
        invocations: invocations > 0 ? invocations : undefined,
      });
    }
  }

  // 5. Terminals: an agent whose output enum has values with no edge ends there.
  for (const def of view.agents) {
    const rule = view.edges?.[def.ref];
    if (!rule) continue;
    const schema = def.outputSchema as
      { properties?: Record<string, { enum?: string[] }> } | undefined;
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

  // 6. Open proposals: render as ghost nodes and dashed edges representing pending execution
  if (live?.proposals) {
    const openProposals = live.proposals.filter((p) => p.status === "open");
    for (const p of openProposals) {
      const pNodeId = proposalNodeId(p.id);
      const agentRef = p.agent ?? p.spec?.agent ?? null;

      let eventType: string | null = null;
      if (p.eventId && live.events) {
        const ev = live.events.find(
          (e) =>
            (p.eventSource ? e.source === p.eventSource : true) &&
            e.eventId === p.eventId,
        );
        if (ev) eventType = ev.type;
      }

      nodes.push({
        id: pNodeId,
        kind: "proposal",
        label: agentRef ? `pending: ${agentRef}` : `proposal · ${p.decision}`,
        proposalId: p.id,
        decision: p.decision,
        agentRef,
        eventType,
        proposal: p,
      });

      // Ghost edges
      if (eventType && nodes.some((n) => n.id === eventNodeId(eventType))) {
        edges.push({
          id: `proposal:event:${p.id}`,
          source: eventNodeId(eventType),
          target: pNodeId,
          kind: "proposal",
          label: `pending · ${p.decision}`,
        });
      }

      if (agentRef && nodes.some((n) => n.id === agentNodeId(agentRef))) {
        edges.push({
          id: `proposal:agent:${p.id}`,
          source: pNodeId,
          target: agentNodeId(agentRef),
          kind: "proposal",
          label: "pending execution",
        });
      }
    }
  }

  return { nodes, edges };
}

import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  GRAPH_OVERLAYS,
  GRAPH_WINDOWS,
  isGraphOverlay,
  isGraphWindow,
  loadGraphDisplayOptions,
  saveGraphDisplayOptions,
  type GraphDisplayOptions,
  type GraphOverlay,
  type GraphWindow,
} from "../displayOptions";
import { keyGuard, refetchIntervals, useNow } from "../hooks";
import {
  applyHistoricalOverlay,
  buildCapabilityGraph,
  type BreakdownRows,
  type GraphEdge,
  type GraphNode,
  type HistoricalBreakdowns,
} from "../graph/model";
import { nodeTypes } from "../graph/nodes";
import { matchNodes, missingFocusNode, searchEnter } from "../graph/search";
import {
  EDGE_STYLES,
  historicalColor,
  historicalRamp,
  historicalStroke,
  legendEntries,
} from "../graph/style";
import { createHashWriter, hashSearch, type HashWriter } from "../hash";
import type { EventFocus } from "../types";
import type { OperatorContext } from "../context";
import {
  Ago,
  Button,
  CopyActions,
  DECISION_HUES,
  DetailPane,
  JsonBlock,
  JumpLink,
  KV,
  Section,
  STATE_HUES,
  StateBadge,
  copyText,
  copyLink,
} from "../components/ui";
import { ScopeCaption } from "../components/ContextTabs";

const GRAPH_FIT_PADDING = "24px";
const FOCUSED_NODE_MIN_ZOOM = 0.65;

/** Poll cadence per window: a 7-day or 30-day rollup barely moves, so it is
 * refreshed half as often as an hour's worth. Live state keeps its own 5s. */
const HISTORICAL_REFETCH_MS: Record<GraphWindow, number> = {
  "1h": 30_000,
  "24h": 30_000,
  "7d": 60_000,
  "30d": 60_000,
};

const OVERLAY_LABELS: Record<GraphOverlay, string> = {
  live: "Live",
  activity: "Activity",
  health: "Health",
  cost: "Cost",
  latency: "Latency",
};

export function graphDisplayFromHash(
  hash: string,
  saved: GraphDisplayOptions = loadGraphDisplayOptions(),
): GraphDisplayOptions {
  const query = hashSearch(hash);
  const overlay = query.get("overlay");
  const windowValue = query.get("window");
  return {
    overlay: isGraphOverlay(overlay) ? overlay : saved.overlay,
    window: isGraphWindow(windowValue) ? windowValue : saved.window,
  };
}

export function graphHashWithDisplay(
  hash: string,
  options: GraphDisplayOptions,
): string {
  const raw = hash.replace(/^#\/?/, "") || "graph";
  const i = raw.indexOf("?");
  const path = i >= 0 ? raw.slice(0, i) : raw;
  const query = new URLSearchParams(i >= 0 ? raw.slice(i + 1) : "");
  if (options.overlay === "live") {
    // Live is the prior behaviour byte for byte: no query of its own, so an
    // operator who never opens the overlay picker still gets a bare `#/graph`
    // to copy. `?project=` and anything else on the hash survive.
    query.delete("overlay");
    query.delete("window");
  } else {
    query.set("overlay", options.overlay);
    query.set("window", options.window);
  }
  const qs = query.toString();
  return qs ? `#/${path}?${qs}` : `#/${path}`;
}

/**
 * The display query rides the same coalescing seam as the router (hash.ts):
 * Safari throws `SecurityError` past ~100 history writes per 30s, and the
 * re-attach effect below re-runs on every selection change — a held `j` fires
 * ~30 a second. Writes preserve `history.state` exactly as `useHashRoute`
 * does; a `null` there wipes state the rest of the app may be carrying.
 */
function createDisplayHashWriter(): HashWriter {
  return createHashWriter((hash, replace) => {
    if (!replace) {
      window.location.hash = hash;
      return;
    }
    // A bare `#…` resolves against the current URL, so path and search survive
    // untouched. `history.state` is passed through, never nulled.
    window.history.replaceState(window.history.state, "", hash);
  });
}

async function breakdown(
  windowValue: GraphWindow,
  by: "agent" | "event_type" | "edge",
  metric: "runs" | "failures" | "cost" | "p95_execution",
): Promise<BreakdownRows> {
  const query = new URLSearchParams({ window: windowValue, by, metric });
  // Agent breakdowns default to top ten; a topology overlay must account for
  // every registered node. Event type/edge are unlimited server-side.
  if (by === "agent") query.set("limit", "500");
  const response = await fetch(`/api/metrics/breakdown?${query.toString()}`);
  if (!response.ok)
    throw new Error(`/metrics/breakdown returned HTTP ${response.status}`);
  return response.json() as Promise<BreakdownRows>;
}

/** One React Query refresh per overlay. The server aggregates each dimension
 * once per refresh; requests are never multiplied by topology size. */
export async function fetchHistoricalOverlay(
  overlay: Exclude<GraphOverlay, "live">,
  windowValue: GraphWindow,
): Promise<HistoricalBreakdowns> {
  const metric =
    overlay === "activity"
      ? "runs"
      : overlay === "health"
        ? "failures"
        : overlay === "cost"
          ? "cost"
          : "p95_execution";
  const [agents, eventTypes, edges] = await Promise.all([
    breakdown(windowValue, "agent", metric),
    breakdown(windowValue, "event_type", metric),
    breakdown(windowValue, "edge", metric),
  ]);
  if (overlay !== "health") return { agents, eventTypes, edges };
  const [agentRuns, eventTypeRuns, edgeRuns] = await Promise.all([
    breakdown(windowValue, "agent", "runs"),
    breakdown(windowValue, "event_type", "runs"),
    breakdown(windowValue, "edge", "runs"),
  ]);
  return { agents, eventTypes, edges, agentRuns, eventTypeRuns, edgeRuns };
}

type GraphFitViewOptions = {
  nodes?: Array<{ id: string }>;
  padding?: number | `${number}px` | `${number}%`;
  duration?: number;
  minZoom?: number;
  maxZoom?: number;
};

export function focusedNodeFit(id: string, zoom: number): GraphFitViewOptions {
  return {
    nodes: [{ id }],
    padding: 0.45,
    duration: 180,
    minZoom: zoom,
    maxZoom: zoom,
  };
}

type FlowViewport = {
  getZoom: () => number;
  fitView: (opts: GraphFitViewOptions) => void;
};

// Reveal the selected node without fighting the operator's viewport: the effect
// depends only on `revealSelected` (which changes with `focusNodeId`) and
// `flowReady`, so the 5s background poll — which rebuilds `positioned` on every
// refetch — cannot re-center or interrupt a drag.
export function useSelectedNodeReveal(
  focusNodeId: string | null,
  flowReady: number,
  flowRef: { current: FlowViewport | null },
) {
  const revealSelected = useCallback(() => {
    if (!focusNodeId || !flowRef.current) return;
    const zoom = flowRef.current.getZoom();
    flowRef.current.fitView(focusedNodeFit(focusNodeId, zoom));
  }, [focusNodeId, flowRef]);

  // `flowReady` makes an initial deep link wait for React Flow's onInit.
  // Deliberately exclude `positioned`: Reset layout should fit the whole
  // graph instead of immediately snapping back to the selected node.
  useEffect(() => {
    revealSelected();
  }, [revealSelected, flowReady]);

  return revealSelected;
}

function flowEdges(graph: { edges: GraphEdge[] }): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: false,
    style: {
      // A no-data edge keeps its topology stroke: intensity 0 on the Health
      // ramp is pure `--hue-ok`, and "unmeasured" must not read as "healthy".
      stroke:
        edge.historical && !edge.historical.noData
          ? historicalStroke(edge.historical)
          : EDGE_STYLES[edge.kind].stroke,
      strokeWidth:
        edge.historical?.mode === "activity"
          ? 1.5 + 5 * edge.historical.intensity
          : 1.5,
      strokeDasharray: EDGE_STYLES[edge.kind].strokeDasharray,
    },
    labelStyle: { fill: "var(--text-faint)", fontSize: "var(--text-xs)" },
    labelBgStyle: { fill: "var(--surface-0)" },
  }));
}

function applyGraphOverlay(
  prev: { nodes: Node[]; edges: Edge[] } | null,
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
): { nodes: Node[]; edges: Edge[] } | null {
  if (!prev) return prev;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (
    prev.nodes.length !== graph.nodes.length ||
    prev.nodes.some((n) => !byId.has(n.id))
  ) {
    return prev;
  }
  return {
    nodes: prev.nodes.map((n) => ({
      ...n,
      data: { ...(n.data as object), node: byId.get(n.id) },
    })),
    edges: flowEdges(graph),
  };
}

/**
 * Graph (webui roadmap / OPS-224 phase 1, chrome OPS-230, phase 2 overlays OPS-227):
 * the capability map overlaid with live run states, admitted/planned event counts,
 * causation invocation counts on recommendation edges, and open proposal ghost nodes.
 */
/**
 * Loader for the async layout chunk. Kept as a mutable seam so tests can make
 * the dynamic import itself reject (a stale chunk after a deploy) without
 * poisoning bun's process-wide module registry via `mock.module`.
 */
export const graphLayoutChunk = {
  load: () => import("../graph/layout"),
};

export function Graph({
  context,
  focusNodeId,
  onSelectNode,
  onJumpAgent,
  onJumpEvents,
  onJumpProposal,
}: {
  context: OperatorContext;
  focusNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvents: (focus: EventFocus) => void;
  onJumpProposal: (id: string) => void;
}) {
  const [display, setDisplay] = useState<GraphDisplayOptions>(() =>
    graphDisplayFromHash(window.location.hash),
  );
  const [metricsFallback, setMetricsFallback] = useState<string | null>(null);
  const hashWriter = useMemo(() => createDisplayHashWriter(), []);

  // `immediate` is the operator changing a picker — a reader must see that at
  // once, the way `useHashRoute` flushes a query change. The re-attach below
  // rides the interval instead, because selection changes arrive in bursts.
  const writeDisplayHash = useCallback(
    (options: GraphDisplayOptions, immediate: boolean) => {
      const next = graphHashWithDisplay(window.location.hash, options);
      if (next === window.location.hash) return;
      hashWriter.replace(next);
      if (immediate) hashWriter.flush();
    },
    [hashWriter],
  );

  const commitDisplay = useCallback(
    (next: GraphDisplayOptions) => {
      setDisplay(next);
      saveGraphDisplayOptions(next);
      writeDisplayHash(next, true);
    },
    [writeDisplayHash],
  );

  // App owns node-selection navigation and rewrites the graph path. Re-attach
  // Graph's display query after those writes, and honor Back/pasted hashes
  // without losing the independently persisted value when a key is omitted.
  useEffect(() => {
    saveGraphDisplayOptions(display);
    writeDisplayHash(display, false);
  }, [display, focusNodeId, writeDisplayHash]);
  useEffect(() => {
    const onHashChange = () => {
      // The URL moved under us (Back, or App's own writer landing): a buffered
      // display write would clobber it.
      hashWriter.cancel();
      const next = graphDisplayFromHash(window.location.hash);
      setDisplay(next);
      saveGraphDisplayOptions(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [hashWriter]);
  // Never flush on unmount: the operator has left the graph and the buffered
  // hash would overwrite the view they went to.
  useEffect(() => () => hashWriter.cancel(), [hashWriter]);

  const registry = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    ...refetchIntervals.secondary,
  });
  const runsQ = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.runs(),
    ...refetchIntervals.fast,
  });
  const eventsQ = useQuery({
    queryKey: ["events"],
    queryFn: () => api.events(),
    ...refetchIntervals.fast,
  });
  const proposalsQ = useQuery({
    queryKey: ["proposals"],
    queryFn: api.proposals,
    ...refetchIntervals.fast,
  });
  const statusQ = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    ...refetchIntervals.secondary,
  });
  const historicalQ = useQuery({
    queryKey: ["graph-historical", display.overlay, display.window],
    queryFn: () =>
      fetchHistoricalOverlay(
        display.overlay as Exclude<GraphOverlay, "live">,
        display.window,
      ),
    enabled: display.overlay !== "live",
    // These are server-side aggregates over the whole window (six
    // /metrics/breakdown calls for Health), not the live feed — a 30-day
    // rollup does not move meaningfully inside five seconds, and polling it at
    // the live cadence is pure load. Short windows still refresh briskly.
    refetchInterval: HISTORICAL_REFETCH_MS[display.window],
    retry: false,
  });
  const now = useNow();

  useEffect(() => {
    if (display.overlay === "live" || !historicalQ.isError) return;
    const reason =
      historicalQ.error instanceof Error
        ? historicalQ.error.message
        : "metrics unavailable";
    setMetricsFallback(
      `Historical metrics unavailable (${reason}); showing Live instead.`,
    );
    commitDisplay({ ...display, overlay: "live" });
  }, [commitDisplay, display, historicalQ.error, historicalQ.isError]);

  const [positioned, setPositioned] = useState<{
    nodes: Node[];
    edges: Edge[];
  } | null>(null);
  const [layoutError, setLayoutError] = useState<
    "chunk" | "layout" | "mapping" | null
  >(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const lastIdentityRef = useRef<string | null>(null);
  const epochLaidOutRef = useRef(0);
  const [completedLayoutEpoch, setCompletedLayoutEpoch] = useState(-1);
  const flowRef = useRef<FlowViewport | null>(null);
  const [flowReady, setFlowReady] = useState(0);

  const { graph: liveGraph, mappingError } = useMemo(() => {
    if (!registry.data) return { graph: null, mappingError: false };
    try {
      return {
        graph: buildCapabilityGraph(registry.data, {
          runs: runsQ.data?.runs,
          events: eventsQ.data?.events,
          proposals: proposalsQ.data?.proposals,
          status: statusQ.data,
        }),
        mappingError: false,
      };
    } catch (err) {
      console.error("graph mapping failed", err);
      return { graph: null, mappingError: true };
    }
  }, [registry.data, runsQ.data, eventsQ.data, proposalsQ.data, statusQ.data]);

  const graph = useMemo(() => {
    if (!liveGraph || display.overlay === "live" || !historicalQ.data)
      return liveGraph;
    return applyHistoricalOverlay(liveGraph, display.overlay, historicalQ.data);
  }, [display.overlay, historicalQ.data, liveGraph]);

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    setLayoutError(null);
    // elkjs is ~1.4 MB of pre-minified layout engine, so it rides in its own
    // async chunk (OPS-255) — fetched the first time there is a graph to lay
    // out, never by the list views. Overlay polls reuse positions when
    // node/edge identity is unchanged (WM-154).
    graphLayoutChunk.load().then(
      ({ layoutGraphIfIdentityChanged, NODE_HEIGHT, NODE_WIDTH }) => {
        const prevIdentity =
          layoutEpoch !== epochLaidOutRef.current
            ? null
            : lastIdentityRef.current;
        return layoutGraphIfIdentityChanged(graph, prevIdentity)
          .then((result) => {
            if (cancelled) return;
            lastIdentityRef.current = result.identity;
            epochLaidOutRef.current = layoutEpoch;
            if (!result.positions) {
              setPositioned((prev) => applyGraphOverlay(prev, graph));
              return;
            }
            const positions = result.positions;
            try {
              setPositioned({
                nodes: graph.nodes.map((node) => ({
                  id: node.id,
                  type: node.kind,
                  position: positions.get(node.id) ?? { x: 0, y: 0 },
                  data: { node },
                  draggable: true,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                })),
                edges: flowEdges(graph),
              });
              setCompletedLayoutEpoch(layoutEpoch);
            } catch (err) {
              if (cancelled) return;
              console.error("graph node/edge positioning failed", err);
              setLayoutError("mapping");
            }
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            console.error("graph layout calculation failed", err);
            setLayoutError("layout");
          });
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error("graph layout chunk import failed", err);
        setLayoutError("chunk");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [graph, layoutEpoch]);

  // Node search (WM-99): case-insensitive substring on label/id, matches
  // highlighted on canvas, Enter cycles through them.
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const matches = useMemo(
    () => (graph ? matchNodes(graph.nodes, query) : []),
    [graph, query],
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const safeMatchIdx = matches.length ? matchIdx % matches.length : 0;
  const currentMatch = matches[safeMatchIdx] ?? null;
  const legend = useMemo(() => (graph ? legendEntries(graph) : null), [graph]);
  const ramp = useMemo(
    () => (graph && display.overlay !== "live" ? historicalRamp(graph) : null),
    [display.overlay, graph],
  );

  const nodes = useMemo(
    () =>
      positioned
        ? positioned.nodes.map((n) => ({
            ...n,
            selected: n.id === focusNodeId,
            data: {
              ...n.data,
              searchHit: matchSet.has(n.id),
              searchCurrent: n.id === currentMatch,
            },
          }))
        : [],
    [positioned, focusNodeId, matchSet, currentMatch],
  );

  const selected: GraphNode | undefined = graph?.nodes.find(
    (n) => n.id === focusNodeId,
  );
  const graphLoaded =
    Boolean(graph) && !registry.isPending && !proposalsQ.isPending;
  const staleFocus = missingFocusNode(graph?.nodes, focusNodeId, graphLoaded);
  const agentDef =
    selected?.kind === "agent"
      ? registry.data?.agents?.find((a) => a.ref === selected.label)
      : undefined;

  const pendingC = useRef<number>(0);

  const revealSelected = useSelectedNodeReveal(focusNodeId, flowReady, flowRef);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onSelectNode(null);
        return;
      }
      const target = e.target as HTMLElement | null;
      const enterActivatesControl =
        e.key === "Enter" &&
        Boolean(target?.closest("button, a, [role=button], [role=link]")) &&
        !target?.closest(".react-flow__node");
      if (
        (e.key === "z" || (e.key === "Enter" && !enterActivatesControl)) &&
        focusNodeId
      ) {
        e.preventDefault();
        revealSelected();
        return;
      }
      if (e.key === "c" && focusNodeId) {
        e.preventDefault();
        const node = graph?.nodes.find((n) => n.id === focusNodeId);
        if (node) {
          copyText(node.label, node.kind === "agent" ? "agent ref" : "id");
          pendingC.current = Date.now();
        }
        return;
      }
      if (e.key === "l" && focusNodeId) {
        if (pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          e.preventDefault();
          copyLink();
          pendingC.current = 0;
          return;
        }
      }
      const order = positioned
        ? [...positioned.nodes]
            .sort(
              (a, b) =>
                a.position.y - b.position.y || a.position.x - b.position.x,
            )
            .map((n) => n.id)
        : (graph?.nodes.map((n) => n.id) ?? []);
      if (!order.length) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : -1;
        onSelectNode(order[Math.min(idx + 1, order.length - 1)]);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : order.length;
        onSelectNode(order[Math.max(idx - 1, 0)]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelectNode, focusNodeId, graph, positioned, revealSelected]);

  // Fit every component after the initial layout and each explicit reset. The
  // completed epoch prevents Reset layout from fitting the stale positions
  // while ELK is still calculating the replacement layout.
  const lastFittedLayoutEpoch = useRef(-1);
  useEffect(() => {
    if (
      lastFittedLayoutEpoch.current === layoutEpoch ||
      completedLayoutEpoch !== layoutEpoch ||
      !flowRef.current ||
      !positioned ||
      !graph ||
      graph.nodes.length === 0
    )
      return;
    lastFittedLayoutEpoch.current = layoutEpoch;
    flowRef.current.fitView({ padding: GRAPH_FIT_PADDING, maxZoom: 1 });
  }, [completedLayoutEpoch, flowReady, graph, layoutEpoch, positioned]);

  // Center the current search match at the operator's zoom; `currentMatch` is
  // a stable string, so background refetches do not re-center the viewport.
  useEffect(() => {
    setMatchIdx(0);
  }, [query]);
  useEffect(() => {
    if (!currentMatch || !flowRef.current) return;
    const zoom = Math.max(flowRef.current.getZoom(), FOCUSED_NODE_MIN_ZOOM);
    flowRef.current.fitView({
      nodes: [{ id: currentMatch }],
      padding: 0.45,
      duration: 180,
      minZoom: zoom,
      maxZoom: zoom,
    });
  }, [currentMatch, flowReady]);

  const emptyCopy = registry.isPending
    ? "Loading the capability map…"
    : registry.isError
      ? "Cannot reach the control API — the graph will appear when /agents is up."
      : mappingError || layoutError === "mapping"
        ? "Could not map the capability graph from registry data."
        : layoutError === "chunk"
          ? "Could not load the graph layout engine — reload the page; if it persists the deployed build is incomplete."
          : layoutError === "layout"
            ? "Could not calculate the graph layout — the layout engine failed or timed out."
            : graph && graph.nodes.length === 0
              ? "No registered event types or agents."
              : "Laying out the capability map…";

  return (
    <div className="flex h-full min-w-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute top-4 left-5 z-10 rounded-md bg-(--surface-0)/85 px-2.5 py-2 backdrop-blur-sm">
          <h1 className="display text-h1 font-semibold">Graph</h1>
          <div className="text-[11px] text-(--text-faint)">
            what this runtime can do — registered routes and recommendation
            edges
          </div>
          <ScopeCaption context={context} surface="graph" />
          {staleFocus && (
            <div
              className="mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px]"
              role="status"
              style={{
                color: "var(--hue-warn)",
                background:
                  "color-mix(in oklch, var(--hue-warn) 10%, transparent)",
              }}
            >
              <span>Node not found</span>
              <Button onClick={() => onSelectNode(null)}>Show graph</Button>
            </div>
          )}
        </div>
        <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-(--text-faint)">
              Overlay
              <select
                aria-label="Graph overlay"
                value={display.overlay}
                onChange={(event) => {
                  setMetricsFallback(null);
                  commitDisplay({
                    ...display,
                    overlay: event.target.value as GraphOverlay,
                  });
                }}
                className="rounded-md border border-(--border) bg-(--surface-1) px-2 py-1 text-[12px] text-(--text) outline-none focus:border-(--accent)"
              >
                {GRAPH_OVERLAYS.map((overlay) => (
                  <option key={overlay} value={overlay}>
                    {OVERLAY_LABELS[overlay]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[11px] text-(--text-faint)">
              Window
              <select
                aria-label="Graph time window"
                value={display.window}
                disabled={display.overlay === "live"}
                onChange={(event) =>
                  commitDisplay({
                    ...display,
                    window: event.target.value as GraphWindow,
                  })
                }
                className="rounded-md border border-(--border) bg-(--surface-1) px-2 py-1 text-[12px] text-(--text) outline-none focus:border-(--accent) disabled:cursor-not-allowed disabled:opacity-40"
              >
                {GRAPH_WINDOWS.map((windowValue) => (
                  <option key={windowValue} value={windowValue}>
                    {windowValue}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative w-52">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const result = searchEnter(
                      matches,
                      safeMatchIdx,
                      focusNodeId,
                    );
                    if (result) {
                      e.preventDefault();
                      setMatchIdx(result.nextIdx);
                      onSelectNode(result.selectId);
                    }
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    if (query) setQuery("");
                    else e.currentTarget.blur();
                  }
                }}
                placeholder="Search nodes…"
                aria-label="Search graph nodes"
                data-view-filter
                spellCheck={false}
                className="w-full rounded-md border border-(--border) bg-(--surface-1) py-1 pr-20 pl-2.5 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
              />
              {query.trim() && (
                <span
                  className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] tabular-nums text-(--text-faint)"
                  aria-live="polite"
                >
                  {matches.length
                    ? `${safeMatchIdx + 1} / ${matches.length}`
                    : "no matches"}
                </span>
              )}
            </div>
            {positioned && graph && graph.nodes.length > 0 && (
              <Button onClick={() => setLayoutEpoch((n) => n + 1)}>
                Reset layout
              </Button>
            )}
          </div>
          {metricsFallback && (
            <div
              role="status"
              className="max-w-xl rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1.5 text-[11px] text-(--hue-warn)"
            >
              {metricsFallback}
            </div>
          )}
          {display.overlay !== "live" && historicalQ.isPending && (
            <div
              role="status"
              className="rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1.5 text-[11px] text-(--text-faint)"
            >
              Loading {OVERLAY_LABELS[display.overlay].toLowerCase()} for{" "}
              {display.window}…
            </div>
          )}
          {positioned && graph && graph.nodes.length > 0 && ramp ? (
            <div
              className="w-56 rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-2"
              role="img"
              aria-label={`${OVERLAY_LABELS[display.overlay]} legend from ${ramp.min.formatted} to ${ramp.max.formatted}`}
            >
              <div className="mb-1 flex items-center justify-between text-[11px] text-(--text-dim)">
                <span>{ramp.min.label}</span>
                <span>{display.window}</span>
              </div>
              <div
                className="h-2 rounded-full"
                style={{
                  // Read the ramp off the same function the nodes paint with,
                  // so the key cannot drift from the canvas.
                  background: `linear-gradient(90deg, ${historicalColor(ramp.min)}, ${historicalColor(ramp.max)})`,
                }}
              />
              <div className="mt-1 flex justify-between text-[11px] tabular-nums text-(--text-faint)">
                <span>{ramp.min.formatted}</span>
                <span>{ramp.max.formatted}</span>
              </div>
            </div>
          ) : (
            positioned &&
            graph &&
            graph.nodes.length > 0 &&
            legend &&
            (legend.nodes.length > 0 || legend.edges.length > 0) && (
              <div
                className="flex flex-col gap-1 rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-2"
                role="img"
                aria-label="Graph legend"
              >
                {legend.nodes.map((entry) => (
                  <div
                    key={entry.key}
                    className="flex items-center gap-2 text-[11px] text-(--text-dim)"
                  >
                    <span
                      aria-hidden
                      className="inline-block shrink-0 rounded-xs"
                      style={{
                        width: 14,
                        height: 11,
                        background: "var(--surface-0)",
                        border: `1px ${entry.dashed ? "dashed" : "solid"} var(--border)`,
                        borderLeft: `3px solid ${entry.accent}`,
                      }}
                    />
                    {entry.label}
                  </div>
                ))}
                {legend.edges.map((entry) => (
                  <div
                    key={entry.kind}
                    className="flex items-center gap-2 text-[11px] text-(--text-dim)"
                  >
                    <span
                      aria-hidden
                      className="inline-block shrink-0"
                      style={{
                        width: 14,
                        borderTop: `2px ${entry.strokeDasharray ? "dashed" : "solid"} ${entry.stroke}`,
                      }}
                    />
                    {entry.label}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
        {positioned && graph && graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={positioned.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onSelectNode(node.id)}
            onPaneClick={() => onSelectNode(null)}
            onNodesChange={(changes: NodeChange[]) => {
              const kept = changes.filter(
                (c) => c.type === "position" || c.type === "dimensions",
              );
              if (kept.length === 0) return;
              setPositioned((prev) => {
                if (!prev) return prev;
                return { ...prev, nodes: applyNodeChanges(kept, prev.nodes) };
              });
            }}
            onInit={(inst) => {
              flowRef.current = inst;
              setFlowReady((n) => n + 1);
            }}
            nodesFocusable
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
          >
            <Background color="var(--border)" gap={20} size={1} />
            <Controls
              showInteractive={false}
              style={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
              }}
            />
            {/* Minimap paints into SVG where var()/color-mix do not resolve —
                style its nodes by class instead (see theme.css). */}
            <MiniMap
              pannable
              zoomable
              style={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
              }}
              maskColor="rgba(0, 0, 0, 0.55)"
              nodeClassName={(n) => `minimap-node minimap-${n.type}`}
            />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-(--text-faint)">
            {emptyCopy}
          </div>
        )}
      </div>

      {selected && (
        <DetailPane
          widthClass="w-[420px]"
          title={selected.label}
          actions={
            <Button onClick={revealSelected}>
              Show on canvas{" "}
              <span
                className="mono ml-1 text-(--text-faint)"
                aria-hidden="true"
              >
                z
              </span>
            </Button>
          }
          utility={
            <CopyActions
              id={selected.label}
              idLabel={selected.kind === "agent" ? "agent ref" : "id"}
            />
          }
          close={<Button onClick={() => onSelectNode(null)}>Close</Button>}
        >
          {selected.historical && (
            <>
              <Section
                title={`${OVERLAY_LABELS[selected.historical.mode]} · ${display.window}`}
              >
                <KV
                  k={selected.historical.label}
                  v={selected.historical.formatted}
                />
                <KV k="window" v={display.window} />
              </Section>
              {(selected.kind === "agent" || selected.kind === "eventType") && (
                <>
                  <Button
                    onClick={() =>
                      selected.kind === "agent"
                        ? onJumpAgent(selected.label)
                        : onJumpEvents({ type: selected.label })
                    }
                  >
                    {selected.kind === "agent"
                      ? "Open in Agents"
                      : "Show in Events"}
                  </Button>
                  {/* Neither destination takes a time filter, so say so rather
                      than hand over a link that quietly shows all time. */}
                  <div className="mt-1 text-[11px] text-(--text-faint)">
                    {selected.kind === "agent" ? "Agents" : "Events"} is not
                    filtered by window — {display.window} applies to the figures
                    above only.
                  </div>
                </>
              )}
            </>
          )}

          {selected.kind === "eventType" && (
            <>
              <Section title="Event type">
                <KV k="type" v={selected.label} />
                <KV k="adapter" v={selected.adapter} />
                <KV
                  k="idempotency scope"
                  v={selected.scope.join(" + ") || "—"}
                />
                <KV
                  k="proposal ttl"
                  v={selected.ttl ? `${selected.ttl}s` : "—"}
                />
                {selected.admittedCount !== undefined && (
                  <KV k="admitted events" v={String(selected.admittedCount)} />
                )}
                {selected.plannedCount !== undefined && (
                  <KV k="planned events" v={String(selected.plannedCount)} />
                )}
              </Section>
              <Button onClick={() => onJumpEvents({ type: selected.label })}>
                Show in Events
              </Button>
            </>
          )}

          {selected.kind === "terminal" && (
            <Section title="Terminal">
              <div className="text-[12px] text-(--text-dim)">
                Recommendation values with no registered edge:{" "}
                <span className="mono">{selected.reason}</span>. A run that
                returns one of these completes and chains no further.
              </div>
            </Section>
          )}

          {selected.kind === "proposal" && (
            <>
              <Section title="Pending proposal">
                <KV k="id" v={selected.proposalId} />
                <KV
                  k="decision"
                  v={
                    <StateBadge
                      state={selected.decision}
                      hues={DECISION_HUES}
                    />
                  }
                />
                <KV
                  k="agent"
                  v={
                    selected.agentRef ? (
                      <JumpLink
                        onClick={() => onJumpAgent(selected.agentRef!)}
                        title="Open in Agents"
                      >
                        {selected.agentRef}
                      </JumpLink>
                    ) : (
                      "—"
                    )
                  }
                />
                <KV
                  k="origin"
                  v={`${selected.proposal.eventSource ?? "—"} · ${selected.proposal.eventId ?? "—"}`}
                />
                <KV
                  k="created"
                  v={<Ago iso={selected.proposal.created_at} now={now} />}
                />
                <KV
                  k="ttl"
                  v={`${selected.proposal.ttl_seconds}s ${selected.proposal.expired ? "(expired)" : "remaining"}`}
                />
                {selected.proposal.reason && (
                  <KV k="reason" v={selected.proposal.reason} />
                )}
                {selected.eventType && (
                  <KV
                    k="event type"
                    v={
                      <JumpLink
                        onClick={() =>
                          onJumpEvents({ type: selected.eventType! })
                        }
                        title="Open in Events"
                      >
                        {selected.eventType}
                      </JumpLink>
                    }
                  />
                )}
              </Section>
              {selected.proposal.spec && (
                <Section title="Run spec" card={false}>
                  <JsonBlock value={selected.proposal.spec} />
                </Section>
              )}
              {selected.agentRef && (
                <Button onClick={() => onJumpAgent(selected.agentRef!)}>
                  Open in Agents
                </Button>
              )}
              <Button onClick={() => onJumpProposal(selected.proposalId)}>
                Open in Proposals
              </Button>
            </>
          )}

          {selected.kind === "agent" && agentDef && (
            <>
              <Section title="Agent">
                <KV
                  k="ref"
                  v={
                    <JumpLink
                      onClick={() => onJumpAgent(agentDef.ref)}
                      title="Open in Agents"
                    >
                      {agentDef.ref}
                    </JumpLink>
                  }
                />
                <KV k="execution" v={selected.execution} />
                <KV k="output contract" v={agentDef.outputContract} />
                <KV k="mutating" v={agentDef.mutating ? "yes" : "no"} />
                <KV
                  k="capabilities"
                  v={agentDef.capabilities?.services?.join(", ") ?? "—"}
                />
                <KV
                  k="timeout"
                  v={`${agentDef.limits?.timeout_seconds ?? "—"}s`}
                />
                <KV k="attempts" v={String(agentDef.limits?.attempts ?? "—")} />
                {selected.activeRuns && selected.activeRuns.length > 0 && (
                  <KV
                    k="active runs"
                    v={
                      <span className="flex items-center gap-1.5 flex-wrap">
                        {selected.activeRuns.map(({ state, count }) => (
                          <StateBadge
                            key={state}
                            state={count > 1 ? `${state} ${count}` : state}
                            hues={{
                              ...STATE_HUES,
                              [`${state} ${count}`]:
                                STATE_HUES[state] ?? "var(--hue-idle)",
                            }}
                          />
                        ))}
                      </span>
                    }
                  />
                )}
              </Section>
              {agentDef.command && (
                <Section title="Closed command template" card={false}>
                  <JsonBlock value={agentDef.command} />
                </Section>
              )}
              {agentDef.actionRegistry && (
                <Section
                  title={`Closed action registry · hosts ${agentDef.hosts?.join(", ")}`}
                  card={false}
                >
                  <JsonBlock value={agentDef.actionRegistry} />
                </Section>
              )}
              <Section title="Prompt" card={false}>
                <pre className="mono max-h-64 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 whitespace-pre-wrap">
                  {agentDef.prompt}
                </pre>
              </Section>
              <Button onClick={() => onJumpAgent(agentDef.ref)}>
                Open in Agents
              </Button>
            </>
          )}
        </DetailPane>
      )}
    </div>
  );
}

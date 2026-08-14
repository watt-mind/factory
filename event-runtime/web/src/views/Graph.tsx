import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { keyGuard } from "../hooks";
import { buildCapabilityGraph, type GraphNode } from "../graph/model";
import { nodeTypes } from "../graph/nodes";
import { largestComponentIds, matchNodes } from "../graph/search";
import { EDGE_STYLES, legendEntries } from "../graph/style";
import type { EventFocus } from "../types";
import type { OperatorContext } from "../context";
import { Button, DetailPane, JsonBlock, JumpLink, KV, Section, copyText, copyLink } from "../components/ui";
import { ScopeCaption } from "../components/ContextTabs";

// Fit-all on a large graph lands at ~0.1–0.3 zoom where labels are unreadable
// (WM-99). The initial fit centers on the largest component and never goes
// below this floor — the minimap covers "where is everything else".
const INITIAL_FIT_MIN_ZOOM = 0.65;

/**
 * Graph (webui roadmap / OPS-224 phase 1, chrome OPS-230): the capability map
 * — what this runtime *can* do, drawn from the registry alone. Same inverted-L
 * as the list views: canvas + right detail, jumps to Events/Agents, Copy id,
 * honest empty when /agents is down. Phase 2 overlays live run state.
 */
export function Graph({
  context,
  focusNodeId,
  onSelectNode,
  onJumpAgent,
  onJumpEvents,
}: {
  context: OperatorContext;
  focusNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvents: (focus: EventFocus) => void;
}) {
  const registry = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 10_000 });
  const [positioned, setPositioned] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [layoutError, setLayoutError] = useState<"chunk" | "layout" | "mapping" | null>(null);
  const flowRef = useRef<{
    getZoom: () => number;
    fitView: (opts: {
      nodes?: Array<{ id: string }>;
      padding?: number;
      duration?: number;
      minZoom?: number;
      maxZoom?: number;
    }) => void;
  } | null>(null);
  const [flowReady, setFlowReady] = useState(0);

  const { graph, mappingError } = useMemo(() => {
    if (!registry.data) return { graph: null, mappingError: false };
    try {
      return { graph: buildCapabilityGraph(registry.data), mappingError: false };
    } catch (err) {
      console.error("graph mapping failed", err);
      return { graph: null, mappingError: true };
    }
  }, [registry.data]);

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    setLayoutError(null);
    // elkjs is ~1.4 MB of pre-minified layout engine, so it rides in its own
    // async chunk (OPS-255) — fetched the first time there is a graph to lay
    // out, never by the list views.
    import("../graph/layout")
      .then(
        ({ layoutGraph, NODE_HEIGHT, NODE_WIDTH }) =>
          layoutGraph(graph)
            .then((positions) => {
              if (cancelled) return;
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
                  edges: graph.edges.map((edge) => ({
                    id: edge.id,
                    source: edge.source,
                    target: edge.target,
                    label: edge.label,
                    animated: false,
                    style: {
                      stroke: EDGE_STYLES[edge.kind].stroke,
                      strokeWidth: 1.5,
                      strokeDasharray: EDGE_STYLES[edge.kind].strokeDasharray,
                    },
                    labelStyle: { fill: "var(--text-faint)", fontSize: 10 },
                    labelBgStyle: { fill: "var(--surface-0)" },
                  })),
                });
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
            }),
        (err: unknown) => {
          if (cancelled) return;
          console.error("graph layout chunk import failed", err);
          setLayoutError("chunk");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [graph]);

  // Node search (WM-99): case-insensitive substring on label/id, matches
  // highlighted on canvas, Enter cycles through them.
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const matches = useMemo(() => (graph ? matchNodes(graph.nodes, query) : []), [graph, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const safeMatchIdx = matches.length ? matchIdx % matches.length : 0;
  const currentMatch = matches[safeMatchIdx] ?? null;
  const legend = useMemo(() => (graph ? legendEntries(graph) : null), [graph]);

  const nodes = useMemo(
    () =>
      positioned
        ? positioned.nodes.map((n) => ({
            ...n,
            selected: n.id === focusNodeId,
            data: { ...n.data, searchHit: matchSet.has(n.id) },
          }))
        : [],
    [positioned, focusNodeId, matchSet],
  );

  const selected: GraphNode | undefined = graph?.nodes.find((n) => n.id === focusNodeId);
  const agentDef =
    selected?.kind === "agent"
      ? registry.data?.agents.find((a) => a.ref === selected.label)
      : undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onSelectNode(null);
        return;
      }
      if (e.key === "c" && focusNodeId) {
        e.preventDefault();
        const node = graph?.nodes.find((n) => n.id === focusNodeId);
        if (node) copyText(node.label, node.kind === "agent" ? "agent ref" : "id");
        return;
      }
      const order = positioned
        ? [...positioned.nodes]
            .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
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
  }, [onSelectNode, focusNodeId, graph, positioned]);

  const revealSelected = () => {
    if (!focusNodeId || !flowRef.current) return;
    const zoom = flowRef.current.getZoom();
    flowRef.current.fitView({
      nodes: [{ id: focusNodeId }],
      padding: 0.45,
      duration: 180,
      minZoom: zoom,
      maxZoom: zoom,
    });
  };

  // Initial view (WM-99): fit the largest connected component with a zoom
  // floor instead of squeezing every island on screen at label-illegible zoom.
  // Runs once per mount; refetches must not yank the viewport afterwards.
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current || !flowRef.current || !positioned || !graph || graph.nodes.length === 0)
      return;
    didInitialFit.current = true;
    flowRef.current.fitView({
      nodes: largestComponentIds(graph).map((id) => ({ id })),
      padding: 0.25,
      minZoom: INITIAL_FIT_MIN_ZOOM,
      maxZoom: 1,
    });
  }, [graph, positioned, flowReady]);

  useEffect(() => {
    revealSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId, flowReady, positioned]);

  // Center the current search match at the operator's zoom; `currentMatch` is
  // a stable string, so background refetches do not re-center the viewport.
  useEffect(() => {
    setMatchIdx(0);
  }, [query]);
  useEffect(() => {
    if (!currentMatch || !flowRef.current) return;
    const zoom = Math.max(flowRef.current.getZoom(), INITIAL_FIT_MIN_ZOOM);
    flowRef.current.fitView({
      nodes: [{ id: currentMatch }],
      padding: 0.45,
      duration: 180,
      minZoom: zoom,
      maxZoom: zoom,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <div className="absolute top-4 left-5 z-10">
          <h1 className="display text-lg font-semibold">Graph</h1>
          <div className="text-[11px] text-(--text-faint)">
            what this runtime can do — registered routes and recommendation edges
          </div>
          <ScopeCaption context={context} surface="graph" />
        </div>
        {positioned && graph && graph.nodes.length > 0 && (
          <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              {query.trim() && (
                <span className="text-[11px] text-(--text-faint)">
                  {matches.length ? `${safeMatchIdx + 1} / ${matches.length}` : "no matches"}
                </span>
              )}
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matches.length) {
                    e.preventDefault();
                    setMatchIdx((i) => (i + 1) % matches.length);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    if (query) setQuery("");
                    else e.currentTarget.blur();
                  }
                }}
                placeholder="Search nodes…"
                aria-label="Search graph nodes"
                spellCheck={false}
                className="w-52 rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
              />
            </div>
            {legend && (legend.nodes.length > 0 || legend.edges.length > 0) && (
              <div
                className="flex flex-col gap-1 rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-2"
                role="img"
                aria-label="Graph legend"
              >
                {legend.nodes.map((entry) => (
                  <div key={entry.key} className="flex items-center gap-2 text-[11px] text-(--text-dim)">
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
                  <div key={entry.kind} className="flex items-center gap-2 text-[11px] text-(--text-dim)">
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
            )}
          </div>
        )}
        {positioned && graph && graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={positioned.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onSelectNode(node.id)}
            onPaneClick={() => onSelectNode(null)}
            onInit={(inst) => {
              flowRef.current = inst;
              setFlowReady((n) => n + 1);
            }}
            nodesFocusable
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
          >
            <Background color="var(--border)" gap={20} size={1} />
            <Controls
              showInteractive={false}
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
            />
            {/* Minimap paints into SVG where var()/color-mix do not resolve —
                style its nodes by class instead (see theme.css). */}
            <MiniMap
              pannable
              zoomable
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
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
            <>
              <Button onClick={() => copyText(selected.label, selected.kind === "agent" ? "agent ref" : "id")}>
                {selected.kind === "agent" ? "Copy ref" : "Copy id"}
              </Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={revealSelected}>Show on canvas</Button>
              <Button onClick={() => onSelectNode(null)}>Close</Button>
            </>
          }
        >

          {selected.kind === "eventType" && (
            <>
              <Section title="Event type">
                <KV k="type" v={selected.label} />
                <KV k="adapter" v={selected.adapter} />
                <KV k="idempotency scope" v={selected.scope.join(" + ") || "—"} />
                <KV k="proposal ttl" v={selected.ttl ? `${selected.ttl}s` : "—"} />
              </Section>
              <Button onClick={() => onJumpEvents({ type: selected.label })}>
                Show in Events
              </Button>
            </>
          )}

          {selected.kind === "terminal" && (
            <Section title="Terminal">
              <div className="text-[12px] text-(--text-dim)">
                Recommendation values with no registered edge: <span className="mono">{selected.reason}</span>. A
                run that returns one of these completes and chains no further.
              </div>
            </Section>
          )}

          {selected.kind === "agent" && agentDef && (
            <>
              <Section title="Agent">
                <KV
                  k="ref"
                  v={
                    <JumpLink onClick={() => onJumpAgent(agentDef.ref)} title="Open in Agents">
                      {agentDef.ref}
                    </JumpLink>
                  }
                />
                <KV k="execution" v={selected.execution} />
                <KV k="output contract" v={agentDef.outputContract} />
                <KV k="mutating" v={agentDef.mutating ? "yes" : "no"} />
                <KV k="capabilities" v={agentDef.capabilities?.services?.join(", ") ?? "—"} />
                <KV k="timeout" v={`${agentDef.limits?.timeout_seconds ?? "—"}s`} />
                <KV k="attempts" v={String(agentDef.limits?.attempts ?? "—")} />
              </Section>
              {agentDef.command && (
                <Section title="Closed command template">
                  <JsonBlock value={agentDef.command} />
                </Section>
              )}
              {agentDef.actionRegistry && (
                <Section title={`Closed action registry · hosts ${agentDef.hosts?.join(", ")}`}>
                  <JsonBlock value={agentDef.actionRegistry} />
                </Section>
              )}
              <Section title="Prompt">
                <pre className="mono max-h-64 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 whitespace-pre-wrap">
                  {agentDef.prompt}
                </pre>
              </Section>
              <Button onClick={() => onJumpAgent(agentDef.ref)}>Open in Agents</Button>
            </>
          )}
        </DetailPane>
      )}
    </div>
  );
}

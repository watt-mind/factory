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
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { buildCapabilityGraph, type GraphNode } from "../graph/model";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "../graph/layout";
import { nodeTypes } from "../graph/nodes";
import { JsonBlock, KV, Section, Button } from "../components/ui";

/**
 * Graph (webui roadmap / OPS-224 phase 1): the capability map — what this
 * runtime *can* do, drawn from the registry alone. Event types route to
 * agents; agents recommend follow-up event types; unmapped recommendation
 * values are drawn as terminals, because "the chain ends here" is topology.
 * Phase 2 overlays live run state onto these same nodes.
 */
export function Graph() {
  const registry = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 10_000 });
  const [positioned, setPositioned] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const graph = useMemo(
    () => (registry.data ? buildCapabilityGraph(registry.data) : null),
    [registry.data],
  );

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    layoutGraph(graph).then((positions) => {
      if (cancelled) return;
      setPositioned({
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          type: node.kind,
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          data: { node },
          draggable: true,
          // Explicit dimensions: the minimap draws from these, and elk was
          // laid out against the same constants.
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
            stroke: edge.kind === "recommends" ? "var(--accent)" : "var(--border-strong)",
            strokeWidth: 1.5,
            strokeDasharray: edge.kind === "recommends" ? "4 3" : undefined,
          },
          labelStyle: { fill: "var(--text-faint)", fontSize: 10 },
          labelBgStyle: { fill: "var(--surface-0)" },
        })),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  const selected: GraphNode | undefined = graph?.nodes.find((n) => n.id === selectedId);
  const agentDef =
    selected?.kind === "agent"
      ? registry.data?.agents.find((a) => a.ref === selected.label)
      : undefined;

  return (
    <div className="flex h-full min-w-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute top-4 left-5 z-10">
          <h1 className="display text-lg font-semibold">Graph</h1>
          <div className="text-[11px] text-(--text-faint)">
            what this runtime can do — registered routes and recommendation edges
          </div>
        </div>
        {positioned ? (
          <ReactFlow
            nodes={positioned.nodes}
            edges={positioned.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.25 }}
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
          <div className="flex h-full items-center justify-center text-(--text-faint)">
            {registry.isError ? "runtime unreachable" : "laying out the capability map…"}
          </div>
        )}
      </div>

      {selected && (
        <div className="w-[420px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="display truncate text-[14px] font-semibold">{selected.label}</div>
            <Button onClick={() => setSelectedId(null)}>Close</Button>
          </div>

          {selected.kind === "eventType" && (
            <Section title="Event type">
              <KV k="type" v={selected.label} />
              <KV k="adapter" v={selected.adapter} />
              <KV k="idempotency scope" v={selected.scope.join(" + ") || "—"} />
              <KV k="proposal ttl" v={selected.ttl ? `${selected.ttl}s` : "—"} />
            </Section>
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
                <KV k="ref" v={agentDef.ref} />
                <KV k="execution" v={selected.execution} />
                <KV k="output contract" v={agentDef.outputContract} />
                <KV k="mutating" v={String(agentDef.mutating)} />
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

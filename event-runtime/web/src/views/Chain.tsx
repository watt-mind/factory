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
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { keyGuard, useNow } from "../hooks";
import {
  buildChainGraph,
  chainOriginLabel,
  eventNodeId,
  runNodeId,
  type ChainGraph,
  type ChainNode,
} from "../graph/chainModel";
import { CHAIN_EDGE_STYLES, chainNodeTypes } from "../graph/chainNodes";
import {
  Ago,
  Button,
  CopyActions,
  DetailPane,
  EVENT_STATUS_HUES,
  JumpLink,
  KV,
  STATE_HUES,
  Section,
  StateBadge,
  shortId,
} from "../components/ui";

const INITIAL_FIT_MIN_ZOOM = 0.4;

function flowEdges(graph: ChainGraph): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: false,
    style: {
      stroke: CHAIN_EDGE_STYLES[edge.kind].stroke,
      strokeWidth: 1.5,
      strokeDasharray: (CHAIN_EDGE_STYLES[edge.kind] as { strokeDasharray?: string }).strokeDasharray,
    },
  }));
}

/**
 * Chain trace (WM-527): `#/chain/:correlationId` — every event and run that
 * shares one correlation id, laid out as the DAG the runtime actually walked
 * (origin event → run → emitted events → runs …). The capability map answers
 * "what can happen"; this answers "what happened to *this* one, and where
 * did it start".
 */
export function Chain({
  correlationId,
  focusNodeId,
  onSelectNode,
  onJumpEvent,
  onJumpRun,
  onOpenRunFull,
  onJumpProposal,
  onJumpAgent,
}: {
  correlationId: string;
  focusNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpRun: (runId: string) => void;
  onOpenRunFull: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpAgent: (ref: string) => void;
}) {
  const chainQ = useQuery({
    queryKey: ["chain", correlationId],
    queryFn: () => api.chain(correlationId),
    refetchInterval: 3000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const now = useNow();
  const notFound = chainQ.isError && chainQ.error instanceof ApiError && chainQ.error.status === 404;

  const graph = useMemo(() => (chainQ.data ? buildChainGraph(chainQ.data) : null), [chainQ.data]);

  const [positioned, setPositioned] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const lastIdentityRef = useRef<string | null>(null);
  const epochLaidOutRef = useRef(0);
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
  const didInitialFit = useRef(false);

  // Reset canvas state when the operator moves to another chain.
  useEffect(() => {
    setPositioned(null);
    lastIdentityRef.current = null;
    didInitialFit.current = false;
  }, [correlationId]);

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    setLayoutError(null);
    // Same async elk chunk as the capability map (OPS-255); positions are
    // reused while node/edge identity is unchanged so the 3s poll only
    // refreshes states/badges (WM-154 pattern).
    import("../graph/layout")
      .then(({ CHAIN_LAYOUT_OPTIONS, layoutGraph, layoutGraphIfIdentityChanged, NODE_HEIGHT, NODE_WIDTH }) => {
        const prevIdentity = layoutEpoch !== epochLaidOutRef.current ? null : lastIdentityRef.current;
        return layoutGraphIfIdentityChanged(graph, prevIdentity, (g) =>
          layoutGraph(g, undefined, CHAIN_LAYOUT_OPTIONS),
        ).then((result) => {
          if (cancelled) return;
          lastIdentityRef.current = result.identity;
          epochLaidOutRef.current = layoutEpoch;
          const byId = new Map(graph.nodes.map((n) => [n.id, n]));
          if (!result.positions) {
            setPositioned((prev) =>
              prev
                ? {
                    nodes: prev.nodes.map((n) => ({ ...n, data: { ...n.data, node: byId.get(n.id) } })),
                    edges: flowEdges(graph),
                  }
                : prev,
            );
            return;
          }
          const positions = result.positions;
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
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("chain layout failed", err);
        setLayoutError("Could not lay out the chain — the layout engine failed or timed out.");
      });
    return () => {
      cancelled = true;
    };
  }, [graph, layoutEpoch]);

  const nodes = useMemo(
    () =>
      positioned
        ? positioned.nodes.map((n) => ({
            ...n,
            selected: n.id === focusNodeId,
            data: { ...n.data, now },
          }))
        : [],
    [positioned, focusNodeId, now],
  );

  const selected: ChainNode | undefined = graph?.nodes.find((n) => n.id === focusNodeId);

  const revealSelected = () => {
    if (!focusNodeId || !flowRef.current) return;
    const zoom = flowRef.current.getZoom();
    flowRef.current.fitView({ nodes: [{ id: focusNodeId }], padding: 0.45, duration: 180, minZoom: zoom, maxZoom: zoom });
  };

  useEffect(() => {
    if (didInitialFit.current || !flowRef.current || !positioned || !graph || graph.nodes.length === 0) return;
    didInitialFit.current = true;
    flowRef.current.fitView({ padding: 0.2, minZoom: INITIAL_FIT_MIN_ZOOM, maxZoom: 1 });
  }, [graph, positioned, flowReady]);

  useEffect(() => {
    revealSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId, flowReady, positioned]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onSelectNode(null);
        return;
      }
      if (e.key === "z" && focusNodeId) {
        e.preventDefault();
        revealSelected();
        return;
      }
      const order = positioned
        ? [...positioned.nodes]
            .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
            .map((n) => n.id)
        : [];
      if (!order.length) return;
      if (e.key === "j" || e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : -1;
        onSelectNode(order[Math.min(idx + 1, order.length - 1)]);
      } else if (e.key === "k" || e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : order.length;
        onSelectNode(order[Math.max(idx - 1, 0)]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectNode, focusNodeId, positioned]);

  const origin = graph ? chainOriginLabel(graph) : null;
  const eventCount = graph?.nodes.filter((n) => n.kind === "chainEvent").length ?? 0;
  const runCount = graph?.nodes.filter((n) => n.kind === "chainRun").length ?? 0;
  const runStates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      if (n.kind === "chainRun") counts.set(n.run.state, (counts.get(n.run.state) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [graph]);

  const emptyCopy = notFound
    ? `No chain with correlation id ${correlationId} on this runtime.`
    : chainQ.isPending
      ? "Loading chain…"
      : chainQ.isError
        ? "Cannot reach the control API — the chain will appear when /chain is up."
        : layoutError ?? "Laying out the chain…";

  return (
    <div className="flex h-full min-w-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute top-4 left-5 z-10 max-w-[60%]">
          <h1 className="display text-lg font-semibold">Chain</h1>
          <div className="mono truncate text-[11px] text-(--text-faint)" title={correlationId}>
            {correlationId}
          </div>
          {graph && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-(--text-dim)">
              {origin && (
                <span>
                  origin <span className="mono">{origin}</span>
                </span>
              )}
              <span>
                {eventCount} event{eventCount === 1 ? "" : "s"} · {runCount} run{runCount === 1 ? "" : "s"} ·{" "}
                {graph.maxDepth} hop{graph.maxDepth === 1 ? "" : "s"}
              </span>
              {runStates.length > 0 && (
                <span className="flex items-center gap-1">
                  {runStates.map(([state, count]) => (
                    <StateBadge key={state} state={count > 1 ? `${state} ×${count}` : state} hues={badgeHues(state, count)} dot={false} />
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <CopyActions id={correlationId} idLabel="correlation id" />
            {positioned && graph && graph.nodes.length > 0 && (
              <Button onClick={() => setLayoutEpoch((n) => n + 1)}>Reset layout</Button>
            )}
          </div>
          {positioned && graph && graph.nodes.length > 0 && (
            <div
              className="flex flex-col gap-1 rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-2"
              role="img"
              aria-label="Chain legend"
            >
              {(Object.keys(CHAIN_EDGE_STYLES) as Array<keyof typeof CHAIN_EDGE_STYLES>).map((kind) => {
                const entry = CHAIN_EDGE_STYLES[kind] as { label: string; stroke: string; strokeDasharray?: string };
                return (
                  <div key={kind} className="flex items-center gap-2 text-[11px] text-(--text-dim)">
                    <span
                      aria-hidden
                      className="inline-block shrink-0"
                      style={{ width: 14, borderTop: `2px ${entry.strokeDasharray ? "dashed" : "solid"} ${entry.stroke}` }}
                    />
                    {entry.label}
                  </div>
                );
              })}
              <div className="text-[11px] text-(--text-faint)">left border = event status / run state</div>
            </div>
          )}
        </div>
        {positioned && graph && graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={positioned.edges}
            nodeTypes={chainNodeTypes}
            onNodeClick={(_, node) => onSelectNode(node.id)}
            onPaneClick={() => onSelectNode(null)}
            onNodesChange={(changes: NodeChange[]) => {
              const kept = changes.filter((c) => c.type === "position" || c.type === "dimensions");
              if (kept.length === 0) return;
              setPositioned((prev) => (prev ? { ...prev, nodes: applyNodeChanges(kept, prev.nodes) } : prev));
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
            <Controls showInteractive={false} style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }} />
            <MiniMap
              pannable
              zoomable
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
              maskColor="rgba(0, 0, 0, 0.55)"
              nodeClassName={(n) => `minimap-node minimap-${n.type}`}
            />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-(--text-faint)">{emptyCopy}</div>
        )}
      </div>

      {selected && (
        <DetailPane
          widthClass="w-[420px]"
          title={selected.kind === "chainEvent" ? selected.event.type : (selected.run.agent ?? selected.run.runId)}
          actions={
            <Button onClick={revealSelected}>
              Show on canvas <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">z</span>
            </Button>
          }
          utility={
            <CopyActions
              id={selected.kind === "chainEvent" ? selected.event.eventId : selected.run.runId}
              idLabel={selected.kind === "chainEvent" ? "event id" : "run id"}
            />
          }
          close={<Button onClick={() => onSelectNode(null)}>Close</Button>}
        >
          {selected.kind === "chainEvent" && (
            <>
              <Section id="chain-event" title={selected.root ? "Origin event" : "Event"} icons>
                <KV k="source" v={selected.event.source} />
                <KV k="type" v={selected.event.type} />
                <KV k="subject" v={selected.event.subject} />
                <KV k="status" v={<StateBadge state={selected.event.status} hues={EVENT_STATUS_HUES} />} />
                <KV k="depth" v={`${selected.depth} hop${selected.depth === 1 ? "" : "s"} from origin`} />
                <KV k="admittedAt" v={<Ago iso={selected.event.admittedAt} now={now} />} />
                <KV
                  k="emitted by run"
                  v={
                    selected.event.causationId ? (
                      <JumpLink
                        onClick={() => onSelectNode(runNodeId(selected.event.causationId!))}
                        title={selected.event.causationId}
                      >
                        {shortId(selected.event.causationId)}
                      </JumpLink>
                    ) : (
                      "— (origin)"
                    )
                  }
                />
                <KV
                  k="proposal"
                  v={
                    selected.event.proposalId ? (
                      <JumpLink onClick={() => onJumpProposal(selected.event.proposalId!)} title={selected.event.proposalId}>
                        {shortId(selected.event.proposalId)}
                        {selected.event.proposalDecision ? ` · ${selected.event.proposalDecision}` : ""}
                      </JumpLink>
                    ) : null
                  }
                />
                <KV
                  k="run"
                  v={
                    selected.event.runId ? (
                      <JumpLink onClick={() => onSelectNode(runNodeId(selected.event.runId!))} title={selected.event.runId}>
                        {shortId(selected.event.runId)}
                      </JumpLink>
                    ) : null
                  }
                />
                {selected.event.repos.length > 0 && <KV k="repos" v={selected.event.repos.join(", ")} />}
              </Section>
              <Button onClick={() => onJumpEvent(selected.event.source, selected.event.eventId)}>Open in Events</Button>
            </>
          )}
          {selected.kind === "chainRun" && (
            <>
              <Section id="chain-run" title="Run" icons>
                <KV k="state" v={<StateBadge state={selected.run.state} />} />
                <KV
                  k="agent"
                  v={
                    selected.run.agent ? (
                      <JumpLink onClick={() => onJumpAgent(selected.run.agent!)} title="Open in Agents">
                        {selected.run.agent}
                      </JumpLink>
                    ) : null
                  }
                />
                <KV k="adapter" v={selected.run.adapter} />
                <KV k="attempts" v={String(selected.run.attempts)} />
                {selected.run.reasonCode && <KV k="reason" v={selected.run.reasonCode} />}
                <KV k="depth" v={`${selected.depth} hop${selected.depth === 1 ? "" : "s"} from origin`} />
                <KV k="created" v={<Ago iso={selected.run.created_at} now={now} />} />
                <KV k="started" v={<Ago iso={selected.run.startedAt} now={now} />} />
                <KV k="finished" v={<Ago iso={selected.run.finishedAt} now={now} />} />
                <KV
                  k="origin event"
                  v={
                    selected.run.eventSource && selected.run.eventId ? (
                      <JumpLink
                        onClick={() => onSelectNode(eventNodeId(selected.run.eventSource!, selected.run.eventId!))}
                        title={selected.run.eventId}
                      >
                        {shortId(selected.run.eventId)}
                      </JumpLink>
                    ) : null
                  }
                />
                {selected.run.repos.length > 0 && <KV k="repos" v={selected.run.repos.join(", ")} />}
              </Section>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => onOpenRunFull(selected.run.runId)}>Open run</Button>
                <Button onClick={() => onJumpRun(selected.run.runId)}>Show in Runs</Button>
              </div>
            </>
          )}
        </DetailPane>
      )}
    </div>
  );
}

function badgeHues(state: string, count: number): Record<string, string> {
  const hue = STATE_HUES[state] ?? "var(--hue-idle)";
  return { ...STATE_HUES, [`${state} ×${count}`]: hue };
}

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
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { keyGuard, useNow } from "../hooks";
import { hashSearch } from "../hash";
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
  buildChainTimeline,
  chainViewModeFromQuery,
  formatDelta,
  humanizeRunReason,
  loadChainViewMode,
  saveChainViewMode,
  type ChainTimeline,
  type ChainTimelineRow,
  type ChainViewMode,
  type TimelineRef,
} from "../chainTimeline";
import {
  Ago,
  Button,
  CopyActions,
  DECISION_HUES,
  DetailPane,
  EVENT_STATUS_HUES,
  JumpLink,
  KV,
  STATE_HUES,
  Section,
  StateBadge,
  Tabs,
  shortId,
} from "../components/ui";
import type { RunDetail } from "../types";

const INITIAL_FIT_MIN_ZOOM = 0.4;

const TIMELINE_DECISION_HUES: Record<string, string> = { ...DECISION_HUES, planned: DECISION_HUES.run };
const TIMELINE_EVENT_HUES: Record<string, string> = EVENT_STATUS_HUES;
const TIMELINE_MUTED_HUES: Record<string, string> = { next: "var(--hue-idle)" };

function huesFor(row: ChainTimelineRow): Record<string, string> {
  switch (row.hues) {
    case "event":
      return TIMELINE_EVENT_HUES;
    case "decision":
      return TIMELINE_DECISION_HUES;
    case "muted":
      return TIMELINE_MUTED_HUES;
    default:
      return STATE_HUES;
  }
}

function rowTime(at: string | null): string {
  if (!at) return "";
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? at : t.toLocaleTimeString([], { hour12: false });
}

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

  // Graph | Timeline (WM-639). `?view=` on a deep link wins for this visit;
  // the toggle itself persists like the other display options.
  const [mode, setModeState] = useState<ChainViewMode>(
    () => chainViewModeFromQuery(hashSearch(window.location.hash)) ?? loadChainViewMode(),
  );
  const setMode = useCallback((next: ChainViewMode) => {
    saveChainViewMode(next);
    setModeState(next);
  }, []);
  // `?node=` is the timeline's deep-link spelling of the path segment; lift it
  // into the selection so the row highlights and Enter opens the pane.
  const deepLinkNodeRef = useRef<string | null>(hashSearch(window.location.hash).get("node"));
  useEffect(() => {
    const node = deepLinkNodeRef.current;
    if (!node || focusNodeId) return;
    deepLinkNodeRef.current = null;
    onSelectNode(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timelineOn = mode === "timeline";
  const runIds = useMemo(() => (chainQ.data?.runs ?? []).map((r) => r.runId), [chainQ.data]);
  const runQs = useQueries({
    queries: runIds.map((id) => ({
      queryKey: ["run", id],
      queryFn: () => api.run(id),
      enabled: timelineOn,
      refetchInterval: 3000,
      retry: 1,
    })),
  });
  const proposalsQ = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    enabled: timelineOn,
    refetchInterval: 5000,
  });
  const schedulesQ = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    enabled: timelineOn,
    refetchInterval: 10000,
  });
  const inboxQ = useQuery({
    queryKey: ["inbox", "open"],
    queryFn: () => api.inbox("open"),
    enabled: timelineOn,
    refetchInterval: 5000,
  });
  // One stable key per fetch generation so the memo below has a fixed-size dep
  // list whatever the chain's run count is.
  const runDetailsKey = runQs.map((q) => q.dataUpdatedAt).join(",");
  const runDetails = useMemo(() => {
    const out: Record<string, RunDetail | undefined> = {};
    runIds.forEach((id, i) => {
      out[id] = runQs[i]?.data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runIds, runDetailsKey]);
  const timeline: ChainTimeline | null = useMemo(
    () =>
      timelineOn && chainQ.data
        ? buildChainTimeline({
            chain: chainQ.data,
            runDetails,
            proposals: proposalsQ.data?.proposals ?? [],
            schedules: schedulesQ.data?.schedules ?? [],
            inbox: inboxQ.data?.items ?? [],
            now,
          })
        : null,
    [timelineOn, chainQ.data, runDetails, proposalsQ.data, schedulesQ.data, inboxQ.data, now],
  );

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
  // The canvas unmounts in timeline mode; fit it again when it comes back.
  useEffect(() => {
    if (timelineOn) {
      flowRef.current = null;
      didInitialFit.current = false;
    }
  }, [timelineOn]);

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

  const timelineListRef = useRef<HTMLOListElement | null>(null);
  const revealSelected = () => {
    if (!focusNodeId) return;
    if (timelineOn) {
      const rows = timelineListRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [];
      for (const row of rows) {
        if (row.dataset.nodeId === focusNodeId) {
          row.scrollIntoView?.({ block: "nearest" });
          break;
        }
      }
      return;
    }
    if (!flowRef.current) return;
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
  }, [focusNodeId, flowReady, positioned, timelineOn, timeline?.rows.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onSelectNode(null);
        return;
      }
      if (e.key === "t") {
        e.preventDefault();
        setMode(timelineOn ? "graph" : "timeline");
        return;
      }
      if (e.key === "z" && focusNodeId) {
        e.preventDefault();
        revealSelected();
        return;
      }
      if (e.key === "Enter" && timelineOn && focusNodeId) {
        // The pane already follows the selection; Enter re-asserts it for a
        // row reached by deep link, matching graph mode's click-to-open.
        e.preventDefault();
        onSelectNode(focusNodeId);
        return;
      }
      const order = timelineOn
        ? (timeline?.nodeOrder ?? [])
        : positioned
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
  }, [onSelectNode, focusNodeId, positioned, timelineOn, timeline]);

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
      <div className={timelineOn ? "flex min-w-0 flex-1 flex-col" : "relative min-w-0 flex-1"}>
        {/* Timeline mode keeps the header in flow so scrolled rows never slide under it. */}
        <div className={timelineOn ? "flex shrink-0 items-start justify-between gap-4 px-5 pt-4 pb-3" : "contents"}>
        <div className={timelineOn ? "min-w-0 max-w-[60%]" : "absolute top-4 left-5 z-10 max-w-[60%]"}>
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
        <div className={timelineOn ? "flex shrink-0 flex-col items-end gap-2" : "absolute top-4 right-4 z-10 flex flex-col items-end gap-2"}>
          <div className="flex items-center gap-2">
            <CopyActions id={correlationId} idLabel="correlation id" />
            <Tabs
              label="Chain view"
              active={mode}
              onSelect={(id) => setMode(id as ChainViewMode)}
              tabs={[
                { id: "graph", label: "Graph", title: "Instance graph — t toggles" },
                { id: "timeline", label: "Timeline", title: "Chronological narrative — t toggles" },
              ]}
            />
            {!timelineOn && positioned && graph && graph.nodes.length > 0 && (
              <Button onClick={() => setLayoutEpoch((n) => n + 1)}>Reset layout</Button>
            )}
          </div>
          {!timelineOn && positioned && graph && graph.nodes.length > 0 && (
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
        </div>
        {timelineOn ? (
          <ChainTimelineList
            listRef={timelineListRef}
            timeline={timeline}
            focusNodeId={focusNodeId}
            emptyCopy={notFound ? emptyCopy : chainQ.isPending ? "Loading chain…" : chainQ.isError ? emptyCopy : null}
            onSelectNode={onSelectNode}
            onJumpEvent={onJumpEvent}
            onJumpProposal={onJumpProposal}
            onJumpAgent={onJumpAgent}
            onOpenRunFull={onOpenRunFull}
          />
        ) : positioned && graph && graph.nodes.length > 0 ? (
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
              {timelineOn ? "Show in timeline" : "Show on canvas"}{" "}
              <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">z</span>
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
                {selected.run.reasonCode && (
                  <KV
                    k="reason"
                    v={
                      <span title={selected.run.reasonCode}>
                        {humanizeRunReason(selected.run.reasonCode)?.text ?? selected.run.reasonCode}
                      </span>
                    }
                  />
                )}
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

/**
 * Timeline mode (WM-639): one vertical list, oldest first, one row per step —
 * `HH:MM:SS · +Δ · [badge] · actor · what` — reusing the run Lifecycle row
 * grammar so the chain reads like the run detail the operator already knows.
 */
function ChainTimelineList({
  listRef,
  timeline,
  focusNodeId,
  emptyCopy,
  onSelectNode,
  onJumpEvent,
  onJumpProposal,
  onJumpAgent,
  onOpenRunFull,
}: {
  listRef: React.MutableRefObject<HTMLOListElement | null>;
  timeline: ChainTimeline | null;
  focusNodeId: string | null;
  emptyCopy: string | null;
  onSelectNode: (id: string | null) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpAgent: (ref: string) => void;
  onOpenRunFull: (runId: string) => void;
}) {
  if (!timeline) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-(--text-faint)">
        {emptyCopy ?? "Loading chain…"}
      </div>
    );
  }
  const rows = timeline.rows;
  const refLink = (ref: TimelineRef, rowNodeId: string | null) => {
    switch (ref.kind) {
      case "event":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} onClick={() => onJumpEvent(ref.source ?? "", ref.id)} title={`Open in Events · ${ref.id}`}>
            event ↗
          </JumpLink>
        );
      case "run":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} onClick={() => onOpenRunFull(ref.id)} title={`Open run · ${ref.id}`}>
            {ref.label} ↗
          </JumpLink>
        );
      case "proposal":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} onClick={() => onJumpProposal(ref.id)} title={`Open proposal · ${ref.id}`}>
            proposal ↗
          </JumpLink>
        );
      case "agent":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} onClick={() => onJumpAgent(ref.id)} title="Open in Agents">
            {ref.label}
          </JumpLink>
        );
      case "pr":
        return ref.href ? (
          <a
            key={`${ref.kind}:${ref.id}`}
            href={ref.href}
            target="_blank"
            rel="noreferrer"
            className="mono hover:text-(--accent)"
            title={ref.href}
            onClick={(e) => e.stopPropagation()}
          >
            {ref.label} ↗
          </a>
        ) : null;
      case "ticket":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} href={`#/tickets/${encodeURIComponent(ref.id)}`} title={`Open ticket journey ${ref.id}`}>
            {ref.label}
          </JumpLink>
        );
      case "schedule":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} href={`#/schedules/${encodeURIComponent(ref.id)}`} title={`Open schedule ${ref.id}`}>
            schedule ↗
          </JumpLink>
        );
      case "inbox":
        return (
          <JumpLink key={`${ref.kind}:${ref.id}`} href={`#/inbox/${encodeURIComponent(ref.id)}`} title={ref.label}>
            inbox: {ref.label} ↗
          </JumpLink>
        );
      default:
        return rowNodeId ? null : null;
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 pt-1 pb-10">
      {rows.length === 0 ? (
        <div className="text-[12px] text-(--text-faint)">{emptyCopy ?? "No steps recorded for this chain yet."}</div>
      ) : (
        <ol ref={listRef} className="m-0 max-w-5xl list-none p-0" aria-label="Chain timeline">
          {rows.map((row, i) => {
            const hue = huesFor(row)[row.badge] ?? "var(--hue-idle)";
            const selected = row.nodeId != null && row.nodeId === focusNodeId;
            const time = rowTime(row.at);
            const clickable = row.nodeId != null;
            return (
              <li
                key={row.id}
                data-node-id={row.nodeId ?? undefined}
                data-row-kind={row.kind}
                aria-current={selected ? "true" : undefined}
                onClick={clickable ? () => onSelectNode(row.nodeId) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onSelectNode(row.nodeId);
                        }
                      }
                    : undefined
                }
                tabIndex={clickable ? 0 : undefined}
                className={`flex gap-2.5 rounded px-1.5 py-1 ${clickable ? "cursor-pointer hover:bg-(--surface-2)" : ""} ${
                  selected ? "bg-(--surface-2) ring-1 ring-(--accent)" : ""
                } ${row.muted ? "opacity-80" : ""}`}
              >
                <span className="mono w-[62px] shrink-0 pt-0.5 text-[11px] tabular-nums text-(--text-faint)" title={row.at ?? undefined}>
                  {time}
                </span>
                <span className="mono w-[52px] shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-(--text-faint)">
                  {row.kind === "next" ? "" : formatDelta(row.deltaMs)}
                </span>
                <span className="relative flex w-2 shrink-0 justify-center" aria-hidden="true">
                  {i < rows.length - 1 && <span className="absolute top-2.5 bottom-[-6px] w-px bg-(--border)" />}
                  <span className="relative mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: hue }} />
                </span>
                <span className="flex min-w-0 flex-1 items-start gap-x-2">
                  <span className="flex w-[100px] shrink-0 items-center">
                    <StateBadge state={row.badge} hues={huesFor(row)} dot={false} />
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[11.5px] leading-relaxed text-(--text-dim)">
                    {row.actor && <span className="mono text-(--text)">{row.actor}</span>}
                    {row.actor && (row.what || row.reason) ? " · " : ""}
                    {row.what && <span className={row.kind === "next" ? "text-(--text-faint)" : ""}>{row.what}</span>}
                    {row.what && row.reason ? " · " : ""}
                    {row.reason && (
                      <span className="text-(--text-faint)" title={row.reason.raw}>
                        {row.reason.text}
                      </span>
                    )}
                    {row.refs.length > 0 && (
                      <span className="ml-2 inline-flex flex-wrap gap-x-2 text-[11px] text-(--text-faint)">
                        {row.refs.map((ref) => refLink(ref, row.nodeId))}
                      </span>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {timeline.partial && (
        <div className="mt-3 text-[11px] text-(--text-faint)">Loading run lifecycles…</div>
      )}
    </div>
  );
}

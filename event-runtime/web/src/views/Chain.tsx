import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "../api";
import { keyGuard, refetchIntervals, useNow } from "../hooks";
import { hashSearch } from "../hash";
import {
  buildChainGraph,
  eventNodeId,
  runNodeId,
  type ChainGraph,
  type ChainNode,
} from "../graph/chainModel";
import {
  CHAIN_EDGE_STYLES,
  chainNodeAccessibleName,
} from "../graph/chainNodes";
import { handleStyle, Line } from "../graph/nodes";
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
import { ChainStateBar } from "../components/ChainStateBar";
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
  ago,
  shortId,
} from "../components/ui";
import type { RunDetail } from "../types";

const EventPanel = lazy(() =>
  import("../components/ArtifactView").then((module) => ({
    default: module.EventPanel,
  })),
);

// React Flow treats a unitless number as a ratio; the ticket's 24 means px.
const FIT_PADDING = "24px" as const;

function ChainNodeShell({
  children,
  accent,
  selected,
  accessibleName,
  title,
}: {
  children: React.ReactNode;
  accent: string;
  selected?: boolean;
  accessibleName: string;
  title: string;
}) {
  return (
    <div
      className="rounded-md px-3 py-2 text-left"
      tabIndex={0}
      role="button"
      aria-label={accessibleName}
      aria-selected={selected ? true : false}
      aria-pressed={selected ? true : false}
      title={title}
      style={{
        width: 236,
        height: 92,
        background: selected ? "var(--surface-2)" : "var(--surface-1)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${accent}`,
        boxShadow: selected ? "0 0 0 2px var(--accent)" : "none",
      }}
    >
      {children}
    </div>
  );
}

/** Chain cards put the distinguishing subject before shared ids and type. */
export function ChainEventNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<ChainNode, { kind: "chainEvent" }>;
  const ordinal = (data as { ordinal?: number }).ordinal;
  const event = node.event;
  const accent = EVENT_STATUS_HUES[event.status] ?? "var(--hue-idle)";
  const now = Number((data as { now?: number }).now ?? Date.now());
  const subject = event.subject ?? "—";
  return (
    <ChainNodeShell
      accent={accent}
      selected={selected}
      accessibleName={chainNodeAccessibleName(node)}
      title={event.eventId}
    >
      {!node.root && (
        <Handle type="target" position={Position.Left} style={handleStyle} />
      )}
      <div className="flex items-center justify-between gap-1">
        <span
          className="text-xs tracking-wide uppercase"
          style={{ color: accent }}
        >
          {node.root ? "origin event" : "event"} · {event.source}
        </span>
        <StateBadge state={event.status} hues={EVENT_STATUS_HUES} dot={false} />
      </div>
      <div className="mono truncate text-[12px]" title={subject}>
        {subject}
        {ordinal ? ` #${ordinal}` : ""}
      </div>
      <Line dim>{event.type}</Line>
      <Line dim>
        <span title={event.admittedAt}>{ago(event.admittedAt, now)}</span>
        {event.repos.length ? ` · ${event.repos.join(", ")}` : ""}
      </Line>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </ChainNodeShell>
  );
}

export function ChainRunNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<ChainNode, { kind: "chainRun" }>;
  const run = node.run;
  const accent = STATE_HUES[run.state] ?? "var(--hue-idle)";
  const now = Number((data as { now?: number }).now ?? Date.now());
  const when = run.finishedAt ?? run.startedAt ?? run.created_at;
  return (
    <ChainNodeShell
      accent={accent}
      selected={selected}
      accessibleName={chainNodeAccessibleName(node)}
      title={run.runId}
    >
      {!node.root && (
        <Handle type="target" position={Position.Left} style={handleStyle} />
      )}
      <div className="flex items-center justify-between gap-1">
        <span
          className="text-xs tracking-wide uppercase"
          style={{ color: accent }}
        >
          run{run.adapter ? ` · ${run.adapter}` : ""}
        </span>
        <StateBadge state={run.state} />
      </div>
      <div className="mono truncate text-[12px]" title={run.agent ?? run.runId}>
        {run.agent ?? "—"}
      </div>
      <Line dim>
        <span title={run.runId}>{shortId(run.runId)}</span>
        {run.attempts > 1 ? ` · attempt ${run.attempts}` : ""}
        {run.reasonCode ? ` · ${run.reasonCode}` : ""}
      </Line>
      <Line dim>
        <span title={when}>{ago(when, now)}</span>
        {run.repos.length ? ` · ${run.repos.join(", ")}` : ""}
      </Line>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </ChainNodeShell>
  );
}

const chainNodeTypes = { chainEvent: ChainEventNode, chainRun: ChainRunNode };

const TIMELINE_DECISION_HUES: Record<string, string> = {
  ...DECISION_HUES,
  planned: DECISION_HUES.run,
};
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
  return Number.isNaN(t.getTime())
    ? at
    : t.toLocaleTimeString([], { hour12: false });
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
      strokeDasharray: (
        CHAIN_EDGE_STYLES[edge.kind] as { strokeDasharray?: string }
      ).strokeDasharray,
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
    ...refetchIntervals.primary,
    retry: (count, err) =>
      !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    enabled: Boolean(focusNodeId),
    ...refetchIntervals.secondary,
  });
  const now = useNow();
  const notFound =
    chainQ.isError &&
    chainQ.error instanceof ApiError &&
    chainQ.error.status === 404;

  const graph = useMemo(
    () => (chainQ.data ? buildChainGraph(chainQ.data) : null),
    [chainQ.data],
  );

  // Graph | Timeline (WM-639). `?view=` on a deep link wins for this visit;
  // the toggle itself persists like the other display options.
  const [mode, setModeState] = useState<ChainViewMode>(
    () =>
      chainViewModeFromQuery(hashSearch(window.location.hash)) ??
      loadChainViewMode(),
  );
  const setMode = useCallback((next: ChainViewMode) => {
    saveChainViewMode(next);
    setModeState(next);
  }, []);
  // `?node=` is the timeline's deep-link spelling of the path segment; lift it
  // into the selection so the row highlights and Enter opens the pane.
  const deepLinkNodeRef = useRef<string | null>(
    hashSearch(window.location.hash).get("node"),
  );
  useEffect(() => {
    const node = deepLinkNodeRef.current;
    if (!node || focusNodeId) return;
    deepLinkNodeRef.current = null;
    onSelectNode(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timelineOn = mode === "timeline";
  const runIds = useMemo(
    () => (chainQ.data?.runs ?? []).map((r) => r.runId),
    [chainQ.data],
  );
  const runQs = useQueries({
    queries: runIds.map((id) => ({
      queryKey: ["run", id],
      queryFn: () => api.run(id),
      enabled: timelineOn,
      ...refetchIntervals.fast,
      retry: 1,
    })),
  });
  const proposalsQ = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    enabled: timelineOn,
    ...refetchIntervals.secondary,
  });
  const schedulesQ = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    enabled: timelineOn,
    ...refetchIntervals.secondary,
  });
  const inboxQ = useQuery({
    queryKey: ["inbox", "open"],
    queryFn: () => api.inbox("open"),
    enabled: timelineOn,
    ...refetchIntervals.secondary,
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
    [
      timelineOn,
      chainQ.data,
      runDetails,
      proposalsQ.data,
      schedulesQ.data,
      inboxQ.data,
      now,
    ],
  );

  const [positioned, setPositioned] = useState<{
    nodes: Node[];
    edges: Edge[];
    epoch: number;
  } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const lastIdentityRef = useRef<string | null>(null);
  const epochLaidOutRef = useRef(0);
  const flowRef = useRef<{
    getZoom: () => number;
    fitView: (opts: {
      nodes?: Array<{ id: string }>;
      padding?: number | `${number}px`;
      duration?: number;
      minZoom?: number;
      maxZoom?: number;
    }) => void;
  } | null>(null);
  const [flowReady, setFlowReady] = useState(0);
  const lastFittedNodeCountRef = useRef(0);
  const lastFittedLayoutEpochRef = useRef(-1);

  // Reset canvas state when the operator moves to another chain.
  useEffect(() => {
    setPositioned(null);
    flowRef.current = null;
    lastIdentityRef.current = null;
    lastFittedNodeCountRef.current = 0;
    lastFittedLayoutEpochRef.current = -1;
  }, [correlationId]);
  // The canvas unmounts in timeline mode; fit it again when it comes back.
  useEffect(() => {
    if (timelineOn) {
      flowRef.current = null;
      lastFittedNodeCountRef.current = 0;
      lastFittedLayoutEpochRef.current = -1;
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
      .then(
        ({
          CHAIN_LAYOUT_OPTIONS,
          layoutGraph,
          layoutGraphIfIdentityChanged,
          NODE_HEIGHT,
          NODE_WIDTH,
        }) => {
          const prevIdentity =
            layoutEpoch !== epochLaidOutRef.current
              ? null
              : lastIdentityRef.current;
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
                      nodes: prev.nodes.map((n) => ({
                        ...n,
                        data: { ...n.data, node: byId.get(n.id) },
                      })),
                      edges: flowEdges(graph),
                      epoch: prev.epoch,
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
              epoch: layoutEpoch,
            });
          });
        },
      )
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("chain layout failed", err);
        setLayoutError(
          "Could not lay out the chain — the layout engine failed or timed out.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [graph, layoutEpoch]);

  const eventOrdinals = useMemo(() => {
    const groups = new Map<string, ChainNode[]>();
    for (const node of graph?.nodes ?? []) {
      if (node.kind !== "chainEvent") continue;
      const key = `${node.event.type}\u0000${node.event.subject ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), node]);
    }
    const ordinals = new Map<string, number>();
    for (const siblings of groups.values()) {
      if (siblings.length < 2) continue;
      siblings.forEach((node, index) => ordinals.set(node.id, index + 1));
    }
    return ordinals;
  }, [graph]);

  const nodes = useMemo(
    () =>
      positioned
        ? positioned.nodes.map((n) => ({
            ...n,
            selected: n.id === focusNodeId,
            data: { ...n.data, now, ordinal: eventOrdinals.get(n.id) },
          }))
        : [],
    [positioned, focusNodeId, now, eventOrdinals],
  );

  const selected: ChainNode | undefined = graph?.nodes.find(
    (n) => n.id === focusNodeId,
  );
  const selectedEnvelope = useMemo(() => {
    if (selected?.kind !== "chainEvent") return null;
    if (selected.event.envelopeMalformed) return null;
    return selected.event.envelope ?? null;
  }, [selected]);

  const timelineListRef = useRef<HTMLOListElement | null>(null);
  const revealSelected = () => {
    if (!focusNodeId) return;
    if (timelineOn) {
      const rows =
        timelineListRef.current?.querySelectorAll<HTMLElement>(
          "[data-node-id]",
        ) ?? [];
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
    flowRef.current.fitView({
      nodes: [{ id: focusNodeId }],
      padding: 0.45,
      duration: 180,
      minZoom: zoom,
      maxZoom: zoom,
    });
  };

  useEffect(() => {
    if (!flowRef.current || !positioned || positioned.nodes.length === 0)
      return;
    const addedNodes = positioned.nodes.length > lastFittedNodeCountRef.current;
    const resetCompleted = positioned.epoch > lastFittedLayoutEpochRef.current;
    if (!addedNodes && !resetCompleted) return;
    const flow = flowRef.current;
    // Selection reveal runs in the same commit. Fit on the next frame so the
    // whole-chain viewport wins after the pane has taken its final width.
    const frame = requestAnimationFrame(() => {
      // React Flow remounts when a route change briefly clears positioned
      // nodes. Leave the fit pending if this frame still holds the old flow.
      if (flowRef.current !== flow) return;
      flow.fitView({ padding: FIT_PADDING });
      lastFittedNodeCountRef.current = positioned.nodes.length;
      lastFittedLayoutEpochRef.current = positioned.epoch;
    });
    return () => cancelAnimationFrame(frame);
  }, [positioned, flowReady]);

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
      if (selected) {
        if (selected.kind === "chainRun") {
          if (e.key === "o" || e.key === "Enter") {
            e.preventDefault();
            onOpenRunFull(selected.run.runId);
            return;
          }
          if (e.key === "r") {
            e.preventDefault();
            onJumpRun(selected.run.runId);
            return;
          }
        } else if (selected.kind === "chainEvent") {
          if (e.key === "e") {
            e.preventDefault();
            onJumpEvent(selected.event.source, selected.event.eventId);
            return;
          }
        }
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
              .sort(
                (a, b) =>
                  a.position.x - b.position.x || a.position.y - b.position.y,
              )
              .map((n) => n.id)
          : [];
      if (!order.length) return;
      if (e.key === "j" || e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : -1;
        onSelectNode(order[Math.min(idx + 1, order.length - 1)]);
      } else if (
        e.key === "k" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowLeft"
      ) {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : order.length;
        onSelectNode(order[Math.max(idx - 1, 0)]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onSelectNode,
    focusNodeId,
    positioned,
    timelineOn,
    timeline,
    selected,
    onOpenRunFull,
    onJumpRun,
    onJumpEvent,
  ]);

  const eventCount =
    graph?.nodes.filter((n) => n.kind === "chainEvent").length ?? 0;
  const runCount =
    graph?.nodes.filter((n) => n.kind === "chainRun").length ?? 0;
  const runStateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of graph?.nodes ?? []) {
      if (n.kind === "chainRun")
        counts[n.run.state] = (counts[n.run.state] ?? 0) + 1;
    }
    return counts;
  }, [graph]);

  const emptyCopy = notFound
    ? `No chain with correlation id ${correlationId} on this runtime.`
    : chainQ.isPending
      ? "Loading chain…"
      : chainQ.isError
        ? "Cannot reach the control API — the chain will appear when /chain is up."
        : (layoutError ?? "Laying out the chain…");

  return (
    <div className="flex h-full min-w-0">
      <div
        className={
          timelineOn
            ? "flex min-w-0 flex-1 flex-col"
            : "relative min-w-0 flex-1"
        }
      >
        {/* Timeline mode keeps the header in flow so scrolled rows never slide under it. */}
        <div
          className={
            timelineOn
              ? "flex shrink-0 items-start justify-between gap-4 px-5 pt-4 pb-3"
              : "contents"
          }
        >
          <div
            className={
              timelineOn
                ? "min-w-0 max-w-[60%]"
                : "absolute top-4 left-5 z-10 max-w-[60%]"
            }
          >
            <h1 className="display text-h1 font-semibold">Chain</h1>
            {graph && (
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-(--text-dim)">
                <span className="mono min-w-0 truncate" title={correlationId}>
                  {correlationId}
                </span>
                <span className="shrink-0">
                  · {eventCount} event{eventCount === 1 ? "" : "s"} · {runCount}{" "}
                  run{runCount === 1 ? "" : "s"} · {graph.maxDepth} hop
                  {graph.maxDepth === 1 ? "" : "s"}
                </span>
                <ChainStateBar states={runStateCounts} runCount={runCount} />
              </div>
            )}
          </div>
          <div
            className={
              timelineOn
                ? "flex shrink-0 flex-col items-end gap-2"
                : "absolute top-4 right-4 z-10 flex flex-col items-end gap-2"
            }
          >
            <div className="flex items-center gap-2">
              <CopyActions id={correlationId} idLabel="correlation id" />
              <Tabs
                label="Chain view"
                active={mode}
                onSelect={(id) => setMode(id as ChainViewMode)}
                tabs={[
                  {
                    id: "graph",
                    label: "Graph",
                    title: "Instance graph — t toggles",
                  },
                  {
                    id: "timeline",
                    label: "Timeline",
                    title: "Chronological narrative — t toggles",
                  },
                ]}
              />
              {!timelineOn && positioned && graph && graph.nodes.length > 0 && (
                <Button onClick={() => setLayoutEpoch((n) => n + 1)}>
                  Reset layout
                </Button>
              )}
            </div>
            {!timelineOn && positioned && graph && graph.nodes.length > 0 && (
              <div
                className="flex flex-col gap-1 rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-2"
                role="img"
                aria-label="Chain legend"
              >
                {(
                  Object.keys(CHAIN_EDGE_STYLES) as Array<
                    keyof typeof CHAIN_EDGE_STYLES
                  >
                ).map((kind) => {
                  const entry = CHAIN_EDGE_STYLES[kind] as {
                    label: string;
                    stroke: string;
                    strokeDasharray?: string;
                  };
                  return (
                    <div
                      key={kind}
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
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {timelineOn ? (
          <ChainTimelineList
            listRef={timelineListRef}
            timeline={timeline}
            focusNodeId={focusNodeId}
            emptyCopy={
              notFound
                ? emptyCopy
                : chainQ.isPending
                  ? "Loading chain…"
                  : chainQ.isError
                    ? emptyCopy
                    : null
            }
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
              const kept = changes.filter(
                (c) => c.type === "position" || c.type === "dimensions",
              );
              if (kept.length === 0) return;
              setPositioned((prev) =>
                prev
                  ? { ...prev, nodes: applyNodeChanges(kept, prev.nodes) }
                  : prev,
              );
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
          title={
            <nav
              className="flex min-w-0 items-center gap-2"
              aria-label="Chain detail breadcrumb"
            >
              <button
                type="button"
                onClick={() => onSelectNode(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to chain"
              >
                Chain
              </button>
              <span className="text-(--text-faint)" aria-hidden="true">
                /
              </span>
              <span
                className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)"
                aria-current="page"
              >
                <StateBadge
                  state={
                    selected.kind === "chainEvent"
                      ? selected.event.status
                      : selected.run.state
                  }
                  hues={
                    selected.kind === "chainEvent"
                      ? EVENT_STATUS_HUES
                      : STATE_HUES
                  }
                />
                <span
                  className="mono truncate"
                  title={
                    selected.kind === "chainEvent"
                      ? selected.event.eventId
                      : selected.run.runId
                  }
                >
                  {shortId(
                    selected.kind === "chainEvent"
                      ? selected.event.eventId
                      : selected.run.runId,
                  )}
                </span>
              </span>
            </nav>
          }
          actions={
            <>
              <Button onClick={revealSelected}>
                {timelineOn ? "Show in timeline" : "Show on canvas"}{" "}
                <span
                  className="mono ml-1 text-(--text-faint)"
                  aria-hidden="true"
                >
                  z
                </span>
              </Button>
              {selected.kind === "chainEvent" ? (
                <Button
                  onClick={() =>
                    onJumpEvent(selected.event.source, selected.event.eventId)
                  }
                >
                  <span>Open in Events</span>
                  <span
                    aria-hidden="true"
                    className="mono ml-1 text-(--text-faint) text-xs"
                  >
                    e
                  </span>
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button onClick={() => onOpenRunFull(selected.run.runId)}>
                    <span>Open run</span>
                    <span
                      aria-hidden="true"
                      className="mono ml-1 text-(--text-faint) text-xs"
                    >
                      o
                    </span>
                  </Button>
                  <Button onClick={() => onJumpRun(selected.run.runId)}>
                    <span>Show in Runs</span>
                    <span
                      aria-hidden="true"
                      className="mono ml-1 text-(--text-faint) text-xs"
                    >
                      r
                    </span>
                  </Button>
                </div>
              )}
            </>
          }
          utility={
            <CopyActions
              id={
                selected.kind === "chainEvent"
                  ? selected.event.eventId
                  : selected.run.runId
              }
              idLabel={selected.kind === "chainEvent" ? "event id" : "run id"}
            />
          }
          close={<Button onClick={() => onSelectNode(null)}>Close</Button>}
        >
          {selected.kind === "chainEvent" && (
            <>
              <Section
                id="chain-event"
                title={selected.root ? "Origin event" : "Event"}
                icons
              >
                <KV k="source" v={selected.event.source} />
                <KV k="type" v={selected.event.type} />
                <KV k="subject" v={selected.event.subject} />
                <KV
                  k="status"
                  v={
                    <StateBadge
                      state={selected.event.status}
                      hues={EVENT_STATUS_HUES}
                    />
                  }
                />
                <KV
                  k="depth"
                  v={`${selected.depth} hop${selected.depth === 1 ? "" : "s"} from origin`}
                />
                <KV
                  k="admittedAt"
                  v={<Ago iso={selected.event.admittedAt} now={now} />}
                />
                <KV
                  k="emitted by run"
                  v={
                    selected.event.causationId ? (
                      <JumpLink
                        onClick={() =>
                          onSelectNode(runNodeId(selected.event.causationId!))
                        }
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
                      <JumpLink
                        onClick={() =>
                          onJumpProposal(selected.event.proposalId!)
                        }
                        title={selected.event.proposalId}
                      >
                        {shortId(selected.event.proposalId)}
                        {selected.event.proposalDecision
                          ? ` · ${selected.event.proposalDecision}`
                          : ""}
                      </JumpLink>
                    ) : null
                  }
                />
                <KV
                  k="run"
                  v={
                    selected.event.runId ? (
                      <JumpLink
                        onClick={() =>
                          onSelectNode(runNodeId(selected.event.runId!))
                        }
                        title={selected.event.runId}
                      >
                        {shortId(selected.event.runId)}
                      </JumpLink>
                    ) : null
                  }
                />
                {selected.event.repos.length > 0 && (
                  <KV k="repos" v={selected.event.repos.join(", ")} />
                )}
              </Section>
              <Section id="chain-envelope" title="Envelope">
                {selectedEnvelope ? (
                  <Suspense
                    fallback={
                      <div className="text-(--text-faint)">
                        Loading event view…
                      </div>
                    }
                  >
                    <EventPanel
                      envelope={selectedEnvelope}
                      agents={agentsQ.data?.agents}
                      runId={selected.event.runId}
                      now={now}
                      onJumpRun={onJumpRun}
                      onJumpChain={(id) => {
                        window.location.hash = `#/chain/${id}`;
                      }}
                      onJumpArtifact={(sha256) => {
                        window.location.hash = `#/artifact/${sha256}`;
                      }}
                    />
                  </Suspense>
                ) : (
                  <div
                    className="text-[12px] text-(--text-faint)"
                    role="status"
                  >
                    Complete envelope unavailable in this chain response.
                  </div>
                )}
              </Section>
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
                      <JumpLink
                        onClick={() => onJumpAgent(selected.run.agent!)}
                        title="Open in Agents"
                      >
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
                        {humanizeRunReason(selected.run.reasonCode)?.text ??
                          selected.run.reasonCode}
                      </span>
                    }
                  />
                )}
                <KV
                  k="depth"
                  v={`${selected.depth} hop${selected.depth === 1 ? "" : "s"} from origin`}
                />
                <KV
                  k="created"
                  v={<Ago iso={selected.run.created_at} now={now} />}
                />
                <KV
                  k="started"
                  v={<Ago iso={selected.run.startedAt} now={now} />}
                />
                <KV
                  k="finished"
                  v={<Ago iso={selected.run.finishedAt} now={now} />}
                />
                <KV
                  k="origin event"
                  v={
                    selected.run.eventSource && selected.run.eventId ? (
                      <JumpLink
                        onClick={() =>
                          onSelectNode(
                            eventNodeId(
                              selected.run.eventSource!,
                              selected.run.eventId!,
                            ),
                          )
                        }
                        title={selected.run.eventId}
                      >
                        {shortId(selected.run.eventId)}
                      </JumpLink>
                    ) : null
                  }
                />
                {selected.run.repos.length > 0 && (
                  <KV k="repos" v={selected.run.repos.join(", ")} />
                )}
              </Section>
            </>
          )}
        </DetailPane>
      )}
    </div>
  );
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
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            onClick={() => onJumpEvent(ref.source ?? "", ref.id)}
            title={`Open in Events · ${ref.id}`}
          >
            event ↗
          </JumpLink>
        );
      case "run":
        return (
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            onClick={() => onOpenRunFull(ref.id)}
            title={`Open run · ${ref.id}`}
          >
            {ref.label} ↗
          </JumpLink>
        );
      case "proposal":
        return (
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            onClick={() => onJumpProposal(ref.id)}
            title={`Open proposal · ${ref.id}`}
          >
            proposal ↗
          </JumpLink>
        );
      case "agent":
        return (
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            onClick={() => onJumpAgent(ref.id)}
            title="Open in Agents"
          >
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
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            href={`#/tickets/${encodeURIComponent(ref.id)}`}
            title={`Open ticket journey ${ref.id}`}
          >
            {ref.label}
          </JumpLink>
        );
      case "schedule":
        return (
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            href={`#/schedules/${encodeURIComponent(ref.id)}`}
            title={`Open schedule ${ref.id}`}
          >
            schedule ↗
          </JumpLink>
        );
      case "inbox":
        return (
          <JumpLink
            key={`${ref.kind}:${ref.id}`}
            href={`#/inbox/${encodeURIComponent(ref.id)}`}
            title={ref.label}
          >
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
        <div className="text-[12px] text-(--text-faint)">
          {emptyCopy ?? "No steps recorded for this chain yet."}
        </div>
      ) : (
        <ol
          ref={listRef}
          className="m-0 max-w-5xl list-none p-0"
          aria-label="Chain timeline"
        >
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
                <span
                  className="mono w-[62px] shrink-0 pt-0.5 text-[11px] tabular-nums text-(--text-faint)"
                  title={row.at ?? undefined}
                >
                  {time}
                </span>
                <span className="mono w-[52px] shrink-0 pt-0.5 text-right text-xs tabular-nums text-(--text-faint)">
                  {row.kind === "next" ? "" : formatDelta(row.deltaMs)}
                </span>
                <span
                  className="relative flex w-2 shrink-0 justify-center"
                  aria-hidden="true"
                >
                  {i < rows.length - 1 && (
                    <span className="absolute top-2.5 bottom-[-6px] w-px bg-(--border)" />
                  )}
                  <span
                    className="relative mt-[7px] size-1.5 shrink-0 rounded-full"
                    style={{ background: hue }}
                  />
                </span>
                <span className="flex min-w-0 flex-1 items-start gap-x-2">
                  <span className="flex w-[100px] shrink-0 items-center">
                    <StateBadge
                      state={row.badge}
                      hues={huesFor(row)}
                      dot={false}
                    />
                  </span>
                  <span className="min-w-0 flex-1 break-words text-sm leading-relaxed text-(--text-dim)">
                    {row.actor && (
                      <span className="mono text-(--text)">{row.actor}</span>
                    )}
                    {row.actor && (row.what || row.reason) ? " · " : ""}
                    {row.what && (
                      <span
                        className={
                          row.kind === "next" ? "text-(--text-faint)" : ""
                        }
                      >
                        {row.what}
                      </span>
                    )}
                    {row.what && row.reason ? " · " : ""}
                    {row.reason && (
                      <span
                        className="text-(--text-faint)"
                        title={row.reason.raw}
                      >
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
        <div className="mt-3 text-[11px] text-(--text-faint)">
          Loading run lifecycles…
        </div>
      )}
    </div>
  );
}

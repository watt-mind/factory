import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ChainNode } from "./chainModel";
import { Line, Shell, handleStyle } from "./nodes";
import { EVENT_STATUS_HUES, STATE_HUES, StateBadge, ago, shortId } from "../components/ui";

// Chain trace nodes (WM-527): the same shell as the capability map so the two
// canvases read as one tool, but every node is an *instance* — an admitted
// event or a run — coloured by its own status rather than by kind.

export const CHAIN_EDGE_STYLES = {
  produced: { label: "event → run", stroke: "var(--border-strong)" },
  emitted: { label: "run emitted event", stroke: "var(--accent)", strokeDasharray: "4 3" },
} as const;

const nowOf = (data: NodeProps["data"]) => Number((data as { now?: number }).now ?? Date.now());

export function chainNodeAccessibleName(node: ChainNode): string {
  if (node.kind === "chainEvent") {
    return `${node.root ? "origin " : ""}event ${node.event.type}, ${node.event.status}`;
  }
  return `run ${node.run.agent ?? node.run.runId}, ${node.run.state}`;
}

export function ChainEventNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<ChainNode, { kind: "chainEvent" }>;
  const e = node.event;
  const accent = EVENT_STATUS_HUES[e.status] ?? "var(--hue-idle)";
  const now = nowOf(data);
  return (
    <Shell accent={accent} selected={selected} accessibleName={chainNodeAccessibleName(node)}>
      {!node.root && <Handle type="target" position={Position.Left} style={handleStyle} />}
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] tracking-wide uppercase" style={{ color: accent }}>
          {node.root ? "origin event" : "event"} · {e.source}
        </span>
        <StateBadge state={e.status} hues={EVENT_STATUS_HUES} dot={false} />
      </div>
      <div className="mono truncate text-[12px]" title={e.type}>
        {e.type}
      </div>
      <Line dim>
        <span title={e.eventId}>{shortId(e.eventId)}</span>
        {e.subject ? ` · ${e.subject}` : ""}
      </Line>
      <Line dim>
        <span title={e.admittedAt}>{ago(e.admittedAt, now)}</span>
        {e.repos.length ? ` · ${e.repos.join(", ")}` : ""}
      </Line>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </Shell>
  );
}

export function ChainRunNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<ChainNode, { kind: "chainRun" }>;
  const r = node.run;
  const accent = STATE_HUES[r.state] ?? "var(--hue-idle)";
  const now = nowOf(data);
  const when = r.finishedAt ?? r.startedAt ?? r.created_at;
  return (
    <Shell accent={accent} selected={selected} accessibleName={chainNodeAccessibleName(node)}>
      {!node.root && <Handle type="target" position={Position.Left} style={handleStyle} />}
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] tracking-wide uppercase" style={{ color: accent }}>
          run{r.adapter ? ` · ${r.adapter}` : ""}
        </span>
        <StateBadge state={r.state} />
      </div>
      <div className="mono truncate text-[12px]" title={r.agent ?? r.runId}>
        {r.agent ?? "—"}
      </div>
      <Line dim>
        <span title={r.runId}>{shortId(r.runId)}</span>
        {r.attempts > 1 ? ` · attempt ${r.attempts}` : ""}
        {r.reasonCode ? ` · ${r.reasonCode}` : ""}
      </Line>
      <Line dim>
        <span title={when}>{ago(when, now)}</span>
        {r.repos.length ? ` · ${r.repos.join(", ")}` : ""}
      </Line>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </Shell>
  );
}

export const chainNodeTypes = {
  chainEvent: ChainEventNode,
  chainRun: ChainRunNode,
};

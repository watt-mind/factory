import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "./model";
import { NODE_STYLES } from "./style";

// Custom nodes: plain components on the app's OKLCH tokens, so the canvas
// reads as part of the tool rather than an embedded diagram widget. Accents
// and dash styles come from ./style so the legend stays truthful (WM-99).

const handleStyle = { background: "var(--border-strong)", width: 6, height: 6, border: "none" };

const searchHitOf = (data: NodeProps["data"]) => Boolean((data as { searchHit?: boolean }).searchHit);

function Shell({
  children,
  accent,
  selected,
  dashed,
  searchHit,
}: {
  children: React.ReactNode;
  accent: string;
  selected?: boolean;
  dashed?: boolean;
  searchHit?: boolean;
}) {
  return (
    <div
      className="rounded-md px-3 py-2 text-left"
      tabIndex={0}
      style={{
        width: 236,
        height: 92,
        background: "var(--surface-1)",
        border: `1px ${dashed ? "dashed" : "solid"} ${selected ? accent : "var(--border)"}`,
        boxShadow: selected ? `0 0 0 1px ${accent}` : "none",
        borderLeft: `3px solid ${accent}`,
        outline: searchHit ? "2px solid var(--accent)" : undefined,
        outlineOffset: searchHit ? 2 : undefined,
      }}
    >
      {children}
    </div>
  );
}

function Line({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <div
      className="mono truncate text-[10.5px]"
      style={{ color: dim ? "var(--text-faint)" : "var(--text-dim)" }}
    >
      {children}
    </div>
  );
}

export function EventTypeNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<GraphNode, { kind: "eventType" }>;
  return (
    <Shell accent={NODE_STYLES.eventType.accent} selected={selected} searchHit={searchHitOf(data)}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="text-[10px] tracking-wide uppercase" style={{ color: NODE_STYLES.eventType.accent }}>
        event type
      </div>
      <div className="mono truncate text-[12px]" title={node.label}>
        {node.label}
      </div>
      <Line dim>dedup: {node.scope.join(" + ") || "—"}</Line>
      <Line dim>ttl: {node.ttl ? `${node.ttl / 60}m` : "—"}</Line>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </Shell>
  );
}

export function AgentNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<GraphNode, { kind: "agent" }>;
  const accent = node.mutating ? NODE_STYLES.agentMutating.accent : NODE_STYLES.agentReadOnly.accent;
  return (
    <Shell accent={accent} selected={selected} searchHit={searchHitOf(data)}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-wide uppercase" style={{ color: accent }}>
          {node.execution === "model" ? "agent · model" : `agent · ${node.execution}`}
        </span>
        {node.mutating && (
          <span
            className="rounded px-1 text-[9.5px] font-semibold tracking-wide uppercase"
            style={{
              color: NODE_STYLES.agentMutating.accent,
              background: `color-mix(in oklch, ${NODE_STYLES.agentMutating.accent} 15%, transparent)`,
            }}
          >
            mutating
          </span>
        )}
      </div>
      <div className="mono truncate text-[12px]" title={node.label}>
        {node.label}
      </div>
      <Line dim>{node.contract}</Line>
      <Line dim>
        {node.execution === "actions"
          ? `${node.actions.length} actions · ${node.hosts.join(", ")}`
          : (node.capabilities.join(", ") || "no declared services")}
      </Line>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </Shell>
  );
}

export function TerminalNode({ data, selected }: NodeProps) {
  const node = data.node as Extract<GraphNode, { kind: "terminal" }>;
  return (
    <Shell
      accent={NODE_STYLES.terminal.accent}
      selected={selected}
      dashed={NODE_STYLES.terminal.dashed}
      searchHit={searchHitOf(data)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="text-[10px] tracking-wide uppercase" style={{ color: "var(--text-faint)" }}>
        terminal
      </div>
      <div className="text-[12px]" style={{ color: "var(--text-dim)" }}>
        {node.label}
      </div>
      <Line dim>{node.reason}</Line>
    </Shell>
  );
}

export const nodeTypes = {
  eventType: EventTypeNode,
  agent: AgentNode,
  terminal: TerminalNode,
};

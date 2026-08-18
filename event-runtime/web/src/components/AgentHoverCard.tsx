import { useQuery } from "@tanstack/react-query";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useMemo,
} from "react";
import { api } from "../api";
import { resolveEntity } from "../entities";
import type { AgentDef } from "../types";
import { HoverCard } from "./HoverCard";
import { JumpLink, StateBadge } from "./ui";
import { Button as PrimitiveButton } from "./ui";

/** Shared empty-value glyph for registry metadata. */
export const EMPTY_VALUE = "—";

/** Compact duration labels match the cadence grammar used by Schedules. */
export function formatDurationSeconds(
  seconds: number | null | undefined,
): string {
  if (seconds == null) return EMPTY_VALUE;
  const remaining = Math.max(0, Math.floor(seconds));
  const units = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const;
  const parts: string[] = [];
  let rest = remaining;
  for (const [size, suffix] of units) {
    const value = Math.floor(rest / size);
    if (value > 0 || (size === 1 && parts.length === 0))
      parts.push(`${value}${suffix}`);
    rest %= size;
  }
  return parts.join(" ");
}

const AGENT_MUTATION_HUES = {
  Mutating: "var(--hue-warn)",
  "Read-only": "var(--text-faint)",
};

/** One mutation-safety badge shared by the Agents table, pane, and hover card. */
export function AgentMutationBadge({ mutating }: { mutating: boolean }) {
  const state = mutating ? "Mutating" : "Read-only";
  return <StateBadge state={state} hues={AGENT_MUTATION_HUES} />;
}

const FOOTER_LINK_CLASS =
  "cursor-pointer text-[11px] font-medium text-(--accent) hover:underline inline-flex items-center gap-1";

export interface AgentHoverCardProps {
  agentRef: string;
  onJumpAgent?: (ref: string) => void;
  children?: ReactNode;
  className?: string;
  title?: string;
}

/**
 * Interactive hover card for an Agent reference (WM-700).
 * Displays agent metadata (version, mutation safety, limits, model, contract,
 * prompt) in the shared `HoverCard` primitive, so it opens on focus as well as
 * hover and answers Escape.
 */
export function AgentHoverCard({
  agentRef,
  onJumpAgent,
  children,
  className,
  title,
}: AgentHoverCardProps) {
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    staleTime: 30_000,
  });

  const agent: AgentDef | undefined = useMemo(() => {
    const list = agentsQ.data?.agents ?? [];
    return list.find((a) => a.ref === agentRef || a.id === agentRef);
  }, [agentsQ.data, agentRef]);

  /** The Agents route for this ref — the fallback target when no jump is wired. */
  const entity = resolveEntity("agent", agentRef);

  const jump = (close: () => void) => (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    close();
    onJumpAgent?.(agentRef);
  };

  return (
    <HoverCard
      label={`Agent ${agentRef}`}
      // A bare ref renders its own JumpLink button; wrapping that in a second
      // tab stop would make every agent cell cost two Tabs.
      focusable={Boolean(children)}
      trigger={({ close }) =>
        children ? (
          <span onClick={jump(close)} className={className}>
            {children}
          </span>
        ) : (
          <JumpLink
            onClick={jump(close)}
            title={title ?? `What is ${agentRef}? Open in Agents`}
            className={className}
          >
            {agentRef}
          </JumpLink>
        )
      }
    >
      {({ close }) => (
        <>
          {/* Header: Agent ref, version, mutation badge */}
          <div className="flex items-start justify-between gap-2 border-b border-(--border) pb-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="mono font-semibold text-(--text) text-[13px] truncate">
                  {agent?.ref ?? agentRef}
                </span>
                {agent?.version !== undefined && (
                  <span className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-xs text-(--text-dim)">
                    v{agent.version}
                  </span>
                )}
              </div>
              {agent?.promptFile && (
                <div
                  className="mt-0.5 mono text-xs text-(--text-faint) truncate"
                  title={agent.promptFile}
                >
                  {agent.promptFile}
                </div>
              )}
            </div>

            {agent && <AgentMutationBadge mutating={agent.mutating} />}
          </div>

          {/* Content metadata */}
          {agent ? (
            <div className="my-2.5 space-y-1.5 text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-(--text-faint)">Model / Tier</span>
                <span className="mono text-(--text-dim) truncate">
                  {agent.model ?? agent.modelTier ?? EMPTY_VALUE}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <span className="text-(--text-faint)">Output Contract</span>
                <span className="mono text-(--text-dim) truncate">
                  {agent.outputContract || EMPTY_VALUE}
                </span>
              </div>

              {/* A registry served mid-migration can omit either block, and a
                  card that throws takes the whole view down with it. */}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-(--text-faint)">Workspace</span>
                <span className="mono text-(--text-dim)">
                  {agent.workspace?.type ?? EMPTY_VALUE}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <span className="text-(--text-faint)">Limits</span>
                <span className="mono text-(--text-dim)">
                  {agent.limits?.timeout_seconds != null
                    ? `${agent.limits.timeout_seconds}s`
                    : EMPTY_VALUE}{" "}
                  timeout · {agent.limits?.attempts ?? EMPTY_VALUE} attempts
                </span>
              </div>

              {agent.capabilities?.services &&
                agent.capabilities.services.length > 0 && (
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-(--text-faint)">Services</span>
                    <span className="mono text-(--text-dim) truncate">
                      {agent.capabilities.services.join(", ")}
                    </span>
                  </div>
                )}

              {agent.eventTypes && agent.eventTypes.length > 0 && (
                <div className="mt-2 pt-2 border-t border-(--border)">
                  <div className="text-(--text-faint) text-xs mb-1 uppercase tracking-wide">
                    Subscribed Events ({agent.eventTypes.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {agent.eventTypes.slice(0, 3).map((et) => (
                      <span
                        key={et.type}
                        className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-xs text-(--text-dim) truncate max-w-[200px]"
                        title={et.type}
                      >
                        {et.type}
                      </span>
                    ))}
                    {agent.eventTypes.length > 3 && (
                      <span className="mono text-xs text-(--text-faint) self-center">
                        +{agent.eventTypes.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-2 text-[11px] text-(--text-faint)">
              {agentsQ.isLoading
                ? "Loading agent definition…"
                : `Agent definition for ${agentRef} not found.`}
            </div>
          )}

          {/* Footer action — a real link when nothing wired a jump handler,
                so the card is never a dead end for keyboard or middle-click. */}
          <div className="mt-2.5 pt-2 border-t border-(--border) flex justify-end">
            {onJumpAgent ? (
              <PrimitiveButton
                bare
                type="button"
                onClick={jump(close)}
                className={FOOTER_LINK_CLASS}
              >
                Open in Agents <span aria-hidden="true">→</span>
              </PrimitiveButton>
            ) : (
              entity && (
                <a
                  href={entity.href}
                  onClick={() => close()}
                  className={FOOTER_LINK_CLASS}
                >
                  Open in Agents <span aria-hidden="true">→</span>
                </a>
              )
            )}
          </div>
        </>
      )}
    </HoverCard>
  );
}

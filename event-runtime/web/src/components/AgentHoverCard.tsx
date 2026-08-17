import { useQuery } from "@tanstack/react-query";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { AgentDef } from "../types";
import { JumpLink } from "./ui";

export interface AgentHoverCardProps {
  agentRef: string;
  onJumpAgent?: (ref: string) => void;
  children?: ReactNode;
  className?: string;
  title?: string;
}

/**
 * Interactive hover card for an Agent reference.
 * Displays agent metadata (version, mutation safety, limits, model, contract, prompt)
 * in a floating portal panel on hover.
 */
export function AgentHoverCard({
  agentRef,
  onJumpAgent,
  children,
  className,
  title,
}: AgentHoverCardProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; placeAbove: boolean }>({
    top: 0,
    left: 0,
    placeAbove: false,
  });
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    staleTime: 30_000,
  });

  const agent: AgentDef | undefined = useMemo(() => {
    const list = agentsQ.data?.agents ?? [];
    return list.find((a) => a.ref === agentRef || a.id === agentRef);
  }, [agentsQ.data, agentRef]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const CARD_WIDTH = 320;
    const CARD_HEIGHT = 220; // approximate estimate
    const margin = 8;

    let left = rect.left;
    if (left + CARD_WIDTH > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - CARD_WIDTH - 12);
    }
    if (left < 12) left = 12;

    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < CARD_HEIGHT + margin && rect.top > CARD_HEIGHT + margin;
    const top = placeAbove
      ? rect.top - margin
      : rect.bottom + margin;

    setCoords({ top, left, placeAbove });
  }, []);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      updatePosition();
      setOpen(true);
    }, 180);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setOpen(false);
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleClick = (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    setOpen(false);
    onJumpAgent?.(agentRef);
  };

  const isMutating = agent?.mutating ?? false;

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline-flex items-center"
      >
        {children ? (
          <span onClick={handleClick} className={className}>
            {children}
          </span>
        ) : (
          <JumpLink
            onClick={handleClick}
            title={title ?? `What is ${agentRef}? Open in Agents`}
            className={className}
          >
            {agentRef}
          </JumpLink>
        )}
      </span>

      {open && typeof document !== "undefined" &&
        createPortal(
          <div
            id={panelId}
            ref={cardRef}
            role="tooltip"
            aria-live="polite"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            style={{
              position: "fixed",
              top: coords.placeAbove ? undefined : `${coords.top}px`,
              bottom: coords.placeAbove ? `${window.innerHeight - coords.top}px` : undefined,
              left: `${coords.left}px`,
              zIndex: 9999,
            }}
            className="w-80 rounded-lg border border-(--border-strong) bg-(--surface-1) p-3.5 shadow-xl text-[12px] text-(--text) select-text transition-opacity duration-150 animate-in fade-in"
          >
            {/* Header: Agent ref, version, mutation badge */}
            <div className="flex items-start justify-between gap-2 border-b border-(--border) pb-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="mono font-semibold text-(--text) text-[13px] truncate">
                    {agent?.ref ?? agentRef}
                  </span>
                  {agent?.version !== undefined && (
                    <span className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-[10px] text-(--text-dim)">
                      v{agent.version}
                    </span>
                  )}
                </div>
                {agent?.promptFile && (
                  <div className="mt-0.5 mono text-[10px] text-(--text-faint) truncate" title={agent.promptFile}>
                    {agent.promptFile}
                  </div>
                )}
              </div>

              {agent && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    color: isMutating ? "var(--hue-err)" : "var(--hue-ok)",
                    background: `color-mix(in oklch, ${isMutating ? "var(--hue-err)" : "var(--hue-ok)"} 12%, transparent)`,
                  }}
                >
                  {isMutating ? "Mutating" : "Read-Only"}
                </span>
              )}
            </div>

            {/* Content metadata */}
            {agent ? (
              <div className="my-2.5 space-y-1.5 text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-(--text-faint)">Model / Tier</span>
                  <span className="mono text-(--text-dim) truncate">
                    {agent.model ?? agent.modelTier ?? "default"}
                  </span>
                </div>

                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-(--text-faint)">Output Contract</span>
                  <span className="mono text-(--text-dim) truncate">
                    {agent.outputContract || "none"}
                  </span>
                </div>

                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-(--text-faint)">Workspace</span>
                  <span className="mono text-(--text-dim)">
                    {agent.workspace.type}
                  </span>
                </div>

                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-(--text-faint)">Limits</span>
                  <span className="mono text-(--text-dim)">
                    {agent.limits.timeout_seconds ? `${agent.limits.timeout_seconds}s timeout` : "600s timeout"} · {agent.limits.attempts ?? 3} attempts
                  </span>
                </div>

                {agent.capabilities?.services && agent.capabilities.services.length > 0 && (
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-(--text-faint)">Services</span>
                    <span className="mono text-(--text-dim) truncate">
                      {agent.capabilities.services.join(", ")}
                    </span>
                  </div>
                )}

                {agent.eventTypes && agent.eventTypes.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-(--border)">
                    <div className="text-(--text-faint) text-[10px] mb-1 uppercase tracking-wide">
                      Subscribed Events ({agent.eventTypes.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {agent.eventTypes.slice(0, 3).map((et) => (
                        <span
                          key={et.type}
                          className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-[10px] text-(--text-dim) truncate max-w-[200px]"
                          title={et.type}
                        >
                          {et.type}
                        </span>
                      ))}
                      {agent.eventTypes.length > 3 && (
                        <span className="mono text-[10px] text-(--text-faint) self-center">
                          +{agent.eventTypes.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-2 text-[11px] text-(--text-faint)">
                {agentsQ.isLoading ? "Loading agent definition…" : `Agent definition for ${agentRef} not found.`}
              </div>
            )}

            {/* Footer action */}
            {onJumpAgent && (
              <div className="mt-2.5 pt-2 border-t border-(--border) flex justify-end">
                <button
                  type="button"
                  onClick={handleClick}
                  className="cursor-pointer text-[11px] font-medium text-(--accent) hover:underline inline-flex items-center gap-1"
                >
                  Open in Agents <span aria-hidden="true">→</span>
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

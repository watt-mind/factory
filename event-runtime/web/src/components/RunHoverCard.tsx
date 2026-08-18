/**
 * Run hover card (WM-702) — the Runs table's answer to "what is this run, and
 * what set it off", without opening the detail pane and losing the list.
 *
 * The list row already knows the agent, state and attempt budget; only the
 * attempt-level duration and the artifacts a run produced need the detail
 * endpoint, so that query sits behind `enabled: open` with a `staleTime`.
 * Sweeping a pointer down a hundred rows must not fetch a hundred run details.
 *
 * The shared pieces — `CausationGlyphs`, `HoverCardAction`, `chainHref` —
 * come from `EventHoverCard`; see the note there on why they live in that file.
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { api } from "../api";
import { resolveEntity } from "../entities";
import { EMPTY, formatDuration } from "../format";
import { runNodeId } from "../graph/chainModel";
import type { RunDetail, RunListItem, RunState } from "../types";
import {
  HOVER_CARD_STALE_MS,
  HoverCardAction,
  HoverCardRow,
  chainHref,
} from "./EventHoverCard";
import { HoverCard } from "./HoverCard";
import { StateBadge, shortId } from "./ui";

const IN_FLIGHT_DURATION_STATES = new Set<RunState>([
  "LEASED",
  "RUNNING",
  "VERIFYING",
]);
const TERMINAL_DURATION_STATES = new Set<RunState>([
  "COMPLETED",
  "REFUSED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
]);

/**
 * Wall-clock time this run has spent executing: first attempt's start to the
 * last one's finish, still ticking while an attempt is open. Before the detail
 * arrives — the common case for the first frame of an open card — the list
 * row's own timestamps carry the same answer to within a poll interval.
 */
export function runDurationSeconds(
  run: RunListItem,
  detail: RunDetail | null | undefined,
  now: number,
): number | null {
  const attempts = detail?.attempts ?? [];
  const at = (value: string | null) => {
    const ms = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  };

  const starts = attempts
    .map((a) => at(a.started_at))
    .filter((ms): ms is number => ms !== null);
  if (starts.length > 0) {
    const finishes = attempts
      .map((a) => at(a.finished_at))
      .filter((ms): ms is number => ms !== null);
    const stillOpen = attempts.some((a) => a.started_at && !a.finished_at);
    const end =
      stillOpen || finishes.length === 0 ? now : Math.max(...finishes);
    return Math.max(0, Math.round((end - Math.min(...starts)) / 1000));
  }

  if (
    !IN_FLIGHT_DURATION_STATES.has(run.state) &&
    !TERMINAL_DURATION_STATES.has(run.state)
  )
    return null;

  const started = at(run.startedAt ?? run.created_at);
  const finished = IN_FLIGHT_DURATION_STATES.has(run.state)
    ? now
    : at(run.updated_at);
  if (started === null || finished === null) return null;
  return Math.max(0, Math.round((finished - started) / 1000));
}

/** Stored outputs this run produced; the pre-`artifacts[]` shape counts as one. */
export function artifactCount(detail: RunDetail | null | undefined): number {
  const result = detail?.result;
  if (!result) return 0;
  if (Array.isArray(result.artifacts)) return result.artifacts.length;
  return result.artifactHash ? 1 : 0;
}

export interface RunOrigin {
  kind: "event" | "schedule" | "none";
  source: string | null;
  eventId: string | null;
}

/**
 * What set this run off. A schedule tick is an admitted event like any other,
 * but calling it "event" hides the only thing an operator wants to know about
 * a run that appeared at 04:00 with nobody at a keyboard.
 */
export function runOrigin(run: RunListItem): RunOrigin {
  const source = run.eventSource ?? null;
  const eventId = run.eventId ?? null;
  if (!source || !eventId) return { kind: "none", source, eventId };
  return {
    kind: source === "schedule" ? "schedule" : "event",
    source,
    eventId,
  };
}

export interface RunHoverCardProps {
  run: RunListItem;
  /**
   * Correlation id of the chain this run belongs to. Resolved by the caller:
   * it lives on the origin event, which the run row does not carry.
   */
  chainId?: string | null;
  /** Open the chain trace, preselecting this run. */
  onJumpChain?: (correlationId: string, nodeId?: string) => void;
  /** Open the full-page run view. */
  onJumpRun?: (runId: string) => void;
  /** Select the run's origin event. */
  onJumpEvent?: (source: string, eventId: string) => void;
  children?: ReactNode;
  className?: string;
}

export function RunHoverCard({
  run,
  chainId,
  onJumpChain,
  onJumpRun,
  onJumpEvent,
  children,
  className,
}: RunHoverCardProps) {
  const [open, setOpen] = useState(false);
  // Read the clock when the card opens, not on every render: an in-flight
  // duration per table row would otherwise want a ticking timer per row.
  const [now, setNow] = useState(() => Date.now());
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setNow(Date.now());
  }, []);

  // Same cache key as the Runs detail pane, so opening a card for the selected
  // run is free and opening the pane afterwards is already warm.
  const detailQ = useQuery({
    queryKey: ["run", run.runId],
    queryFn: () => api.run(run.runId),
    enabled: open,
    staleTime: HOVER_CARD_STALE_MS,
  });

  const detail = detailQ.data;
  const duration = runDurationSeconds(run, detail, now);
  const artifacts = artifactCount(detail);
  const origin = runOrigin(run);
  const originEntity =
    origin.kind === "none"
      ? null
      : resolveEntity("event", origin.eventId, { source: origin.source });
  const runEntity = resolveEntity("run", run.runId);

  return (
    <HoverCard
      label={`Run ${run.runId}`}
      className={className}
      onOpenChange={onOpenChange}
      estimatedHeight={230}
      trigger={<span className="min-w-0 truncate">{children}</span>}
    >
      {({ close }) => (
        <>
          <div className="flex items-start justify-between gap-2 border-b border-(--border) pb-2.5">
            <div className="min-w-0 flex-1">
              <div
                className="mono truncate font-semibold text-(--text) text-[13px]"
                title={run.runId}
              >
                {shortId(run.runId)}
              </div>
              <div className="mt-0.5 truncate text-xs text-(--text-faint)">
                <span className="mono rounded bg-(--surface-2) px-1.5 py-0.5 text-(--text-dim)">
                  {run.agent}
                </span>{" "}
                {run.adapter}
              </div>
            </div>
            <StateBadge state={run.state} />
          </div>

          <div className="my-2.5 space-y-1.5 text-[11px]">
            <HoverCardRow label="Triggered by">
              {origin.kind === "none" ? (
                EMPTY
              ) : (
                <>
                  <span className="font-sans text-(--text-faint)">
                    {origin.kind === "schedule" ? "Schedule" : "Event"}
                  </span>{" "}
                  {origin.source} ·{" "}
                  {originEntity ? (
                    <a
                      href={originEntity.href}
                      title={origin.eventId ?? undefined}
                      className="hover:text-(--accent)"
                      onClick={(e) => {
                        e.stopPropagation();
                        close();
                        if (!onJumpEvent) return;
                        e.preventDefault();
                        onJumpEvent(origin.source!, origin.eventId!);
                      }}
                    >
                      {shortId(origin.eventId!)}
                    </a>
                  ) : (
                    shortId(origin.eventId!)
                  )}
                </>
              )}
            </HoverCardRow>

            <HoverCardRow label="Duration">
              {duration === null ? EMPTY : formatDuration(duration)}
            </HoverCardRow>

            <HoverCardRow label="Attempts">
              {run.attempts}/{run.maxAttempts}
            </HoverCardRow>

            <HoverCardRow label="Output">
              {detailQ.isLoading
                ? "Loading…"
                : `${artifacts} artifact${artifacts === 1 ? "" : "s"}`}
            </HoverCardRow>

            {run.reasonCode && run.reasonCode.toLowerCase() !== "ok" && (
              <HoverCardRow label="Reason">{run.reasonCode}</HoverCardRow>
            )}
          </div>

          <div className="mt-2.5 flex justify-between gap-2 border-t border-(--border) pt-2">
            <HoverCardAction
              href={chainHref(chainId, runNodeId(run.runId))}
              close={close}
              onJump={
                onJumpChain && chainId
                  ? () => onJumpChain(chainId, runNodeId(run.runId))
                  : undefined
              }
            >
              View chain
            </HoverCardAction>
            <HoverCardAction
              href={runEntity?.href ?? null}
              close={close}
              onJump={onJumpRun ? () => onJumpRun(run.runId) : undefined}
            >
              Open run
            </HoverCardAction>
          </div>
        </>
      )}
    </HoverCard>
  );
}

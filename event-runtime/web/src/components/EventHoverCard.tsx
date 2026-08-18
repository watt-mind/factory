/**
 * Event hover card and the causation glyphs that trigger it (WM-702).
 *
 * The Events table answers "what arrived"; it took a navigation away to answer
 * "and why". This card gives the one hop either side of a row — the run that
 * emitted the event, the runs it went on to plan — without leaving the table,
 * and hands off to the chain trace when one hop is not enough.
 *
 * The query lives behind `enabled: open` on purpose: a pointer crossing a
 * hundred rows must cost nothing, and a `staleTime` keeps a second look at the
 * same row off the wire entirely.
 *
 * `CausationGlyphs`, `HoverCardAction` and `chainHref` are shared with
 * `RunHoverCard` and both tables. They live here rather than in a module of
 * their own because WM-702 owns these two card files and the two views, and a
 * third shared file would sit outside that set.
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { api } from "../api";
import { resolveEntity } from "../entities";
import { EMPTY, formatRelative } from "../format";
import { chainKeyOfEvent, eventNodeId } from "../graph/chainModel";
import { hashPath } from "../hash";
import type { AdmittedEvent, RunListItem } from "../types";
import { formatCellValue } from "./CustomCell";
import { HoverCard } from "./HoverCard";
import { EVENT_STATUS_HUES, StateBadge, shortId } from "./ui";

/**
 * How long a card's answer stays good. Long enough that re-hovering a row, or
 * sweeping back up a table, never refetches; short enough that a card opened a
 * minute later is not describing a run that has since finished.
 */
export const HOVER_CARD_STALE_MS = 30_000;

/** Payload keys a card shows before it starts costing more than it explains. */
export const PAYLOAD_KEY_LIMIT = 4;

/** Envelope fields the card's own header already states. */
const ENVELOPE_METADATA = new Set([
  "schemaVersion",
  "eventId",
  "type",
  "source",
  "subject",
  "occurredAt",
  "receivedAt",
  "correlationId",
  "causationId",
  "payload",
]);

const FOOTER_LINK_CLASS =
  "cursor-pointer text-[11px] font-medium text-(--accent) hover:underline inline-flex items-center gap-1";

const ROW_CLASS = "flex items-baseline justify-between gap-2";
const ROW_KEY_CLASS = "shrink-0 text-(--text-faint)";
const ROW_VALUE_CLASS = "mono min-w-0 truncate text-(--text-dim)";

export interface PayloadEntry {
  key: string;
  text: string;
  title?: string;
}

/**
 * The leading few payload keys, rendered in the same grammar as the tables'
 * custom columns (`formatCellValue`) so a value never reads one way in a cell
 * and another in the card describing it.
 *
 * An envelope with no `payload` object still says something — a schedule tick
 * carries its loop and slot at the top level — so the fields the header does
 * not already show stand in for it.
 */
export function payloadSummary(
  envelope: Record<string, unknown> | null | undefined,
  limit: number = PAYLOAD_KEY_LIMIT,
): { entries: PayloadEntry[]; total: number } {
  const raw = envelope?.payload;
  const payload =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const source = payload ?? envelope ?? {};
  const keys = Object.keys(source).filter(
    (key) => payload !== null || !ENVELOPE_METADATA.has(key),
  );
  const entries = keys.slice(0, Math.max(0, limit)).map((key) => {
    const { text, title } = formatCellValue(source[key]);
    return { key, text, title };
  });
  return { entries, total: keys.length };
}

/**
 * The chain trace route, optionally with the node to preselect. Null when
 * nothing names the chain — a link to `#/chain/undefined` is a 404 dressed up
 * as an affordance.
 */
export function chainHref(
  correlationId: string | null | undefined,
  nodeId?: string | null,
): string | null {
  if (!correlationId) return null;
  return `#/${hashPath("chain", correlationId, nodeId)}`;
}

export interface CausationGlyphsProps {
  /** Id of the one thing that caused this row, or null when it is an origin. */
  causedBy: string | null;
  /** How many things this row went on to cause. */
  fanOut: number;
  /** Chain route to open, or null when no correlation id is known. */
  href: string | null;
  /** Tooltip and accessible name — the glyphs themselves say nothing aloud. */
  title: string;
  /** In-app navigation, when the view wires one. Falls back to `href`. */
  onJump?: () => void;
}

/**
 * `↳` for "something caused this", `→ N` for "this caused N things" — the two
 * facts a lineage question starts from, in the width a table cell can spare.
 * Clicking opens the chain with this row already selected, and never selects
 * the row underneath: following a link and changing the selection are two
 * different intents and one click cannot mean both.
 */
export function CausationGlyphs({
  causedBy,
  fanOut,
  href,
  title,
  onJump,
}: CausationGlyphsProps) {
  if (!causedBy && fanOut <= 0) return null;

  const body = (
    <>
      {causedBy && <span aria-hidden="true">↳</span>}
      {fanOut > 0 && (
        <span aria-hidden="true" className="tabular-nums">
          → {fanOut}
        </span>
      )}
    </>
  );
  const className =
    "inline-flex shrink-0 items-center gap-1 text-xs text-(--text-faint)";

  if (!href) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    );
  }

  return (
    <a
      href={href}
      title={title}
      aria-label={title}
      className={`${className} hover:text-(--accent)`}
      onClick={(e) => {
        e.stopPropagation();
        if (!onJump) return;
        e.preventDefault();
        onJump();
      }}
    >
      {body}
    </a>
  );
}

/**
 * A card's footer action. Always a real link so middle-click and copy-address
 * work, and the wired-up navigation only replaces the default when a view has
 * one — a card that is a dead end for the keyboard is half a card.
 */
export function HoverCardAction({
  href,
  onJump,
  close,
  children,
}: {
  href: string | null;
  onJump?: () => void;
  close: () => void;
  children: ReactNode;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      className={FOOTER_LINK_CLASS}
      onClick={(e) => {
        e.stopPropagation();
        close();
        if (!onJump) return;
        e.preventDefault();
        onJump();
      }}
    >
      {children} <span aria-hidden="true">→</span>
    </a>
  );
}

/** One `key   value` line, the shape every hover card states facts in. */
export function HoverCardRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={ROW_CLASS}>
      <span className={ROW_KEY_CLASS}>{label}</span>
      <span className={ROW_VALUE_CLASS}>{children}</span>
    </div>
  );
}

export interface EventHoverCardProps {
  event: AdmittedEvent;
  /** Open the chain trace, preselecting this event. */
  onJumpChain?: (correlationId: string, nodeId?: string) => void;
  /** Select this event in the Events view. */
  onJumpEvent?: (source: string, eventId: string) => void;
  /** Open the run that emitted this event. */
  onJumpRun?: (runId: string) => void;
  children?: ReactNode;
  className?: string;
}

/**
 * Hover card for one admitted event: what it is, who published it, the run
 * that caused it, and the head of its payload.
 */
export function EventHoverCard({
  event,
  onJumpChain,
  onJumpEvent,
  onJumpRun,
  children,
  className,
}: EventHoverCardProps) {
  const [open, setOpen] = useState(false);
  // Read the clock when the card opens, not on every render: a relative
  // timestamp per table row would otherwise want a ticking timer per row.
  const [now, setNow] = useState(() => Date.now());
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setNow(Date.now());
  }, []);
  const causationId = event.causationId ?? null;

  // Shared cache key with the Events and Runs tables, so an open card usually
  // reads a list the view already holds and never touches the network.
  const runsQ = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    enabled: open && causationId !== null,
    staleTime: HOVER_CARD_STALE_MS,
  });

  const cause: RunListItem | null = useMemo(() => {
    if (!causationId) return null;
    return (
      (runsQ.data?.runs ?? []).find((r) => r.runId === causationId) ?? null
    );
  }, [runsQ.data, causationId]);

  const chainId = chainKeyOfEvent(event);
  const nodeId = eventNodeId(event.source, event.eventId);
  const eventEntity = resolveEntity("event", event.eventId, {
    source: event.source,
  });
  const summary = useMemo(
    () => payloadSummary(event.envelope),
    [event.envelope],
  );
  const hidden = summary.total - summary.entries.length;

  return (
    <HoverCard
      label={`Event ${event.eventId}`}
      className={className}
      onOpenChange={onOpenChange}
      estimatedHeight={260}
      trigger={<span className="min-w-0 truncate">{children}</span>}
    >
      {({ close }) => (
        <>
          {/* Header: what happened, and what the planner made of it. */}
          <div className="flex items-start justify-between gap-2 border-b border-(--border) pb-2.5">
            <div className="min-w-0 flex-1">
              <div
                className="truncate font-semibold text-(--text) text-[13px]"
                title={event.type}
              >
                {event.type}
              </div>
              <div className="mono mt-0.5 truncate text-xs text-(--text-faint)">
                {event.source} · {event.eventId}
              </div>
            </div>
            <StateBadge state={event.status} hues={EVENT_STATUS_HUES} />
          </div>

          <div className="my-2.5 space-y-1.5 text-[11px]">
            <HoverCardRow label="Publisher">
              {cause ? `${event.source} · ${cause.agent}` : event.source}
            </HoverCardRow>

            <HoverCardRow label="Occurred">
              <span title={event.occurredAt}>
                {formatRelative(event.occurredAt, now)}
              </span>
            </HoverCardRow>

            {event.subject && (
              <HoverCardRow label="Subject">{event.subject}</HoverCardRow>
            )}

            {/* One hop back: the run that emitted this event, previewed rather
                than merely named — an id alone is another navigation. */}
            <div className="mt-2 border-t border-(--border) pt-2">
              {causationId ? (
                <HoverCardRow label="Caused by">
                  {cause ? (
                    <a
                      href={`#/${hashPath("run", causationId)}`}
                      title={causationId}
                      className="hover:text-(--accent)"
                      onClick={(e) => {
                        e.stopPropagation();
                        close();
                        if (!onJumpRun) return;
                        e.preventDefault();
                        onJumpRun(causationId);
                      }}
                    >
                      {shortId(causationId)} · {cause.agent} · {cause.state}
                    </a>
                  ) : (
                    <span title={causationId}>
                      {runsQ.isLoading
                        ? "Loading…"
                        : `${shortId(causationId)} ${EMPTY}`}
                    </span>
                  )}
                </HoverCardRow>
              ) : (
                <div className="text-[11px] text-(--text-faint)">
                  No causation — this event starts this chain.
                </div>
              )}
            </div>

            {summary.entries.length > 0 && (
              <div className="mt-2 border-t border-(--border) pt-2">
                <div className="mb-1 text-xs uppercase tracking-wide text-(--text-faint)">
                  Payload
                </div>
                <div className="space-y-1">
                  {summary.entries.map((entry) => (
                    <div key={entry.key} className={ROW_CLASS}>
                      <span className={`mono ${ROW_KEY_CLASS}`}>
                        {entry.key}
                      </span>
                      <span className={ROW_VALUE_CLASS} title={entry.title}>
                        {entry.text}
                      </span>
                    </div>
                  ))}
                  {hidden > 0 && (
                    <div className="text-xs text-(--text-faint)">
                      +{hidden} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="mt-2.5 flex justify-between gap-2 border-t border-(--border) pt-2">
            <HoverCardAction
              href={chainHref(chainId, nodeId)}
              close={close}
              onJump={
                onJumpChain ? () => onJumpChain(chainId, nodeId) : undefined
              }
            >
              View chain
            </HoverCardAction>
            <HoverCardAction
              href={eventEntity?.href ?? null}
              close={close}
              onJump={
                onJumpEvent
                  ? () => onJumpEvent(event.source, event.eventId)
                  : undefined
              }
            >
              Open event
            </HoverCardAction>
          </div>
        </>
      )}
    </HoverCard>
  );
}

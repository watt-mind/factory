import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { humanizeReason } from "../reasons";
import type { AdmittedEvent, Proposal, RunListItem } from "../types";
import {
  DECISION_HUES,
  DisclosureChevron,
  EVENT_STATUS_HUES,
  JumpLink,
  Section,
  StateBadge,
  ago,
  shortId,
} from "./ui";
import {
  ReasonText,
  eventTicket,
  hashHref,
  ticketIdOf,
} from "./RunDetailBlocks";
import { Button as PrimitiveButton } from "./ui";

/**
 * The per-ticket "why isn't this running?" answer (WM-594). Split out of
 * RunDetailBlocks and fetched on demand: the entry chunk is budgeted
 * (vite.config.ts) and only a pane that names a ticket ever needs this.
 */
/** One planner (or dispatch-gate) decision about a ticket, in the order it was made. */
export interface TicketDecision {
  at: string;
  /** `planned` / `noop` / `human_needed` for proposals; `refused` for a REFUSED run; the event status otherwise. */
  outcome: string;
  /** Proposal status when the decision was a proposal (`open`, `approved`, `rejected`, …). */
  status: string | null;
  /** The raw reason code; humanize with `humanizeReason`. */
  reason: string | null;
  event: { source: string; eventId: string; type: string } | null;
  proposalId: string | null;
  runId: string | null;
}

const OUTCOME_HUES: Record<string, string> = {
  ...EVENT_STATUS_HUES,
  ...DECISION_HUES,
  planned: "var(--hue-ok)",
  refused: "var(--hue-warn)",
};

/**
 * Every decision the planner made about one ticket, oldest first, joined on
 * the client from what the views already fetch: events naming the ticket
 * (subject / payload.ticket), proposals attached to those events or whose spec
 * input names it, and the runs those proposals opened. A REFUSED run counts as
 * a decision too — the dispatch gate said no after the planner said yes.
 */
export function buildTicketDecisions(
  ticket: string,
  data: {
    events: readonly AdmittedEvent[];
    proposals: readonly Proposal[];
    runs: readonly RunListItem[];
  },
): TicketDecision[] {
  const T = ticket.toUpperCase();
  const eventKey = (
    source: string | null | undefined,
    id: string | null | undefined,
  ) => `${source}:${id}`;
  const events = new Map<string, AdmittedEvent>();
  for (const e of data.events)
    if (eventTicket(e) === T) events.set(eventKey(e.source, e.eventId), e);

  const proposals = data.proposals.filter((p) => {
    if (events.has(eventKey(p.eventSource, p.eventId))) return true;
    const input = (p.spec?.input ?? null) as Record<string, unknown> | null;
    return ticketIdOf(input?.ticket) === T;
  });
  // A proposal whose spec names the ticket links its event even when the event
  // itself does not (a chain event carrying only the proposal's payload).
  const eventById = new Map(
    data.events.map((e) => [eventKey(e.source, e.eventId), e]),
  );
  for (const p of proposals) {
    const k = eventKey(p.eventSource, p.eventId);
    const e = eventById.get(k);
    if (e && !events.has(k)) events.set(k, e);
  }

  // Only runs this ticket's planner opened: a noop proposal's runId can be
  // the *blocking* run of another ticket (`ticket_dispatch_already_live`).
  const runIds = new Set(
    proposals
      .filter((p) => p.decision === "run")
      .map((p) => p.runId)
      .filter((id): id is string => !!id),
  );
  const runs = data.runs.filter(
    (r) =>
      runIds.has(r.runId) || events.has(eventKey(r.eventSource, r.eventId)),
  );

  const decisions: TicketDecision[] = [];
  const decidedEvents = new Set(
    proposals.map((p) => eventKey(p.eventSource, p.eventId)),
  );
  for (const p of proposals) {
    const e = eventById.get(eventKey(p.eventSource, p.eventId));
    decisions.push({
      at: p.created_at,
      outcome: p.decision === "run" ? "planned" : p.decision,
      status: p.status,
      reason: p.reason,
      event: e ? { source: e.source, eventId: e.eventId, type: e.type } : null,
      proposalId: p.id,
      runId: p.runId,
    });
  }
  // An event the planner has not (or could not) turn into a proposal is still
  // an answer: admitted = still waiting, dead_lettered = the plan error.
  for (const [k, e] of events) {
    if (decidedEvents.has(k)) continue;
    decisions.push({
      at: e.admittedAt,
      outcome: e.status,
      status: null,
      reason: e.lastPlanError,
      event: { source: e.source, eventId: e.eventId, type: e.type },
      proposalId: e.proposalId,
      runId: e.runId,
    });
  }
  for (const r of runs) {
    if (r.state !== "REFUSED") continue;
    decisions.push({
      at: r.updated_at,
      outcome: "refused",
      status: null,
      reason: r.reasonCode,
      event:
        r.eventSource && r.eventId
          ? { source: r.eventSource, eventId: r.eventId, type: "" }
          : null,
      proposalId: null,
      runId: r.runId,
    });
  }
  return decisions.sort((a, b) => a.at.localeCompare(b.at));
}

/** `noop · Owned paths overlap · 3m ago` — the one line an operator reads first. */
export function decisionHeadline(d: TicketDecision, now: number): string {
  const reason = humanizeReason(d.reason).text;
  const status =
    d.outcome === "planned" && d.status && d.status !== "approved"
      ? ` (${d.status})`
      : "";
  return `${d.outcome}${status}${reason ? ` · ${reason}` : ""} · ${ago(d.at, now)}`;
}

/**
 * The per-ticket answer to "why isn't this running?" (WM-594): every planner
 * decision about the ticket, chronologically, collapsed to its latest one.
 * Rendered wherever a ticket id appears in a pane — a run's `input.ticket`, an
 * event's subject. Data comes from the same list queries the views keep warm.
 */
export function TicketDecisions({
  ticket,
  now,
  defaultOpen = false,
  onJumpRun,
  onJumpProposal,
  onJumpEvent,
  onJumpTicket,
}: {
  ticket: string;
  now: number;
  defaultOpen?: boolean;
  onJumpRun?: (runId: string) => void;
  onJumpProposal?: (id: string) => void;
  onJumpEvent?: (source: string, eventId: string) => void;
  onJumpTicket?: (ticketId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const eventsQ = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    staleTime: 5_000,
  });
  const proposalsQ = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    staleTime: 5_000,
  });
  const runsQ = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    staleTime: 5_000,
  });
  const decisions = useMemo(
    () =>
      buildTicketDecisions(ticket, {
        events: eventsQ.data?.events ?? [],
        proposals: proposalsQ.data?.proposals ?? [],
        runs: runsQ.data?.runs ?? [],
      }),
    [ticket, eventsQ.data, proposalsQ.data, runsQ.data],
  );
  const loading = eventsQ.isPending || proposalsQ.isPending || runsQ.isPending;
  const latest = decisions.at(-1) ?? null;
  const jumpEvent = (source: string, eventId: string) =>
    onJumpEvent
      ? onJumpEvent(source, eventId)
      : (window.location.hash = hashHref("events", source, eventId));

  return (
    <Section title="Decisions" id="decisions">
      {loading && !latest ? (
        <div className="py-1 text-[11px] text-(--text-faint)">
          Loading planner decisions…
        </div>
      ) : !latest ? (
        <div className="py-1 text-[11px] text-(--text-faint)">
          No planner decisions recorded for this ticket.
        </div>
      ) : (
        <>
          {/* The headline is the whole answer for most tickets; the list under
              it is the audit trail. Links inside the reason stop propagation,
              so clicking a run id jumps instead of toggling. */}
          <div
            className="flex cursor-pointer items-baseline gap-2 py-1"
            onClick={() => setOpen((o) => !o)}
            title={decisionHeadline(latest, now)}
          >
            <PrimitiveButton
              bare
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} all ${decisions.length} planner decisions for ${ticket}`}
              onClick={(ev) => {
                ev.stopPropagation();
                setOpen((o) => !o);
              }}
              className="flex shrink-0 cursor-pointer items-center gap-2 self-center hover:text-(--text)"
            >
              <DisclosureChevron open={open} />
              <span className="text-[11px] text-(--text-faint)">last:</span>
            </PrimitiveButton>
            <StateBadge
              state={latest.outcome}
              hues={OUTCOME_HUES}
              dot={false}
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-(--text-dim)">
              {latest.outcome === "planned" &&
                latest.status &&
                latest.status !== "approved" && (
                  <span className="text-(--text-faint)">
                    ({latest.status}){" "}
                  </span>
                )}
              <ReasonText
                code={latest.reason}
                onJumpRun={onJumpRun}
                onJumpProposal={onJumpProposal}
                onJumpTicket={onJumpTicket}
              />
              {!latest.reason && latest.outcome === "planned" && (
                <span className="text-(--text-faint)">run proposed</span>
              )}
              {!latest.reason && latest.outcome === "admitted" && (
                <span className="text-(--text-faint)">
                  awaiting the planner
                </span>
              )}
            </span>
            <span
              className="shrink-0 text-[11px] tabular-nums text-(--text-faint)"
              title={latest.at}
            >
              {ago(latest.at, now)}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-(--text-faint)">
              {decisions.length} decision{decisions.length === 1 ? "" : "s"}
            </span>
          </div>
          {open && (
            <ol
              className="m-0 mt-1 list-none border-t border-(--border) p-0 pt-1"
              aria-label={`Planner decisions for ${ticket}`}
            >
              {decisions.map((d, i) => (
                <li
                  key={`${d.proposalId ?? ""}:${d.runId ?? ""}:${d.event?.eventId ?? ""}:${i}`}
                  className="py-1 text-sm"
                >
                  <div className="flex items-baseline gap-2">
                    <span
                      className="mono w-[52px] shrink-0 text-[11px] tabular-nums text-(--text-faint)"
                      title={d.at}
                    >
                      {ago(d.at, now)}
                    </span>
                    <StateBadge
                      state={d.outcome}
                      hues={OUTCOME_HUES}
                      dot={false}
                    />
                    <span className="min-w-0 flex-1 break-words text-(--text-dim)">
                      {d.outcome === "planned" &&
                        d.status &&
                        d.status !== "approved" && (
                          <span className="text-(--text-faint)">
                            ({d.status}){" "}
                          </span>
                        )}
                      <ReasonText
                        code={d.reason}
                        onJumpRun={onJumpRun}
                        onJumpProposal={onJumpProposal}
                        onJumpTicket={onJumpTicket}
                      />
                      {!d.reason && d.outcome === "planned" && (
                        <span className="text-(--text-faint)">
                          run proposed
                        </span>
                      )}
                      {!d.reason && d.outcome === "admitted" && (
                        <span className="text-(--text-faint)">
                          awaiting the planner
                        </span>
                      )}
                    </span>
                  </div>
                  {/* The joins on their own line: event ids can be long
                      (`operator:dispatch:WM-1:<iso>`), and squeezed beside the
                      reason they left it one character wide. */}
                  <div className="ml-[60px] flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-(--text-faint)">
                    {d.event && (
                      <span className="flex shrink-0 items-baseline gap-1">
                        <span>event</span>
                        <JumpLink
                          onClick={() =>
                            jumpEvent(d.event!.source, d.event!.eventId)
                          }
                          title={`${d.event.source} · ${d.event.eventId}${d.event.type ? ` · ${d.event.type}` : ""}`}
                          className="inline-block max-w-[11rem] truncate align-bottom"
                        >
                          {shortId(d.event.eventId)}
                        </JumpLink>
                      </span>
                    )}
                    {d.proposalId && (
                      <span className="flex shrink-0 items-baseline gap-1">
                        <span>proposal</span>
                        <JumpLink
                          href={hashHref("proposals", d.proposalId)}
                          onClick={
                            onJumpProposal
                              ? (ev) => {
                                  ev?.preventDefault();
                                  onJumpProposal(d.proposalId!);
                                }
                              : undefined
                          }
                          title={d.proposalId}
                        >
                          {shortId(d.proposalId)}
                        </JumpLink>
                      </span>
                    )}
                    {d.runId && (
                      <span className="flex shrink-0 items-baseline gap-1">
                        <span>run</span>
                        <JumpLink
                          href={hashHref("runs", d.runId)}
                          onClick={
                            onJumpRun
                              ? (ev) => {
                                  ev?.preventDefault();
                                  onJumpRun(d.runId!);
                                }
                              : undefined
                          }
                          title={d.runId}
                        >
                          {shortId(d.runId)}
                        </JumpLink>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Section>
  );
}

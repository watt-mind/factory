import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import {
  buildTicketJourney,
  formatDuration,
  parsePrRef,
  prHref,
  prNumbersIn,
  selectPrSource,
  subjectJourney,
  TICKET_ID_PATTERN,
  ticketIdsIn,
  type JourneyEvent,
  type JourneyProposal,
  type JourneyRun,
  type SubjectJourney,
  type TicketJourneySource,
  type TimelineItem,
} from "../subjectJourney";
import { StateBadge, STATE_HUES } from "../components/ui";
import type { AdmittedEvent, Proposal, RunDetail, RunListItem } from "../types";

async function fetchTicketJourney(ticketId: string): Promise<TicketJourneySource> {
  const response = await fetch(`/api/runs?ticket=${encodeURIComponent(ticketId)}`);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error ?? message;
    } catch {
      // Keep the HTTP status when the control API did not return JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2">
      <div className="text-[10px] font-medium tracking-wide text-(--text-faint) uppercase">{label}</div>
      <div className="mt-0.5 tabular-nums text-[13px] font-medium text-(--text)">{value}</div>
    </div>
  );
}

function SourceLink({ item, children }: { item: TimelineItem; children: ReactNode }) {
  return (
    <a
      href={item.href}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noreferrer" : undefined}
      className="min-w-0 hover:text-(--accent) hover:underline"
      title={`Open source: ${item.href}`}
    >
      {children}
    </a>
  );
}

function TimelineRow({ item, last }: { item: TimelineItem; last: boolean }) {
  const muted = item.kind === "concurrent" || item.kind === "schedule";
  const hue =
    item.kind === "ci"
      ? item.label.includes("green")
        ? "var(--hue-ok)"
        : "var(--hue-err)"
      : item.kind === "merge" || item.kind === "pr"
        ? "var(--hue-ok)"
        : item.kind === "decision"
          ? /refused/.test(item.label)
            ? "var(--hue-warn)"
            : "var(--hue-info)"
          : muted
            ? "var(--border-strong)"
            : "var(--accent)";
  const body = (
    <div className={`flex min-w-0 flex-1 items-start gap-3 ${muted ? "pb-3" : "pb-5"}`}>
      <span className="relative flex w-3 shrink-0 justify-center" aria-hidden="true">
        {!last && <span className="absolute top-2 bottom-[-22px] w-px bg-(--border)" />}
        <span
          className={`relative mt-1.5 size-2 rounded-full ring-4 ring-(--surface-1) ${item.kind === "schedule" ? "outline outline-1 outline-dashed outline-(--text-faint) bg-transparent!" : ""}`}
          style={{ background: hue }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <SourceLink item={item}>
          <div className={`mono break-words text-[12px] ${muted ? "font-normal text-(--text-dim) italic" : "font-medium text-(--text)"}`}>{item.label}</div>
        </SourceLink>
        {item.detail && <div className="mt-0.5 break-words text-[11.5px] text-(--text-faint)">{item.detail}</div>}
      </div>
      <time className="mono shrink-0 text-[10px] text-(--text-faint)" dateTime={item.at} title={item.at}>
        {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </time>
    </div>
  );

  return (
    <li className="flex items-start gap-3" data-kind={item.kind}>
      <div className="mono w-16 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-(--text-faint)">
        {item.durationMs == null ? "" : `+${formatDuration(item.durationMs)}`}
      </div>
      {item.children?.length ? (
        <details className="min-w-0 flex-1" open>
          <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">{body}</summary>
          <ol className="mb-4 ml-[5.25rem] border-l border-(--border) pl-4">
            {item.children.map((child) => (
              <li key={child.id} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 py-1 text-[11px]">
                <span className="mono text-right tabular-nums text-(--text-faint)">
                  {child.durationMs == null ? "" : `+${formatDuration(child.durationMs)}`}
                </span>
                <SourceLink item={child}>
                  <span className="inline-flex flex-wrap items-baseline gap-x-2">
                    <StateBadge state={child.label} hues={STATE_HUES} />
                    {child.detail && <span className="text-(--text-faint)">{child.detail}</span>}
                  </span>
                </SourceLink>
              </li>
            ))}
          </ol>
        </details>
      ) : (
        body
      )}
    </li>
  );
}

function TicketPicker({ onNavigate, onNavigatePr }: { onNavigate: (ticketId: string) => void; onNavigatePr?: (number: number) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const ticket = value.trim().toUpperCase();
    const pr = parsePrRef(value);
    if (pr && onNavigatePr) {
      setError(false);
      onNavigatePr(pr);
      return;
    }
    if (!TICKET_ID_PATTERN.test(ticket)) {
      setError(true);
      return;
    }
    setError(false);
    onNavigate(ticket);
  };
  return (
    <div className="mx-auto max-w-lg p-8">
      <h1 className="display text-xl font-semibold">Ticket journey</h1>
      <p className="mt-2 text-[13px] text-(--text-dim)">
        Enter a Linear ticket id to see its decisions, attempts, PR, CI, and merge history on one timeline.
        {onNavigatePr ? " A PR reference (#541) opens that PR's journey." : ""}
      </p>
      <form onSubmit={submit} className="mt-5 flex gap-2">
        <input
          ref={inputRef}
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="WM-542"
          aria-label="Ticket id"
          aria-invalid={error}
          className="mono min-w-0 flex-1 rounded-md border border-(--border-strong) bg-(--surface-1) px-3 py-2 text-[13px] outline-none focus:border-(--accent)"
        />
        <button type="submit" className="rounded-md bg-(--accent) px-4 py-2 text-[12px] font-medium text-(--on-accent)">
          Open
        </button>
      </form>
      {error && <div role="alert" className="mt-2 text-[11px] text-(--hue-err)">Use an id like WM-542{onNavigatePr ? " or a PR like #541" : ""}.</div>}
      <div className="mt-3 text-[11px] text-(--text-faint)">Shortcut: <span className="mono">g k</span></div>
    </div>
  );
}

/** Shared header + timeline + "Where it is now" for either subject kind. */
function JourneyLayout({ journey, onNavigateTicket }: { journey: SubjectJourney; onNavigateTicket?: (ticketId: string) => void }) {
  const cost = journey.totalCost == null ? "—" : `$${journey.totalCost.toFixed(2)}`;
  const tokens = journey.totalTokens == null ? "—" : journey.totalTokens.toLocaleString();
  const isPr = journey.subject.kind === "pr";
  const title = journey.subject.title ?? (isPr ? `PR #${journey.subject.id}` : "title not recorded");
  const state = journey.subject.state ?? (isPr ? null : "unknown");
  const heading = isPr ? `#${journey.subject.id}` : journey.subject.id;
  const noActivityLabel = isPr ? `no runtime activity for PR #${journey.subject.id}` : `no runtime activity for ${journey.subject.id}`;
  const externalLabel = isPr ? "Open on GitHub ↗" : "Open in Linear ↗";
  const externalUrl = isPr ? journey.pr?.url ?? null : journey.subject.url;

  return (
    <div className="h-full overflow-auto bg-(--surface-0) p-5 lg:p-7">
      <div className="mx-auto max-w-6xl">
        <header className="rounded-lg border border-(--border) bg-(--surface-1) p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="display mono text-lg font-semibold text-(--text)">{heading}</h1>
                {state && <StateBadge state={state} />}
                {isPr && journey.pr?.ticket && (
                  <span className="text-[12px] text-(--text-dim)">
                    ticket{" "}
                    <a href={`#/tickets/${encodeURIComponent(journey.pr.ticket)}`} onClick={onNavigateTicket ? (event) => { event.preventDefault(); onNavigateTicket(journey.pr!.ticket!); } : undefined} className="mono text-(--accent) hover:underline">
                      {journey.pr.ticket}
                    </a>
                  </span>
                )}
                {isPr && journey.pr?.github && <span className="mono text-[11px] text-(--text-faint)">{journey.pr.github}</span>}
              </div>
              <div className="mt-1 break-words text-[14px] text-(--text-dim)">{title}</div>
            </div>
            <div className="flex flex-wrap gap-3 text-[12px]">
              {externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer" className="text-(--accent) hover:underline">{externalLabel}</a>}
              {!isPr && journey.prUrls[0] && (
                <a href={prHref(journey.prUrls[0].match(/\/pull\/(\d+)/)?.[1] ?? "")} className="text-(--accent) hover:underline">PR journey</a>
              )}
              {!isPr && journey.prUrls[0] && <a href={journey.prUrls[0]} target="_blank" rel="noreferrer" className="text-(--accent) hover:underline">Open PR ↗</a>}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Metric label="total cost" value={cost} />
            <Metric label="lead time" value={formatDuration(journey.leadTimeMs)} />
            <Metric label="runs" value={String(journey.runCount)} />
            {!isPr && <Metric label="PRs" value={String(journey.prUrls.length)} />}
            <Metric label="tokens" value={tokens} />
          </div>
        </header>

        {!journey.activity ? (
          <div role="status" className="mt-5 rounded-lg border border-dashed border-(--border-strong) bg-(--surface-1) p-8 text-center">
            <div className="mono text-[13px] text-(--text-dim)">{noActivityLabel}</div>
            {externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[12px] text-(--accent) hover:underline">{externalLabel}</a>}
          </div>
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <section aria-labelledby="ticket-timeline" className="rounded-lg border border-(--border) bg-(--surface-1) p-5">
              <h2 id="ticket-timeline" className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">Timeline · oldest to newest</h2>
              <ol className="mt-5">
                {journey.timeline.map((item, index) => <TimelineRow key={item.id} item={item} last={index === journey.timeline.length - 1} />)}
              </ol>
            </section>
            <aside className="self-start rounded-lg border border-(--border) bg-(--surface-1) p-4 lg:sticky lg:top-5">
              <h2 className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">Where it is now</h2>
              <dl className="mt-3 space-y-3 text-[12px]">
                <div><dt className="text-(--text-faint)">{isPr ? "Merge state" : "Linear state"}</dt><dd className="mt-1">{state ? <StateBadge state={state} /> : <span className="text-(--text-dim)">— (no scan recorded it yet)</span>}</dd></div>
                <div><dt className="text-(--text-faint)">Current run / worker</dt><dd className="mono mt-1 break-words text-(--text-dim)">{journey.currentRun ? `${journey.currentRun.runId}${journey.currentRun.actor ? ` · ${journey.currentRun.actor}` : ""}` : "—"}</dd></div>
                <div><dt className="text-(--text-faint)">Blocking reason</dt><dd className="mt-1 break-words text-(--text-dim)">{journey.blockingReason ?? "—"}</dd></div>
                {journey.nextVisit && (
                  <div><dt className="text-(--text-faint)">Next visit</dt><dd className="mono mt-1 break-words text-(--text-dim)">{journey.nextVisit.loop} at {new Date(journey.nextVisit.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</dd></div>
                )}
                <div className="border-t border-(--border) pt-3"><dt className="text-(--text-faint)">Next action</dt><dd className="mt-1 break-words font-medium text-(--text)">{journey.nextAction}</dd></div>
              </dl>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

export function Ticket({
  ticketId,
  onNavigate,
  onNavigatePr,
}: {
  ticketId: string | null;
  onNavigate: (ticketId: string) => void;
  onNavigatePr?: (number: number) => void;
}) {
  const normalized = ticketId?.trim().toUpperCase() ?? null;
  const valid = normalized != null && TICKET_ID_PATTERN.test(normalized);
  const query = useQuery({
    queryKey: ["ticket-journey", normalized],
    queryFn: () => fetchTicketJourney(normalized!),
    enabled: valid,
    refetchInterval: 5000,
  });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules, enabled: valid, refetchInterval: 30_000 });

  if (!ticketId) return <TicketPicker onNavigate={onNavigate} onNavigatePr={onNavigatePr} />;
  if (!valid) {
    return (
      <div className="p-8">
        <div role="alert" className="rounded-md border border-(--hue-warn) bg-(--surface-1) p-4 text-(--hue-warn)">
          Invalid ticket id <span className="mono">{ticketId}</span>. Use an id like WM-542.
        </div>
        <button type="button" onClick={() => onNavigate("")} className="mt-3 text-[12px] text-(--accent) hover:underline">Choose another ticket</button>
      </div>
    );
  }
  if (query.isPending) return <div className="p-8 text-[13px] text-(--text-faint)">Loading {normalized} journey…</div>;
  if (query.isError || !query.data) {
    return (
      <div className="p-8">
        <div role="alert" className="rounded-md border border-(--hue-err) bg-(--surface-1) p-4 text-(--hue-err)">
          Cannot load {normalized}: {(query.error as Error)?.message ?? "control API unavailable"}
        </div>
      </div>
    );
  }

  const journey = buildTicketJourney({ ...query.data, schedules: schedules.data?.schedules });
  return <JourneyLayout journey={journey} />;
}

/**
 * Bounded set of run ids worth a detail fetch for one PR: runs linked to
 * events/proposals that name it, the parent run of each such chain (the scan
 * that produced a fix/apply/escalate for it), and the runs of its ticket (the
 * other chain that moves the head). Never every run in the registry.
 */
export function prCandidateRunIds(
  pr: number,
  input: { events: AdmittedEvent[]; proposals: Proposal[]; runs: RunListItem[] },
  cap = 80,
): string[] {
  const namesPr = (value: unknown) => prNumbersIn(value).includes(pr);
  const events = input.events.filter((event) => namesPr(event.envelope));
  const eventKeys = new Set(events.map((event) => `${event.source}\0${event.eventId}`));
  const roots = new Set(events.map((event) => event.correlationId).filter((id): id is string => !!id));
  const tickets = new Set<string>();
  for (const event of events) for (const ticket of ticketIdsIn(event.envelope)) tickets.add(ticket);
  const ids = new Set<string>();
  for (const event of events) if (event.runId) ids.add(event.runId);
  for (const proposal of input.proposals) {
    const linked = proposal.eventId && eventKeys.has(`${proposal.eventSource}\0${proposal.eventId}`);
    if ((linked || namesPr(proposal.spec?.input)) && proposal.runId) ids.add(proposal.runId);
  }
  // Root events of the chains that touched the PR (the merge scan itself) and
  // the dispatch events of the PR's ticket.
  const rootIds = new Set<string>();
  for (const event of input.events) {
    const isRoot = event.correlationId && roots.has(event.correlationId) && event.eventId === event.correlationId;
    const isTicketEvent =
      tickets.size > 0 &&
      (ticketIdsIn(event.subject).some((ticket) => tickets.has(ticket)) ||
        ticketIdsIn((event.envelope as { payload?: unknown }).payload).some((ticket) => tickets.has(ticket)));
    if (!isRoot && !isTicketEvent) continue;
    rootIds.add(`${event.source}\0${event.eventId}`);
    if (event.runId) ids.add(event.runId);
  }
  for (const run of input.runs) {
    const key = run.eventId ? `${run.eventSource}\0${run.eventId}` : null;
    if (key && (eventKeys.has(key) || rootIds.has(key))) ids.add(run.runId);
  }
  const order = new Map(input.runs.map((run, index) => [run.runId, index]));
  // The list is newest-first; keep the newest `cap` when the PR has a long history.
  return [...ids].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)).slice(0, cap);
}

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "REFUSED", "CANCELLED", "TIMED_OUT", "DEAD"]);

export function PullRequest({
  number,
  onNavigateTicket,
}: {
  number: string | null;
  onNavigateTicket?: (ticketId: string) => void;
}) {
  const pr = number != null && /^\d{1,7}$/.test(number.trim()) ? Number(number.trim()) : null;
  const enabled = pr != null;
  const events = useQuery({ queryKey: ["events", "all"], queryFn: () => api.events(), enabled, refetchInterval: 15_000 });
  const proposals = useQuery({ queryKey: ["proposals", "history"], queryFn: () => api.proposalHistory("all"), enabled, refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ["runs", "ALL"], queryFn: () => api.runs(), enabled, refetchInterval: 15_000 });
  const inbox = useQuery({ queryKey: ["inbox", "all"], queryFn: () => api.inbox("all"), enabled, refetchInterval: 30_000 });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules, enabled, refetchInterval: 30_000 });

  const eventList = events.data?.events ?? [];
  const proposalList = proposals.data?.proposals ?? [];
  const runList = runs.data?.runs ?? [];
  const candidateIds = useMemo(
    () => (pr != null && events.data && proposals.data && runs.data ? prCandidateRunIds(pr, { events: eventList, proposals: proposalList, runs: runList }) : []),
    [pr, events.data, proposals.data, runs.data],
  );
  const stateById = useMemo(() => new Map(runList.map((run) => [run.runId, run.state])), [runs.data]);
  const details = useQueries({
    queries: candidateIds.map((id) => ({
      queryKey: ["run", id],
      queryFn: () => api.run(id),
      staleTime: TERMINAL_STATES.has(stateById.get(id) ?? "") ? Infinity : 5_000,
      refetchInterval: TERMINAL_STATES.has(stateById.get(id) ?? "") ? false : 5_000,
    })),
  });
  const detailsReady = details.every((query) => query.data || query.isError);
  const loadedRuns = useMemo(
    () => details.map((query) => query.data).filter((run): run is RunDetail => !!run) as unknown as JourneyRun[],
    [details],
  );

  if (pr == null) {
    return (
      <div className="p-8">
        <div role="alert" className="rounded-md border border-(--hue-warn) bg-(--surface-1) p-4 text-(--hue-warn)">
          Invalid PR reference <span className="mono">{number}</span>. Use a number like 541.
        </div>
      </div>
    );
  }
  const listError = events.error ?? proposals.error ?? runs.error;
  if (listError) {
    return (
      <div className="p-8">
        <div role="alert" className="rounded-md border border-(--hue-err) bg-(--surface-1) p-4 text-(--hue-err)">
          Cannot load PR #{pr}: {(listError as Error).message ?? "control API unavailable"}
        </div>
      </div>
    );
  }
  if (!events.data || !proposals.data || !runs.data || !detailsReady) {
    return <div className="p-8 text-[13px] text-(--text-faint)">Loading PR #{pr} journey…</div>;
  }

  const source = selectPrSource(pr, {
    events: eventList as unknown as JourneyEvent[],
    proposals: proposalList as unknown as JourneyProposal[],
    runs: loadedRuns,
    inbox: (inbox.data?.items ?? []).filter((item) => !item.resolvedAt),
    schedules: schedules.data?.schedules,
  });
  const journey = subjectJourney("pr", String(pr), source);
  return <JourneyLayout journey={journey} onNavigateTicket={onNavigateTicket} />;
}

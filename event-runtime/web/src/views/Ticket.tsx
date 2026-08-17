import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  buildTicketJourney,
  formatDuration,
  TICKET_ID_PATTERN,
  type TicketJourneySource,
  type TimelineItem,
} from "../ticketJourney";
import { StateBadge, STATE_HUES } from "../components/ui";

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
  const hue =
    item.kind === "ci"
      ? item.label.includes("green")
        ? "var(--hue-ok)"
        : "var(--hue-err)"
      : item.kind === "merge" || item.kind === "pr"
        ? "var(--hue-ok)"
        : item.kind === "decision"
          ? "var(--hue-info)"
          : "var(--accent)";
  const body = (
    <div className="flex min-w-0 flex-1 items-start gap-3 pb-5">
      <span className="relative flex w-3 shrink-0 justify-center" aria-hidden="true">
        {!last && <span className="absolute top-2 bottom-[-22px] w-px bg-(--border)" />}
        <span
          className="relative mt-1.5 size-2 rounded-full ring-4 ring-(--surface-1)"
          style={{ background: hue }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <SourceLink item={item}>
          <div className="mono break-words text-[12px] font-medium text-(--text)">{item.label}</div>
        </SourceLink>
        {item.detail && <div className="mt-0.5 break-words text-[11.5px] text-(--text-faint)">{item.detail}</div>}
      </div>
      <time className="mono shrink-0 text-[10px] text-(--text-faint)" dateTime={item.at} title={item.at}>
        {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </time>
    </div>
  );

  return (
    <li className="flex items-start gap-3">
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

function TicketPicker({ onNavigate }: { onNavigate: (ticketId: string) => void }) {
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
      {error && <div role="alert" className="mt-2 text-[11px] text-(--hue-err)">Use an id like WM-542.</div>}
      <div className="mt-3 text-[11px] text-(--text-faint)">Shortcut: <span className="mono">g k</span></div>
    </div>
  );
}

export function Ticket({ ticketId, onNavigate }: { ticketId: string | null; onNavigate: (ticketId: string) => void }) {
  const normalized = ticketId?.trim().toUpperCase() ?? null;
  const valid = normalized != null && TICKET_ID_PATTERN.test(normalized);
  const query = useQuery({
    queryKey: ["ticket-journey", normalized],
    queryFn: () => fetchTicketJourney(normalized!),
    enabled: valid,
    refetchInterval: 5000,
  });

  if (!ticketId) return <TicketPicker onNavigate={onNavigate} />;
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

  const journey = buildTicketJourney(query.data);
  const cost = journey.totalCost == null ? "—" : `$${journey.totalCost.toFixed(2)}`;
  const tokens = journey.totalTokens == null ? "—" : journey.totalTokens.toLocaleString();
  const title = journey.ticket.title ?? "title not recorded";
  const state = journey.ticket.state ?? "unknown";

  return (
    <div className="h-full overflow-auto bg-(--surface-0) p-5 lg:p-7">
      <div className="mx-auto max-w-6xl">
        <header className="rounded-lg border border-(--border) bg-(--surface-1) p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="display mono text-lg font-semibold text-(--text)">{journey.ticket.id}</h1>
                <StateBadge state={state} />
              </div>
              <div className="mt-1 break-words text-[14px] text-(--text-dim)">{title}</div>
            </div>
            <div className="flex flex-wrap gap-3 text-[12px]">
              <a href={journey.ticket.url} target="_blank" rel="noreferrer" className="text-(--accent) hover:underline">Open in Linear ↗</a>
              {journey.prUrls[0] && <a href={journey.prUrls[0]} target="_blank" rel="noreferrer" className="text-(--accent) hover:underline">Open PR ↗</a>}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Metric label="total cost" value={cost} />
            <Metric label="lead time" value={formatDuration(journey.leadTimeMs)} />
            <Metric label="runs" value={String(journey.runCount)} />
            <Metric label="PRs" value={String(journey.prUrls.length)} />
            <Metric label="tokens" value={tokens} />
          </div>
        </header>

        {!journey.activity ? (
          <div role="status" className="mt-5 rounded-lg border border-dashed border-(--border-strong) bg-(--surface-1) p-8 text-center">
            <div className="mono text-[13px] text-(--text-dim)">no runtime activity for {journey.ticket.id}</div>
            <a href={journey.ticket.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[12px] text-(--accent) hover:underline">Open in Linear ↗</a>
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
                <div><dt className="text-(--text-faint)">Linear state</dt><dd className="mt-1"><StateBadge state={state} /></dd></div>
                <div><dt className="text-(--text-faint)">Current run / worker</dt><dd className="mono mt-1 break-words text-(--text-dim)">{journey.currentRun ? `${journey.currentRun.runId}${journey.currentRun.actor ? ` · ${journey.currentRun.actor}` : ""}` : "—"}</dd></div>
                <div><dt className="text-(--text-faint)">Blocking reason</dt><dd className="mt-1 break-words text-(--text-dim)">{journey.blockingReason ?? "—"}</dd></div>
                <div className="border-t border-(--border) pt-3"><dt className="text-(--text-faint)">Next action</dt><dd className="mt-1 break-words font-medium text-(--text)">{journey.nextAction}</dd></div>
              </dl>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

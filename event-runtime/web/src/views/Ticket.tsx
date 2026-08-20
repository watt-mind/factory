import { useQueries, useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "../api";
import { goPrefixActive } from "../goSequence";
import {
  keyGuard,
  refetchIntervals,
  useListKeys,
  useNow,
  useTabKeys,
} from "../hooks";
import {
  buildTicketJourney,
  formatDuration,
  parsePrRef,
  prHref,
  prNumbersIn,
  selectPrSource,
  subjectJourney,
  TICKET_ID_PATTERN,
  overlayTrackerDetail,
  ticketIdsIn,
  type JourneyEvent,
  type JourneyProposal,
  type JourneyRun,
  type SubjectJourney,
  type TicketTrackerDetail,
  type TimelineItem,
} from "../subjectJourney";
import { MarkdownView } from "../components/RunTrace";
import { SupplyStrip, type TicketSupply } from "../components/SupplyStrip";
import {
  Ago,
  Button as PrimitiveButton,
  FilterInput,
  ListEmpty,
  ListPane,
  StateBadge,
  STATE_HUES,
  Th,
} from "../components/ui";
import {
  fetchTicketJourney,
  isUnindexedTicket,
  TicketText,
} from "../components/TicketHoverCard";
import type {
  AdmittedEvent,
  Proposal,
  RunDetail,
  RunListItem,
  TicketSummary,
} from "../types";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2">
      <div className="text-xs font-medium tracking-wide text-(--text-faint) uppercase">
        {label}
      </div>
      <div className="mt-0.5 tabular-nums text-[13px] font-medium text-(--text)">
        {value}
      </div>
    </div>
  );
}

function SourceLink({
  item,
  children,
}: {
  item: TimelineItem;
  children: ReactNode;
}) {
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
    <div
      className={`flex min-w-0 flex-1 items-start gap-3 ${muted ? "pb-3" : "pb-5"}`}
    >
      <span
        className="relative flex w-3 shrink-0 justify-center"
        aria-hidden="true"
      >
        {!last && (
          <span className="absolute top-2 bottom-[-22px] w-px bg-(--border)" />
        )}
        <span
          className={`relative mt-1.5 size-2 rounded-full ring-4 ring-(--surface-1) ${item.kind === "schedule" ? "outline outline-1 outline-dashed outline-(--text-faint) bg-transparent!" : ""}`}
          style={{ background: hue }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <SourceLink item={item}>
          <div
            className={`mono break-words text-[12px] ${muted ? "font-normal text-(--text-dim) italic" : "font-medium text-(--text)"}`}
          >
            {item.label}
          </div>
        </SourceLink>
        {item.detail && (
          <div className="mt-0.5 break-words text-sm text-(--text-faint)">
            {/* The label above is already a link, so only the detail line can
                carry ticket links without nesting anchors. */}
            <TicketText text={item.detail} />
          </div>
        )}
      </div>
      <time
        className="mono shrink-0 text-xs text-(--text-faint)"
        dateTime={item.at}
        title={item.at}
      >
        {new Date(item.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </time>
    </div>
  );

  return (
    <li className="flex items-start gap-3" data-kind={item.kind}>
      <div className="mono w-16 shrink-0 pt-0.5 text-right text-xs tabular-nums text-(--text-faint)">
        {item.durationMs == null ? "" : `+${formatDuration(item.durationMs)}`}
      </div>
      {item.children?.length ? (
        <details className="min-w-0 flex-1" open>
          <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
            {body}
          </summary>
          <ol className="mb-4 ml-[5.25rem] border-l border-(--border) pl-4">
            {item.children.map((child) => (
              <li
                key={child.id}
                className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 py-1 text-[11px]"
              >
                <span className="mono text-right tabular-nums text-(--text-faint)">
                  {child.durationMs == null
                    ? ""
                    : `+${formatDuration(child.durationMs)}`}
                </span>
                <SourceLink item={child}>
                  <span className="inline-flex flex-wrap items-baseline gap-x-2">
                    <StateBadge state={child.label} hues={STATE_HUES} />
                    {child.detail && (
                      <span className="text-(--text-faint)">
                        {child.detail}
                      </span>
                    )}
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

function TicketsHub({
  onNavigate,
  onNavigatePr,
}: {
  onNavigate: (ticketId: string) => void;
  onNavigatePr?: (number: number) => void;
}) {
  const [jumpValue, setJumpValue] = useState("");
  const [jumpError, setJumpError] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNow();

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const ticketsQuery = useQuery({
    queryKey: ["tickets", repoFilter],
    queryFn: () => api.tickets(undefined, 100, repoFilter || undefined),
    ...refetchIntervals.fast,
  });

  const supplyQuery = useQuery({
    queryKey: ["tickets-supply"],
    queryFn: fetchTicketSupply,
    ...refetchIntervals.secondary,
  });

  const reposQuery = useQuery({
    queryKey: ["repos"],
    queryFn: api.repos,
    ...refetchIntervals.secondary,
  });

  const tickets: TicketSummary[] = useMemo(
    () => ticketsQuery.data?.tickets ?? [],
    [ticketsQuery.data],
  );

  const repoOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of reposQuery.data?.repos ?? []) {
      if (r.name) set.add(r.name);
    }
    for (const t of tickets) {
      if (t.repo) set.add(t.repo);
      if (t.repos) t.repos.forEach((r) => set.add(r));
    }
    return Array.from(set).sort();
  }, [reposQuery.data, tickets]);

  const stateOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tickets) {
      if (t.state) set.add(t.state);
    }
    if (stateFilter) set.add(stateFilter);
    return Array.from(set).sort();
  }, [tickets, stateFilter]);

  const filteredTickets = useMemo(() => {
    return tickets.filter((t) => {
      if (repoFilter) {
        const matchesRepo =
          t.repo === repoFilter || (t.repos && t.repos.includes(repoFilter));
        if (!matchesRepo) return false;
      }
      if (stateFilter) {
        if (t.state !== stateFilter) return false;
      }
      if (searchQuery) {
        const q = searchQuery.trim().toLowerCase();
        const matchId = t.id.toLowerCase().includes(q);
        const matchTitle = t.title?.toLowerCase().includes(q);
        const matchRepo =
          t.repo?.toLowerCase().includes(q) ||
          t.repos?.some((r) => r.toLowerCase().includes(q));
        const matchState = t.state?.toLowerCase().includes(q);
        const matchDesc = t.lastActivityDescription?.toLowerCase().includes(q);
        if (
          !matchId &&
          !matchTitle &&
          !matchRepo &&
          !matchState &&
          !matchDesc
        ) {
          return false;
        }
      }
      return true;
    });
  }, [tickets, repoFilter, stateFilter, searchQuery]);

  const selectedIndex = useMemo(() => {
    if (!selectedId) return 0;
    const idx = filteredTickets.findIndex((t) => t.id === selectedId);
    return idx >= 0 ? idx : 0;
  }, [filteredTickets, selectedId]);

  const selectedTicket = filteredTickets[selectedIndex] ?? null;

  useListKeys({
    count: filteredTickets.length,
    selected: selectedIndex,
    onSelect: (index) => setSelectedId(filteredTickets[index]?.id ?? null),
    onClose: () => {
      if (searchQuery) setSearchQuery("");
      else setSelectedId(null);
    },
    keys: {
      Enter: () => {
        if (selectedTicket) {
          onNavigate(selectedTicket.id);
        }
      },
      o: () => {
        if (selectedTicket) {
          const linearUrl =
            selectedTicket.url ||
            `https://linear.app/watt-mind/issue/${encodeURIComponent(selectedTicket.id)}`;
          window.open(linearUrl, "_blank", "noreferrer");
        }
      },
    },
  });

  useEffect(() => {
    let lastKey = "";
    let lastKeyTime = 0;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isInput) return;

      const currentTime = Date.now();
      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        lastKey = "g";
        lastKeyTime = currentTime;
        return;
      }
      if (
        e.key === "k" &&
        lastKey === "g" &&
        currentTime - lastKeyTime < 1000 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        inputRef.current?.focus();
        if (typeof inputRef.current?.select === "function") {
          inputRef.current.select();
        }
        lastKey = "";
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        if (typeof inputRef.current?.select === "function") {
          inputRef.current.select();
        }
        return;
      }
      lastKey = "";
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const submitJump = (event: FormEvent) => {
    event.preventDefault();
    const raw = (inputRef.current?.value || jumpValue).trim();
    const ticket = raw.toUpperCase();
    const pr = parsePrRef(raw);
    if (pr && onNavigatePr) {
      setJumpError(false);
      onNavigatePr(pr);
      return;
    }
    if (!TICKET_ID_PATTERN.test(ticket)) {
      setJumpError(true);
      return;
    }
    setJumpError(false);
    onNavigate(ticket);
  };

  return (
    <ListPane
      chrome={
        <>
          <h1 className="display mb-1 text-lg font-semibold">Tickets</h1>
          <p className="mb-3 text-[11px] text-(--text-faint)">
            Recent factory ticket activity, journey timelines, and quick search.
            {onNavigatePr
              ? " A PR reference (#541) opens that PR's journey."
              : ""}
          </p>
          <form
            onSubmit={submitJump}
            className="mb-3 flex flex-wrap items-center gap-2"
          >
            <input
              ref={inputRef}
              autoFocus
              value={jumpValue}
              onChange={(event) => setJumpValue(event.target.value)}
              placeholder="WM-542 or #541"
              aria-label="Ticket id"
              aria-invalid={jumpError}
              className="mono min-w-48 flex-1 rounded-md border border-(--border-strong) bg-(--surface-1) px-3 py-1.5 text-[13px] outline-none focus:border-(--accent)"
            />
            <PrimitiveButton
              bare
              type="submit"
              className="rounded-md bg-(--accent) px-3.5 py-1.5 text-[12px] font-medium text-(--on-accent)"
            >
              Open
            </PrimitiveButton>
          </form>
          {jumpError && (
            <div role="alert" className="mb-3 text-[11px] text-(--hue-err)">
              Use an id like WM-542{onNavigatePr ? " or a PR like #541" : ""}.
            </div>
          )}
          <SupplyStrip
            supply={supplyQuery.data}
            pending={supplyQuery.isPending}
            error={
              supplyQuery.isError
                ? ((supplyQuery.error as Error)?.message ?? "unavailable")
                : null
            }
            repoFilter={repoFilter}
            stateFilter={stateFilter}
            now={now}
            onFilter={({ repo, state }) => {
              setRepoFilter(repo);
              setStateFilter(state);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <FilterInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Filter tickets…"
              label="Filter tickets"
            />
            <select
              aria-label="Filter by repo"
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              className="rounded-md border border-(--border-strong) bg-(--surface-1) px-2.5 py-1 text-[12px] text-(--text)"
            >
              <option value="">All repos</option>
              {repoOptions.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by state"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="rounded-md border border-(--border-strong) bg-(--surface-1) px-2.5 py-1 text-[12px] text-(--text)"
            >
              <option value="">All states</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 text-[11px] text-(--text-faint)">
            Shortcut: <span className="mono">g k</span> to focus jump bar,{" "}
            <span className="mono">j</span>/<span className="mono">k</span> to
            navigate, <span className="mono">Enter</span> to open,{" "}
            <span className="mono">o</span> to open in Linear
          </div>
        </>
      }
    >
      <div className="table-wrap">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-(--border)">
              <Th label="Ticket ID" />
              <Th label="Repo" />
              <Th label="State" />
              <Th label="Last Activity" />
              <Th label="Attempts" />
              <Th label="PR / CI" />
            </tr>
          </thead>
          <tbody>
            {filteredTickets.length === 0 ? (
              <ListEmpty
                colSpan={6}
                query={ticketsQuery}
                filtered={Boolean(searchQuery || repoFilter || stateFilter)}
                noun="tickets"
                empty="No tickets found."
                onClear={() => {
                  setSearchQuery("");
                  setRepoFilter("");
                  setStateFilter("");
                }}
              />
            ) : (
              filteredTickets.map((ticket, index) => {
                const selected =
                  index === selectedIndex || ticket.id === selectedId;
                return (
                  <tr
                    key={ticket.id}
                    data-ticket-id={ticket.id}
                    aria-selected={selected}
                    onClick={() => onNavigate(ticket.id)}
                    className={`cursor-pointer border-b border-(--border) hover:bg-(--surface-1) ${
                      selected ? "bg-(--surface-1)" : ""
                    }`}
                  >
                    <td className="mono px-3 py-1.5 whitespace-nowrap font-medium">
                      <span className="inline-flex max-w-xs items-center gap-2">
                        <a
                          href={`#/tickets/${encodeURIComponent(ticket.id)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onNavigate(ticket.id);
                          }}
                          className="shrink-0 text-(--accent) hover:underline"
                        >
                          {ticket.id}
                        </a>
                        {ticket.title && (
                          <span
                            className="min-w-0 truncate font-sans text-[11px] font-normal text-(--text-dim)"
                            title={ticket.title}
                          >
                            {ticket.title}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="mono px-3 py-1.5 whitespace-nowrap text-(--text-dim)">
                      {ticket.repo || ticket.repos?.join(", ") || "—"}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {ticket.state ? (
                        <StateBadge state={ticket.state} hues={STATE_HUES} />
                      ) : (
                        <span className="text-(--text-faint)">—</span>
                      )}
                    </td>
                    <td className="max-w-xs truncate px-3 py-1.5 whitespace-nowrap text-(--text-dim)">
                      <span>
                        {ticket.lastActivityDescription ||
                          ticket.lastActivityKind ||
                          "—"}
                      </span>
                      {ticket.lastActivityAt && (
                        <span className="ml-2 text-(--text-faint)">
                          <Ago iso={ticket.lastActivityAt} now={now} />
                        </span>
                      )}
                    </td>
                    <td className="mono px-3 py-1.5 whitespace-nowrap tabular-nums text-(--text-dim)">
                      {ticket.attempts != null ? ticket.attempts : "—"}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {(() => {
                        const prNumber =
                          typeof ticket.pr === "number"
                            ? ticket.pr
                            : ticket.pr && typeof ticket.pr === "object"
                              ? ticket.pr.number
                              : null;
                        const prUrl =
                          typeof ticket.pr === "object" && ticket.pr?.url
                            ? ticket.pr.url
                            : ticket.prUrl ||
                              (prNumber ? `#/prs/${prNumber}` : undefined);
                        const ci =
                          typeof ticket.pr === "object" && ticket.pr?.ci
                            ? ticket.pr.ci
                            : (ticket.ciStatus ??
                              (ticket.checksGreen != null
                                ? ticket.checksGreen
                                  ? "green"
                                  : "red"
                                : null));

                        return prNumber != null ? (
                          <span className="inline-flex items-center gap-1.5">
                            <a
                              href={prUrl || `#/prs/${prNumber}`}
                              onClick={(e) => {
                                if (onNavigatePr) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onNavigatePr(prNumber);
                                }
                              }}
                              className="mono text-(--accent) hover:underline"
                            >
                              {`#${prNumber}`}
                            </a>
                            {ci && (
                              <span
                                className={`inline-block size-2 rounded-full ring-2 ring-(--surface-1) ${
                                  ci === "green"
                                    ? "bg-(--hue-ok)"
                                    : ci === "red"
                                      ? "bg-(--hue-err)"
                                      : "bg-(--hue-warn)"
                                }`}
                                title={`CI: ${ci}`}
                              />
                            )}
                          </span>
                        ) : (
                          <span className="text-(--text-faint)">—</span>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </ListPane>
  );
}

const JOURNEY_TABS = ["timeline", "spec"] as const;
type JourneyTab = (typeof JOURNEY_TABS)[number];

const EXTERNAL_BUTTON_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-(--border-strong) bg-(--surface-2) px-2.5 text-[12px] font-medium text-(--text) hover:bg-(--surface-3)";

async function fetchTicketSupply(): Promise<TicketSupply> {
  const response = await fetch("/api/tickets/supply");
  if (response.status === 404) {
    return { repos: [], recommendedAction: null };
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.message ?? body.error ?? message;
    } catch {
      // Keep the HTTP status when the control API did not return JSON.
    }
    throw new Error(message);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.repos)) {
    return { repos: [], recommendedAction: null };
  }
  return body as TicketSupply;
}

async function fetchTicketDetail(
  ticketId: string,
): Promise<TicketTrackerDetail | null> {
  const response = await fetch(
    `/api/tickets/${encodeURIComponent(ticketId)}/detail`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.message ?? body.error ?? message;
    } catch {
      // Keep the HTTP status when the control API did not return JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

function ExternalTicketLink({
  href,
  label,
  shortcut,
}: {
  href: string;
  label: string;
  shortcut?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={EXTERNAL_BUTTON_CLASS}
    >
      {label}
      {shortcut && (
        <kbd
          aria-hidden="true"
          className="rounded border border-(--border) px-1 font-sans text-xs text-(--text-faint)"
        >
          {shortcut}
        </kbd>
      )}
    </a>
  );
}

function SpecCommentsPanel({
  detail,
  pending,
  error,
}: {
  detail: TicketTrackerDetail | null;
  pending: boolean;
  error: string | null;
}) {
  if (pending) {
    return (
      <div role="status" className="text-[13px] text-(--text-faint)">
        Loading spec and comments…
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md border border-(--hue-warn) bg-(--surface-0) p-3 text-[13px] text-(--hue-warn)"
      >
        Cannot load Linear details: {error}
      </div>
    );
  }
  if (!detail) {
    return (
      <div role="status" className="text-[13px] text-(--text-dim)">
        No Linear issue found for this id.
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <section aria-labelledby="ticket-spec">
        <h3
          id="ticket-spec"
          className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase"
        >
          Spec
        </h3>
        <div className="mt-3">
          {(detail.ticket.description ?? "").trim() ? (
            <MarkdownView text={detail.ticket.description} />
          ) : (
            <p className="text-[13px] text-(--text-dim)">
              No description recorded.
            </p>
          )}
        </div>
      </section>
      <section aria-labelledby="ticket-comments">
        <h3
          id="ticket-comments"
          className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase"
        >
          Comments ({(detail.comments ?? []).length})
        </h3>
        {(detail.comments ?? []).length === 0 ? (
          <p className="mt-3 text-[13px] text-(--text-dim)">No comments yet.</p>
        ) : (
          <ol className="mt-3 space-y-4">
            {(detail.comments ?? []).map((comment, index) => (
              <li
                key={comment.id ?? `comment-${index}`}
                className="rounded-md border border-(--border) bg-(--surface-0) p-3"
              >
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[11px] text-(--text-faint)">
                  <span className="font-medium text-(--text-dim)">
                    {comment.user?.name ?? "unknown"}
                  </span>
                  {comment.createdAt && (
                    <time dateTime={comment.createdAt}>
                      {new Date(comment.createdAt).toLocaleString()}
                    </time>
                  )}
                </div>
                <MarkdownView text={comment.body} allowToggle={false} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Shared header + timeline + "Where it is now" for either subject kind. */
function JourneyLayout({
  journey,
  onNavigateTicket,
  detail = null,
  detailPending = false,
  detailError = null,
}: {
  journey: SubjectJourney;
  onNavigateTicket?: (ticketId: string) => void;
  detail?: TicketTrackerDetail | null;
  detailPending?: boolean;
  detailError?: string | null;
}) {
  const [tab, setTab] = useState<JourneyTab>("timeline");
  const cost =
    journey.totalCost == null ? "—" : `$${journey.totalCost.toFixed(2)}`;
  const tokens =
    journey.totalTokens == null ? "—" : journey.totalTokens.toLocaleString();
  const isPr = journey.subject.kind === "pr";
  const title =
    journey.subject.title ??
    (detailPending && !isPr
      ? "Loading title…"
      : isPr
        ? `PR #${journey.subject.id}`
        : "title not recorded");
  const state = journey.subject.state ?? (isPr ? null : "unknown");
  const heading = isPr ? `#${journey.subject.id}` : journey.subject.id;
  const noActivityLabel = isPr
    ? `no runtime activity for PR #${journey.subject.id}`
    : `no runtime activity for ${journey.subject.id}`;
  const externalLabel = isPr ? "Open on GitHub ↗" : "Open in Linear ↗";
  const externalUrl = isPr ? (journey.pr?.url ?? null) : journey.subject.url;
  const ticketTabs: readonly JourneyTab[] = isPr ? ["timeline"] : JOURNEY_TABS;

  useTabKeys(ticketTabs, isPr ? "timeline" : tab, setTab);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (keyGuard(event) || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (goPrefixActive()) return;
      if (event.key !== "o" && event.key !== "l") return;
      if (!externalUrl) return;
      event.preventDefault();
      window.open(externalUrl, "_blank", "noreferrer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [externalUrl]);

  return (
    <div className="h-full overflow-auto bg-(--surface-0) p-5 lg:p-7">
      <div className="mx-auto max-w-6xl">
        <header className="rounded-lg border border-(--border) bg-(--surface-1) p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="display mono text-h1 font-semibold text-(--text)">
                  {heading}
                </h1>
                {state && <StateBadge state={state} />}
                {isPr && journey.pr?.ticket && (
                  <span className="text-[12px] text-(--text-dim)">
                    ticket{" "}
                    <a
                      href={`#/tickets/${encodeURIComponent(journey.pr.ticket)}`}
                      onClick={
                        onNavigateTicket
                          ? (event) => {
                              event.preventDefault();
                              onNavigateTicket(journey.pr!.ticket!);
                            }
                          : undefined
                      }
                      className="mono text-(--accent) hover:underline"
                    >
                      {journey.pr.ticket}
                    </a>
                  </span>
                )}
                {isPr && journey.pr?.github && (
                  <span className="mono text-[11px] text-(--text-faint)">
                    {journey.pr.github}
                  </span>
                )}
              </div>
              <div className="mt-1 break-words text-[14px] text-(--text-dim)">
                {title}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              {externalUrl && (
                <ExternalTicketLink
                  href={externalUrl}
                  label={externalLabel}
                  shortcut="O"
                />
              )}
              {!isPr && journey.prUrls[0] && (
                <a
                  href={prHref(
                    journey.prUrls[0].match(/\/pull\/(\d+)/)?.[1] ?? "",
                  )}
                  className="text-(--accent) hover:underline"
                >
                  PR journey
                </a>
              )}
              {!isPr && journey.prUrls[0] && (
                <a
                  href={journey.prUrls[0]}
                  target="_blank"
                  rel="noreferrer"
                  className="text-(--accent) hover:underline"
                >
                  Open PR ↗
                </a>
              )}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Metric label="total cost" value={cost} />
            <Metric
              label="lead time"
              value={formatDuration(journey.leadTimeMs)}
            />
            <Metric label="runs" value={String(journey.runCount)} />
            {!isPr && (
              <Metric label="PRs" value={String(journey.prUrls.length)} />
            )}
            <Metric label="tokens" value={tokens} />
          </div>
        </header>

        {!isPr && (
          <div
            className="mt-5 flex w-max flex-nowrap gap-1 whitespace-nowrap"
            role="tablist"
            aria-label="Ticket journey sections"
          >
            <PrimitiveButton
              bare
              type="button"
              role="tab"
              aria-selected={tab === "timeline"}
              onClick={() => setTab("timeline")}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                tab === "timeline"
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              Timeline
            </PrimitiveButton>
            <PrimitiveButton
              bare
              type="button"
              role="tab"
              aria-selected={tab === "spec"}
              onClick={() => setTab("spec")}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                tab === "spec"
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              Spec & Comments
            </PrimitiveButton>
          </div>
        )}

        {!isPr && tab === "spec" ? (
          <section
            role="tabpanel"
            aria-label="Spec and comments"
            className="mt-5 rounded-lg border border-(--border) bg-(--surface-1) p-5"
          >
            <SpecCommentsPanel
              detail={detail}
              pending={detailPending}
              error={detailError}
            />
          </section>
        ) : !journey.activity ? (
          <div
            role="status"
            className="mt-5 rounded-lg border border-dashed border-(--border-strong) bg-(--surface-1) p-8 text-center"
          >
            <div className="mono text-[13px] text-(--text-dim)">
              {noActivityLabel}
            </div>
            {externalUrl && (
              <div className="mt-3 flex justify-center">
                <ExternalTicketLink
                  href={externalUrl}
                  label={externalLabel}
                  shortcut="O"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <section
              role="tabpanel"
              aria-labelledby="ticket-timeline"
              className="rounded-lg border border-(--border) bg-(--surface-1) p-5"
            >
              <h2
                id="ticket-timeline"
                className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase"
              >
                Timeline · oldest to newest
              </h2>
              <ol className="mt-5">
                {journey.timeline.map((item, index) => (
                  <TimelineRow
                    key={item.id}
                    item={item}
                    last={index === journey.timeline.length - 1}
                  />
                ))}
              </ol>
            </section>
            <aside className="self-start rounded-lg border border-(--border) bg-(--surface-1) p-4 lg:sticky lg:top-5">
              <h2 className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                Where it is now
              </h2>
              <dl className="mt-3 space-y-3 text-[12px]">
                <div>
                  <dt className="text-(--text-faint)">
                    {isPr ? "Merge state" : "Linear state"}
                  </dt>
                  <dd className="mt-1">
                    {state ? (
                      <StateBadge state={state} />
                    ) : (
                      <span className="text-(--text-dim)">
                        — (no scan recorded it yet)
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-(--text-faint)">Current run / worker</dt>
                  <dd className="mono mt-1 break-words text-(--text-dim)">
                    {journey.currentRun
                      ? `${journey.currentRun.runId}${journey.currentRun.actor ? ` · ${journey.currentRun.actor}` : ""}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-(--text-faint)">Blocking reason</dt>
                  <dd className="mt-1 break-words text-(--text-dim)">
                    {journey.blockingReason ? (
                      <TicketText text={journey.blockingReason} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                {journey.nextVisit && (
                  <div>
                    <dt className="text-(--text-faint)">Next visit</dt>
                    <dd className="mono mt-1 break-words text-(--text-dim)">
                      {journey.nextVisit.loop} at{" "}
                      {new Date(journey.nextVisit.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </dd>
                  </div>
                )}
                <div className="border-t border-(--border) pt-3">
                  <dt className="text-(--text-faint)">Next action</dt>
                  <dd className="mt-1 break-words font-medium text-(--text)">
                    <TicketText text={journey.nextAction} />
                  </dd>
                </div>
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
    // fetchTicketJourney uses raw fetch() and bypasses the ETag wrapper in api.ts, so it stays at 5s.
    refetchInterval: 5000,
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    enabled: valid,
    ...refetchIntervals.secondary,
  });
  const detailQuery = useQuery({
    queryKey: ["ticket-detail", normalized],
    queryFn: () => fetchTicketDetail(normalized!),
    enabled: valid,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  if (!ticketId || ticketId.trim() === "")
    return <TicketsHub onNavigate={onNavigate} onNavigatePr={onNavigatePr} />;
  if (!valid) {
    return (
      <div className="p-8">
        <div
          role="alert"
          className="rounded-md border border-(--hue-warn) bg-(--surface-1) p-4 text-(--hue-warn)"
        >
          Invalid ticket id <span className="mono">{ticketId}</span>. Use an id
          like WM-542.
        </div>
        <PrimitiveButton
          bare
          type="button"
          onClick={() => onNavigate("")}
          className="mt-3 text-[12px] text-(--accent) hover:underline"
        >
          Choose another ticket
        </PrimitiveButton>
      </div>
    );
  }
  if (query.isPending)
    return (
      <div className="p-8 text-[13px] text-(--text-faint)">
        Loading {normalized} journey…
      </div>
    );
  if (query.isError || !query.data) {
    return (
      <div className="p-8">
        <div
          role="alert"
          className="rounded-md border border-(--hue-err) bg-(--surface-1) p-4 text-(--hue-err)"
        >
          Cannot load {normalized}:{" "}
          {(query.error as Error)?.message ?? "control API unavailable"}
        </div>
      </div>
    );
  }

  // An id nothing in the runtime has ever named — a typo, another workspace's
  // ticket, or a team this factory does not dispatch. If the tracker still
  // knows it, show the journey chrome with the live title instead of this
  // empty state.
  const trackerKnown = Boolean(
    detailQuery.data?.ticket?.title || detailQuery.data?.ticket?.state,
  );
  if (isUnindexedTicket(query.data) && !trackerKnown) {
    if (detailQuery.isPending) {
      return (
        <div className="p-8 text-[13px] text-(--text-faint)">
          Loading {normalized} from Linear…
        </div>
      );
    }
    return (
      <div className="p-8">
        <div
          role="status"
          className="mx-auto max-w-lg rounded-lg border border-dashed border-(--border-strong) bg-(--surface-1) p-8 text-center"
        >
          <div className="text-[13px] font-medium text-(--text)">
            Unknown or external ticket
          </div>
          <div className="mt-1.5 text-[12px] text-(--text-dim)">
            <span className="mono">{normalized}</span> is not in this factory's
            index: no run, event, or proposal has ever named it.
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-4 text-[12px]">
            <ExternalTicketLink
              href={query.data.ticket.url}
              label="Open in Linear ↗"
              shortcut="O"
            />
            <button
              type="button"
              onClick={() => onNavigate("")}
              className="text-(--accent) hover:underline"
            >
              Choose another ticket
            </button>
          </div>
        </div>
      </div>
    );
  }

  const journey = overlayTrackerDetail(
    buildTicketJourney({
      ...query.data,
      schedules: schedules.data?.schedules,
    }),
    detailQuery.data,
  );
  return (
    <JourneyLayout
      journey={journey}
      detail={detailQuery.data}
      detailPending={detailQuery.isPending}
      detailError={
        detailQuery.isError
          ? ((detailQuery.error as Error)?.message ?? "unavailable")
          : null
      }
    />
  );
}

/**
 * Bounded set of run ids worth a detail fetch for one PR: runs linked to
 * events/proposals that name it, the parent run of each such chain (the scan
 * that produced a fix/apply/escalate for it), and the runs of its ticket (the
 * other chain that moves the head). Never every run in the registry.
 */
export function prCandidateRunIds(
  pr: number,
  input: {
    events: AdmittedEvent[];
    proposals: Proposal[];
    runs: RunListItem[];
  },
  cap = 80,
): string[] {
  const namesPr = (value: unknown) => prNumbersIn(value).includes(pr);
  const events = input.events.filter((event) => namesPr(event.envelope));
  const eventKeys = new Set(
    events.map((event) => `${event.source}\0${event.eventId}`),
  );
  const roots = new Set(
    events
      .map((event) => event.correlationId)
      .filter((id): id is string => !!id),
  );
  const tickets = new Set<string>();
  for (const event of events)
    for (const ticket of ticketIdsIn(event.envelope)) tickets.add(ticket);
  const ids = new Set<string>();
  for (const event of events) if (event.runId) ids.add(event.runId);
  for (const proposal of input.proposals) {
    const linked =
      proposal.eventId &&
      eventKeys.has(`${proposal.eventSource}\0${proposal.eventId}`);
    if ((linked || namesPr(proposal.spec?.input)) && proposal.runId)
      ids.add(proposal.runId);
  }
  // Root events of the chains that touched the PR (the merge scan itself) and
  // the dispatch events of the PR's ticket.
  const rootIds = new Set<string>();
  for (const event of input.events) {
    const isRoot =
      event.correlationId &&
      roots.has(event.correlationId) &&
      event.eventId === event.correlationId;
    const isTicketEvent =
      tickets.size > 0 &&
      (ticketIdsIn(event.subject).some((ticket) => tickets.has(ticket)) ||
        ticketIdsIn((event.envelope as { payload?: unknown }).payload).some(
          (ticket) => tickets.has(ticket),
        ));
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
  return [...ids]
    .sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
    .slice(0, cap);
}

const TERMINAL_STATES = new Set([
  "COMPLETED",
  "FAILED",
  "REFUSED",
  "CANCELLED",
  "TIMED_OUT",
  "DEAD",
]);

export function PullRequest({
  number,
  onNavigateTicket,
}: {
  number: string | null;
  onNavigateTicket?: (ticketId: string) => void;
}) {
  const pr =
    number != null && /^\d{1,7}$/.test(number.trim())
      ? Number(number.trim())
      : null;
  const enabled = pr != null;
  const events = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    enabled,
    ...refetchIntervals.fast,
  });
  const proposals = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    enabled,
    ...refetchIntervals.fast,
  });
  const runs = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    enabled,
    ...refetchIntervals.fast,
  });
  const inbox = useQuery({
    queryKey: ["inbox", "all"],
    queryFn: () => api.inbox("all"),
    enabled,
    ...refetchIntervals.secondary,
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    enabled,
    ...refetchIntervals.secondary,
  });

  const eventList = events.data?.events ?? [];
  const proposalList = proposals.data?.proposals ?? [];
  const runList = runs.data?.runs ?? [];
  const candidateIds = useMemo(
    () =>
      pr != null && events.data && proposals.data && runs.data
        ? prCandidateRunIds(pr, {
            events: eventList,
            proposals: proposalList,
            runs: runList,
          })
        : [],
    [pr, events.data, proposals.data, runs.data],
  );
  const stateById = useMemo(
    () => new Map(runList.map((run) => [run.runId, run.state])),
    [runs.data],
  );
  const details = useQueries({
    queries: candidateIds.map((id) => ({
      queryKey: ["run", id],
      queryFn: () => api.run(id),
      staleTime: TERMINAL_STATES.has(stateById.get(id) ?? "")
        ? Infinity
        : 5_000,
      ...refetchIntervals.primary,
      refetchInterval: TERMINAL_STATES.has(stateById.get(id) ?? "")
        ? false
        : refetchIntervals.primary.refetchInterval,
    })),
  });
  const detailsReady = details.every((query) => query.data || query.isError);
  const loadedRuns = useMemo(
    () =>
      details
        .map((query) => query.data)
        .filter((run): run is RunDetail => !!run) as unknown as JourneyRun[],
    [details],
  );

  if (pr == null) {
    return (
      <div className="p-8">
        <div
          role="alert"
          className="rounded-md border border-(--hue-warn) bg-(--surface-1) p-4 text-(--hue-warn)"
        >
          Invalid PR reference <span className="mono">{number}</span>. Use a
          number like 541.
        </div>
      </div>
    );
  }
  const listError = events.error ?? proposals.error ?? runs.error;
  if (listError) {
    return (
      <div className="p-8">
        <div
          role="alert"
          className="rounded-md border border-(--hue-err) bg-(--surface-1) p-4 text-(--hue-err)"
        >
          Cannot load PR #{pr}:{" "}
          {(listError as Error).message ?? "control API unavailable"}
        </div>
      </div>
    );
  }
  if (!events.data || !proposals.data || !runs.data || !detailsReady) {
    return (
      <div className="p-8 text-[13px] text-(--text-faint)">
        Loading PR #{pr} journey…
      </div>
    );
  }

  const source = selectPrSource(pr, {
    events: eventList as unknown as JourneyEvent[],
    proposals: proposalList as unknown as JourneyProposal[],
    runs: loadedRuns,
    inbox: (inbox.data?.items ?? []).filter((item) => !item.resolvedAt),
    schedules: schedules.data?.schedules,
  });
  const journey = subjectJourney("pr", String(pr), source);
  return (
    <JourneyLayout journey={journey} onNavigateTicket={onNavigateTicket} />
  );
}

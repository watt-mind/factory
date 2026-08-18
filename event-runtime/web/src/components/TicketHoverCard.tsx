/**
 * Ticket auto-linking and the ticket hover card (WM-701).
 *
 * Which prefixes are tickets is a property of *this* factory's configuration,
 * not of the web app: the team keys come from `config/repos.yaml` by way of
 * `api.repos()`. A hard-coded list would either miss a team the operator added
 * this morning or linkify another workspace's ids into dead routes.
 *
 * The match is deliberately narrow — word boundaries on both sides and at most
 * six digits — because the payloads this runs over are full of things that
 * merely look like ticket ids: `UTF-8`, `SHA-256`, `feat/WM-701-slug`. Guessing
 * wrong here turns ordinary prose into a field of broken links.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import { api } from "../api";
import { resolveEntity } from "../entities";
import type { TicketJourneySource } from "../subjectJourney";
import type { RepoItem } from "../types";
import { HoverCard } from "./HoverCard";
import { StateBadge } from "./ui";

function walkJson(
  value: unknown,
  visitor: (key: string, value: unknown) => void,
  seen = new Set<unknown>(),
) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    visitor(key, entry);
    walkJson(entry, visitor, seen);
  }
}

/** PR numbers a record names structurally: `pr`/`prNumber` fields, `PR#541`, or pull URLs. */
function prNumbersIn(value: unknown): number[] {
  const numbers = new Set<number>();
  const addNumber = (candidate: unknown) => {
    const number =
      typeof candidate === "string"
        ? Number(candidate.replace(/^PR\s*#?/i, "").trim())
        : Number(candidate);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  };
  const inspect = (key: string, entry: unknown) => {
    if (/^(pr|prNumber|prNumbers|pullRequestNumber|prs)$/i.test(key)) {
      if (Array.isArray(entry)) entry.forEach(addNumber);
      else if (typeof entry !== "object" || entry === null) addNumber(entry);
    }
    if (typeof entry === "string") {
      const url = entry.match(
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:$|[/?#])/,
      );
      if (url) addNumber(url[1]);
    }
  };
  if (typeof value === "string") inspect("prUrl", value);
  walkJson(value, inspect);
  return [...numbers];
}

/** Longest ticket number Linear realistically issues; also the false-positive guard. */
export const TICKET_REF_MAX_DIGITS = 6;

/**
 * Team keys assumed until `api.repos()` answers. Without them the first paint
 * after a reload would show every ticket id as dead prose and then quietly
 * relink it, which reads as a rendering bug.
 */
export const FALLBACK_TICKET_TEAMS = ["CLNT", "CW", "LAB", "OPS", "WM"];

/** A Linear team key: letters and digits, never regex metacharacters. */
const TEAM_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

/** An alternation that can never match, for a factory with no configured teams. */
const NEVER_MATCHES = "(?!)";

/** The team keys this factory actually runs tickets for, sorted and deduped. */
export function ticketTeamsFrom(
  repos: readonly Pick<RepoItem, "team">[] | null | undefined,
): string[] {
  const teams = new Set<string>();
  for (const repo of repos ?? []) {
    const team = repo?.team?.trim().toUpperCase();
    if (team && TEAM_KEY.test(team)) teams.add(team);
  }
  return teams.size > 0 ? [...teams].sort() : [...FALLBACK_TICKET_TEAMS];
}

/**
 * `\b(?:CLNT|OPS|WM)-\d{1,6}\b` for the configured teams. Longest key first so
 * a shorter prefix cannot win a partial match, and global so one pattern can
 * walk a whole string. Matching is case-insensitive because ticket ids are
 * canonicalised only after a free-text match is found.
 */
export function buildTicketPattern(teams: readonly string[]): RegExp {
  const keys = [
    ...new Set(
      teams
        .map((team) => team?.trim().toUpperCase())
        .filter((team): team is string => !!team && TEAM_KEY.test(team)),
    ),
  ].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const body = keys.length
    ? `\\b(?:${keys.join("|")})-\\d{1,${TICKET_REF_MAX_DIGITS}}\\b`
    : NEVER_MATCHES;
  return new RegExp(body, "gi");
}

/**
 * The configured ticket pattern, rebuilt whenever the repo list changes.
 *
 * Every custom cell in a table calls this, so it subscribes narrowly: the repo
 * list is shared with the rest of the app under one key, and a cell has no use
 * for fetch status — only for the answer.
 */
export function useTicketPattern(): RegExp {
  const reposQ = useQuery({
    queryKey: ["repos"],
    queryFn: api.repos,
    staleTime: 300_000,
    notifyOnChangeProps: ["data"],
  });
  return useMemo(
    () => buildTicketPattern(ticketTeamsFrom(reposQ.data?.repos)),
    [reposQ.data],
  );
}

export interface TicketSegment {
  text: string;
  /** The ticket id when this segment is a reference, null for plain prose. */
  ticket: string | null;
}

/**
 * Split free text into plain and ticket segments, in order. The caller's
 * pattern is re-created here rather than used directly: a global regex carries
 * `lastIndex` between calls, and a shared one would skip matches on its second
 * use.
 */
export function splitTicketRefs(
  text: string,
  pattern: RegExp,
): TicketSegment[] {
  const scanner = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const segments: TicketSegment[] = [];
  let cursor = 0;
  for (
    let match = scanner.exec(text);
    match !== null;
    match = scanner.exec(text)
  ) {
    if (match.index > cursor)
      segments.push({ text: text.slice(cursor, match.index), ticket: null });
    segments.push({ text: match[0], ticket: match[0].toUpperCase() });
    cursor = match.index + match[0].length;
    // A zero-width match would spin forever; the pattern cannot produce one,
    // but the loop should not depend on that.
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), ticket: null });
  return segments.length ? segments : [{ text, ticket: null }];
}

/**
 * The ticket journey source, shared with `views/Ticket.tsx` under one query key
 * so hovering a ticket and then opening it costs a single fetch.
 */
export async function fetchTicketJourney(
  ticketId: string,
): Promise<TicketJourneySource> {
  const response = await fetch(
    `/api/runs?ticket=${encodeURIComponent(ticketId)}`,
  );
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

/**
 * A ticket the runtime has no record of: Linear gave back neither a title nor
 * a state and nothing has ever run for it. Either it does not exist, or it
 * belongs to a team this factory does not dispatch.
 */
export function isUnindexedTicket(
  source: TicketJourneySource | undefined,
): boolean {
  return (
    !!source &&
    !source.activity &&
    source.ticket.title == null &&
    source.ticket.state == null
  );
}

const EMPTY = "—";

const FOOTER_LINK_CLASS =
  "cursor-pointer text-[11px] font-medium text-(--accent) hover:underline inline-flex items-center gap-1";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-(--text-faint)">{label}</span>
      <span className="mono truncate text-(--text-dim)">{children}</span>
    </div>
  );
}

export interface TicketHoverCardProps {
  ticketId: string;
  /** In-app navigation; without it the trigger is an ordinary hash link. */
  onNavigateTicket?: (ticketId: string) => void;
  /** Trigger content when the caller wants something other than the bare id. */
  children?: ReactNode;
  className?: string;
  title?: string;
}

/**
 * Hover card for a Linear ticket reference: identifier, state, title, the
 * latest run and PR, and the two jumps an operator wants from a table row —
 * the in-app journey and the ticket itself.
 *
 * The journey is fetched only once the card opens. A table of a hundred rows
 * naming a dozen tickets must not turn into a dozen requests on paint.
 */
export function TicketHoverCard({
  ticketId,
  onNavigateTicket,
  children,
  className,
  title,
}: TicketHoverCardProps) {
  const entity = resolveEntity("ticket", ticketId);
  const id = entity?.id ?? ticketId;
  const [open, setOpen] = useState(false);
  const journeyQ = useQuery({
    queryKey: ["ticket-journey", id],
    queryFn: () => fetchTicketJourney(id),
    enabled: open && entity != null,
    staleTime: 15_000,
  });

  const source = journeyQ.data;
  const latestRun = useMemo(() => {
    let latest: TicketJourneySource["runs"][number] | null = null;
    for (const run of source?.runs ?? []) {
      if (
        !latest ||
        Date.parse(run.run.created_at) >= Date.parse(latest.run.created_at)
      )
        latest = run;
    }
    return latest;
  }, [source]);
  const latestPr = useMemo(
    () => prNumbersIn(source?.runs ?? []).at(-1) ?? null,
    [source],
  );

  // A ticket cell usually sits in a clickable row, so the click never belongs
  // to the row. Without a navigation handler the anchor's own href still runs.
  const jump = (close: () => void) => (event?: ReactMouseEvent) => {
    event?.stopPropagation();
    if (!onNavigateTicket) return;
    event?.preventDefault();
    close();
    onNavigateTicket(id);
  };

  // An id that is not addressable (an empty or malformed key) gets no card and
  // no link — a hover target that leads nowhere is worse than plain text.
  if (!entity) return <>{children ?? ticketId}</>;

  const unknown = isUnindexedTicket(source);
  const prEntity = latestPr == null ? null : resolveEntity("pr", latestPr);
  const runEntity = latestRun
    ? resolveEntity("run", latestRun.run.runId)
    : null;

  return (
    <HoverCard
      label={`Ticket ${id}`}
      // The trigger is already a link, so the wrapper must not be a second tab
      // stop: one ticket id should cost one Tab, not two.
      focusable={false}
      onOpenChange={setOpen}
      trigger={({ close }) => (
        <a
          href={entity.href}
          onClick={jump(close)}
          title={title ?? `Open ticket journey for ${id}`}
          className={`mono text-(--accent) hover:underline ${className ?? ""}`}
        >
          {children ?? id}
        </a>
      )}
    >
      {({ close }) => (
        <>
          <div className="flex items-start justify-between gap-2 border-b border-(--border) pb-2.5">
            <span className="mono truncate text-[13px] font-semibold text-(--text)">
              {id}
            </span>
            {source?.ticket.state && <StateBadge state={source.ticket.state} />}
          </div>

          <div className="my-2.5 space-y-1.5 text-[11px]">
            {journeyQ.isPending ? (
              <div className="text-(--text-faint)">Loading {id}…</div>
            ) : journeyQ.isError ? (
              <div className="text-(--text-faint)">
                Cannot reach the control API:{" "}
                {(journeyQ.error as Error)?.message ?? "unavailable"}
              </div>
            ) : unknown ? (
              <div className="text-(--text-dim)">
                Unknown or external ticket — nothing in this runtime has ever
                named it.
              </div>
            ) : (
              <>
                <div className="break-words text-[12px] text-(--text)">
                  {source?.ticket.title ?? "title not recorded"}
                </div>
                <Row label="Latest run">
                  {runEntity && latestRun ? (
                    <a
                      href={runEntity.href}
                      onClick={() => close()}
                      className="hover:text-(--accent) hover:underline"
                    >
                      {latestRun.run.runId} · {latestRun.run.state}
                    </a>
                  ) : (
                    EMPTY
                  )}
                </Row>
                <Row label="Latest PR">
                  {prEntity ? (
                    <a
                      href={prEntity.href}
                      onClick={() => close()}
                      className="hover:text-(--accent) hover:underline"
                    >
                      #{prEntity.id}
                    </a>
                  ) : (
                    EMPTY
                  )}
                </Row>
              </>
            )}
          </div>

          <div className="flex justify-between gap-3 border-t border-(--border) pt-2">
            <a
              href={entity.href}
              onClick={jump(close)}
              className={FOOTER_LINK_CLASS}
            >
              Open journey <span aria-hidden="true">→</span>
            </a>
            {source?.ticket.url && (
              <a
                href={source.ticket.url}
                target="_blank"
                rel="noreferrer"
                onClick={() => close()}
                className={FOOTER_LINK_CLASS}
              >
                Linear <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
        </>
      )}
    </HoverCard>
  );
}

export interface TicketTextProps {
  text: string;
  /** Override the configured pattern; the views never need to. */
  pattern?: RegExp;
  onNavigateTicket?: (ticketId: string) => void;
  className?: string;
}

/**
 * Free text with every configured ticket id turned into a hover-card link and
 * everything else left exactly as written.
 */
export function TicketText({
  text,
  pattern,
  onNavigateTicket,
  className,
}: TicketTextProps) {
  const configured = useTicketPattern();
  const active = pattern ?? configured;
  const segments = useMemo(() => splitTicketRefs(text, active), [text, active]);
  if (!segments.some((segment) => segment.ticket)) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.ticket ? (
          <TicketHoverCard
            key={`${index}:${segment.ticket}`}
            ticketId={segment.ticket}
            onNavigateTicket={onNavigateTicket}
            className={className}
          >
            {segment.text}
          </TicketHoverCard>
        ) : (
          <Fragment key={`${index}:text`}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Subject journeys (WM-595 tickets, WM-640 PRs): one chronological timeline
 * per subject, built purely from the runtime's own records — events,
 * proposals, runs and their result artifacts, open inbox items, and the
 * schedule registry. Nothing here fetches; the views assemble a
 * `SubjectJourneySource` and hand it over.
 */

import { nextScheduledRetry, scheduledRetryLabel } from "./chainTimeline";
import { REASONS, humanizeReason } from "./reasons";

export const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** `#541`, `PR 541`, `pr:541`, `pull/541`, `541` — what an operator types for a PR. */
export const PR_REF_PATTERN = /^(?:#|pr[:#\s-]?|pull\/)?(\d{1,7})$/i;

/** Parse an operator-typed PR reference (`#541`, `PR 541`, `pr:541`) to its number. */
export function parsePrRef(input: string): number | null {
  const match = input.trim().match(PR_REF_PATTERN);
  if (!match) return null;
  // A bare number is only a PR reference when the operator wrote a PR marker;
  // otherwise `541` could be anything (an inbox count, a run attempt).
  if (/^\d+$/.test(input.trim())) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** Decorate exact ticket string tokens produced by JSON/detail renderers. */
export function installTicketJourneyLinks(
  root: HTMLElement,
  open: (ticket: string) => void,
): () => void {
  const decorate = () => {
    for (const span of root.querySelectorAll<HTMLSpanElement>("span")) {
      if (span.childElementCount > 0 || span.dataset.ticketJourneyId) continue;
      const ticket = (span.textContent ?? "")
        .trim()
        .replace(/^([\"'])|([\"'])$/g, "")
        .toUpperCase();
      if (!TICKET_ID_PATTERN.test(ticket)) continue;
      span.dataset.ticketJourneyId = ticket;
      span.setAttribute("role", "link");
      span.tabIndex = 0;
      span.setAttribute("aria-label", `Open ticket ${ticket}`);
      span.title = `Open ticket journey for ${ticket}`;
      span.classList.add(
        "cursor-pointer",
        "hover:text-(--accent)",
        "hover:underline",
      );
    }
  };
  const ticketTarget = (
    target: EventTarget | null,
  ): { element: HTMLElement; ticket: string } | null => {
    const element =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-ticket-journey-id], button")
        : null;
    if (!element) return null;
    const dataTicket = element.dataset.ticketJourneyId;
    const ticket = (dataTicket ?? element.textContent ?? "")
      .trim()
      .toUpperCase();
    const exactCopyButton =
      element.tagName === "BUTTON" &&
      element.title.trim().toUpperCase() === ticket;
    return (dataTicket || exactCopyButton) && TICKET_ID_PATTERN.test(ticket)
      ? { element, ticket }
      : null;
  };
  const onClick = (event: MouseEvent) => {
    const target = ticketTarget(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    open(target.ticket);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = event.target instanceof HTMLElement ? event.target : null;
    const ticket = element?.dataset.ticketJourneyId;
    if (!ticket) return;
    event.preventDefault();
    event.stopPropagation();
    open(ticket);
  };
  decorate();
  const observer = new MutationObserver(decorate);
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener("click", onClick, true);
  root.addEventListener("keydown", onKey, true);
  return () => {
    observer.disconnect();
    root.removeEventListener("click", onClick, true);
    root.removeEventListener("keydown", onKey, true);
  };
}

export type SubjectKind = "ticket" | "pr";

/** The `/api/runs?ticket=` response — the server-side ticket join (WM-595). */
export interface TicketJourneySource {
  ticket: {
    id: string;
    title: string | null;
    state: string | null;
    createdAt: string | null;
    url: string;
  };
  activity: boolean;
  events: JourneyEvent[];
  proposals: JourneyProposal[];
  runs: JourneyRun[];
}

/** One comment from `GET /tickets/:id/detail` (WM-914). */
export interface TicketTrackerComment {
  id: string | null;
  body: string;
  createdAt: string | null;
  user: { id?: string | null; name?: string | null } | null;
}

/** Live tracker snapshot from `GET /tickets/:id/detail` (WM-914). */
export interface TicketTrackerDetail {
  ticket: {
    id: string;
    identifier: string;
    title: string | null;
    state: string | null;
    description: string;
    url: string;
    assignee: { name?: string | null } | null;
  };
  comments: TicketTrackerComment[];
  fetchedAt: string;
  cached: boolean;
}

/** Overlay live tracker title/state/url onto a runtime-built ticket journey. */
export function overlayTrackerDetail(
  journey: SubjectJourney,
  detail: TicketTrackerDetail | null | undefined,
): SubjectJourney {
  if (!detail?.ticket || journey.subject.kind !== "ticket") return journey;
  const title =
    typeof detail.ticket.title === "string" && detail.ticket.title.trim()
      ? detail.ticket.title.trim()
      : journey.subject.title;
  const state =
    typeof detail.ticket.state === "string" && detail.ticket.state.trim()
      ? detail.ticket.state.trim()
      : journey.subject.state;
  const url =
    typeof detail.ticket.url === "string" && detail.ticket.url.trim()
      ? detail.ticket.url.trim()
      : journey.subject.url;
  if (
    title === journey.subject.title &&
    state === journey.subject.state &&
    url === journey.subject.url
  ) {
    return journey;
  }
  return {
    ...journey,
    subject: { ...journey.subject, title, state, url },
  };
}

export interface JourneyEvent {
  source: string;
  eventId: string;
  type: string;
  subject: string | null;
  status: string;
  occurredAt: string;
  admittedAt: string;
  proposalId: string | null;
  runId: string | null;
  correlationId?: string | null;
  envelope: Record<string, unknown>;
}

export interface JourneyProposal {
  id: string;
  decision: string;
  status: string;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  runId: string | null;
  eventId: string | null;
  eventSource: string | null;
  agent: string | null;
  spec: { input?: unknown } | null;
}

export interface JourneyLifecycle {
  seq: number;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  attempt: number | null;
  at: string;
}

export interface JourneyRun {
  run: {
    runId: string;
    state: string;
    attempts: number;
    created_at: string;
    updated_at: string;
    spec: {
      agent: string;
      adapter: string;
      input?: unknown;
      model?: string | null;
      modelTier?: string | null;
    };
  };
  lifecycle: JourneyLifecycle[];
  result: Record<string, any> | null;
  usage?: {
    totals?: { attempts?: number; totalTokens?: number; costUSD?: number };
    attempts?: unknown[];
  };
}

/** Open inbox item naming the subject (`refs.pr` / `refs.issue`). */
export interface JourneyInboxItem {
  id: string;
  kind: string;
  title: string;
  createdAt: string;
  refs: { pr?: string; issue?: string; runId?: string; repo?: string };
}

/** A schedule registry row — only the fields the `next:` row needs. */
export interface JourneySchedule {
  loop: string;
  repo: string | null;
  eventType: string;
  nextDue: string | null;
  enabled: boolean;
}

export interface SubjectRef {
  kind: SubjectKind;
  /** `WM-627` or `541`. */
  id: string;
  title: string | null;
  state: string | null;
  createdAt: string | null;
  url: string;
}

export interface SubjectJourneySource {
  subject: SubjectRef;
  activity: boolean;
  events: JourneyEvent[];
  proposals: JourneyProposal[];
  runs: JourneyRun[];
  inbox?: JourneyInboxItem[];
  schedules?: JourneySchedule[];
  /**
   * Runs from other chains that touched the subject's ticket but are not the
   * subject's own story (a dispatch of the PR's ticket that produced no PR
   * artifact). Only the concurrent `↔` rows read them; they never count as
   * runs, cost, or lead time.
   */
  contextRuns?: JourneyRun[];
}

export type TimelineKind =
  | "linear"
  | "event"
  | "decision"
  | "run"
  | "pr"
  | "ci"
  | "merge"
  | "concurrent"
  | "schedule";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  at: string;
  label: string;
  detail: string | null;
  href: string;
  external?: boolean;
  durationMs: number | null;
  children?: TimelineItem[];
}

export interface SubjectJourney {
  subject: SubjectRef;
  /** For PR journeys: the repo (`owner/name`), ticket, branch and merge state the artifacts recorded. */
  pr: {
    number: number;
    github: string | null;
    ticket: string | null;
    headRef: string | null;
    mergeState: string | null;
    url: string | null;
  } | null;
  activity: boolean;
  timeline: TimelineItem[];
  totalCost: number | null;
  totalTokens: number | null;
  leadTimeMs: number | null;
  runCount: number;
  prUrls: string[];
  currentRun: { runId: string; state: string; actor: string | null } | null;
  blockingReason: string | null;
  nextAction: string;
  /** The schedule that will next revisit the subject, when one is registered. */
  nextVisit: { loop: string; at: string } | null;
}

/** @deprecated name kept for the WM-595 callers — same shape as `SubjectJourney`. */
export type TicketJourney = SubjectJourney;

function reasonText(reason: string | null | undefined): string | null {
  const human = humanizeReason(reason);
  if (!human.raw) return null;
  // A PR journey anchors this refusal to the scan that observed the old head.
  return reason?.split(":", 1)[0] === "merge_fix_pr_moved"
    ? human.text.replace("since the plan", "since the scan")
    : human.text;
}

/** `Human text (raw_code)` — for refusal rows, where the code is the search key. */
function humanizeWithCode(reason: string | null | undefined): string | null {
  const text = reasonText(reason);
  if (!text || !reason) return null;
  const code = reason.split(":")[0];
  return REASONS[code] ? `${text} (${code})` : text;
}

function validDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function timeOf(
  value: string | null | undefined,
  fallback = "1970-01-01T00:00:00.000Z",
): string {
  return validDate(value) == null ? fallback : value!;
}

function eventHref(event: Pick<JourneyEvent, "source" | "eventId">): string {
  return `#/events/${encodeURIComponent(event.source)}/${encodeURIComponent(event.eventId)}`;
}

function runHref(runId: string): string {
  return `#/run/${encodeURIComponent(runId)}`;
}

/** Hash route of a PR journey. */
export function prHref(number: number | string): string {
  return `#/prs/${encodeURIComponent(String(number))}`;
}

function walk(
  value: unknown,
  visit: (key: string, value: unknown) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    visit(key, entry);
    walk(entry, visit);
  }
}

export function ticketIdsIn(value: unknown): string[] {
  const ids = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const normalized = candidate.trim().toUpperCase();
    if (TICKET_ID_PATTERN.test(normalized)) ids.add(normalized);
  };
  if (typeof value === "string") add(value);
  walk(value, (key, entry) => {
    if (/^(ticket|ticketId|issue|issueId|linearId|subject)$/i.test(key))
      add(entry);
  });
  return [...ids];
}

/**
 * PR numbers a record names structurally: `pr`/`prNumber` fields, `PR#541`
 * inbox refs, and `github.com/<owner>/<repo>/pull/<n>` URLs — never prose.
 */
export function prNumbersIn(value: unknown): number[] {
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
  walk(value, inspect);
  return [...numbers];
}

function prUrlsIn(value: unknown): string[] {
  const urls = new Set<string>();
  const inspect = (entry: unknown) => {
    if (typeof entry !== "string") return;
    if (
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:$|[/?#])/.test(entry)
    )
      urls.add(entry);
  };
  inspect(value);
  walk(value, (_key, entry) => inspect(entry));
  return [...urls];
}

function prNumber(url: string): string {
  return url.match(/\/pull\/(\d+)/)?.[1] ?? url;
}

function nestedValue(value: unknown, keyPattern: RegExp): unknown {
  let found: unknown;
  walk(value, (key, entry) => {
    if (found === undefined && keyPattern.test(key)) found = entry;
  });
  return found;
}

function githubOf(value: unknown): string | null {
  const github = nestedValue(value, /^github$/i);
  return typeof github === "string" && /^[^/]+\/[^/]+$/.test(github)
    ? github
    : null;
}

function shortSha(sha: unknown): string | null {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha)
    ? sha.slice(0, 7)
    : null;
}

function eventPr(event: JourneyEvent): { number: number; url: string } | null {
  const number = Number(
    nestedValue(event.envelope, /^(pr|prNumber|pullRequestNumber)$/i),
  );
  if (!Number.isInteger(number) || number <= 0) return null;
  const github = githubOf(event.envelope);
  if (!github) return null;
  return { number, url: `https://github.com/${github}/pull/${number}` };
}

function lifecycleSorted(run: JourneyRun): JourneyLifecycle[] {
  return [...run.lifecycle].sort(
    (a, b) => a.at.localeCompare(b.at) || a.seq - b.seq,
  );
}

function resultAt(run: JourneyRun): string {
  return (
    lifecycleSorted(run).at(-1)?.at ?? run.run.updated_at ?? run.run.created_at
  );
}

function runWindow(run: JourneyRun): { start: number; end: number } | null {
  const lifecycle = lifecycleSorted(run);
  const start = validDate(lifecycle[0]?.at ?? run.run.created_at);
  const end = validDate(lifecycle.at(-1)?.at ?? run.run.updated_at);
  return start != null && end != null && end >= start ? { start, end } : null;
}

function runDuration(run: JourneyRun): number | null {
  const window = runWindow(run);
  return window ? window.end - window.start : null;
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ""}`;
}

function clock(value: string | number): string {
  const ms = typeof value === "number" ? value : validDate(value);
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function lifecycleChildren(run: JourneyRun): TimelineItem[] {
  return lifecycleSorted(run).map((entry, index, all) => {
    const previous = index ? validDate(all[index - 1].at) : null;
    const current = validDate(entry.at);
    return {
      id: `${run.run.runId}:lifecycle:${entry.seq}`,
      kind: "run" as const,
      at: entry.at,
      label: entry.to_state,
      detail: `${entry.actor}${entry.reason ? ` · ${entry.reason}` : ""}`,
      href: runHref(run.run.runId),
      durationMs:
        previous != null && current != null
          ? Math.max(0, current - previous)
          : null,
    };
  });
}

function proposalFor(
  event: JourneyEvent,
  proposals: JourneyProposal[],
): JourneyProposal | undefined {
  return proposals.find(
    (proposal) =>
      proposal.id === event.proposalId ||
      (proposal.eventId === event.eventId &&
        proposal.eventSource === event.source),
  );
}

function mergeLabel(run: JourneyRun): string | null {
  const artifact = run.result?.artifact ?? run.result ?? {};
  const text = JSON.stringify(artifact);
  const agent = run.run.spec.agent ?? "";
  if (!/merge/i.test(agent) && !/merge|escalate/i.test(text)) return null;
  if (/escalate/i.test(text)) return "merge-scan: ESCALATE";
  if (/merged/i.test(text)) return "merged";
  if (/merge/i.test(text)) return "merge-scan: MERGE";
  return null;
}

function checkLabel(
  run: JourneyRun,
): { label: string; detail: string | null } | null {
  const artifact = run.result?.artifact ?? {};
  let checksGreen: boolean | null = null;
  walk(artifact, (key, value) => {
    if (/^(checksGreen|ciGreen)$/i.test(key) && typeof value === "boolean")
      checksGreen = value;
  });
  if (checksGreen == null) return null;
  return {
    label: checksGreen ? "CI checks green" : "CI checks red",
    detail: checksGreen
      ? "All recorded checks passed"
      : "One or more recorded checks failed",
  };
}

const RUN_FAMILY = {
  scan: /^merge-scan/,
  fix: /^merge-fix/,
  apply: /^merge-apply/,
  merge: /^merge-/,
} as const;

function agentShort(agent: string | null | undefined): string {
  return (agent ?? "run").replace(/@.*$/, "");
}

/** Per-PR verdict a merge-scan artifact recorded: which bucket, at which head, why. */
export interface ScanVerdict {
  bucket: "MERGE" | "FIX" | "ESCALATE";
  headSha: string | null;
  headRef: string | null;
  ticket: string | null;
  mergeable: boolean | null;
  reason: string | null;
  round: number | null;
}

type ArtifactPrEntry = Record<string, unknown>;

function isArtifactPrEntry(value: unknown): value is ArtifactPrEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function scanVerdictFor(
  artifact: unknown,
  pr: number,
): ScanVerdict | null {
  if (!isArtifactPrEntry(artifact)) return null;
  const buckets: Array<[ScanVerdict["bucket"], string]> = [
    ["MERGE", "plan"],
    ["FIX", "fix"],
    ["ESCALATE", "escalate"],
  ];
  for (const [bucket, key] of buckets) {
    const list = artifact[key];
    if (!Array.isArray(list)) continue;
    const entry = list.find(
      (item): item is ArtifactPrEntry =>
        isArtifactPrEntry(item) && Number(item.pr) === pr,
    );
    if (!entry) continue;
    return {
      bucket,
      headSha: typeof entry.headSha === "string" ? entry.headSha : null,
      headRef: typeof entry.headRef === "string" ? entry.headRef : null,
      ticket:
        typeof entry.ticket === "string" ? entry.ticket.toUpperCase() : null,
      mergeable: typeof entry.mergeable === "boolean" ? entry.mergeable : null,
      reason:
        typeof entry.reason === "string"
          ? entry.reason
          : typeof entry.finding === "string"
            ? entry.finding
            : null,
      round: typeof entry.round === "number" ? entry.round : null,
    };
  }
  return null;
}

/** GitHub's own vocabulary when a scan artifact quotes it; `mergeable` when it only recorded the boolean. */
function mergeStateOf(verdict: ScanVerdict): string | null {
  const quoted = verdict.reason?.match(
    /\b(CONFLICTING|MERGEABLE|UNSTABLE|DIRTY|BLOCKED|BEHIND|CLEAN|DRAFT)\b/,
  );
  if (quoted) return quoted[1];
  if (verdict.mergeable === true) return "MERGEABLE";
  if (verdict.mergeable === false) return "NOT MERGEABLE";
  return null;
}

/** A refused or failed run, with the code the runtime recorded for it. */
function refusalOf(
  run: JourneyRun,
): { verb: "refused" | "failed"; code: string; at: string } | null {
  const terminal = String(run.result?.terminalState ?? "");
  const verb =
    run.run.state === "REFUSED" || /refused/i.test(terminal)
      ? "refused"
      : run.run.state === "FAILED" || /failed/i.test(terminal)
        ? "failed"
        : null;
  if (!verb) return null;
  const code: string | null =
    run.result?.reasonCode ?? lifecycleSorted(run).at(-1)?.reason ?? null;
  return { verb, code: code ?? verb, at: resultAt(run) };
}

/** The object inside `value` that names `pr` (`{pr: 541, headSha, …}`), else the value itself when it names the PR another way. */
function prEntryIn(value: unknown, pr: number): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const visit = (candidate: unknown) => {
    if (found || !candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (Number(record.pr) === pr || Number(record.prNumber) === pr) {
      found = record;
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  if (found) return found;
  return prNumbersIn(value).includes(pr) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ticketOfRun(run: JourneyRun): string | null {
  return (
    ticketIdsIn(run.run.spec.input)[0] ??
    ticketIdsIn(run.result?.artifact)[0] ??
    null
  );
}

function repoOfSource(source: SubjectJourneySource): string | null {
  for (const run of source.runs) {
    const repo = nestedValue(run.run.spec.input, /^repo$/i);
    if (typeof repo === "string" && repo) return repo;
  }
  for (const event of source.events) {
    const repo = nestedValue(event.envelope, /^repo$/i);
    if (typeof repo === "string" && repo) return repo;
  }
  return null;
}

/**
 * Rows from other chains that touched the subject while a scan or fix was
 * looking at it (WM-640). Sources are only what is already recorded: run
 * lifecycles (the overlap itself), dispatch result artifacts (`prUrl`,
 * `headSha`) — no new recording. Rendered muted with a `↔` prefix so the
 * refusal they explain reads directly under them.
 */
function concurrentRows(
  source: SubjectJourneySource,
  prOfSubject: number | null,
  subjectTicket: string | null,
): TimelineItem[] {
  const rows: TimelineItem[] = [];
  const windows = source.runs
    .filter(
      (run) =>
        RUN_FAMILY.scan.test(run.run.spec.agent) ||
        RUN_FAMILY.fix.test(run.run.spec.agent),
    )
    .map((run) => ({ run, window: runWindow(run) }))
    .filter(
      (
        entry,
      ): entry is { run: JourneyRun; window: { start: number; end: number } } =>
        entry.window != null,
    );
  if (!windows.length) return rows;
  const seen = new Set<string>();
  const others = [...source.runs, ...(source.contextRuns ?? [])].filter(
    (run) => {
      if (seen.has(run.run.runId) || RUN_FAMILY.merge.test(run.run.spec.agent))
        return false;
      seen.add(run.run.runId);
      // Only chains that touched *this* subject: the subject's own ticket, or a
      // run whose result names the PR. The server-side ticket join can carry
      // neighbours (other tickets' dispatches sharing a scan) — they are not
      // concurrent activity on this subject.
      const ticket = ticketOfRun(run);
      if (subjectTicket && ticket === subjectTicket) return true;
      return (
        prOfSubject != null && prNumbersIn(run.result).includes(prOfSubject)
      );
    },
  );
  for (const { run: windowRun, window } of windows) {
    for (const other of others) {
      const span = runWindow(other);
      if (!span || span.end < window.start || span.start > window.end) continue;
      const artifact = other.result?.artifact ?? null;
      const ticket = ticketOfRun(other);
      const who = `${ticket ? `${ticket} ` : ""}${agentShort(other.run.spec.agent)}`;
      const pushed = shortSha(
        nestedValue(artifact, /^(headSha|pushedSha|commitSha)$/i),
      );
      const openedUrl = prUrlsIn(artifact).find(
        (url) => prOfSubject == null || Number(prNumber(url)) === prOfSubject,
      );
      const finishedAt = validDate(resultAt(other));
      const insideWindow =
        finishedAt != null &&
        finishedAt >= window.start &&
        finishedAt <= window.end;
      let at: number;
      let label: string;
      let detail: string;
      if (pushed && insideWindow) {
        at = finishedAt!;
        label = `↔ ${who} pushed ${pushed} (${other.run.runId})`;
        detail = `While ${agentShort(windowRun.run.spec.agent)} ${windowRun.run.runId} was looking at this subject`;
      } else if (openedUrl && insideWindow) {
        at = finishedAt!;
        label = `↔ ${who} opened PR #${prNumber(openedUrl)} (${other.run.runId})`;
        detail = `While ${agentShort(windowRun.run.spec.agent)} ${windowRun.run.runId} was looking at this subject`;
      } else {
        // The overlap is the evidence: place the row just inside the window so
        // it reads under the scan/fix row that it explains.
        at = Math.max(span.start, window.start) + 1;
        const live = /QUEUED|LEASED|RUNNING|VERIFYING/.test(other.run.state);
        label = `↔ ${who} ${other.run.runId} was active during ${agentShort(windowRun.run.spec.agent)}`;
        detail = `${clock(span.start)} → ${live ? "now" : clock(span.end)} · ${other.run.state.toLowerCase()}${pushed ? ` · head ${pushed}` : ""}`;
      }
      rows.push({
        id: `concurrent:${windowRun.run.runId}:${other.run.runId}`,
        kind: "concurrent",
        at: new Date(at).toISOString(),
        label,
        detail,
        href: runHref(other.run.runId),
        durationMs: null,
      });
    }
  }
  return rows;
}

/** Pure chronological join used by the views and fixture tests. */
export function subjectJourney(
  kind: SubjectKind,
  id: string,
  source: SubjectJourneySource,
): SubjectJourney {
  const subject: SubjectRef = { ...source.subject, kind, id };
  const prOfSubject = kind === "pr" ? Number(id) : null;
  const timeline: TimelineItem[] = [];
  const resultPrUrls = new Set(
    source.runs.flatMap((run) => prUrlsIn(run.result)),
  );
  const prUrls = new Set(resultPrUrls);
  const renderedPrUrls = new Set<string>();
  const allActivityTimes = [
    ...source.events.flatMap((event) => [event.occurredAt, event.admittedAt]),
    ...source.proposals.flatMap((proposal) => [
      proposal.created_at,
      proposal.decided_at ?? "",
    ]),
    ...source.runs.flatMap((run) => [run.run.created_at, run.run.updated_at]),
  ].filter((value) => validDate(value) != null);
  const earliest = [...allActivityTimes].sort()[0] ?? null;

  let prGithub: string | null = null;
  let prTicket: string | null = null;
  let prHeadRef: string | null = null;
  let prMergeState: string | null = null;
  let prMergeStateAt = -Infinity;

  if (kind === "ticket" && subject.createdAt) {
    timeline.push({
      id: `${subject.id}:filed`,
      kind: "linear",
      at: subject.createdAt,
      label: "filed",
      detail: subject.title,
      href: subject.url,
      external: true,
      durationMs: null,
    });
  }

  for (const event of source.events) {
    const proposal = proposalFor(event, source.proposals);
    const decision =
      proposal?.decision ??
      (event.status === "planned" ? "planned" : event.status);
    const reason = reasonText(proposal?.reason);
    const dispatch = /dispatch/i.test(event.type);
    const agentReady =
      /agent[-_. ]?ready/i.test(event.type) ||
      /agent[-_. ]?ready/i.test(JSON.stringify(event.envelope));
    const at = timeOf(event.occurredAt, event.admittedAt);
    const eventPrRef = eventPr(event);
    const prEntry =
      kind === "pr" ? prEntryIn(event.envelope, prOfSubject!) : null;
    const eventHead = shortSha(
      prEntry ? prEntry.headSha : nestedValue(event.envelope, /^headSha$/i),
    );
    if (prEntry) {
      prGithub ??= githubOf(event.envelope);
      prTicket ??=
        ticketIdsIn(prEntry)[0] ??
        ticketIdsIn(nestedValue(event.envelope, /^payload$/i))[0] ??
        null;
      if (typeof prEntry.headRef === "string") prHeadRef ??= prEntry.headRef;
    }
    const typeLabel = agentReady
      ? "agent-ready"
      : dispatch
        ? "dispatch requested"
        : event.type
            .replace(/^factory\./, "")
            .replace(/\.requested$/, " requested");
    const prSuffix =
      kind === "pr" && prEntry && eventHead
        ? ` · at ${eventHead}`
        : eventPrRef && kind === "ticket"
          ? ` · PR #${eventPrRef.number}${eventHead ? ` at ${eventHead}` : ""}`
          : "";
    timeline.push({
      id: `event:${event.source}:${event.eventId}`,
      kind: proposal ? "decision" : "event",
      at,
      label: `${typeLabel}${prSuffix}`,
      detail: proposal
        ? `${decision}${reason ? ` · ${reason}` : ""}`
        : event.status,
      href: eventHref(event),
      durationMs: null,
    });

    if (eventPrRef) {
      const knownUrl = [...resultPrUrls].find(
        (url) => prNumber(url) === String(eventPrRef.number),
      );
      const url = knownUrl ?? eventPrRef.url;
      prUrls.add(url);
      if (kind === "ticket" && !knownUrl && !renderedPrUrls.has(url)) {
        renderedPrUrls.add(url);
        timeline.push({
          id: `pr:${url}`,
          kind: "pr",
          at,
          label: `PR #${eventPrRef.number} referenced`,
          detail: null,
          href: prHref(eventPrRef.number),
          durationMs: null,
        });
      }
    }
    // On a PR journey the scan artifact already carries the CI verdict and the
    // merge decision for this PR; repeating them from the request event that
    // copies the plan would double every row.
    const checksGreen =
      kind === "pr"
        ? null
        : nestedValue(event.envelope, /^(checksGreen|ciGreen)$/i);
    if (typeof checksGreen === "boolean") {
      timeline.push({
        id: `ci:event:${event.source}:${event.eventId}`,
        kind: "ci",
        at,
        label: checksGreen ? "CI checks green" : "CI checks red",
        detail: "Recorded by the merge plan",
        href: eventHref(event),
        durationMs: null,
      });
    }
    const action = nestedValue(event.envelope, /^action$/i);
    const landed = /merge-landed/i.test(event.type);
    // Only decisions to merge are merge rows; scan ticks, fix and escalate
    // requests already have their own event row.
    if (
      landed ||
      (kind === "ticket" &&
        (/merge-apply/i.test(event.type) ||
          (typeof action === "string" && /merge/i.test(action))))
    ) {
      const mergeSha = shortSha(
        nestedValue(event.envelope, /^mergeCommitSha$/i),
      );
      timeline.push({
        id: `merge:event:${event.source}:${event.eventId}`,
        kind: "merge",
        at,
        label: landed
          ? `merged${mergeSha ? ` as ${mergeSha}` : ""}`
          : action === "merge_pr"
            ? "merge requested"
            : "merge decision",
        detail:
          (nestedValue(event.envelope, /^reason$/i) as string | undefined) ??
          null,
        href: eventHref(event),
        durationMs: null,
      });
    }
  }

  let totalCost = 0;
  let totalTokens = 0;
  let usageKnown = false;
  const activeStates = new Set(["QUEUED", "LEASED", "RUNNING", "VERIFYING"]);
  let currentRun: SubjectJourney["currentRun"] = null;

  for (const run of source.runs) {
    const totals = run.usage?.totals;
    const attempts = totals?.attempts ?? run.usage?.attempts?.length ?? 0;
    if (
      attempts > 0 ||
      (totals?.costUSD ?? 0) > 0 ||
      (totals?.totalTokens ?? 0) > 0
    ) {
      usageKnown = true;
      totalCost += Number(totals?.costUSD ?? 0);
      totalTokens += Number(totals?.totalTokens ?? 0);
    }
    const duration = runDuration(run);
    const model = run.run.spec.model ?? run.run.spec.modelTier ?? null;
    const detail = [
      run.run.spec.agent,
      run.run.spec.adapter,
      model,
      formatDuration(duration),
      attempts > 0 ? `$${Number(totals?.costUSD ?? 0).toFixed(2)}` : "—",
    ]
      .filter(Boolean)
      .join(" · ");
    timeline.push({
      id: `run:${run.run.runId}`,
      kind: "run",
      at: timeOf(run.run.created_at),
      label: `${run.run.runId} · ${run.run.state}`,
      detail,
      href: runHref(run.run.runId),
      durationMs: null,
      children: lifecycleChildren(run),
    });

    const artifact = run.result?.artifact ?? null;
    if (kind === "pr") {
      prGithub ??= githubOf(run.run.spec.input) ?? githubOf(artifact);
      const inputPrs = prNumbersIn(run.run.spec.input);
      if (inputPrs.includes(prOfSubject!)) {
        prTicket ??= ticketOfRun(run);
        const headRef = nestedValue(run.run.spec.input, /^headRef$/i);
        if (typeof headRef === "string") prHeadRef ??= headRef;
      }
    }

    for (const url of prUrlsIn(run.result)) {
      prUrls.add(url);
      if (renderedPrUrls.has(url)) continue;
      renderedPrUrls.add(url);
      const number = Number(prNumber(url));
      if (kind === "pr" && number !== prOfSubject) continue;
      if (kind === "pr") prTicket ??= ticketOfRun(run);
      timeline.push({
        id: `pr:${url}`,
        kind: "pr",
        at: resultAt(run),
        label: `PR #${prNumber(url)} opened`,
        detail:
          kind === "pr"
            ? `by ${ticketOfRun(run) ?? agentShort(run.run.spec.agent)} · ${run.run.runId}`
            : null,
        href: kind === "pr" ? url : prHref(number),
        external: kind === "pr",
        durationMs: null,
      });
    }
    const ci =
      kind === "pr"
        ? checkLabel({
            ...run,
            result: { artifact: prEntryIn(artifact, prOfSubject!) ?? {} },
          })
        : checkLabel(run);
    if (ci) {
      timeline.push({
        id: `ci:${run.run.runId}`,
        kind: "ci",
        at: resultAt(run),
        label: ci.label,
        detail: ci.detail,
        href: runHref(run.run.runId),
        durationMs: null,
      });
    }
    const verdict =
      kind === "pr" && RUN_FAMILY.scan.test(run.run.spec.agent)
        ? scanVerdictFor(artifact, prOfSubject!)
        : null;
    if (verdict) {
      const head = shortSha(verdict.headSha);
      prTicket ??= verdict.ticket;
      prHeadRef ??= verdict.headRef;
      const state = mergeStateOf(verdict);
      const when = validDate(resultAt(run)) ?? -Infinity;
      if (state && when >= prMergeStateAt) {
        prMergeState = state;
        prMergeStateAt = when;
      }
      timeline.push({
        id: `merge:${run.run.runId}`,
        kind: "merge",
        at: resultAt(run),
        label: `merge-scan: ${verdict.bucket}${head ? ` · reviewed at ${head}` : ""}${verdict.round != null ? ` · round ${verdict.round}` : ""}`,
        detail: verdict.reason,
        href: runHref(run.run.runId),
        durationMs: null,
      });
    } else if (kind === "ticket") {
      const merge = mergeLabel(run);
      if (merge) {
        timeline.push({
          id: `merge:${run.run.runId}`,
          kind: "merge",
          at: resultAt(run),
          label: merge,
          detail: run.result?.reasonCode ?? null,
          href: runHref(run.run.runId),
          durationMs: null,
        });
      }
    } else if (
      RUN_FAMILY.apply.test(run.run.spec.agent) &&
      artifact &&
      /merge_pr/.test(JSON.stringify(artifact))
    ) {
      timeline.push({
        id: `merge:${run.run.runId}`,
        kind: "merge",
        at: resultAt(run),
        label: "merge applied",
        detail: run.result?.reasonCode ?? null,
        href: runHref(run.run.runId),
        durationMs: null,
      });
    }
    const refusal = refusalOf(run);
    if (refusal) {
      const reason = (humanizeWithCode(refusal.code) ?? refusal.code).replace(
        /\s+/g,
        " ",
      );
      timeline.push({
        id: `refusal:${run.run.runId}`,
        kind: "decision",
        at: refusal.at,
        label: `${agentShort(run.run.spec.agent)} ${refusal.verb} · ${reason.length > 160 ? `${reason.slice(0, 159)}…` : reason}`,
        detail:
          reason.length > 160 ? `${run.run.runId} · ${reason}` : run.run.runId,
        href: runHref(run.run.runId),
        durationMs: null,
      });
    }
    if (activeStates.has(run.run.state)) {
      const last = lifecycleSorted(run).at(-1);
      currentRun = {
        runId: run.run.runId,
        state: run.run.state,
        actor: last?.actor ?? null,
      };
    }
  }

  for (const item of source.inbox ?? []) {
    timeline.push({
      id: `inbox:${item.id}`,
      kind: "ci",
      at: item.createdAt,
      label: `${item.kind}: ${item.title.length > 96 ? `${item.title.slice(0, 95)}…` : item.title}`,
      detail: "Open inbox item",
      href: `#/inbox/${encodeURIComponent(item.id)}`,
      durationMs: null,
    });
  }

  timeline.push(
    ...concurrentRows(
      source,
      prOfSubject,
      kind === "ticket" ? subject.id : prTicket,
    ),
  );

  if (kind === "ticket" && /^done$/i.test(subject.state ?? "")) {
    const at =
      timeline
        .map((item) => item.at)
        .filter((value) => validDate(value) != null)
        .sort()
        .at(-1) ?? earliest;
    if (at) {
      timeline.push({
        id: `${subject.id}:done`,
        kind: "linear",
        at,
        label: "Done",
        detail: null,
        href: subject.url,
        external: true,
        durationMs: null,
      });
    }
  }

  timeline.sort((a, b) => {
    const diff = (validDate(a.at) ?? 0) - (validDate(b.at) ?? 0);
    return diff || a.id.localeCompare(b.id);
  });

  const latestNoop = [...source.proposals]
    .filter((proposal) => proposal.decision === "noop")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);

  const repo = repoOfSource(source);
  const loopType =
    kind === "pr"
      ? /^factory\.merge\.requested$/
      : /^factory\.(work|dispatch)\.requested$/;
  const retryOriginType =
    [...source.events]
      .filter((event) => loopType.test(event.type))
      .sort((a, b) =>
        timeOf(a.occurredAt, a.admittedAt).localeCompare(
          timeOf(b.occurredAt, b.admittedAt),
        ),
      )[0]?.type ??
    (source.schedules ?? [])
      .filter((schedule) => loopType.test(schedule.eventType))
      .sort(
        (a, b) =>
          (validDate(a.nextDue) ?? Infinity) -
          (validDate(b.nextDue) ?? Infinity),
      )[0]?.eventType ??
    (kind === "pr" ? "factory.merge.requested" : "factory.work.requested");
  const nextSchedule = nextScheduledRetry(
    { type: retryOriginType, repos: repo ? [repo] : [] },
    source.schedules ?? [],
  );
  const nextVisit = nextSchedule?.nextDue
    ? { loop: nextSchedule.loop, at: nextSchedule.nextDue }
    : null;
  const merged = timeline.some(
    (item) => item.kind === "merge" && /^merged/.test(item.label),
  );
  const ticketWaiting =
    kind === "ticket" &&
    (latestNoop != null || /^(todo|backlog)$/i.test(subject.state ?? ""));
  if (
    nextVisit &&
    !merged &&
    !/^done$/i.test(subject.state ?? "") &&
    (kind === "pr" || ticketWaiting)
  ) {
    timeline.push({
      id: `schedule:${nextVisit.loop}`,
      kind: "schedule",
      at: nextVisit.at,
      label: scheduledRetryLabel(nextSchedule!),
      detail: `next: ${nextVisit.loop} at ${clock(nextVisit.at)} · ${nextSchedule!.eventType} will revisit this ${kind === "pr" ? "PR" : "ticket"}`,
      href: `#/schedules/${encodeURIComponent(nextVisit.loop)}`,
      durationMs: null,
    });
  }

  for (let index = 0; index < timeline.length; index += 1) {
    const previous = index ? validDate(timeline[index - 1].at) : null;
    const current = validDate(timeline[index].at);
    timeline[index].durationMs =
      previous != null && current != null
        ? Math.max(0, current - previous)
        : null;
  }

  const activityRows = timeline.filter((item) => item.kind !== "schedule");
  const first = validDate(subject.createdAt ?? activityRows[0]?.at);
  const last = validDate(activityRows.at(-1)?.at);
  const leadTimeMs =
    first != null && last != null && last > first ? last - first : null;
  const lastRun = [...source.runs]
    .sort((a, b) => resultAt(a).localeCompare(resultAt(b)))
    .at(-1);
  const lastRefusal = lastRun ? refusalOf(lastRun) : null;
  const blockingReason =
    reasonText(latestNoop?.reason) ??
    (kind === "pr" && lastRefusal ? humanizeWithCode(lastRefusal.code) : null);
  const awaitingApproval = [...source.proposals]
    .filter(
      (proposal) => proposal.status === "open" && proposal.decision === "run",
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
  if (!currentRun && awaitingApproval?.runId) {
    currentRun = {
      runId: awaitingApproval.runId,
      state: "PROPOSED",
      actor: null,
    };
  }
  const nextAction =
    currentRun && currentRun.state !== "PROPOSED"
      ? `${currentRun.runId} is ${currentRun.state.toLowerCase()}${currentRun.actor ? ` on ${currentRun.actor}` : ""}`
      : awaitingApproval
        ? `Awaiting approval for ${awaitingApproval.id}`
        : merged && kind === "pr"
          ? "Merged — no further action"
          : blockingReason
            ? `Waiting: ${blockingReason}${nextVisit ? ` · ${nextVisit.loop} revisits at ${clock(nextVisit.at)}` : ""}`
            : /^done$/i.test(subject.state ?? "")
              ? "No further action"
              : kind === "pr"
                ? nextVisit
                  ? `Waiting for ${nextVisit.loop} at ${clock(nextVisit.at)}`
                  : "Waiting for the next merge scan"
                : prUrls.size
                  ? "Waiting for review or merge"
                  : source.activity
                    ? "Waiting for the next dispatch decision"
                    : `No runtime activity for ${subject.id}`;

  const pr =
    kind === "pr"
      ? {
          number: prOfSubject!,
          github: prGithub,
          ticket: prTicket,
          headRef: prHeadRef,
          mergeState: merged ? "MERGED" : prMergeState,
          url: prGithub
            ? `https://github.com/${prGithub}/pull/${prOfSubject}`
            : null,
        }
      : null;
  if (pr?.url) subject.url = pr.url;
  if (kind === "pr" && !subject.title && pr?.headRef)
    subject.title = pr.headRef;
  if (kind === "pr" && !subject.state) subject.state = pr?.mergeState ?? null;

  return {
    subject,
    pr,
    activity: source.activity,
    timeline,
    totalCost: usageKnown ? totalCost : null,
    totalTokens: usageKnown ? totalTokens : null,
    leadTimeMs,
    runCount: source.runs.length,
    prUrls: [...prUrls],
    currentRun,
    blockingReason,
    nextAction,
    nextVisit,
  };
}

/** The WM-595 entry point: a ticket journey from the `/api/runs?ticket=` join. */
export function buildTicketJourney(
  source: TicketJourneySource &
    Partial<Pick<SubjectJourneySource, "inbox" | "schedules">>,
): SubjectJourney {
  return subjectJourney("ticket", source.ticket.id, {
    subject: { kind: "ticket", ...source.ticket },
    activity: source.activity,
    events: source.events,
    proposals: source.proposals,
    runs: source.runs,
    inbox: source.inbox,
    schedules: source.schedules,
  });
}

/**
 * Client-side PR join (WM-640): the runtime has no PR endpoint, so the view
 * assembles the source from the run/event/proposal lists it already loads.
 * Selection is structural (`pr`, `prNumber`, `pull/<n>` URLs, `refs.pr`) —
 * never prose — and closes over correlation ids so the scan that produced a
 * fix request for the PR is on the timeline next to the fix itself.
 */
export function selectPrSource(
  pr: number,
  input: {
    events: JourneyEvent[];
    proposals: JourneyProposal[];
    runs: JourneyRun[];
    inbox?: JourneyInboxItem[];
    schedules?: JourneySchedule[];
  },
): SubjectJourneySource {
  const namesPr = (value: unknown) => prNumbersIn(value).includes(pr);
  const events = input.events.filter(
    (event) => namesPr(event.envelope) || namesPr(event.subject),
  );
  const eventKeys = new Set(
    events.map((event) => `${event.source}\0${event.eventId}`),
  );
  const proposals = input.proposals.filter(
    (proposal) =>
      namesPr(proposal.spec?.input) ||
      (proposal.eventId &&
        eventKeys.has(`${proposal.eventSource}\0${proposal.eventId}`)),
  );
  const runIds = new Set<string>();
  for (const event of events) if (event.runId) runIds.add(event.runId);
  for (const proposal of proposals)
    if (proposal.runId) runIds.add(proposal.runId);
  const runs = input.runs.filter(
    (run) =>
      runIds.has(run.run.runId) ||
      namesPr(run.run.spec.input) ||
      namesPr(run.result) ||
      (run.result && scanVerdictFor(run.result.artifact, pr) != null),
  );
  const tickets = new Set<string>();
  for (const event of events)
    for (const ticket of ticketIdsIn(event.envelope)) tickets.add(ticket);
  for (const run of runs) {
    const ticket = ticketOfRun(run);
    if (ticket) tickets.add(ticket);
    for (const bucket of ["plan", "fix", "escalate"]) {
      const artifact = run.result?.artifact;
      if (!isArtifactPrEntry(artifact)) continue;
      const list = artifact[bucket];
      if (!Array.isArray(list)) continue;
      const entry = list.find(
        (item): item is ArtifactPrEntry =>
          isArtifactPrEntry(item) && Number(item.pr) === pr,
      );
      if (typeof entry?.ticket === "string")
        tickets.add(entry.ticket.toUpperCase());
    }
  }
  // Same-ticket runs are the other chain that moves the PR's head (the
  // dispatch agent pushing while a scan reads) — context for the ↔ rows only.
  const own = new Set(runs.map((run) => run.run.runId));
  const contextRuns = input.runs.filter((run) => {
    if (own.has(run.run.runId) || RUN_FAMILY.merge.test(run.run.spec.agent))
      return false;
    const ticket = ticketOfRun(run);
    return ticket != null && tickets.has(ticket);
  });
  const allRuns = [...runs].sort((a, b) =>
    a.run.created_at.localeCompare(b.run.created_at),
  );
  const inbox = (input.inbox ?? []).filter((item) => namesPr(item.refs));
  const first =
    [
      ...events.map((e) => e.occurredAt),
      ...allRuns.map((r) => r.run.created_at),
    ]
      .filter((v) => validDate(v) != null)
      .sort()[0] ?? null;
  return {
    subject: {
      kind: "pr",
      id: String(pr),
      title: null,
      state: null,
      createdAt: first,
      url: `#/prs/${pr}`,
    },
    activity:
      events.length > 0 ||
      proposals.length > 0 ||
      allRuns.length > 0 ||
      inbox.length > 0,
    events,
    proposals,
    runs: allRuns,
    inbox,
    schedules: input.schedules,
    contextRuns,
  };
}

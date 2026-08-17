export const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** Decorate exact ticket string tokens produced by JSON/detail renderers. */
export function installTicketJourneyLinks(root: HTMLElement, open: (ticket: string) => void): () => void {
  const decorate = () => {
    for (const span of root.querySelectorAll<HTMLSpanElement>("span")) {
      if (span.childElementCount > 0 || span.dataset.ticketJourneyId) continue;
      const ticket = (span.textContent ?? "").trim().replace(/^([\"'])|([\"'])$/g, "").toUpperCase();
      if (!TICKET_ID_PATTERN.test(ticket)) continue;
      span.dataset.ticketJourneyId = ticket;
      span.setAttribute("role", "link");
      span.tabIndex = 0;
      span.setAttribute("aria-label", `Open ticket ${ticket}`);
      span.title = `Open ticket journey for ${ticket}`;
      span.classList.add("cursor-pointer", "hover:text-(--accent)", "hover:underline");
    }
  };
  const ticketTarget = (target: EventTarget | null): { element: HTMLElement; ticket: string } | null => {
    const element = target instanceof Element
      ? target.closest<HTMLElement>("[data-ticket-journey-id], button")
      : null;
    if (!element) return null;
    const dataTicket = element.dataset.ticketJourneyId;
    const ticket = (dataTicket ?? element.textContent ?? "").trim().toUpperCase();
    const exactCopyButton = element.tagName === "BUTTON" && element.title.trim().toUpperCase() === ticket;
    return (dataTicket || exactCopyButton) && TICKET_ID_PATTERN.test(ticket) ? { element, ticket } : null;
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
  spec: Record<string, any> | null;
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

export type TimelineKind = "linear" | "event" | "decision" | "run" | "pr" | "ci" | "merge";

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

export interface TicketJourney {
  ticket: TicketJourneySource["ticket"];
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
}

const KNOWN_REASONS: Record<string, string> = {
  owned_paths_overlap: "Owned paths overlap",
  ticket_assigned: "Ticket is already assigned",
  ticket_dispatch_already_live: "A dispatch is already live",
  same_ticket_worktree_held: "The ticket worktree is still held",
  proposal_expired: "The proposal expired",
  needs_human: "Human input is required",
  attempts_exhausted: "Attempts are exhausted",
};

/** Human-readable planner reason while preserving identifiers in the suffix. */
export function humanizeReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const [code, ...suffix] = reason.split(":");
  const words = KNOWN_REASONS[code] ?? code.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
  return suffix.length ? `${words} — ${suffix.join(" · ")}` : words;
}

function validDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function timeOf(value: string | null | undefined, fallback = "1970-01-01T00:00:00.000Z"): string {
  return validDate(value) == null ? fallback : value!;
}

function eventHref(event: Pick<JourneyEvent, "source" | "eventId">): string {
  return `#/events/${encodeURIComponent(event.source)}/${encodeURIComponent(event.eventId)}`;
}

function runHref(runId: string): string {
  return `#/run/${encodeURIComponent(runId)}`;
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
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
    if (/^(ticket|ticketId|issue|issueId|linearId|subject)$/i.test(key)) add(entry);
  });
  return [...ids];
}

function prUrlsIn(value: unknown): string[] {
  const urls = new Set<string>();
  const inspect = (entry: unknown) => {
    if (typeof entry !== "string") return;
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:$|[/?#])/.test(entry)) urls.add(entry);
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

function eventPr(event: JourneyEvent): { number: number; url: string } | null {
  const number = Number(nestedValue(event.envelope, /^(pr|prNumber|pullRequestNumber)$/i));
  if (!Number.isInteger(number) || number <= 0) return null;
  const github = nestedValue(event.envelope, /^github$/i);
  if (typeof github !== "string" || !/^[^/]+\/[^/]+$/.test(github)) return null;
  return { number, url: `https://github.com/${github}/pull/${number}` };
}

function resultAt(run: JourneyRun): string {
  return (
    [...run.lifecycle].sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.at ??
    run.run.updated_at ??
    run.run.created_at
  );
}

function runDuration(run: JourneyRun): number | null {
  const lifecycle = [...run.lifecycle].sort((a, b) => a.at.localeCompare(b.at));
  const start = validDate(lifecycle[0]?.at ?? run.run.created_at);
  const end = validDate(lifecycle.at(-1)?.at ?? run.run.updated_at);
  return start != null && end != null && end >= start ? end - start : null;
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ""}`;
}

function lifecycleChildren(run: JourneyRun): TimelineItem[] {
  return [...run.lifecycle]
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
    .map((entry, index, all) => {
      const previous = index ? validDate(all[index - 1].at) : null;
      const current = validDate(entry.at);
      return {
        id: `${run.run.runId}:lifecycle:${entry.seq}`,
        kind: "run" as const,
        at: entry.at,
        label: entry.to_state,
        detail: `${entry.actor}${entry.reason ? ` · ${entry.reason}` : ""}`,
        href: runHref(run.run.runId),
        durationMs: previous != null && current != null ? Math.max(0, current - previous) : null,
      };
    });
}

function proposalFor(event: JourneyEvent, proposals: JourneyProposal[]): JourneyProposal | undefined {
  return proposals.find(
    (proposal) =>
      proposal.id === event.proposalId ||
      (proposal.eventId === event.eventId && proposal.eventSource === event.source),
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

function checkLabel(run: JourneyRun): { label: string; detail: string | null } | null {
  const artifact = run.result?.artifact ?? {};
  let checksGreen: boolean | null = null;
  walk(artifact, (key, value) => {
    if (/^(checksGreen|ciGreen)$/i.test(key) && typeof value === "boolean") checksGreen = value;
  });
  if (checksGreen == null) return null;
  return {
    label: checksGreen ? "CI checks green" : "CI checks red",
    detail: checksGreen ? "All recorded checks passed" : "One or more recorded checks failed",
  };
}

/** Pure chronological join used by the view and fixture tests. */
export function buildTicketJourney(source: TicketJourneySource): TicketJourney {
  const timeline: TimelineItem[] = [];
  const resultPrUrls = new Set(source.runs.flatMap((run) => prUrlsIn(run.result)));
  const prUrls = new Set(resultPrUrls);
  const renderedPrUrls = new Set<string>();
  const allActivityTimes = [
    ...source.events.flatMap((event) => [event.occurredAt, event.admittedAt]),
    ...source.proposals.flatMap((proposal) => [proposal.created_at, proposal.decided_at ?? ""]),
    ...source.runs.flatMap((run) => [run.run.created_at, run.run.updated_at]),
  ].filter((value) => validDate(value) != null);
  const earliest = [...allActivityTimes].sort()[0] ?? null;

  if (source.ticket.createdAt) {
    timeline.push({
      id: `${source.ticket.id}:filed`,
      kind: "linear",
      at: source.ticket.createdAt,
      label: "filed",
      detail: source.ticket.title,
      href: source.ticket.url,
      external: true,
      durationMs: null,
    });
  }

  for (const event of source.events) {
    const proposal = proposalFor(event, source.proposals);
    const decision = proposal?.decision ?? (event.status === "planned" ? "planned" : event.status);
    const reason = humanizeReason(proposal?.reason);
    const dispatch = /dispatch/i.test(event.type);
    const agentReady = /agent[-_. ]?ready/i.test(event.type) || /agent[-_. ]?ready/i.test(JSON.stringify(event.envelope));
    const at = timeOf(event.occurredAt, event.admittedAt);
    timeline.push({
      id: `event:${event.source}:${event.eventId}`,
      kind: proposal ? "decision" : "event",
      at,
      label: agentReady ? "agent-ready" : dispatch ? "dispatch requested" : event.type,
      detail: proposal ? `${decision}${reason ? ` · ${reason}` : ""}` : event.status,
      href: eventHref(event),
      durationMs: null,
    });

    const eventPrRef = eventPr(event);
    if (eventPrRef) {
      const knownUrl = [...resultPrUrls].find((url) => prNumber(url) === String(eventPrRef.number));
      const url = knownUrl ?? eventPrRef.url;
      prUrls.add(url);
      if (!knownUrl && !renderedPrUrls.has(url)) {
        renderedPrUrls.add(url);
        timeline.push({
          id: `pr:${url}`,
          kind: "pr",
          at,
          label: `PR #${eventPrRef.number} referenced`,
          detail: null,
          href: url,
          external: true,
          durationMs: null,
        });
      }
    }
    const checksGreen = nestedValue(event.envelope, /^(checksGreen|ciGreen)$/i);
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
    if (/merge/i.test(event.type) || (typeof action === "string" && /merge/i.test(action))) {
      timeline.push({
        id: `merge:event:${event.source}:${event.eventId}`,
        kind: "merge",
        at,
        label: action === "merge_pr" ? "merge requested" : "merge decision",
        detail: (nestedValue(event.envelope, /^reason$/i) as string | undefined) ?? null,
        href: eventHref(event),
        durationMs: null,
      });
    }
  }

  let totalCost = 0;
  let totalTokens = 0;
  let usageKnown = false;
  const activeStates = new Set(["QUEUED", "LEASED", "RUNNING", "VERIFYING"]);
  let currentRun: TicketJourney["currentRun"] = null;

  for (const run of source.runs) {
    const totals = run.usage?.totals;
    const attempts = totals?.attempts ?? run.usage?.attempts?.length ?? 0;
    if (attempts > 0 || (totals?.costUSD ?? 0) > 0 || (totals?.totalTokens ?? 0) > 0) {
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
    ].filter(Boolean).join(" · ");
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

    for (const url of prUrlsIn(run.result)) {
      prUrls.add(url);
      if (renderedPrUrls.has(url)) continue;
      renderedPrUrls.add(url);
      timeline.push({
        id: `pr:${url}`,
        kind: "pr",
        at: resultAt(run),
        label: `PR #${prNumber(url)} opened`,
        detail: null,
        href: url,
        external: true,
        durationMs: null,
      });
    }
    const ci = checkLabel(run);
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
    if (activeStates.has(run.run.state)) {
      const last = [...run.lifecycle].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      currentRun = { runId: run.run.runId, state: run.run.state, actor: last?.actor ?? null };
    }
  }

  if (/^done$/i.test(source.ticket.state ?? "")) {
    const at = timeline.map((item) => item.at).filter((value) => validDate(value) != null).sort().at(-1) ?? earliest;
    if (at) {
      timeline.push({
        id: `${source.ticket.id}:done`,
        kind: "linear",
        at,
        label: "Done",
        detail: null,
        href: source.ticket.url,
        external: true,
        durationMs: null,
      });
    }
  }

  timeline.sort((a, b) => {
    const diff = (validDate(a.at) ?? 0) - (validDate(b.at) ?? 0);
    return diff || a.id.localeCompare(b.id);
  });
  for (let index = 0; index < timeline.length; index += 1) {
    const previous = index ? validDate(timeline[index - 1].at) : null;
    const current = validDate(timeline[index].at);
    timeline[index].durationMs = previous != null && current != null ? Math.max(0, current - previous) : null;
  }

  const first = validDate(source.ticket.createdAt ?? timeline[0]?.at);
  const last = validDate(timeline.at(-1)?.at);
  const leadTimeMs = first != null && last != null && last > first ? last - first : null;
  const latestNoop = [...source.proposals]
    .filter((proposal) => proposal.decision === "noop")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
  const blockingReason = humanizeReason(latestNoop?.reason);
  const awaitingApproval = [...source.proposals]
    .filter((proposal) => proposal.status === "open" && proposal.decision === "run")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
  if (!currentRun && awaitingApproval?.runId) {
    currentRun = { runId: awaitingApproval.runId, state: "PROPOSED", actor: null };
  }
  const nextAction = currentRun && currentRun.state !== "PROPOSED"
    ? `${currentRun.runId} is ${currentRun.state.toLowerCase()}${currentRun.actor ? ` on ${currentRun.actor}` : ""}`
    : awaitingApproval
      ? `Awaiting approval for ${awaitingApproval.id}`
      : blockingReason
        ? `Waiting: ${blockingReason}`
        : /^done$/i.test(source.ticket.state ?? "")
          ? "No further action"
          : prUrls.size
            ? "Waiting for review or merge"
            : source.activity
              ? "Waiting for the next dispatch decision"
              : `No runtime activity for ${source.ticket.id}`;

  return {
    ticket: source.ticket,
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
  };
}

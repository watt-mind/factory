import type {
  AdmittedEvent,
  AgentsView,
  ArtifactInventoryItem,
  ArtifactView,
  ChainListItem,
  ChainView,
  ApproveOutcome,
  CancelOutcome,
  EnvIdentity,
  DecisionEffect,
  DecisionResponseInput,
  InboxItem,
  InboxStatus,
  JournalView,
  MetricsBreakdownView,
  MetricsView,
  MetricsWindow,
  OutboxRow,
  JanitorResult,
  Proposal,
  RepoItem as BaseRepoItem,
  RunDetail,
  RunListItem,
  StatusView,
  TicketSummary,
  TraceView,
  Worker,
} from "./types";

// Same contract as lib/client.mjs: one function per endpoint, an Error with
// `.status` on non-2xx, no status at all on connection failure.

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type ConfigReload = "hot" | "restart" | "cli-only";
export interface ConfigEntry {
  key: string;
  value: unknown;
  reload?: ConfigReload;
  note?: string;
}
/** One extension in the `extensions` config section (WM-841): effective, redacted values or the anomaly that disabled it. */
export interface ConfigExtension {
  name: string | null;
  version: string | null;
  path: string;
  namespace: string | null;
  reload: ConfigReload;
  schema: Record<string, unknown> | null;
  values: Record<string, unknown> | null;
  anomaly: string | null;
}
export interface ConfigSection {
  id: string;
  title: string;
  source: { file: string; kind: "yaml" | "json" | "registry" };
  reload: ConfigReload;
  entries: ConfigEntry[];
  /** Only on the `extensions` section. */
  extensions?: ConfigExtension[];
}
export interface ConfigView {
  generatedAt: string;
  policyVersion: string;
  registry: {
    loadedAt: string;
    agentCount: number;
    eventTypeCount: number;
    edgeCount: number;
    scheduleCount: number;
  };
  sections: ConfigSection[];
}

/**
 * A declarative Overview panel (`factory.panel-view/v1`, WM-840) as `GET
 * /panels` serves it: already validated by the runtime, bound to one
 * allow-listed loopback GET route, drawn with the artifact-view vocabulary
 * over the node `source.path` selects in that route's response.
 */
export interface PanelView {
  name: string;
  title: string;
  description: string | null;
  source: { endpoint: string; query: Record<string, string>; path: string };
  refreshSeconds: number;
  /** An artifact-view body without `schemaVersion`; sections' `path` is relative to the selected node. */
  view: Omit<ArtifactView, "schemaVersion">;
  /** `builtin`, `pack:<namespace>` or `extension:<name>`. */
  origin: string;
  file: string;
}
export interface PanelsView {
  panels: PanelView[];
  /** The `source.endpoint` allow-list — a client refuses to fetch anything else. */
  endpoints: string[];
}

/** Deliberately allow-listed repository settings returned by GET /repos. */
export interface RepoItem extends BaseRepoItem {
  effective?: {
    maxInFlight: number;
    maxInFlightSource: "repo" | "default";
  };
  smokeDeadlineSeconds?: number | null;
  smokeWorkflow?: string | null;
  smokeUrl?: string | null;
  deployment?: {
    url: string | null;
    branch: string | null;
    revisionField: string | null;
  } | null;
  security?: { pythonVersion: string | null } | null;
  mergeCi?: { workflow: string; requiredChecks: string[] } | null;
  escalatePaths?: string[] | null;
  ownedPathsPolicy?: {
    direct: { source: string; requires: string[] }[];
    pinManifests: string[];
  };
}

type CachedResponse = { etag: string; body: unknown };
const responseCache = new Map<string, CachedResponse>();

export type RunListFilters = {
  state?: string;
  from?: string;
  to?: string;
  population?:
    | "created"
    | "terminal"
    | "started"
    | "retried"
    | "leased"
    | "finished"
    | "usage";
  agent?: string;
  /** Opaque cursor returned by the preceding GET /runs page. */
  before?: string;
};

export type RunListResponse = {
  runs: RunListItem[];
  /** Absent for legacy fixtures/servers; null on the final summary page. */
  nextBefore?: string | null;
};

export type CursorPage<T, Key extends string> = Record<Key, T[]> & {
  /** Opaque cursor returned by the preceding newest-first page. */
  nextBefore?: string | null;
};

export type ProposalListFilters = {
  from?: string;
  to?: string;
  population?: "decision";
  decisionStatus?: string;
  limit?: number;
  before?: string;
};

function withQuery(path: string, values: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value) query.set(key, value);
  return query.size > 0 ? `${path}?${query.toString()}` : path;
}

export function fetchRuns(filters: RunListFilters = {}) {
  return call<RunListResponse>("GET", withQuery("/runs", filters));
}

export function fetchProposalHistory(
  status = "all",
  filters: ProposalListFilters = {},
) {
  return call<CursorPage<Proposal, "proposals">>(
    "GET",
    withQuery("/proposals", {
      status,
      from: filters.from,
      to: filters.to,
      population: filters.population,
      decisionStatus: filters.decisionStatus,
      limit: filters.limit == null ? undefined : String(filters.limit),
      before: filters.before,
    }),
  );
}

export function fetchProposals(page: { limit?: number; before?: string } = {}) {
  return call<CursorPage<Proposal, "proposals">>(
    "GET",
    withQuery("/proposals", {
      limit: page.limit == null ? undefined : String(page.limit),
      before: page.before,
    }),
  );
}

export function fetchMetrics(window: MetricsWindow, bucket: string) {
  return call<MetricsView>("GET", withQuery("/metrics", { window, bucket }));
}

export function fetchMetricsBreakdown(
  window: MetricsWindow,
  by: string,
  metric: string,
  limit?: number,
) {
  return call<MetricsBreakdownView>(
    "GET",
    withQuery("/metrics/breakdown", {
      window,
      by,
      metric,
      limit: limit == null ? undefined : String(limit),
    }),
  );
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `/api${path}`;
  const cacheKey = method === "GET" ? url : null;
  const cached = cacheKey ? responseCache.get(cacheKey) : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cached) headers["if-none-match"] = cached.etag;
  const res = await fetch(url, {
    method,
    headers,
    // The application cache owns validators and response identity. Bypass the
    // browser's opaque HTTP cache so a wire 304 reaches this wrapper.
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 304) {
    if (cached) return cached.body as T;
    throw new ApiError("HTTP 304 without a cached response", 304);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      json?.error ??
      (Array.isArray(json?.errors)
        ? json.errors.join("; ")
        : `HTTP ${res.status}`);
    throw new ApiError(message, res.status);
  }
  if (cacheKey) {
    const etag = res.headers.get("etag");
    if (etag) responseCache.set(cacheKey, { etag, body: json });
    else responseCache.delete(cacheKey);
  }
  return json as T;
}

/** Every published config source, read-only and allow-listed by the server. */
export const fetchConfig = () => call<ConfigView>("GET", "/config");

export function fetchArtifacts(filters?: {
  kind?: string;
  orphan?: boolean;
  search?: string;
  limit?: number;
  before?: string;
}) {
  const query = new URLSearchParams();
  if (filters?.kind) query.set("kind", filters.kind);
  if (filters?.orphan !== undefined)
    query.set("orphan", String(filters.orphan));
  if (filters?.search) query.set("search", filters.search);
  if (filters?.limit != null) query.set("limit", String(filters.limit));
  if (filters?.before) query.set("before", filters.before);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return call<CursorPage<ArtifactInventoryItem, "artifacts">>(
    "GET",
    `/artifacts${suffix}`,
  );
}

export function fetchTickets(
  filters: { since?: string | number; limit?: number; repo?: string } = {},
) {
  return call<{ tickets: TicketSummary[] }>(
    "GET",
    withQuery("/tickets", {
      since: filters.since != null ? String(filters.since) : undefined,
      limit: filters.limit != null ? String(filters.limit) : undefined,
      repo: filters.repo || undefined,
    }),
  );
}

export const api = {
  health: () =>
    call<{ ok: boolean; policyVersion: string; env: EnvIdentity }>(
      "GET",
      "/health",
    ),
  status: () => call<StatusView>("GET", "/status"),
  events: (status?: string, page: { limit?: number; before?: string } = {}) =>
    call<CursorPage<AdmittedEvent, "events">>(
      "GET",
      withQuery("/events", {
        status,
        limit: page.limit == null ? undefined : String(page.limit),
        before: page.before,
      }),
    ),
  proposals: () => fetchProposals(),
  // Full decision history (?status=all), newest first — read-only audit view.
  proposalHistory: (status = "all", filters: ProposalListFilters = {}) =>
    fetchProposalHistory(status, filters),
  approve: (id: string) =>
    call<ApproveOutcome>(
      "POST",
      `/proposals/${encodeURIComponent(id)}/approve`,
      {},
    ),
  reject: (id: string, reason?: string) =>
    call<{ rejected: boolean }>(
      "POST",
      `/proposals/${encodeURIComponent(id)}/reject`,
      { reason },
    ),
  runs: (state?: string, filters: RunListFilters = {}) =>
    fetchRuns(state ? { ...filters, state } : filters),
  run: (id: string) =>
    call<RunDetail>("GET", `/runs/${encodeURIComponent(id)}`),
  // Live agent trace, ascending by seq; `since` is the last seen seq (incremental).
  trace: (id: string, since = 0, limit = 500) =>
    call<TraceView>(
      "GET",
      `/runs/${encodeURIComponent(id)}/trace?since=${since}&limit=${limit}`,
    ),
  cancel: (id: string, reason?: string) =>
    call<CancelOutcome>(
      "POST",
      `/runs/${encodeURIComponent(id)}/cancel`,
      reason ? { reason } : {},
    ),
  retry: (id: string, force = false) =>
    call<{ queued: boolean }>("POST", `/runs/${encodeURIComponent(id)}/retry`, {
      force,
    }),
  replay: (envelope: unknown) =>
    call<{ admitted: boolean; duplicate: boolean; eventId: string }>(
      "POST",
      "/replay",
      envelope,
    ),
  injectEvent: (
    type: string,
    payload: Record<string, unknown>,
    source = "factory-web",
    subject = "factory",
  ) => {
    const eventId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId,
      type,
      source,
      subject,
      occurredAt: new Date().toISOString(),
      correlationId: eventId,
      payload,
    };
    return call<{ admitted: boolean; duplicate: boolean; eventId: string }>(
      "POST",
      "/replay",
      envelope,
    );
  },
  // Append-only lifecycle feed: entries newest-first, `since` is the last seen head.
  journal: (since = 0, limit = 100) =>
    call<JournalView>("GET", `/journal?since=${since}&limit=${limit}`),
  outbox: (limit = 20) =>
    call<{ outbox: OutboxRow[] }>("GET", `/outbox?limit=${limit}`),
  // Re-plan a dead_lettered or human_needed event (404 unknown, 409 wrong status).
  requeue: (source: string, eventId: string) =>
    call<{ requeued: boolean }>("POST", "/events/requeue", { source, eventId }),
  // Preserve a dead letter in history while removing it from active anomalies.
  archive: (source: string, eventId: string) =>
    call<{ archived: boolean }>("POST", "/events/archive", { source, eventId }),
  // Requeue/fail the run held by a stale worker and retire its registry row.
  releaseWorker: (workerId: string, runId: string) =>
    call<{ released: boolean; runId: string }>(
      "POST",
      `/workers/${encodeURIComponent(workerId)}/release`,
      { runId },
    ),
  // The agent registry, fully readable: definitions, prompts, schemas, pins.
  // Effective adapter/tier include the runtime overlay (WM-887).
  agents: () => call<AgentsView>("GET", "/agents"),
  putEventTypeOverride: (type: string, body: { adapter: string }) =>
    call<{ patch: { adapter: string } }>(
      "PUT",
      `/overrides/event-types/${encodeURIComponent(type)}`,
      body,
    ),
  deleteEventTypeOverride: (type: string) =>
    call<{ deleted: boolean }>(
      "DELETE",
      `/overrides/event-types/${encodeURIComponent(type)}`,
    ),
  putAgentOverride: (
    ref: string,
    body: { modelTier?: string | null; model?: string | null },
  ) =>
    call<{ patch: Record<string, unknown> }>(
      "PUT",
      `/overrides/agents/${encodeURIComponent(ref)}`,
      body,
    ),
  deleteAgentOverride: (ref: string) =>
    call<{ deleted: boolean }>(
      "DELETE",
      `/overrides/agents/${encodeURIComponent(ref)}`,
    ),
  // Declarative Overview panels (WM-840) and the data behind one of them:
  // `panelSource` only ever GETs an endpoint the runtime already
  // allow-listed for the panel; the query is the panel's own `source.query`.
  panels: () => call<PanelsView>("GET", "/panels"),
  panelSource: (endpoint: string, query: Record<string, string> = {}) => {
    const qs = new URLSearchParams(query).toString();
    return call<unknown>("GET", qs ? `${endpoint}?${qs}` : endpoint);
  },
  // Every event + run under one correlation id (WM-527); 404 when unknown.
  chain: (correlationId: string) =>
    call<ChainView>("GET", `/chain/${encodeURIComponent(correlationId)}`),
  // Recent chain summaries, newest activity first (WM-537).
  chains: (window = "24h", limit = 100) =>
    call<{ chains: ChainListItem[] }>(
      "GET",
      `/chains?window=${encodeURIComponent(window)}&limit=${limit}`,
    ),
  // Configured factory repositories (config/repos.yaml) — context tabs open from this list.
  repos: () => call<{ repos: RepoItem[] }>("GET", "/repos"),
  // Janitor worktree scan and cleanup (apply: false for dry run, apply: true for teardown)
  janitor: (name: string, apply = false) =>
    call<JanitorResult>("POST", `/repos/${encodeURIComponent(name)}/janitor`, {
      apply,
    }),
  // The worker registry: which processes are alive, where, and what they run.
  workers: () => call<{ workers: Worker[] }>("GET", "/workers"),
  // Human inbox ledger (WM-285): everything waiting on the operator, by status.
  inbox: (
    status: InboxStatus = "open",
    page: { limit?: number; before?: string } = {},
  ) =>
    call<CursorPage<InboxItem, "items">>(
      "GET",
      withQuery("/inbox", {
        status,
        limit: page.limit == null ? undefined : String(page.limit),
        before: page.before,
      }),
    ),
  // Ack = "seen"; 404 unknown item, 409 already resolved.
  ackInbox: (id: string) =>
    call<{ item: InboxItem }>(
      "POST",
      `/inbox/${encodeURIComponent(id)}/ack`,
      {},
    ),
  // Resolve = "dealt with"; idempotent on the ledger, 404 unknown item.
  // A non-empty reason is required (WM-604) — the API rejects blanks with 422.
  resolveInbox: (id: string, reason: string) =>
    call<{ item: InboxItem }>(
      "POST",
      `/inbox/${encodeURIComponent(id)}/resolve`,
      { reason },
    ),
  // The schedule registry: recurring loops, cadence, timing, and health.
  schedules: () => call<{ schedules: ScheduleItem[] }>("GET", "/schedules"),
  // Trigger an ad-hoc run. Explicit PR numbers are accepted only by merge schedules.
  triggerSchedule: (loop: string, prNumbers?: number[]) =>
    call<TriggerOutcome>(
      "POST",
      `/schedules/${encodeURIComponent(loop)}/run`,
      prNumbers === undefined ? {} : { prNumbers },
    ),
  // Recent ticket summaries across factory runs (GET /tickets).
  tickets: (since?: string | number, limit = 50, repo?: string) =>
    fetchTickets({ since, limit, repo }),
};

// Decision detail endpoints are named exports so the generic API test harness
// does not need an unrelated mock every time this self-contained flow grows.
export const getInboxItem = (id: string) =>
  call<{ item: InboxItem }>("GET", `/inbox/${encodeURIComponent(id)}`);

export const decideInboxItem = (id: string, response: DecisionResponseInput) =>
  call<{ item: InboxItem; effect: DecisionEffect }>(
    "POST",
    `/inbox/${encodeURIComponent(id)}/decide`,
    response,
  );

export const retryInboxDecision = (id: string) =>
  call<{ item: InboxItem; effect: DecisionEffect }>(
    "POST",
    `/inbox/${encodeURIComponent(id)}/decide/retry`,
    {},
  );

export interface ScheduleItem {
  loop: string;
  repo: string | null;
  every: string;
  cadenceSeconds: number | null;
  eventType: string;
  approval: "watched" | "auto";
  catchUp: "none" | "last" | "all";
  singleton: boolean;
  enabled: boolean;
  lastSlot: string | null;
  lastCompletedSlot: string | null;
  neverCompleted: boolean;
  nextDue: string | null;
  intervalsLate: number | null;
  stopped: boolean;
  error: string | null;
}

export const extendRun = (id: string, seconds: number, override = false) =>
  call<ExtendOutcome>("POST", `/runs/${encodeURIComponent(id)}/extend`, {
    seconds,
    override,
  });

export interface ExtendOutcome {
  extended: true;
  runId: string;
  seconds: number;
  deadlineAt: string;
  leaseExpiresAt: string;
  override: boolean;
}

export interface TriggerOutcome {
  admitted: boolean;
  duplicate: boolean;
  eventId: string;
  proposalId: string | null;
  runId: string | null;
  decision: string;
  reason: string | null;
  disabled: boolean;
  loop: string;
}

/** Browser URL for a stored artifact's bytes (streamed by the control API); `name` becomes the save-as filename. */
export const artifactUrl = (sha256: string, name?: string) =>
  `/api/artifacts/${encodeURIComponent(sha256)}${name ? `?name=${encodeURIComponent(name)}` : ""}`;

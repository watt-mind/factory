import type {
  AdmittedEvent,
  AgentsView,
  ArtifactInventoryItem,
  ChainView,
  ApproveOutcome,
  CancelOutcome,
  EnvIdentity,
  JournalView,
  OutboxRow,
  JanitorResult,
  Proposal,
  RepoItem,
  RunDetail,
  RunListItem,
  StatusView,
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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      json?.error ?? (Array.isArray(json?.errors) ? json.errors.join("; ") : `HTTP ${res.status}`);
    throw new ApiError(message, res.status);
  }
  return json as T;
}

export function fetchArtifacts(filters?: { kind?: string; orphan?: boolean; search?: string }) {
  const query = new URLSearchParams();
  if (filters?.kind) query.set("kind", filters.kind);
  if (filters?.orphan !== undefined) query.set("orphan", String(filters.orphan));
  if (filters?.search) query.set("search", filters.search);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return call<{ artifacts: ArtifactInventoryItem[] }>("GET", `/artifacts${suffix}`);
}

export const api = {
  health: () => call<{ ok: boolean; policyVersion: string; env: EnvIdentity }>("GET", "/health"),
  status: () => call<StatusView>("GET", "/status"),
  events: (status?: string) =>
    call<{ events: AdmittedEvent[] }>("GET", `/events${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  proposals: () => call<{ proposals: Proposal[] }>("GET", "/proposals"),
  // Full decision history (?status=all), newest first — read-only audit view.
  proposalHistory: (status = "all") =>
    call<{ proposals: Proposal[] }>("GET", `/proposals?status=${encodeURIComponent(status)}`),
  approve: (id: string) => call<ApproveOutcome>("POST", `/proposals/${encodeURIComponent(id)}/approve`, {}),
  reject: (id: string, reason?: string) =>
    call<{ rejected: boolean }>("POST", `/proposals/${encodeURIComponent(id)}/reject`, { reason }),
  runs: (state?: string) =>
    call<{ runs: RunListItem[] }>("GET", `/runs${state ? `?state=${encodeURIComponent(state)}` : ""}`),
  run: (id: string) => call<RunDetail>("GET", `/runs/${encodeURIComponent(id)}`),
  // Live agent trace, ascending by seq; `since` is the last seen seq (incremental).
  trace: (id: string, since = 0, limit = 500) =>
    call<TraceView>("GET", `/runs/${encodeURIComponent(id)}/trace?since=${since}&limit=${limit}`),
  cancel: (id: string, reason?: string) =>
    call<CancelOutcome>("POST", `/runs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
  retry: (id: string, force = false) =>
    call<{ queued: boolean }>("POST", `/runs/${encodeURIComponent(id)}/retry`, { force }),
  replay: (envelope: unknown) =>
    call<{ admitted: boolean; duplicate: boolean; eventId: string }>("POST", "/replay", envelope),
  injectEvent: (type: string, payload: Record<string, unknown>, source = "factory-web", subject = "factory") => {
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
    return call<{ admitted: boolean; duplicate: boolean; eventId: string }>("POST", "/replay", envelope);
  },
  // Append-only lifecycle feed: entries newest-first, `since` is the last seen head.
  journal: (since = 0, limit = 100) => call<JournalView>("GET", `/journal?since=${since}&limit=${limit}`),
  outbox: (limit = 20) => call<{ outbox: OutboxRow[] }>("GET", `/outbox?limit=${limit}`),
  // Re-plan a dead_lettered or human_needed event (404 unknown, 409 wrong status).
  requeue: (source: string, eventId: string) =>
    call<{ requeued: boolean }>("POST", "/events/requeue", { source, eventId }),
  // Preserve a dead letter in history while removing it from active anomalies.
  archive: (source: string, eventId: string) =>
    call<{ archived: boolean }>("POST", "/events/archive", { source, eventId }),
  // Requeue/fail the run held by a stale worker and retire its registry row.
  releaseWorker: (workerId: string, runId: string) =>
    call<{ released: boolean; runId: string }>("POST", `/workers/${encodeURIComponent(workerId)}/release`, { runId }),
  // The agent registry, fully readable: definitions, prompts, schemas, pins.
  agents: () => call<AgentsView>("GET", "/agents"),
  // Every event + run under one correlation id (WM-527); 404 when unknown.
  chain: (correlationId: string) => call<ChainView>("GET", `/chain/${encodeURIComponent(correlationId)}`),
  // Configured factory repositories (config/repos.yaml) — context tabs open from this list.
  repos: () => call<{ repos: RepoItem[] }>("GET", "/repos"),
  // Janitor worktree scan and cleanup (apply: false for dry run, apply: true for teardown)
  janitor: (name: string, apply = false) =>
    call<JanitorResult>("POST", `/repos/${encodeURIComponent(name)}/janitor`, { apply }),
  // The worker registry: which processes are alive, where, and what they run.
  workers: () => call<{ workers: Worker[] }>("GET", "/workers"),
  // The schedule registry: recurring loops, cadence, timing, and health.
  schedules: () => call<{ schedules: ScheduleItem[] }>("GET", "/schedules"),
  // Trigger an ad-hoc run. Explicit PR numbers are accepted only by merge schedules.
  triggerSchedule: (loop: string, prNumbers?: number[]) =>
    call<TriggerOutcome>(
      "POST",
      `/schedules/${encodeURIComponent(loop)}/run`,
      prNumbers === undefined ? {} : { prNumbers },
    ),
};

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

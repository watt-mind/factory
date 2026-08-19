// Shapes mirror event-runtime/lib/api.mjs views verbatim — this app renders
// what the control API says, it does not reinterpret it.

export type RunState =
  | "PROPOSED"
  | "APPROVED"
  | "QUEUED"
  | "LEASED"
  | "RUNNING"
  | "VERIFYING"
  | "COMPLETED"
  | "REFUSED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface RunSpec {
  schemaVersion: string;
  runId: string;
  agent: string;
  input: unknown;
  inputHash: string;
  workspace: { type: string; retainOnFailure?: boolean };
  adapter: string;
  promptVersion: string;
  policyVersion: string;
  outputContract: string;
  capabilities: string[];
  timeoutSeconds: number;
  maxAttempts: number;
  idempotencyKey: string;
  placement?: Record<string, unknown> | null;
  /**
   * Declared intent and the model it resolved to at plan time (WM-135). Both
   * fields appear together or not at all: a definition that declares neither
   * produces a spec byte-identical to the pre-WM-135 shape, which is why these
   * are optional here and `null` is a different fact from absent — `null`
   * means the routed adapter takes no model.
   */
  modelTier?: string | null;
  model?: string | null;
}

export interface Proposal {
  id: string;
  decision: string;
  status: string;
  expired: boolean;
  created_at: string;
  ttl_seconds: number;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
  runId: string | null;
  eventId: string | null;
  eventSource: string | null;
  agent: string | null;
  spec: RunSpec | null;
  /** One-line spec heading from the agent's view `subject` (WM-897). */
  subject?: string | null;
  /** Repos the spec input names. Empty if unscoped. */
  repos: string[];
}

/**
 * One persisted `approve.before` hook decision — oldest first on
 * `GET /proposals/:id` as `hookDecisions` (WM-842 / WM-864).
 */
export interface HookDecision {
  id: number;
  at: string;
  point: string;
  hookId: string;
  source: string;
  proposalId: string | null;
  runId: string | null;
  decision: string;
  reason: string | null;
  durationMs: number;
  error: string | null;
}

/** `GET /proposals/:id` — the list row plus every hook that voted on it. */
export interface ProposalDetail {
  proposal: Proposal;
  hookDecisions: HookDecision[];
}

export interface AdmittedEvent {
  source: string;
  eventId: string;
  type: string;
  subject: string | null;
  status: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: string | null;
  causationId?: string | null;
  planFailures: number;
  lastPlanError: string | null;
  admittedAt: string;
  proposalId: string | null;
  runId: string | null;
  envelope: Record<string, unknown>;
  /** Repos this envelope names (`repoPin.repo` / `repo` / `repos[]`). Empty if unscoped. */
  repos: string[];
}

/** One event in a chain trace (`GET /chain/:correlationId`, WM-527). */
export interface ChainEvent {
  source: string;
  eventId: string;
  type: string;
  subject: string | null;
  status: string;
  occurredAt: string;
  receivedAt: string;
  admittedAt: string;
  correlationId: string | null;
  /** The run id that emitted this event; null on the origin. */
  causationId: string | null;
  proposalId: string | null;
  proposalStatus: string | null;
  proposalDecision: string | null;
  runId: string | null;
  repos: string[];
}

/** One run in a chain trace. */
export interface ChainRun {
  runId: string;
  state: RunState;
  attempts: number;
  agent: string | null;
  adapter: string | null;
  reasonCode: string | null;
  eventId: string | null;
  eventSource: string | null;
  created_at: string;
  updated_at: string;
  startedAt: string | null;
  finishedAt: string | null;
  repos: string[];
}

export interface ChainView {
  correlationId: string;
  events: ChainEvent[];
  runs: ChainRun[];
}

/** One recent chain summary (`GET /chains`, WM-537). */
export interface ChainListItem {
  correlationId: string;
  origin: {
    source: string;
    eventId: string;
    type: string;
    subject: string | null;
    admittedAt: string;
  };
  eventCount: number;
  runCount: number;
  maxDepth: number;
  states: Partial<Record<RunState, number>>;
  lastActivityAt: string;
  repos: string[];
  single: boolean;
}

export interface RunListItem {
  runId: string;
  /** Full run specification for custom columns and field discovery. */
  spec: RunSpec;
  state: RunState;
  attempts: number;
  maxAttempts: number;
  agent: string;
  adapter: string;
  reasonCode: string | null;
  eventId: string | null;
  eventSource: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Plan-time pins (WM-135), flattened out of the spec for the Model column
   * (WM-221). Optional for the same reason they are optional on `RunSpec`:
   * absent is a third state next to `null`, and the column renders it the
   * same way — "this run pinned nothing" — rather than guessing.
   */
  modelTier?: string | null;
  model?: string | null;
  /** Current execution and lease deadlines, null before the first claim. */
  startedAt?: string | null;
  leaseExpiresAt?: string | null;
  deadlineAt?: string | null;
  timeoutSeconds?: number;
  /** Repos the spec input names. Empty if unscoped. */
  repos: string[];
}

export type MetricsWindow = "1h" | "24h" | "7d" | "30d";

export interface MetricsPercentiles {
  p50: Array<number | null>;
  p95: Array<number | null>;
}

export interface MetricsView {
  window: MetricsWindow;
  bucket: string;
  buckets: string[];
  series: {
    "runs.outcomes": Record<string, number[]>;
    "runs.started": { total: number[] };
    "latency.queue_wait": MetricsPercentiles;
    "latency.execution": MetricsPercentiles;
    "spend.cost": Record<string, number[]>;
    "spend.tokens": Record<string, number[]>;
    "proposals.decisions": Record<string, number[]>;
    "proposals.time_to_decision": MetricsPercentiles;
    "events.intake": Record<string, number[]>;
    "attempts.retries": { total: number[] };
  };
}

export interface MetricsBreakdownView {
  window: MetricsWindow;
  by: string;
  metric: string;
  limit: number | null;
  rows: Array<{ key: string; value: number }>;
}

/** One append-only journal row (GET /journal) — the runtime's activity feed. */
export interface JournalEntry {
  seq: number;
  runId: string;
  from: string | null;
  to: string;
  actor: string;
  reason: string | null;
  attempt: number | null;
  at: string;
}

export interface JournalView {
  head: number;
  entries: JournalEntry[];
}

/** One published (or pending) result event from the §8 outbox. */
export interface OutboxRow {
  seq: number;
  event: Record<string, unknown>;
  created_at: string;
  published_at: string | null;
}

export interface LifecycleEvent {
  seq: number;
  run_id: string;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  attempt: number | null;
  at: string;
}

export interface Attempt {
  run_id: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  terminal_state: string | null;
  reason_code: string | null;
  workspace_path: string | null;
}

/**
 * One factory.trace/v1 payload (closed kind set, adapter-supplied). Every
 * field is optional: which ones exist depends on `kind`, and the recorder
 * may have replaced the whole payload with `{truncated, preview, originalBytes}`.
 */
export interface TracePayload {
  /** assistant_text */
  text?: string;
  /** tool_use */
  id?: string | null;
  name?: string;
  input?: unknown;
  /** tool_result */
  toolUseId?: string | null;
  content?: unknown;
  isError?: boolean;
  /** lifecycle policy_denial */
  tool?: string;
  rule?: string;
  /** usage */
  durationMs?: number | null;
  numTurns?: number | null;
  costUSD?: number | null;
  usage?: Record<string, number>;
  /** lifecycle (e.g. {note: "trace_truncated", dropped}) */
  note?: string;
  dropped?: number;
  /** recorder truncation marker — replaces any oversize payload in place */
  truncated?: boolean;
  preview?: string;
  originalBytes?: number;
}

/** One live-trace row (GET /runs/:id/trace) — ascending by seq. */
export interface TraceEntry {
  seq: number;
  attempt: number;
  ts: string;
  kind: string;
  payload: TracePayload | null;
}

export interface TraceView {
  head: number;
  entries: TraceEntry[];
}

/** Durable, content-addressed artifact — bytes stream from GET /artifacts/:sha256. */
export interface ArtifactRef {
  kind: string;
  uri: string;
  sha256: string;
  sizeBytes: number;
}

/** Accepted result that keeps an artifact reachable in the content-addressed store. */
export interface ArtifactReference {
  runId: string;
  kind: string | null;
  agent: string | null;
  state: RunState | null;
  createdAt: string | null;
}

/** One physical file returned by the artifact inventory endpoint. */
export interface ArtifactInventoryItem {
  sha256: string;
  sizeBytes: number;
  mtime: string;
  referenced: boolean;
  references: ArtifactReference[];
}

export interface DeadlineExtensionReceipt {
  seq: number;
  actor: string;
  at: string;
  type: "deadline_extended";
  seconds: number;
  deadlineAt: string;
  override: boolean;
}

export type RunReceipt = Record<string, string | null> & {
  /** Canonical JSON array of DeadlineExtensionReceipt records. */
  readonly deadlineExtensions?: string;
};

export interface RunDetail {
  run: {
    runId: string;
    state: RunState;
    attempts: number;
    idempotencyKey: string;
    specHash: string;
    created_at: string;
    updated_at: string;
    spec: RunSpec;
  };
  lifecycle: LifecycleEvent[];
  attempts: Attempt[];
  result: {
    terminalState: string;
    reasonCode: string | null;
    artifact?: unknown;
    artifactHash?: string;
    artifacts?: ArtifactRef[];
    evidence?: unknown;
  } | null;
  receipt: RunReceipt | null;
  workspace: string | null;
  /** Mutable execution deadline; extensions do not change the immutable RunSpec. */
  deadlineAt?: string | null;
  /**
   * What the harness reported it actually ran on, read out of the stored
   * transcript (WM-221) — the only source for a run whose spec pins the
   * `default` sentinel. Null when no transcript was captured, the adapter
   * takes no model, or the harness named none.
   */
  observedModel: string | null;
  /** One-line spec heading from the agent's view `subject` (WM-897). */
  subject?: string | null;
}

/** Which event types route to an agent, and how (GET /agents). */
export interface AgentEventRoute {
  type: string;
  adapter: string;
  idempotencyScope: string;
  proposalTtlSeconds: number | null;
  /**
   * What the planner would pin for this route (WM-135). Resolution is per
   * adapter, which is why it rides the route and not the definition: the same
   * `model_tier: strong` is `default` on claude and a codex id on pi. Null
   * both when the adapter takes no model and when the definition declares
   * none — `routeModel` in views/Agents.tsx tells those two apart.
   */
  resolvedModel: string | null;
}

/**
 * `factory.artifact-view/v1` — the sidecar rendering hints an agent may ship
 * beside its output schema (docs/event-runtime-artifact-views.md §2.2). The
 * closed vocabularies mirror `SECTION_KINDS` / `FORMATS` / `TONES` in
 * `event-runtime/lib/artifact-view.mjs`; per-`as` key applicability is
 * enforced there at registry load, so the web renderer trusts the shape.
 */
export type ArtifactTone = "ok" | "warn" | "error" | "muted" | "neutral";
export type ArtifactFormat =
  | "issue"
  | "pr"
  | "url"
  | "sha"
  | "repo"
  | "run"
  | "duration"
  | "datetime"
  | "state"
  | "bytes"
  | "count";
export type ArtifactSectionKind =
  "table" | "keyvalue" | "list" | "badge" | "code" | "prose";
export interface ArtifactViewSection {
  /** RFC 6901 pointer into the artifact; `""` is the whole document. */
  path: string;
  as: ArtifactSectionKind;
  label?: string;
  /** table */
  columns?: string[];
  groupBy?: string;
  expand?: string[];
  /** keyvalue */
  keys?: string[];
  /** list */
  itemLabel?: string;
  /** code */
  language?: string;
  /** column/key (or `""` for the section value itself) → format */
  formats?: Record<string, ArtifactFormat>;
  /** table/keyvalue/list: column/key → (value → tone); badge: value → tone */
  tone?: Record<string, ArtifactTone | Record<string, ArtifactTone>>;
}
/** Output or input view body — `input` reuses this shape (WM-897). */
export interface ArtifactViewBody {
  title?: string;
  summary?: string;
  status?: { path: string; tone: Record<string, ArtifactTone> };
  sections?: ArtifactViewSection[];
  formats?: Record<string, ArtifactFormat>;
  tone?: Record<string, ArtifactTone | Record<string, ArtifactTone>>;
}
export interface ArtifactView extends ArtifactViewBody {
  schemaVersion: "factory.artifact-view/v1";
  /** One-line spec heading template, rendered server-side onto GET /runs/:id and /proposals. */
  subject?: string;
  /** View body whose pointers resolve against the agent's input schema. */
  input?: ArtifactViewBody;
}

/** One registered agent, fully readable: definition, prompt, schemas, pins. */
export interface AgentDef {
  ref: string;
  id: string;
  version: number;
  outputContract: string;
  workspace: { type: string; retainOnFailure?: boolean };
  capabilities: { filesystem?: string; services?: string[] };
  limits: { timeout_seconds?: number; attempts?: number };
  mutating: boolean;
  promptFile: string;
  prompt: string;
  inputSchemaFile: string;
  inputSchema: unknown;
  outputSchemaFile: string;
  outputSchema: unknown;
  /** Artifact-view sidecar (WM-454), null when the agent ships none. */
  outputViewFile?: string | null;
  outputView?: ArtifactView | null;
  /** Which sidecar applied: the agent file, or the contract-keyed fallback (WM-897). */
  view?: { source: "agent" | "contract" } | null;
  pins: Record<string, string>;
  /** Closed-execution shape: fixed argv (command adapter) or action registry. */
  command: string[] | null;
  actionRegistry: Record<string, { remote: string }> | null;
  hosts: string[] | null;
  /** Declared intent (WM-135): strong | standard | light, or null for none. */
  modelTier: string | null;
  /** Exact model id, when a definition overrides its tier outright. */
  model: string | null;
  eventTypes: AgentEventRoute[];
}

/** One recommendation edge: an artifact value routing to a follow-up event type. */
export interface RecommendationRule {
  recommendationField: string;
  edges: Record<string, { eventType: string; input: Record<string, string> }>;
}

/** Every registered route, independent of which agent mentions it. */
export interface EventRoute {
  type: string;
  agent?: string;
  adapter?: string;
  idempotencyScope?: string[];
  proposalTtlSeconds?: number | null;
}

export interface AgentsView {
  agents: AgentDef[];
  edges: Record<string, RecommendationRule>;
  eventTypes: EventRoute[];
  contracts: Record<string, unknown>;
}

/** A worker's own report of what it is doing; "stopped" is a clean exit. */
export type WorkerState = "idle" | "busy" | "stopped";

export type CapacityLimitingFactor =
  | "at worker max"
  | "no idle worker"
  | "per-repo max_in_flight reached"
  | "owned-paths collision"
  | "budget ceiling";

export interface WorkerClassCapacity {
  name: string;
  running: number;
  capacity: number;
}

/** One consistent capacity projection shared by GET /status and GET /workers. */
export interface WorkerCapacity {
  running: number;
  capacity: number;
  queued: number;
  live: number;
  idle: number;
  draining: number;
  /** Current non-draining pool size; becomes the supervisor target when persisted. */
  target: number;
  min: number | null;
  max: number | null;
  supervisor: "active" | "absent" | "stopped";
  source: "live-workers" | "worker-policy";
  limitingFactor: CapacityLimitingFactor | null;
  /** Empty until class-aware worker policy ships. */
  classes: WorkerClassCapacity[];
}

/** One registered worker process (GET /workers) — the fleet, not the leases. */
export interface Worker {
  workerId: string;
  host: string;
  pid: number;
  /** Placement labels the worker declared, e.g. `{ node: "lab" }`. */
  labels: Record<string, string>;
  adapters: string[];
  state: WorkerState;
  currentRun: string | null;
  lastSeen: string;
  /** Heartbeat older than the stale window: gone, whatever `state` claims. */
  stale: boolean;
  startedAt: string;
  stoppedAt: string | null;
  /** The pool supervisor has asked this worker to exit at its next idle boundary. */
  draining?: boolean;
}

/** A stale worker still holding a run — the doctor's projection, not the row. */
export interface StalledWorker {
  workerId: string;
  host: string;
  /** Always set: the projection only emits workers that hold a run. */
  runId: string;
  lastSeen: string;
}

/** Which runtime this UI is pointed at — live vs dev, adapter override. */
export interface EnvIdentity {
  name: string;
  home: string;
  adapter: string | null;
}

/** A registered scheduler loop that has missed ticks or errored (§9). */
export interface StoppedSchedule {
  loop: string;
  every: string;
  lastSlot: string | null;
  intervalsLate: number;
  error: string | null;
}

/** A scheduled loop that has open proposals piling up beyond threshold (WM-124). */
export interface ProposalPilingUp {
  loop: string;
  count: number;
  threshold: number;
}

/** A queued run whose placement requirements match no live worker. */
export interface UnmatchedPlacementRun {
  runId: string;
  placement: Record<string, unknown>;
}

export interface StatusView {
  env: EnvIdentity;
  events: Record<string, number>;
  proposals: { open: number; expired: number };
  runs: { byState: Partial<Record<RunState, number>> };
  /** Fleet counts; `live` and `busy` exclude stale workers, as the API does. */
  workers: { live: number; busy: number; stale: number };
  /** Absent only when the UI is talking to a pre-WM-228 control API. */
  capacity?: WorkerCapacity;
  /** Human inbox counts (WM-285); absent on a pre-inbox control API. */
  inbox?: { open: number; acked: number; byKind?: Record<string, number> };
  /** Artifact store rollup; `orphans` counts files no result references. Cached ~10s server-side (`at` = when computed). */
  artifacts: {
    files: number;
    bytes: number;
    orphans: number;
    orphanBytes: number;
    at?: string;
  };
  /** `approve.before` hook decisions in the trailing 24h, by hook id (WM-842); absent on a pre-hooks control API. */
  hooks?: {
    decisions24h: Record<
      string,
      { source: string; point: string; allow: number; deny: number }
    >;
  };
  anomalies: {
    configuration?: string[];
    expiredOpenProposals: string[];
    staleLeases: number;
    unpublishedOutbox: number;
    deadLettered: {
      source: string;
      eventId: string;
      lastError: string | null;
    }[];
    stalledWorkers: StalledWorker[];
    stoppedSchedules?: StoppedSchedule[];
    /** Placement-constrained queued runs that no active, non-stale worker can claim. */
    unmatchedPlacementRuns?: UnmatchedPlacementRun[];
    /** Queued runs with no live worker to claim them. */
    noWorkers: boolean;
    ambiguousOpenProposals: { runId: string; count: number }[];
    proposalsPilingUp?: ProposalPilingUp[];
  };
}

export interface ApproveOutcome {
  approved: boolean;
  runId?: string;
  replanned?: boolean;
  proposal?: Proposal;
}

export interface CancelOutcome {
  cancelled: boolean;
  ambiguousOpenProposals?: { runId: string; count: number }[];
}

/** Deep-link payload for the Events inbox (tab, type chip, and/or a specific row). */
export interface EventFocus {
  status?: string;
  source?: string;
  eventId?: string;
  type?: string;
}

/** Configured factory repository (GET /repos). */
export interface RepoItem {
  name: string;
  path: string;
  github: string | null;
  team: string | null;
  project: string | null;
  base: string;
  deployBranch: string | null;
  reportOnly: boolean;
  maxInFlight: number | null;
  worktreeRoot: string | null;
  hasWorktreeUp: boolean;
  hasWorktreeDown: boolean;
  hasWorktreeWarm: boolean;
  verify: string | null;
}

/** Janitor scan/cleanup result (POST /repos/:name/janitor). */
export interface JanitorResult {
  repo: string;
  apply: boolean;
  actor: string;
  reclaimable: { id: string; state: string }[];
  kept: { id: string; state: string }[];
  named: string[];
  unknown: string[];
  removed: string[];
  refused: { id: string; reason: string }[];
  held: { id: string; state: string; branch?: string; reason: string }[];
  skippedApplyReason?: string;
}

/** The kinds the inbox ledger accepts (lib/inbox.mjs INBOX_KINDS). */
export type InboxKind =
  | "BLOCKED"
  | "ESCALATED"
  | "CI RED"
  | "SMOKE RED"
  | "CIRCUIT BREAKER"
  | "RC READY"
  | "human_needed"
  | "decision_needed"
  | "proposal_expired";

export type InboxStatus = "open" | "acked" | "resolved" | "all";

/** Cross-references an inbox item carries; each is a jump target. */
export interface InboxRefs {
  runId?: string;
  proposalId?: string;
  eventSource?: string;
  eventId?: string;
  issue?: string;
  pr?: string;
  repo?: string;
}

/** Telegram projection record written by deliverInboxItem; absent = not attempted. */
export interface InboxDelivery {
  telegram?: {
    sent_at: string;
    exit_code: number | null;
    error: string | null;
  };
}

export type DecisionTone = "primary" | "danger" | "neutral";
export type DecisionEffectKind =
  | "authorise"
  | "send_to_triage"
  | "answer"
  | "requeue"
  | "approve_proposal"
  | "reject_proposal"
  | "dismiss";

export interface DecisionChoice {
  id: string;
  label: string;
  description?: string;
}

interface DecisionFieldBase {
  id: string;
  label: string;
  required?: boolean;
  whenOption?: string[];
}

export type DecisionField =
  | (DecisionFieldBase & {
      kind: "text";
      placeholder?: string;
      maxLength?: number;
    })
  | (DecisionFieldBase & {
      kind: "single-choice";
      choices: DecisionChoice[];
    })
  | (DecisionFieldBase & {
      kind: "multi-choice";
      choices: DecisionChoice[];
      minItems?: number;
      maxItems?: number;
    })
  | (DecisionFieldBase & { kind: "confirm" })
  | (DecisionFieldBase & {
      kind: "number";
      minimum?: number;
      maximum?: number;
      integer?: boolean;
    });

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  effect: DecisionEffectKind;
  tone?: DecisionTone;
  scope?: { paths: string[]; summary: string };
}

export interface DecisionRequest {
  schemaVersion: "factory.decision-request/v1";
  question: string;
  context?: string;
  recommended?: string;
  options: DecisionOption[];
  fields?: DecisionField[];
}

export interface DecisionEffect {
  kind: DecisionEffectKind | string;
  outcome: "applied" | "failed" | string;
  error?: string;
  retryAttempt?: number;
  [key: string]: unknown;
}

export interface DecisionResponse {
  schemaVersion: "factory.decision-response/v1";
  requestHash: string;
  optionId: string;
  fields: Record<string, unknown>;
  decidedBy: string;
  decidedAt: string;
  effect?: DecisionEffect;
}

export interface DecisionSupersededResponse {
  superseded: true;
  reason: string;
  decidedBy: string;
  decidedAt: string;
}

export type InboxDecisionResponse =
  DecisionResponse | DecisionSupersededResponse;

/** The browser sends this shape; the API supplies actor and timestamp. */
export type DecisionResponseInput = Omit<
  DecisionResponse,
  "decidedBy" | "decidedAt" | "effect"
>;

/** One row of the human inbox ledger (GET /inbox). */
export interface InboxItem {
  id: string;
  kind: InboxKind | string;
  severity: string;
  title: string;
  body: string | null;
  refs: InboxRefs;
  /** `cli`, `serve:notify`, or `agent:<runId>`. */
  source: string;
  createdAt: string;
  ackedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Resolution audit note; absent only in fixtures or responses from pre-migration runtimes. */
  resolvedReason?: string | null;
  delivery: InboxDelivery;
  decision?: DecisionRequest | null;
  response?: InboxDecisionResponse | null;
  decidedAt?: string | null;
  decidedBy?: string | null;
  dedupeKey?: string | null;
}

/** One recent ticket summary (GET /tickets). */
export interface TicketSummary {
  id: string;
  title?: string | null;
  state?: string | null;
  repo?: string | null;
  repos?: string[];
  lastActivityAt?: string;
  lastActivityDescription?: string | null;
  lastActivityKind?: string | null;
  attempts?: number;
  activeRun?: { runId: string; state: string; agent: string } | null;
  lastDecision?: string | null;
  pr?: { number: number; url?: string; ci?: string } | number | null;
  prUrl?: string | null;
  checksGreen?: boolean | null;
  ciStatus?: "green" | "red" | "pending" | string | null;
  url?: string | null;
  merged?: boolean;
}

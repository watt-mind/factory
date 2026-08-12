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
  planFailures: number;
  lastPlanError: string | null;
  admittedAt: string;
  envelope: Record<string, unknown>;
}

export interface RunListItem {
  runId: string;
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

/** Durable, content-addressed artifact — bytes stream from GET /artifacts/:sha256. */
export interface ArtifactRef {
  kind: string;
  uri: string;
  sha256: string;
  sizeBytes: number;
}

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
  receipt: Record<string, string | null> | null;
  workspace: string | null;
}

/** Which event types route to an agent, and how (GET /agents). */
export interface AgentEventRoute {
  type: string;
  adapter: string;
  idempotencyScope: string;
  proposalTtlSeconds: number | null;
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
  pins: Record<string, string>;
  /** Closed-execution shape: fixed argv (command adapter) or action registry. */
  command: string[] | null;
  actionRegistry: Record<string, { remote: string }> | null;
  hosts: string[] | null;
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
  agent: string;
  adapter: string;
  idempotencyScope: string[];
  proposalTtlSeconds: number | null;
}

export interface AgentsView {
  agents: AgentDef[];
  edges: Record<string, RecommendationRule>;
  eventTypes: EventRoute[];
  contracts: Record<string, unknown>;
}

/** Which runtime this UI is pointed at — live vs dev, adapter override. */
export interface EnvIdentity {
  name: string;
  home: string;
  adapter: string | null;
}

export interface StatusView {
  env: EnvIdentity;
  events: Record<string, number>;
  proposals: { open: number; expired: number };
  runs: { byState: Partial<Record<RunState, number>> };
  anomalies: {
    expiredOpenProposals: string[];
    staleLeases: number;
    unpublishedOutbox: number;
    deadLettered: { source: string; eventId: string; lastError: string | null }[];
  };
}

export interface ApproveOutcome {
  approved: boolean;
  runId?: string;
  replanned?: boolean;
  proposal?: Proposal;
}

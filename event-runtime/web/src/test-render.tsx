/**
 * Component testing harness and test render helper for event-runtime-web (OPS-249).
 *
 * This module provides:
 * - `renderWithClient`: mounts a React component inside a TanStack Query `QueryClientProvider`
 *   configured specifically for unit/component tests with retries and background refetches disabled.
 * - `createTestQueryClient`: factory for test QueryClient instances.
 * - `stubApi` / `restoreApi` / `withApi`: robust API mocking via `bun:test` mocks with comprehensive defaults.
 * - `changeInput`: helper to trigger onChange and onInput on controlled form elements in happy-dom.
 * - `typeText`: helper to simulate keystroke-level typing with cursor progression on inputs/textareas.
 * - Test fixture generators for StatusView, RunListItem, RunDetail, AdmittedEvent, Proposal, Worker, etc.
 *
 * Import this module in DOM component tests. It automatically registers happy-dom globals.
 */
import "./test-dom";
import { mock } from "bun:test";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "./api";
import type {
  AdmittedEvent,
  AgentsView,
  ApproveOutcome,
  CancelOutcome,
  EnvIdentity,
  JanitorResult,
  JournalView,
  LifecycleEvent,
  ModelTierCellResult,
  ModelTierConfig,
  OutboxRow,
  Proposal,
  RepoItem,
  RunDetail,
  RunListItem,
  RunSpec,
  RunState,
  StatusView,
  TraceView,
  Worker,
} from "./types";

// ============================================================================
// Fixture Factories
// ============================================================================

export function createEnvFixture(
  overrides?: Partial<EnvIdentity>,
): EnvIdentity {
  return {
    name: "test",
    home: "/tmp/factory-test",
    adapter: null,
    ...overrides,
  };
}

export function createStatusFixture(
  overrides?: Partial<StatusView>,
): StatusView {
  return {
    env: createEnvFixture(),
    events: {},
    proposals: { open: 0, expired: 0 },
    runs: { byState: {} },
    workers: { live: 1, busy: 0, stale: 0 },
    artifacts: { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 },
    anomalies: {
      expiredOpenProposals: [],
      staleLeases: 0,
      unpublishedOutbox: 0,
      deadLettered: [],
      stalledWorkers: [],
      noWorkers: false,
      ambiguousOpenProposals: [],
    },
    ...overrides,
  };
}

export function createRunListItemFixture(
  overrides?: Partial<RunListItem>,
): RunListItem {
  const now = new Date().toISOString();
  const runId = overrides?.runId ?? "run_test_1001";
  return {
    runId,
    spec: createRunSpecFixture(runId),
    state: "RUNNING",
    attempts: 1,
    maxAttempts: 3,
    agent: "triage-scan",
    adapter: "claude-code",
    reasonCode: null,
    eventId: "evt_1001",
    eventSource: "github",
    created_at: now,
    updated_at: now,
    modelTier: null,
    model: null,
    repos: ["repo-test"],
    ...overrides,
  };
}

export function createLifecycleEventFixture(
  seq: number,
  runId: string,
  from: string | null,
  to: string,
  reason: string | null = null,
  at?: string,
): LifecycleEvent {
  return {
    seq,
    run_id: runId,
    from_state: from,
    to_state: to,
    actor: "worker_test",
    reason,
    attempt: 1,
    at: at ?? new Date().toISOString(),
  };
}

export function createRunSpecFixture(
  runId = "run_test_1001",
  overrides?: Partial<RunSpec>,
): RunSpec {
  return {
    schemaVersion: "1",
    runId,
    agent: "triage-scan",
    input: { prompt: "Analyze issue" },
    inputHash: "input_hash_1",
    workspace: { type: "ephemeral" },
    adapter: "claude-code",
    promptVersion: "1",
    policyVersion: "1",
    outputContract: "triage/v1",
    capabilities: [],
    timeoutSeconds: 600,
    maxAttempts: 3,
    idempotencyKey: `idem-${runId}`,
    ...overrides,
  };
}

export function createRunDetailFixture(
  overrides?: Partial<RunDetail>,
): RunDetail {
  const now = new Date().toISOString();
  const runId = overrides?.run?.runId ?? "run_test_1001";
  const state: RunState = overrides?.run?.state ?? "RUNNING";

  return {
    run: {
      runId,
      state,
      attempts: 1,
      idempotencyKey: `idem-${runId}`,
      specHash: "spec_hash_1",
      created_at: now,
      updated_at: now,
      spec: createRunSpecFixture(runId, overrides?.run?.spec),
      ...overrides?.run,
    },
    lifecycle: overrides?.lifecycle ?? [
      createLifecycleEventFixture(1, runId, null, "QUEUED", null, now),
      createLifecycleEventFixture(2, runId, "QUEUED", state, null, now),
    ],
    attempts: overrides?.attempts ?? [
      {
        run_id: runId,
        attempt: 1,
        lease_owner: "worker_test",
        lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
        started_at: now,
        finished_at: null,
        terminal_state: null,
        reason_code: null,
        workspace_path: "/tmp/workspaces/test",
      },
    ],
    result: overrides?.result ?? null,
    receipt: overrides?.receipt ?? null,
    workspace: overrides?.workspace ?? null,
    observedModel: overrides?.observedModel ?? null,
  };
}

export function createEventFixture(
  overrides?: Partial<AdmittedEvent>,
): AdmittedEvent {
  const now = new Date().toISOString();
  return {
    source: "github",
    eventId: "evt_1001",
    type: "pull_request.opened",
    subject: "factory/repo-test",
    status: "admitted",
    occurredAt: now,
    receivedAt: now,
    correlationId: "corr_1001",
    planFailures: 0,
    lastPlanError: null,
    admittedAt: now,
    proposalId: null,
    runId: null,
    envelope: {
      schemaVersion: "factory.event/v1",
      eventId: "evt_1001",
      type: "pull_request.opened",
      source: "github",
      occurredAt: now,
    },
    repos: ["repo-test"],
    ...overrides,
  };
}

export function createProposalFixture(overrides?: Partial<Proposal>): Proposal {
  const now = new Date().toISOString();
  const id = overrides?.id ?? "prop_1001";
  return {
    id,
    decision: "run",
    status: "open",
    expired: false,
    created_at: now,
    ttl_seconds: 300,
    decided_at: null,
    decided_by: null,
    reason: null,
    runId: "run_prop_1001",
    eventId: "evt_1001",
    eventSource: "github",
    agent: "triage-scan",
    spec: createRunSpecFixture("run_prop_1001"),
    repos: ["repo-test"],
    ...overrides,
  };
}

export function createWorkerFixture(overrides?: Partial<Worker>): Worker {
  const now = new Date().toISOString();
  return {
    workerId: "worker_1",
    host: "host-1",
    pid: 1234,
    labels: { env: "test" },
    adapters: ["claude-code"],
    state: "idle",
    currentRun: null,
    lastSeen: now,
    stale: false,
    startedAt: now,
    stoppedAt: null,
    ...overrides,
  };
}

export function createAgentsFixture(
  overrides?: Partial<AgentsView>,
): AgentsView {
  return {
    agents: [],
    eventTypes: [],
    edges: {},
    contracts: {},
    schemaHash: "fixture-hash",
    publishedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as AgentsView;
}

// ============================================================================
// API Stubbing & Mocking Harness
// ============================================================================

export type ApiKey = keyof typeof api;
export type ApiStubMap = {
  [K in ApiKey]?: (typeof api)[K];
};

const originalApi: typeof api = { ...api };

/**
 * Creates default mock implementations for all API endpoints.
 */
export function createDefaultApiMocks(): Record<ApiKey, any> {
  return {
    health: mock(async () => ({
      ok: true,
      policyVersion: "1.0",
      env: createEnvFixture(),
    })),
    status: mock(async () => createStatusFixture()),
    events: mock(async (_status?: string) => ({
      events: [] as AdmittedEvent[],
    })),
    chain: mock(async (correlationId: string) => ({
      correlationId,
      events: [],
      runs: [],
    })),
    chains: mock(async (_window = "24h", _limit = 100) => ({ chains: [] })),
    proposals: mock(async () => ({ proposals: [] as Proposal[] })),
    proposalHistory: mock(async (_status = "all") => ({
      proposals: [] as Proposal[],
    })),
    approve: mock(async (id: string): Promise<ApproveOutcome> => ({
      approved: true,
      runId: `run_${id}`,
    })),
    reject: mock(async (_id: string, _reason?: string) => ({ rejected: true })),
    runs: mock(async (_state?: string) => ({ runs: [] as RunListItem[] })),
    run: mock(async (id: string) =>
      createRunDetailFixture({ run: { runId: id, state: "RUNNING" } as any }),
    ),
    trace: mock(
      async (_id: string, _since = 0, _limit = 500): Promise<TraceView> => ({
        head: 0,
        entries: [],
      }),
    ),
    cancel: mock(
      async (_id: string, _reason?: string): Promise<CancelOutcome> => ({
        cancelled: true,
      }),
    ),
    retry: mock(async (_id: string, _force = false) => ({ queued: true })),
    replay: mock(async (_envelope: unknown) => ({
      admitted: true,
      duplicate: false,
      eventId: "evt_replayed_1",
    })),
    injectEvent: mock(
      async (
        _type: string,
        _payload: Record<string, unknown>,
        _source = "factory-web",
      ) => ({
        admitted: true,
        duplicate: false,
        eventId: `evt_injected_${Date.now()}`,
      }),
    ),
    journal: mock(async (_since = 0, _limit = 100): Promise<JournalView> => ({
      head: 0,
      entries: [],
    })),
    outbox: mock(async (_limit = 20): Promise<{ outbox: OutboxRow[] }> => ({
      outbox: [],
    })),
    requeue: mock(async (_source: string, _eventId: string) => ({
      requeued: true,
    })),
    archive: mock(async (_source: string, _eventId: string) => ({
      archived: true,
    })),
    releaseWorker: mock(async (_workerId: string, runId: string) => ({
      released: true,
      runId,
    })),
    terminateWorkspace: mock(async (_workerId: string, runId: string) => ({
      released: true,
      runId,
      terminated: true as const,
    })),
    agents: mock(async () => createAgentsFixture()),
    putEventTypeOverride: mock(
      async (_type: string, body: { adapter: string }) => ({
        patch: { adapter: body.adapter },
      }),
    ),
    deleteEventTypeOverride: mock(async (_type: string) => ({
      deleted: true,
    })),
    putAgentOverride: mock(
      async (
        _ref: string,
        body: { modelTier?: string | null; model?: string | null },
      ) => ({
        patch: { ...body },
      }),
    ),
    deleteAgentOverride: mock(async (_ref: string) => ({
      deleted: true,
    })),
    panels: mock(async () => ({ panels: [], endpoints: [] })),
    panelSource: mock(
      async (_endpoint: string, _query?: Record<string, string>) => ({}),
    ),
    repos: mock(async (): Promise<{ repos: RepoItem[] }> => ({ repos: [] })),
    // Overlay promotion (gh-860): default mocks return an empty, no-op preview.
    promotionPreview: mock(async () => ({ digest: "", selections: [] })),
    promotionApply: mock(async () => ({
      status: "noop" as const,
      ticket: null,
      pr: null,
    })),
    janitor: mock(
      async (name: string, apply = false): Promise<JanitorResult> => ({
        repo: name,
        apply,
        actor: "janitor",
        reclaimable: [],
        kept: [],
        named: [],
        unknown: [],
        removed: [],
        refused: [],
        held: [],
      }),
    ),
    workers: mock(async (): Promise<{ workers: Worker[] }> => ({
      workers: [],
    })),
    tickets: mock(async () => ({ tickets: [] })),
    inbox: mock(async (_status = "open") => ({ items: [] })),
    ackInbox: mock(async (id: string) => ({ item: { id } })),
    resolveInbox: mock(async (id: string, _reason?: string) => ({
      item: { id },
    })),
    schedules: mock(async (): Promise<{ schedules: any[] }> => ({
      schedules: [],
    })),
    modelTierConfig: mock(async (): Promise<ModelTierConfig> => ({
      adapters: ["claude", "pi", "agy", "cursor"],
      tiers: ["strong", "standard", "light"],
      tracked: {
        claude: { strong: "opus", standard: "sonnet", light: "haiku" },
      },
      runtime: {},
      effective: {
        claude: { strong: "opus", standard: "sonnet", light: "haiku" },
      },
    })),
    putModelTierCell: mock(
      async (
        adapter: string,
        tier: string,
        model: string,
      ): Promise<ModelTierCellResult> => ({
        adapter,
        tier,
        trackedModel: null,
        runtimeModel: model,
        effectiveModel: model,
        source: "runtime",
        restartRequired: true,
      }),
    ),
    deleteModelTierCell: mock(
      async (adapter: string, tier: string): Promise<ModelTierCellResult> => ({
        adapter,
        tier,
        trackedModel: null,
        runtimeModel: null,
        effectiveModel: null,
        source: "tracked",
        restartRequired: true,
        deleted: true,
      }),
    ),
    triggerSchedule: mock(async (_loop: string, _prNumbers?: number[]) => ({
      admitted: true,
      duplicate: false,
      eventId: "manual:fixture",
      proposalId: null,
      runId: "run_mock_1",
      decision: "run",
      reason: null,
      disabled: false,
      loop: _loop,
    })),
  };
}

/**
 * Replaces methods on `api` with `bun:test` mocks.
 * Any method not specified in `overrides` will receive a default no-op mock implementation.
 */
export function stubApi(overrides: ApiStubMap = {}): typeof api {
  const defaults = createDefaultApiMocks();
  for (const key of Object.keys(originalApi) as ApiKey[]) {
    if (key in overrides && overrides[key] !== undefined) {
      const fn = overrides[key];
      (api as any)[key] = typeof fn === "function" ? mock(fn) : fn;
    } else {
      (api as any)[key] = defaults[key];
    }
  }
  return api;
}

/**
 * Restores original un-mocked implementations on `api`.
 */
export function restoreApi(): void {
  for (const key of Object.keys(originalApi) as ApiKey[]) {
    (api as any)[key] = originalApi[key];
  }
}

/**
 * Executes a callback with custom API stubs, automatically restoring original API on finish.
 */
export async function withApi<T>(
  overrides: ApiStubMap,
  fn: () => Promise<T> | T,
): Promise<T> {
  stubApi(overrides);
  try {
    return await fn();
  } finally {
    restoreApi();
  }
}

// ============================================================================
// QueryClient & Component Render Harness
// ============================================================================

/**
 * Creates a TanStack Query `QueryClient` configured for deterministic testing:
 * - Queries: retry: false, refetchInterval: false, refetchOnWindowFocus: false, gcTime: Infinity
 * - Mutations: retry: false
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        gcTime: Infinity,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export interface RenderOptions {
  queryClient?: QueryClient;
  apiMocks?: ApiStubMap;
}

export type CustomRenderResult = RenderResult & {
  queryClient: QueryClient;
};

/**
 * Mounts a React component inside a test-configured `QueryClientProvider`.
 * If `apiMocks` is provided in options, stubs the API endpoints before rendering.
 */
export function renderWithClient(
  ui: React.ReactElement,
  options: RenderOptions = {},
): CustomRenderResult {
  if (options.apiMocks) {
    stubApi(options.apiMocks);
  }
  const queryClient = options.queryClient ?? createTestQueryClient();
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const utils = render(ui, { wrapper: Wrapper });
  return {
    ...utils,
    queryClient,
  };
}

/**
 * Sets native value on an HTMLInputElement, HTMLTextAreaElement, or HTMLSelectElement,
 * invoking the prototype property descriptor setter to bypass React's instance-level
 * value tracker interceptor.
 */
function setNativeValue(element: HTMLElement, value: string): void {
  let proto: any = Object.getPrototypeOf(element);
  let descriptor: PropertyDescriptor | undefined;
  while (proto) {
    descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      break;
    }
    proto = Object.getPrototypeOf(proto);
  }

  const setter =
    descriptor?.set ??
    (element instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
          ?.set
      : element instanceof HTMLSelectElement
        ? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
            ?.set
        : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
            ?.set);

  if (setter) {
    setter.call(element, value);
  } else {
    (element as any).value = value;
  }
}

/**
 * Helper to reliably trigger onChange and onInput on controlled React inputs in happy-dom.
 * Sets the native DOM value via prototype descriptor and dispatches standard bubbling
 * input and change DOM events, without relying on private React internals.
 */
export function changeInput(el: HTMLElement, value: string): void {
  if (typeof el.focus === "function" && document.activeElement !== el) {
    try {
      el.focus();
    } catch {}
  }
  setNativeValue(el, value);
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  el.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true }),
  );
  el.dispatchEvent(
    new KeyboardEvent("keyup", { bubbles: true, cancelable: true }),
  );
}

/**
 * Simulates keystroke-level typing into an input or textarea element.
 * For each character, emits keyDown, updates value with cursor/selection range progression,
 * emits input and keyUp, and finally emits change when typing is complete.
 */
export function typeText(element: HTMLElement, text: string): void {
  if (
    typeof element.focus === "function" &&
    document.activeElement !== element
  ) {
    try {
      element.focus();
    } catch {}
  }
  for (const char of text) {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: char,
        bubbles: true,
        cancelable: true,
      }),
    );

    const currentVal =
      (element as HTMLInputElement | HTMLTextAreaElement).value ?? "";
    const start = (element as any).selectionStart ?? currentVal.length;
    const end = (element as any).selectionEnd ?? currentVal.length;
    const nextVal = currentVal.slice(0, start) + char + currentVal.slice(end);

    setNativeValue(element, nextVal);

    const nextPos = start + char.length;
    if (typeof (element as any).setSelectionRange === "function") {
      try {
        (element as any).setSelectionRange(nextPos, nextPos);
      } catch {}
    } else {
      try {
        (element as any).selectionStart = nextPos;
        (element as any).selectionEnd = nextPos;
      } catch {}
    }

    try {
      element.dispatchEvent(
        new InputEvent("input", {
          data: char,
          inputType: "insertText",
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      element.dispatchEvent(
        new Event("input", { bubbles: true, cancelable: true }),
      );
    }

    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: char,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  element.dispatchEvent(
    new Event("change", { bubbles: true, cancelable: true }),
  );
}

import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  Overview,
  groupJournalEntries,
  formatActivityGroup,
  buildAnomalyRows,
  groupDeadLetters,
  stripAnomalyKindPrefix,
} from "./Overview";
import { shortId } from "../components/ui";
import { api } from "../api";
import type { OperatorContext } from "../context";
import { scopedCount, scopedTally } from "../context";
import { restoreApi, withApi } from "../test-render";
import type {
  AdmittedEvent,
  EventFocus,
  InboxItem,
  JournalEntry,
  Proposal,
  RunListItem,
  StatusView,
} from "../types";

afterEach(() => {
  cleanup();
});

// Bun restores its fetch mock when each test begins. Reassert the fail-closed
// DOM-test contract in tests that intentionally exercise an unmocked request.
function installFetchGuard() {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const rawUrl = request?.url ?? String(input);
    const url = new URL(rawUrl, "http://localhost/");
    const path = `${url.pathname}${url.search}`.replace(/^\/api(?=\/)/, "");
    throw new Error(`unmocked api call: ${method} ${path}`);
  }) as unknown as typeof fetch;
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const noop = () => {};

function UnmockedApiProbe() {
  const query = useQuery({
    queryKey: ["unmocked-status"],
    queryFn: api.status,
  });
  return (
    <p>{query.error instanceof Error ? query.error.message : "pending"}</p>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function baseStatus(
  overrides: Partial<StatusView["anomalies"]> = {},
): StatusView {
  return {
    env: { name: "test", home: "/tmp/test", adapter: null },
    events: {},
    proposals: { open: 0, expired: 1 },
    runs: { byState: {} },
    workers: { live: 0, busy: 0, stale: 0 },
    capacity: {
      running: 0,
      capacity: 0,
      queued: 0,
      live: 0,
      idle: 0,
      draining: 0,
      target: 0,
      min: null,
      max: null,
      supervisor: "absent",
      source: "live-workers",
      limitingFactor: null,
      classes: [],
    },
    artifacts: { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 },
    anomalies: {
      expiredOpenProposals: [],
      staleLeases: 0,
      unpublishedOutbox: 0,
      deadLettered: [],
      stalledWorkers: [],
      noWorkers: false,
      ambiguousOpenProposals: [],
      ...overrides,
    },
  };
}

function stubEvent(
  overrides: Partial<AdmittedEvent> &
    Pick<AdmittedEvent, "eventId" | "status" | "repos">,
): AdmittedEvent {
  const now = new Date().toISOString();
  return {
    source: "github",
    type: "pull_request.opened",
    subject: null,
    occurredAt: now,
    receivedAt: now,
    correlationId: null,
    planFailures: 0,
    lastPlanError: null,
    admittedAt: now,
    proposalId: null,
    runId: null,
    envelope: {},
    ...overrides,
  };
}

function stubRun(
  overrides: Partial<RunListItem> &
    Pick<RunListItem, "runId" | "state" | "repos">,
): RunListItem {
  const now = new Date().toISOString();
  return {
    spec: {
      schemaVersion: "factory.run-spec/v1",
      runId: overrides.runId,
      agent: "triage-scan",
      input: { repos: overrides.repos },
      inputHash: "sha256:overview",
      workspace: { type: "ephemeral" },
      adapter: "fake",
      promptVersion: "1",
      policyVersion: "1",
      outputContract: "triage/v1",
      capabilities: [],
      timeoutSeconds: 600,
      maxAttempts: 3,
      idempotencyKey: `idem-${overrides.runId}`,
    },
    attempts: 1,
    maxAttempts: 3,
    agent: "triage-scan",
    adapter: "fake",
    reasonCode: null,
    eventId: null,
    eventSource: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const stubProposal: Proposal = {
  id: "prop_abc123def456",
  decision: "human_needed",
  status: "open",
  expired: true,
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ttl_seconds: 60,
  decided_at: null,
  decided_by: null,
  reason: "ambiguous repo pin",
  runId: null,
  eventId: "evt-789",
  eventSource: "github",
  agent: "triage-scan",
  spec: null,
  repos: [],
};

type OverviewCallbacks = Partial<
  Pick<
    React.ComponentProps<typeof Overview>,
    | "onJumpRun"
    | "onJumpProposal"
    | "onJumpEvents"
    | "onJumpRuns"
    | "onNavigate"
    | "onJumpExpired"
  >
>;

function renderOverview(
  context: OperatorContext = { kind: "all" },
  callbacks: OverviewCallbacks = {},
) {
  return renderWithClient(
    <Overview
      connected={true}
      context={context}
      onJumpRun={callbacks.onJumpRun ?? noop}
      onJumpProposal={callbacks.onJumpProposal ?? noop}
      onJumpEvents={callbacks.onJumpEvents ?? noop}
      onJumpRuns={callbacks.onJumpRuns ?? noop}
      onNavigate={callbacks.onNavigate ?? noop}
      onJumpExpired={callbacks.onJumpExpired ?? noop}
      onJumpGraph={noop}
      onInject={noop}
    />,
  );
}

/**
 * Scope a query to the anomaly remediation deck. Needs-you (WM-596) repeats the
 * same anomaly text above it, so unscoped text/role queries are ambiguous.
 */
function deck(view: ReturnType<typeof renderOverview>) {
  return within(view.getByLabelText("Anomalies"));
}

/** Build a journal entry; the feed keeps entries newest-first, so tests pass them that way. */
function entry(
  overrides: Partial<JournalEntry> & Pick<JournalEntry, "seq" | "runId" | "to">,
): JournalEntry {
  return {
    from: null,
    actor: "worker",
    reason: null,
    attempt: 1,
    at: new Date(Date.now() - overrides.seq * 1000).toISOString(),
    ...overrides,
  };
}

describe("groupJournalEntries (WM-100)", () => {
  test("collapses consecutive transitions of one run into a single row spanning first → last state", () => {
    // Newest-first: run_a went PROPOSED → QUEUED → LEASED → RUNNING → FAILED.
    const entries: JournalEntry[] = [
      entry({ seq: 5, runId: "run_a", from: "RUNNING", to: "FAILED" }),
      entry({ seq: 4, runId: "run_a", from: "LEASED", to: "RUNNING" }),
      entry({ seq: 3, runId: "run_a", from: "QUEUED", to: "LEASED" }),
      entry({ seq: 2, runId: "run_a", from: "PROPOSED", to: "QUEUED" }),
    ];
    const groups = groupJournalEntries(entries);
    expect(groups.length).toBe(1);
    expect(groups[0]!.runId).toBe("run_a");
    expect(groups[0]!.from).toBe("PROPOSED");
    expect(groups[0]!.to).toBe("FAILED");
    expect(groups[0]!.count).toBe(4);
    expect(groups[0]!.path).toEqual([
      "PROPOSED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "FAILED",
    ]);
    // Key, timestamp, and actor come from the most recent transition.
    expect(groups[0]!.seq).toBe(5);
    expect(groups[0]!.at).toBe(entries[0]!.at);
  });

  test("interleaved runs group only consecutive spans, preserving newest-first order", () => {
    const entries: JournalEntry[] = [
      entry({ seq: 6, runId: "run_a", from: "RUNNING", to: "COMPLETED" }),
      entry({ seq: 5, runId: "run_a", from: "LEASED", to: "RUNNING" }),
      entry({ seq: 4, runId: "run_b", from: "QUEUED", to: "LEASED" }),
      entry({ seq: 3, runId: "run_a", from: "QUEUED", to: "LEASED" }),
      entry({ seq: 2, runId: "run_b", from: null, to: "QUEUED" }),
    ];
    const groups = groupJournalEntries(entries);
    expect(groups.map((g) => [g.runId, g.from, g.to, g.count])).toEqual([
      ["run_a", "LEASED", "COMPLETED", 2],
      ["run_b", "QUEUED", "LEASED", 1],
      ["run_a", "QUEUED", "LEASED", 1],
      ["run_b", null, "QUEUED", 1],
    ]);
  });

  test("single-transition runs pass through one row each", () => {
    const entries: JournalEntry[] = [
      entry({ seq: 3, runId: "run_c", from: "RUNNING", to: "COMPLETED" }),
      entry({ seq: 2, runId: "run_b", from: null, to: "QUEUED" }),
      entry({
        seq: 1,
        runId: "run_a",
        from: "QUEUED",
        to: "CANCELLED",
        reason: "operator",
      }),
    ];
    const groups = groupJournalEntries(entries);
    expect(groups.length).toBe(3);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
    expect(groups.map((g) => g.seq)).toEqual([3, 2, 1]);
    expect(groups[2]!.reason).toBe("operator");
  });

  test("formats collapsed steps without ellipsis and suppresses state-duplicate reasons", () => {
    const [group] = groupJournalEntries([
      entry({
        seq: 3,
        runId: "run_a",
        from: "RUNNING",
        to: "COMPLETED",
        reason: "exit_0",
      }),
      entry({ seq: 2, runId: "run_a", from: "LEASED", to: "RUNNING" }),
      entry({ seq: 1, runId: "run_a", from: "QUEUED", to: "LEASED" }),
    ]);

    const row = formatActivityGroup(group!);
    expect(row.steps).toBe("+3 steps");
    expect(row.path).toBe("QUEUED → LEASED → RUNNING → COMPLETED");
    expect(row.path).not.toContain("…");
    expect(row.reason).toBeNull();
  });

  test("empty input produces no rows", () => {
    expect(groupJournalEntries([])).toEqual([]);
  });
});

describe("anomaly normalization (WM-548)", () => {
  test("groups dead letters only when source and error message both match", () => {
    const groups = groupDeadLetters([
      { source: "chain", eventId: "chain-run_1", lastError: "duplicate key" },
      { source: "chain", eventId: "chain-run_2", lastError: "duplicate key" },
      { source: "chain", eventId: "chain-run_3", lastError: "timeout" },
      { source: "github", eventId: "delivery_1", lastError: "duplicate key" },
    ]);

    expect(
      groups.map((group) => [
        group.source,
        group.errorMessage,
        group.events.length,
      ]),
    ).toEqual([
      ["chain", "duplicate key", 2],
      ["chain", "timeout", 1],
      ["github", "duplicate key", 1],
    ]);
    expect(groups[0]!.events.map((event) => event.eventId)).toEqual([
      "chain-run_1",
      "chain-run_2",
    ]);
  });

  test("strips a redundant kind prefix without altering unrelated text", () => {
    expect(
      stripAnomalyKindPrefix(
        "configuration",
        "configuration: FACTORY_EVENT_SECRET is unset",
      ),
    ).toBe("FACTORY_EVENT_SECRET is unset");
    expect(
      stripAnomalyKindPrefix(
        "dead_letter",
        "dead-lettered (chain, chain-run_123): UNIQUE constraint failed",
      ),
    ).toBe("chain, chain-run_123: UNIQUE constraint failed");
    expect(
      stripAnomalyKindPrefix("proposal", "expired open proposal prop_123"),
    ).toBe("expired open proposal prop_123");
  });
});

describe("Overview activity feed rendering (WM-100)", () => {
  test("renders one grouped row per run span with the collapsed transition count", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () => baseStatus();
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({
      head: 4,
      entries: [
        entry({ seq: 4, runId: "run_cda2b3c0", from: "RUNNING", to: "FAILED" }),
        entry({ seq: 3, runId: "run_cda2b3c0", from: "LEASED", to: "RUNNING" }),
        entry({
          seq: 2,
          runId: "run_cda2b3c0",
          from: "PROPOSED",
          to: "LEASED",
        }),
        entry({ seq: 1, runId: "run_other", from: null, to: "QUEUED" }),
      ],
    });

    try {
      const { getByText, getByTitle } = renderOverview();

      await waitFor(() => getByTitle("run_cda2b3c0"));

      // The final state stays prominent while collapsed detail is plain-language and inspectable.
      expect(getByText("+3 steps")).toBeTruthy();
      expect(getByTitle("PROPOSED → LEASED → RUNNING → FAILED")).toBeTruthy();
      expect(document.body.textContent).not.toContain("…");
      expect(document.body.textContent).not.toContain("transitions");
      // Last state keeps its badge; the single-transition run renders plainly.
      expect(getByText("FAILED")).toBeTruthy();
      expect(getByTitle("run_other")).toBeTruthy();
      expect(getByText("QUEUED")).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });
});

describe("Overview keyboard navigation (WM-292)", () => {
  function stubOverviewApis(status: StatusView) {
    const restore = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
      requeue: api.requeue,
    };
    api.status = async () => status;
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    return () => {
      api.status = restore.status;
      api.proposals = restore.proposals;
      api.outbox = restore.outbox;
      api.journal = restore.journal;
      api.requeue = restore.requeue;
    };
  }

  test("1–5 jump to the corresponding pipeline views", async () => {
    const restore = stubOverviewApis(baseStatus());
    const onJumpEvents = mock(() => {});
    const onJumpRuns = mock((_state?: string) => {});
    const onNavigate = mock(() => {});

    try {
      renderOverview({ kind: "all" }, { onJumpEvents, onJumpRuns, onNavigate });

      for (const key of ["1", "2", "3", "4", "5"]) {
        fireEvent.keyDown(document.body, { key });
      }

      expect(onJumpEvents).toHaveBeenCalledTimes(1);
      expect(onJumpEvents).toHaveBeenCalledWith({});
      expect(onNavigate).toHaveBeenCalledWith("proposals");
      expect(onJumpRuns.mock.calls.map((call) => call[0])).toEqual([
        "QUEUED",
        "RUNNING",
        "COMPLETED",
      ]);
    } finally {
      restore();
    }
  });

  test("stage shortcuts stand down for modifiers and typing targets", () => {
    const restore = stubOverviewApis(baseStatus());
    const onJumpEvents = mock(() => {});
    const onNavigate = mock(() => {});

    try {
      const view = renderOverview(
        { kind: "all" },
        { onJumpEvents, onNavigate },
      );
      fireEvent.keyDown(document.body, { key: "1", metaKey: true });
      fireEvent.keyDown(document.body, { key: "2", ctrlKey: true });
      const input = document.createElement("input");
      view.container.append(input);
      fireEvent.keyDown(input, { key: "1" });

      expect(onJumpEvents).not.toHaveBeenCalled();
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test(". cycles anomaly focus and r requeues only a focused dead-letter event", async () => {
    const restore = stubOverviewApis(
      baseStatus({
        expiredOpenProposals: ["prop_expired"],
        deadLettered: [
          {
            source: "github",
            eventId: "evt_dead",
            lastError: "planner failed",
          },
        ],
      }),
    );
    const requeue = mock(
      (_source: string, _eventId: string) =>
        new Promise<{ requeued: boolean }>(() => {}),
    );
    api.requeue = requeue;

    try {
      const view = renderOverview();
      await waitFor(() => view.getByText(/Anomalies · 2 active issues/));

      const first = deck(view)
        .getByRole("button", { name: "1 expired open proposal" })
        .closest('[tabindex="-1"]');
      const second = deck(view)
        .getByRole("button", { name: /github.*planner failed/ })
        .closest('[tabindex="-1"]');
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();

      fireEvent.keyDown(document.body, { key: "." });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(document.body, { key: "r" });
      expect(requeue).not.toHaveBeenCalled();

      fireEvent.keyDown(document.body, { key: "." });
      expect(document.activeElement).toBe(second);
      fireEvent.keyDown(document.body, { key: "r" });
      await waitFor(() =>
        expect(requeue).toHaveBeenCalledWith("github", "evt_dead"),
      );

      fireEvent.keyDown(document.body, { key: "." });
      expect(document.activeElement).toBe(first);
    } finally {
      restore();
    }
  });
});

describe("Overview anomaly deck (WM-95, WM-979)", () => {
  test("an incomplete api stub fails closed without reaching the network", async () => {
    installFetchGuard();
    const originalProposals = api.proposals;
    api.proposals = async () => ({ proposals: [] });
    try {
      const view = renderWithClient(<UnmockedApiProbe />);
      await waitFor(() =>
        expect(view.getByText("unmocked api call: GET /status")).toBeTruthy(),
      );
    } finally {
      api.proposals = originalProposals;
      restoreApi();
    }
  });

  test("the network guard reports mutating methods and normalized api paths", async () => {
    installFetchGuard();
    await expect(
      globalThis.fetch("/api/events", { method: "POST" }),
    ).rejects.toThrow("unmocked api call: POST /events");
  });

  test("collapses expired-open proposals to one Review-expired row (WM-979)", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () =>
      baseStatus({
        expiredOpenProposals: [stubProposal.id, "prop_second"],
      });
    api.proposals = async () => ({ proposals: [stubProposal] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    const onJumpExpired = mock(() => {});

    try {
      const view = renderOverview({ kind: "all" }, { onJumpExpired });
      const row = await waitFor(() =>
        deck(view).getByRole("button", { name: "2 expired open proposals" }),
      );
      expect(view.queryByText(/agent: triage-scan/)).toBeNull();
      expect(view.queryByRole("button", { name: "Reject…" })).toBeNull();
      fireEvent.click(row);
      expect(onJumpExpired).toHaveBeenCalledTimes(1);
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

  test("does not list expired-open proposals under Needs you Runtime", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () =>
      baseStatus({
        expiredOpenProposals: [stubProposal.id],
        staleLeases: 1,
      });
    api.proposals = async () => ({ proposals: [stubProposal] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    try {
      const view = renderOverview();
      const needsYou = await waitFor(() => view.getByLabelText("Needs you"));
      expect(within(needsYou).queryByText(/expired open proposal/)).toBeNull();
      expect(
        within(needsYou).getByRole("button", { name: "View leased runs" }),
      ).toBeTruthy();
      expect(view.getByText(/Anomalies · 2 active issues/)).toBeTruthy();
      expect(
        deck(view).getByRole("button", { name: "1 expired open proposal" }),
      ).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

  test("Approval Gate expired tile jumps via onJumpExpired", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () => ({
      ...baseStatus({ expiredOpenProposals: [stubProposal.id] }),
      proposals: { open: 1, expired: 1 },
    });
    api.proposals = async () => ({ proposals: [stubProposal] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    const onJumpExpired = mock(() => {});
    const onNavigate = mock((_path: string) => {});

    try {
      const view = renderOverview(
        { kind: "all" },
        { onJumpExpired, onNavigate },
      );
      const tile = await waitFor(() =>
        view.getByRole("button", { name: "proposals · expired: 1" }),
      );
      fireEvent.click(tile);
      expect(onJumpExpired).toHaveBeenCalledTimes(1);
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

  test("Needs you is calm when expired-open proposals are the only doctor anomalies", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () =>
      baseStatus({ expiredOpenProposals: [stubProposal.id] });
    api.proposals = async () => ({ proposals: [stubProposal] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    try {
      const view = renderOverview();
      await waitFor(() =>
        expect(
          view.getByText(/Nothing needs you · last decision/),
        ).toBeTruthy(),
      );
      expect(
        deck(view).getByRole("button", { name: "1 expired open proposal" }),
      ).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

  test("collapses matching dead letters, expands short event ids, and confirms bulk actions with the count", async () => {
    const originals = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
    };
    const eventIds = [
      "chain-run_abcdef123456",
      "chain-run_bcdefa234567",
      "chain-run_cdefab345678",
    ];
    api.status = async () =>
      baseStatus({
        deadLettered: [
          ...eventIds.map((eventId) => ({
            source: "chain",
            eventId,
            lastError: "duplicate key",
          })),
          {
            source: "chain",
            eventId: "chain-run_timeout123456",
            lastError: "timeout",
          },
        ],
      });
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    const onJumpEvents = mock((_focus: EventFocus) => {});

    try {
      const view = renderOverview({ kind: "all" }, { onJumpEvents });
      const group = await waitFor(() =>
        deck(view).getByRole("button", {
          name: /3 dead-lettered.*chain.*duplicate key/,
        }),
      );

      expect(
        view.getByText(/Anomalies · 2 active issues · \(4 events\)/),
      ).toBeTruthy();
      expect(group.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(group);
      expect(group.getAttribute("aria-expanded")).toBe("true");

      const firstEvent = deck(view).getByTitle(eventIds[0]!);
      expect(firstEvent.textContent).toBe(shortId(eventIds[0]!));
      fireEvent.click(firstEvent);
      expect(onJumpEvents).toHaveBeenCalledWith({
        source: "chain",
        eventId: eventIds[0],
      });

      fireEvent.click(view.getByRole("button", { name: "Archive all" }));
      expect(view.getByText("Archive 3 dead-lettered events?")).toBeTruthy();
      expect(
        view.getByRole("button", { name: "Archive 3 events" }),
      ).toBeTruthy();
    } finally {
      api.status = originals.status;
      api.proposals = originals.proposals;
      api.outbox = originals.outbox;
      api.journal = originals.journal;
    }
  });

  test("archives dead letters and releases stalled worker leases, removing both rows (WM-326)", async () => {
    const mutableApi = api as typeof api & {
      archive: (
        source: string,
        eventId: string,
      ) => Promise<{ archived: boolean }>;
      releaseWorker: (
        workerId: string,
        runId: string,
      ) => Promise<{ released: boolean; runId: string }>;
    };
    const originals = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
      archive: mutableApi.archive,
      releaseWorker: mutableApi.releaseWorker,
    };
    let deadLettered = true;
    let stalled = true;
    api.status = async () =>
      baseStatus({
        deadLettered: deadLettered
          ? [
              {
                source: "github",
                eventId: "dead-1",
                lastError: "historical failure",
              },
            ]
          : [],
        stalledWorkers: stalled
          ? [
              {
                workerId: "worker-1",
                runId: "run-1",
                host: "lab",
                lastSeen: new Date(0).toISOString(),
              },
            ]
          : [],
      });
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    mutableApi.archive = async (source, eventId) => {
      expect({ source, eventId }).toEqual({
        source: "github",
        eventId: "dead-1",
      });
      deadLettered = false;
      return { archived: true };
    };
    mutableApi.releaseWorker = async (workerId, runId) => {
      expect({ workerId, runId }).toEqual({
        workerId: "worker-1",
        runId: "run-1",
      });
      stalled = false;
      return { released: true, runId };
    };

    try {
      const view = renderOverview();
      await waitFor(() => view.getByRole("button", { name: "Archive" }));

      expect(
        deck(view).getByRole("button", { name: /github.*historical failure/ }),
      ).toBeTruthy();
      view.getByRole("button", { name: "Archive" }).click();
      await waitFor(() =>
        expect(
          deck(view).queryByRole("button", {
            name: /github.*historical failure/,
          }),
        ).toBeNull(),
      );

      const releaseLease = await waitFor(() =>
        view.getByRole("button", { name: "Release lease" }),
      );
      releaseLease.click();
      // Both anomalies are gone, so the deck unmounts entirely.
      await waitFor(() =>
        expect(view.queryByLabelText("Anomalies")).toBeNull(),
      );
      expect(view.queryByText(/stalled worker worker-1/)).toBeNull();
    } finally {
      api.status = originals.status;
      api.proposals = originals.proposals;
      api.outbox = originals.outbox;
      api.journal = originals.journal;
      mutableApi.archive = originals.archive;
      mutableApi.releaseWorker = originals.releaseWorker;
    }
    // Two 2s status polls plus the waitFor budgets put this right at bun's
    // default 5s — it passed on develop by ~100ms. Give it its real budget.
  }, 30_000);

  test("other anomaly kinds (stale leases, unpublished outbox) render unchanged", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () =>
      baseStatus({ staleLeases: 3, unpublishedOutbox: 2 });
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    try {
      const view = renderOverview();

      await waitFor(() => deck(view).getByText(/stale leases: 3/));
      expect(deck(view).getByText(/unpublished outbox rows: 2/)).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });
});

describe("Overview needs you (WM-596)", () => {
  const originalInbox = api.inbox;

  function inboxItem(
    id: string,
    kind: string,
    createdAt: string,
    title?: string,
  ): InboxItem {
    return {
      id,
      kind,
      severity: "normal",
      title: title ?? `Attention ${id}`,
      body: null,
      refs: {},
      source: "test",
      createdAt,
      ackedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      delivery: {},
    };
  }

  function stubNeedsYou(
    items: InboxItem[] | (() => Promise<{ items: InboxItem[] }>),
    status = baseStatus(),
  ) {
    const restore = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
    };
    const list = Array.isArray(items) ? items : [];
    api.status = async () => ({
      ...status,
      inbox: { open: list.length, acked: 0, byKind: {} },
    });
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    api.inbox = Array.isArray(items) ? async () => ({ items }) : items;
    return () => {
      api.status = restore.status;
      api.proposals = restore.proposals;
      api.outbox = restore.outbox;
      api.journal = restore.journal;
      api.inbox = originalInbox;
    };
  }

  test("leads with capped newest-first inbox groups and opens the selected row", async () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      inboxItem(
        `blocked-${index}`,
        "BLOCKED",
        `2026-08-17T0${index}:00:00.000Z`,
      ),
    );
    const restore = stubNeedsYou(items);
    const onNavigate = mock((_path: string) => {});

    try {
      const view = renderOverview({ kind: "all" }, { onNavigate });
      await waitFor(() =>
        expect(view.getByRole("heading", { name: "Needs you" })).toBeTruthy(),
      );
      expect(
        view
          .getAllByRole("heading")
          .map((heading) => heading.textContent)
          .slice(0, 2),
      ).toEqual(["Overview", "Needs you"]);
      expect(view.getAllByTitle(/Attention blocked-/)).toHaveLength(5);
      expect(
        view
          .getAllByTitle(/Attention blocked-/)
          .map((row) => row.getAttribute("title")),
      ).toEqual([
        "Attention blocked-5",
        "Attention blocked-4",
        "Attention blocked-3",
        "Attention blocked-2",
        "Attention blocked-1",
      ]);
      expect(view.queryByTitle("Attention blocked-0")).toBeNull();

      fireEvent.click(view.getByRole("button", { name: "1 more →" }));
      expect(onNavigate).toHaveBeenCalledWith("inbox");

      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(onNavigate).toHaveBeenCalledWith("inbox/blocked-5");
    } finally {
      restore();
    }
  });

  test("requests open inbox rows rather than a mixed-status ledger page", async () => {
    const calls: string[] = [];
    const restore = stubNeedsYou([]);
    api.inbox = async (status) => {
      calls.push(status ?? "open");
      return {
        items:
          status === "open"
            ? [inboxItem("open-only", "BLOCKED", "2026-08-17T00:00:00.000Z")]
            : [],
      };
    };

    try {
      const view = renderOverview();
      await waitFor(() => view.getByTitle("Attention open-only"));
      expect(calls).toEqual(["open"]);
    } finally {
      restore();
    }
  });

  test("bulk requeue keeps peer proposal polls alive when the first match navigates away", async () => {
    const originals = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
      requeue: api.requeue,
    };
    const eventIds = ["evt_concurrent_first", "evt_concurrent_second"];
    api.status = async () =>
      baseStatus({
        deadLettered: eventIds.map((eventId) => ({
          source: "github",
          eventId,
          lastError: "planner unavailable",
        })),
      });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    let requeued = 0;
    api.requeue = mock(async () => {
      requeued += 1;
      return { requeued: true };
    });
    const pollRequests: ReturnType<
      typeof deferred<Awaited<ReturnType<typeof api.proposals>>>
    >[] = [];
    api.proposals = mock(() => {
      if (requeued < eventIds.length) return Promise.resolve({ proposals: [] });
      const request = deferred<Awaited<ReturnType<typeof api.proposals>>>();
      pollRequests.push(request);
      return request.promise;
    });

    try {
      const onJumpProposal = mock((proposalId: string) => {
        if (proposalId === "prop_concurrent_first") view.unmount();
      });
      const view = renderOverview({ kind: "all" }, { onJumpProposal });

      fireEvent.click(
        await waitFor(() => view.getByRole("button", { name: "Requeue all" })),
      );
      fireEvent.click(view.getByRole("button", { name: "Requeue 2 events" }));
      await waitFor(() => expect(api.requeue).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(pollRequests).toHaveLength(2));

      await act(async () => {
        pollRequests[0]!.resolve({
          proposals: [
            {
              ...stubProposal,
              id: "prop_concurrent_first",
              eventId: eventIds[0]!,
              eventSource: "github",
            },
          ],
        });
      });
      await waitFor(() =>
        expect(onJumpProposal).toHaveBeenCalledWith("prop_concurrent_first"),
      );

      await act(async () => {
        pollRequests[1]!.resolve({
          proposals: [
            {
              ...stubProposal,
              id: "prop_concurrent_second",
              eventId: eventIds[1]!,
              eventSource: "github",
            },
          ],
        });
      });
      await waitFor(() =>
        expect(
          onJumpProposal.mock.calls.map(([proposalId]) => proposalId),
        ).toEqual(["prop_concurrent_first", "prop_concurrent_second"]),
      );
    } finally {
      api.status = originals.status;
      api.proposals = originals.proposals;
      api.outbox = originals.outbox;
      api.journal = originals.journal;
      api.requeue = originals.requeue;
    }
  });

  test("rows read the display title and keep the raw title as the tooltip", async () => {
    const restore = stubNeedsYou([
      inboxItem(
        "blocked-1",
        "BLOCKED",
        "2026-08-17T00:00:00.000Z",
        "BLOCKED needs a decision",
      ),
    ]);

    try {
      const view = renderOverview();
      const row = await waitFor(() =>
        view.getByTitle("BLOCKED needs a decision"),
      );
      expect(row.textContent).toBe("needs a decision");
    } finally {
      restore();
    }
  });

  test("renders Runtime anomalies in the shared compact grammar", async () => {
    const onJumpRuns = mock((_state?: string) => {});
    const restore = stubNeedsYou([], baseStatus({ staleLeases: 1 }));

    try {
      const view = renderOverview({ kind: "all" }, { onJumpRuns });
      const needsYou = await waitFor(() => view.getByLabelText("Needs you"));
      within(needsYou).getByRole("heading", { name: "Runtime" });
      fireEvent.click(
        within(needsYou).getByRole("button", { name: "View leased runs" }),
      );
      expect(onJumpRuns).toHaveBeenCalledWith("LEASED");
    } finally {
      restore();
    }
  });

  test("keeps the ack verb visible but inert while an ack is in flight", async () => {
    const origAck = api.ackInbox;
    const restore = stubNeedsYou([
      inboxItem("blocked-1", "BLOCKED", "2026-08-17T00:00:00.000Z"),
    ]);
    api.ackInbox = () => new Promise(() => {});

    try {
      const view = renderOverview();
      const needsYou = await waitFor(() => view.getByLabelText("Needs you"));
      const ack = within(needsYou).getByRole("button", {
        name: "ack",
      }) as HTMLButtonElement;
      expect(ack.disabled).toBe(false);
      fireEvent.click(ack);
      await waitFor(() =>
        expect(
          (
            within(needsYou).getByRole("button", {
              name: "ack",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true),
      );
      expect(
        within(needsYou).getByRole("button", { name: "Open" }),
      ).toBeTruthy();
    } finally {
      api.ackInbox = origAck;
      restore();
    }
  });

  test("waits for the ledger before claiming nothing needs you", async () => {
    const restore = stubNeedsYou(() => new Promise(() => {}));

    try {
      const view = renderOverview();
      const needsYou = await waitFor(() => view.getByLabelText("Needs you"));
      expect(
        within(needsYou).getByText(/Checking what needs you/),
      ).toBeTruthy();
      expect(view.queryByText(/Nothing needs you · last decision/)).toBeNull();
    } finally {
      restore();
    }
  });

  test("uses the unfenced calm line when the ledger and runtime are clear", async () => {
    const restore = stubNeedsYou([]);

    try {
      const view = renderOverview();
      await waitFor(() =>
        expect(
          view.getByText(/Nothing needs you · last decision/),
        ).toBeTruthy(),
      );
      const needsYou = view.getByLabelText("Needs you");
      expect(needsYou.querySelector("table")).toBeNull();
      expect(needsYou.querySelector(".border")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("scopedCount / scopedTally (WM-147)", () => {
  const repo = { kind: "repo" as const, name: "bj29" };
  const rows = [
    { repos: ["bj29"], state: "LEASED" },
    { repos: ["ok"], state: "LEASED" },
    { repos: ["bj29"], state: "QUEUED" },
    { repos: [], state: "RUNNING" },
  ];

  test("repo tab counts named-repo rows only; unscoped rows stay out", () => {
    expect(scopedCount(rows, repo, { repos: (r) => r.repos })).toBe(2);
    expect(scopedCount(rows, { kind: "all" }, { repos: (r) => r.repos })).toBe(
      4,
    );
    expect(
      scopedTally(rows, repo, { repos: (r) => r.repos, key: (r) => r.state }),
    ).toEqual({
      LEASED: 1,
      QUEUED: 1,
    });
  });

  test("in flight keeps LEASED/RUNNING and drops QUEUED even when repos match", () => {
    expect(
      scopedTally(
        rows,
        { kind: "inflight" },
        {
          repos: (r) => r.repos,
          state: (r) => r.state,
          key: (r) => r.state,
        },
      ),
    ).toEqual({ LEASED: 2, RUNNING: 1 });
    expect(
      scopedCount(
        rows,
        { kind: "inflight" },
        { repos: (r) => r.repos, state: (r) => r.state },
      ),
    ).toBe(3);
  });
});

describe("Overview scoped tiles and factory-wide labels (WM-147)", () => {
  function stubApis(opts: {
    status: StatusView;
    events?: AdmittedEvent[];
    runs?: RunListItem[];
    proposals?: Proposal[];
  }) {
    const restore = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
      events: api.events,
      runs: api.runs,
    };
    api.status = async () => opts.status;
    api.proposals = async () => ({ proposals: opts.proposals ?? [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    api.events = async () => ({ events: opts.events ?? [] });
    api.runs = async () => ({ runs: opts.runs ?? [] });
    return () => {
      api.status = restore.status;
      api.proposals = restore.proposals;
      api.outbox = restore.outbox;
      api.journal = restore.journal;
      api.events = restore.events;
      api.runs = restore.runs;
    };
  }

  test("repo tab: event tiles show scoped counts, not factory-wide GET /status totals", async () => {
    const restore = stubApis({
      status: {
        ...baseStatus(),
        events: { human_needed: 4, dead_lettered: 2 },
        proposals: { open: 5, expired: 2 },
        workers: { live: 3, busy: 1, stale: 0 },
      },
      events: [
        stubEvent({ eventId: "e1", status: "human_needed", repos: ["bj29"] }),
        stubEvent({ eventId: "e2", status: "human_needed", repos: ["ok"] }),
        stubEvent({ eventId: "e3", status: "human_needed", repos: [] }),
        stubEvent({ eventId: "e4", status: "dead_lettered", repos: ["ok"] }),
      ],
      proposals: [
        { ...stubProposal, id: "p1", repos: ["bj29"], expired: false },
        { ...stubProposal, id: "p2", repos: ["ok"], expired: false },
        { ...stubProposal, id: "p3", repos: ["bj29"], expired: true },
      ],
    });

    try {
      const { getByRole, queryByRole } = renderOverview({
        kind: "repo",
        name: "bj29",
      });

      await waitFor(() =>
        getByRole("button", { name: "events · human_needed: 1" }),
      );

      // Negative: factory-wide totals must not appear as the clickable count.
      expect(
        queryByRole("button", { name: "events · human_needed: 4" }),
      ).toBeNull();
      expect(
        queryByRole("button", { name: "events · dead_lettered: 2" }),
      ).toBeNull();
      expect(
        getByRole("button", { name: "events · dead_lettered: 0" }),
      ).toBeTruthy();
      expect(getByRole("button", { name: "proposals · open: 2" })).toBeTruthy();
      expect(queryByRole("button", { name: "proposals · open: 5" })).toBeNull();
      expect(
        getByRole("button", { name: "proposals · expired: 1" }),
      ).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("repo tab: worker tiles keep factory-wide counts but are marked before click", async () => {
    const restore = stubApis({
      status: {
        ...baseStatus(),
        events: { admitted: 1 },
        workers: { live: 3, busy: 1, stale: 2 },
      },
      events: [
        stubEvent({ eventId: "e1", status: "admitted", repos: ["bj29"] }),
      ],
    });

    try {
      const { getByRole, queryByRole } = renderOverview({
        kind: "repo",
        name: "bj29",
      });

      await waitFor(() => getByRole("button", { name: /workers · live/ }));

      expect(
        getByRole("button", { name: "workers · live · factory-wide: 3" }),
      ).toBeTruthy();
      expect(
        getByRole("button", { name: "workers · busy · factory-wide: 1" }),
      ).toBeTruthy();
      expect(
        getByRole("button", { name: "workers · stale · factory-wide: 2" }),
      ).toBeTruthy();
      expect(queryByRole("button", { name: "workers · live: 3" })).toBeNull();
    } finally {
      restore();
    }
  });

  test("repo tab: Activity and Outbox state they are factory-wide; All does not", async () => {
    const restore = stubApis({
      status: { ...baseStatus(), events: { admitted: 0 } },
    });

    try {
      const repo = renderOverview({ kind: "repo", name: "bj29" });
      const repoActivity = await waitFor(() =>
        repo.getByText("Activity").closest("button"),
      );
      const repoOutbox = repo.getByText("Outbox").closest("button");
      expect(repoActivity?.textContent?.toLowerCase()).toMatch(
        /latest 0.*factory-wide/,
      );
      expect(repoOutbox?.textContent?.toLowerCase()).toMatch(
        /published results.*factory-wide/,
      );
      expect(repo.container.textContent).not.toMatch(
        /\/journal|\/outbox|GET \//,
      );
      repo.unmount();

      const all = renderOverview({ kind: "all" });
      const allActivity = await waitFor(() =>
        all.getByText("Activity").closest("button"),
      );
      const allOutbox = all.getByText("Outbox").closest("button");
      expect(allActivity?.textContent?.toLowerCase()).not.toMatch(
        /factory-wide/,
      );
      expect(allOutbox?.textContent?.toLowerCase()).not.toMatch(/factory-wide/);
      expect(all.queryByRole("status")).toBeNull();
    } finally {
      restore();
    }
  });

  test("in-flight: run-state tiles match Runs list filtering (LEASED/RUNNING only)", async () => {
    const restore = stubApis({
      status: {
        ...baseStatus(),
        runs: {
          byState: {
            QUEUED: 5,
            LEASED: 2,
            RUNNING: 3,
            COMPLETED: 9,
          },
        },
      },
      runs: [
        stubRun({ runId: "r1", state: "QUEUED", repos: ["bj29"] }),
        stubRun({ runId: "r2", state: "LEASED", repos: ["ok"] }),
        stubRun({ runId: "r3", state: "LEASED", repos: [] }),
        stubRun({ runId: "r4", state: "RUNNING", repos: ["bj29"] }),
        stubRun({ runId: "r5", state: "COMPLETED", repos: ["bj29"] }),
      ],
    });

    try {
      const { getByRole, queryByRole, getAllByText } = renderOverview({
        kind: "inflight",
      });

      await waitFor(() => getByRole("button", { name: "active · leased: 2" }));

      // Negative: factory-wide queued/completed totals must not appear.
      expect(queryByRole("button", { name: "active · queued: 5" })).toBeNull();
      expect(getByRole("button", { name: "active · queued: 0" })).toBeTruthy();
      expect(getByRole("button", { name: "active · leased: 2" })).toBeTruthy();
      expect(getByRole("button", { name: "active · running: 1" })).toBeTruthy();
      expect(queryByRole("button", { name: "runs · completed: 9" })).toBeNull();
      expect(getAllByText(/no terminal runs/).length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test("repo tab: anomaly deck heading is marked factory-wide; All is not", async () => {
    const restore = stubApis({
      status: baseStatus({ staleLeases: 1 }),
    });

    try {
      const repo = renderOverview({ kind: "repo", name: "bj29" });
      await waitFor(() => repo.getByText(/Anomalies ·/));
      expect(repo.getByText(/Anomalies ·/).textContent?.toLowerCase()).toMatch(
        /factory-wide/,
      );
      repo.unmount();

      const all = renderOverview({ kind: "all" });
      await waitFor(() => all.getByText(/Anomalies ·/));
      expect(
        all.getByText(/Anomalies ·/).textContent?.toLowerCase(),
      ).not.toMatch(/factory-wide/);
    } finally {
      restore();
    }
  });

  test("scope notice is glanceable when context ≠ All", async () => {
    const restore = stubApis({
      status: { ...baseStatus(), events: { admitted: 0 } },
    });

    try {
      const repo = renderOverview({ kind: "repo", name: "bj29" });
      await waitFor(() => repo.getByRole("status"));
      const notice = repo.getByRole("status");
      expect(notice.textContent).toMatch(/bj29/);
      expect(notice.className).not.toMatch(/text-\[11px\]/);
      repo.unmount();

      const inflight = renderOverview({ kind: "inflight" });
      await waitFor(() => inflight.getByRole("status"));
      expect(inflight.getByRole("status").textContent).toMatch(/in flight/i);
    } finally {
      restore();
    }
  });

  test("stage cards and legend rows use responsive fluid layouts", async () => {
    const restore = stubApis({
      status: {
        ...baseStatus(),
        events: { admitted: 1 },
        runs: { byState: { QUEUED: 1 } },
      },
    });

    try {
      const { getByText } = renderOverview();
      await waitFor(() => getByText(/Intake & Approval Gate/));

      const stage1 = getByText(/Intake & Approval Gate/).closest("section");
      expect(stage1?.className).toMatch(/\brounded-lg\b/);

      const stage2 = getByText(/Execution & Fleet Capacity/).closest("section");
      expect(stage2?.className).toMatch(/\brounded-lg\b/);
    } finally {
      restore();
    }
  });
});

describe("buildAnomalyRows (WM-205)", () => {
  const callbacks = {
    onJumpProposal: noop,
    onJumpRuns: noop,
    onJumpEvents: noop,
    onJumpRun: noop,
    onNavigate: noop,
  };

  test("correctly categorizes and maps all anomaly kinds", () => {
    const proposalsMap = new Map([["prop_1", stubProposal]]);
    const anomalies: StatusView["anomalies"] = {
      expiredOpenProposals: ["prop_1"],
      staleLeases: 2,
      unpublishedOutbox: 1,
      deadLettered: [
        { source: "github", eventId: "e99", lastError: "timeout" },
      ],
      stalledWorkers: [
        {
          workerId: "w1",
          runId: "r1",
          host: "srv1",
          lastSeen: new Date().toISOString(),
        },
      ],
      ambiguousOpenProposals: [{ runId: "r2", count: 3 }],
      noWorkers: true,
    };
    const s: StatusView = {
      ...baseStatus(),
      runs: { byState: { QUEUED: 4 } },
    };

    const rows = buildAnomalyRows(anomalies, proposalsMap, callbacks, s);
    expect(rows.length).toBe(7);
    expect(rows.map((r) => r.kind)).toEqual([
      "proposal",
      "lease",
      "outbox",
      "dead_letter",
      "worker",
      "ambiguous",
      "capacity",
    ]);
    expect(rows[0]!.text).toBe("1 expired open proposal");
    expect(rows[0]!.surfaceInNeedsYou).toBe(false);
    expect(rows[0]!.proposalId).toBeUndefined();
    expect(rows[0]!.links[0]!.label).toBe("Review expired");
    expect(rows[1]!.text).toMatch(/stale leases: 2/);
    expect(rows[2]!.text).toMatch(/unpublished outbox rows: 1/);
    expect(rows[3]!.requeue).toEqual({ source: "github", eventId: "e99" });
    expect(rows[3]!.archive).toEqual({ source: "github", eventId: "e99" });
    expect(rows[4]!.text).toMatch(/stalled worker w1 still holds run r1/);
    expect(rows[4]!.releaseWorker).toEqual({ workerId: "w1", runId: "r1" });
    expect(rows[5]!.text).toMatch(/ambiguous open proposals: 3/);
    expect(rows[6]!.text).toMatch(/4 queued runs and no live worker/);
  });

  test("collapses many expired-open ids to one Review-expired row (WM-979)", () => {
    const onJumpExpired = mock(() => {});
    const rows = buildAnomalyRows(
      {
        ...baseStatus().anomalies,
        expiredOpenProposals: ["prop_a", "prop_b", "prop_c"],
      },
      new Map(),
      { ...callbacks, onJumpExpired },
    );
    const expired = rows.filter((row) => row.kind === "proposal");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.text).toBe("3 expired open proposals");
    expect(expired[0]!.surfaceInNeedsYou).toBe(false);
    expired[0]!.links[0]!.go();
    expect(onJumpExpired).toHaveBeenCalledTimes(1);
  });

  test("maps stopped and late schedules, piling proposals, and configuration warnings", () => {
    const onNavigate = mock((_path: string) => {});
    const anomalies: StatusView["anomalies"] = {
      ...baseStatus().anomalies,
      stoppedSchedules: [
        {
          loop: "nightly",
          every: "1h",
          lastSlot: "2026-08-16T08:00:00.000Z",
          intervalsLate: 3,
          error: null,
        },
        {
          loop: "reaper",
          every: "5m",
          lastSlot: "2026-08-16T10:00:00.000Z",
          intervalsLate: 0,
          error: "tick failed",
        },
      ],
      proposalsPilingUp: [{ loop: "reconcile-bj29", count: 4, threshold: 3 }],
      configuration: ["policyVersion is unknown"],
    };

    const rows = buildAnomalyRows(anomalies, new Map(), {
      ...callbacks,
      onNavigate,
    });

    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ["schedule", "stopped schedule nightly: 3 intervals late"],
      ["schedule", "stopped schedule reaper: error: tick failed"],
      [
        "proposal",
        "proposals piling up for schedule reconcile-bj29: 4 open proposals (threshold 3)",
      ],
      ["configuration", "policyVersion is unknown"],
    ]);

    rows[0]!.links[0]!.go();
    rows[2]!.links[0]!.go();
    expect(rows[0]!.links[0]!.label).toBe("View schedules");
    expect(rows[2]!.links[0]!.label).toBe("View proposals");
    expect(onNavigate.mock.calls.map((call) => call[0])).toEqual([
      "schedules",
      "proposals",
    ]);
  });

  test("returns empty array for undefined anomalies", () => {
    expect(buildAnomalyRows(undefined, new Map(), callbacks)).toEqual([]);
  });
});

describe("Overview 4-Band layout & telemetry (WM-205)", () => {
  test("renders empty stage fallbacks for a partial cold status response (WM-266)", async () => {
    await withApi({ status: async () => ({}) as StatusView }, async () => {
      const r = renderOverview();

      await waitFor(() => {
        expect(r.getByText("Worker Fleet Capacity")).toBeTruthy();
      });
      expect(r.getByText("no events yet")).toBeTruthy();
      expect(r.getByText("nothing in flight")).toBeTruthy();
      expect(r.getAllByText("no terminal runs").length).toBeGreaterThan(0);
      expect(r.container.textContent).toContain("0 files");
    });
  });

  test("renders a calm Needs-you line when no anomalies are present", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () => baseStatus();
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    try {
      const { getByText, queryByText, queryByLabelText } = renderOverview();
      await waitFor(() => getByText(/Nothing needs you · last decision/));
      expect(queryByText(/Doctor: All systems nominal/)).toBeNull();
      expect(queryByLabelText("Anomalies")).toBeNull();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

  test("renders Fleet Capacity meter and Recent Outcomes strip", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () => ({
      ...baseStatus(),
      runs: { byState: { QUEUED: 2 } },
      workers: { live: 3, busy: 1, stale: 0 },
      capacity: {
        running: 1,
        capacity: 4,
        queued: 2,
        live: 3,
        idle: 2,
        draining: 0,
        target: 3,
        min: 1,
        max: 4,
        supervisor: "active",
        source: "worker-policy",
        limitingFactor: "per-repo max_in_flight reached",
        classes: [{ name: "light", running: 1, capacity: 3 }],
      },
    });
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({
      outbox: [
        {
          seq: 1,
          created_at: new Date().toISOString(),
          published_at: new Date().toISOString(),
          event: {
            type: "factory.run.finished",
            source: "factory",
            eventId: "evt-out-1",
            payload: { outcome: "PR_OPEN #42" },
          },
        },
      ],
    });
    api.journal = async () => ({
      head: 3,
      entries: [
        entry({
          seq: 3,
          runId: "run_term_1",
          from: "RUNNING",
          to: "COMPLETED",
        }),
        entry({ seq: 2, runId: "run_term_2", from: "RUNNING", to: "FAILED" }),
        entry({ seq: 1, runId: "run_term_3", from: "LEASED", to: "RUNNING" }),
      ],
    });

    try {
      const onJumpRun = mock((_runId: string) => {});
      const { getByText, getByTitle, getByRole } = renderOverview(
        { kind: "all" },
        { onJumpRun },
      );

      await waitFor(() => getByText(/Worker Fleet Capacity/));
      expect(getByText(/3 live · 1 busy · 2 idle/)).toBeTruthy();
      expect(
        getByRole("button", {
          name: "worker capacity: 1 running of 4, 2 queued",
        }),
      ).toBeTruthy();
      expect(getByText("per-repo max_in_flight reached")).toBeTruthy();
      expect(getByText("light 1/3")).toBeTruthy();

      // Recent outcomes strip exposes exact titles, a legend, and run navigation.
      expect(getByText("Recent outcomes")).toBeTruthy();
      expect(getByText("last 2")).toBeTruthy();
      const completedTick = getByTitle(/^run_term_1 · COMPLETED · /);
      expect(completedTick.getAttribute("title")).toMatch(
        /^run_term_1 · COMPLETED · .+ ago$/,
      );
      expect(getByTitle(/^run_term_2 · FAILED · /)).toBeTruthy();
      expect(
        getByRole("generic", { name: "1 completed, 1 failed" }),
      ).toBeTruthy();
      fireEvent.click(completedTick);
      expect(onJumpRun).toHaveBeenCalledWith("run_term_1");

      // Outbox summary preview
      expect(getByText("[PR_OPEN #42]")).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });
});

describe("Overview waiting-on-you tile (WM-286)", () => {
  function withStatus(status: StatusView) {
    const orig = {
      status: api.status,
      proposals: api.proposals,
      outbox: api.outbox,
      journal: api.journal,
    };
    api.status = async () => status;
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });
    return () => {
      api.status = orig.status;
      api.proposals = orig.proposals;
      api.outbox = orig.outbox;
      api.journal = orig.journal;
    };
  }

  test("shows the open count with a by-kind caption and jumps to #/inbox", async () => {
    const restore = withStatus({
      ...baseStatus(),
      inbox: { open: 3, acked: 0, byKind: { BLOCKED: 2, "CI RED": 1 } },
    });
    const onNavigate = mock(() => {});
    try {
      const view = renderOverview({ kind: "all" }, { onNavigate });
      const tile = await waitFor(() =>
        view.getByRole("button", {
          name: /Waiting on you: 3 open inbox items/,
        }),
      );
      expect(tile.textContent).toContain("2 BLOCKED · 1 CI RED");
      expect(view.getByText("3 open")).toBeTruthy();
      fireEvent.click(tile);
      expect(onNavigate).toHaveBeenCalledWith("inbox");
    } finally {
      restore();
    }
  });

  test("says when the by-kind breakdown spans acked items too, and reads calm at zero", async () => {
    const restore = withStatus({
      ...baseStatus(),
      inbox: { open: 1, acked: 1, byKind: { BLOCKED: 2 } },
    });
    try {
      const view = renderOverview();
      const tile = await waitFor(() =>
        view.getByRole("button", { name: /Waiting on you: 1 open inbox item/ }),
      );
      expect(tile.textContent).toContain("open + acked · 2 BLOCKED");
      expect(view.getByText("1 open · 1 acked")).toBeTruthy();
    } finally {
      restore();
    }
    cleanup();
    const restoreZero = withStatus({
      ...baseStatus(),
      inbox: { open: 0, acked: 0, byKind: {} },
    });
    try {
      const view = renderOverview();
      await waitFor(() =>
        view.getByText("Nothing needs a decision right now."),
      );
      expect(view.getByText("nothing waiting")).toBeTruthy();
    } finally {
      restoreZero();
    }
  });

  test("renders no tile against a pre-inbox control API", async () => {
    const restore = withStatus(baseStatus());
    try {
      const view = renderOverview();
      await waitFor(() => view.getByText("Approval Gate"));
      expect(view.queryByText("Waiting on you")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Overview declarative panels (WM-840)", () => {
  const inboxPanel = {
    name: "inbox-open",
    title: "Open inbox items",
    description: null,
    source: { endpoint: "/inbox", query: { status: "open" }, path: "/items" },
    refreshSeconds: 30,
    view: {
      sections: [
        { path: "", as: "table" as const, columns: ["kind", "title"] },
      ],
    },
    origin: "builtin",
    file: "panels/inbox-open.panel.json",
  };

  test("shows the panel grid below the existing content when at least one panel exists", async () => {
    await withApi(
      {
        status: async () => baseStatus(),
        panels: async () => ({ panels: [inboxPanel], endpoints: ["/inbox"] }),
        panelSource: async () => ({
          items: [{ id: "i1", kind: "BLOCKED", title: "WM-7 waits on you" }],
        }),
      },
      async () => {
        const r = renderOverview();
        const grid = await r.findByLabelText("Panels");
        await waitFor(() =>
          expect(within(grid).getByText("WM-7 waits on you")).toBeTruthy(),
        );
        // Below the content Overview already draws (the housekeeping band is its last).
        const housekeeping = r.getByText("Worker Fleet Capacity");
        expect(
          Boolean(
            housekeeping.compareDocumentPosition(grid) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ).toBe(true);
        expect(within(grid).getByText("Open inbox items")).toBeTruthy();
      },
    );
  });

  test("renders no panel section at all when there are zero panels", async () => {
    await withApi(
      {
        status: async () => baseStatus(),
        panels: async () => ({ panels: [], endpoints: ["/inbox"] }),
      },
      async () => {
        const r = renderOverview();
        await waitFor(() => expect(api.panels).toHaveBeenCalled());
        await r.findByText("Worker Fleet Capacity");
        expect(r.queryByLabelText("Panels")).toBeNull();
        expect(r.container.textContent).not.toContain("1 panel");
      },
    );
  });
});

describe("Overview hook metrics (WM-864)", () => {
  test("renders /status.hooks.decisions24h allow/deny counts per hook", async () => {
    await withApi(
      {
        status: async () => ({
          ...baseStatus(),
          hooks: {
            decisions24h: {
              "factory:escalation-labels": {
                source: "builtin",
                point: "approve.before",
                allow: 3,
                deny: 1,
              },
              "acme/x:gate": {
                source: "extension:acme/x",
                point: "approve.before",
                allow: 0,
                deny: 2,
              },
            },
          },
        }),
      },
      async () => {
        const r = renderOverview();
        const list = await waitFor(() =>
          r.getByLabelText("Hook decisions · 24h"),
        );
        expect(
          within(list).getByText("factory:escalation-labels"),
        ).toBeTruthy();
        expect(within(list).getByText("acme/x:gate")).toBeTruthy();
        expect(within(list).getByText("3 allow")).toBeTruthy();
        expect(within(list).getByText("1 deny")).toBeTruthy();
        expect(within(list).getByText("0 allow")).toBeTruthy();
        expect(within(list).getByText("2 deny")).toBeTruthy();
        expect(r.getByText("Hook decisions · 24h")).toBeTruthy();
      },
    );
  });

  test("does not render hook metrics against a pre-hooks control API", async () => {
    await withApi(
      {
        status: async () => baseStatus(),
      },
      async () => {
        const r = renderOverview();
        await waitFor(() => r.getByText("Approval Gate"));
        expect(r.queryByText(/Hook decisions/i)).toBeNull();
      },
    );
  });
});

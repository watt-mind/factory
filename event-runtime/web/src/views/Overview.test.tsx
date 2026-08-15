import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Overview, groupJournalEntries, buildAnomalyRows } from "./Overview";
import { shortId } from "../components/ui";
import { api } from "../api";
import type { OperatorContext } from "../context";
import { scopedCount, scopedTally } from "../context";
import { changeInput } from "../test-render";
import type { AdmittedEvent, JournalEntry, Proposal, RunListItem, StatusView } from "../types";

afterEach(() => {
  cleanup();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const noop = () => {};

function baseStatus(overrides: Partial<StatusView["anomalies"]> = {}): StatusView {
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

function stubEvent(overrides: Partial<AdmittedEvent> & Pick<AdmittedEvent, "eventId" | "status" | "repos">): AdmittedEvent {
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

function stubRun(overrides: Partial<RunListItem> & Pick<RunListItem, "runId" | "state" | "repos">): RunListItem {
  const now = new Date().toISOString();
  return {
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
    "onJumpRun" | "onJumpProposal" | "onJumpEvents" | "onJumpRuns" | "onNavigate"
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
      onJumpExpired={noop}
      onJumpGraph={noop}
      onInject={noop}
    />,
  );
}

/** Build a journal entry; the feed keeps entries newest-first, so tests pass them that way. */
function entry(overrides: Partial<JournalEntry> & Pick<JournalEntry, "seq" | "runId" | "to">): JournalEntry {
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
      entry({ seq: 1, runId: "run_a", from: "QUEUED", to: "CANCELLED", reason: "operator" }),
    ];
    const groups = groupJournalEntries(entries);
    expect(groups.length).toBe(3);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
    expect(groups.map((g) => g.seq)).toEqual([3, 2, 1]);
    expect(groups[2]!.reason).toBe("operator");
  });

  test("empty input produces no rows", () => {
    expect(groupJournalEntries([])).toEqual([]);
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
        entry({ seq: 2, runId: "run_cda2b3c0", from: "PROPOSED", to: "LEASED" }),
        entry({ seq: 1, runId: "run_other", from: null, to: "QUEUED" }),
      ],
    });

    try {
      const { getByText, getByTitle } = renderOverview();

      await waitFor(() => getByTitle("run_cda2b3c0"));

      // One row spanning the whole run: first state, ellipsis, transition count.
      expect(getByText(/PROPOSED → … →/)).toBeTruthy();
      expect(getByText(/· 3 transitions/)).toBeTruthy();
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
      const view = renderOverview({ kind: "all" }, { onJumpEvents, onNavigate });
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
          { source: "github", eventId: "evt_dead", lastError: "planner failed" },
        ],
      }),
    );
    const requeue = mock(
      (_source: string, _eventId: string) => new Promise<{ requeued: boolean }>(() => {}),
    );
    api.requeue = requeue;

    try {
      const view = renderOverview();
      await waitFor(() => view.getByText(/Anomalies · 2 active issues/));

      const first = view.getByText("expired open proposal").closest('[tabindex="-1"]');
      const second = view.getByText(/dead-lettered \(github, evt_dead\)/).closest('[tabindex="-1"]');
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();

      fireEvent.keyDown(document.body, { key: "." });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(document.body, { key: "r" });
      expect(requeue).not.toHaveBeenCalled();

      fireEvent.keyDown(document.body, { key: "." });
      expect(document.activeElement).toBe(second);
      fireEvent.keyDown(document.body, { key: "r" });
      await waitFor(() => expect(requeue).toHaveBeenCalledWith("github", "evt_dead"));

      fireEvent.keyDown(document.body, { key: "." });
      expect(document.activeElement).toBe(first);
    } finally {
      restore();
    }
  });
});

describe("Overview anomaly deck (WM-95)", () => {
  test("enriches an expired-proposal row with agent, decision/reason, origin, and age; demotes the raw id", async () => {
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
      const { getByText, queryByTitle } = renderOverview();

      await waitFor(() => getByText(/agent: triage-scan/));

      expect(getByText(/agent: triage-scan/)).toBeTruthy();
      expect(getByText(/human_needed/)).toBeTruthy();
      expect(getByText(/ambiguous repo pin/)).toBeTruthy();
      expect(getByText(/origin github\/evt-789/)).toBeTruthy();

      // Raw id is demoted to secondary, copyable text rather than the primary label.
      const idNode = queryByTitle(`${stubProposal.id} — click to copy`);
      expect(idNode).toBeTruthy();
      expect(idNode?.textContent).toBe(shortId(stubProposal.id));
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

  test("rejects an expired proposal only after collecting a non-empty reason", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    const origReject = api.reject;
    api.status = async () =>
      baseStatus({ expiredOpenProposals: [stubProposal.id] });
    api.proposals = async () => ({ proposals: [stubProposal] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    const rejectedCalls: { id: string; why?: string }[] = [];
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    try {
      const view = renderOverview();
      const reject = await waitFor(() => view.getByRole("button", { name: "Reject…" }));

      expect(view.queryByRole("button", { name: "Dismiss" })).toBeNull();
      fireEvent.click(reject);

      const confirm = view.getByRole("button", { name: "Reject proposal" }) as HTMLButtonElement;
      const reasonInput = view.getByLabelText("Rejection reason") as HTMLInputElement;
      expect(reasonInput.placeholder).toMatch(/Reason \(required/i);
      expect(confirm.disabled).toBe(true);

      await act(async () => changeInput(reasonInput, "   "));
      fireEvent.click(confirm);
      expect(rejectedCalls).toEqual([]);

      await act(async () => changeInput(reasonInput, " No longer actionable "));
      await waitFor(() => expect(confirm.disabled).toBe(false));
      await act(async () => fireEvent.click(confirm));
      await waitFor(() =>
        expect(rejectedCalls).toEqual([
          { id: stubProposal.id, why: "No longer actionable" },
        ]),
      );
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
      api.reject = origReject;
    }
  });

  test("shows a fallback for a proposal id with no match in the proposals list", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () => baseStatus({ expiredOpenProposals: ["prop_missing"] });
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    try {
      const { getByText, queryByTitle } = renderOverview();

      await waitFor(() => queryByTitle("prop_missing — click to copy"));

      expect(getByText(/agent: —/)).toBeTruthy();
      expect(getByText(/origin —\/—/)).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
    }
  });

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
      const { getByText } = renderOverview();

      await waitFor(() => getByText(/stale leases: 3/));
      expect(getByText(/unpublished outbox rows: 2/)).toBeTruthy();
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
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
    expect(scopedCount(rows, { kind: "all" }, { repos: (r) => r.repos })).toBe(4);
    expect(scopedTally(rows, repo, { repos: (r) => r.repos, key: (r) => r.state })).toEqual({
      LEASED: 1,
      QUEUED: 1,
    });
  });

  test("in flight keeps LEASED/RUNNING and drops QUEUED even when repos match", () => {
    expect(
      scopedTally(rows, { kind: "inflight" }, {
        repos: (r) => r.repos,
        state: (r) => r.state,
        key: (r) => r.state,
      }),
    ).toEqual({ LEASED: 2, RUNNING: 1 });
    expect(
      scopedCount(rows, { kind: "inflight" }, { repos: (r) => r.repos, state: (r) => r.state }),
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
      const { getByRole, queryByRole } = renderOverview({ kind: "repo", name: "bj29" });

      await waitFor(() => getByRole("button", { name: "events · human_needed: 1" }));

      // Negative: factory-wide totals must not appear as the clickable count.
      expect(queryByRole("button", { name: "events · human_needed: 4" })).toBeNull();
      expect(queryByRole("button", { name: "events · dead_lettered: 2" })).toBeNull();
      expect(getByRole("button", { name: "events · dead_lettered: 0" })).toBeTruthy();
      expect(getByRole("button", { name: "proposals · open: 2" })).toBeTruthy();
      expect(queryByRole("button", { name: "proposals · open: 5" })).toBeNull();
      expect(getByRole("button", { name: "proposals · expired: 1" })).toBeTruthy();
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
      events: [stubEvent({ eventId: "e1", status: "admitted", repos: ["bj29"] })],
    });

    try {
      const { getByRole, queryByRole } = renderOverview({ kind: "repo", name: "bj29" });

      await waitFor(() => getByRole("button", { name: /workers · live/ }));

      expect(getByRole("button", { name: "workers · live · factory-wide: 3" })).toBeTruthy();
      expect(getByRole("button", { name: "workers · busy · factory-wide: 1" })).toBeTruthy();
      expect(getByRole("button", { name: "workers · stale · factory-wide: 2" })).toBeTruthy();
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
      await waitFor(() => repo.getByText(/Activity · latest/));
      expect(repo.getByText(/Activity · latest/).textContent?.toLowerCase()).toMatch(/factory-wide/);
      expect(repo.getByText(/Outbox/).textContent?.toLowerCase()).toMatch(/factory-wide/);
      expect(repo.container.textContent).not.toMatch(/\/journal|\/outbox|GET \//);
      repo.unmount();

      const all = renderOverview({ kind: "all" });
      await waitFor(() => all.getByText(/Activity · latest/));
      expect(all.getByText(/Activity · latest/).textContent?.toLowerCase()).not.toMatch(/factory-wide/);
      expect(all.getByText(/Outbox/).textContent?.toLowerCase()).not.toMatch(/factory-wide/);
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
      const { getByRole, queryByRole, getAllByText } = renderOverview({ kind: "inflight" });

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
      expect(repo.getByText(/Anomalies ·/).textContent?.toLowerCase()).toMatch(/factory-wide/);
      repo.unmount();

      const all = renderOverview({ kind: "all" });
      await waitFor(() => all.getByText(/Anomalies ·/));
      expect(all.getByText(/Anomalies ·/).textContent?.toLowerCase()).not.toMatch(/factory-wide/);
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
      deadLettered: [{ source: "github", eventId: "e99", lastError: "timeout" }],
      stalledWorkers: [{ workerId: "w1", runId: "r1", host: "srv1", lastSeen: new Date().toISOString() }],
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
    expect(rows[0]!.proposalId).toBe("prop_1");
    expect(rows[0]!.proposal?.agent).toBe("triage-scan");
    expect(rows[1]!.text).toMatch(/stale leases: 2/);
    expect(rows[2]!.text).toMatch(/unpublished outbox rows: 1/);
    expect(rows[3]!.requeue).toEqual({ source: "github", eventId: "e99" });
    expect(rows[4]!.text).toMatch(/stalled worker w1 still holds run r1/);
    expect(rows[5]!.text).toMatch(/ambiguous open proposals: 3/);
    expect(rows[6]!.text).toMatch(/4 queued runs and no live worker/);
  });

  test("returns empty array for undefined anomalies", () => {
    expect(buildAnomalyRows(undefined, new Map(), callbacks)).toEqual([]);
  });
});

describe("Overview 4-Band layout & telemetry (WM-205)", () => {
  test("renders nominal status banner when no anomalies are present", async () => {
    const origStatus = api.status;
    const origProposals = api.proposals;
    const origOutbox = api.outbox;
    const origJournal = api.journal;
    api.status = async () => baseStatus();
    api.proposals = async () => ({ proposals: [] });
    api.outbox = async () => ({ outbox: [] });
    api.journal = async () => ({ entries: [], head: 0 });

    try {
      const { getByText } = renderOverview();
      await waitFor(() => getByText(/Doctor: All systems nominal/));
      expect(getByText(/Doctor: All systems nominal/)).toBeTruthy();
      expect(getByText(/scope: all repos/)).toBeTruthy();
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
        entry({ seq: 3, runId: "run_term_1", from: "RUNNING", to: "COMPLETED" }),
        entry({ seq: 2, runId: "run_term_2", from: "RUNNING", to: "FAILED" }),
        entry({ seq: 1, runId: "run_term_3", from: "LEASED", to: "RUNNING" }),
      ],
    });

    try {
      const { getByText, getByTitle, getByRole } = renderOverview();

      await waitFor(() => getByText(/Worker Fleet Capacity/));
      expect(getByText(/3 live · 1 busy · 2 idle/)).toBeTruthy();
      expect(getByRole("button", { name: "worker capacity: 1 running of 4, 2 queued" })).toBeTruthy();
      expect(getByText("per-repo max_in_flight reached")).toBeTruthy();
      expect(getByText("light 1/3")).toBeTruthy();

      // Recent outcomes strip displays completed & failed terminal entries (2 total)
      expect(getByText(/Recent Outcomes · last 2/)).toBeTruthy();
      expect(getByTitle(/run_term_1 · COMPLETED/)).toBeTruthy();
      expect(getByTitle(/run_term_2 · FAILED/)).toBeTruthy();

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


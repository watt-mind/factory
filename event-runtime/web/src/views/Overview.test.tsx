import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Overview, groupJournalEntries } from "./Overview";
import { api } from "../api";
import type { JournalEntry, Proposal, StatusView } from "../types";

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

function renderOverview() {
  return renderWithClient(
    <Overview
      connected={true}
      context={{ kind: "all" }}
      onJumpRun={noop}
      onJumpProposal={noop}
      onJumpEvents={noop}
      onJumpRuns={noop}
      onNavigate={noop}
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
      expect(idNode?.textContent).toBe(stubProposal.id);
    } finally {
      api.status = origStatus;
      api.proposals = origProposals;
      api.outbox = origOutbox;
      api.journal = origJournal;
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

import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Overview } from "./Overview";
import { api } from "../api";
import type { Proposal, StatusView } from "../types";

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

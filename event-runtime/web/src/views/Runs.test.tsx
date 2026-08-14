import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Runs } from "./Runs";
import { api } from "../api";
import type { LifecycleEvent, RunDetail, RunListItem, RunState, StatusView } from "../types";

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

const FAILURE_REASON = 'contract_violation: $: unknown property "captured"';

function stubStatus(): StatusView {
  return {
    env: { name: "test", home: "/tmp/test", adapter: null },
    events: {},
    proposals: { open: 0, expired: 0 },
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
    },
  };
}

const NOW = new Date().toISOString();

function stubListItem(runId: string, state: RunState): RunListItem {
  return {
    runId,
    state,
    attempts: 1,
    maxAttempts: 3,
    agent: "triage-scan",
    adapter: "claude-code",
    reasonCode: state === "FAILED" ? "contract_violation" : null,
    eventId: null,
    eventSource: null,
    created_at: NOW,
    updated_at: NOW,
    repos: [],
  };
}

function stubDetail(runId: string, state: RunState, lifecycle: LifecycleEvent[]): RunDetail {
  return {
    run: {
      runId,
      state,
      attempts: 1,
      idempotencyKey: "idem-1",
      specHash: "hash-1",
      created_at: NOW,
      updated_at: NOW,
      spec: {
        schemaVersion: "1",
        runId,
        agent: "triage-scan",
        input: {},
        inputHash: "in-1",
        workspace: { type: "ephemeral" },
        adapter: "claude-code",
        promptVersion: "1",
        policyVersion: "1",
        outputContract: "triage/v1",
        capabilities: [],
        timeoutSeconds: 600,
        maxAttempts: 3,
        idempotencyKey: "idem-1",
      },
    },
    lifecycle,
    attempts: [],
    result: null,
    receipt: null,
    workspace: null,
  };
}

function transition(seq: number, runId: string, from: string | null, to: string, reason: string | null): LifecycleEvent {
  return { seq, run_id: runId, from_state: from, to_state: to, actor: "worker_1", reason, attempt: 1, at: NOW };
}

function renderRuns(focusRunId: string) {
  return renderWithClient(
    <Runs
      connected={true}
      context={{ kind: "all" }}
      focusRunId={focusRunId}
      onSelectRun={noop}
      onOpenFull={noop}
      focusState={null}
      onFocusStateConsumed={noop}
      onJumpAgent={noop}
      onJumpEvent={noop}
    />,
  );
}

function withApi(runs: RunListItem[], detail: RunDetail, fn: () => Promise<void>) {
  const orig = { runs: api.runs, run: api.run, status: api.status, trace: api.trace };
  api.runs = async () => ({ runs });
  api.run = async () => detail;
  api.status = async () => stubStatus();
  api.trace = async () => ({ head: 0, entries: [] });
  return fn().finally(() => {
    api.runs = orig.runs;
    api.run = orig.run;
    api.status = orig.status;
    api.trace = orig.trace;
  });
}

describe("Runs detail failure banner (WM-93)", () => {
  test("FAILED run renders the terminal transition's reason as a banner with a copy affordance", async () => {
    const runId = "run_failed_1";
    const detail = stubDetail(runId, "FAILED", [
      transition(1, runId, null, "QUEUED", null),
      transition(2, runId, "QUEUED", "LEASED", null),
      transition(3, runId, "LEASED", "RUNNING", null),
      transition(4, runId, "RUNNING", "FAILED", FAILURE_REASON),
    ]);
    await withApi([stubListItem(runId, "FAILED")], detail, async () => {
      const { getByRole, getByText } = renderRuns(runId);

      await waitFor(() => getByRole("alert"));

      const banner = getByRole("alert");
      // The full, untruncated reason string, plus the copy affordance.
      expect(banner.textContent).toContain(FAILURE_REASON);
      expect(getByText("Copy reason")).toBeTruthy();

      // Before the metadata rows: the banner precedes the "Run" section in the document.
      const runSection = getByText("idempotencyKey");
      expect(banner.compareDocumentPosition(runSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  test("COMPLETED run renders no banner", async () => {
    const runId = "run_ok_1";
    const detail = stubDetail(runId, "COMPLETED", [
      transition(1, runId, null, "QUEUED", null),
      transition(2, runId, "QUEUED", "LEASED", null),
      transition(3, runId, "LEASED", "RUNNING", null),
      transition(4, runId, "RUNNING", "COMPLETED", "ok"),
    ]);
    await withApi([stubListItem(runId, "COMPLETED")], detail, async () => {
      const { getByText, queryByRole } = renderRuns(runId);

      // Wait for the detail panel to load, then assert no banner appeared.
      await waitFor(() => getByText("idempotencyKey"));
      expect(queryByRole("alert")).toBeNull();
    });
  });
});

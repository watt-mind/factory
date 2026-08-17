import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ArtifactInventoryItem } from "../types";
import { Artifacts, formatBytes, type ArtifactFilters } from "./Artifacts";
import { handleRunArtifactClick } from "./Runs";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;
const LONG_RUN_ID = "run_12345678-1234-1234-1234-123456789abc";

const ITEMS: ArtifactInventoryItem[] = [
  {
    sha256: "a".repeat(64),
    sizeBytes: 1_024,
    mtime: "2026-01-02T03:04:05.000Z",
    referenced: true,
    references: [
      {
        runId: LONG_RUN_ID,
        kind: "report",
        agent: "reporter@1",
        state: "COMPLETED",
        createdAt: "2026-01-02T03:04:05.000Z",
      },
    ],
  },
  {
    sha256: "b".repeat(64),
    sizeBytes: 2_048,
    mtime: "2026-01-03T03:04:05.000Z",
    referenced: true,
    references: [
      {
        runId: "run_trace",
        kind: "transcript",
        agent: "ticket-agent@1",
        state: "COMPLETED",
        createdAt: "2026-01-03T03:04:05.000Z",
      },
    ],
  },
  {
    sha256: "c".repeat(64),
    sizeBytes: 512,
    mtime: "2026-01-04T03:04:05.000Z",
    referenced: false,
    references: [],
  },
];

afterEach(() => {
  cleanup();
  window.location.hash = "#/artifacts";
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  localStorage.removeItem("evrt-display-artifacts");
});

function renderArtifacts(
  onJumpRun = mock(() => {}),
  initialFilters: ArtifactFilters = { kind: null, orphan: null, search: "" },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false, staleTime: Infinity } },
  });
  client.setQueryData(["artifacts"], { artifacts: ITEMS });
  client.setQueryData(["events", "all-for-artifacts"], {
    events: [
      {
        source: "factory-chain",
        eventId: "evt_consumer",
        type: "factory.follow-up.requested",
        subject: "factory",
        status: "planned",
        occurredAt: "2026-01-02T03:05:05.000Z",
        receivedAt: "2026-01-02T03:05:05.000Z",
        correlationId: "corr_report",
        causationId: LONG_RUN_ID,
        planFailures: 0,
        lastPlanError: null,
        admittedAt: "2026-01-02T03:05:05.000Z",
        proposalId: "proposal_consumer",
        runId: "run_consumer",
        envelope: { payload: { inputArtifact: "a".repeat(64) } },
        repos: [],
      },
    ],
  });
  function Harness() {
    const [filters, setFilters] = useState<ArtifactFilters>(initialFilters);
    return (
      <QueryClientProvider client={client}>
        <Artifacts
          metrics={{
            files: 318,
            bytes: Math.round(2.4 * 1024 ** 3),
            orphans: 28,
            orphanBytes: Math.round(5.1 * 1024),
          }}
          filters={filters}
          onFiltersChange={setFilters}
          onJumpRun={onJumpRun}
        />
      </QueryClientProvider>
    );
  }
  return { ...render(<Harness />), onJumpRun };
}

describe("Artifacts inventory (WM-207)", () => {
  test("formats byte thresholds through GB with one decimal", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(2.4 * 1024 ** 3)).toBe("2.4 GB");
  });

  test("renders storage metrics, inventory columns, downloads, and shortened run jump links", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const summary = view.getByRole("region", { name: "Artifact storage summary" });
    expect(summary.textContent).toContain("2.4 GB");
    expect(summary.textContent).toContain("28");
    expect(summary.textContent).toContain("5.1 KB");

    for (const heading of ["SHA", "Kind", "File size", "Age", "Referenced by"]) {
      expect(view.getByRole("columnheader", { name: heading })).toBeTruthy();
    }
    expect(view.queryByRole("columnheader", { name: "Orphan" })).toBeNull();
    const download = view.getByRole("link", { name: `Download artifact ${"a".repeat(64)}` });
    expect(download.getAttribute("href")).toContain(`/api/artifacts/${"a".repeat(64)}`);

    const runLink = view.getByRole("button", { name: "run_12345678" });
    expect(runLink.getAttribute("title")).toBe(LONG_RUN_ID);
    fireEvent.click(runLink);
    expect(view.onJumpRun).toHaveBeenCalledWith(LONG_RUN_ID);
  });

  test("defaults to newest artifacts first", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const downloads = view.getAllByRole("link", { name: /Download artifact/ });
    expect(downloads.map((link) => link.textContent)).toEqual([
      "cccccccccccc",
      "bbbbbbbbbbbb",
      "aaaaaaaaaaaa",
    ]);
    expect(view.getByRole("columnheader", { name: "Age" }).getAttribute("aria-sort")).toBe("descending");
  });

  test("filters by kind and orphan status facets", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    fireEvent.change(view.getByRole("combobox", { name: "Artifact kind" }), { target: { value: "report" } });
    expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy();
    expect(view.queryByText("bbbbbbbbbbbb")).toBeNull();

    fireEvent.change(view.getByRole("combobox", { name: "Artifact kind" }), { target: { value: "" } });
    fireEvent.click(view.getByRole("tab", { name: "Orphans 28" }));
    expect(view.getByText("cccccccccccc")).toBeTruthy();
    expect(view.queryByText("aaaaaaaaaaaa")).toBeNull();

  });

  test("applies a free-text filter across reference metadata", async () => {
    const view = renderArtifacts(mock(() => {}), {
      kind: null,
      orphan: null,
      search: "ticket-agent",
    });
    await waitFor(() => expect(view.getByText("bbbbbbbbbbbb")).toBeTruthy());
    const table = view.getByRole("table");
    expect(within(table).queryByText("aaaaaaaaaaaa")).toBeNull();
    expect(within(table).queryByText("cccccccccccc")).toBeNull();
  });

  test("opens a deep-linked inspector with formatted preview, actions, search, and bidirectional references", async () => {
    const raw = JSON.stringify({ message: "hello artifact", count: 2 });
    globalThis.fetch = mock(async () => new Response(raw, { status: 200 })) as unknown as typeof fetch;
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    window.location.hash = `#/artifacts/${"a".repeat(64)}`;
    const view = renderArtifacts();

    const preview = await view.findByRole("region", { name: "Artifact content" });
    expect(preview.textContent).toContain('\"message\": \"hello artifact\"');
    expect(preview.textContent).toContain("1");
    expect(preview.textContent).toContain("2");

    const references = view.getByRole("region", { name: "Artifact run references" });
    fireEvent.click(within(references).getByRole("button", { name: /run_12345678/ }));
    expect(view.onJumpRun).toHaveBeenCalledWith(LONG_RUN_ID);
    fireEvent.click(within(references).getByTitle("Open consuming run run_consumer"));
    expect(view.onJumpRun).toHaveBeenCalledWith("run_consumer");
    expect(within(references).getByText(/factory-chain:evt_consumer/)).toBeTruthy();

    const download = view.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toContain(`/api/artifacts/${"a".repeat(64)}`);
    expect(view.getByRole("combobox", { name: "Search artifact content" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Copy Raw Content" }));
    fireEvent.click(view.getByRole("button", { name: "Copy SHA-256" }));
    expect(writeText).toHaveBeenNthCalledWith(1, raw);
    expect(writeText).toHaveBeenNthCalledWith(2, "a".repeat(64));
  });

  test("selects a row into the inspector and routes run artifact links to the same deep link", async () => {
    globalThis.fetch = mock(async () => new Response("line one\nline two", { status: 200 })) as unknown as typeof fetch;
    const view = renderArtifacts();
    const reportRow = view.getByText("1.0 KB").closest("tr");
    expect(reportRow).toBeTruthy();
    fireEvent.click(reportRow!);
    expect(window.location.hash).toBe(`#/${`artifacts/${"a".repeat(64)}`}`);
    expect(await view.findByRole("region", { name: "Artifact content" })).toBeTruthy();

    window.location.hash = `#/runs/${LONG_RUN_ID}`;
    const runLink = render(
      <div onClickCapture={handleRunArtifactClick}>
        <a href={`/api/artifacts/${"b".repeat(64)}?name=transcript`}>Open</a>
      </div>,
    );
    fireEvent.click(runLink.getByRole("link", { name: "Open" }));
    expect(window.location.hash).toBe(`#/${`artifacts/${"b".repeat(64)}`}`);
  });
});

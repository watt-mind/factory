import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ArtifactInventoryItem } from "../types";
import { Artifacts, type ArtifactFilters } from "./Artifacts";

const ITEMS: ArtifactInventoryItem[] = [
  {
    sha256: "a".repeat(64),
    sizeBytes: 1_024,
    mtime: "2026-01-02T03:04:05.000Z",
    referenced: true,
    references: [
      {
        runId: "run_report",
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
});

function renderArtifacts(
  onJumpRun = mock(() => {}),
  initialFilters: ArtifactFilters = { kind: null, orphan: null, search: "" },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  client.setQueryData(["artifacts"], { artifacts: ITEMS });
  function Harness() {
    const [filters, setFilters] = useState<ArtifactFilters>(initialFilters);
    return (
      <QueryClientProvider client={client}>
        <Artifacts
          metrics={{ files: 3, bytes: 3_584, orphans: 1, orphanBytes: 512 }}
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
  test("renders storage metrics, inventory columns, downloads, and run jump links", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const summary = view.getByRole("region", { name: "Artifact storage summary" });
    expect(summary.textContent).toContain("3");
    expect(summary.textContent).toContain("3.5 KB");
    expect(summary.textContent).toContain("1 · 512 B");

    for (const heading of ["SHA", "Kind", "File size", "Age / timestamp", "Referenced by", "Orphan"]) {
      expect(view.getByRole("columnheader", { name: heading })).toBeTruthy();
    }
    const download = view.getByRole("link", { name: `Download artifact ${"a".repeat(64)}` });
    expect(download.getAttribute("href")).toContain(`/api/artifacts/${"a".repeat(64)}`);

    fireEvent.click(view.getByRole("button", { name: "run_report" }));
    expect(view.onJumpRun).toHaveBeenCalledWith("run_report");
  });

  test("filters by kind and orphan status facets", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    fireEvent.click(view.getByRole("button", { name: "report" }));
    expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy();
    expect(view.queryByText("bbbbbbbbbbbb")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Any kind" }));
    fireEvent.click(view.getByRole("button", { name: "Orphans" }));
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
});

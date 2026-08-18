import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useState } from "react";
import type { ArtifactInventoryItem } from "../types";
import { Artifacts, formatBytes, type ArtifactFilters } from "./Artifacts";
import { ARTIFACT_RAW_KEY } from "../components/ArtifactView";
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
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  localStorage.removeItem("evrt-display-artifacts");
  localStorage.removeItem(ARTIFACT_RAW_KEY);
});

function renderArtifacts(
  onJumpRun = mock(() => {}),
  initialFilters: ArtifactFilters = { kind: null, orphan: null, search: "" },
  seed: { items?: ArtifactInventoryItem[]; agents?: unknown[] } = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
    },
  });
  client.setQueryData(["artifacts"], { artifacts: seed.items ?? ITEMS });
  if (seed.agents)
    client.setQueryData(["agents"], {
      agents: seed.agents,
      edges: {},
      eventTypes: [],
      contracts: {},
    });
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

    const summary = view.getByRole("region", {
      name: "Artifact storage summary",
    });
    expect(summary.textContent).toContain("2.4 GB");
    expect(summary.textContent).toContain("28");
    expect(summary.textContent).toContain("5.1 KB");

    for (const heading of [
      "SHA",
      "Kind",
      "File size",
      "Age",
      "Referenced by",
    ]) {
      expect(view.getByRole("columnheader", { name: heading })).toBeTruthy();
    }
    expect(view.queryByRole("columnheader", { name: "Orphan" })).toBeNull();
    const download = view.getByRole("link", {
      name: "Download aaaaaaaaaaaa.report",
    });
    expect(download.getAttribute("href")).toContain(
      `/api/artifacts/${"a".repeat(64)}`,
    );

    const runLink = view.getByRole("button", { name: "run_12345678" });
    expect(runLink.getAttribute("title")).toBe(LONG_RUN_ID);
    fireEvent.click(runLink);
    expect(view.onJumpRun).toHaveBeenCalledWith(LONG_RUN_ID);
  });

  test("defaults to newest artifacts first", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const shas = view.getAllByRole("link", { name: /^[0-9a-f]{12}$/ });
    expect(shas.map((link) => link.textContent)).toEqual([
      "cccccccccccc",
      "bbbbbbbbbbbb",
      "aaaaaaaaaaaa",
    ]);
    expect(
      view.getByRole("columnheader", { name: "Age" }).getAttribute("aria-sort"),
    ).toBe("descending");
  });

  test("filters by kind and orphan status facets", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    fireEvent.change(view.getByRole("combobox", { name: "Artifact kind" }), {
      target: { value: "report" },
    });
    expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy();
    expect(view.queryByText("bbbbbbbbbbbb")).toBeNull();

    fireEvent.change(view.getByRole("combobox", { name: "Artifact kind" }), {
      target: { value: "" },
    });
    fireEvent.click(view.getByRole("tab", { name: "Orphans 28" }));
    expect(view.getByText("cccccccccccc")).toBeTruthy();
    expect(view.queryByText("aaaaaaaaaaaa")).toBeNull();
  });

  test("applies a free-text filter across reference metadata", async () => {
    const view = renderArtifacts(
      mock(() => {}),
      {
        kind: null,
        orphan: null,
        search: "ticket-agent",
      },
    );
    await waitFor(() => expect(view.getByText("bbbbbbbbbbbb")).toBeTruthy());
    const table = view.getByRole("table");
    expect(within(table).queryByText("aaaaaaaaaaaa")).toBeNull();
    expect(within(table).queryByText("cccccccccccc")).toBeNull();
  });

  test("opens a deep-linked inspector with formatted preview, actions, search, and bidirectional references", async () => {
    const raw = JSON.stringify({ message: "hello artifact", count: 2 });
    globalThis.fetch = mock(
      async () => new Response(raw, { status: 200 }),
    ) as unknown as typeof fetch;
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    window.location.hash = `#/artifacts/${"a".repeat(64)}`;
    const view = renderArtifacts();

    const preview = await view.findByRole("region", {
      name: "Artifact content",
    });
    expect(preview.textContent).toContain('\"message\": \"hello artifact\"');
    expect(preview.textContent).toContain("1");
    expect(preview.textContent).toContain("2");

    const references = view.getByRole("region", {
      name: "Artifact run references",
    });
    fireEvent.click(
      within(references).getByRole("button", { name: /run_12345678/ }),
    );
    expect(view.onJumpRun).toHaveBeenCalledWith(LONG_RUN_ID);
    fireEvent.click(
      within(references).getByTitle("Open consuming run run_consumer"),
    );
    expect(view.onJumpRun).toHaveBeenCalledWith("run_consumer");
    expect(
      within(references).getByText(/factory-chain:evt_consumer/),
    ).toBeTruthy();

    const download = view.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toContain(
      `/api/artifacts/${"a".repeat(64)}`,
    );
    expect(
      view.getByRole("combobox", { name: "Search artifact content" }),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Copy Raw Content" }));
    fireEvent.click(view.getByRole("button", { name: "Copy SHA-256" }));
    expect(writeText).toHaveBeenNthCalledWith(1, raw);
    expect(writeText).toHaveBeenNthCalledWith(2, "a".repeat(64));
  });

  test("selects a row into the inspector and routes run artifact links to the same deep link", async () => {
    globalThis.fetch = mock(
      async () => new Response("line one\nline two", { status: 200 }),
    ) as unknown as typeof fetch;
    const view = renderArtifacts();
    const reportRow = view.getByText("1.0 KB").closest("tr");
    expect(reportRow).toBeTruthy();
    fireEvent.click(reportRow!);
    expect(window.location.hash).toBe(`#/${`artifacts/${"a".repeat(64)}`}`);
    expect(
      await view.findByRole("region", { name: "Artifact content" }),
    ).toBeTruthy();

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

describe("Artifact rows inspect on click, download on demand (WM-699)", () => {
  const SHA_A = "a".repeat(64);

  test("opening and closing the inspector preserves project context (WM-748)", async () => {
    globalThis.fetch = mock(
      async () => new Response("line one", { status: 200 }),
    ) as unknown as typeof fetch;
    window.location.hash = "#/artifacts?project=factory";
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const sha = view.getByRole("link", { name: "aaaaaaaaaaaa" });
    expect(sha.getAttribute("href")).toBe(
      `#/artifacts/${SHA_A}?project=factory`,
    );

    fireEvent.click(view.getByText("1.0 KB").closest("tr")!);
    expect(window.location.hash).toBe(`#/artifacts/${SHA_A}?project=factory`);
    fireEvent.click(await view.findByRole("button", { name: "Close" }));
    expect(window.location.hash).toBe("#/artifacts?project=factory");
  });

  test("the SHA is a deep link into the inspector, not a download", async () => {
    globalThis.fetch = mock(
      async () => new Response("line one\nline two", { status: 200 }),
    ) as unknown as typeof fetch;
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const sha = view.getByRole("link", { name: "aaaaaaaaaaaa" });
    expect(sha.getAttribute("href")).toBe(`#/artifacts/${SHA_A}`);
    expect(sha.hasAttribute("download")).toBe(false);

    fireEvent.click(sha);
    expect(window.location.hash).toBe(`#/artifacts/${SHA_A}`);
    expect(
      await view.findByRole("region", { name: "Artifact content" }),
    ).toBeTruthy();
  });

  test("the row download control does not select the row", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const download = view.getByRole("link", {
      name: "Download aaaaaaaaaaaa.report",
    });
    expect(download.getAttribute("download")).toBe("aaaaaaaaaaaa.report");
    expect(download.getAttribute("href")).toContain(
      `/api/artifacts/${SHA_A}?name=`,
    );
    expect(download.classList.contains("h-6")).toBe(true);
    expect(download.classList.contains("w-6")).toBe(true);

    fireEvent.click(download);
    expect(window.location.hash).not.toContain(SHA_A);
    expect(
      view.queryByRole("region", { name: "Artifact metadata" }),
    ).toBeNull();
  });

  test("rows take Tab focus and select on Enter and Space", async () => {
    globalThis.fetch = mock(
      async () => new Response("line one", { status: 200 }),
    ) as unknown as typeof fetch;
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const row = view.getByText("1.0 KB").closest("tr");
    expect(row?.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(row!, { key: "Enter" });
    expect(window.location.hash).toBe(`#/artifacts/${SHA_A}`);
    expect(
      await view.findByRole("region", { name: "Artifact content" }),
    ).toBeTruthy();

    window.location.hash = "#/artifacts";
    fireEvent.keyDown(view.getByText("512 B").closest("tr")!, { key: " " });
    expect(window.location.hash).toBe(`#/artifacts/${"c".repeat(64)}`);
  });

  test("a modified click leaves the current view for the browser to handle", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    fireEvent.click(view.getByText("1.0 KB").closest("tr")!, {
      metaKey: true,
    });
    expect(window.location.hash).toBe("#/artifacts");
    expect(
      view.queryByRole("region", { name: "Artifact metadata" }),
    ).toBeNull();
  });

  test("a binary artifact offers metadata and a download instead of a text preview", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("PK\u0003\u0004\u0000\u0000\uFFFD\uFFFD\u0001\u0002", {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${SHA_A}`;
    const view = renderArtifacts();

    expect(await view.findByText(/cannot be previewed/i)).toBeTruthy();
    expect(view.queryByRole("region", { name: "Artifact content" })).toBeNull();
    expect(
      view.queryByRole("combobox", { name: "Search artifact content" }),
    ).toBeNull();

    const prominent = view.getByRole("link", { name: "Download file" });
    expect(prominent.getAttribute("href")).toContain(
      `/api/artifacts/${SHA_A}?name=aaaaaaaaaaaa.report`,
    );
    expect(prominent.getAttribute("download")).toBe("aaaaaaaaaaaa.report");
    expect(
      view.getByRole("region", { name: "Artifact metadata" }).textContent,
    ).toContain("1.0 KB");
    expect(view.getByRole("link", { name: "Download" })).toBeTruthy();
  });

  test("short text with one replacement character remains previewable", async () => {
    globalThis.fetch = mock(
      async () => new Response("partially decoded: \uFFFD", { status: 200 }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${SHA_A}`;
    const view = renderArtifacts();

    const preview = await view.findByRole("region", {
      name: "Artifact content",
    });
    expect(preview.textContent).toContain("partially decoded: \uFFFD");
    expect(view.queryByText(/cannot be previewed/i)).toBeNull();
  });

  test("a long sample with more than two percent replacement characters uses the binary fallback", async () => {
    const raw = `${"a".repeat(4000)}${"\uFFFD".repeat(96)}trailing text`;
    globalThis.fetch = mock(
      async () => new Response(raw, { status: 200 }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${SHA_A}`;
    const view = renderArtifacts();

    expect(await view.findByText(/cannot be previewed/i)).toBeTruthy();
    expect(view.queryByRole("region", { name: "Artifact content" })).toBeNull();
  });
});

describe("Artifacts inspector renders a view for the producing agent's artifact (WM-455)", () => {
  const MERGE_VIEW = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../agents/merge-scan.view.json"),
      "utf8",
    ),
  );
  const MERGE_AGENT = {
    ref: "merge-scan@2",
    id: "merge-scan",
    outputSchema: { title: "merge plan" },
    outputView: MERGE_VIEW,
  };
  const MERGE_ITEM: ArtifactInventoryItem = {
    sha256: "d".repeat(64),
    sizeBytes: 900,
    mtime: "2026-01-05T03:04:05.000Z",
    referenced: true,
    references: [
      {
        runId: "run_merge",
        kind: "report",
        agent: "merge-scan@2",
        state: "COMPLETED",
        createdAt: "2026-01-05T03:04:05.000Z",
      },
    ],
  };
  const MERGE_PLAN = {
    recommendation: "ESCALATE",
    repo: "factory",
    github: "watt-mind/factory",
    base: "develop",
    deployBranch: "main",
    plan: [],
    fix: [],
    escalate: [
      {
        pr: 471,
        ticket: "WM-210",
        headSha: "c".repeat(40),
        reason: "Draft hold.",
      },
    ],
    summary: "One PR held.",
  };

  test("a stored merge-plan JSON draws through the merge-scan view, Raw swaps back to the line preview", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(MERGE_PLAN), { status: 200 }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${"d".repeat(64)}`;
    const view = renderArtifacts(undefined, undefined, {
      items: [MERGE_ITEM, ...ITEMS],
      agents: [MERGE_AGENT],
    });

    expect(await view.findByText("One PR held.")).toBeTruthy();
    expect(view.getByText("ESCALATE")).toBeTruthy();
    expect(
      (
        view.getByRole("link", { name: "#471" }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("https://github.com/watt-mind/factory/pull/471");
    expect(view.queryByRole("region", { name: "Artifact content" })).toBeNull();
    expect(
      view.queryByRole("combobox", { name: "Search artifact content" }),
    ).toBeNull();
    expect(view.getByText(/Merge plan · merge-scan@2/)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Raw" }));
    const preview = view.getByRole("region", { name: "Artifact content" });
    expect(preview.textContent).toContain('"recommendation": "ESCALATE"');
    expect(
      view.getByRole("combobox", { name: "Search artifact content" }),
    ).toBeTruthy();
    expect(localStorage.getItem(ARTIFACT_RAW_KEY)).toBe("1");

    fireEvent.click(view.getByRole("button", { name: "View" }));
    expect(view.queryByRole("region", { name: "Artifact content" })).toBeNull();
    expect(view.getByText("One PR held.")).toBeTruthy();
  });

  test("a transcript from an agent with a view keeps the plain preview — the view says nothing about it", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ type: "assistant", text: "hi" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${"d".repeat(64)}`;
    const view = renderArtifacts(undefined, undefined, {
      items: [MERGE_ITEM, ...ITEMS],
      agents: [MERGE_AGENT],
    });
    const preview = await view.findByRole("region", {
      name: "Artifact content",
    });
    expect(preview.textContent).toContain('"type": "assistant"');
    expect(
      view.queryByRole("group", { name: "Artifact rendering" }),
    ).toBeNull();
  });
});

import "../test-dom";
import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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
import {
  Artifacts,
  formatBytes,
  formattedContent,
  type ArtifactFilters,
} from "./Artifacts";
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
  seed: {
    items?: ArtifactInventoryItem[];
    agents?: unknown[];
    nextBefore?: string | null;
    formatContent?: typeof formattedContent;
  } = {},
  onOpenFull = mock(() => {}),
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
    },
  });
  client.setQueryData(
    [
      "artifacts",
      initialFilters.kind,
      initialFilters.orphan,
      initialFilters.search,
    ],
    {
      artifacts: seed.items ?? ITEMS,
      nextBefore: seed.nextBefore,
    },
  );
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
          onOpenFull={onOpenFull}
          formatContent={seed.formatContent}
        />
      </QueryClientProvider>
    );
  }
  return { ...render(<Harness />), onJumpRun, onOpenFull };
}

// happy-dom mutates this controlled input without reaching React's onChange;
// call the mounted handler so assertions exercise component state, not stale DOM.
function changeControlledInput(input: HTMLInputElement, value: string) {
  const propsKey = Object.keys(input).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) throw new Error("React input props were not mounted");
  const props = (
    input as unknown as Record<
      string,
      { onChange: (event: { target: HTMLInputElement }) => void }
    >
  )[propsKey];
  act(() =>
    props.onChange({
      target: { value, selectionStart: value.length } as HTMLInputElement,
    }),
  );
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
    const grid = view.getByRole("grid");
    expect(within(grid).queryByText("aaaaaaaaaaaa")).toBeNull();
    expect(within(grid).queryByText("cccccccccccc")).toBeNull();
  });

  test("requests the active kind, orphan, and search filters", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ artifacts: ITEMS }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    fireEvent.change(view.getByRole("combobox", { name: "Artifact kind" }), {
      target: { value: "report" },
    });
    fireEvent.click(view.getByRole("tab", { name: "Orphans 28" }));
    changeControlledInput(
      view.getByRole("combobox", {
        name: "Search artifacts",
      }) as HTMLInputElement,
      "reporter@1",
    );

    await waitFor(() =>
      expect(requests).toContain(
        "/api/artifacts?kind=report&orphan=true&search=reporter%401",
      ),
    );
  });

  test("trims the search term before querying the server", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ artifacts: ITEMS }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    changeControlledInput(
      view.getByRole("combobox", {
        name: "Search artifacts",
      }) as HTMLInputElement,
      "  reporter@1  ",
    );

    await waitFor(() =>
      expect(requests).toContain("/api/artifacts?search=reporter%401"),
    );
  });

  test("resolves a deep-linked artifact outside the filtered page", async () => {
    const requests: string[] = [];
    const orphanOnly = ITEMS.filter((item) => !item.referenced);
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("/api/artifacts?")) {
        const params = new URL(url, "http://localhost").searchParams;
        const search = params.get("search");
        const hit = ITEMS.filter((item) => !search || item.sha256 === search);
        return new Response(JSON.stringify({ artifacts: hit }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ message: "deep" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    window.location.hash = `#/artifacts/${"a".repeat(64)}`;
    const view = renderArtifacts(
      undefined,
      { kind: null, orphan: true, search: "" },
      { items: orphanOnly },
    );

    const references = await view.findByRole("region", {
      name: "Artifact run references",
    });
    expect(within(references).getByText(/run_12345678/)).toBeTruthy();
    expect(requests).toContain(
      `/api/artifacts?search=${"a".repeat(64)}&limit=1`,
    );
    expect(view.queryByText(/metadata is unavailable/i)).toBeNull();
  });

  test("ignores a fallback row whose digest differs from the deep link", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/artifacts?")) {
        return new Response(JSON.stringify({ artifacts: [ITEMS[1]] }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    window.location.hash = `#/artifacts/${"a".repeat(64)}`;
    const view = renderArtifacts(
      undefined,
      { kind: null, orphan: true, search: "" },
      { items: [ITEMS[2]] },
    );

    await view.findByText(/metadata is unavailable/i);
    expect(view.queryByText(/run_trace/)).toBeNull();
  });

  test("warns when the server has more artifacts than this page", async () => {
    const view = renderArtifacts(undefined, undefined, {
      nextBefore: "older-artifacts",
    });
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    expect(view.getByRole("status").textContent).toMatch(
      /showing 3 artifacts.*more.*narrow the filter/i,
    );
  });

  test("the more-available notice counts the visible rows", async () => {
    const view = renderArtifacts(
      undefined,
      { kind: "report", orphan: null, search: "" },
      { nextBefore: "older-artifacts" },
    );
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    expect(view.getByRole("status").textContent).toMatch(
      /showing 1 artifacts?.*more/i,
    );
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

  test("formats a large artifact once across a useNow tick", async () => {
    const raw = JSON.stringify({
      entries: Array.from({ length: 10_000 }, (_, index) => ({
        index,
        message: `artifact line ${index}`,
      })),
    });
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    const formatContent = mock(formattedContent);
    globalThis.fetch = mock(
      async () => new Response(raw, { status: 200 }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${"a".repeat(64)}`;

    try {
      const view = renderArtifacts(undefined, undefined, { formatContent });
      await view.findByRole("region", { name: "Artifact content" });
      expect(formatContent).toHaveBeenCalledTimes(1);

      act(() => jest.advanceTimersByTime(1_000));

      expect(formatContent).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      jest.useRealTimers();
    }
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

  test("run artifact click keeps ?project= on the inspector hash (WM-761)", () => {
    const sha = "b".repeat(64);
    window.location.hash = `#/runs/${LONG_RUN_ID}?project=factory`;
    const runLink = render(
      <div onClickCapture={handleRunArtifactClick}>
        <a href={`/api/artifacts/${sha}?name=transcript`}>Open</a>
      </div>,
    );
    fireEvent.click(runLink.getByRole("link", { name: "Open" }));
    expect(window.location.hash).toBe(`#/artifacts/${sha}?project=factory`);
  });

  test("preserves URL-backed facets when opening and closing the inspector", async () => {
    globalThis.fetch = mock(
      async () => new Response("artifact report", { status: 200 }),
    ) as unknown as typeof fetch;
    const query =
      "kind=report&orphan=false&search=reporter%401&project=factory";
    window.location.hash = `#/artifacts?${query}`;
    const view = renderArtifacts(
      mock(() => {}),
      {
        kind: "report",
        orphan: false,
        search: "reporter@1",
      },
    );

    fireEvent.click(await view.findByRole("link", { name: "aaaaaaaaaaaa" }));
    expect(window.location.hash).toBe(`#/artifacts/${"a".repeat(64)}?${query}`);
    expect(
      await view.findByRole("region", { name: "Artifact content" }),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(window.location.hash).toBe(`#/artifacts?${query}`);
  });
});

describe("Artifact rows inspect on click, download on demand (WM-699)", () => {
  const SHA_A = "a".repeat(64);

  test.each([
    ["single-line", "line one", "1 line"],
    ["multi-line", "line one\nline two", "2 lines"],
  ])(
    "labels a %s preview with the correct line-count grammar",
    async (_, raw, label) => {
      globalThis.fetch = mock(
        async () => new Response(raw, { status: 200 }),
      ) as unknown as typeof fetch;
      window.location.hash = `#/artifacts/${SHA_A}`;

      const view = renderArtifacts();
      await view.findByRole("region", { name: "Artifact content" });

      expect(
        within(
          view.getByRole("region", { name: "Artifact preview" }),
        ).getByText(label),
      ).toBeTruthy();
    },
  );

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

  test("the SHA link leaves hash assignment to browser navigation", async () => {
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const sha = view.getByRole("link", { name: "aaaaaaaaaaaa" });
    // Suppress only the anchor's default navigation. The click still bubbles,
    // so a row handler that also assigns the hash makes this assertion fail.
    sha.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(sha);
    expect(window.location.hash).toBe("#/artifacts");
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

  test("grid rows take Tab focus and select on Enter and Space", async () => {
    globalThis.fetch = mock(
      async () => new Response("line one", { status: 200 }),
    ) as unknown as typeof fetch;
    const view = renderArtifacts();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    const grid = view.getByRole("grid");
    expect(within(grid).getAllByRole("rowgroup")).toHaveLength(2);
    expect(within(grid).getAllByRole("columnheader")).toHaveLength(5);

    const row = view.getByText("1.0 KB").closest("tr");
    expect(row?.getAttribute("role")).toBe("row");
    expect(within(row!).getAllByRole("gridcell")).toHaveLength(5);
    expect(row?.getAttribute("tabindex")).toBe("0");
    expect(row?.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(row!, { key: "Enter" });
    expect(window.location.hash).toBe(`#/artifacts/${SHA_A}`);
    await waitFor(() =>
      expect(row?.getAttribute("aria-selected")).toBe("true"),
    );
    expect(
      await view.findByRole("region", { name: "Artifact content" }),
    ).toBeTruthy();

    window.location.hash = "#/artifacts";
    fireEvent.keyDown(view.getByText("512 B").closest("tr")!, { key: " " });
    expect(window.location.hash).toBe(`#/artifacts/${"c".repeat(64)}`);
  });

  test("hash-driven selection clears the previous artifact content search", async () => {
    globalThis.fetch = mock(
      async () => new Response("line one\nline two", { status: 200 }),
    ) as unknown as typeof fetch;
    window.location.hash = `#/artifacts/${SHA_A}`;
    const view = renderArtifacts();
    await view.findByRole("region", { name: "Artifact content" });

    const search = view.getByRole("combobox", {
      name: "Search artifact content",
    }) as HTMLInputElement;
    changeControlledInput(search, "line one");
    expect(search.value).toBe("line one");
    await waitFor(() =>
      expect(
        view.getByRole("region", { name: "Artifact preview" }).textContent,
      ).toContain("1 matching lines"),
    );

    window.location.hash = `#/artifacts/${"b".repeat(64)}`;
    fireEvent(window, new Event("hashchange"));

    await waitFor(() =>
      expect(
        (
          view.getByRole("combobox", {
            name: "Search artifact content",
          }) as HTMLInputElement
        ).value,
      ).toBe(""),
    );
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
    expect(
      view
        .getByRole("button", { name: "Copy Raw Content" })
        .hasAttribute("disabled"),
    ).toBe(true);
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
    expect(
      view
        .getByRole("button", { name: "Copy Raw Content" })
        .hasAttribute("disabled"),
    ).toBe(true);
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

describe("Full-page artifact reader view navigation & 'o' shortcut (WM-828)", () => {
  const SHA_A = "a".repeat(64);

  test("pressing 'o' on selected artifact row navigates to full page reader view", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/artifacts") || u.includes("/api/artifacts?")) {
        return new Response(JSON.stringify({ artifacts: ITEMS }), {
          status: 200,
        });
      }
      return new Response("line one\nline two", { status: 200 });
    }) as unknown as typeof fetch;

    window.location.hash = `#/artifacts/${SHA_A}`;
    const view = renderArtifacts();
    await view.findByRole("region", { name: "Artifact content" });

    fireEvent.keyDown(document.body, { key: "o" });
    expect(view.onOpenFull).toHaveBeenCalledWith(SHA_A);
  });

  test("detail pane includes Open in full page action with 'o' shortcut hint", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/artifacts") || u.includes("/api/artifacts?")) {
        return new Response(JSON.stringify({ artifacts: ITEMS }), {
          status: 200,
        });
      }
      return new Response("line one\nline two", { status: 200 });
    }) as unknown as typeof fetch;

    window.location.hash = `#/artifacts/${SHA_A}`;
    const view = renderArtifacts();
    await view.findByRole("region", { name: "Artifact content" });

    const openBtns = view.getAllByRole("button", { name: "Open in full page" });
    expect(openBtns.length).toBeGreaterThanOrEqual(1);
    expect(openBtns[0].getAttribute("title")).toBe("Open in full page (o)");

    fireEvent.click(openBtns[0]);
    expect(view.onOpenFull).toHaveBeenCalledWith(SHA_A);
  });
});

describe("Artifacts list row height (WM-843)", () => {
  test("SHA download stays 24×24 and overlaps py-1.5 padding", async () => {
    const view = renderArtifacts();
    const download = await view.findByRole("link", {
      name: "Download aaaaaaaaaaaa.report",
    });
    const tokens = download.className.split(/\s+/);
    expect(tokens).toContain("h-6");
    expect(tokens).toContain("w-6");
    expect(tokens).toContain("-my-1.5");
    const cell = download.closest("td");
    expect(cell).toBeTruthy();
    expect(cell!.className.split(/\s+/)).toContain("py-1.5");
  });
});

import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactInventoryItem } from "../types";
import { ArtifactFull } from "./ArtifactFull";
import { ARTIFACT_RAW_KEY } from "../components/ArtifactView";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;
const LONG_RUN_ID = "run_12345678-1234-1234-1234-123456789abc";
const SHA_A = "a".repeat(64);

const ITEMS: ArtifactInventoryItem[] = [
  {
    sha256: SHA_A,
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
];

afterEach(() => {
  cleanup();
  window.location.hash = `#/artifact/${SHA_A}`;
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  localStorage.removeItem(ARTIFACT_RAW_KEY);
});

function renderArtifactFull({
  digest = SHA_A,
  onBack = mock(() => {}),
  onJumpRun = mock(() => {}),
  seed = {},
  seedArtifacts = true,
}: {
  digest?: string;
  onBack?: () => void;
  onJumpRun?: (runId: string) => void;
  seed?: { items?: ArtifactInventoryItem[]; agents?: unknown[] };
  seedArtifacts?: boolean;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
    },
  });
  if (seedArtifacts)
    client.setQueryData(["artifact", digest], {
      artifacts: seed.items ?? ITEMS,
    });
  if (seed.agents) {
    client.setQueryData(["agents"], {
      agents: seed.agents,
      edges: {},
      eventTypes: [],
      contracts: {},
    });
  }

  function Harness() {
    return (
      <QueryClientProvider client={client}>
        <ArtifactFull digest={digest} onBack={onBack} onJumpRun={onJumpRun} />
      </QueryClientProvider>
    );
  }

  return { ...render(<Harness />), onBack, onJumpRun };
}

describe("ArtifactFull reader view (WM-828)", () => {
  test("requests only the selected digest", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ artifacts: ITEMS }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    renderArtifactFull({ seedArtifacts: false });

    await waitFor(() =>
      expect(requests).toContain(`/api/artifacts?search=${SHA_A}&limit=1`),
    );
  });

  test("ignores a positional hit whose digest differs from the requested one", async () => {
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    const view = renderArtifactFull({
      seed: { items: [{ ...ITEMS[0], sha256: "b".repeat(64) }] },
    });

    await view.findByRole("button", { name: /← Artifacts/ });
    expect(view.queryByText("1.0 KB")).toBeNull();
    expect(view.queryByRole("button", { name: "run_12345678" })).toBeNull();
  });

  test("renders header with back button, kind badges, short digest, size, timestamp, producing run jump link, and copy actions", async () => {
    const raw = JSON.stringify({ summary: "report content", status: "ok" });
    globalThis.fetch = mock(
      async () => new Response(raw, { status: 200 }),
    ) as unknown as typeof fetch;

    const view = renderArtifactFull();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    // Back button
    const backBtn = view.getByRole("button", { name: /← Artifacts/ });
    expect(backBtn).toBeTruthy();
    fireEvent.click(backBtn);
    expect(view.onBack).toHaveBeenCalled();

    // Kind badge & size & time
    expect(view.getByText("report")).toBeTruthy();
    expect(view.getByText("1.0 KB")).toBeTruthy();

    // Producing run link
    const runLink = view.getByRole("button", { name: "run_12345678" });
    expect(runLink.getAttribute("title")).toBe(LONG_RUN_ID);
    fireEvent.click(runLink);
    expect(view.onJumpRun).toHaveBeenCalledWith(LONG_RUN_ID);

    // Download link
    const download = view.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toContain(`/api/artifacts/${SHA_A}`);

    // Copy actions in header
    expect(view.getByRole("group", { name: "Copy actions" })).toBeTruthy();
  });

  test("handles Esc shortcut to go back and keyboard shortcuts for copying", async () => {
    globalThis.fetch = mock(
      async () => new Response("line 1\nline 2", { status: 200 }),
    ) as unknown as typeof fetch;
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const view = renderArtifactFull();
    await waitFor(() => expect(view.getByText("aaaaaaaaaaaa")).toBeTruthy());

    // Esc triggers onBack
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(view.onBack).toHaveBeenCalled();

    // c copies digest
    fireEvent.keyDown(document.body, { key: "c" });
    expect(writeText).toHaveBeenCalledWith(SHA_A);
  });

  test("renders a result artifact with its agent ArtifactView and toggles raw with 'r' key shortcut", async () => {
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
    const MERGE_SHA = "d".repeat(64);
    const MERGE_ITEM: ArtifactInventoryItem = {
      sha256: MERGE_SHA,
      sizeBytes: 900,
      mtime: "2026-01-05T03:04:05.000Z",
      referenced: true,
      references: [
        {
          runId: "run_collected",
          kind: "report",
          agent: "unrelated@1",
          state: "COMPLETED",
          createdAt: "2026-01-04T03:04:05.000Z",
        },
        {
          runId: "run_merge",
          kind: "result",
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
      summary: "One PR held in full view.",
    };

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(MERGE_PLAN), { status: 200 }),
    ) as unknown as typeof fetch;

    const view = renderArtifactFull({
      digest: MERGE_SHA,
      seed: {
        items: [MERGE_ITEM],
        agents: [
          {
            ref: "unrelated@1",
            id: "unrelated",
            outputSchema: {},
            outputView: {
              schemaVersion: "factory.artifact-view/v1",
              summary: "/not-present",
              sections: [],
            },
          },
          MERGE_AGENT,
        ],
      },
    });

    expect(await view.findByText("One PR held in full view.")).toBeTruthy();
    expect(view.getByText("ESCALATE")).toBeTruthy();

    // Toggle to raw via 'r'
    fireEvent.keyDown(document.body, { key: "r" });
    const rawPreview = await view.findByRole("region", {
      name: "Artifact content",
    });
    expect(rawPreview.textContent).toContain('"recommendation": "ESCALATE"');
    expect(localStorage.getItem(ARTIFACT_RAW_KEY)).toBe("1");

    // Toggle back to formatted view via 'r'
    fireEvent.keyDown(document.body, { key: "r" });
    expect(await view.findByText("One PR held in full view.")).toBeTruthy();
  });

  test("binary artifact displays binary information and download action", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("PK\u0003\u0004\u0000\u0000\uFFFD\uFFFD\u0001\u0002", {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const view = renderArtifactFull();
    expect(await view.findByText(/cannot be previewed/i)).toBeTruthy();
    expect(view.getByRole("link", { name: "Download file" })).toBeTruthy();
  });
});

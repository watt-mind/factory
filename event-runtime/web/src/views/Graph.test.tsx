import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";
import {
  createAgentsFixture,
  renderWithClient,
  restoreApi,
} from "../test-render";
import { Graph, graphLayoutChunk } from "./Graph";

// `mock.module` would poison bun's process-wide module registry for every
// later test file that imports `../graph/layout` (a throwing factory leaves an
// empty module behind), so the tests swap the chunk loader seam instead.
const realLoad = graphLayoutChunk.load;

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
  window.location.hash = "";
  graphLayoutChunk.load = realLoad;
});

function renderGraph() {
  return renderWithClient(
    <Graph
      context={{ kind: "all" }}
      focusNodeId={null}
      onSelectNode={() => {}}
      onJumpAgent={() => {}}
      onJumpEvents={() => {}}
      onJumpProposal={() => {}}
    />,
    { apiMocks: { agents: async () => createAgentsFixture() } },
  );
}

async function withCapturedErrors(
  run: (error: ReturnType<typeof mock>) => Promise<void>,
) {
  const error = mock(() => {});
  const originalError = console.error;
  const rejections: PromiseRejectionEvent[] = [];
  const onUnhandledRejection = (event: PromiseRejectionEvent) =>
    rejections.push(event);

  console.error = error;
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  try {
    await run(error);
    expect(rejections).toHaveLength(0);
  } finally {
    console.error = originalError;
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }
}

describe("Graph layout loading", () => {
  test("renders the chunk error when the dynamic layout import itself rejects (WM-1367)", async () => {
    // A stale deploy: the chunk URL baked into the shell no longer exists, so
    // `import()` rejects before any module code runs.
    graphLayoutChunk.load = () =>
      Promise.reject(
        new TypeError("Failed to fetch dynamically imported module"),
      );

    await withCapturedErrors(async (error) => {
      const rendered = renderGraph();
      await waitFor(() => {
        expect(
          rendered.getByText(/Could not load the graph layout engine/),
        ).toBeTruthy();
      });
      expect(error).toHaveBeenCalledWith(
        "graph layout chunk import failed",
        expect.any(TypeError),
      );
      expect(error).not.toHaveBeenCalledWith(
        "graph layout calculation failed",
        expect.anything(),
      );
    });
  });

  test("renders the layout error instead of leaking a rejected layout calculation", async () => {
    graphLayoutChunk.load = async () => {
      const actual = await realLoad();
      return {
        ...actual,
        layoutGraphIfIdentityChanged: () =>
          Promise.reject(new Error("layout engine timed out")),
      };
    };

    await withCapturedErrors(async (error) => {
      const rendered = renderGraph();
      await waitFor(() => {
        expect(
          rendered.getByText(/Could not calculate the graph layout/),
        ).toBeTruthy();
      });
      expect(error).toHaveBeenCalledWith(
        "graph layout calculation failed",
        expect.any(Error),
      );
      expect(error).not.toHaveBeenCalledWith(
        "graph layout chunk import failed",
        expect.anything(),
      );
    });
  });
});

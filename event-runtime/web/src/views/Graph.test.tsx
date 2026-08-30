import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";
import {
  createAgentsFixture,
  renderWithClient,
  restoreApi,
} from "../test-render";

const actualLayout = await import("../graph/layout");
mock.module("../graph/layout", () => {
  return {
    NODE_HEIGHT: 72,
    NODE_WIDTH: 220,
    layoutGraphIfIdentityChanged: () =>
      Promise.reject(new Error("stale graph layout chunk")),
  };
});

const { Graph } = await import("./Graph");

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
  window.location.hash = "";
  mock.module("../graph/layout", () => actualLayout);
});

describe("Graph layout loading", () => {
  test("renders the layout error instead of leaking a rejected dynamic layout", async () => {
    const error = mock(() => {});
    const originalError = console.error;
    const rejections: PromiseRejectionEvent[] = [];
    const onUnhandledRejection = (event: PromiseRejectionEvent) =>
      rejections.push(event);

    console.error = error;
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    try {
      const rendered = renderWithClient(
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

      await waitFor(() => {
        expect(
          rendered.getByText(/Could not calculate the graph layout/),
        ).toBeTruthy();
      });
      expect(error).toHaveBeenCalledWith(
        "graph layout calculation failed",
        expect.any(Error),
      );
      expect(rejections).toHaveLength(0);
    } finally {
      console.error = originalError;
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  });
});

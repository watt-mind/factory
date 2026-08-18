import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ChainListItem } from "../types";
import {
  changeInput,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import { Chains } from "./Chains";

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
});

const at = (minute: number) =>
  new Date(Date.UTC(2026, 7, 17, 12, minute)).toISOString();

function chain(
  overrides: Partial<ChainListItem> & Pick<ChainListItem, "correlationId">,
): ChainListItem {
  return {
    origin: {
      source: "github",
      eventId: `event-${overrides.correlationId}`,
      type: "pull_request.opened",
      subject: "factory",
      admittedAt: at(0),
    },
    eventCount: 2,
    runCount: 1,
    maxDepth: 1,
    states: { COMPLETED: 1 },
    lastActivityAt: at(10),
    repos: ["factory"],
    single: false,
    ...overrides,
  };
}

const rows = [
  chain({
    correlationId: "corr-active",
    states: { RUNNING: 1 },
    lastActivityAt: at(30),
  }),
  chain({
    correlationId: "corr-failed",
    origin: {
      source: "linear",
      eventId: "event-failed",
      type: "factory.work.requested",
      subject: "WM-537",
      admittedAt: at(5),
    },
    states: { FAILED: 1 },
    repos: ["other"],
    lastActivityAt: at(20),
  }),
  chain({
    correlationId: "single-root",
    origin: {
      source: "test",
      eventId: "event-single",
      type: "factory.single.requested",
      subject: null,
      admittedAt: at(15),
    },
    eventCount: 1,
    runCount: 0,
    maxDepth: 0,
    states: {},
    repos: ["factory"],
    single: true,
  }),
];

function renderChains(
  overrides: Partial<React.ComponentProps<typeof Chains>> = {},
) {
  return renderWithClient(
    <Chains
      context={{ kind: "all" }}
      initialStateFilter={null}
      onOpenChain={() => {}}
      {...overrides}
    />,
  );
}

describe("Chains list (WM-537)", () => {
  test("renders grouped summaries, hides single roots by default, and opens the trace", async () => {
    const onOpenChain = mock(() => {});
    await withApi({ chains: async () => ({ chains: rows }) }, async () => {
      const view = renderChains({ onOpenChain });
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeTruthy();
      });
      expect(
        view.container.querySelector('[data-chain-id="corr-failed"]'),
      ).toBeTruthy();
      expect(
        view.container.querySelector('[data-chain-id="single-root"]'),
      ).toBeNull();
      expect(
        view
          .getByRole("button", { name: "Single-event roots 1" })
          .getAttribute("aria-pressed"),
      ).toBe("false");
      expect(view.getByText("active")).toBeTruthy();
      expect(view.getByText("failed")).toBeTruthy();

      fireEvent.click(
        view.container.querySelector('[data-chain-id="corr-active"]')!,
      );
      expect(onOpenChain).toHaveBeenCalledWith("corr-active");

      fireEvent.click(
        view.getByRole("button", { name: "Single-event roots 1" }),
      );
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="single-root"]'),
        ).toBeTruthy();
      });
    });
  });

  test("supports state/is filters and repo operator context", async () => {
    await withApi({ chains: async () => ({ chains: rows }) }, async () => {
      const view = renderChains({ context: { kind: "repo", name: "factory" } });
      const input = view.getByLabelText("Filter chains") as HTMLInputElement;
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeTruthy();
      });
      expect(
        view.container.querySelector('[data-chain-id="corr-failed"]'),
      ).toBeNull();
      expect(view.getByText(/Scoped to/)).toBeTruthy();

      changeInput(input, "is:failed");
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeNull();
      });
      changeInput(input, "state:running");
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeTruthy();
      });
    });
  });

  test("syncs query-derived state changes and never opens a filtered-out selection", async () => {
    const onOpenChain = mock(() => {});
    await withApi({ chains: async () => ({ chains: rows }) }, async () => {
      const view = renderChains({ initialStateFilter: "running", onOpenChain });
      const input = view.getByLabelText("Filter chains") as HTMLInputElement;
      await waitFor(() => {
        expect(input.value).toBe("state:running");
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeTruthy();
      });

      fireEvent.keyDown(document.body, { key: "j" });
      expect(
        view.container
          .querySelector('[data-chain-id="corr-active"]')
          ?.getAttribute("aria-selected"),
      ).toBe("true");
      changeInput(input, "type:does-not-exist");
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeNull();
      });
      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(onOpenChain).not.toHaveBeenCalled();

      view.rerender(
        <Chains
          context={{ kind: "all" }}
          initialStateFilter="failed"
          onOpenChain={onOpenChain}
        />,
      );
      await waitFor(() => {
        expect(input.value).toBe("state:failed");
        expect(
          view.container.querySelector('[data-chain-id="corr-failed"]'),
        ).toBeTruthy();
      });
    });
  });

  test("renders compact single-line table with source icon and repo badges", async () => {
    await withApi({ chains: async () => ({ chains: rows }) }, async () => {
      const view = renderChains();
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeTruthy();
      });
      const activeRow = view.container.querySelector(
        '[data-chain-id="corr-active"]',
      )!;
      // Origin cell should have source icon and whitespace-nowrap
      const originCell = activeRow.querySelector("td")!;
      expect(originCell.className).toContain("whitespace-nowrap");
      expect(originCell.querySelector("svg")).toBeTruthy();

      // Repos cell should contain GitHub icon
      const reposCell = activeRow.querySelectorAll("td")[7];
      expect(reposCell.className).toContain("whitespace-nowrap");
      expect(reposCell.querySelector("svg")).toBeTruthy();
      expect(reposCell.textContent).toContain("factory");
    });
  });
});

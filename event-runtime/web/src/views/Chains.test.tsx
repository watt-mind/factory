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
import { shortId } from "../components/ui";
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

  test("focuses rows and opens a chain with Enter or Space", async () => {
    const onOpenChain = mock(() => {});
    await withApi({ chains: async () => ({ chains: rows }) }, async () => {
      const view = renderChains({ onOpenChain });
      const row = await waitFor(() => {
        const element = view.container.querySelector(
          '[data-chain-id="corr-active"]',
        ) as HTMLTableRowElement | null;
        if (!element) throw new Error("row not rendered");
        return element;
      });

      row.focus();
      expect(document.activeElement).toBe(row);
      fireEvent.keyDown(row, { key: "Enter" });
      fireEvent.keyDown(row, { key: " " });

      expect(onOpenChain).toHaveBeenCalledWith("corr-active");
      expect(onOpenChain).toHaveBeenCalledTimes(2);
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

  test("States is a proportional bar, not wrapping badges (WM-826)", async () => {
    const mixed = chain({
      correlationId: "corr-mixed",
      states: { FAILED: 1, COMPLETED: 2 },
      runCount: 3,
    });
    await withApi(
      { chains: async () => ({ chains: [...rows, mixed] }) },
      async () => {
        const view = renderChains();
        await waitFor(() => {
          expect(
            view.container.querySelector('[data-chain-id="corr-mixed"]'),
          ).toBeTruthy();
        });
        const row = view.container.querySelector(
          '[data-chain-id="corr-mixed"]',
        ) as HTMLElement;
        const bar = row.querySelector('[role="img"]');
        expect(bar).toBeTruthy();
        expect(bar?.getAttribute("aria-label")).toBe("COMPLETED 2, FAILED 1");
        expect(row.textContent).not.toMatch(/COMPLETED 2/);
        expect(row.textContent).not.toMatch(/FAILED 1/);
        expect(bar?.querySelectorAll("[data-state]")).toHaveLength(2);
        expect(
          (bar?.querySelector('[data-state="COMPLETED"]') as HTMLElement).style
            .flexGrow,
        ).toBe("2");
        expect(
          (bar?.querySelector('[data-state="FAILED"]') as HTMLElement).style
            .flexGrow,
        ).toBe("1");
        expect(
          view.container.querySelector('col[data-col="depth"]')?.className,
        ).toContain("w-12");
        expect(
          view.container.querySelector('col[data-col="events"]')?.className,
        ).toContain("w-12");
        expect(
          view.container.querySelector('col[data-col="runs"]')?.className,
        ).toContain("w-12");
      },
    );
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

      // Repos cell should contain GitHub icon (Root hidden by default, so index 6)
      const reposCell = activeRow.querySelectorAll("td")[6];
      expect(reposCell.className).toContain("whitespace-nowrap");
      expect(reposCell.querySelector("svg")).toBeTruthy();
      expect(reposCell.textContent).toContain("factory");
    });
  });

  test("hides the Root column by default and titles Depth as hops (WM-831)", async () => {
    await withApi({ chains: async () => ({ chains: rows }) }, async () => {
      const view = renderChains();
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-chain-id="corr-active"]'),
        ).toBeTruthy();
      });

      // Root event column is default-hidden: no header, no cell.
      const headers = Array.from(
        view.container.querySelectorAll("thead th"),
      ).map((th) => th.textContent ?? "");
      expect(headers.some((text) => text.includes("Root"))).toBe(false);
      expect(view.queryByText(shortId("event-corr-active"))).toBeNull();

      // Depth header abbreviates and explains the metric is hops in its title.
      const depthTitle = view.container.querySelector('[title*="hops"]');
      expect(depthTitle).toBeTruthy();
      expect(depthTitle?.textContent).toContain("Dep");

      // Cell values stay plain integers.
      const activeRow = view.container.querySelector(
        '[data-chain-id="corr-active"]',
      ) as HTMLElement;
      const depthCell = activeRow.querySelectorAll("td")[1];
      expect(depthCell.textContent).toBe("1");
    });
  });
});

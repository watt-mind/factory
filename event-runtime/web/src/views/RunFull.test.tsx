import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ApiError } from "../api";
import { RunFull } from "./RunFull";
import {
  createRunDetailFixture,
  createRunListItemFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { RunDetail } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
});

const noop = () => {};
const CANCEL_409 = "illegal transition CANCELLED → CANCELLED";

function renderRunFull(runId: string) {
  return renderWithClient(
    <RunFull
      runId={runId}
      connected={true}
      onBack={noop}
      onJumpAgent={noop}
      onJumpEvent={noop}
    />,
  );
}

describe("RunFull cancel dialog (WM-144)", () => {
  test("a simulated 409 on cancel shows a persistent inline message in the dialog", async () => {
    const runId = "run_cancel_race";
    const detail = createRunDetailFixture({ run: { runId, state: "RUNNING" } as RunDetail["run"] });
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({ runs: [createRunListItemFixture({ runId, state: "RUNNING" })] }),
        cancel: async () => {
          throw new ApiError(CANCEL_409, 409);
        },
      },
      async () => {
        const { getByRole, getByText } = renderRunFull(runId);

        await waitFor(() => getByText("Cancel"));
        fireEvent.click(getByText("Cancel"));

        const dialog = getByRole("dialog");
        expect(dialog.textContent).toContain(`Cancel ${runId}?`);
        expect(within(dialog).queryByText(CANCEL_409)).toBeNull();

        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));

        await waitFor(() => {
          expect(within(dialog).getByText(CANCEL_409)).toBeTruthy();
        });
        // Dialog stays open so the race is explained inline, not only as a toast.
        expect(getByRole("dialog")).toBeTruthy();
      },
    );
  });
});

describe("RunFull header copy verbs and hints (WM-218)", () => {
  test("renders trailing keyboard hints on ← Runs, Copy id, Copy CLI, Copy link", async () => {
    const runId = "run_header_hints";
    const detail = createRunDetailFixture({ run: { runId, state: "RUNNING" } as RunDetail["run"] });
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({ runs: [createRunListItemFixture({ runId, state: "RUNNING" })] }),
      },
      async () => {
        const { getByRole } = renderRunFull(runId);
        await waitFor(() => getByRole("button", { name: /← Runs/ }));

        expect(getByRole("button", { name: /← Runs/ }).textContent).toContain("Esc");
        expect(getByRole("button", { name: /Copy id/ }).textContent).toContain("c");
        expect(getByRole("button", { name: /Copy CLI/ }).textContent).toContain("c i");
        expect(getByRole("button", { name: /Copy link/ }).textContent).toContain("c l");
      },
    );
  });

  test("c copies run id; c i and c l chords copy CLI and link", async () => {
    const runId = "run_chords_test";
    const detail = createRunDetailFixture({ run: { runId, state: "RUNNING" } as RunDetail["run"] });

    let clipboardText = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          clipboardText = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });

    await withApi(
      {
        run: async () => detail,
        runs: async () => ({ runs: [createRunListItemFixture({ runId, state: "RUNNING" })] }),
      },
      async () => {
        const { getByRole } = renderRunFull(runId);
        await waitFor(() => getByRole("button", { name: /Copy id/ }));

        // Single 'c' copies run ID
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
        expect(clipboardText).toBe(runId);

        // 'c' then 'i' copies CLI command
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
        expect(clipboardText).toBe(`bun event-runtime/cli.mjs inspect ${runId}`);

        // 'c' then 'l' copies link
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
        expect(clipboardText).toContain(window.location.href);
      },
    );
  });
});

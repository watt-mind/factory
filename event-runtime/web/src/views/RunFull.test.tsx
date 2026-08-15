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

describe("RunFull model rows (WM-221)", () => {
  test("the full page's sidebar answers which model the run used, pinned and observed", async () => {
    const runId = "run_model_full";
    const detail = createRunDetailFixture({
      run: {
        runId,
        state: "COMPLETED",
        spec: { adapter: "claude", modelTier: "strong", model: "default" },
      } as RunDetail["run"],
      observedModel: "claude-opus-5[1m]",
    });
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({ runs: [createRunListItemFixture({ runId, state: "COMPLETED" })] }),
      },
      async () => {
        const { getByText } = renderRunFull(runId);
        await waitFor(() => getByText("model (observed)"));
        // The header already names the adapter; the sidebar now names the model.
        expect(getByText("model tier")).toBeTruthy();
        expect(getByText("strong")).toBeTruthy();
        expect(getByText("default (CLI)")).toBeTruthy();
        expect(getByText("claude-opus-5[1m]")).toBeTruthy();
      },
    );
  });
});

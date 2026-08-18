import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ApiError } from "../api";
import { RunFull } from "./RunFull";
import {
  changeInput,
  createEventFixture,
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
  sessionStorage.clear();
});

const noop = () => {};
const CANCEL_409 = "illegal transition CANCELLED → CANCELLED";

function renderRunFull(runId: string, connected = true) {
  return renderWithClient(
    <RunFull
      runId={runId}
      connected={connected}
      onBack={noop}
      onJumpAgent={noop}
      onJumpEvent={noop}
    />,
  );
}

describe("RunFull layout (WM-194)", () => {
  test("centers the capped trace container on wide viewports", async () => {
    const runId = "run_centered_trace";
    const detail = createRunDetailFixture({
      run: { runId, state: "COMPLETED" } as RunDetail["run"],
    });
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "COMPLETED" })],
        }),
      },
      async () => {
        const { container } = renderRunFull(runId);

        await waitFor(() => {
          const traceContainer = container.querySelector("main > div");
          expect(traceContainer).toBeTruthy();
          expect(traceContainer!.classList.contains("xl:mx-auto")).toBe(true);
          expect(traceContainer!.classList.contains("xl:max-w-[900px]")).toBe(
            true,
          );
          expect(traceContainer!.classList.contains("p-6")).toBe(true);
        });
      },
    );
  });
});

describe("RunFull header (WM-193)", () => {
  test("keeps run identity and actions without duplicating sidebar metadata", async () => {
    const runId = "run_clean_header";
    const detail = createRunDetailFixture({
      run: {
        runId,
        state: "RUNNING",
        attempts: 2,
        spec: {
          agent: "header-agent@1",
          adapter: "header-adapter",
          maxAttempts: 5,
        },
      } as RunDetail["run"],
    });

    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING" })],
        }),
      },
      async () => {
        const { container, getByRole } = renderRunFull(runId);

        await waitFor(() => {
          expect(container.querySelector("aside")?.textContent).toContain(
            "header-agent@1",
          );
        });

        const header = container.querySelector("header");
        expect(header?.textContent).toContain("← Runs");
        expect(header?.textContent).toContain(runId);
        expect(header?.textContent).toContain("RUNNING");
        expect(getByRole("button", { name: /Open in tab/ })).toBeTruthy();
        expect(getByRole("button", { name: /Cancel/ })).toBeTruthy();
        expect(header?.textContent).not.toContain("header-agent@1");
        expect(header?.textContent).not.toContain("header-adapter");
        expect(header?.textContent).not.toContain("2/5 attempts");

        const sidebar = container.querySelector("aside");
        expect(sidebar?.textContent).toContain("header-agent@1");
        expect(sidebar?.textContent).toContain("header-adapter");
        expect(sidebar?.textContent).toContain("2/5");
      },
    );
  });
});

describe("RunFull deadline extension (WM-566)", () => {
  test("shows remaining time and extends by preset or custom increments", async () => {
    const runId = "run_extend_controls";
    const deadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });
    detail.deadlineAt = deadlineAt;
    const calls: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push(body.seconds);
      return new Response(JSON.stringify({
        extended: true,
        runId,
        seconds: body.seconds,
        deadlineAt: new Date(Date.parse(deadlineAt) + body.seconds * 1000).toISOString(),
        leaseExpiresAt: new Date(Date.parse(deadlineAt) + (body.seconds + 120) * 1000).toISOString(),
        override: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING", deadlineAt })],
        }),
      },
      async () => {
        const { getByRole, getByText, getByLabelText } = renderRunFull(runId);
        await waitFor(() => getByText(/Remaining/));
        expect(getByText(/Remaining/).textContent).toContain("30m");

        fireEvent.click(getByRole("button", { name: "+15m" }));
        await waitFor(() => expect(calls).toEqual([900]));
        expect(getByText(/Run extended by 15 minutes/)).toBeTruthy();

        fireEvent.click(getByRole("button", { name: "Custom…" }));
        const input = getByLabelText("Extension minutes");
        changeInput(input as HTMLInputElement, "0");
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(getByText("Enter a whole number from 1 to 60.")).toBeTruthy();
        expect(within(getByRole("dialog")).getByRole("button", { name: "Extend run" }).hasAttribute("disabled")).toBe(true);
        changeInput(input as HTMLInputElement, "20");
        expect(input.getAttribute("aria-invalid")).toBe("false");
        fireEvent.click(within(getByRole("dialog")).getByRole("button", { name: "Extend run" }));
        await waitFor(() => expect(calls).toEqual([900, 1200]));
      },
    );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preset refusal is visible without opening the custom dialog", async () => {
    const runId = "run_extend_refused";
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });
    detail.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: "deadline_already_expired",
      extended: false,
      refusal: { code: "deadline_already_expired", retryable: false },
    }), { status: 409, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      await withApi(
        {
          run: async () => detail,
          runs: async () => ({
            runs: [createRunListItemFixture({ runId, state: "RUNNING", deadlineAt: detail.deadlineAt })],
          }),
        },
        async () => {
          const { getByRole, getByText, queryByRole } = renderRunFull(runId);
          await waitFor(() => getByRole("button", { name: "+30m" }));
          fireEvent.click(getByRole("button", { name: "+30m" }));
          await waitFor(() => getByText("deadline_already_expired"));
          expect(queryByRole("dialog")).toBeNull();
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("custom extension submit is disabled while disconnected", async () => {
    const runId = "run_extend_disconnected";
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });
    detail.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING", deadlineAt: detail.deadlineAt })],
        }),
      },
      async () => {
        const { getByRole } = renderRunFull(runId, false);
        const custom = await waitFor(() => getByRole("button", { name: "Custom…" }));
        expect(custom.hasAttribute("disabled")).toBe(false);
        fireEvent.click(custom);
        expect(within(getByRole("dialog")).getByRole("button", { name: "Extend run" }).hasAttribute("disabled")).toBe(true);
      },
    );
  });
});

describe("RunFull cancel dialog (WM-144)", () => {
  test("a simulated 409 on cancel shows a persistent inline message in the dialog", async () => {
    const runId = "run_cancel_race";
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING" })],
        }),
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

        fireEvent.click(
          within(dialog).getByRole("button", { name: "Cancel run" }),
        );

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
  test("p toggles the run in the context strip and Open in tab shows its hint", async () => {
    const runId = "run_full_pin_shortcut";
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });

    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING" })],
        }),
      },
      async () => {
        const { getByRole } = renderRunFull(runId);
        const openInTab = await waitFor(() => getByRole("button", { name: /Open in tab/ }));
        expect(openInTab.querySelector('[aria-hidden="true"]')?.textContent).toBe("p");

        fireEvent.keyDown(document.body, { key: "p" });
        expect(JSON.parse(sessionStorage.getItem("factory.pinnedRuns") ?? "[]")).toEqual([runId]);

        fireEvent.keyDown(document.body, { key: "p" });
        expect(JSON.parse(sessionStorage.getItem("factory.pinnedRuns") ?? "[]")).toEqual([]);
      },
    );
  });

  test("renders shortcut tooltips on the back and copy icon actions", async () => {
    const runId = "run_header_hints";
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });
    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING" })],
        }),
      },
      async () => {
        const { getByRole } = renderRunFull(runId);
        await waitFor(() => getByRole("button", { name: /← Runs/ }));

        expect(getByRole("button", { name: /← Runs/ }).textContent).toContain(
          "Esc",
        );
        expect(getByRole("button", { name: "Copy run id (c)" }).getAttribute("title")).toBe(
          "Copy run id · c",
        );
        expect(getByRole("button", { name: "Copy CLI inspect command (c i)" }).getAttribute("title")).toBe(
          "Copy CLI inspect command · c i",
        );
        expect(getByRole("button", { name: "Copy link (c l)" }).getAttribute("title")).toBe(
          "Copy link · c l",
        );
      },
    );
  });

  test("c copies run id; c i and c l chords copy CLI and link", async () => {
    const runId = "run_chords_test";
    const detail = createRunDetailFixture({
      run: { runId, state: "RUNNING" } as RunDetail["run"],
    });

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
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "RUNNING" })],
        }),
      },
      async () => {
        const { getByRole } = renderRunFull(runId);
        await waitFor(() => getByRole("button", { name: "Copy run id (c)" }));

        // Single 'c' copies run ID
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", bubbles: true }),
        );
        expect(clipboardText).toBe(runId);

        // 'c' then 'i' copies CLI command
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", bubbles: true }),
        );
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "i", bubbles: true }),
        );
        expect(clipboardText).toBe(
          `bun event-runtime/cli.mjs inspect ${runId}`,
        );

        // 'c' then 'l' copies link
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", bubbles: true }),
        );
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "l", bubbles: true }),
        );
        expect(clipboardText).toContain(window.location.href);
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
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "COMPLETED" })],
        }),
      },
      async () => {
        const { getByText } = renderRunFull(runId);
        await waitFor(() => getByText("model (observed)"));
        // The sidebar keeps the harness and model details together.
        expect(getByText("model tier")).toBeTruthy();
        expect(getByText("strong")).toBeTruthy();
        expect(getByText("default (CLI)")).toBeTruthy();
        expect(getByText("claude-opus-5[1m]")).toBeTruthy();
      },
    );
  });
});

describe("RunFull causal follow-up events and chained runs (WM-420)", () => {
  test("renders empty-state copy when no follow-up event was emitted", async () => {
    const runId = "run_no_follow_ups";
    const detail = createRunDetailFixture({
      run: {
        runId,
        state: "COMPLETED",
        spec: { agent: "merge-scan@1", adapter: "pi" },
      } as RunDetail["run"],
    });

    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [createRunListItemFixture({ runId, state: "COMPLETED" })],
        }),
        events: async () => ({
          events: [
            createEventFixture({
              eventId: "unrelated-event-1",
              causationId: "run_other",
            }),
          ],
        }),
      },
      async () => {
        const { getByText } = renderRunFull(runId);
        await waitFor(() => getByText("Follow-up Events"));
        expect(getByText("No follow-up event was emitted.")).toBeTruthy();
      },
    );
  });

  test("renders exact merge-scan → merge-escalate → merge-notify causal chain fixture", async () => {
    const parentRunId = "run_74681439-530c-4301-bd9c-baa17d8b92d5";
    const childRunId = "run_a07fde5a-ee51-46ae-9945-3b38cd87e180";
    const eventId = "chain-run_74681439-530c-4301-bd9c-baa17d8b92d5";
    const proposalId = "prop_escalate_7468";

    const detail = createRunDetailFixture({
      run: {
        runId: parentRunId,
        state: "COMPLETED",
        spec: { agent: "merge-scan@1", adapter: "pi" },
      } as RunDetail["run"],
    });

    const emittedEvent = createEventFixture({
      source: "factory.chain",
      eventId,
      type: "factory.merge-escalate.requested",
      subject: "merge-scan@1",
      status: "planned",
      causationId: parentRunId,
      proposalId,
      runId: childRunId,
      envelope: { causationId: parentRunId },
    });

    const childRun = createRunListItemFixture({
      runId: childRunId,
      agent: "merge-notify@1",
      state: "COMPLETED",
      adapter: "pi",
    });

    let jumpedAgent = "";
    let jumpedEvent = "";

    await withApi(
      {
        run: async () => detail,
        runs: async () => ({
          runs: [
            createRunListItemFixture({ runId: parentRunId, state: "COMPLETED" }),
            childRun,
          ],
        }),
        events: async () => ({
          events: [emittedEvent],
        }),
      },
      async () => {
        const { getByText, getAllByText, getByTitle } = renderWithClient(
          <RunFull
            runId={parentRunId}
            connected={true}
            onBack={noop}
            onJumpAgent={(ref) => {
              jumpedAgent = ref;
            }}
            onJumpEvent={(source, id) => {
              jumpedEvent = `${source}:${id}`;
            }}
          />,
        );

        await waitFor(() => getByText("Follow-up Events"));
        // Event type and planning status
        expect(getByText("factory.merge-escalate.requested")).toBeTruthy();
        expect(getByText("planned")).toBeTruthy();

        // Linked proposal
        expect(getByTitle(proposalId)).toBeTruthy();

        // Follow-up Run agent, state badge, and run link
        expect(getByText("Follow-up Run")).toBeTruthy();
        expect(getAllByText("COMPLETED").length).toBeGreaterThanOrEqual(1);
        expect(getByText("merge-notify@1")).toBeTruthy();

        const runLink = getByTitle(`Open run ${childRunId}`);
        expect(runLink).toBeTruthy();
        expect(runLink.getAttribute("href")).toContain(childRunId);

        // Clicking agent jumps to agent
        fireEvent.click(getByText("merge-notify@1"));
        expect(jumpedAgent).toBe("merge-notify@1");

        // Clicking event jumps to event
        fireEvent.click(getByTitle(eventId));
        expect(jumpedEvent).toBe(`factory.chain:${eventId}`);
      },
    );
  });
});

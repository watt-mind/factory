import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Runs, statesForRunTab } from "./Runs";
import {
  changeInput,
  createAgentsFixture,
  createLifecycleEventFixture,
  createProposalFixture,
  createRunSpecFixture,
  createRunDetailFixture,
  createRunListItemFixture,
  createStatusFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { LifecycleEvent, RunDetail, RunListItem, RunState } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
});

const noop = () => {};
const FAILURE_REASON = 'contract_violation: $: unknown property "captured"';
const NOW = new Date().toISOString();

function stubListItem(runId: string, state: RunState, overrides?: Partial<RunListItem>): RunListItem {
  return createRunListItemFixture({
    runId,
    state,
    attempts: 1,
    maxAttempts: 3,
    agent: "triage-scan",
    adapter: "claude-code",
    reasonCode: state === "FAILED" ? "contract_violation" : null,
    eventId: null,
    eventSource: null,
    created_at: NOW,
    updated_at: NOW,
    repos: [],
    ...overrides,
  });
}

function stubDetail(runId: string, state: RunState, lifecycle: LifecycleEvent[], overrides?: Partial<RunDetail>): RunDetail {
  return createRunDetailFixture({
    run: {
      runId,
      state,
      attempts: 1,
      idempotencyKey: "idem-1",
      specHash: "hash-1",
      created_at: NOW,
      updated_at: NOW,
      spec: {
        schemaVersion: "1",
        runId,
        agent: "triage-scan",
        input: {},
        inputHash: "in-1",
        workspace: { type: "ephemeral" },
        adapter: "claude-code",
        promptVersion: "1",
        policyVersion: "1",
        outputContract: "triage/v1",
        capabilities: [],
        timeoutSeconds: 600,
        maxAttempts: 3,
        idempotencyKey: "idem-1",
      },
    },
    lifecycle,
    ...overrides,
  });
}

function transition(seq: number, runId: string, from: string | null, to: string, reason: string | null): LifecycleEvent {
  return createLifecycleEventFixture(seq, runId, from, to, reason, NOW);
}

function renderRuns(props: Partial<Parameters<typeof Runs>[0]> = {}) {
  return renderWithClient(
    <Runs
      connected={true}
      context={{ kind: "all" }}
      focusRunId={null}
      onSelectRun={noop}
      onOpenFull={noop}
      focusState={null}
      onFocusStateConsumed={noop}
      onJumpAgent={noop}
      onJumpEvent={noop}
      {...props}
    />,
  );
}

describe("Runs sortable columns (OPS-492)", () => {
  test("every data header cycles ascending, descending, and default order with accessible state", async () => {
    const onSelectRun = mock(() => {});
    const later = stubListItem("run_zulu", "RUNNING", {
      agent: "z-agent",
      adapter: "pi",
      attempts: 2,
      reasonCode: "z-reason",
      eventId: "event_zulu",
      eventSource: "github",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    const earlier = stubListItem("run_alpha", "FAILED", {
      agent: "a-agent",
      adapter: "claude",
      attempts: 1,
      reasonCode: "a-reason",
      eventId: "event_alpha",
      eventSource: "linear",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    await withApi(
      {
        runs: async () => ({ runs: [later, earlier] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns({ onSelectRun });
        await waitFor(() => r.getByRole("columnheader", { name: /Run/ }));

        for (const label of ["Run", "State", "Agent", "Adapter", "Model", "Attempts", "Reason", "Origin", "Updated"]) {
          const header = r.getByRole("columnheader", { name: new RegExp(label) });
          expect(header.getAttribute("aria-sort")).toBe("none");
          expect(header.querySelector("button")).toBeTruthy();
        }

        const runHeader = r.getByRole("columnheader", { name: /Run/ });
        fireEvent.click(r.getByRole("button", { name: /Run/ }));
        expect(runHeader.getAttribute("aria-sort")).toBe("ascending");
        expect(Array.from(r.container.querySelectorAll("tbody tr td:first-child")).map((cell) => cell.textContent)).toEqual([
          "run_alpha",
          "run_zulu",
        ]);

        act(() => {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        });
        expect(onSelectRun).toHaveBeenLastCalledWith("run_alpha");

        fireEvent.click(r.getByRole("button", { name: /Run/ }));
        expect(runHeader.getAttribute("aria-sort")).toBe("descending");
        fireEvent.click(r.getByRole("button", { name: /Run/ }));
        expect(runHeader.getAttribute("aria-sort")).toBe("none");
      },
    );
  });
});

describe("Runs table short run ids (WM-96)", () => {
  test("run id cell displays the short form and carries the full id as title", async () => {
    const runId = "run_ec9c87f9-4c1d-4f4a-9d7e-2c2f3a1b0c9d";
    const detail = stubDetail(runId, "COMPLETED", [transition(1, runId, null, "QUEUED", null)]);
    await withApi(
      {
        runs: async () => ({ runs: [stubListItem(runId, "COMPLETED")] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
        trace: async () => ({ head: 0, entries: [] }),
      },
      async () => {
        const { container } = renderRuns({ focusRunId: runId });

        const cell = await waitFor(() => {
          const el = container.querySelector(`td[title="${runId}"]`);
          if (!el) throw new Error("run id cell with full-id title is missing");
          return el;
        });
        // Short form shown; the full id never rendered as text, only as title.
        expect(cell.textContent).toBe("run_ec9c87f9");
      },
    );
  });
});

describe("Runs detail failure banner (WM-93)", () => {
  test("FAILED run renders the terminal transition's reason as a banner with a copy affordance", async () => {
    const runId = "run_failed_1";
    const detail = stubDetail(runId, "FAILED", [
      transition(1, runId, null, "QUEUED", null),
      transition(2, runId, "QUEUED", "LEASED", null),
      transition(3, runId, "LEASED", "RUNNING", null),
      transition(4, runId, "RUNNING", "FAILED", FAILURE_REASON),
    ]);
    await withApi(
      {
        runs: async () => ({ runs: [stubListItem(runId, "FAILED")] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
        trace: async () => ({ head: 0, entries: [] }),
      },
      async () => {
        const { getByRole, getByText } = renderRuns({ focusRunId: runId });

        await waitFor(() => getByRole("alert"));

        const banner = getByRole("alert");
        // The full, untruncated reason string, plus the copy affordance.
        expect(banner.textContent).toContain(FAILURE_REASON);
        expect(getByText("Copy reason")).toBeTruthy();

        // Before the metadata rows: the banner precedes the "Run" section in the document.
        const runSection = getByText("idempotencyKey");
        expect(banner.compareDocumentPosition(runSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      },
    );
  });

  test("COMPLETED run renders no banner", async () => {
    const runId = "run_ok_1";
    const detail = stubDetail(runId, "COMPLETED", [
      transition(1, runId, null, "QUEUED", null),
      transition(2, runId, "QUEUED", "LEASED", null),
      transition(3, runId, "LEASED", "RUNNING", null),
      transition(4, runId, "RUNNING", "COMPLETED", "ok"),
    ]);
    await withApi(
      {
        runs: async () => ({ runs: [stubListItem(runId, "COMPLETED")] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
        trace: async () => ({ head: 0, entries: [] }),
      },
      async () => {
        const { getByText, queryByRole } = renderRuns({ focusRunId: runId });

        // Wait for the detail panel to load, then assert no banner appeared.
        await waitFor(() => getByText("idempotencyKey"));
        expect(queryByRole("alert")).toBeNull();
      },
    );
  });
});

describe("Runs component harness: selection & filter retention", () => {
  test("p toggles the selected run in the context strip and the detail action shows its hint", async () => {
    const runId = "run_pin_shortcut";
    sessionStorage.clear();

    await withApi(
      {
        runs: async () => ({ runs: [stubListItem(runId, "RUNNING")] }),
        run: async () => stubDetail(runId, "RUNNING", []),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByRole } = renderRuns({ focusRunId: runId });
        const openInTab = await waitFor(() => getByRole("button", { name: /Open in tab/ }));
        expect(openInTab.querySelector('[aria-hidden="true"]')?.textContent).toBe("p");

        fireEvent.keyDown(document.body, { key: "p" });
        expect(JSON.parse(sessionStorage.getItem("factory.pinnedRuns") ?? "[]")).toEqual([runId]);

        fireEvent.keyDown(document.body, { key: "p" });
        expect(JSON.parse(sessionStorage.getItem("factory.pinnedRuns") ?? "[]")).toEqual([]);
      },
    );
  });

  test("clicking a row selects the run via onSelectRun", async () => {
    const onSelectRun = mock(() => {});
    const r1 = stubListItem("run_click_test", "RUNNING");
    await withApi(
      {
        runs: async () => ({ runs: [r1] }),
        run: async () => stubDetail("run_click_test", "RUNNING", []),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { container } = renderRuns({ onSelectRun });
        const cell = await waitFor(() => {
          const el = container.querySelector(`td[title="${r1.runId}"]`);
          if (!el) throw new Error("row not rendered");
          return el;
        });

        const row = cell.closest("tr");
        expect(row).toBeTruthy();
        fireEvent.click(row!);

        expect(onSelectRun).toHaveBeenCalledWith("run_click_test");
      },
    );
  });

  test("focusRunId highlights the selected row and renders the detail pane", async () => {
    const r1 = stubListItem("run_selected_1", "RUNNING");
    const detail = stubDetail("run_selected_1", "RUNNING", [transition(1, "run_selected_1", null, "RUNNING", null)]);
    await withApi(
      {
        runs: async () => ({ runs: [r1] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
      },
      async () => {
        const { container, getByText } = renderRuns({ focusRunId: "run_selected_1" });

        const selectedRow = await waitFor(() => {
          const el = container.querySelector("tr.row-selected");
          if (!el) throw new Error("selected row not highlighted");
          return el;
        });
        expect(selectedRow).toBeTruthy();
        await waitFor(() => getByText("idempotencyKey"));
      },
    );
  });

  test("typing in filter input restricts visible rows and retains matching selection", async () => {
    const r1 = stubListItem("run_alpha", "RUNNING", { agent: "triage-scan" });
    const r2 = stubListItem("run_beta", "RUNNING", { agent: "review-scan" });
    const detail = stubDetail("run_alpha", "RUNNING", []);

    await withApi(
      {
        runs: async () => ({ runs: [r1, r2] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
      },
      async () => {
        const { container, getByLabelText } = renderRuns({ focusRunId: "run_alpha" });

        await waitFor(() => container.querySelector(`td[title="${r1.runId}"]`));
        expect(container.querySelector(`td[title="${r2.runId}"]`)).toBeTruthy();

        const filterInput = getByLabelText("Filter runs") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector(`td[title="${r1.runId}"]`)).toBeTruthy();
          expect(container.querySelector(`td[title="${r2.runId}"]`)).toBeNull();
        });

        // The selected row remains selected
        const selectedRow = container.querySelector("tr.row-selected");
        expect(selectedRow).toBeTruthy();
        expect(selectedRow?.querySelector(`td[title="${r1.runId}"]`)).toBeTruthy();
      },
    );
  });

  test("switching status tabs clears row selection via onSelectRun(null)", async () => {
    const onSelectRun = mock(() => {});
    const r1 = stubListItem("run_tab_1", "RUNNING");
    await withApi(
      {
        runs: async () => ({ runs: [r1] }),
        run: async () => stubDetail("run_tab_1", "RUNNING", []),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByRole, container } = renderRuns({ focusRunId: "run_tab_1", onSelectRun });

        await waitFor(() => container.querySelector("tr.row-selected"));

        const failedTab = getByRole("tab", { name: /^FAILED/i });
        fireEvent.click(failedTab);

        expect(onSelectRun).toHaveBeenCalledWith(null);
      },
    );
  });
});

describe("Runs component harness: cross-tab reveal", () => {
  test("switches tab to ALL when focusRunId points to a run on a different state tab", async () => {
    const rRunning = stubListItem("run_running_1", "RUNNING");
    const rFailed = stubListItem("run_failed_target", "FAILED");
    const allRuns = [rRunning, rFailed];
    const detailFailed = stubDetail("run_failed_target", "FAILED", [
      transition(1, "run_failed_target", "RUNNING", "FAILED", "some error"),
    ]);

    await withApi(
      {
        runs: async (state?: string) => ({
          runs: state && state !== "ALL" ? allRuns.filter((r) => r.state === state) : allRuns,
        }),
        run: async () => detailFailed,
        status: async () => createStatusFixture(),
      },
      async () => {
        const onFocusStateConsumed = mock(() => {});
        // Start on RUNNING tab via focusState
        const { getByRole, container, rerender } = renderRuns({
          focusState: "RUNNING",
          onFocusStateConsumed,
        });

        await waitFor(() => {
          const tab = getByRole("tab", { name: /^Active/i });
          expect(tab.getAttribute("aria-selected")).toBe("true");
        });

        // Now focus the FAILED run
        rerender(
          <Runs
            connected={true}
            context={{ kind: "all" }}
            focusRunId="run_failed_target"
            onSelectRun={noop}
            onOpenFull={noop}
            focusState={null}
            onFocusStateConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Should switch to ALL tab and reveal the FAILED run
        await waitFor(() => {
          const allTab = getByRole("tab", { name: /^All/i });
          expect(allTab.getAttribute("aria-selected")).toBe("true");
          const targetCell = container.querySelector(`td[title="run_failed_target"]`);
          expect(targetCell).toBeTruthy();
        });
      },
    );
  });

  test("clears active text filter when focusRunId is hidden by the filter", async () => {
    const r1 = stubListItem("run_alpha", "RUNNING", { agent: "triage-scan" });
    const r2 = stubListItem("run_beta", "RUNNING", { agent: "deploy-scan" });

    await withApi(
      {
        runs: async () => ({ runs: [r1, r2] }),
        run: async () => stubDetail("run_beta", "RUNNING", []),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderRuns({});

        await waitFor(() => container.querySelector(`td[title="${r1.runId}"]`));

        // Filter for alpha, hiding beta
        const filterInput = getByLabelText("Filter runs") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector(`td[title="${r2.runId}"]`)).toBeNull();
        });

        // Focus beta (which was hidden by the filter)
        rerender(
          <Runs
            connected={true}
            context={{ kind: "all" }}
            focusRunId="run_beta"
            onSelectRun={noop}
            onOpenFull={noop}
            focusState={null}
            onFocusStateConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Filter should be cleared to reveal run_beta
        await waitFor(() => {
          const input = getByLabelText("Filter runs") as HTMLInputElement;
          expect(input.value).toBe("");
          expect(container.querySelector(`td[title="run_beta"]`)).toBeTruthy();
        });
      },
    );
  });

  test("retains active text filter when focusRunId is already visible under that filter", async () => {
    const r1 = stubListItem("run_alpha", "RUNNING", { agent: "triage-scan" });
    const r2 = stubListItem("run_beta", "RUNNING", { agent: "triage-scan" });

    await withApi(
      {
        runs: async () => ({ runs: [r1, r2] }),
        run: async () => stubDetail("run_alpha", "RUNNING", []),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderRuns({});

        await waitFor(() => container.querySelector(`td[title="${r1.runId}"]`));

        const filterInput = getByLabelText("Filter runs") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector(`td[title="${r1.runId}"]`)).toBeTruthy();
        });

        // Now focus run_alpha (which is already visible)
        rerender(
          <Runs
            connected={true}
            context={{ kind: "all" }}
            focusRunId="run_alpha"
            onSelectRun={noop}
            onOpenFull={noop}
            focusState={null}
            onFocusStateConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Filter is retained
        await waitFor(() => {
          const input = getByLabelText("Filter runs") as HTMLInputElement;
          expect(input.value).toBe("agent:triage-scan");
          expect(container.querySelector(`td[title="run_alpha"]`)).toBeTruthy();
        });
      },
    );
  });

  test("focusState prop sets the active tab and calls onFocusStateConsumed", async () => {
    const onFocusStateConsumed = mock(() => {});
    await withApi(
      {
        runs: async () => ({ runs: [] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByRole } = renderRuns({
          focusState: "CANCELLED",
          onFocusStateConsumed,
        });

        await waitFor(() => {
          const tab = getByRole("tab", { name: /^Cancelled/i });
          expect(tab.getAttribute("aria-selected")).toBe("true");
          expect(onFocusStateConsumed).toHaveBeenCalledTimes(1);
        });
      },
    );
  });
});

describe("Runs Model column (WM-221)", () => {
  test("renders the pinned model per row, with the sentinel and n/a spelled out", async () => {
    const modelRows = [
      stubListItem("run_pinned", "COMPLETED", { adapter: "claude", modelTier: "standard", model: "sonnet" }),
      stubListItem("run_sentinel", "COMPLETED", { adapter: "claude", modelTier: "strong", model: "default" }),
      stubListItem("run_command", "COMPLETED", { adapter: "command", modelTier: null, model: null }),
    ];
    await withApi(
      {
        runs: async () => ({ runs: modelRows }),
        run: async () => stubDetail("run_pinned", "COMPLETED", []),
        status: async () => createStatusFixture(),
        trace: async () => ({ head: 0, entries: [] }),
      },
      async () => {
        const { findByText, getByText } = renderRuns();
        // The column is offered like every other one, and on by default —
        // same call as the Agents view's Model column (WM-211).
        expect(await findByText("sonnet")).toBeTruthy();
        expect(getByText("default (CLI)")).toBeTruthy();
        expect(getByText("n/a")).toBeTruthy();
      },
    );
  });

  test("the column can be hidden through Display Options like any other", async () => {
    localStorage.setItem("evrt-display-runs", JSON.stringify({ hiddenColumns: ["model"] }));
    const modelRows = [stubListItem("run_pinned", "COMPLETED", { adapter: "claude", model: "sonnet" })];
    await withApi(
      {
        runs: async () => ({ runs: modelRows }),
        run: async () => stubDetail("run_pinned", "COMPLETED", []),
        status: async () => createStatusFixture(),
        trace: async () => ({ head: 0, entries: [] }),
      },
      async () => {
        const { findByText, queryByText } = renderRuns();
        await findByText("run_pinned");
        expect(queryByText("sonnet")).toBeNull();
      },
    );
  });
});

describe("Runs copy chords and hints (WM-233)", () => {
  test("copy chords: c (id), c l (link), c i / c c (CLI inspect command) and utility hints", async () => {
    let written = "";
    const mockClipboard = {
      writeText: (t: string) => {
        written = t;
        return Promise.resolve();
      },
    };
    Object.defineProperty(window.navigator, "clipboard", {
      value: mockClipboard,
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: mockClipboard,
      configurable: true,
    });

    const runId = "run_12345678-abcd-ef01-2345-6789abcdef01";
    const rows = [stubListItem(runId, "RUNNING")];

    await withApi(
      {
        runs: async () => ({ runs: rows }),
        run: async () => stubDetail(runId, "RUNNING", []),
        status: async () => createStatusFixture(),
        trace: async () => ({ head: 0, entries: [] }),
      },
      async () => {
        const r = renderRuns({ focusRunId: runId });
        const idBtn = await r.findByRole("button", { name: "Copy run id (c)" });

        // Verify icon-action tooltips preserve shortcut discoverability.
        expect(idBtn.getAttribute("title")).toBe("Copy run id · c");
        const cliBtn = r.getByRole("button", { name: "Copy CLI inspect command (c i)" });
        expect(cliBtn.getAttribute("title")).toBe("Copy CLI inspect command · c i");
        const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
        expect(linkBtn.getAttribute("title")).toBe("Copy link · c l");

        // 1. Press 'c' -> copies runId
        fireEvent.keyDown(document.body, { key: "c" });
        expect(written).toBe(runId);

        // 2. Press 'l' immediately after 'c' -> 'c l' copies link
        fireEvent.keyDown(document.body, { key: "l" });
        expect(written).toBe(window.location.href);

        // 3. Press 'c' then 'i' within 800ms -> copies CLI inspect command
        fireEvent.keyDown(document.body, { key: "c" });
        fireEvent.keyDown(document.body, { key: "i" });
        expect(written).toBe(`bun event-runtime/cli.mjs inspect ${runId}`);

        // 4. Press 'c' then 'c' within 800ms -> copies CLI inspect command
        fireEvent.keyDown(document.body, { key: "c" });
        fireEvent.keyDown(document.body, { key: "c" });
        expect(written).toBe(`bun event-runtime/cli.mjs inspect ${runId}`);
      },
    );
  });

  test("statesForRunTab maps multi-state and single-state tabs to their full run state sets (WM-327)", () => {
    expect(statesForRunTab("ALL")).toEqual([
      "PROPOSED",
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
      "REFUSED",
      "FAILED",
      "TIMED_OUT",
      "CANCELLED",
    ]);
    expect(statesForRunTab("ACTIVE")).toEqual([
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
    ]);
    expect(statesForRunTab("FAILED")).toEqual([
      "FAILED",
      "TIMED_OUT",
      "REFUSED",
    ]);
    expect(statesForRunTab("COMPLETED")).toEqual(["COMPLETED"]);
    expect(statesForRunTab("CANCELLED")).toEqual(["CANCELLED"]);
  });

  test("PROPOSED run shows proposal jump link in table and open & approve actions in detail pane", async () => {
    const onJumpProposal = mock(() => {});
    const onSelectRun = mock(() => {});
    const runId = "run-proposed-1";
    const propId = "prop-1234567890abcdef";

    const proposedRow = stubListItem(runId, "PROPOSED");
    const proposal = createProposalFixture({
      id: propId,
      runId,
      status: "open",
      decision: "run",
    });

    const approveMock = mock(async (_id: string) => ({
      approved: true as const,
      runId,
    }));

    await withApi(
      {
        runs: mock(async () => ({ runs: [proposedRow] })),
        run: mock(async () => stubDetail(runId, "PROPOSED", [])),
        proposals: mock(async () => ({ proposals: [proposal] })),
        approve: approveMock,
        status: mock(async () =>
          createStatusFixture({
            runs: { byState: { PROPOSED: 1 } },
          }),
        ),
      },
      async () => {
        const r = renderRuns({
          focusRunId: runId,
          onJumpProposal,
          onSelectRun,
        });

        // Verify "proposal" link is present in the table row and clickable
        await waitFor(() => {
          expect(r.getByTitle(`Open proposal ${propId}`)).toBeTruthy();
        });

        fireEvent.click(r.getByTitle(`Open proposal ${propId}`));
        expect(onJumpProposal).toHaveBeenCalledWith(propId);

        // Verify detail pane shows "Awaiting Proposal Approval" section and "Approve…" button
        await waitFor(() => {
          expect(r.getByText("Awaiting Proposal Approval")).toBeTruthy();
          expect(r.getAllByRole("button", { name: /Approve…/i }).length).toBeGreaterThan(0);
        });

        // Click "Approve…" button in the detail pane
        const approveBtns = r.getAllByRole("button", { name: /Approve…/i });
        fireEvent.click(approveBtns[0]);

        // Confirmation dialog should open
        await waitFor(() => {
          expect(r.getByRole("dialog")).toBeTruthy();
          expect(r.getByText(/Approve and queue run/i)).toBeTruthy();
        });

        // Click "Approve and queue" in the dialog
        const confirmBtn = r.getByRole("button", { name: /Approve and queue/i });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
          expect(approveMock).toHaveBeenCalledWith(propId);
        });
      },
    );
  });

  // WM-505: approving from Runs launches a real agent that spends money and can
  // push code. It must show the same risk context the Proposals view shows —
  // both paths now render the shared `ApprovalRiskDetails` component.
  test("approve dialog surfaces capabilities, mutating status, blast radius and budget", async () => {
    const runId = "run-proposed-risk";
    const propId = "prop-risk-1";

    const proposal = createProposalFixture({
      id: propId,
      runId,
      status: "open",
      decision: "run",
      agent: "shipper",
      repos: ["watt-mind/factory"],
      spec: createRunSpecFixture(runId, {
        agent: "shipper",
        capabilities: ["gh:write", "linear:read"],
        timeoutSeconds: 900,
        maxAttempts: 2,
        input: { branch: "main" },
      }),
    });

    await withApi(
      {
        runs: mock(async () => ({ runs: [stubListItem(runId, "PROPOSED", { agent: "shipper" })] })),
        run: mock(async () => stubDetail(runId, "PROPOSED", [])),
        proposals: mock(async () => ({ proposals: [proposal] })),
        agents: mock(async () =>
          createAgentsFixture({
            agents: [
              {
                ref: "shipper@1",
                id: "shipper",
                version: 1,
                outputContract: "factory.agent-result/v1",
                workspace: { type: "ephemeral" },
                capabilities: { filesystem: "workspace-only", services: ["github"] },
                limits: { timeout_seconds: 900, attempts: 2 },
                mutating: true,
                promptFile: "agents/shipper.md",
                prompt: "",
                inputSchemaFile: "schemas/shipper.input.json",
                inputSchema: {},
                outputSchemaFile: "schemas/agent-result.output.json",
                outputSchema: {},
                pins: {},
                command: null,
                actionRegistry: null,
                hosts: null,
                modelTier: "standard",
                model: null,
                eventTypes: [],
              },
            ],
          } as unknown as Parameters<typeof createAgentsFixture>[0]),
        ),
        approve: mock(async () => ({ approved: true as const, runId })),
        status: mock(async () => createStatusFixture({ runs: { byState: { PROPOSED: 1 } } })),
      },
      async () => {
        const r = renderRuns({ focusRunId: runId, onJumpProposal: noop });

        await waitFor(() => {
          expect(r.getAllByRole("button", { name: /Approve…/i }).length).toBeGreaterThan(0);
        });
        fireEvent.click(r.getAllByRole("button", { name: /Approve…/i })[0]);

        const dialog = await waitFor(() => r.getByRole("dialog"));
        const text = dialog.textContent ?? "";

        // Capabilities the agent runs with — the signal the old dialog dropped.
        expect(text).toContain("gh:write");
        expect(text).toContain("linear:read");
        // Mutating / blast-radius verdict.
        expect(text).toContain("Mutating");
        expect(text).toContain("Risk");
        // Budget and target.
        expect(text).toContain("900");
        expect(text).toContain("watt-mind/factory");
        expect(text).toContain("main");
        // The immutable spec itself is reachable from the dialog.
        expect(text).toContain("immutable RunSpec");
      },
    );
  });

  // WM-505: the global `table td { white-space: nowrap }` turned the State
  // column's `max-w-32 truncate` into a hard clip — `truncate` cannot ellipsize
  // a flex child, so `PROPOSED` + the `proposal` link were cut mid-glyph and
  // most of the link's hit area was unclickable. jsdom has no layout engine, so
  // assert the class contract that caused the clip is gone.
  test("State cell does not clip the proposal jump link", async () => {
    const runId = "run-proposed-clip";
    const propId = "prop-clip-1";
    const proposal = createProposalFixture({ id: propId, runId, status: "open", decision: "run" });

    await withApi(
      {
        runs: mock(async () => ({ runs: [stubListItem(runId, "PROPOSED")] })),
        run: mock(async () => stubDetail(runId, "PROPOSED", [])),
        proposals: mock(async () => ({ proposals: [proposal] })),
        status: mock(async () => createStatusFixture({ runs: { byState: { PROPOSED: 1 } } })),
      },
      async () => {
        const r = renderRuns({ focusRunId: runId, onJumpProposal: noop });

        const link = await waitFor(() => r.getByTitle(`Open proposal ${propId}`));
        const cell = link.closest("td");
        expect(cell).toBeTruthy();

        const cls = cell!.className;
        // A capped width plus `truncate` is exactly what clipped the link.
        expect(cls).not.toContain("truncate");
        expect(cls).not.toMatch(/\bmax-w-/);
        // The row must still not wrap — that is the point of this PR.
        expect(cls).toContain("whitespace-nowrap");

        // The link text is rendered in full, not cut short.
        expect(link.textContent).toContain("proposal");
      },
    );
  });
});


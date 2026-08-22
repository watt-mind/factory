import "../test-dom";
import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Runs, runDrilldownFilters, statesForRunTab } from "./Runs";
import {
  changeInput,
  createAgentsFixture,
  createEventFixture,
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
import type {
  LifecycleEvent,
  RunDetail,
  RunListItem,
  RunState,
  AgentsView,
} from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
  setSystemTime();
});

const noop = () => {};
const FAILURE_REASON = 'contract_violation: $: unknown property "captured"';
const NOW = new Date().toISOString();

test("reads a complete metrics drill-down contract from the hash", () => {
  expect(
    runDrilldownFilters(
      "#/runs?from=2026-08-18T08%3A00%3A00.000Z&to=2026-08-18T09%3A00%3A00.000Z&population=terminal&state=FAILED",
    ),
  ).toEqual({
    from: "2026-08-18T08:00:00.000Z",
    to: "2026-08-18T09:00:00.000Z",
    population: "terminal",
    state: "FAILED",
    agent: undefined,
  });
  expect(runDrilldownFilters("#/runs?population=terminal")).toBeNull();
});

function stubListItem(
  runId: string,
  state: RunState,
  overrides?: Partial<RunListItem>,
): RunListItem {
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

function stubDetail(
  runId: string,
  state: RunState,
  lifecycle: LifecycleEvent[],
  overrides?: Partial<RunDetail>,
): RunDetail {
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

function transition(
  seq: number,
  runId: string,
  from: string | null,
  to: string,
  reason: string | null,
): LifecycleEvent {
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

describe("Runs API pagination (WM-976)", () => {
  test("moves through summary pages with the runs pager", async () => {
    const first = stubListItem("run-page-new", "COMPLETED", {
      maxAttempts: undefined,
      spec: undefined,
    });
    const second = stubListItem("run-page-old", "FAILED", {
      maxAttempts: undefined,
      spec: undefined,
    });
    const runs = mock(async (_state?: string, filters?: { before?: string }) =>
      filters?.before
        ? { runs: [second], nextBefore: null }
        : { runs: [first], nextBefore: "older-page" },
    );
    await withApi(
      { runs, status: async () => createStatusFixture() },
      async () => {
        const r = renderRuns();
        await r.findByTitle("run-page-new");
        expect(r.getByRole("button", { name: "Older" })).toBeTruthy();

        fireEvent.click(r.getByRole("button", { name: "Older" }));
        await r.findByTitle("run-page-old");
        expect(r.queryByTitle("run-page-new")).toBeNull();
        expect(runs).toHaveBeenLastCalledWith(undefined, {
          before: "older-page",
        });
      },
    );
  });
});

function ticketSchemaRegistry(): AgentsView {
  return createAgentsFixture({
    agents: [
      {
        ref: "ticket-agent@1",
        inputSchema: {
          type: "object",
          properties: {
            ticket: { type: "string", "x-ui": { kind: "ticket" } },
          },
        },
        eventTypes: [],
      } as unknown as AgentsView["agents"][number],
    ],
  });
}

describe("Runs sortable columns (OPS-492)", () => {
  test("renders an x-ui ticket input column from its run agent schema", async () => {
    localStorage.setItem(
      "evrt-display-runs",
      JSON.stringify({ customColumns: ["spec.input.ticket"] }),
    );
    const run = stubListItem("run_schema_ticket", "COMPLETED", {
      agent: "ticket-agent@1",
      spec: createRunSpecFixture("run_schema_ticket", {
        input: { ticket: "FOO-12" },
      }),
    });

    await withApi(
      {
        runs: async () => ({ runs: [run] }),
        events: async () => ({ events: [] }),
        status: async () => createStatusFixture(),
        agents: async () => ticketSchemaRegistry(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() =>
          expect(
            r.getByRole("link", { name: "FOO-12" }).getAttribute("href"),
          ).toBe("#/tickets/FOO-12"),
        );
      },
    );
  });

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

        for (const label of [
          "Run",
          "State",
          "Agent",
          "Adapter",
          "Model",
          "Attempts",
          "Reason",
          "Origin",
          "Updated",
        ]) {
          const header = r.getByRole("columnheader", {
            name: new RegExp(label),
          });
          expect(header.getAttribute("aria-sort")).toBe("none");
          expect(header.querySelector("button")).toBeTruthy();
        }

        const runHeader = r.getByRole("columnheader", { name: /Run/ });
        fireEvent.click(r.getByRole("button", { name: /Run/ }));
        expect(runHeader.getAttribute("aria-sort")).toBe("ascending");
        expect(
          Array.from(
            r.container.querySelectorAll("tbody tr td:first-child"),
          ).map((cell) => cell.textContent),
        ).toEqual(["run_alpha", "run_zulu"]);

        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          );
        });
        expect(onSelectRun).toHaveBeenLastCalledWith("run_alpha");

        fireEvent.click(r.getByRole("button", { name: /Run/ }));
        expect(runHeader.getAttribute("aria-sort")).toBe("descending");
        fireEvent.click(r.getByRole("button", { name: /Run/ }));
        expect(runHeader.getAttribute("aria-sort")).toBe("none");
      },
    );
  });

  test("Remaining sorts a started-at timeout fallback among explicit deadlines", async () => {
    const now = Date.now();
    const early = stubListItem("run_early", "RUNNING", {
      deadlineAt: new Date(now + 5 * 60_000).toISOString(),
    });
    const fallback = stubListItem("run_fallback", "RUNNING", {
      deadlineAt: null,
      startedAt: new Date(now).toISOString(),
      timeoutSeconds: 600,
    });
    const late = stubListItem("run_late", "RUNNING", {
      deadlineAt: new Date(now + 15 * 60_000).toISOString(),
    });

    await withApi(
      {
        runs: async () => ({ runs: [early, fallback, late] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() => r.getByRole("columnheader", { name: /Remaining/ }));

        fireEvent.click(r.getByRole("button", { name: /Remaining/ }));
        expect(
          Array.from(
            r.container.querySelectorAll("tbody tr td:first-child"),
          ).map((cell) => cell.getAttribute("title")),
        ).toEqual(["run_early", "run_fallback", "run_late"]);
      },
    );
  });

  test("Duration sorts by numeric elapsed seconds", async () => {
    setSystemTime(new Date("2026-08-18T12:03:00.000Z"));
    const early = "2026-08-18T12:00:00.000Z";
    const short = stubListItem("run_short", "COMPLETED", {
      startedAt: early,
      updated_at: "2026-08-18T12:01:00.000Z",
    });
    const long = stubListItem("run_long", "COMPLETED", {
      startedAt: early,
      updated_at: "2026-08-18T12:02:00.000Z",
    });
    const live = stubListItem("run_live", "RUNNING", {
      startedAt: "2026-08-18T12:00:30.000Z",
      updated_at: "2026-08-18T12:00:45.000Z",
    });
    const missing = stubListItem("run_missing", "QUEUED");

    await withApi(
      {
        runs: async () => ({ runs: [missing, live, long, short] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await r.findByRole("columnheader", { name: /Duration/ });
        fireEvent.click(r.getByRole("button", { name: /Duration/ }));
        expect(
          Array.from(
            r.container.querySelectorAll("tbody tr td:first-child"),
          ).map((cell) => cell.getAttribute("title")),
        ).toEqual(["run_short", "run_long", "run_live", "run_missing"]);

        fireEvent.click(r.getByRole("button", { name: /Duration/ }));
        expect(
          Array.from(
            r.container.querySelectorAll("tbody tr td:first-child"),
          ).map((cell) => cell.getAttribute("title")),
        ).toEqual(["run_live", "run_long", "run_short", "run_missing"]);
      },
    );
  });
});

describe("Runs Duration column (WM-871)", () => {
  function cellFor(
    r: ReturnType<typeof renderRuns>,
    runId: string,
    label: string,
  ): HTMLTableCellElement {
    const index = [...r.container.querySelectorAll("thead th")].findIndex(
      (th) => (th.textContent ?? "").startsWith(label),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const row = r.container
      .querySelector(`td[title="${runId}"]`)
      ?.closest("tr");
    expect(row).toBeTruthy();
    return row!.querySelectorAll("td")[index] as HTMLTableCellElement;
  }

  test("renders terminal elapsed time, ticks in-flight rows, and never fetches row details", async () => {
    const t0 = Date.parse("2026-08-18T12:00:00.000Z");
    setSystemTime(new Date(t0 + 150_000));
    let detailCalls = 0;
    const completed = stubListItem("run_completed", "COMPLETED", {
      startedAt: new Date(t0).toISOString(),
      created_at: new Date(t0 - 60_000).toISOString(),
      updated_at: new Date(t0 + 150_000).toISOString(),
    });
    const running = stubListItem("run_running", "RUNNING", {
      startedAt: new Date(t0).toISOString(),
      updated_at: new Date(t0 + 30_000).toISOString(),
    });
    const queued = stubListItem("run_queued", "QUEUED", {
      created_at: new Date(t0).toISOString(),
      updated_at: new Date(t0 + 30_000).toISOString(),
    });

    await withApi(
      {
        runs: async () => ({ runs: [completed, running, queued] }),
        run: async () => {
          detailCalls += 1;
          return stubDetail("run_running", "RUNNING", []);
        },
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() =>
          expect(
            r.container.querySelector('td[title="run_completed"]'),
          ).toBeTruthy(),
        );
        const headers = [...r.container.querySelectorAll("thead th")].map(
          (th) => th.textContent?.replace(/[↕↑↓×]/g, "").trim(),
        );
        expect(headers.indexOf("Duration")).toBe(
          headers.indexOf("Remaining") + 1,
        );
        expect(r.container.querySelector("table")?.style.minWidth).toBe(
          `${(headers.length - 1) * 112 + 176}px`,
        );
        expect(cellFor(r, "run_completed", "Duration").textContent).toBe(
          "2m 30s",
        );
        expect(cellFor(r, "run_running", "Duration").textContent).toBe(
          "2m 30s",
        );
        expect(cellFor(r, "run_queued", "Duration").textContent).toBe("—");
        expect(detailCalls).toBe(0);

        setSystemTime(new Date(t0 + 152_000));
        await waitFor(
          () =>
            expect(cellFor(r, "run_running", "Duration").textContent).toBe(
              "2m 32s",
            ),
          { timeout: 4000 },
        );
        expect(detailCalls).toBe(0);
      },
    );
  }, 10_000);

  test("stays visible when saved options only hide another column", async () => {
    localStorage.setItem(
      "evrt-display-runs",
      JSON.stringify({ hiddenColumns: ["model"] }),
    );
    await withApi(
      {
        runs: async () => ({ runs: [stubListItem("run_saved", "COMPLETED")] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        expect(
          await r.findByRole("columnheader", { name: /Duration/ }),
        ).toBeTruthy();
      },
    );
  });
});

describe("Runs table short run ids (WM-96)", () => {
  test("run id cell displays the short form and carries the full id as title", async () => {
    const runId = "run_ec9c87f9-4c1d-4f4a-9d7e-2c2f3a1b0c9d";
    const detail = stubDetail(runId, "COMPLETED", [
      transition(1, runId, null, "QUEUED", null),
    ]);
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
        expect(
          banner.compareDocumentPosition(runSection) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
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
        const openInTab = await waitFor(() =>
          getByRole("button", { name: /Open in tab/ }),
        );
        expect(
          openInTab.querySelector('[aria-hidden="true"]')?.textContent,
        ).toBe("p");

        fireEvent.keyDown(document.body, { key: "p" });
        expect(
          JSON.parse(sessionStorage.getItem("factory.pinnedRuns") ?? "[]"),
        ).toEqual([runId]);

        fireEvent.keyDown(document.body, { key: "p" });
        expect(
          JSON.parse(sessionStorage.getItem("factory.pinnedRuns") ?? "[]"),
        ).toEqual([]);
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
    const detail = stubDetail("run_selected_1", "RUNNING", [
      transition(1, "run_selected_1", null, "RUNNING", null),
    ]);
    await withApi(
      {
        runs: async () => ({ runs: [r1] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
      },
      async () => {
        const { container, getByText } = renderRuns({
          focusRunId: "run_selected_1",
        });

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
        const { container, getByLabelText } = renderRuns({
          focusRunId: "run_alpha",
        });

        await waitFor(() => container.querySelector(`td[title="${r1.runId}"]`));
        expect(container.querySelector(`td[title="${r2.runId}"]`)).toBeTruthy();

        const filterInput = getByLabelText("Filter runs") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(
            container.querySelector(`td[title="${r1.runId}"]`),
          ).toBeTruthy();
          expect(container.querySelector(`td[title="${r2.runId}"]`)).toBeNull();
        });

        // The selected row remains selected
        const selectedRow = container.querySelector("tr.row-selected");
        expect(selectedRow).toBeTruthy();
        expect(
          selectedRow?.querySelector(`td[title="${r1.runId}"]`),
        ).toBeTruthy();
      },
    );
  });

  test("tab counts describe the filtered set instead of the unfiltered totals", async () => {
    const rows = [
      stubListItem("run_match_active", "RUNNING", { agent: "triage-scan" }),
      stubListItem("run_match_done", "COMPLETED", { agent: "triage-scan" }),
      stubListItem("run_other_failed", "FAILED", { agent: "review-scan" }),
    ];

    await withApi(
      {
        runs: async () => ({ runs: rows }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() =>
          r.container.querySelector('td[title="run_match_active"]'),
        );

        act(() => {
          changeInput(
            r.getByLabelText("Filter runs") as HTMLInputElement,
            "agent:triage-scan",
          );
        });

        expect(r.getByRole("tab", { name: /^All 2$/i })).toBeTruthy();
        expect(r.getByRole("tab", { name: /^Active 1$/i })).toBeTruthy();
        expect(r.getByRole("tab", { name: /^Completed 1$/i })).toBeTruthy();
        expect(r.getByRole("tab", { name: /^Failed$/i })).toBeTruthy();
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
        const { getByRole, container } = renderRuns({
          focusRunId: "run_tab_1",
          onSelectRun,
        });

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
          runs:
            state && state !== "ALL"
              ? allRuns.filter((r) => r.state === state)
              : allRuns,
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
          const targetCell = container.querySelector(
            `td[title="run_failed_target"]`,
          );
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
          expect(
            container.querySelector(`td[title="${r1.runId}"]`),
          ).toBeTruthy();
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
      stubListItem("run_pinned", "COMPLETED", {
        adapter: "claude",
        modelTier: "standard",
        model: "sonnet",
      }),
      stubListItem("run_sentinel", "COMPLETED", {
        adapter: "claude",
        modelTier: "strong",
        model: "default",
      }),
      stubListItem("run_command", "COMPLETED", {
        adapter: "command",
        modelTier: null,
        model: null,
      }),
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
    localStorage.setItem(
      "evrt-display-runs",
      JSON.stringify({ hiddenColumns: ["model"] }),
    );
    const modelRows = [
      stubListItem("run_pinned", "COMPLETED", {
        adapter: "claude",
        model: "sonnet",
      }),
    ];
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

describe("Runs custom spec columns (WM-303)", () => {
  test("renders a nested spec value and discovers spec paths with samples", async () => {
    const runId = "run_custom_spec";
    const model = "opus-custom-303";
    const spec = createRunSpecFixture(runId, {
      input: { model, repo: "factory" },
    });

    await withApi(
      {
        runs: async () => ({
          runs: [stubListItem(runId, "COMPLETED", { spec })],
        }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await r.findByText("run_custom_s");

        fireEvent.click(r.getByRole("button", { name: /^Display/ }));
        const input = r.getByRole("combobox", {
          name: "Add custom property path",
        });
        fireEvent.focus(input);
        expect(
          r.getByRole("option", {
            name: new RegExp(`spec\\.input\\.model.*${model}`, "i"),
          }),
        ).toBeTruthy();
        expect(
          r.getByRole("option", { name: /spec\.input\.repo.*factory/i }),
        ).toBeTruthy();

        act(() => changeInput(input as HTMLInputElement, "model"));
        fireEvent.keyDown(input, { key: "Enter" });
        expect(await r.findByText(model)).toBeTruthy();
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
        expect(idBtn).toBeTruthy();
        expect(
          r.getByRole("button", { name: "Copy CLI inspect command (c i)" }),
        ).toBeTruthy();
        expect(r.getByRole("button", { name: "Copy link (c l)" })).toBeTruthy();
        expect(
          r.getAllByRole("tooltip").map((tooltip) => tooltip.textContent),
        ).toEqual(
          expect.arrayContaining([
            "Copy run id · c",
            "Copy CLI inspect command · c i",
            "Copy link · c l",
          ]),
        );

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
          expect(
            r.getAllByRole("button", { name: /Approve…/i }).length,
          ).toBeGreaterThan(0);
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
        const confirmBtn = r.getByRole("button", {
          name: /Approve and queue/i,
        });
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
        capabilities: ["gh:write", "tracker:read"],
        timeoutSeconds: 900,
        maxAttempts: 2,
        input: { branch: "main" },
      }),
    });

    await withApi(
      {
        runs: mock(async () => ({
          runs: [stubListItem(runId, "PROPOSED", { agent: "shipper" })],
        })),
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
                capabilities: {
                  filesystem: "workspace-only",
                  services: ["github"],
                },
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
        status: mock(async () =>
          createStatusFixture({ runs: { byState: { PROPOSED: 1 } } }),
        ),
      },
      async () => {
        const r = renderRuns({ focusRunId: runId, onJumpProposal: noop });

        await waitFor(() => {
          expect(
            r.getAllByRole("button", { name: /Approve…/i }).length,
          ).toBeGreaterThan(0);
        });
        fireEvent.click(r.getAllByRole("button", { name: /Approve…/i })[0]);

        const dialog = await waitFor(() => r.getByRole("dialog"));
        const text = dialog.textContent ?? "";

        // Capabilities the agent runs with — the signal the old dialog dropped.
        expect(text).toContain("gh:write");
        expect(text).toContain("tracker:read");
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
    const proposal = createProposalFixture({
      id: propId,
      runId,
      status: "open",
      decision: "run",
    });

    await withApi(
      {
        runs: mock(async () => ({ runs: [stubListItem(runId, "PROPOSED")] })),
        run: mock(async () => stubDetail(runId, "PROPOSED", [])),
        proposals: mock(async () => ({ proposals: [proposal] })),
        status: mock(async () =>
          createStatusFixture({ runs: { byState: { PROPOSED: 1 } } }),
        ),
      },
      async () => {
        const r = renderRuns({ focusRunId: runId, onJumpProposal: noop });

        const link = await waitFor(() =>
          r.getByTitle(`Open proposal ${propId}`),
        );
        const cell = link.closest("td");
        expect(cell).toBeTruthy();

        const cls = cell!.className;
        // A capped width plus `truncate` is exactly what clipped the link.
        expect(cls).not.toContain("truncate");
        expect(cls).not.toMatch(/\bmax-w-/);
        expect(cls).not.toContain("overflow-hidden");
        // The fixed table layout must reserve room for the badge and link.
        expect(cls).toMatch(/\bmin-w-/);
        expect(
          cell!.closest("table")?.querySelectorAll("col")[1]?.className,
        ).toContain("w-44");
        // The row must still not wrap — that is the point of this PR.
        expect(cls).toContain("whitespace-nowrap");

        // The link text is rendered in full, not cut short.
        expect(link.textContent).toContain("proposal");
      },
    );
  });
});

describe("Runs long-list window (WM-563)", () => {
  test("a 2,000-row fixture mounts fewer than 200 table rows and pages forward", async () => {
    const runs = Array.from({ length: 2000 }, (_, i) =>
      stubListItem(`run_window_${i}`, "COMPLETED"),
    );
    await withApi(
      {
        runs: async () => ({ runs }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        const next = await r.findByRole("button", { name: "Next" });
        expect(r.container.querySelectorAll("tbody tr").length).toBeLessThan(
          200,
        );
        expect(
          r.container.querySelector('td[title="run_window_100"]'),
        ).toBeNull();
        fireEvent.click(next);
        await waitFor(() => {
          expect(
            r.container.querySelector('td[title="run_window_100"]'),
          ).toBeTruthy();
        });
        expect(
          r.container.querySelector("tbody tr:last-child")?.textContent,
        ).toContain("101–200/2000");
        expect(r.container.querySelectorAll("tbody tr").length).toBeLessThan(
          200,
        );
      },
    );
  });

  test("group headers share the DOM cap even when 2,000 unique groups are collapsed", async () => {
    const runs = Array.from({ length: 2000 }, (_, i) =>
      stubListItem(`run_group_${i}`, "COMPLETED", { agent: `agent-${i}` }),
    );
    localStorage.setItem(
      "evrt-display-runs",
      JSON.stringify({
        groupBy: "agent",
        subGroupBy: "none",
        sortBy: "default",
        sortDir: "asc",
        showEmpty: false,
        hiddenColumns: [],
        collapsed: runs.map((run) => run.agent),
        customColumns: [],
      }),
    );
    await withApi(
      {
        runs: async () => ({ runs }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await r.findByRole("button", { name: /agent-0/ });
        expect(r.container.querySelectorAll("tbody tr").length).toBeLessThan(
          200,
        );
        fireEvent.click(r.getByRole("button", { name: "Next" }));
        await waitFor(() =>
          expect(r.getByRole("button", { name: /agent-100/ })).toBeTruthy(),
        );
        expect(r.container.querySelectorAll("tbody tr").length).toBeLessThan(
          200,
        );
      },
    );
  });

  test("a sub-grouped page repeats only its own ancestry, never earlier sub headers", async () => {
    // 5 agents x 50 runs, all COMPLETED: token 100 (the second page's first
    // token) lands mid-way inside the second agent's subsection, so the window
    // has to replay exactly two headers — COMPLETED and that agent — and no
    // sub header whose rows all live on the previous page.
    const runs = Array.from({ length: 250 }, (_, i) =>
      stubListItem(`run_sub_${i}`, "COMPLETED", {
        agent: `agent-${Math.floor(i / 50)}`,
      }),
    );
    localStorage.setItem(
      "evrt-display-runs",
      JSON.stringify({
        groupBy: "state",
        subGroupBy: "agent",
        sortBy: "default",
        sortDir: "asc",
        showEmpty: false,
        hiddenColumns: [],
        collapsed: [],
        customColumns: [],
      }),
    );
    await withApi(
      {
        runs: async () => ({ runs }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        fireEvent.click(await r.findByRole("button", { name: "Next" }));
        await waitFor(() => {
          expect(
            r.container.querySelector('td[title="run_sub_100"]'),
          ).toBeTruthy();
        });

        // Walk the rendered body: every expanded sub header must own at least
        // one run row before the next header. A header with a count badge and
        // nothing under it is the phantom this guards against.
        const rows = [...r.container.querySelectorAll("tbody tr")];
        const phantoms: string[] = [];
        rows.forEach((row, i) => {
          const header = row.querySelector("button[aria-expanded]");
          if (!header || header.getAttribute("aria-expanded") !== "true")
            return;
          const next = rows[i + 1];
          if (!next || !next.querySelector('td[title^="run_sub_"]')) {
            if (header.className.includes("pl-8"))
              phantoms.push(header.textContent ?? "");
          }
        });
        expect(phantoms).toEqual([]);

        // Positively: the page's own ancestry is replayed — its state header
        // and its own agent — and the subsection that ended on the previous
        // page is gone entirely.
        const headers = [
          ...r.container.querySelectorAll("tbody tr button[aria-expanded]"),
        ].map((el) => el.textContent ?? "");
        expect(headers[0]).toStartWith("COMPLETED");
        expect(headers[1]).toStartWith("agent-1");
        expect(headers.filter((label) => label.startsWith("agent-0"))).toEqual(
          [],
        );
      },
    );
  });

  test("j crosses a page boundary, Enter opens that row, and footer Enter does not", async () => {
    const runs = Array.from({ length: 250 }, (_, i) =>
      stubListItem(`run_keys_${i}`, "COMPLETED"),
    );
    const onOpenFull = mock(() => {});
    function Harness() {
      const [focusRunId, setFocusRunId] = useState<string | null>(
        "run_keys_99",
      );
      return (
        <Runs
          connected
          context={{ kind: "all" }}
          focusRunId={focusRunId}
          onSelectRun={setFocusRunId}
          onOpenFull={onOpenFull}
          focusState={null}
          onFocusStateConsumed={noop}
          onJumpAgent={noop}
          onJumpEvent={noop}
        />
      );
    }
    await withApi(
      {
        runs: async () => ({ runs }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderWithClient(<Harness />);
        await waitFor(() =>
          expect(
            r.container.querySelector('td[title="run_keys_99"]'),
          ).toBeTruthy(),
        );
        fireEvent.keyDown(document.body, { key: "j" });
        await waitFor(() => {
          expect(
            r.container.querySelector('td[title="run_keys_100"]')?.closest("tr")
              ?.className,
          ).toContain("row-selected");
        });
        fireEvent.keyDown(document.body, { key: "Enter" });
        expect(onOpenFull).toHaveBeenCalledWith("run_keys_100");
        onOpenFull.mockClear();
        fireEvent.keyDown(r.getByRole("button", { name: "Next" }), {
          key: "Enter",
        });
        expect(onOpenFull).not.toHaveBeenCalled();
      },
    );
  });
});

describe("Runs in-flight row height (WM-725)", () => {
  function cellFor(
    r: ReturnType<typeof renderRuns>,
    runId: string,
    label: string,
  ): HTMLTableCellElement {
    const index = [...r.container.querySelectorAll("thead th")].findIndex(
      (th) => (th.textContent ?? "").startsWith(label),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const row = r.container
      .querySelector(`td[title="${runId}"]`)
      ?.closest("tr");
    expect(row).toBeTruthy();
    return row!.querySelectorAll("td")[index] as HTMLTableCellElement;
  }

  // The State column is one line: the badge plus the optional `proposal` jump
  // link (WM-505). A second line of clocks stacked under the badge made every
  // in-flight row taller than the terminal rows around it, and repeated a
  // countdown the Remaining column already owns.
  test("in-flight State cell stays one line and Remaining carries the countdown", async () => {
    const now = Date.now();
    const hang = stubListItem("run_hang", "RUNNING", {
      startedAt: new Date(now - 2 * 60_000).toISOString(),
      deadlineAt: new Date(now + 9 * 60_000).toISOString(),
      leaseExpiresAt: new Date(now + 60_000).toISOString(),
      timeoutSeconds: 600,
    });
    // The ordinary case: the lease is minted for the budget plus a grace, so it
    // fires after the budget and has nothing to add to the row.
    const calm = stubListItem("run_calm", "RUNNING", {
      startedAt: new Date(now - 2 * 60_000).toISOString(),
      deadlineAt: new Date(now + 9 * 60_000).toISOString(),
      leaseExpiresAt: new Date(now + 11 * 60_000).toISOString(),
      timeoutSeconds: 600,
    });
    const done = stubListItem("run_done", "COMPLETED");

    await withApi(
      {
        runs: async () => ({ runs: [hang, calm, done] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() =>
          expect(
            r.container.querySelector('td[title="run_hang"]'),
          ).toBeTruthy(),
        );

        const state = cellFor(r, "run_hang", "State");
        expect(state.textContent).not.toContain("timeout in");
        expect(state.textContent).not.toContain("reaped in");
        expect(state.textContent).toBe("RUNNING");
        // Same block count as the terminal row beside it: one line each, so
        // the two rows are the same height.
        expect(state.querySelectorAll("div").length).toBe(
          cellFor(r, "run_done", "State").querySelectorAll("div").length,
        );

        // The urgency did not disappear with the second line — Remaining shows
        // the budget and the lease together, still on one line.
        const remaining = cellFor(r, "run_hang", "Remaining");
        expect(remaining.textContent).toMatch(/\b9m\b/);
        expect(remaining.textContent).toContain("lease");
        expect(remaining.querySelectorAll("div").length).toBe(0);
        expect(remaining.className).toContain("whitespace-nowrap");
        expect(remaining.className).toContain("overflow-hidden");

        // A lease that outlives the budget is not the binding deadline, so it
        // stays off the row rather than padding the column with a number the
        // operator cannot act on.
        const calmRemaining = cellFor(r, "run_calm", "Remaining");
        expect(calmRemaining.textContent).toMatch(/\b9m\b/);
        expect(calmRemaining.textContent).not.toContain("lease");
        expect(cellFor(r, "run_calm", "State").textContent).toBe("RUNNING");
      },
    );
  });

  test("Remaining title includes the ISO deadline alongside the relative countdown (WM-747)", async () => {
    const now = Date.now();
    const deadlineAt = new Date(now + 9 * 60_000).toISOString();
    const calm = stubListItem("run_iso_deadline", "RUNNING", {
      startedAt: new Date(now - 2 * 60_000).toISOString(),
      deadlineAt,
      leaseExpiresAt: new Date(now + 11 * 60_000).toISOString(),
      timeoutSeconds: 600,
    });

    await withApi(
      {
        runs: async () => ({ runs: [calm] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() =>
          expect(
            r.container.querySelector('td[title="run_iso_deadline"]'),
          ).toBeTruthy(),
        );

        const remaining = cellFor(r, "run_iso_deadline", "Remaining");
        const title =
          remaining.querySelector("[title]")?.getAttribute("title") ?? "";
        expect(title).toContain("timeout in");
        expect(title).toContain(deadlineAt);
        expect(remaining.textContent).toMatch(/\b9m\b/);
        expect(remaining.textContent).not.toContain(deadlineAt);
      },
    );
  });
});

describe("Runs detail pane width (WM-685)", () => {
  test("detail pane uses the canonical 440px width", async () => {
    const run = stubListItem("run_pane_width", "RUNNING");
    const detail = stubDetail("run_pane_width", "RUNNING", [
      transition(1, "run_pane_width", null, "RUNNING", null),
    ]);
    await withApi(
      {
        runs: async () => ({ runs: [run] }),
        run: async () => detail,
        status: async () => createStatusFixture(),
      },
      async () => {
        const view = renderRuns({ focusRunId: "run_pane_width" });
        await waitFor(() => view.getByText("idempotencyKey"));
        const className =
          view.container.querySelector("aside")?.className ?? "";
        expect(className).toContain("w-[440px]");
        expect(className).not.toContain("w-[460px]");
      },
    );
  });
});

// One-hop causation on the row (WM-702): `↳` when the run's own origin event
// was emitted by another run, `→ N` for the events it emitted, both landing on
// the chain trace with this run already selected. The chain key lives on the
// origin event, so the view has to read the event list to address the chain.
describe("Runs causation glyphs and hover card (WM-702)", () => {
  const triggered = stubListItem("run_chained", "COMPLETED", {
    eventSource: "github",
    eventId: "evt_origin",
  });

  const chainEvents = [
    createEventFixture({
      source: "github",
      eventId: "evt_origin",
      correlationId: "corr_1001",
      causationId: "run_parent",
    }),
    createEventFixture({
      source: "factory",
      eventId: "evt_emitted_a",
      correlationId: "corr_1001",
      causationId: "run_chained",
    }),
    createEventFixture({
      source: "factory",
      eventId: "evt_emitted_b",
      correlationId: "corr_1001",
      causationId: "run_chained",
    }),
  ];

  function runCell(container: HTMLElement, runId: string): HTMLElement {
    const cell = container.querySelector<HTMLElement>(`td[title="${runId}"]`);
    if (!cell) throw new Error(`no Run cell for ${runId}`);
    return cell;
  }

  test("a triggered run links into its origin event's chain, preselected", async () => {
    const onSelectRun = mock(() => {});
    await withApi(
      {
        runs: async () => ({ runs: [triggered] }),
        events: async () => ({ events: chainEvents }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns({ onSelectRun });

        const link = await waitFor(() => {
          const el = runCell(r.container, "run_chained").querySelector("a");
          if (!el) throw new Error("no causation link in the Run cell");
          return el;
        });

        // The chain key is the origin event's correlation id, not the run id.
        expect(link.getAttribute("href")).toBe(
          "#/chain/corr_1001/run%3Arun_chained",
        );
        expect(link.textContent).toContain("↳");
        expect(link.textContent).toContain("→ 2");

        fireEvent.click(link);
        expect(onSelectRun).not.toHaveBeenCalled();
      },
    );
  });

  // Almost every run names an origin event, so "was triggered by an event"
  // would put an arrow on every row and tell an operator nothing.
  test("a run at the head of its chain gets the fan-out arrow but no downstream one", async () => {
    const rootEvents = [
      createEventFixture({
        source: "github",
        eventId: "evt_root",
        correlationId: "corr_2002",
        causationId: null,
      }),
      createEventFixture({
        source: "factory",
        eventId: "evt_from_root",
        correlationId: "corr_2002",
        causationId: "run_root",
      }),
    ];
    await withApi(
      {
        runs: async () => ({
          runs: [
            stubListItem("run_root", "COMPLETED", {
              eventSource: "github",
              eventId: "evt_root",
            }),
          ],
        }),
        events: async () => ({ events: rootEvents }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        // The fan-out arrow proves the event list reached the row.
        await waitFor(() =>
          expect(runCell(r.container, "run_root").textContent).toContain("→ 1"),
        );
        expect(runCell(r.container, "run_root").textContent).not.toContain("↳");
      },
    );
  });

  test("a run with no origin event and no emissions gets no glyph", async () => {
    await withApi(
      {
        runs: async () => ({ runs: [stubListItem("run_bare", "COMPLETED")] }),
        events: async () => ({ events: [] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        await waitFor(() => runCell(r.container, "run_bare"));
        expect(runCell(r.container, "run_bare").querySelector("a")).toBeNull();
      },
    );
  });

  test("hovering the run id opens the run hover card", async () => {
    await withApi(
      {
        runs: async () => ({ runs: [triggered] }),
        events: async () => ({ events: chainEvents }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderRuns();
        const cell = await waitFor(() => runCell(r.container, "run_chained"));

        const trigger = cell.querySelector<HTMLElement>(
          "[aria-haspopup='dialog']",
        );
        expect(trigger).toBeTruthy();
        fireEvent.mouseEnter(trigger!);

        await waitFor(() => {
          const card = r.getByRole("dialog");
          expect(card.getAttribute("aria-label")).toBe("Run run_chained");
          expect(card.textContent).toContain("triage-scan");
          expect(card.textContent).toContain("COMPLETED");
        });
      },
    );
  });
});

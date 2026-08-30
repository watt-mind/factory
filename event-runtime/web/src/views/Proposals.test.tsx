import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  filterOpenProposals,
  proposalDrilldownFilters,
  Proposals,
} from "./Proposals";
import { api } from "../api";
import {
  changeInput,
  createEventFixture,
  createProposalFixture,
  createRunListItemFixture,
  createRunSpecFixture,
  createStatusFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { Proposal, StatusView } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
  globalThis.fetch = realFetch;
});

const realFetch = globalThis.fetch;

function stubProposalDetailFetch(
  hookDecisions: unknown[] = [],
  proposalId?: string,
) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!/\/api\/proposals\/[^/?]+\/?$/.test(url)) {
      return realFetch(input as RequestInfo);
    }
    return new Response(
      JSON.stringify({
        proposal: { id: proposalId ?? "prop" },
        hookDecisions,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

beforeEach(() => {
  stubProposalDetailFetch();
});

const noop = () => {};
const NOW = new Date().toISOString();

test("reads a reproducible proposal decision drill-down from the hash", () => {
  expect(
    proposalDrilldownFilters(
      "#/proposals?from=2026-08-18T08%3A00%3A00.000Z&to=2026-08-18T09%3A00%3A00.000Z&population=decision&decisionStatus=expired",
    ),
  ).toEqual({
    from: "2026-08-18T08:00:00.000Z",
    to: "2026-08-18T09:00:00.000Z",
    population: "decision",
    decisionStatus: "expired",
  });
  expect(
    proposalDrilldownFilters("#/proposals?population=decision"),
  ).toBeNull();
});

function stubStatus(): StatusView {
  return createStatusFixture({
    proposals: { open: 2, expired: 0 },
    workers: { live: 1, busy: 0, stale: 0 },
  });
}

function stubProposal(
  id: string,
  status = "open",
  overrides?: Partial<Proposal>,
): Proposal {
  return createProposalFixture({
    id,
    decision: "run",
    status,
    expired: false,
    created_at: NOW,
    ttl_seconds: 300,
    agent: "triage-scan",
    repos: ["repo-test"],
    ...overrides,
  });
}

function renderProposals(props: Partial<Parameters<typeof Proposals>[0]> = {}) {
  return renderWithClient(
    <Proposals
      connected={true}
      healthPending={false}
      context={{ kind: "all" }}
      onRunQueued={noop}
      focusProposalId={null}
      onSelectProposal={noop}
      focusExpired={false}
      onFocusExpiredConsumed={noop}
      onJumpAgent={noop}
      onJumpEvent={noop}
      {...props}
    />,
  );
}

describe("Proposals approval availability (WM-738)", () => {
  const proposal = stubProposal("prop_health_state");

  async function approvalTitle(props: {
    connected: boolean;
    healthPending: boolean;
  }) {
    return withApi(
      {
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => stubStatus(),
      },
      async () => {
        const r = renderProposals({
          ...props,
          focusProposalId: proposal.id,
        });
        const approve = await r.findByRole("button", { name: /^Approve/ });
        return approve.parentElement?.getAttribute("title");
      },
    );
  }

  test("pending health says approval is waiting to connect", async () => {
    expect(await approvalTitle({ connected: false, healthPending: true })).toBe(
      "Approval is unavailable while connecting.",
    );
  });

  test("failed health says approval is unavailable while disconnected", async () => {
    expect(
      await approvalTitle({ connected: false, healthPending: false }),
    ).toBe("Approval is unavailable while disconnected.");
  });

  test("successful health leaves approval enabled without a tooltip", async () => {
    expect(
      await approvalTitle({ connected: true, healthPending: false }),
    ).toBeNull();
  });
});

describe("Proposals multi-row selection & bulk actions (WM-71)", () => {
  let origProposals: typeof api.proposals;
  let origProposalHistory: typeof api.proposalHistory;
  let origStatus: typeof api.status;
  let origRuns: typeof api.runs;
  let origEvents: typeof api.events;
  let origAgents: typeof api.agents;
  let origApprove: typeof api.approve;
  let origReject: typeof api.reject;

  beforeEach(() => {
    origProposals = api.proposals;
    origProposalHistory = api.proposalHistory;
    origStatus = api.status;
    origRuns = api.runs;
    origEvents = api.events;
    origAgents = api.agents;
    origApprove = api.approve;
    origReject = api.reject;

    api.status = async () => stubStatus();
    api.proposals = async () => ({ proposals: [] });
    api.proposalHistory = async () => ({ proposals: [] });
    api.runs = async () => ({ runs: [] });
    api.events = async () => ({ events: [] });
    api.agents = async () => ({
      agents: [],
      edges: {},
      eventTypes: [],
      contracts: {},
    });
  });

  afterEach(() => {
    api.proposals = origProposals;
    api.proposalHistory = origProposalHistory;
    api.status = origStatus;
    api.runs = origRuns;
    api.events = origEvents;
    api.agents = origAgents;
    api.approve = origApprove;
    api.reject = origReject;
  });

  test("supports individual checkbox selection and renders floating bulk action bar", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "security-scan" });
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );

    // Initially no bulk action bar
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    // Select prop_1
    const cb1 = r.getByLabelText("Select proposal prop_1") as HTMLInputElement;
    expect(cb1.checked).toBe(false);
    fireEvent.click(cb1);
    expect(cb1.checked).toBe(true);

    // Floating bar appears with 1 selected
    expect(r.getByRole("toolbar", { name: /bulk actions/i })).toBeTruthy();
    expect(r.getByText("Approve selected (1)")).toBeTruthy();
    expect(r.getByText("Reject selected (1)")).toBeTruthy();

    // Select prop_2
    const cb2 = r.getByLabelText("Select proposal prop_2") as HTMLInputElement;
    fireEvent.click(cb2);
    expect(cb2.checked).toBe(true);

    expect(r.getByText("Approve selected (2)")).toBeTruthy();
    expect(r.getByText("Reject selected (2)")).toBeTruthy();

    // Clear selection
    const clearBtn = r.getByText("Clear");
    fireEvent.click(clearBtn);
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
    expect(cb1.checked).toBe(false);
    expect(cb2.checked).toBe(false);
  });

  test("select all checkbox selects/deselects all visible proposals matching current filter", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "security-scan" });
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );

    const selectAll = r.getByLabelText(
      "Select all proposals",
    ) as HTMLInputElement;
    expect(selectAll.checked).toBe(false);

    // Click select all
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(true);
    expect(r.getByText("Approve selected (2)")).toBeTruthy();

    // Click select all again to deselect all
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(false);
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    // Now filter by security using changeInput
    const filterInput = r.getByLabelText(
      "Filter proposals",
    ) as HTMLInputElement;
    await act(async () => {
      changeInput(filterInput, "security");
    });

    expect(r.queryByLabelText("Select proposal prop_1")).toBeNull();
    expect(r.getByLabelText("Select proposal prop_2")).toBeTruthy();

    // Click select all under filter — only 1 matching row should be selected
    const selectAllAfter = r.getByLabelText(
      "Select all proposals",
    ) as HTMLInputElement;
    fireEvent.click(selectAllAfter);
    expect(r.getByText("Approve selected (1)")).toBeTruthy();
  });

  test("bulk approve approves actionable proposals and skips non-actionable rows", async () => {
    const p1 = stubProposal("prop_1", "open", { decision: "run" });
    const p2 = stubProposal("prop_2", "open", { decision: "run" });
    const p3 = stubProposal("prop_3", "open", { decision: "noop" }); // non-actionable for approval
    api.proposals = async () => ({ proposals: [p1, p2, p3] });
    api.proposalHistory = async () => ({ proposals: [] });

    const approvedIds: string[] = [];
    api.approve = async (id: string) => {
      approvedIds.push(id);
      return {
        approved: true,
        runId: `run_${id}`,
        proposal: undefined,
        replanned: false,
      };
    };

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );

    // Select all 3
    const selectAll = r.getByLabelText("Select all proposals");
    fireEvent.click(selectAll);

    // Click Approve selected — confirm must appear before any POST
    const approveBtn = r.getByText("Approve selected (2)");
    fireEvent.click(approveBtn);
    expect(approvedIds).toEqual([]);
    await act(async () => {
      fireEvent.click(r.getByRole("button", { name: "Approve and queue" }));
    });

    // Should have approved prop_1 and prop_2, skipping prop_3
    expect(approvedIds).toEqual(["prop_1", "prop_2"]);
    // Selection should be cleared
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
  });

  test("bulk reject prompts once for reason and applies to all selected", async () => {
    const p1 = stubProposal("prop_1", "open");
    const p2 = stubProposal("prop_2", "open");
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const rejectedCalls: { id: string; why?: string }[] = [];
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );

    // Select all 2
    const selectAll = r.getByLabelText("Select all proposals");
    fireEvent.click(selectAll);

    // Click Reject selected (2)
    const rejectBtn = r.getByText("Reject selected (2)");
    fireEvent.click(rejectBtn);

    // Prompt Dialog appears
    expect(r.getByRole("dialog")).toBeTruthy();
    expect(r.getByText(/Reject 2 selected proposals/i)).toBeTruthy();

    // Click a canned template
    const cannedScope = r.getByRole("button", { name: "Scope too wide" });
    fireEvent.click(cannedScope);

    // Confirm bulk rejection
    const confirmBtn = r.getByRole("button", { name: "Reject 2 proposals" });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(rejectedCalls).toEqual([
      { id: "prop_1", why: "Scope too wide" },
      { id: "prop_2", why: "Scope too wide" },
    ]);

    // Dialog closed and selection cleared
    expect(r.queryByRole("dialog")).toBeNull();
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
  });

  test("Space and Shift+Space toggle the highlighted proposal checkbox", async () => {
    const p1 = stubProposal("prop_keyboard", "open", {
      agent: "keyboard-agent",
    });
    api.proposals = async () => ({ proposals: [p1] });

    const r = renderProposals({ focusProposalId: "prop_keyboard" });
    const checkbox = await waitFor(
      () =>
        r.getByLabelText("Select proposal prop_keyboard") as HTMLInputElement,
    );

    fireEvent.keyDown(document.body, { key: " " });
    expect(checkbox.checked).toBe(true);

    fireEvent.keyDown(document.body, { key: " ", shiftKey: true });
    expect(checkbox.checked).toBe(false);
  });

  test("selection chords select all and clear the active multi-selection", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "security-scan" });
    api.proposals = async () => ({ proposals: [p1, p2] });

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );

    fireEvent.keyDown(document.body, { key: "*" });
    fireEvent.keyDown(document.body, { key: "a" });
    expect(r.getByText("Approve selected (2)")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "*" });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    expect(r.getByText("Approve selected (2)")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
  });

  test("Shift+A and Shift+X open bulk dialogs and buttons show shortcut hints", async () => {
    const p1 = stubProposal("prop_1", "open");
    const p2 = stubProposal("prop_2", "open");
    api.proposals = async () => ({ proposals: [p1, p2] });

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );
    fireEvent.click(r.getByLabelText("Select all proposals"));

    const approveButton = r.getByRole("button", {
      name: /Approve selected \(2\)/,
    });
    const rejectButton = r.getByRole("button", {
      name: /Reject selected \(2\)/,
    });
    expect(approveButton.textContent).toContain("A");
    expect(rejectButton.textContent).toContain("X");

    fireEvent.keyDown(document.body, { key: "A", shiftKey: true });
    expect(
      r.getByRole("dialog", { name: /Approve and queue 2 runs/i }),
    ).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Not yet" }));

    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(document.body, { key: "X", shiftKey: true });
    expect(
      r.getByRole("dialog", { name: /Reject 2 selected proposals/i }),
    ).toBeTruthy();
  });

  test("selection clears on tab switch and history rows are not selectable", async () => {
    const pOpen = stubProposal("prop_open", "open", { agent: "open-agent" });
    const pHist = stubProposal("prop_hist", "approved", {
      agent: "hist-agent",
    });
    api.proposals = async () => ({ proposals: [pOpen] });
    api.proposalHistory = async () => ({ proposals: [pHist] });

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_open")).toBeTruthy(),
    );

    // Select open proposal
    const cb = r.getByLabelText("Select proposal prop_open");
    fireEvent.click(cb);
    expect(r.getByText("Approve selected (1)")).toBeTruthy();

    // Switch to History tab
    const historyTab = r.getByRole("tab", { name: /history/i });
    fireEvent.click(historyTab);

    await waitFor(() => {
      expect(r.getByText("hist-agent")).toBeTruthy();
    });

    // Selection cleared
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    // No checkboxes in History tab
    expect(r.queryByLabelText(/Select proposal/i)).toBeNull();
    expect(r.queryByLabelText("Select all proposals")).toBeNull();

    // Switch back to Open tab — selection remains cleared
    const openTab = r.getByRole("tab", { name: /open/i });
    fireEvent.click(openTab);

    await waitFor(() => {
      expect(r.getByText("open-agent")).toBeTruthy();
    });
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
    const cbAfter = r.getByLabelText(
      "Select proposal prop_open",
    ) as HTMLInputElement;
    expect(cbAfter.checked).toBe(false);
  });
});

describe("Proposals component harness: selection & detail view", () => {
  test("clicking a row selects the proposal via onSelectProposal", async () => {
    const onSelectProposal = mock(() => {});
    const p1 = stubProposal("prop_click_test", "open", {
      agent: "agent-click-test",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByText } = renderProposals({ onSelectProposal });

        const cell = await waitFor(() => getByText("agent-click-test"));
        const row = cell.closest("tr");
        expect(row).toBeTruthy();
        fireEvent.click(row!);

        expect(onSelectProposal).toHaveBeenCalledWith("prop_click_test");
      },
    );
  });

  test("focusProposalId highlights the selected row and renders the spec detail panel", async () => {
    const p1 = stubProposal("prop_selected_1", "open", {
      agent: "triage-scan",
      reason: "Needs triage review",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { container, getAllByText } = renderProposals({
          focusProposalId: "prop_selected_1",
        });

        const selectedRow = await waitFor(() => {
          const el = container.querySelector("tr.row-selected");
          if (!el) throw new Error("selected row not highlighted");
          return el;
        });
        expect(selectedRow).toBeTruthy();

        // Detail pane renders reason and proposal id
        await waitFor(() => {
          expect(getAllByText("prop_selected_1").length).toBeGreaterThan(0);
          expect(getAllByText("Needs triage review").length).toBeGreaterThan(0);
        });
      },
    );
  });
});

describe("Proposals component harness: filter retention", () => {
  test("typing in filter input restricts visible proposals and retains matching selection", async () => {
    const p1 = stubProposal("prop_alpha", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_beta", "open", { agent: "review-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByLabelText, container } = renderProposals({
          focusProposalId: "prop_alpha",
        });

        await waitFor(() => container.querySelector("tr.row-selected"));
        expect(container.querySelector("tbody")?.textContent).toContain(
          "review-scan",
        );

        const filterInput = getByLabelText(
          "Filter proposals",
        ) as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain(
            "triage-scan",
          );
          expect(container.querySelector("tbody")?.textContent).not.toContain(
            "review-scan",
          );
        });

        // Selected proposal remains highlighted
        const selectedRow = container.querySelector("tr.row-selected");
        expect(selectedRow).toBeTruthy();
      },
    );
  });
});

describe("Proposals expiration and reason presentation (WM-547)", () => {
  test("filterOpenProposals keeps TTL-expired proposals out of Open", () => {
    const now = Date.now();
    const expired = stubProposal("prop_expired", "open", {
      created_at: new Date(now - 10_000).toISOString(),
      ttl_seconds: 1,
    });
    const active = stubProposal("prop_active", "open", {
      created_at: new Date(now - 1_000).toISOString(),
      ttl_seconds: 300,
    });

    expect(
      filterOpenProposals([expired, active], now, false).map((p) => p.id),
    ).toEqual(["prop_active"]);
    expect(
      filterOpenProposals([expired, active], now, true).map((p) => p.id),
    ).toEqual(["prop_expired"]);
  });

  test("expired detail disables approval with a reason and the Expired filter can be cleared", async () => {
    const now = Date.now();
    const rawReason = "auto_approval_ineligible:proposal_expired";
    const expired = stubProposal("prop_expired", "open", {
      agent: "expired-agent",
      created_at: new Date(now - 10_000).toISOString(),
      ttl_seconds: 1,
      reason: rawReason,
      spec: createRunSpecFixture("run_expired"),
    });
    const active = stubProposal("prop_active", "open", {
      agent: "active-agent",
      created_at: new Date(now).toISOString(),
      ttl_seconds: 300,
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [expired, active] }),
        proposalHistory: async () => ({ proposals: [] }),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({ focusProposalId: expired.id });
        const approve = await waitFor(
          () =>
            r.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement,
        );

        expect(approve.disabled).toBe(true);
        expect(approve.parentElement?.getAttribute("title")).toBe(
          "This proposal has expired and can no longer be approved.",
        );
        // Rendered through the shared reason table (WM-594), not a local map.
        expect(
          r.getAllByText("Not eligible for auto-approval — Proposal expired")
            .length,
        ).toBeGreaterThan(0);
        expect(r.getAllByTitle(rawReason).length).toBeGreaterThan(0);
        expect(r.getByText("Safety & blast radius")).toBeTruthy();

        const expiredRow = r
          .getAllByText("expired-agent")
          .find((node) => node.closest("tr"))
          ?.closest("tr");
        expect(
          Array.from(expiredRow?.querySelectorAll("td") ?? []).some(
            (cell) =>
              cell.classList.contains("min-w-24") &&
              cell.classList.contains("truncate") &&
              cell.classList.contains("whitespace-nowrap"),
          ),
        ).toBe(true);

        // Clearing the chip brings the live proposals back. The focused one is
        // exempt from the chip so the operator keeps the pane they are reading.
        act(() => {
          fireEvent.click(r.getByRole("button", { name: /^Expired/ }));
        });
        await waitFor(() => {
          expect(r.getByText("active-agent")).toBeTruthy();
          expect(r.getAllByText("expired-agent").length).toBeGreaterThan(0);
        });
      },
    );
  });
});

describe("Proposals selection safety under focus and expiry (WM-547)", () => {
  /** Re-render with a different focused row, the way the hash/parent does. */
  function refocus(
    r: ReturnType<typeof renderProposals>,
    focusProposalId: string | null,
  ) {
    r.rerender(
      <Proposals
        connected={true}
        healthPending={false}
        context={{ kind: "all" }}
        onRunQueued={noop}
        focusProposalId={focusProposalId}
        onSelectProposal={noop}
        focusExpired={false}
        onFocusExpiredConsumed={noop}
        onJumpAgent={noop}
        onJumpEvent={noop}
      />,
    );
  }

  test("opening a row to read it keeps the bulk selection", async () => {
    const p1 = stubProposal("prop_bulk_1", "open", { agent: "agent-one" });
    const p2 = stubProposal("prop_bulk_2", "open", { agent: "agent-two" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        proposalHistory: async () => ({ proposals: [] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({ focusProposalId: null });
        await waitFor(() =>
          expect(r.getByLabelText("Select proposal prop_bulk_1")).toBeTruthy(),
        );

        act(() => {
          fireEvent.click(r.getByLabelText("Select proposal prop_bulk_1"));
          fireEvent.click(r.getByLabelText("Select proposal prop_bulk_2"));
        });
        expect(r.getByText("Approve selected (2)")).toBeTruthy();

        // Open one of the ticked rows to read its spec before bulk-approving.
        act(() => refocus(r, "prop_bulk_1"));
        await waitFor(() =>
          expect(r.container.querySelector("tr.row-selected")).toBeTruthy(),
        );

        expect(r.getByRole("toolbar", { name: /bulk actions/i })).toBeTruthy();
        expect(r.getByText("Approve selected (2)")).toBeTruthy();
        expect(
          (r.getByLabelText("Select proposal prop_bulk_2") as HTMLInputElement)
            .checked,
        ).toBe(true);

        // And moving on to the next row keeps it too.
        act(() => refocus(r, "prop_bulk_2"));
        await waitFor(() =>
          expect(r.getByText("Approve selected (2)")).toBeTruthy(),
        );
      },
    );
  });

  test("losing the selection disarms the approve dialog", async () => {
    const p1 = stubProposal("prop_armed_1", "open", {
      agent: "armed-agent",
      spec: createRunSpecFixture("run_armed_1"),
    });
    const p2 = stubProposal("prop_armed_2", "open", {
      agent: "other-agent",
      spec: createRunSpecFixture("run_armed_2"),
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        proposalHistory: async () => ({ proposals: [] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({ focusProposalId: "prop_armed_1" });
        const openApprove = await waitFor(
          () =>
            r.getByRole("button", { name: /^Approve…/ }) as HTMLButtonElement,
        );
        act(() => {
          fireEvent.click(openApprove);
        });
        expect(r.getByText("Approve and queue this run?")).toBeTruthy();

        // The armed proposal is decided elsewhere and leaves the open list, so
        // the dialog unmounts with the detail pane. Write the cache and rerender
        // with the same focus — do not wait for useNow/refetchInterval to paint.
        act(() => {
          r.queryClient.setQueryData(["proposals"], { proposals: [p2] });
          refocus(r, "prop_armed_1");
        });
        expect(r.queryByText("Approve and queue this run?")).toBeNull();

        // Selecting another proposal must not re-open an approve dialog the
        // operator never armed — Enter is bound to its confirm button.
        act(() => refocus(r, "prop_armed_2"));
        expect(r.getAllByText("prop_armed_2").length).toBeGreaterThan(0);
        expect(r.queryByText("Approve and queue this run?")).toBeNull();
      },
    );
  });

  test("a TTL that passes while the row is selected keeps the pane and its expired banner", async () => {
    const t0 = Date.now();
    const nowTicks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((
      handler: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === "function" && ms === 1000) {
        nowTicks.push(() => handler(...args));
      }
      return realSetInterval(handler, ms, ...args);
    }) as typeof setInterval;

    try {
      const live = stubProposal("prop_ticking", "open", {
        agent: "ticking-agent",
        created_at: new Date(t0).toISOString(),
        ttl_seconds: 1,
        spec: createRunSpecFixture("run_ticking"),
      });

      await withApi(
        {
          proposals: async () => ({ proposals: [live] }),
          proposalHistory: async () => ({ proposals: [] }),
          status: async () => createStatusFixture(),
          runs: async () => ({ runs: [] }),
          events: async () => ({ events: [] }),
        },
        async () => {
          const r = renderProposals({ focusProposalId: "prop_ticking" });
          const approve = await waitFor(
            () =>
              r.getByRole("button", { name: /^Approve…/ }) as HTMLButtonElement,
          );
          expect(approve.disabled).toBe(false);

          // 1s fixture TTL elapses; fire useNow's interval instead of waiting
          // a real second. Patch Date.now only for that tick — waitFor uses it
          // as its timeout clock, so a freeze during mount hangs the suite.
          const realDateNow = Date.now;
          Date.now = () => t0 + 2_000;
          try {
            act(() => {
              for (const tick of nowTicks) tick();
            });
          } finally {
            Date.now = realDateNow;
          }
          const b = r.getByRole("button", {
            name: /^Approve…/,
          }) as HTMLButtonElement;
          expect(b.disabled).toBe(true);
          expect(b.parentElement?.getAttribute("title")).toBe(
            "This proposal has expired and can no longer be approved.",
          );
        },
      );
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});

describe("Proposals component harness: cross-tab reveal", () => {
  test("History groups expired proposals when empty status groups are shown", async () => {
    localStorage.setItem(
      "evrt-display-proposals-history",
      JSON.stringify({ groupBy: "status", showEmpty: true }),
    );
    const expired = stubProposal("prop_expired_history", "expired", {
      agent: "expired-history-agent",
      decided_at: NOW,
      decided_by: "serve",
    });
    api.proposalHistory = async () => ({ proposals: [expired] });

    const r = renderProposals();
    fireEvent.click(r.getByRole("tab", { name: /^History/i }));

    await waitFor(() => {
      expect(r.getByText("expired-history-agent")).toBeTruthy();
      expect(r.getByRole("button", { name: /expired\s+1/i })).toBeTruthy();
    });
  });

  test("switches tab to History when focusProposalId is a decided proposal", async () => {
    const pOpen = stubProposal("prop_open_1", "open", { agent: "agent-open" });
    const pDecided = stubProposal("prop_decided_1", "approved", {
      agent: "agent-decided",
      decided_at: NOW,
      decided_by: "operator",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [pOpen] }),
        proposalHistory: async () => ({ proposals: [pDecided] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        // Start on Open tab with no selection
        const { getByRole, container, rerender } = renderProposals({});

        await waitFor(() => {
          const openTab = getByRole("tab", { name: /^Open/i });
          expect(openTab.getAttribute("aria-selected")).toBe("true");
        });

        // Focus the decided proposal
        rerender(
          <Proposals
            connected={true}
            healthPending={false}
            context={{ kind: "all" }}
            onRunQueued={noop}
            focusProposalId="prop_decided_1"
            onSelectProposal={noop}
            focusExpired={false}
            onFocusExpiredConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Should switch to History tab and render the decided proposal
        await waitFor(() => {
          const historyTab = getByRole("tab", { name: /^History/i });
          expect(historyTab.getAttribute("aria-selected")).toBe("true");
          expect(container.querySelector("tbody")?.textContent).toContain(
            "agent-decided",
          );
        });
      },
    );
  });

  test("clears active text filter when focusProposalId is hidden by the filter", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "review-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderProposals({});

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain(
            "triage-scan",
          );
        });

        // Filter for agent triage, hiding prop_2
        const filterInput = getByLabelText(
          "Filter proposals",
        ) as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).not.toContain(
            "review-scan",
          );
        });

        // Focus prop_2 (which was hidden by the filter)
        rerender(
          <Proposals
            connected={true}
            healthPending={false}
            context={{ kind: "all" }}
            onRunQueued={noop}
            focusProposalId="prop_2"
            onSelectProposal={noop}
            focusExpired={false}
            onFocusExpiredConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Filter should be cleared to reveal prop_2
        await waitFor(() => {
          const input = getByLabelText("Filter proposals") as HTMLInputElement;
          expect(input.value).toBe("");
          expect(container.querySelector("tbody")?.textContent).toContain(
            "review-scan",
          );
        });
      },
    );
  });

  test("retains active text filter when focusProposalId is already visible under that filter", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "triage-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderProposals({});

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain(
            "triage-scan",
          );
        });

        const filterInput = getByLabelText(
          "Filter proposals",
        ) as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain(
            "triage-scan",
          );
        });

        // Focus prop_1 (already visible under agent:triage-scan)
        rerender(
          <Proposals
            connected={true}
            healthPending={false}
            context={{ kind: "all" }}
            onRunQueued={noop}
            focusProposalId="prop_1"
            onSelectProposal={noop}
            focusExpired={false}
            onFocusExpiredConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Filter is retained
        await waitFor(() => {
          const input = getByLabelText("Filter proposals") as HTMLInputElement;
          expect(input.value).toBe("agent:triage-scan");
          expect(container.querySelector("tbody")?.textContent).toContain(
            "triage-scan",
          );
        });
      },
    );
  });

  test("focusExpired prop sets open tab, filters to expired proposals, and calls onFocusExpiredConsumed", async () => {
    const onFocusExpiredConsumed = mock(() => {});
    const pExpired = stubProposal("prop_exp", "open", {
      expired: true,
      agent: "agent-expired",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      ttl_seconds: 1,
    });
    const pActive = stubProposal("prop_act", "open", {
      expired: false,
      agent: "agent-active",
      created_at: new Date().toISOString(),
      ttl_seconds: 300,
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [pExpired, pActive] }),
        status: async () =>
          createStatusFixture({ proposals: { open: 2, expired: 1 } }),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByRole, container } = renderProposals({
          focusExpired: true,
          onFocusExpiredConsumed,
        });

        await waitFor(() => {
          const openTab = getByRole("tab", { name: /^Open/i });
          expect(openTab.getAttribute("aria-selected")).toBe("true");
          expect(onFocusExpiredConsumed).toHaveBeenCalled();
          expect(container.querySelector("tbody")?.textContent).toContain(
            "agent-expired",
          );
          expect(container.querySelector("tbody")?.textContent).not.toContain(
            "agent-active",
          );
        });
      },
    );
  });
});

describe("Proposals bulk confirm, reject reason, replan halt (WM-141)", () => {
  let origProposals: typeof api.proposals;
  let origProposalHistory: typeof api.proposalHistory;
  let origStatus: typeof api.status;
  let origRuns: typeof api.runs;
  let origEvents: typeof api.events;
  let origAgents: typeof api.agents;
  let origApprove: typeof api.approve;
  let origReject: typeof api.reject;

  beforeEach(() => {
    origProposals = api.proposals;
    origProposalHistory = api.proposalHistory;
    origStatus = api.status;
    origRuns = api.runs;
    origEvents = api.events;
    origAgents = api.agents;
    origApprove = api.approve;
    origReject = api.reject;

    api.status = async () => stubStatus();
    api.proposals = async () => ({ proposals: [] });
    api.runs = async () => ({ runs: [] });
    api.events = async () => ({ events: [] });
    api.agents = async () => ({
      agents: [],
      edges: {},
      eventTypes: [],
      contracts: {},
    });
    api.proposalHistory = async () => ({ proposals: [] });
  });

  afterEach(() => {
    api.proposals = origProposals;
    api.proposalHistory = origProposalHistory;
    api.status = origStatus;
    api.runs = origRuns;
    api.events = origEvents;
    api.agents = origAgents;
    api.approve = origApprove;
    api.reject = origReject;
  });

  test("bulk approve does not call api.approve until confirm", async () => {
    const p1 = stubProposal("prop_1", "open", {
      agent: "triage-scan",
      spec: createRunSpecFixture("run_prop_1", {
        agent: "triage-scan",
        adapter: "claude",
        capabilities: ["read"],
        timeoutSeconds: 600,
        maxAttempts: 4,
      }),
    });
    const p2 = stubProposal("prop_2", "open", {
      agent: "security-scan",
      spec: createRunSpecFixture("run_prop_2", {
        agent: "security-scan",
        adapter: "codex",
        capabilities: ["net"],
        timeoutSeconds: 120,
        maxAttempts: 2,
      }),
    });
    const stale = stubProposal("prop_stale", "open", {
      decision: "run",
      runId: "run_stale",
      agent: "stale-agent",
    });
    api.proposals = async () => ({ proposals: [p1, p2, stale] });
    api.runs = async () => ({
      runs: [
        createRunListItemFixture({
          runId: "run_stale",
          state: "CANCELLED",
          agent: "stale-agent",
        }),
      ],
    });

    const approvedIds: string[] = [];
    api.approve = async (id: string) => {
      approvedIds.push(id);
      return {
        approved: true,
        runId: `run_${id}`,
        proposal: undefined,
        replanned: false,
      };
    };

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );

    fireEvent.click(r.getByLabelText("Select all proposals"));
    fireEvent.click(r.getByText("Approve selected (2)"));

    expect(approvedIds).toEqual([]);
    const dialog = r.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toMatch(/triage-scan/);
    expect(dialog.textContent).toMatch(/security-scan/);
    expect(dialog.textContent).toMatch(/read/);
    expect(dialog.textContent).toMatch(/net/);
    expect(dialog.textContent).toMatch(/600s/);
    expect(dialog.textContent).toMatch(/120s/);
    expect(dialog.querySelectorAll('[title="adapter"]')).toHaveLength(2);
    expect(dialog.querySelectorAll('[title="attempts"]')).toHaveLength(2);
    expect(dialog.querySelectorAll('[title="ttl"]')).toHaveLength(2);
    expect(dialog.textContent).toContain("timeoutSeconds");
    expect(dialog.textContent).not.toMatch(/stale-agent/);

    await act(async () => {
      fireEvent.click(r.getByRole("button", { name: "Approve and queue" }));
    });

    expect(approvedIds).toEqual(["prop_1", "prop_2"]);
  });

  test("dismiss/reject never fires without a trimmed reason", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    api.proposals = async () => ({ proposals: [p1] });

    const rejectedCalls: { id: string; why?: string }[] = [];
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals({ focusProposalId: "prop_1" });
    await waitFor(() =>
      expect(r.getByRole("button", { name: /^Reject/ })).toBeTruthy(),
    );

    expect(r.queryByRole("button", { name: /^Dismiss$/ })).toBeNull();
    expect(rejectedCalls).toEqual([]);

    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const confirm = await waitFor(
      () => r.getByRole("button", { name: "Confirm" }) as HTMLButtonElement,
    );
    expect(confirm.disabled).toBe(true);

    const reasonInput = r.getByPlaceholderText(
      /Reason \(required/i,
    ) as HTMLInputElement;
    await act(async () => {
      changeInput(reasonInput, "   ");
    });
    expect(
      (r.getByRole("button", { name: "Confirm" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(reasonInput, { key: "Enter" });
    expect(rejectedCalls).toEqual([]);

    await act(async () => {
      changeInput(reasonInput, " Scope too wide ");
    });
    await act(async () => {
      fireEvent.click(r.getByRole("button", { name: "Confirm" }));
    });
    expect(rejectedCalls).toEqual([{ id: "prop_1", why: "Scope too wide" }]);
  });

  test("one stubbed replan response does not silently continue bulk approve", async () => {
    const p1 = stubProposal("prop_1", "open", {
      agent: "triage-scan",
      spec: createRunSpecFixture("run_prop_1", { timeoutSeconds: 600 }),
    });
    const p2 = stubProposal("prop_2", "open", { agent: "security-scan" });
    const replacement = stubProposal("prop_1b", "open", {
      agent: "triage-scan",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      ttl_seconds: 1,
      spec: createRunSpecFixture("run_prop_1b", {
        timeoutSeconds: 900,
        agent: "triage-scan",
      }),
    });
    api.proposals = async () => ({ proposals: [p1, p2] });

    const approveCalls: string[] = [];
    api.approve = async (id: string) => {
      approveCalls.push(id);
      if (id === "prop_1") {
        return {
          approved: false,
          runId: undefined,
          replanned: true,
          proposal: replacement,
        };
      }
      return {
        approved: true,
        runId: `run_${id}`,
        proposal: undefined,
        replanned: false,
      };
    };

    const r = renderProposals();
    await waitFor(() =>
      expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy(),
    );
    fireEvent.click(r.getByLabelText("Select all proposals"));
    fireEvent.click(r.getByText("Approve selected (2)"));

    const confirm = r.queryByRole("button", { name: "Approve and queue" });
    if (confirm) {
      await act(async () => {
        fireEvent.click(confirm);
      });
    } else {
      await act(async () => {});
    }

    await waitFor(() => expect(approveCalls.length).toBeGreaterThan(0));
    expect(approveCalls).toEqual(["prop_1"]);
    expect(r.getByText(/re-planned against current state/i)).toBeTruthy();
    expect(
      r.getByText(
        /nothing runs until you approve the new proposal explicitly/i,
      ),
    ).toBeTruthy();
    const approveReplacement = r.getByRole("button", {
      name: /Approve new proposal/i,
    }) as HTMLButtonElement;
    expect(approveReplacement.disabled).toBe(true);
    expect(approveReplacement.parentElement?.getAttribute("title")).toBe(
      "This replacement proposal has expired and can no longer be approved.",
    );
  });

  test("repo context shows a persistent caption that the list is scoped to that repo", async () => {
    const p1 = stubProposal("prop_1", "open", {
      repos: ["repo-test"],
      agent: "triage-scan",
    });
    api.proposals = async () => ({ proposals: [p1] });

    const r = renderProposals({ context: { kind: "repo", name: "repo-test" } });
    await waitFor(() => expect(r.getByText("triage-scan")).toBeTruthy());
    expect(r.getByText("Showing proposals that name repo-test.")).toBeTruthy();
  });

  test("repo caption counts open proposals hidden because they do not name the repo", async () => {
    const matching = stubProposal("prop_matching", "open", {
      repos: ["repo-test"],
      agent: "triage-scan",
    });
    const unscoped = stubProposal("prop_unscoped", "open", {
      repos: [],
      agent: "human-needed",
    });
    const otherRepo = stubProposal("prop_other", "open", {
      repos: ["another-repo"],
      agent: "review-scan",
    });
    api.proposals = async () => ({
      proposals: [matching, unscoped, otherRepo],
    });

    const r = renderProposals({ context: { kind: "repo", name: "repo-test" } });
    await waitFor(() => expect(r.getByText("triage-scan")).toBeTruthy());
    expect(r.queryByText("human-needed")).toBeNull();
    expect(r.queryByText("review-scan")).toBeNull();
    expect(
      r.getByText(
        "Showing proposals that name repo-test. 2 open proposals do not name this repo and are hidden.",
      ),
    ).toBeTruthy();
  });

  test("origin column title is the full eventId; reason column title is p.reason", async () => {
    const eventId = "evt_abc123_full_event_id";
    const reason = "Needs a very long planner reason for the truncated cell";
    const p1 = stubProposal("prop_1", "open", {
      eventId,
      eventSource: "github",
      reason,
      agent: "triage-scan",
    });
    api.proposals = async () => ({ proposals: [p1] });
    api.events = async () => ({
      events: [
        createEventFixture({
          eventId,
          source: "github",
          type: "pull_request.opened",
        }),
      ],
    });

    const r = renderProposals();
    const origin = await waitFor(() => r.getByTitle(eventId));
    expect(origin.closest("td")?.getAttribute("title")).toBe(eventId);
    const reasonCell = r.getByText(reason);
    expect(reasonCell.closest("td")?.getAttribute("title")).toBe(reason);
  });
});

describe("Proposals copy chords and hints (WM-233)", () => {
  test("copy chords: c (id), c l (link) and utility hints", async () => {
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

    const proposalId = "prop_12345678-abcd-ef01-2345-6789abcdef01";
    const p1 = stubProposal(proposalId, "open", { agent: "triage-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({ focusProposalId: proposalId });
        const idBtn = await r.findByRole("button", {
          name: "Copy proposal id (c)",
        });

        // Verify icon-action tooltips preserve shortcut discoverability.
        expect(
          idBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
        ).toBe("Copy proposal id · c");
        const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
        expect(
          linkBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
        ).toBe("Copy link · c l");

        // 1. Press 'c' -> copies proposalId
        fireEvent.keyDown(document.body, { key: "c" });
        expect(written).toBe(proposalId);

        // 2. Press 'l' immediately after 'c' -> 'c l' copies link
        fireEvent.keyDown(document.body, { key: "l" });
        expect(written).toBe(window.location.href);
      },
    );
  });
});

describe("Proposals single-proposal reject dialog hotkeys (WM-236)", () => {
  let origProposals: typeof api.proposals;
  let origReject: typeof api.reject;

  beforeEach(() => {
    origProposals = api.proposals;
    origReject = api.reject;
  });

  afterEach(() => {
    api.proposals = origProposals;
    api.reject = origReject;
  });

  test("Cmd+Enter and Ctrl+Enter submit reject dialog when valid and connected", async () => {
    const p1 = stubProposal("prop_reject_hotkey", "open", {
      agent: "triage-scan",
    });
    const rejectedCalls: { id: string; why?: string }[] = [];
    api.proposals = async () => ({ proposals: [p1] });
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals({
      focusProposalId: "prop_reject_hotkey",
      connected: true,
    });
    await waitFor(() =>
      expect(r.getByRole("button", { name: /^Reject/ })).toBeTruthy(),
    );

    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const reasonInput = await waitFor(
      () => r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement,
    );

    // Enter with metaKey (Cmd+Enter)
    await act(async () => {
      changeInput(reasonInput, "Not needed right now");
    });
    fireEvent.keyDown(reasonInput, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(rejectedCalls).toEqual([
        { id: "prop_reject_hotkey", why: "Not needed right now" },
      ]),
    );

    // Ctrl+Enter also works on reopened dialog
    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const reasonInput2 = await waitFor(
      () => r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement,
    );

    await act(async () => {
      changeInput(reasonInput2, "Second rejection reason");
    });
    fireEvent.keyDown(reasonInput2, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(rejectedCalls).toEqual([
        { id: "prop_reject_hotkey", why: "Not needed right now" },
        { id: "prop_reject_hotkey", why: "Second rejection reason" },
      ]),
    );
  });

  test("Cmd+Enter does not submit when reason is empty or when disconnected", async () => {
    const p1 = stubProposal("prop_reject_disconn", "open", {
      agent: "triage-scan",
    });
    const rejectedCalls: { id: string; why?: string }[] = [];
    api.proposals = async () => ({ proposals: [p1] });
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals({
      focusProposalId: "prop_reject_disconn",
      connected: true,
    });
    await waitFor(() =>
      expect(r.getByRole("button", { name: /^Reject/ })).toBeTruthy(),
    );

    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const reasonInput = await waitFor(
      () => r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement,
    );

    // Empty / whitespace reason does not submit on Cmd+Enter
    await act(async () => {
      changeInput(reasonInput, "   ");
    });
    fireEvent.keyDown(reasonInput, { key: "Enter", metaKey: true });
    expect(rejectedCalls).toEqual([]);

    // Fill valid reason but disconnect
    await act(async () => {
      changeInput(reasonInput, "Valid reason");
    });

    // Rerender with connected={false}
    r.rerender(
      <Proposals
        connected={false}
        healthPending={false}
        context={{ kind: "all" }}
        onRunQueued={noop}
        focusProposalId="prop_reject_disconn"
        onSelectProposal={noop}
        focusExpired={false}
        onFocusExpiredConsumed={noop}
        onJumpAgent={noop}
        onJumpEvent={noop}
      />,
    );

    fireEvent.keyDown(reasonInput, { key: "Enter", metaKey: true });
    expect(rejectedCalls).toEqual([]);
  });

  test("Enter key submits single-proposal approve dialog when connected", async () => {
    const p1 = stubProposal("prop_approve_hotkey", "open", {
      agent: "triage-scan",
      decision: "run",
    });
    const approvedCalls: string[] = [];
    api.proposals = async () => ({ proposals: [p1] });
    api.approve = async (id: string) => {
      approvedCalls.push(id);
      return { approved: true, runId: "run_approved_1" };
    };

    const r = renderProposals({
      focusProposalId: "prop_approve_hotkey",
      connected: true,
    });
    const approveBtn = await waitFor(() =>
      r.getByRole("button", { name: /^Approve/ }),
    );
    expect(approveBtn.textContent).toContain("a");

    // Open confirmation dialog
    fireEvent.click(approveBtn);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    // Press Enter to confirm approval
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(approvedCalls).toEqual(["prop_approve_hotkey"]));
  });
});

describe("Proposals long-list window (WM-563)", () => {
  test("a 2,000-row fixture mounts fewer than 200 table rows and pages forward", async () => {
    const proposals = Array.from({ length: 2000 }, (_, i) =>
      stubProposal(`prop_window_${i}`),
    );
    await withApi(
      {
        proposals: async () => ({ proposals }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const r = renderProposals();
        const next = await r.findByRole("button", { name: "Next" });
        expect(r.container.querySelectorAll("tbody tr").length).toBeLessThan(
          200,
        );
        expect(
          r.queryByLabelText("Select proposal prop_window_100"),
        ).toBeNull();
        fireEvent.click(next);
        await waitFor(() => {
          expect(
            r.getByLabelText("Select proposal prop_window_100"),
          ).toBeTruthy();
        });
        expect(r.container.querySelectorAll("tbody tr").length).toBeLessThan(
          200,
        );
      },
    );
  });
});

describe("Proposals approval modal pinned footer (WM-829)", () => {
  test("renders approve modal with pinned footer containing action buttons", async () => {
    const proposal = stubProposal("prop_pinned_footer");
    let approvedId: string | null = null;
    await withApi(
      {
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => stubStatus(),
        approve: async (id: string) => {
          approvedId = id;
          return { approved: true, runId: `run_${id}` };
        },
      },
      async () => {
        const r = renderProposals({
          focusProposalId: proposal.id,
        });

        const approveBtn = await r.findByRole("button", { name: /^Approve/ });
        fireEvent.click(approveBtn);

        const dialog = await r.findByRole("dialog", {
          name: "Approve and queue this run?",
        });
        expect(dialog.className).toContain("flex flex-col");

        const confirmBtn = r.getByRole("button", { name: /Approve and queue/ });
        const notYetBtn = r.getByRole("button", { name: "Not yet" });

        // Confirm and cancel buttons are inside the pinned footer container with border-t
        expect(confirmBtn.closest("div")?.className).toContain("border-t");
        expect(notYetBtn.closest("div")?.className).toContain("border-t");

        fireEvent.click(confirmBtn);
        await waitFor(() => expect(approvedId).toBe("prop_pinned_footer"));
      },
    );
  });
});

describe("Proposals hover checkboxes and Shift+Click range selection (WM-885)", () => {
  test("checkboxes have hover-only visibility when none selected and full opacity when selected", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "security-scan" });
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const r = renderProposals();
    const headerCb = (await r.findByLabelText(
      "Select all proposals",
    )) as HTMLInputElement;
    const rowCb1 = r.getByLabelText(
      "Select proposal prop_1",
    ) as HTMLInputElement;
    const rowCb2 = r.getByLabelText(
      "Select proposal prop_2",
    ) as HTMLInputElement;

    expect(headerCb.className).toContain(
      "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
    );
    expect(rowCb1.className).toContain(
      "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
    );
    expect(rowCb2.className).toContain(
      "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
    );

    expect(headerCb.closest("thead")?.className).toContain("group");
    expect(rowCb1.closest("tr")?.className).toContain("group");
    expect(rowCb2.closest("tr")?.className).toContain("group");

    fireEvent.click(rowCb1);
    expect(headerCb.className).toContain("opacity-100");
    expect(rowCb1.className).toContain("opacity-100");
    expect(rowCb2.className).toContain("opacity-100");
  });

  test("Shift+Click selects and deselects contiguous range of proposals", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "agent-1" });
    const p2 = stubProposal("prop_2", "open", { agent: "agent-2" });
    const p3 = stubProposal("prop_3", "open", { agent: "agent-3" });
    const p4 = stubProposal("prop_4", "open", { agent: "agent-4" });
    api.proposals = async () => ({ proposals: [p1, p2, p3, p4] });
    api.proposalHistory = async () => ({ proposals: [] });

    const r = renderProposals();
    const cb1 = (await r.findByLabelText(
      "Select proposal prop_1",
    )) as HTMLInputElement;
    const cb2 = r.getByLabelText("Select proposal prop_2") as HTMLInputElement;
    const cb3 = r.getByLabelText("Select proposal prop_3") as HTMLInputElement;
    const cb4 = r.getByLabelText("Select proposal prop_4") as HTMLInputElement;

    // Click proposal 1
    fireEvent.click(cb1);
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(false);
    expect(cb3.checked).toBe(false);
    expect(cb4.checked).toBe(false);

    // Shift+Click proposal 3 -> selects prop_1, prop_2, prop_3
    fireEvent.click(cb3, { shiftKey: true });
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);
    expect(cb3.checked).toBe(true);
    expect(cb4.checked).toBe(false);

    // Shift+Click checked proposal 2 -> deselects range between anchor (prop_3) and target (prop_2)
    fireEvent.click(cb2, { shiftKey: true });
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(false);
    expect(cb3.checked).toBe(false);
    expect(cb4.checked).toBe(false);
  });
});

describe("Proposals navigation shortcuts (WM-875)", () => {
  test("e triggers onJumpEvent and r triggers onRunQueued", async () => {
    let jumpedEvent = "";
    let queuedRun = "";
    const proposal = stubProposal("prop_nav_test", "open", {
      eventId: "evt_origin_123",
      eventSource: "github",
      runId: "run_target_456",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => stubStatus(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({
          focusProposalId: proposal.id,
          onJumpEvent: (source, eventId) => {
            jumpedEvent = `${source}:${eventId}`;
          },
          onRunQueued: (runId) => {
            queuedRun = runId;
          },
        });

        await r.findByRole("heading", { name: "Proposals" });
        await waitFor(() => expect(r.getByText("evt_origin_123")).toBeTruthy());

        // Press 'e' to jump to origin event
        fireEvent.keyDown(document.body, { key: "e" });
        expect(jumpedEvent).toBe("github:evt_origin_123");

        // Press 'r' to open run
        fireEvent.keyDown(document.body, { key: "r" });
        expect(queuedRun).toBe("run_target_456");
      },
    );
  });
});

describe("Proposals detail pane width (WM-685)", () => {
  test("detail pane uses the canonical 440px width", async () => {
    const proposal = stubProposal("prop_pane_width", "open", {
      reason: "Needs width review",
    });
    await withApi(
      {
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const view = renderProposals({ focusProposalId: "prop_pane_width" });
        await waitFor(() => view.getAllByText("prop_pane_width").length > 0);
        const className =
          view.container.querySelector("aside")?.className ?? "";
        expect(className).toContain("w-[440px]");
        expect(className).not.toContain("w-[460px]");
      },
    );
  });
});

describe("Proposals hook decisions (WM-864)", () => {
  test("detail pane lists hook id, decision, and reason for each hook", async () => {
    stubProposalDetailFetch([
      {
        id: 1,
        at: NOW,
        point: "approve.before",
        hookId: "factory:escalation-labels",
        source: "builtin",
        proposalId: "prop_hooks",
        runId: "run_hooks",
        decision: "allow",
        reason: null,
        durationMs: 2,
        error: null,
      },
      {
        id: 2,
        at: NOW,
        point: "approve.before",
        hookId: "acme/x:gate",
        source: "extension:acme/x",
        proposalId: "prop_hooks",
        runId: "run_hooks",
        decision: "deny",
        reason: "repo_gated",
        durationMs: 4,
        error: null,
      },
    ]);
    const proposal = stubProposal("prop_hooks", "open", {
      agent: "dispatch@1",
      reason: "auto_approval_ineligible:dispatch_ineligible:repo_gated",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({ focusProposalId: "prop_hooks" });
        await waitFor(() => r.getByText("factory:escalation-labels"));
        expect(r.getByText("acme/x:gate")).toBeTruthy();
        expect(r.getByText("allow")).toBeTruthy();
        expect(r.getByText("deny")).toBeTruthy();
        expect(r.getByText("repo_gated")).toBeTruthy();
        expect(r.getByText("Hook decisions")).toBeTruthy();
      },
    );
  });

  test("empty hookDecisions still names the section so the operator knows none ran", async () => {
    stubProposalDetailFetch([]);
    const proposal = stubProposal("prop_hooks_empty", "open");

    await withApi(
      {
        proposals: async () => ({ proposals: [proposal] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const r = renderProposals({ focusProposalId: "prop_hooks_empty" });
        await waitFor(() => r.getByText("Hook decisions"));
        expect(r.getByText("No hook ran for this proposal.")).toBeTruthy();
      },
    );
  });
});

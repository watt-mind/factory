import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Proposals } from "./Proposals";
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
});

const noop = () => {};
const NOW = new Date().toISOString();

function stubStatus(): StatusView {
  return createStatusFixture({
    proposals: { open: 2, expired: 0 },
    workers: { live: 1, busy: 0, stale: 0 },
  });
}

function stubProposal(id: string, status = "open", overrides?: Partial<Proposal>): Proposal {
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
    api.agents = async () => ({ agents: [], edges: {}, eventTypes: [], contracts: {} });
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
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

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
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

    const selectAll = r.getByLabelText("Select all proposals") as HTMLInputElement;
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
    const filterInput = r.getByLabelText("Filter proposals") as HTMLInputElement;
    await act(async () => {
      changeInput(filterInput, "security");
    });

    expect(r.queryByLabelText("Select proposal prop_1")).toBeNull();
    expect(r.getByLabelText("Select proposal prop_2")).toBeTruthy();

    // Click select all under filter — only 1 matching row should be selected
    const selectAllAfter = r.getByLabelText("Select all proposals") as HTMLInputElement;
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
      return { approved: true, runId: `run_${id}`, proposal: undefined, replanned: false };
    };

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

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
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

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

  test("selection clears on tab switch and history rows are not selectable", async () => {
    const pOpen = stubProposal("prop_open", "open", { agent: "open-agent" });
    const pHist = stubProposal("prop_hist", "approved", { agent: "hist-agent" });
    api.proposals = async () => ({ proposals: [pOpen] });
    api.proposalHistory = async () => ({ proposals: [pHist] });

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_open")).toBeTruthy());

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
    const cbAfter = r.getByLabelText("Select proposal prop_open") as HTMLInputElement;
    expect(cbAfter.checked).toBe(false);
  });
});

describe("Proposals component harness: selection & detail view", () => {
  test("clicking a row selects the proposal via onSelectProposal", async () => {
    const onSelectProposal = mock(() => {});
    const p1 = stubProposal("prop_click_test", "open", { agent: "agent-click-test" });

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
        const { container, getAllByText } = renderProposals({ focusProposalId: "prop_selected_1" });

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
        const { getByLabelText, container } = renderProposals({ focusProposalId: "prop_alpha" });

        await waitFor(() => container.querySelector("tr.row-selected"));
        expect(container.querySelector("tbody")?.textContent).toContain("review-scan");

        const filterInput = getByLabelText("Filter proposals") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
          expect(container.querySelector("tbody")?.textContent).not.toContain("review-scan");
        });

        // Selected proposal remains highlighted
        const selectedRow = container.querySelector("tr.row-selected");
        expect(selectedRow).toBeTruthy();
      },
    );
  });
});

describe("Proposals component harness: cross-tab reveal", () => {
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
          expect(container.querySelector("tbody")?.textContent).toContain("agent-decided");
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
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });

        // Filter for agent triage, hiding prop_2
        const filterInput = getByLabelText("Filter proposals") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).not.toContain("review-scan");
        });

        // Focus prop_2 (which was hidden by the filter)
        rerender(
          <Proposals
            connected={true}
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
          expect(container.querySelector("tbody")?.textContent).toContain("review-scan");
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
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });

        const filterInput = getByLabelText("Filter proposals") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });

        // Focus prop_1 (already visible under agent:triage-scan)
        rerender(
          <Proposals
            connected={true}
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
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });
      },
    );
  });

  test("focusExpired prop sets open tab, filters to expired proposals, and calls onFocusExpiredConsumed", async () => {
    const onFocusExpiredConsumed = mock(() => {});
    const pExpired = stubProposal("prop_exp", "open", { expired: true, agent: "agent-expired" });
    const pActive = stubProposal("prop_act", "open", { expired: false, agent: "agent-active" });

    await withApi(
      {
        proposals: async () => ({ proposals: [pExpired, pActive] }),
        status: async () => createStatusFixture({ proposals: { open: 2, expired: 1 } }),
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
          expect(container.querySelector("tbody")?.textContent).toContain("agent-expired");
          expect(container.querySelector("tbody")?.textContent).not.toContain("agent-active");
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
    api.agents = async () => ({ agents: [], edges: {}, eventTypes: [], contracts: {} });
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
      spec: createRunSpecFixture("run_prop_1", { agent: "triage-scan", capabilities: ["read"], timeoutSeconds: 600 }),
    });
    const p2 = stubProposal("prop_2", "open", {
      agent: "security-scan",
      spec: createRunSpecFixture("run_prop_2", { agent: "security-scan", capabilities: ["net"], timeoutSeconds: 120 }),
    });
    const stale = stubProposal("prop_stale", "open", {
      decision: "run",
      runId: "run_stale",
      agent: "stale-agent",
    });
    api.proposals = async () => ({ proposals: [p1, p2, stale] });
    api.runs = async () => ({
      runs: [createRunListItemFixture({ runId: "run_stale", state: "CANCELLED", agent: "stale-agent" })],
    });

    const approvedIds: string[] = [];
    api.approve = async (id: string) => {
      approvedIds.push(id);
      return { approved: true, runId: `run_${id}`, proposal: undefined, replanned: false };
    };

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

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
    await waitFor(() => expect(r.getByRole("button", { name: /^Reject/ })).toBeTruthy());

    const dismiss = r.queryByRole("button", { name: /^Dismiss$/ });
    if (dismiss) fireEvent.click(dismiss);
    expect(rejectedCalls).toEqual([]);

    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const confirm = await waitFor(() => r.getByRole("button", { name: "Confirm" }) as HTMLButtonElement);
    expect(confirm.disabled).toBe(true);

    const reasonInput = r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement;
    await act(async () => {
      changeInput(reasonInput, "   ");
    });
    expect((r.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
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
      spec: createRunSpecFixture("run_prop_1b", { timeoutSeconds: 900, agent: "triage-scan" }),
    });
    api.proposals = async () => ({ proposals: [p1, p2] });

    const approveCalls: string[] = [];
    api.approve = async (id: string) => {
      approveCalls.push(id);
      if (id === "prop_1") {
        return { approved: false, runId: undefined, replanned: true, proposal: replacement };
      }
      return { approved: true, runId: `run_${id}`, proposal: undefined, replanned: false };
    };

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());
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
    expect(r.getByText(/nothing runs until you approve the new proposal explicitly/i)).toBeTruthy();
  });

  test("repo context shows a persistent caption that the list is scoped to that repo", async () => {
    const p1 = stubProposal("prop_1", "open", { repos: ["repo-test"], agent: "triage-scan" });
    api.proposals = async () => ({ proposals: [p1] });

    const r = renderProposals({ context: { kind: "repo", name: "repo-test" } });
    await waitFor(() => expect(r.getByText("triage-scan")).toBeTruthy());
    expect(r.getByText("Showing proposals that name repo-test.")).toBeTruthy();
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
      events: [createEventFixture({ eventId, source: "github", type: "pull_request.opened" })],
    });

    const r = renderProposals();
    const origin = await waitFor(() => r.getByTitle(eventId));
    expect(origin.closest("td")?.getAttribute("title")).toBe(eventId);
    const reasonCell = r.getByText(reason);
    expect(reasonCell.closest("td")?.getAttribute("title")).toBe(reason);
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
    const p1 = stubProposal("prop_reject_hotkey", "open", { agent: "triage-scan" });
    const rejectedCalls: { id: string; why?: string }[] = [];
    api.proposals = async () => ({ proposals: [p1] });
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals({ focusProposalId: "prop_reject_hotkey", connected: true });
    await waitFor(() => expect(r.getByRole("button", { name: /^Reject/ })).toBeTruthy());

    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const reasonInput = await waitFor(() => r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement);

    // Enter with metaKey (Cmd+Enter)
    await act(async () => {
      changeInput(reasonInput, "Not needed right now");
    });
    fireEvent.keyDown(reasonInput, { key: "Enter", metaKey: true });

    await waitFor(() => expect(rejectedCalls).toEqual([{ id: "prop_reject_hotkey", why: "Not needed right now" }]));

    // Ctrl+Enter also works on reopened dialog
    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const reasonInput2 = await waitFor(() => r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement);

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
    const p1 = stubProposal("prop_reject_disconn", "open", { agent: "triage-scan" });
    const rejectedCalls: { id: string; why?: string }[] = [];
    api.proposals = async () => ({ proposals: [p1] });
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals({ focusProposalId: "prop_reject_disconn", connected: true });
    await waitFor(() => expect(r.getByRole("button", { name: /^Reject/ })).toBeTruthy());

    fireEvent.click(r.getByRole("button", { name: /^Reject/ }));
    const reasonInput = await waitFor(() => r.getByPlaceholderText(/Reason \(required/i) as HTMLInputElement);

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
});


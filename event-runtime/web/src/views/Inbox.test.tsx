import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Inbox,
  deliveryState,
  deliveryText,
  displayTitle,
  groupItems,
  groupOf,
  inboxActionPrHref,
  inboxAge,
  itemStatus,
  kindBadgeInRow,
  matchesTab,
  prHref,
  proposalTtlLabel,
  sourceRunId,
  waitingCount,
  waitingLabel,
} from "./Inbox";
import { api } from "../api";
import { attrIcon } from "../components/attrIcons";
import { clearToasts, ToastContainer } from "../components/ui";
import type { InboxItem, Proposal } from "../types";
import { changeInput } from "../test-render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function item(
  overrides: Partial<InboxItem> & Pick<InboxItem, "id" | "kind">,
): InboxItem {
  return {
    severity: "normal",
    title: `${overrides.kind} ${overrides.id}`,
    body: null,
    refs: {},
    source: "serve:notify",
    createdAt: "2026-08-17T10:00:00.000Z",
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedReason: null,
    delivery: {},
    ...overrides,
  };
}

const T0 = "2026-08-17T10:00:00.000Z";
const T1 = "2026-08-17T11:00:00.000Z";
const T2 = "2026-08-17T12:00:00.000Z";

describe("inbox pure helpers", () => {
  test("groups by triage kind and drops empty groups, newest first inside a group", () => {
    const rows = [
      item({ id: "i-ci", kind: "CI RED", createdAt: T2 }),
      item({ id: "i-blocked-new", kind: "BLOCKED", createdAt: T2 }),
      item({ id: "i-blocked-old", kind: "BLOCKED", createdAt: T0 }),
      item({ id: "i-decision", kind: "decision_needed", createdAt: T1 }),
    ];
    const groups = groupItems(rows);
    expect(groups.map((g) => g.group.id)).toEqual(["decide", "red"]);
    expect(groups[0].items.map((i) => i.id)).toEqual([
      "i-blocked-new",
      "i-decision",
      "i-blocked-old",
    ]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["i-ci"]);
  });

  test("every ledger kind lands in a named group; unknown kinds fall through to Other", () => {
    expect(groupOf("RC READY").id).toBe("ready");
    expect(groupOf("SMOKE RED").id).toBe("red");
    expect(groupOf("human_needed").id).toBe("decide");
    expect(groupOf("something_new").id).toBe("other");
  });

  test("status is derived from the timestamps, resolved wins over acked", () => {
    expect(itemStatus(item({ id: "a", kind: "BLOCKED" }))).toBe("open");
    expect(itemStatus(item({ id: "b", kind: "BLOCKED", ackedAt: T1 }))).toBe(
      "acked",
    );
    expect(
      itemStatus(
        item({ id: "c", kind: "BLOCKED", ackedAt: T1, resolvedAt: T2 }),
      ),
    ).toBe("resolved");
    expect(
      matchesTab(item({ id: "d", kind: "BLOCKED", ackedAt: T1 }), "all"),
    ).toBe(true);
    expect(
      matchesTab(item({ id: "e", kind: "BLOCKED", ackedAt: T1 }), "open"),
    ).toBe(false);
  });

  test("delivery: not attempted is neither sent nor failed", () => {
    expect(deliveryState(item({ id: "a", kind: "BLOCKED" }))).toBe("none");
    expect(deliveryText(item({ id: "a", kind: "BLOCKED" }))).toBe(
      "Telegram: not attempted",
    );
    const sent = item({
      id: "b",
      kind: "BLOCKED",
      delivery: { telegram: { sent_at: T1, exit_code: 0, error: null } },
    });
    expect(deliveryState(sent)).toBe("sent");
    expect(deliveryText(sent)).toMatch(/^Telegram: sent .* · exit 0$/);
    const failed = item({
      id: "c",
      kind: "BLOCKED",
      delivery: { telegram: { sent_at: T1, exit_code: 1, error: null } },
    });
    expect(deliveryState(failed)).toBe("failed");
    const errored = item({
      id: "d",
      kind: "BLOCKED",
      delivery: {
        telegram: { sent_at: T1, exit_code: null, error: "spawn ENOENT" },
      },
    });
    expect(deliveryState(errored)).toBe("failed");
    expect(deliveryText(errored)).toContain("spawn ENOENT");
  });

  test("agent sources name the run that raised the item", () => {
    expect(sourceRunId("agent:run_123")).toBe("run_123");
    expect(sourceRunId("serve:notify")).toBeNull();
    expect(sourceRunId("cli")).toBeNull();
  });

  test("displayTitle removes redundant kind and visible issue/PR prefixes", () => {
    expect(
      displayTitle(
        item({
          id: "blocked",
          kind: "BLOCKED",
          title: "BLOCKED WM-303: expand Owned Paths to include the fixture",
          refs: { issue: "WM-303" },
        }),
      ),
    ).toBe("expand Owned Paths to include the fixture");
    expect(
      displayTitle(
        item({
          id: "human",
          kind: "human_needed",
          title: "BLOCKED factory.ticket.reaped reap:CLNT-1393:1786698035",
        }),
      ),
    ).toBe("factory.ticket.reaped reap:CLNT-1393:1786698035");
    expect(
      displayTitle(
        item({
          id: "ci",
          kind: "CI RED",
          title: "CI RED PR#398/WM-398: Verify run failed",
          refs: { issue: "WM-398", pr: "PR#398" },
        }),
      ),
    ).toBe("Verify run failed");
    expect(
      displayTitle(
        item({
          id: "escalated",
          kind: "ESCALATED",
          title: "escalated CLNT-12/PR#7: choose a release",
          refs: { issue: "CLNT-12", pr: "#7", repo: "bj29" },
        }),
      ),
    ).toBe("choose a release");
  });

  test("displayTitle keeps a ref prefix that has no matching chip", () => {
    const row = item({
      id: "a",
      kind: "BLOCKED",
      title: "BLOCKED WM-303: expand paths",
      refs: {},
    });
    expect(displayTitle(row)).toBe("WM-303: expand paths");
    expect(row.title).toBe("BLOCKED WM-303: expand paths");
  });

  test("displayTitle strips a legacy DECISION NEEDED prefix (WM-896)", () => {
    expect(
      displayTitle(
        item({
          id: "legacy",
          kind: "decision_needed",
          title:
            "DECISION NEEDED proposal prop_2dda1ca8-2469-4aab-8908-79c31a5df55b (dispatch@1): expires in 15m",
        }),
      ),
    ).toBe(
      "proposal prop_2dda1ca8-2469-4aab-8908-79c31a5df55b (dispatch@1): expires in 15m",
    );
    expect(
      displayTitle(
        item({
          id: "dispatch",
          kind: "decision_needed",
          title: "Dispatch WM-862 · factory · cursor-grok-4.6-high",
        }),
      ),
    ).toBe("Dispatch WM-862 · factory · cursor-grok-4.6-high");
  });

  test("kindBadgeInRow hides the badge when the group header already names the group", () => {
    const decide = item({ id: "d", kind: "decision_needed" });
    const other = { ...decide, id: "o", kind: "mystery-kind" } as InboxItem;
    expect(kindBadgeInRow(decide, { groupBy: "attention" })).toBe(false);
    expect(kindBadgeInRow(decide, { groupBy: "kind" })).toBe(false);
    expect(kindBadgeInRow(decide, { groupBy: "none" })).toBe(true);
    expect(kindBadgeInRow(decide, { groupBy: "repo" })).toBe(true);
    expect(kindBadgeInRow(other, { groupBy: "attention" })).toBe(true);
  });

  test("proposalTtlLabel is a live countdown and omitted without a TTL", () => {
    const created = "2026-08-19T12:00:00.000Z";
    const now = Date.parse("2026-08-19T12:15:00.000Z");
    expect(proposalTtlLabel(created, 1800, now)).toBe("15m left");
    expect(proposalTtlLabel(created, 1800, now + 16 * 60_000)).toBe("expired");
    expect(proposalTtlLabel(undefined, 1800, now)).toBeNull();
    expect(proposalTtlLabel(created, undefined, now)).toBeNull();
  });

  test("PR refs resolve only with an absolute URL or a known repository", () => {
    expect(
      prHref(
        item({
          id: "url",
          kind: "CI RED",
          refs: { pr: "https://github.com/watt-mind/factory/pull/9" },
        }),
      ),
    ).toBe("https://github.com/watt-mind/factory/pull/9");
    expect(
      prHref(
        item({
          id: "repo",
          kind: "CI RED",
          refs: { pr: "PR#123", repo: "factory" },
        }),
      ),
    ).toBe("https://github.com/watt-mind/factory/pull/123");
    expect(
      prHref(
        item({
          id: "issue",
          kind: "CI RED",
          refs: { pr: "#124", issue: "WM-617" },
        }),
      ),
    ).toBe("https://github.com/watt-mind/factory/pull/124");
    expect(
      prHref(
        item({
          id: "bare",
          kind: "CI RED",
          refs: { pr: "125", repo: "factory" },
        }),
      ),
    ).toBe("https://github.com/watt-mind/factory/pull/125");
    expect(
      inboxActionPrHref(
        item({
          id: "action",
          kind: "SMOKE RED",
          refs: { repo: "factory", pr: "607" },
        }),
      ),
    ).toBe("https://github.com/watt-mind/factory/pull/607");
  });

  // `run`/`runId` stay unmapped by the WM-483 contract (identity labels reserve
  // an empty slot); the run reference renders as text until #2119 decides otherwise.
  test("reference attributes have distinct icons", () => {
    for (const reference of ["proposal", "event", "issue", "pr", "repo"]) {
      expect(attrIcon(reference)).not.toBeNull();
    }
  });

  test("Inbox age preserves hour precision after 24 hours", () => {
    expect(
      inboxAge(
        "2026-08-16T05:30:00.000Z",
        Date.parse("2026-08-17T10:00:00.000Z"),
      ),
    ).toBe("1d 4h ago");
  });

  test("waitingCount is 1 plus attached waiters and hides the label at 1", () => {
    expect(waitingCount(item({ id: "a", kind: "BLOCKED" }))).toBe(1);
    expect(waitingLabel(1)).toBeNull();
    const crowded = {
      ...item({ id: "b", kind: "BLOCKED" }),
      waiters: [{ runId: "run_2" }, { runId: "run_3" }],
    };
    expect(waitingCount(crowded)).toBe(3);
    expect(waitingLabel(3)).toBe("3 runs waiting on this answer");
  });
});

const origInbox = api.inbox;
const origAck = api.ackInbox;
const origResolve = api.resolveInbox;
const origProposals = api.proposals;
const origStatus = api.status;

let ledger: InboxItem[] = [];

beforeEach(() => {
  clearToasts();
  localStorage.clear();
  ledger = [
    item({
      id: "inbox_open_1",
      kind: "BLOCKED",
      title: "BLOCKED WM-1: decide X",
      body: "Choose a safe recovery",
      createdAt: T0,
      refs: { runId: "run_a", issue: "WM-1", repo: "factory" },
    }),
    item({
      id: "inbox_open_2",
      kind: "CI RED",
      title: "CI RED WM-2/PR #9",
      createdAt: T1,
      refs: { pr: "https://github.com/watt-mind/factory/pull/9" },
    }),
    item({
      id: "inbox_acked_1",
      kind: "ESCALATED",
      title: "ESCALATED merge",
      createdAt: T0,
      ackedAt: T1,
    }),
    item({
      id: "inbox_resolved_1",
      kind: "RC READY",
      title: "RC READY factory",
      createdAt: T0,
      ackedAt: T1,
      resolvedAt: T2,
      resolvedBy: "operator",
    }),
  ];
  api.inbox = mock(async (status) => ({
    items: ledger.filter(
      (entry) => status === "all" || itemStatus(entry) === status,
    ),
  }));
  api.status = mock(async () => ({
    inbox: {
      open: ledger.filter(
        (entry) => itemStatus(entry) === "open" && !entry.expired,
      ).length,
      acked: ledger.filter((entry) => itemStatus(entry) === "acked").length,
    },
  })) as unknown as typeof api.status;
  api.proposals = mock(async () => ({ proposals: [] }));
  api.ackInbox = mock(async (id: string) => {
    ledger = ledger.map((it) => (it.id === id ? { ...it, ackedAt: T2 } : it));
    return { item: ledger.find((it) => it.id === id)! };
  });
  api.resolveInbox = mock(async (id: string, reason: string) => {
    ledger = ledger.map((it) =>
      it.id === id
        ? {
            ...it,
            resolvedAt: T2,
            resolvedBy: "operator",
            resolvedReason: reason,
          }
        : it,
    );
    return { item: ledger.find((it) => it.id === id)! };
  });
});

afterEach(() => {
  api.inbox = origInbox;
  api.ackInbox = origAck;
  api.resolveInbox = origResolve;
  api.proposals = origProposals;
  api.status = origStatus;
});

function renderInbox(props: Partial<React.ComponentProps<typeof Inbox>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const jumps = {
    onJumpRun: mock(() => {}),
    onJumpProposal: mock(() => {}),
    onJumpEvent: mock(() => {}),
  };
  const view = render(
    <QueryClientProvider client={client}>
      <Inbox
        connected
        focusItemId={null}
        onSelectItem={() => {}}
        {...jumps}
        {...props}
      />
      <ToastContainer />
    </QueryClientProvider>,
  );
  return { view, jumps, client };
}

describe("Inbox view", () => {
  test("Open tab shows open items grouped, with counts on every tab", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByText("decide X"));
    expect(view.getByText("WM-2/PR #9")).toBeTruthy();
    expect(view.queryByText("ESCALATED merge")).toBeNull();
    const tabs = view.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs[0]).toContain("Open");
    expect(tabs[0]).toContain("2");
    expect(tabs[1]).toContain("Acked");
    expect(tabs[1]).toContain("1");
    // The Resolved badge comes from its own query, not the Open tab's rows.
    expect(tabs[2]).toContain("Resolved");
    expect(tabs[2]).toContain("1");
    expect(tabs[3]).toContain("All");
    expect(tabs[3]).toContain("4");
    // Group headers in triage order.
    expect(view.getByText("Decide")).toBeTruthy();
    expect(view.getByText("Red")).toBeTruthy();
    // Group headers already identify Decide/Red — the kind badge stays off.
    expect(view.queryByText("BLOCKED")).toBeNull();
    expect(view.queryByText("CI RED")).toBeNull();
  });

  test("keeps open items and their badge visible past a resolved cursor page", async () => {
    const resolved = Array.from({ length: 100 }, (_, index) =>
      item({
        id: `resolved-${index}`,
        kind: "RC READY",
        ackedAt: T1,
        resolvedAt: T2,
      }),
    );
    const olderOpen = item({
      id: "older-open",
      kind: "BLOCKED",
      title: "Open item behind resolved history",
    });
    api.inbox = mock(async (status, page = {}) => {
      if (status === "open") return { items: [olderOpen] };
      if (status === "resolved")
        return page.before
          ? { items: [] }
          : { items: resolved, nextBefore: "resolved-page-2" };
      return { items: [] };
    });
    api.status = mock(async () => ({
      inbox: { open: 1, acked: 0 },
    })) as unknown as typeof api.status;

    const { view } = renderInbox();
    await waitFor(() => view.getByText("Open item behind resolved history"));
    expect(view.getByRole("tab", { name: /Open/ }).textContent).toContain("1");

    fireEvent.click(view.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Load older inbox items" }),
      ).toBeTruthy(),
    );
  });

  test("renders after Overview cached its single-page open query", async () => {
    // Overview stores `{ items }` under ["inbox", "open"]; the Inbox cursor
    // queries must not read that entry as `{ pages }`.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["inbox", "open"], {
      items: ledger.filter((entry) => itemStatus(entry) === "open"),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Inbox
          connected
          focusItemId={null}
          onSelectItem={() => {}}
          onJumpRun={() => {}}
          onJumpProposal={() => {}}
          onJumpEvent={() => {}}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => view.getByText("decide X"));
    expect(view.getByText("WM-2/PR #9")).toBeTruthy();
    const tabs = view.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs[0]).toContain("2");
    expect(tabs[2]).toContain("1");
    // Overview's cache entry is left intact for Overview.
    expect(client.getQueryData<unknown>(["inbox", "open"])).toEqual({
      items: ledger.filter((entry) => itemStatus(entry) === "open"),
    });
  });

  test("Resolved badge counts resolved rows while the Open tab is showing", async () => {
    ledger = [
      item({ id: "open-a", kind: "BLOCKED", title: "Open A" }),
      ...Array.from({ length: 3 }, (_, index) =>
        item({
          id: `resolved-${index}`,
          kind: "RC READY",
          title: `Resolved ${index}`,
          ackedAt: T1,
          resolvedAt: T2,
        }),
      ),
    ];
    const { view } = renderInbox();
    await waitFor(() => view.getByText("Open A"));
    expect(view.getByRole("tab", { name: /Resolved/ }).textContent).toContain(
      "3",
    );
    expect(view.getByRole("tab", { name: /All/ }).textContent).toContain("4");
  });

  test("Open badge excludes expired rows even when /status counts them", async () => {
    ledger = [
      item({ id: "active", kind: "BLOCKED", title: "Active decision" }),
      item({ id: "expired-kind", kind: "proposal_expired", title: "Expired" }),
    ];
    // Legacy server: no `expired` field on rows and an open total that still
    // includes the expired row; the open status has another page.
    ledger = ledger.map(({ expired: _expired, ...rest }) => rest as InboxItem);
    api.inbox = mock(async (status, page = {}) => {
      if (status === "open")
        return page.before
          ? { items: [] }
          : {
              items: ledger,
              nextBefore: "open-page-2",
            };
      return { items: [] };
    });
    api.status = mock(async () => ({
      inbox: { open: 2, acked: 0 },
    })) as unknown as typeof api.status;
    const { view } = renderInbox();
    await waitFor(() => view.getByText("Active decision"));
    expect(view.getByRole("tab", { name: /Open/ }).textContent).toContain("1");
    expect(view.getByRole("button", { name: "Expired (1)" })).toBeTruthy();
  });

  test("hides expired open items by default and shows only them from the Expired chip", async () => {
    ledger = [
      item({ id: "active", kind: "BLOCKED", title: "Active decision" }),
      item({
        id: "expired-kind",
        kind: "proposal_expired",
        title: "Expired by kind",
      }),
      item({
        id: "expired-proposal",
        kind: "decision_needed",
        title: "Expired by proposal",
        refs: { proposalId: "expired-proposal-id" },
        expired: true,
      }),
    ];
    api.proposals = mock(async () => ({
      proposals: [],
    }));
    api.status = mock(async () => ({
      inbox: { open: 1, acked: 0 },
    })) as unknown as typeof api.status;

    const { view } = renderInbox();
    await waitFor(() => view.getByText("Active decision"));
    expect(view.queryByText("Expired by kind")).toBeNull();
    expect(view.queryByText("Expired by proposal")).toBeNull();
    expect(view.getByRole("tab", { name: /Open/ }).textContent).toContain("1");
    expect(view.getByRole("tab", { name: /All/ }).textContent).toContain("1");

    fireEvent.click(view.getByRole("button", { name: "Expired (2)" }));
    await waitFor(() => view.getByText("Expired by kind"));
    expect(view.getByText("Expired by proposal")).toBeTruthy();
    expect(view.queryByText("Active decision")).toBeNull();

    // The chip count is derived from the open query, so visiting another tab
    // and coming back does not change it.
    fireEvent.click(view.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() =>
      expect(view.queryByRole("button", { name: /Expired/ })).toBeNull(),
    );
    fireEvent.click(view.getByRole("tab", { name: /Open/ }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Expired (2)" })).toBeTruthy(),
    );
  });

  test("proposal rows show a live right-aligned TTL and hide it without one", async () => {
    ledger = [
      item({
        id: "inbox_dispatch",
        kind: "decision_needed",
        title: "Dispatch WM-862 · factory · cursor-grok-4.6-high",
        refs: { proposalId: "prop_aging", issue: "WM-862", repo: "factory" },
        decision: {
          schemaVersion: "factory.decision-request/v1",
          question:
            "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
          context:
            "**Why you're being asked.** Auto-approval re-check failed (see proposal)",
          options: [
            { id: "approve", label: "Approve proposal", effect: "dismiss" },
            { id: "dismiss", label: "Not now", effect: "dismiss" },
          ],
        },
      }),
    ];
    api.proposals = mock(async () => ({
      proposals: [
        {
          id: "prop_aging",
          created_at: new Date(Date.now() - 16 * 60_000).toISOString(),
          ttl_seconds: 1800,
        } as Proposal,
      ],
    }));
    const { view } = renderInbox();
    await waitFor(() =>
      view.getByText("Dispatch WM-862 · factory · cursor-grok-4.6-high"),
    );
    expect(view.getByLabelText(/Time left/).textContent).toMatch(
      /(?:\d+m left|expired)/,
    );
    expect(view.queryByText("decision_needed")).toBeNull();
  });

  test("list and detail show how many runs wait on one answer", async () => {
    ledger = [
      {
        ...item({
          id: "inbox_wait",
          kind: "BLOCKED",
          title: "BLOCKED WM-9: shared question",
          refs: { issue: "WM-9", runId: "run_a" },
        }),
        waiters: [{ runId: "run_b" }, { runId: "run_c" }],
        waitingCount: 3,
      } as InboxItem,
    ];
    const { view } = renderInbox({
      focusItemId: "inbox_wait",
      onSelectItem: () => {},
    });
    await waitFor(() => view.getByText("3 waiting"));
    expect(view.getByText("3 runs waiting on this answer")).toBeTruthy();
  });

  test("filters with inbox facets and free text, with an Esc-hinted empty state", async () => {
    const { view } = renderInbox();
    const input = (await waitFor(() =>
      view.getByLabelText("Filter inbox"),
    )) as HTMLInputElement;

    act(() =>
      changeInput(input, "kind:blocked repo:factory issue:WM-1 is:open"),
    );
    expect(view.getByText("decide X")).toBeTruthy();
    expect(view.queryByText("WM-2/PR #9")).toBeNull();

    act(() => changeInput(input, "safe recovery"));
    expect(view.getByText("decide X")).toBeTruthy();

    act(() => changeInput(input, "kind:no-such-kind"));
    expect(view.getByText("No inbox items match this filter.")).toBeTruthy();
    expect(view.getByText("Esc clears the filter")).toBeTruthy();
  });

  test("Display groups by kind or none and shared group headers collapse rows", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByText("decide X"));

    const decide = view.getByRole("button", { name: /Decide 1/ });
    expect(decide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(decide);
    expect(decide.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("decide X")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: /Display/ }));
    const chooseGroup = (name: string) => {
      fireEvent.click(view.getByRole("combobox", { name: "Group by" }));
      fireEvent.mouseDown(
        within(
          view.getByRole("listbox", { name: "Group by options" }),
        ).getByRole("option", { name }),
      );
    };
    chooseGroup("Kind");
    expect(view.getByRole("button", { name: /BLOCKED 1/ })).toBeTruthy();
    expect(view.getByRole("button", { name: /CI RED 1/ })).toBeTruthy();

    chooseGroup("No grouping");
    expect(view.queryByRole("button", { name: /BLOCKED 1/ })).toBeNull();
    expect(view.getByText("decide X")).toBeTruthy();
    expect(view.getByText("WM-2/PR #9")).toBeTruthy();
  });

  test("Kind and Age headers are sortable and persist ordering through display state", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByText("decide X"));
    const age = view.getByRole("button", { name: "Age" }).closest("th")!;
    expect(age.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(view.getByRole("button", { name: "Kind" }));
    expect(
      view
        .getByRole("button", { name: "Kind" })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");
    const persisted = JSON.parse(
      localStorage.getItem("evrt-display-inbox") ?? "{}",
    );
    expect(persisted.sortBy).toBe("kind");
  });

  test("keeps Title visible when every display property is toggled off", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByText("decide X"));
    fireEvent.click(view.getByRole("button", { name: /Display/ }));
    const dialog = view.getByRole("dialog", { name: "Display options" });
    for (const label of ["Kind", "Title", "Age", "Refs", "Sent"]) {
      fireEvent.click(within(dialog).getByRole("button", { name: label }));
    }
    expect(view.getByRole("columnheader", { name: "Title" })).toBeTruthy();
    expect(view.getByText("decide X")).toBeTruthy();
    const persisted = JSON.parse(
      localStorage.getItem("evrt-display-inbox") ?? "{}",
    );
    expect(persisted.hiddenColumns).not.toContain("title");
  });

  test("empty Open tab is a sentence, not a table", async () => {
    ledger = ledger.filter((it) => itemStatus(it) !== "open");
    const { view } = renderInbox();
    await waitFor(() => view.getByText("Nothing waiting on you."));
    expect(view.queryByRole("table")).toBeNull();
  });

  test("ref chips jump without selecting the row", async () => {
    const onSelectItem = mock(() => {});
    const { view, jumps } = renderInbox({ onSelectItem });
    await waitFor(() => view.getByText("decide X"));
    fireEvent.click(view.getByTitle("run_a"));
    expect(jumps.onJumpRun).toHaveBeenCalledWith("run_a");
    expect(onSelectItem).not.toHaveBeenCalled();
    const issue = view.getByText("WM-1") as HTMLAnchorElement;
    expect(issue.getAttribute("href")).toBe(
      "https://linear.app/watt-mind/issue/WM-1",
    );
    const pr = view.getByTitle("Open pull request") as HTMLAnchorElement;
    expect(pr.getAttribute("href")).toBe(
      "https://github.com/watt-mind/factory/pull/9",
    );
    const { view: detail } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => detail.getByTitle("Open repository"));
    const repo = detail.getByTitle("Open repository") as HTMLAnchorElement;
    expect(repo.getAttribute("href")).toBe(
      "https://github.com/watt-mind/factory",
    );
  });

  test("ref chips shorten events and cap the row at three with a remainder tooltip", async () => {
    ledger = [
      item({
        id: "many_refs",
        kind: "BLOCKED",
        title: "BLOCKED inspect refs",
        refs: {
          runId: "run_1234567890",
          eventSource: "github",
          eventId: "event_abcdefghijk",
          issue: "WM-617",
          pr: "PR#42",
          repo: "factory",
        },
      }),
    ];
    const { view } = renderInbox();
    await waitFor(() => view.getByText("inspect refs"));
    expect(view.getByText("event_abcdefgh").getAttribute("title")).toBe(
      "event_abcdefghijk",
    );
    expect(view.getByText("WM-617")).toBeTruthy();
    expect(view.queryByText("PR#42")).toBeNull();
    const more = view.getByText("+1");
    expect(more.getAttribute("title")).toBe("pull request PR#42");
  });

  test("an unresolved PR shorthand renders as text, never a relative link", async () => {
    ledger = [
      item({
        id: "bare_pr",
        kind: "CI RED",
        title: "CI RED inspect PR",
        refs: { pr: "PR#88" },
      }),
    ];
    const { view } = renderInbox();
    await waitFor(() => view.getByText("inspect PR"));
    const ref = view.getByText("PR#88");
    expect(ref.tagName).toBe("SPAN");
    expect(ref.closest("a")).toBeNull();
  });

  test("deep link selects the item and follows it onto the tab that has it", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_acked_1" });
    await waitFor(() => view.getByRole("tab", { selected: true }));
    await waitFor(() =>
      expect(view.getByRole("tab", { selected: true }).textContent).toContain(
        "Acked",
      ),
    );
    expect(
      view.getByText("Telegram: not attempted".replace(/^Telegram: /, "")),
    ).toBeTruthy();
    expect(view.getByText(/inbox deliberately cannot merge/)).toBeTruthy();
    expect(view.queryByRole("button", { name: /Resolve…/ })).toBeNull();
    expect(view.queryByRole("button", { name: /^Ack/ })).toBeNull();
  });

  test("contains a detail render failure and retries it without losing the list", async () => {
    let failDetail = true;
    const decision = {
      schemaVersion: "factory.decision-request/v1" as const,
      question: "Can this detail recover?",
      get options() {
        if (failDetail) {
          throw new Error("first detail render failed");
        }
        return [{ id: "retry", label: "Retry", effect: "dismiss" as const }];
      },
    };
    ledger = [
      item({
        id: "inbox_detail_failure",
        kind: "decision_needed",
        title: "Decision that initially fails",
        decision,
      }),
    ];

    const { view } = renderInbox({ focusItemId: "inbox_detail_failure" });
    await waitFor(() => view.getByRole("alert"));
    expect(view.getByTitle("Decision that initially fails")).toBeTruthy();
    expect(view.getByText("Open raw item")).toBeTruthy();

    failDetail = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => view.getByText("Can this detail recover?"));
    expect(view.queryByText("This item could not render")).toBeNull();
  });

  test("the detail fallback can be closed like the real detail pane", async () => {
    const decision = {
      schemaVersion: "factory.decision-request/v1" as const,
      question: "Will this ever render?",
      get options(): { id: string; label: string; effect: "dismiss" }[] {
        throw new Error("detail render failed");
      },
    };
    ledger = [
      item({
        id: "inbox_detail_failure",
        kind: "decision_needed",
        title: "Decision that always fails",
        decision,
      }),
    ];
    const onSelectItem = mock(() => {});
    const { view } = renderInbox({
      focusItemId: "inbox_detail_failure",
      onSelectItem,
    });
    await waitFor(() => view.getByRole("alert"));
    expect(view.getByText("This item could not render")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onSelectItem).toHaveBeenCalledWith(null);
  });

  test("unknown deep link shows an inline notice, not a blank list", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_nope" });
    await waitFor(() => view.getByText(/^No inbox item/));
    expect(view.getByText(/^No inbox item/).textContent).toContain(
      "No inbox item",
    );
    expect(view.getByText("decide X")).toBeTruthy();
  });

  test("marks undecided rows and replaces ack/resolve with the decision card", async () => {
    ledger = [
      item({
        id: "inbox_decision",
        kind: "decision_needed",
        title: "DECISION NEEDED choose a recovery",
        decision: {
          schemaVersion: "factory.decision-request/v1",
          question: "Which recovery should run?",
          options: [
            { id: "retry", label: "Try again", effect: "dismiss" },
            { id: "dismiss", label: "Not now", effect: "dismiss" },
          ],
        },
        response: null,
      }),
    ];
    const { view } = renderInbox({ focusItemId: "inbox_decision" });
    await waitFor(() => view.getByText("Which recovery should run?"));
    expect(view.getByLabelText("Decision required").textContent).toBe("?");
    expect(view.queryByRole("button", { name: /^Ack/ })).toBeNull();
    expect(view.queryByRole("button", { name: /Resolve…/ })).toBeNull();
    const card = view.getByRole("region", { name: "Decision" });
    fireEvent.keyDown(card, { key: "2" });
    expect(view.getByRole("tab", { selected: true }).textContent).toContain(
      "Open",
    );
    expect(
      within(card)
        .getAllByRole("button", { name: /Not now/ })[0]
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("a acks the selected item and the ledger, not the UI, flips its status", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByRole("button", { name: /^Ack/ }));
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });
    await waitFor(() =>
      expect(api.ackInbox).toHaveBeenCalledWith("inbox_open_1"),
    );
    await waitFor(() =>
      expect(view.getByRole("tab", { selected: true }).textContent).toContain(
        "Acked",
      ),
    );
    expect(view.queryByRole("button", { name: /^Ack(?:\s|$)/ })).toBeNull();
  });

  test("x opens the resolve dialog; Enter requires a reason before resolving", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByRole("button", { name: /Resolve…/ }));
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true }),
      );
    });
    await waitFor(() => view.getByRole("dialog"));
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(api.resolveInbox).not.toHaveBeenCalled();
    expect(view.getByRole("dialog")).toBeTruthy();

    act(() => {
      changeInput(
        view.getByLabelText("Resolution reason"),
        "Handled after operator follow-up",
      );
    });
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Resolve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await waitFor(() =>
      expect(api.resolveInbox).toHaveBeenCalledWith(
        "inbox_open_1",
        "Handled after operator follow-up",
      ),
    );
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(view.getByRole("tab", { selected: true }).textContent).toContain(
        "Resolved",
      ),
    );
    expect(view.getByText(/Handled after operator follow-up/)).toBeTruthy();
  });

  test("clicking an Open-tab title opens the item and does not bulk-select it", async () => {
    const onSelectItem = mock(() => {});
    const { view } = renderInbox({ onSelectItem });
    await waitFor(() => view.getByText("decide X"));

    fireEvent.click(view.getByText("decide X"));

    expect(onSelectItem).toHaveBeenCalledWith("inbox_open_1");
    expect(
      (
        view.getByLabelText(
          "Select inbox item inbox_open_1",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(view.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
  });

  test("clicking the row checkbox bulk-selects and does not open the item", async () => {
    const onSelectItem = mock(() => {});
    const { view } = renderInbox({ onSelectItem });
    await waitFor(() => view.getByLabelText("Select inbox item inbox_open_1"));

    fireEvent.click(view.getByLabelText("Select inbox item inbox_open_1"));

    expect(onSelectItem).not.toHaveBeenCalled();
    expect(
      (
        view.getByLabelText(
          "Select inbox item inbox_open_1",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      view.getByRole("toolbar", { name: "Bulk actions" }).textContent,
    ).toContain("1 selected");
  });

  test("Space and Shift+Space toggle the highlighted inbox checkbox", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    const checkbox = await waitFor(
      () =>
        view.getByLabelText(
          "Select inbox item inbox_open_1",
        ) as HTMLInputElement,
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });
    expect(checkbox.checked).toBe(true);

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(checkbox.checked).toBe(false);
  });

  test("select-all selects every visible actionable inbox item", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));

    fireEvent.click(view.getByLabelText("Select all inbox items"));

    expect(
      view.getByRole("toolbar", { name: "Bulk actions" }).textContent,
    ).toContain("2 selected");
    expect(
      (
        view.getByLabelText(
          "Select inbox item inbox_open_1",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        view.getByLabelText(
          "Select inbox item inbox_open_2",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  test("* a selects all without acking the focused item", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByLabelText("Select all inbox items"));

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "*", bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    await waitFor(() =>
      expect(
        view.getByRole("toolbar", { name: "Bulk actions" }).textContent,
      ).toContain("2 selected"),
    );
    expect(api.ackInbox).not.toHaveBeenCalled();
  });

  test("A acks selected legacy rows without acking per-kind action rows", async () => {
    const calls: string[] = [];
    api.ackInbox = mock(async (id: string) => {
      calls.push(id);
      ledger = ledger.map((it) => (it.id === id ? { ...it, ackedAt: T2 } : it));
      return { item: ledger.find((it) => it.id === id)! };
    });
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));
    fireEvent.click(view.getByLabelText("Select all inbox items"));

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "A",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    await waitFor(() => expect(calls).toEqual(["inbox_open_1"]));
    expect(
      view.getByRole("button", { name: "Ack: 1 done / 0 failed" }),
    ).toBeTruthy();
  });

  test("bulk ack retains failed items and surfaces the first failure", async () => {
    ledger = [
      item({ id: "inbox_bulk_success", kind: "BLOCKED" }),
      item({ id: "inbox_bulk_failure", kind: "BLOCKED", createdAt: T1 }),
    ];
    api.ackInbox = mock(async (id: string) => {
      if (id === "inbox_bulk_failure") throw new Error("race lost");
      ledger = ledger.map((it) => (it.id === id ? { ...it, ackedAt: T2 } : it));
      return { item: ledger.find((it) => it.id === id)! };
    });
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));
    fireEvent.click(view.getByLabelText("Select all inbox items"));

    fireEvent.click(view.getByRole("button", { name: /^Ack$/ }));

    await waitFor(() => expect(api.ackInbox).toHaveBeenCalledTimes(2));
    expect(
      view.getByRole("button", { name: "Ack: 1 done / 1 failed" }),
    ).toBeTruthy();
    expect(view.getByText("race lost")).toBeTruthy();
    expect(
      view.getByRole("toolbar", { name: "Bulk actions" }).textContent,
    ).toContain("1 selected");
    expect(
      (
        view.getByLabelText(
          "Select inbox item inbox_bulk_failure",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  test("background refetch preserves selected ids and prunes ids that leave the tab", async () => {
    const { view, client } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));
    fireEvent.click(view.getByLabelText("Select all inbox items"));
    expect(
      view.getByRole("toolbar", { name: "Bulk actions" }).textContent,
    ).toContain("2 selected");

    ledger = ledger.filter((it) => it.id !== "inbox_open_2");
    await client.invalidateQueries({ queryKey: ["inbox"] });

    await waitFor(() =>
      expect(
        view.getByRole("toolbar", { name: "Bulk actions" }).textContent,
      ).toContain("1 selected"),
    );
    expect(
      (
        view.getByLabelText(
          "Select inbox item inbox_open_1",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  test("verbs are disabled while disconnected", async () => {
    const { view } = renderInbox({
      focusItemId: "inbox_open_1",
      connected: false,
    });
    await waitFor(() => view.getByRole("button", { name: /^Ack/ }));
    expect(
      (view.getByRole("button", { name: /^Ack/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: /Resolve…/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("table checkboxes have hover-only visibility when none selected and full opacity when selected", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));

    const headerCb = view.getByLabelText(
      "Select all inbox items",
    ) as HTMLInputElement;
    const rowCb1 = view.getByLabelText(
      "Select inbox item inbox_open_1",
    ) as HTMLInputElement;
    const rowCb2 = view.getByLabelText(
      "Select inbox item inbox_open_2",
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

    // Table head and rows have group class
    expect(headerCb.closest("thead")?.className).toContain("group");
    expect(rowCb1.closest("tr")?.className).toContain("group");
    expect(rowCb2.closest("tr")?.className).toContain("group");

    // Select row 1 -> checkboxes become opacity-100
    fireEvent.click(rowCb1);
    expect(headerCb.className).toContain("opacity-100");
    expect(rowCb1.className).toContain("opacity-100");
    expect(rowCb2.className).toContain("opacity-100");
  });

  test("Shift+Click selects and deselects contiguous range of items", async () => {
    ledger = [
      item({ id: "inbox_1", kind: "BLOCKED", title: "Item 1", createdAt: T0 }),
      item({ id: "inbox_2", kind: "BLOCKED", title: "Item 2", createdAt: T1 }),
      item({ id: "inbox_3", kind: "BLOCKED", title: "Item 3", createdAt: T2 }),
      item({ id: "inbox_4", kind: "BLOCKED", title: "Item 4", createdAt: T2 }),
    ];
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select inbox item inbox_1"));

    const cb1 = view.getByLabelText(
      "Select inbox item inbox_1",
    ) as HTMLInputElement;
    const cb2 = view.getByLabelText(
      "Select inbox item inbox_2",
    ) as HTMLInputElement;
    const cb3 = view.getByLabelText(
      "Select inbox item inbox_3",
    ) as HTMLInputElement;
    const cb4 = view.getByLabelText(
      "Select inbox item inbox_4",
    ) as HTMLInputElement;

    // Click item 1
    fireEvent.click(cb1);
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(false);
    expect(cb3.checked).toBe(false);
    expect(cb4.checked).toBe(false);

    // Shift+Click item 3 -> items 1, 2, 3 selected
    fireEvent.click(cb3, { shiftKey: true });
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);
    expect(cb3.checked).toBe(true);
    expect(cb4.checked).toBe(false);

    // Shift+Click checked item 2 -> deselects range between anchor (item 3) and target (item 2), leaving item 1
    fireEvent.click(cb2, { shiftKey: true });
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(false);
    expect(cb3.checked).toBe(false);
    expect(cb4.checked).toBe(false);
  });
});

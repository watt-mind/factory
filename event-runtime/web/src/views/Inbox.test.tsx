import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Inbox,
  deliveryState,
  deliveryText,
  displayTitle,
  groupItems,
  groupOf,
  inboxAge,
  itemStatus,
  matchesTab,
  prHref,
  sourceRunId,
} from "./Inbox";
import { api } from "../api";
import { clearToasts, ToastContainer } from "../components/ui";
import type { InboxItem } from "../types";
import { changeInput } from "../test-render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function item(overrides: Partial<InboxItem> & Pick<InboxItem, "id" | "kind">): InboxItem {
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
    delivery: {},
    ...overrides,
  };
}

const T0 = "2026-08-17T10:00:00.000Z";
const T1 = "2026-08-17T11:00:00.000Z";
const T2 = "2026-08-17T12:00:00.000Z";

describe("inbox pure helpers", () => {
  test("groups by triage kind and drops empty groups, oldest first inside a group", () => {
    const rows = [
      item({ id: "i-ci", kind: "CI RED", createdAt: T2 }),
      item({ id: "i-blocked-new", kind: "BLOCKED", createdAt: T2 }),
      item({ id: "i-blocked-old", kind: "BLOCKED", createdAt: T0 }),
      item({ id: "i-decision", kind: "decision_needed", createdAt: T1 }),
    ];
    const groups = groupItems(rows);
    expect(groups.map((g) => g.group.id)).toEqual(["decide", "red"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["i-blocked-old", "i-decision", "i-blocked-new"]);
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
    expect(itemStatus(item({ id: "b", kind: "BLOCKED", ackedAt: T1 }))).toBe("acked");
    expect(itemStatus(item({ id: "c", kind: "BLOCKED", ackedAt: T1, resolvedAt: T2 }))).toBe("resolved");
    expect(matchesTab(item({ id: "d", kind: "BLOCKED", ackedAt: T1 }), "all")).toBe(true);
    expect(matchesTab(item({ id: "e", kind: "BLOCKED", ackedAt: T1 }), "open")).toBe(false);
  });

  test("delivery: not attempted is neither sent nor failed", () => {
    expect(deliveryState(item({ id: "a", kind: "BLOCKED" }))).toBe("none");
    expect(deliveryText(item({ id: "a", kind: "BLOCKED" }))).toBe("Telegram: not attempted");
    const sent = item({ id: "b", kind: "BLOCKED", delivery: { telegram: { sent_at: T1, exit_code: 0, error: null } } });
    expect(deliveryState(sent)).toBe("sent");
    expect(deliveryText(sent)).toMatch(/^Telegram: sent .* · exit 0$/);
    const failed = item({ id: "c", kind: "BLOCKED", delivery: { telegram: { sent_at: T1, exit_code: 1, error: null } } });
    expect(deliveryState(failed)).toBe("failed");
    const errored = item({ id: "d", kind: "BLOCKED", delivery: { telegram: { sent_at: T1, exit_code: null, error: "spawn ENOENT" } } });
    expect(deliveryState(errored)).toBe("failed");
    expect(deliveryText(errored)).toContain("spawn ENOENT");
  });

  test("agent sources name the run that raised the item", () => {
    expect(sourceRunId("agent:run_123")).toBe("run_123");
    expect(sourceRunId("serve:notify")).toBeNull();
    expect(sourceRunId("cli")).toBeNull();
  });

  test("displayTitle removes redundant kind and visible issue/PR prefixes", () => {
    expect(displayTitle(item({
      id: "blocked",
      kind: "BLOCKED",
      title: "BLOCKED WM-303: expand Owned Paths to include the fixture",
      refs: { issue: "WM-303" },
    }))).toBe("expand Owned Paths to include the fixture");
    expect(displayTitle(item({
      id: "human",
      kind: "human_needed",
      title: "BLOCKED factory.ticket.reaped reap:CLNT-1393:1786698035",
    }))).toBe("factory.ticket.reaped reap:CLNT-1393:1786698035");
    expect(displayTitle(item({
      id: "ci",
      kind: "CI RED",
      title: "CI RED PR#398/WM-398: Verify run failed",
      refs: { issue: "WM-398", pr: "PR#398" },
    }))).toBe("Verify run failed");
    expect(displayTitle(item({
      id: "escalated",
      kind: "ESCALATED",
      title: "escalated CLNT-12/PR#7: choose a release",
      refs: { issue: "CLNT-12", pr: "#7", repo: "bj29" },
    }))).toBe("choose a release");
  });

  test("displayTitle keeps a ref prefix that has no matching chip", () => {
    const row = item({ id: "a", kind: "BLOCKED", title: "BLOCKED WM-303: expand paths", refs: {} });
    expect(displayTitle(row)).toBe("WM-303: expand paths");
    expect(row.title).toBe("BLOCKED WM-303: expand paths");
  });

  test("PR refs resolve only with an absolute URL or a known repository", () => {
    expect(prHref(item({ id: "url", kind: "CI RED", refs: { pr: "https://github.com/watt-mind/factory/pull/9" } })))
      .toBe("https://github.com/watt-mind/factory/pull/9");
    expect(prHref(item({ id: "repo", kind: "CI RED", refs: { pr: "PR#123", repo: "factory" } })))
      .toBe("https://github.com/watt-mind/factory/pull/123");
    expect(prHref(item({ id: "issue", kind: "CI RED", refs: { pr: "#124", issue: "WM-617" } })))
      .toBe("https://github.com/watt-mind/factory/pull/124");
    expect(prHref(item({ id: "bare", kind: "CI RED", refs: { pr: "PR#125" } }))).toBeNull();
  });

  test("Inbox age preserves hour precision after 24 hours", () => {
    expect(inboxAge("2026-08-16T05:30:00.000Z", Date.parse("2026-08-17T10:00:00.000Z"))).toBe("1d 4h ago");
  });
});

const origInbox = api.inbox;
const origAck = api.ackInbox;
const origResolve = api.resolveInbox;

let ledger: InboxItem[] = [];

beforeEach(() => {
  clearToasts();
  localStorage.clear();
  ledger = [
    item({ id: "inbox_open_1", kind: "BLOCKED", title: "BLOCKED WM-1: decide X", body: "Choose a safe recovery", createdAt: T0, refs: { runId: "run_a", issue: "WM-1", repo: "factory" } }),
    item({ id: "inbox_open_2", kind: "CI RED", title: "CI RED WM-2/PR #9", createdAt: T1, refs: { pr: "https://github.com/watt-mind/factory/pull/9" } }),
    item({ id: "inbox_acked_1", kind: "ESCALATED", title: "ESCALATED merge", createdAt: T0, ackedAt: T1 }),
    item({ id: "inbox_resolved_1", kind: "RC READY", title: "RC READY factory", createdAt: T0, ackedAt: T1, resolvedAt: T2, resolvedBy: "operator" }),
  ];
  api.inbox = mock(async () => ({ items: ledger }));
  api.ackInbox = mock(async (id: string) => {
    ledger = ledger.map((it) => (it.id === id ? { ...it, ackedAt: T2 } : it));
    return { item: ledger.find((it) => it.id === id)! };
  });
  api.resolveInbox = mock(async (id: string) => {
    ledger = ledger.map((it) => (it.id === id ? { ...it, resolvedAt: T2, resolvedBy: "operator" } : it));
    return { item: ledger.find((it) => it.id === id)! };
  });
});

afterEach(() => {
  api.inbox = origInbox;
  api.ackInbox = origAck;
  api.resolveInbox = origResolve;
});

function renderInbox(props: Partial<React.ComponentProps<typeof Inbox>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    expect(tabs[2]).toContain("Resolved");
    expect(tabs[3]).toContain("All");
    expect(tabs[3]).toContain("4");
    // Group headers in triage order.
    expect(view.getByText("Decide")).toBeTruthy();
    expect(view.getByText("Red")).toBeTruthy();
  });

  test("filters with inbox facets and free text, with an Esc-hinted empty state", async () => {
    const { view } = renderInbox();
    const input = await waitFor(() => view.getByLabelText("Filter inbox")) as HTMLInputElement;

    act(() => changeInput(input, "kind:blocked repo:factory issue:WM-1 is:open"));
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
      fireEvent.mouseDown(within(view.getByRole("listbox", { name: "Group by options" })).getByRole("option", { name }));
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
    expect(view.getByRole("button", { name: "Kind" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    const persisted = JSON.parse(localStorage.getItem("evrt-display-inbox") ?? "{}");
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
    const persisted = JSON.parse(localStorage.getItem("evrt-display-inbox") ?? "{}");
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
    expect(issue.getAttribute("href")).toBe("https://linear.app/watt-mind/issue/WM-1");
    const pr = view.getByTitle("Open pull request") as HTMLAnchorElement;
    expect(pr.getAttribute("href")).toBe("https://github.com/watt-mind/factory/pull/9");
  });

  test("ref chips shorten events and cap the row at three with a remainder tooltip", async () => {
    ledger = [item({
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
    })];
    const { view } = renderInbox();
    await waitFor(() => view.getByText("inspect refs"));
    expect(view.getByText("event_abcdefgh").getAttribute("title")).toBe("event_abcdefghijk");
    expect(view.getByText("WM-617")).toBeTruthy();
    expect(view.queryByText("PR#42")).toBeNull();
    const more = view.getByText("+1");
    expect(more.getAttribute("title")).toBe("pull request PR#42");
  });

  test("an unresolved PR shorthand renders as text, never a relative link", async () => {
    ledger = [item({ id: "bare_pr", kind: "CI RED", title: "CI RED inspect PR", refs: { pr: "PR#88" } })];
    const { view } = renderInbox();
    await waitFor(() => view.getByText("inspect PR"));
    const ref = view.getByText("PR#88");
    expect(ref.tagName).toBe("SPAN");
    expect(ref.closest("a")).toBeNull();
  });

  test("deep link selects the item and follows it onto the tab that has it", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_acked_1" });
    await waitFor(() => view.getByRole("tab", { selected: true }));
    await waitFor(() => expect(view.getByRole("tab", { selected: true }).textContent).toContain("Acked"));
    expect(view.getByText("Telegram: not attempted".replace(/^Telegram: /, ""))).toBeTruthy();
    expect(view.getByRole("button", { name: /Resolve…/ })).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Ack/ })).toBeNull();
  });

  test("unknown deep link shows an inline notice, not a blank list", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_nope" });
    await waitFor(() => view.getByText(/^No inbox item/));
    expect(view.getByText(/^No inbox item/).textContent).toContain("No inbox item");
    expect(view.getByText("decide X")).toBeTruthy();
  });

  test("a acks the selected item and the ledger, not the UI, flips its status", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByRole("button", { name: /^Ack/ }));
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    await waitFor(() => expect(api.ackInbox).toHaveBeenCalledWith("inbox_open_1"));
    await waitFor(() => expect(view.getByRole("tab", { selected: true }).textContent).toContain("Acked"));
    expect(view.queryByRole("button", { name: /^Ack(?:\s|$)/ })).toBeNull();
  });

  test("x opens the resolve confirm; Enter resolves", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByRole("button", { name: /Resolve…/ }));
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    });
    await waitFor(() => view.getByRole("dialog"));
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => expect(api.resolveInbox).toHaveBeenCalledWith("inbox_open_1"));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(view.getByRole("tab", { selected: true }).textContent).toContain("Resolved"));
  });

  test("select-all selects every visible actionable inbox item", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));

    fireEvent.click(view.getByLabelText("Select all inbox items"));

    expect(view.getByRole("toolbar", { name: "Bulk actions" }).textContent).toContain("2 selected");
    expect((view.getByLabelText("Select inbox item inbox_open_1") as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText("Select inbox item inbox_open_2") as HTMLInputElement).checked).toBe(true);
  });

  test("* a selects all without acking the focused item", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByLabelText("Select all inbox items"));

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "*", bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });

    await waitFor(() => expect(view.getByRole("toolbar", { name: "Bulk actions" }).textContent).toContain("2 selected"));
    expect(api.ackInbox).not.toHaveBeenCalled();
  });

  test("A acks each selected id sequentially", async () => {
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
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true }));
    });

    await waitFor(() => expect(calls).toEqual(["inbox_open_1", "inbox_open_2"]));
    expect(view.getByRole("button", { name: "Ack: 2 done / 0 failed" })).toBeTruthy();
  });

  test("bulk ack reports one done / failed summary toast", async () => {
    api.ackInbox = mock(async (id: string) => {
      if (id === "inbox_open_2") throw new Error("race");
      return { item: ledger.find((it) => it.id === id)! };
    });
    const { view } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));
    fireEvent.click(view.getByLabelText("Select all inbox items"));

    fireEvent.click(view.getByRole("button", { name: /^Ack$/ }));

    await waitFor(() => expect(api.ackInbox).toHaveBeenCalledTimes(2));
    expect(view.getByRole("button", { name: "Ack: 1 done / 1 failed" })).toBeTruthy();
  });

  test("background refetch preserves selected ids and prunes ids that leave the tab", async () => {
    const { view, client } = renderInbox();
    await waitFor(() => view.getByLabelText("Select all inbox items"));
    fireEvent.click(view.getByLabelText("Select all inbox items"));
    expect(view.getByRole("toolbar", { name: "Bulk actions" }).textContent).toContain("2 selected");

    ledger = ledger.filter((it) => it.id !== "inbox_open_2");
    await client.invalidateQueries({ queryKey: ["inbox"] });

    await waitFor(() => expect(view.getByRole("toolbar", { name: "Bulk actions" }).textContent).toContain("1 selected"));
    expect((view.getByLabelText("Select inbox item inbox_open_1") as HTMLInputElement).checked).toBe(true);
  });

  test("verbs are disabled while disconnected", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1", connected: false });
    await waitFor(() => view.getByRole("button", { name: /^Ack/ }));
    expect((view.getByRole("button", { name: /^Ack/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: /Resolve…/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

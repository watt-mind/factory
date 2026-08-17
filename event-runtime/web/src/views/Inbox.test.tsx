import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Inbox,
  deliveryState,
  deliveryText,
  groupItems,
  groupOf,
  itemStatus,
  matchesTab,
  sourceRunId,
} from "./Inbox";
import { api } from "../api";
import type { InboxItem } from "../types";

afterEach(() => {
  cleanup();
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
});

const origInbox = api.inbox;
const origAck = api.ackInbox;
const origResolve = api.resolveInbox;

let ledger: InboxItem[] = [];

beforeEach(() => {
  ledger = [
    item({ id: "inbox_open_1", kind: "BLOCKED", title: "BLOCKED WM-1: decide X", createdAt: T0, refs: { runId: "run_a", issue: "WM-1" } }),
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
    </QueryClientProvider>,
  );
  return { view, jumps };
}

describe("Inbox view", () => {
  test("Open tab shows open items grouped, with counts on every tab", async () => {
    const { view } = renderInbox();
    await waitFor(() => view.getByText("BLOCKED WM-1: decide X"));
    expect(view.getByText("CI RED WM-2/PR #9")).toBeTruthy();
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

  test("empty Open tab is a sentence, not a table", async () => {
    ledger = ledger.filter((it) => itemStatus(it) !== "open");
    const { view } = renderInbox();
    await waitFor(() => view.getByText("Nothing waiting on you."));
    expect(view.queryByRole("table")).toBeNull();
  });

  test("ref chips jump without selecting the row", async () => {
    const onSelectItem = mock(() => {});
    const { view, jumps } = renderInbox({ onSelectItem });
    await waitFor(() => view.getByText("BLOCKED WM-1: decide X"));
    fireEvent.click(view.getByTitle("run_a"));
    expect(jumps.onJumpRun).toHaveBeenCalledWith("run_a");
    expect(onSelectItem).not.toHaveBeenCalled();
    const issue = view.getByText("WM-1") as HTMLAnchorElement;
    expect(issue.getAttribute("href")).toBe("https://linear.app/watt-mind/issue/WM-1");
    const pr = view.getByText("PR") as HTMLAnchorElement;
    expect(pr.getAttribute("href")).toBe("https://github.com/watt-mind/factory/pull/9");
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
    await waitFor(() => view.getByRole("status"));
    expect(view.getByRole("status").textContent).toContain("No inbox item");
    expect(view.getByText("BLOCKED WM-1: decide X")).toBeTruthy();
  });

  test("a acks the selected item and the ledger, not the UI, flips its status", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1" });
    await waitFor(() => view.getByRole("button", { name: /^Ack/ }));
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    await waitFor(() => expect(api.ackInbox).toHaveBeenCalledWith("inbox_open_1"));
    await waitFor(() => expect(view.getByRole("tab", { selected: true }).textContent).toContain("Acked"));
    expect(view.queryByRole("button", { name: /^Ack/ })).toBeNull();
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

  test("verbs are disabled while disconnected", async () => {
    const { view } = renderInbox({ focusItemId: "inbox_open_1", connected: false });
    await waitFor(() => view.getByRole("button", { name: /^Ack/ }));
    expect((view.getByRole("button", { name: /^Ack/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: /Resolve…/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

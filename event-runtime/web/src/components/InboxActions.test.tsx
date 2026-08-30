import "../test-dom";
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AdmittedEvent, InboxItem } from "../types";
import { InboxActions, ciRerunEnvelope, replayEnvelope } from "./InboxActions";

afterEach(cleanup);

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: "inbox_action",
  kind: "CI RED",
  severity: "normal",
  title: "Action",
  body: null,
  refs: {},
  source: "serve:notify",
  createdAt: "2026-08-18T10:00:00.000Z",
  ackedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  delivery: {},
  ...overrides,
});

const event: AdmittedEvent = {
  source: "github",
  eventId: "failed-1",
  type: "github.workflow-run.failed",
  subject: "ci",
  status: "admitted",
  occurredAt: "2026-08-18T10:00:00.000Z",
  receivedAt: "2026-08-18T10:00:00.000Z",
  correlationId: "failed-1",
  planFailures: 0,
  lastPlanError: null,
  admittedAt: "2026-08-18T10:00:00.000Z",
  proposalId: null,
  runId: null,
  envelope: {
    schemaVersion: "factory.event/v1",
    eventId: "failed-1",
    type: "github.workflow-run.failed",
    source: "github",
    occurredAt: "2026-08-18T10:00:00.000Z",
    correlationId: "failed-1",
    payload: { repo: "watt-mind/factory", runId: 987 },
  },
  repos: ["factory"],
};

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

test("builds fresh replay and CI-rerun envelopes correlated to the inbox item", () => {
  const source = item({
    kind: "human_needed",
    refs: { eventSource: "github", eventId: "failed-1" },
  });
  expect(replayEnvelope(source, event, NOW)).toMatchObject({
    eventId: `inbox-${source.id}-${NOW}`,
    source: "inbox",
    correlationId: source.id,
    causationId: "failed-1",
    type: "github.workflow-run.failed",
  });
  expect(
    ciRerunEnvelope(
      item({ refs: { repo: "fallback/repo", pr: "PR #42" } }),
      event,
      NOW,
    ),
  ).toMatchObject({
    type: "factory.ci-rerun.requested",
    source: "inbox",
    correlationId: "inbox_action",
    payload: { repo: "watt-mind/factory", runId: 987 },
  });
});

test("renders only diagnose-first jump/resolve chrome and explains escalations", () => {
  const calls = {
    events: mock(async () => ({ events: [] })),
    replay: mock(async (_envelope: unknown) => ({
      admitted: true,
      duplicate: false,
      eventId: "x",
    })),
    triggerSchedule: mock(async (_loop: string) => ({}) as never),
    repos: mock(async () => ({ repos: [] }) as never),
    schedules: mock(async () => ({ schedules: [] }) as never),
  };
  const escalated = render(
    <InboxActions
      item={item({ kind: "ESCALATED", refs: { issue: "WM-287", pr: "607" } })}
      connected
      prUrl="https://github.com/watt-mind/factory/pull/607"
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={calls}
    />,
  );
  expect(escalated.getByText("Open PR")).toBeTruthy();
  expect(escalated.getByText("Open issue")).toBeTruthy();
  expect(escalated.getByText(/deliberately cannot merge/)).toBeTruthy();
  expect(escalated.queryByRole("button")).toBeNull();
  escalated.unmount();

  const resolve = mock(() => {});
  const smoke = render(
    <InboxActions
      item={item({ kind: "SMOKE RED", refs: { issue: "WM-287" } })}
      connected
      onResolve={resolve}
      onItemChange={() => {}}
      apiCalls={calls}
    />,
  );
  fireEvent.click(smoke.getByRole("button", { name: "Resolve…" }));
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(smoke.queryByText(/retry/i)).toBeNull();
});

test("Replay, Rerun CI, and Ship use their existing API request shapes and refetch", async () => {
  const replay = mock(async (_envelope: unknown) => ({
    admitted: true,
    duplicate: false,
    eventId: "new",
  }));
  const triggerSchedule = mock(async (_loop: string) => ({}) as never);
  const apiCalls = {
    events: mock(async () => ({ events: [event] })),
    replay,
    triggerSchedule,
    repos: mock(
      async () =>
        ({
          repos: [{ name: "factory", github: "watt-mind/factory" }],
        }) as never,
    ),
    schedules: mock(
      async () => ({ schedules: [{ loop: "ship-factory" }] }) as never,
    ),
  };
  const changed = mock(() => {});

  const replayView = render(
    <InboxActions
      item={item({
        kind: "human_needed",
        refs: { eventSource: "github", eventId: "failed-1" },
      })}
      connected
      onResolve={() => {}}
      onItemChange={changed}
      apiCalls={apiCalls}
      now={() => NOW}
    />,
  );
  fireEvent.click(replayView.getByRole("button", { name: "Replay" }));
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
  expect(replay.mock.calls[0][0]).toMatchObject({
    source: "inbox",
    correlationId: "inbox_action",
  });
  replayView.unmount();

  const ciView = render(
    <InboxActions
      item={item({
        refs: {
          repo: "watt-mind/factory",
          pr: "987",
          eventSource: "github",
          eventId: "failed-1",
        },
      })}
      connected
      onResolve={() => {}}
      onItemChange={changed}
      apiCalls={apiCalls}
      now={() => NOW}
    />,
  );
  fireEvent.click(ciView.getByRole("button", { name: "Rerun CI" }));
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
  expect(replay.mock.calls[1][0]).toMatchObject({
    type: "factory.ci-rerun.requested",
    payload: { repo: "watt-mind/factory", runId: 987 },
  });
  expect(ciView.getByText("Request created")).toBeTruthy();
  expect(ciView.queryByRole("button", { name: "Rerun CI" })).toBeNull();
  ciView.unmount();

  const shipView = render(
    <InboxActions
      item={item({ kind: "RC READY", refs: { repo: "factory" } })}
      connected
      onResolve={() => {}}
      onItemChange={changed}
      apiCalls={apiCalls}
    />,
  );
  fireEvent.click(shipView.getByRole("button", { name: "Ship" }));
  await waitFor(() =>
    expect(triggerSchedule).toHaveBeenCalledWith("ship-factory"),
  );
  expect(shipView.getByText("Request created")).toBeTruthy();
  expect(shipView.queryByRole("button", { name: "Ship" })).toBeNull();
  expect(changed).toHaveBeenCalledTimes(3);
});

test("Replay finds a referenced human-needed event beyond the first 200 events", async () => {
  const replay = mock(async (_envelope: unknown) => ({
    admitted: true,
    duplicate: false,
    eventId: "new",
  }));
  const newerEvents = Array.from({ length: 200 }, (_, index) => ({
    ...event,
    eventId: `newer-${index}`,
    envelope: { ...event.envelope, eventId: `newer-${index}` },
  }));
  const olderEvents = Array.from({ length: 49 }, (_, index) => ({
    ...event,
    eventId: `older-${index}`,
    envelope: { ...event.envelope, eventId: `older-${index}` },
  }));
  const apiCalls = {
    events: mock(
      async (
        _status?: string,
        page: { limit?: number; before?: string } = {},
      ) =>
        page.before === "cursor-1"
          ? { events: [...olderEvents, event], nextBefore: null }
          : { events: newerEvents, nextBefore: "cursor-1" },
    ),
    replay,
    triggerSchedule: mock(async (_loop: string) => ({}) as never),
    repos: mock(async () => ({ repos: [] }) as never),
    schedules: mock(async () => ({ schedules: [] }) as never),
  };
  const view = render(
    <InboxActions
      item={item({
        kind: "human_needed",
        refs: { eventSource: "github", eventId: "failed-1" },
      })}
      connected
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={apiCalls}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Replay" }));
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
  expect(apiCalls.events).toHaveBeenNthCalledWith(1, "human_needed", {
    limit: 200,
    before: undefined,
  });
  expect(apiCalls.events).toHaveBeenNthCalledWith(2, "human_needed", {
    limit: 200,
    before: "cursor-1",
  });
});

test("a successful Replay stays completed and cannot be submitted twice", async () => {
  const replay = mock(async (_envelope: unknown) => ({
    admitted: true,
    duplicate: false,
    eventId: "new",
  }));
  const apiCalls = {
    events: mock(async () => ({ events: [event] })),
    replay,
    triggerSchedule: mock(async (_loop: string) => ({}) as never),
    repos: mock(async () => ({ repos: [] }) as never),
    schedules: mock(async () => ({ schedules: [] }) as never),
  };
  const view = render(
    <InboxActions
      item={item({
        kind: "human_needed",
        refs: { eventSource: "github", eventId: "failed-1" },
      })}
      connected
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={apiCalls}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Replay" }));
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
  const button = view.getByRole("button", { name: "Replayed" });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button);
  expect(replay).toHaveBeenCalledTimes(1);

  view.rerender(
    <InboxActions
      item={item({
        kind: "human_needed",
        title: "Changed action",
        refs: { eventSource: "github", eventId: "failed-1" },
      })}
      connected
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={apiCalls}
    />,
  );
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Replay" }).hasAttribute("disabled"),
    ).toBe(false),
  );
});

test("an item already correlated to a proposal replaces its mutating action", () => {
  const apiCalls = {
    events: mock(async () => ({ events: [] })),
    replay: mock(async (_envelope: unknown) => ({
      admitted: true,
      duplicate: false,
      eventId: "x",
    })),
    triggerSchedule: mock(async (_loop: string) => ({}) as never),
    repos: mock(async () => ({ repos: [] }) as never),
    schedules: mock(async () => ({ schedules: [] }) as never),
  };
  const view = render(
    <InboxActions
      item={item({
        kind: "RC READY",
        refs: { repo: "factory", proposalId: "prop_ship" },
      })}
      connected
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={apiCalls}
    />,
  );
  expect(view.getByText("Open proposal").getAttribute("href")).toBe(
    "#/proposals/prop_ship",
  );
  expect(view.queryByRole("button", { name: "Ship" })).toBeNull();
});

test("Rerun CI maps a short repo name to its GitHub slug, and Ship refuses a repo with no ship schedule", async () => {
  const replay = mock(async (_envelope: unknown) => ({
    admitted: true,
    duplicate: false,
    eventId: "new",
  }));
  const triggerSchedule = mock(async (_loop: string) => ({}) as never);
  const apiCalls = {
    events: mock(async () => ({ events: [] })),
    replay,
    triggerSchedule,
    repos: mock(
      async () =>
        ({
          repos: [{ name: "factory", github: "watt-mind/factory" }],
        }) as never,
    ),
    schedules: mock(
      async () => ({ schedules: [{ loop: "ship-bj29" }] }) as never,
    ),
  };
  const rerun = render(
    <InboxActions
      item={item({
        kind: "CI RED",
        refs: { repo: "factory", runId: "123", pr: "PR #123" },
      })}
      connected
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={apiCalls}
      now={() => 1_700_000_000_000}
    />,
  );
  fireEvent.click(rerun.getByRole("button", { name: "Rerun CI" }));
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
  const envelope = replay.mock.calls[0][0] as {
    payload: { repo: string; runId: string };
  };
  expect(envelope.payload.repo).toBe("watt-mind/factory");
  expect(envelope.payload.runId).toBe("123");
  expect(() =>
    ciRerunEnvelope(
      item({ refs: { repo: "watt-mind/factory", pr: "PR #123" } }),
      null,
    ),
  ).toThrow("Rerun CI needs the failed workflow run reference");
  cleanup();

  const ship = render(
    <InboxActions
      item={item({ kind: "RC READY", refs: { repo: "factory" } })}
      connected
      onResolve={() => {}}
      onItemChange={() => {}}
      apiCalls={apiCalls}
    />,
  );
  fireEvent.click(ship.getByRole("button", { name: "Ship" }));
  await waitFor(() =>
    expect(
      ship.getByText(/No ship schedule is configured for "factory"/),
    ).toBeTruthy(),
  );
  expect(triggerSchedule).not.toHaveBeenCalled();
});

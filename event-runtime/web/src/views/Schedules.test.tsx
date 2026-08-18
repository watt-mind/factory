import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Schedules,
  scheduleFilterTokens,
  type ScheduleItem,
} from "./Schedules";
import { api } from "../api";
import { useContextActions } from "../palette";
import { changeInput } from "../test-render";

afterEach(() => {
  cleanup();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const noop = () => {};

function schedule(
  overrides: Partial<ScheduleItem> & Pick<ScheduleItem, "loop">,
): ScheduleItem {
  return {
    repo: null,
    every: "5m",
    cadenceSeconds: 300,
    eventType: "tick.test",
    approval: "watched",
    catchUp: "none",
    singleton: false,
    enabled: true,
    lastSlot: null,
    lastCompletedSlot: null,
    neverCompleted: true,
    nextDue: null,
    intervalsLate: null,
    stopped: false,
    error: null,
    ...overrides,
  };
}

/** The four enabled × stopped combinations (WM-101). */
const rows: ScheduleItem[] = [
  schedule({ loop: "loop-enabled-running", enabled: true, stopped: false }),
  schedule({
    loop: "loop-enabled-stopped",
    enabled: true,
    stopped: true,
    intervalsLate: 3,
  }),
  schedule({ loop: "loop-disabled-idle", enabled: false, stopped: false }),
  schedule({
    loop: "loop-disabled-stopped",
    enabled: false,
    stopped: true,
    intervalsLate: 7,
  }),
];

const origFetch = globalThis.fetch;
const origAgents = api.agents;
const origEvents = api.events;
const origTriggerSchedule = api.triggerSchedule;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("/api/schedules")) {
      return new Response(JSON.stringify({ schedules: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  api.agents = async () => ({
    agents: [],
    edges: {},
    eventTypes: [],
    contracts: {},
  });
  api.events = async () => ({ events: [] });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  api.agents = origAgents;
  api.events = origEvents;
  api.triggerSchedule = origTriggerSchedule;
});

function scheduleViewProps(
  overrides: Partial<{
    connected: boolean;
    focusScheduleLoop: string | null;
    onSelectSchedule: (loop: string | null) => void;
  }> = {},
) {
  return {
    context: { kind: "all" as const },
    focusScheduleLoop: null as string | null,
    onSelectSchedule: noop,
    onJumpProposal: noop,
    onJumpRun: noop,
    onJumpEvent: noop,
    onJumpAgent: noop,
    ...overrides,
  };
}

function renderSchedules(
  overrides: Partial<{
    connected: boolean;
    focusScheduleLoop: string | null;
    onSelectSchedule: (loop: string | null) => void;
  }> = {},
) {
  return renderWithClient(<Schedules {...scheduleViewProps(overrides)} />);
}

function StatefulSchedules({
  connected,
  initialLoop = null,
}: {
  connected?: boolean;
  initialLoop?: string | null;
}) {
  const [loop, setLoop] = useState<string | null>(initialLoop);
  return (
    <Schedules
      {...scheduleViewProps({
        connected,
        focusScheduleLoop: loop,
        onSelectSchedule: setLoop,
      })}
    />
  );
}

function PaletteProbe() {
  const actions = useContextActions();
  return (
    <div data-testid="palette-probe">
      {actions.map((a) => a.label).join(" | ")}
    </div>
  );
}

function pressKey(key: string) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

describe("Schedules enabled/state wording (WM-101)", () => {
  test("enabled + not stopped renders 'enabled' and 'running' with semantic tooltips", async () => {
    const { getByText, getAllByText, queryByText } = renderSchedules();

    await waitFor(() => getByText("loop-enabled-running"));

    const enabledCells = getAllByText("enabled");
    expect(enabledCells.length).toBe(2); // the two enabled rows
    expect(enabledCells[0]!.title).toContain(
      "enabled: true in event-runtime/schedules.json",
    );

    const running = getByText("running");
    expect(running.title).toContain("scheduler loop is ticking");

    // The ambiguous old wording is gone entirely.
    expect(queryByText("off")).toBeNull();
    expect(queryByText("ok")).toBeNull();
  });

  test("enabled + stopped renders 'stopped (N late)' with the stalled-clock tooltip", async () => {
    const { getByText } = renderSchedules();

    await waitFor(() => getByText("loop-enabled-stopped"));

    const stopped = getByText("stopped (3 late)");
    expect(stopped.title).toContain(
      "enabled: true but the scheduler loop is not ticking",
    );
    expect(stopped.title).toContain("3 intervals");
  });

  test("disabled + not stopped renders 'disabled' and 'not scheduled' pointing at schedules.json", async () => {
    const { getByText, getAllByText, getByRole } = renderSchedules();

    await waitFor(() => getByRole("tab", { name: /Disabled/ }));
    fireEvent.click(getByRole("tab", { name: /Disabled/ }));
    await waitFor(() => getByText("loop-disabled-idle"));

    const disabledCells = getAllByText("disabled");
    expect(disabledCells.length).toBe(2); // the two disabled rows
    expect(disabledCells[0]!.title).toContain(
      "enabled: false in event-runtime/schedules.json",
    );

    const notScheduled = getAllByText("not scheduled");
    expect(notScheduled[0]!.title).toContain(
      "enabled: false in event-runtime/schedules.json",
    );
  });

  test("disabled + stopped still renders 'not scheduled' (a disabled loop cannot be a stalled clock)", async () => {
    const { getByText, getAllByText, queryByText, getByRole } =
      renderSchedules();

    await waitFor(() => getByRole("tab", { name: /Disabled/ }));
    fireEvent.click(getByRole("tab", { name: /Disabled/ }));
    await waitFor(() => getByText("loop-disabled-stopped"));

    // Both disabled rows collapse to "not scheduled"; the stopped flag on a
    // disabled row never surfaces as a stalled-clock alarm.
    expect(getAllByText("not scheduled").length).toBe(2);
    expect(queryByText("stopped (7 late)")).toBeNull();
  });

  test("column headers and footer say where enable/disable lives", async () => {
    const { getByText, getByTitle } = renderSchedules();

    await waitFor(() => getByText("loop-enabled-running"));

    expect(
      getByTitle(/Config flag from event-runtime\/schedules.json/).title,
    ).toContain("event-runtime/schedules.json");
    expect(getByText("State").title).toContain("Runtime health");
    expect(getByText(/there is no.*toggle here/s)).toBeTruthy();
  });

  test("filter tokens match the visible enabled/state words for all four combinations", () => {
    // enabled + running
    expect(scheduleFilterTokens(rows[0]!)).toContain("enabled");
    expect(scheduleFilterTokens(rows[0]!)).toContain("running");
    // enabled + stopped
    expect(scheduleFilterTokens(rows[1]!)).toContain("enabled");
    expect(scheduleFilterTokens(rows[1]!)).toContain("stopped");
    // disabled rows expose "disabled" and "not scheduled", never the old "off"/"ok"
    for (const s of [rows[2]!, rows[3]!]) {
      const tokens = scheduleFilterTokens(s);
      expect(tokens).toContain("disabled");
      expect(tokens).toContain("not scheduled");
      expect(tokens).not.toContain("off");
      expect(tokens).not.toContain("ok");
    }
    // error wins the state token
    expect(
      scheduleFilterTokens(schedule({ loop: "l", error: "bad cadence" })),
    ).toContain("error");
  });
});

describe("Schedules tabs and default ordering (WM-549)", () => {
  test("defaults to Enabled and exposes All, Enabled, and Disabled counts", async () => {
    const view = renderSchedules();

    const enabledTab = await view.findByRole("tab", { name: /Enabled\s*2/ });
    const allTab = view.getByRole("tab", { name: /All\s*4/ });
    const disabledTab = view.getByRole("tab", { name: /Disabled\s*2/ });

    expect(enabledTab.getAttribute("aria-selected")).toBe("true");
    expect(view.getByText("loop-enabled-running")).toBeTruthy();
    expect(view.queryByText("loop-disabled-idle")).toBeNull();
    expect(view.getByText(/2 enabled · 2 disabled/)).toBeTruthy();

    fireEvent.click(allTab);
    expect(view.getByText("loop-disabled-idle")).toBeTruthy();

    fireEvent.click(disabledTab);
    expect(view.queryByText("loop-enabled-running")).toBeNull();
    expect(view.getByText("loop-disabled-idle")).toBeTruthy();
  });

  test("orders enabled first, then next due ascending, then loop name", async () => {
    const orderedRows = [
      schedule({
        loop: "disabled-z",
        enabled: false,
        nextDue: "2030-01-01T00:00:00.000Z",
      }),
      schedule({ loop: "enabled-later", nextDue: "2030-01-02T00:00:00.000Z" }),
      schedule({ loop: "enabled-undated", nextDue: null }),
      schedule({
        loop: "disabled-a",
        enabled: false,
        nextDue: "2030-01-03T00:00:00.000Z",
      }),
      schedule({ loop: "enabled-sooner", nextDue: "2030-01-01T00:00:00.000Z" }),
    ];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("/api/schedules")) {
        return new Response(JSON.stringify({ schedules: orderedRows }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    const view = renderSchedules();
    const allTab = await view.findByRole("tab", { name: /All\s*5/ });
    fireEvent.click(allTab);

    const renderedLoops = [
      ...view.container.querySelectorAll("tbody tr td:first-child"),
    ].map((cell) => cell.textContent);
    expect(renderedLoops).toEqual([
      "enabled-sooner",
      "enabled-later",
      "enabled-undated",
      "disabled-a",
      "disabled-z",
    ]);
  });
});

describe("Schedules connected gating (WM-156)", () => {
  test("list and detail Run now buttons are disabled when connected={false}", async () => {
    const { getAllByRole } = renderSchedules({
      connected: false,
      focusScheduleLoop: "loop-enabled-running",
    });

    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(1),
    );

    for (const btn of getAllByRole("button", { name: "Run now…" })) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test("keyboard r does not open confirm when disconnected", async () => {
    const { getAllByRole, queryByRole, queryByText } = renderWithClient(
      <StatefulSchedules
        connected={false}
        initialLoop="loop-enabled-running"
      />,
    );

    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    pressKey("r");

    expect(queryByRole("button", { name: "Trigger Run" }) === null).toBe(true);
    expect(queryByText(/Run schedule/) === null).toBe(true);
  });

  test("palette omits Run now when disconnected", async () => {
    const { getAllByRole, getByTestId } = renderWithClient(
      <>
        <StatefulSchedules
          connected={false}
          initialLoop="loop-enabled-running"
        />
        <PaletteProbe />
      </>,
    );

    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(getByTestId("palette-probe").textContent).toContain(
        "Copy loop-enabled-running",
      ),
    );

    const labels = getByTestId("palette-probe").textContent ?? "";
    expect(labels).not.toMatch(/Run .* now/);
  });

  test("confirm primary stays disabled after connection drops", async () => {
    function ConfirmThenDisconnect() {
      const [connected, setConnected] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setConnected(false)}>
            simulate-disconnect
          </button>
          <StatefulSchedules
            connected={connected}
            initialLoop="loop-enabled-running"
          />
        </>
      );
    }

    const { getByText, getByRole, getAllByRole } = renderWithClient(
      <ConfirmThenDisconnect />,
    );

    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(getAllByRole("button", { name: "Run now…" })[0]!);
    await waitFor(() => getByRole("button", { name: "Trigger Run" }));

    expect(
      (getByRole("button", { name: "Trigger Run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(getByText("simulate-disconnect"));

    expect(
      (getByRole("button", { name: "Trigger Run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("Run now buttons are enabled when connected={true}", async () => {
    const { getAllByRole } = renderSchedules({
      connected: true,
      focusScheduleLoop: "loop-enabled-running",
    });

    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(1),
    );

    for (const btn of getAllByRole("button", { name: "Run now…" })) {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe("Schedules aria-selected (WM-156)", () => {
  test("selected row has aria-selected=true; others false; updates on click and j/k", async () => {
    const { getByText, container } = renderWithClient(
      <StatefulSchedules connected={true} />,
    );

    await waitFor(() => getByText("loop-enabled-running"));

    const dataRows = () => [...container.querySelectorAll("tbody tr")];
    expect(
      dataRows().every((row) => row.getAttribute("aria-selected") === "false"),
    ).toBe(true);

    fireEvent.click(getByText("loop-enabled-running"));
    expect(dataRows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(
      dataRows()
        .slice(1)
        .every((row) => row.getAttribute("aria-selected") === "false"),
    ).toBe(true);

    pressKey("j");
    expect(dataRows()[0]!.getAttribute("aria-selected")).toBe("false");
    expect(dataRows()[1]!.getAttribute("aria-selected")).toBe("true");

    pressKey("k");
    expect(dataRows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(dataRows()[1]!.getAttribute("aria-selected")).toBe("false");
  });
});

describe("Schedules copy chords and hints (WM-233)", () => {
  test("copy chords: c (loop), c l (link) and utility hints", async () => {
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

    const r = renderSchedules({
      connected: true,
      focusScheduleLoop: "loop-enabled-running",
    });

    const loopBtn = await r.findByRole("button", {
      name: "Copy schedule loop (c)",
    });

    // Verify icon-action tooltips preserve shortcut discoverability.
    expect(
      loopBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
    ).toBe("Copy schedule loop · c");
    const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
    expect(
      linkBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
    ).toBe("Copy link · c l");

    // 1. Press 'c' -> copies loop
    fireEvent.keyDown(document.body, { key: "c" });
    expect(written).toBe("loop-enabled-running");

    // 2. Press 'l' immediately after 'c' -> 'c l' copies link
    fireEvent.keyDown(document.body, { key: "l" });
    expect(written).toBe(window.location.href);
  });
});

describe("Schedules action shortcut badge (WM-236)", () => {
  test("renders the shared Schedules breadcrumb in the standard pane width (WM-552)", async () => {
    const view = renderSchedules({ focusScheduleLoop: "loop-enabled-running" });
    const breadcrumb = await view.findByRole("navigation", {
      name: "Breadcrumb",
    });

    expect(breadcrumb.textContent).toContain("Schedules/");
    expect(breadcrumb.textContent).toContain("loop-enabled-running");
    expect(view.container.querySelector("aside")?.className).toContain(
      "w-[440px]",
    );
  });

  test("detail pane 'Run now…' button renders 'r' shortcut hint badge with aria-hidden", async () => {
    const { container } = renderWithClient(
      <StatefulSchedules connected={true} initialLoop="loop-enabled-running" />,
    );

    const detailPane = await waitFor(() => {
      const el = container.querySelector("aside");
      if (!el) throw new Error("detail pane not rendered");
      return el;
    });

    const buttons = [...detailPane.querySelectorAll("button")];
    const runBtn = buttons.find((b) => b.textContent?.includes("Run now…"));
    expect(runBtn).toBeTruthy();

    const badge = runBtn!.querySelector("span.mono");
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe("r");
    expect(badge!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Schedules manual merge targeting (WM-426)", () => {
  const mergeSchedule = schedule({
    loop: "merge-factory",
    eventType: "factory.merge.requested",
    approval: "auto",
    repo: "factory",
  });

  function serveMergeSchedule() {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("/api/schedules")) {
        return new Response(JSON.stringify({ schedules: [mergeSchedule] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;
  }

  test("submits explicit PR numbers from the merge confirmation", async () => {
    serveMergeSchedule();
    const calls: Array<{ loop: string; prNumbers?: number[] }> = [];
    api.triggerSchedule = async (loop, prNumbers) => {
      calls.push({ loop, prNumbers });
      return {
        admitted: true,
        duplicate: false,
        eventId: "manual:merge-factory:test",
        proposalId: null,
        runId: "run-test",
        decision: "run",
        reason: null,
        disabled: false,
        loop,
      };
    };

    const view = renderWithClient(
      <StatefulSchedules connected={true} initialLoop="merge-factory" />,
    );
    await waitFor(() =>
      expect(
        view.getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(view.getAllByRole("button", { name: "Run now…" })[0]!);

    const input = await view.findByRole("textbox", {
      name: "PR numbers (optional)",
    });
    expect(
      view.getByText(/Leave blank to review all open PRs in factory/),
    ).toBeTruthy();
    expect(view.getByText("Autonomous merge automation")).toBeTruthy();
    expect(
      view.getByText(
        /mutating downstream automation without another confirmation/,
      ),
    ).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(
      "schedule-pr-numbers-help",
    );
    act(() => changeInput(input, "411, 426"));
    fireEvent.click(view.getByRole("button", { name: "Trigger Run" }));

    await waitFor(() =>
      expect(calls).toEqual([{ loop: "merge-factory", prNumbers: [411, 426] }]),
    );
  });

  test("invalid merge selection exposes an input-associated error", async () => {
    serveMergeSchedule();
    const view = renderWithClient(
      <StatefulSchedules connected={true} initialLoop="merge-factory" />,
    );
    await waitFor(() =>
      expect(
        view.getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(view.getAllByRole("button", { name: "Run now…" })[0]!);
    const input = await view.findByRole("textbox", {
      name: "PR numbers (optional)",
    });
    act(() => changeInput(input, "426, 426"));
    fireEvent.click(view.getByRole("button", { name: "Trigger Run" }));

    const error = await view.findByRole("alert");
    expect(error.textContent).toContain("only once");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
  });

  test("blank merge selection submits no override and means all open PRs", async () => {
    serveMergeSchedule();
    const calls: Array<{ loop: string; prNumbers?: number[] }> = [];
    api.triggerSchedule = async (loop, prNumbers) => {
      calls.push({ loop, prNumbers });
      return {
        admitted: true,
        duplicate: false,
        eventId: "manual:merge-factory:all",
        proposalId: null,
        runId: "run-all",
        decision: "run",
        reason: null,
        disabled: false,
        loop,
      };
    };

    const view = renderWithClient(
      <StatefulSchedules connected={true} initialLoop="merge-factory" />,
    );
    await waitFor(() =>
      expect(
        view.getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(view.getAllByRole("button", { name: "Run now…" })[0]!);
    await view.findByRole("textbox", { name: "PR numbers (optional)" });
    fireEvent.click(view.getByRole("button", { name: "Trigger Run" }));

    await waitFor(() =>
      expect(calls).toEqual([{ loop: "merge-factory", prNumbers: undefined }]),
    );
  });
});

describe("Schedules list row height (WM-843)", () => {
  test("list Run now uses sm (h-6) and overlaps py-1.5 padding", async () => {
    const view = renderSchedules();
    await waitFor(() =>
      expect(
        view.getAllByRole("button", { name: "Run now…" }).length,
      ).toBeGreaterThan(0),
    );
    const table = view.container.querySelector("table");
    expect(table).toBeTruthy();
    const btn = within(table as HTMLElement).getAllByRole("button", {
      name: "Run now…",
    })[0]!;
    expect(btn.getAttribute("data-control-size")).toBe("sm");
    const tokens = btn.className.split(/\s+/);
    expect(tokens).toContain("h-6");
    expect(tokens).toContain("-my-1.5");
    expect(tokens).not.toContain("h-7");
  });
});

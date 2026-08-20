import "./test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { App, listSelectionPath, navIsCurrent } from "./App";
import { goPrefix } from "./goSequence";
import { refetchIntervals } from "./hooks";
import { NAV } from "./nav";
import { createProposalFixture } from "./test-render";
import type { MetricsView, Proposal, StatusView } from "./types";

const ENV = { name: "dev", home: "/tmp/factory", adapter: null };

// Deterministic counts so the badge cases (Events, Proposals) are exercised:
// the fixture keeps proposals/events/runs badges visible in the "all" context.
// Typed so a StatusView shape change breaks here, not as an Overview crash.
const STATUS: StatusView = {
  env: ENV,
  proposals: { open: 9, expired: 0 },
  runs: { byState: { RUNNING: 2, QUEUED: 1 } },
  events: { human_needed: 4, dead_lettered: 2 },
  workers: { busy: 1, stale: 0, live: 1 },
  artifacts: { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 },
  anomalies: {
    expiredOpenProposals: [],
    ambiguousOpenProposals: [],
    staleLeases: 0,
    stalledWorkers: [],
    deadLettered: [],
    unpublishedOutbox: 0,
    noWorkers: false,
  },
};

const HEALTH = { ok: true, policyVersion: "test", env: ENV };
// One approvable open proposal, so the proposals route renders the detail pane
// whose Approve button carries the health-derived tooltip (WM-738).
const OPEN_PROPOSAL_ID = "prop_health_wiring";

const EMPTY_METRICS: MetricsView = {
  window: "24h",
  bucket: "1h",
  buckets: [],
  series: {
    "runs.outcomes": {},
    "runs.started": { total: [] },
    "latency.queue_wait": { p50: [], p95: [] },
    "latency.execution": { p50: [], p95: [] },
    "spend.cost": {},
    "spend.tokens": {},
    "proposals.decisions": {},
    "proposals.time_to_decision": { p50: [], p95: [] },
    "events.intake": {},
    "attempts.retries": { total: [] },
  },
};
let currentStatus = STATUS;
// "pending" never resolves, which is what a first load looks like before
// /api/health answers; "error" is a runtime that answered with a failure.
let healthMode: "ok" | "pending" | "error" = "ok";
let healthCalls = 0;
let currentProposals: Proposal[] = [];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
const realPrimaryRefetchInterval = refetchIntervals.primary.refetchInterval;

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  // Scope queries to the sidebar landmark: views render their own controls
  // (Overview has a "Graph" button too) and must not satisfy nav assertions.
  const sidebar = within(utils.getByRole("navigation", { name: "Primary" }));
  // Exposed so a test can drive a poll tick itself instead of waiting out the
  // 2s refetch interval.
  return { ...utils, sidebar, queryClient };
}

beforeEach(() => {
  currentStatus = STATUS;
  healthMode = "ok";
  healthCalls = 0;
  currentProposals = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/health")) {
      healthCalls += 1;
      if (healthMode === "pending") return new Promise<Response>(() => {});
      if (healthMode === "error")
        return new Response(JSON.stringify({ error: "runtime down" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      return jsonResponse(HEALTH);
    }
    if (url.includes("/api/status")) return jsonResponse(currentStatus);
    if (url.includes("/api/proposals")) {
      // `?status=all` is the decided-history join; only the open list carries
      // the proposal the detail pane selects. created_at is minted per request
      // so the fixture's TTL never lapses mid-suite.
      if (url.includes("status=")) return jsonResponse({ proposals: [] });
      return jsonResponse({
        proposals:
          currentProposals.length > 0
            ? currentProposals
            : [
                createProposalFixture({
                  id: OPEN_PROPOSAL_ID,
                  created_at: new Date().toISOString(),
                  ttl_seconds: 300,
                }),
              ],
      });
    }
    if (url.includes("/api/agents")) {
      return jsonResponse({
        agents: [],
        eventTypes: [],
        edges: {},
        contracts: {},
        schemaHash: "test",
        publishedAt: new Date().toISOString(),
      });
    }
    if (url.includes("/api/repos")) return jsonResponse({ repos: [] });
    if (url.includes("/api/metrics")) return jsonResponse(EMPTY_METRICS);
    if (url.includes("/api/config")) {
      // Object-shaped so Settings can read `.registry` / `.sections`. The
      // generic `[]` fallback is truthy and then throws on `.registry.loadedAt`.
      return jsonResponse({
        generatedAt: "2026-01-01T00:00:00.000Z",
        policyVersion: "wm857-config",
        registry: {
          loadedAt: "2026-01-01T00:00:00.000Z",
          agentCount: 0,
          eventTypeCount: 0,
          edgeCount: 0,
          scheduleCount: 0,
        },
        sections: [
          {
            id: "policy",
            title: "Policy",
            source: { file: "config/policy.yaml", kind: "yaml" },
            reload: "hot",
            entries: [{ key: "workers.max", value: 20 }],
          },
        ],
      });
    }
    if (url.includes("/api/runs?ticket=")) {
      const ticket =
        new URL(url, "http://localhost").searchParams.get("ticket") ?? "WM-0";
      return jsonResponse({
        ticket: {
          id: ticket,
          title: null,
          state: null,
          createdAt: null,
          url: `https://linear.app/watt-mind/issue/${ticket}`,
        },
        activity: false,
        events: [],
        proposals: [],
        runs: [],
      });
    }
    // Views poll their own endpoints; an empty list keeps them quiet.
    return jsonResponse([]);
  }) as typeof fetch;
  goPrefix.armedAt = 0;
  window.location.href = "http://localhost/";
});

afterEach(() => {
  Object.assign(refetchIntervals.primary, {
    refetchInterval: realPrimaryRefetchInterval,
  });
  goPrefix.armedAt = 0;
  cleanup();
  globalThis.fetch = realFetch;
});

describe("cold query rendering (WM-266)", () => {
  test("keeps the shell available before the initial status query resolves", () => {
    const { sidebar } = renderApp();
    expect(sidebar.getByRole("button", { name: "Overview" })).toBeTruthy();
  });

  test("treats missing nested status sections as empty badge data", async () => {
    currentStatus = {} as StatusView;
    const { sidebar, queryClient } = renderApp();

    await waitFor(() => {
      expect(queryClient.getQueryState(["status"])?.status).toBe("success");
    });

    expect(sidebar.getByRole("button", { name: "Proposals" })).toBeTruthy();
    expect(sidebar.getByRole("button", { name: "Runs" })).toBeTruthy();
    expect(sidebar.getByRole("button", { name: "Artifacts" })).toBeTruthy();
  });
});

describe("sidebar navigation accessibility", () => {
  test("detail routes keep their parent navigation entry current", () => {
    expect(navIsCurrent("runs", "run")).toBe(true);
    expect(navIsCurrent("tickets", "prs")).toBe(true);
    expect(navIsCurrent("chains", "chain")).toBe(true);
    expect(navIsCurrent("events", "chain")).toBe(false);
  });

  test("every NAV entry is a button whose accessible name is exactly its label", async () => {
    const { sidebar } = renderApp();
    // Wait for the status fixture to land so badge-carrying entries (Events 6,
    // Proposals 9, Runs 3) are tested with their badges actually rendered.
    await waitFor(() => {
      expect(
        sidebar.getByRole("button", { name: "Proposals" }).textContent,
      ).toContain("9");
    });
    for (const n of NAV) {
      // Exact match: a badge that leaks into the name ("Events 6") fails here.
      const button = sidebar.getByRole("button", { name: n.label });
      expect(button.tagName).toBe("BUTTON");
    }
  });

  test("count badges are exposed as the button's accessible description", async () => {
    const { sidebar } = renderApp();
    await waitFor(() => {
      expect(
        sidebar.getByRole("button", { name: "Events" }).textContent,
      ).toContain("6");
    });
    for (const [label, expected] of [
      ["Events", "6"],
      ["Proposals", "9"],
      ["Runs", "3"],
    ] as const) {
      const button = sidebar.getByRole("button", { name: label });
      const describedBy = button.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const badge = document.getElementById(describedBy!)!;
      expect(badge).toBeTruthy();
      expect(badge.textContent).toContain(expected);
      // The badge must not leak into the name (exact-name match above already
      // guarantees this; the explicit visible count keeps the fixture honest).
      expect(within(button).getByText(expected)).toBeTruthy();
    }
    // Badge-less entries carry no dangling describedby reference.
    expect(
      sidebar
        .getByRole("button", { name: "Overview" })
        .hasAttribute("aria-describedby"),
    ).toBe(false);
  });

  test("the active entry — and only it — exposes aria-current=page", async () => {
    window.location.hash = "#/events";
    const { sidebar } = renderApp();
    await waitFor(() => {
      expect(
        sidebar
          .getByRole("button", { name: "Events" })
          .getAttribute("aria-current"),
      ).toBe("page");
    });
    for (const n of NAV) {
      const button = sidebar.getByRole("button", { name: n.label });
      expect(button.getAttribute("aria-current")).toBe(
        n.key === "events" ? "page" : null,
      );
    }
  });

  test("renders navigation rail grouped into functional tiers separated by dividers (WM-819)", async () => {
    const { sidebar } = renderApp();
    const separators = sidebar.getAllByRole("separator");
    expect(separators.length).toBe(3);

    const buttons = sidebar.getAllByRole("button");
    const labels = buttons.map((b) => b.textContent?.trim()).filter(Boolean);
    const overviewIdx = labels.findIndex((l) => l?.startsWith("Overview"));
    const inboxIdx = labels.findIndex((l) => l?.startsWith("Inbox"));
    const proposalsIdx = labels.findIndex((l) => l?.startsWith("Proposals"));
    const runsIdx = labels.findIndex((l) => l?.startsWith("Runs"));
    const eventsIdx = labels.findIndex((l) => l?.startsWith("Events"));
    const ticketsIdx = labels.findIndex((l) => l?.startsWith("Tickets"));
    const chainsIdx = labels.findIndex((l) => l?.startsWith("Chains"));

    expect(overviewIdx).toBeLessThan(inboxIdx);
    expect(inboxIdx).toBeLessThan(proposalsIdx);
    expect(proposalsIdx).toBeLessThan(runsIdx);
    expect(runsIdx).toBeLessThan(eventsIdx);
    expect(eventsIdx).toBeLessThan(ticketsIdx);
    expect(ticketsIdx).toBeLessThan(chainsIdx);
  });
});

describe("view registry routing (WM-839)", () => {
  test("an unknown first segment lands on Overview, with no rail entry current", async () => {
    window.location.hash = "#/no-such-view";
    const utils = renderApp();
    expect(
      await utils.findByRole("heading", { name: "Overview" }),
    ).toBeTruthy();
    for (const n of NAV) {
      expect(
        utils.sidebar
          .getByRole("button", { name: n.label })
          .getAttribute("aria-current"),
      ).toBe(null);
    }
  });

  test("an id-less drill-in route falls back to its list view and keeps the parent current", async () => {
    window.location.hash = "#/run";
    const utils = renderApp();
    expect(await utils.findByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(
      utils.sidebar
        .getByRole("button", { name: "Runs" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(window.location.hash).toBe("#/run");
  });

  test("a lazily registered view with a focus param resolves through the registry", async () => {
    window.location.hash = `#/proposals/${OPEN_PROPOSAL_ID}`;
    const utils = renderApp();
    expect(
      await utils.findByRole("heading", { name: "Proposals" }),
    ).toBeTruthy();
    expect(
      utils.sidebar
        .getByRole("button", { name: "Proposals" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.title).toBe(`factory · Proposals · ${OPEN_PROPOSAL_ID}`);
  });

  test("the Settings route renders against the config fixture (WM-857)", async () => {
    window.location.hash = "#/settings";
    const utils = renderApp();
    expect(
      await utils.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      utils.sidebar
        .getByRole("button", { name: "Settings" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(await utils.findByText("wm857-config")).toBeTruthy();
    expect(utils.getByText("workers.max")).toBeTruthy();
  });
});

describe("Graph proposal navigation (WM-165)", () => {
  test("Open in Proposals routes through App to the selected proposal", async () => {
    currentProposals = [
      createProposalFixture({
        id: "prop_graph",
        agent: "doctor@1",
        spec: null,
        repos: [],
      }),
    ];
    window.location.hash = "#/graph/proposal:prop_graph";
    const utils = renderApp();

    const open = await utils.findByRole("button", {
      name: "Open in Proposals",
    });
    fireEvent.click(open);

    expect(window.location.hash).toBe("#/proposals/prop_graph");
    await utils.findByRole("heading", { name: "Proposals" });
  });
});

describe("responsive primary navigation (WM-175)", () => {
  test("mobile toggle opens and closes the overlay navigation accessibly", async () => {
    const utils = renderApp();
    const nav = utils.getByRole("navigation", { name: "Primary" });
    const main = utils.getByRole("main");
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });
    const toggle = utils.getByRole("button", { name: "Open navigation" });

    expect(toggle.getAttribute("aria-controls")).toBe("primary-navigation");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(nav.className).toContain("hidden");
    expect(nav.className).toContain("md:flex");
    expect(nav.className).toContain("md:w-52");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(nav.className).toContain("flex");
    expect(nav.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    const close = utils.getByRole("button", { name: "Close navigation" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(main.hasAttribute("inert")).toBe(true);
    expect(main.getAttribute("aria-hidden")).toBe("true");
    expect(statusBar.hasAttribute("inert")).toBe(true);

    const navButtons = within(nav).getAllByRole("button");
    const first = navButtons[0]!;
    const last = navButtons.at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(nav.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(main.hasAttribute("inert")).toBe(false);
    expect(main.hasAttribute("aria-hidden")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  test("choosing a destination closes the mobile navigation and preserves its landmark", () => {
    const utils = renderApp();
    const toggle = utils.getByRole("button", { name: "Open navigation" });

    fireEvent.click(toggle);
    fireEvent.click(utils.sidebar.getByRole("button", { name: "Events" }));

    expect(window.location.hash).toBe("#/events");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      utils.getByRole("navigation", { name: "Primary" }).getAttribute("id"),
    ).toBe("primary-navigation");
  });
});

test("metrics list selections preserve the reproducible drill-down query", () => {
  const hash =
    "#/runs?from=2026-08-18T08%3A00%3A00.000Z&to=2026-08-18T09%3A00%3A00.000Z&population=terminal&state=FAILED&project=factory";
  expect(listSelectionPath("runs", "run_1", hash)).toBe(
    "runs/run_1?from=2026-08-18T08%3A00%3A00.000Z&to=2026-08-18T09%3A00%3A00.000Z&population=terminal&state=FAILED",
  );
  expect(listSelectionPath("runs", null, hash)).toStartWith("runs?from=");
  expect(listSelectionPath("proposals", "prop_1", "#/proposals")).toBe(
    "proposals/prop_1",
  );
});

describe("bottom status bar", () => {
  test("stale-only fleet agrees with the Workers badge instead of saying no workers (WM-159)", async () => {
    currentStatus = {
      ...STATUS,
      workers: { busy: 0, stale: 1, live: 0 },
    };
    const utils = renderApp();
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });

    await waitFor(() => {
      expect(
        utils.sidebar.getByRole("button", { name: "Workers" }).textContent,
      ).toContain("1stale");
      expect(statusBar.textContent).toContain("1 stale worker");
    });
    expect(statusBar.textContent).not.toContain("no workers");
  });

  test("empty registry still says no workers (WM-159)", async () => {
    currentStatus = {
      ...STATUS,
      workers: { busy: 0, stale: 0, live: 0 },
    };
    const utils = renderApp();
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });

    await waitFor(() => {
      expect(statusBar.textContent).toContain("no workers");
    });
  });

  test("renders connection status, policy, workers, shortcuts, and theme switcher", async () => {
    const utils = renderApp();
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });
    expect(statusBar).toBeTruthy();

    await waitFor(() => {
      expect(statusBar.textContent).toContain("connected");
      expect(statusBar.textContent).toContain("test");
      expect(statusBar.textContent).toContain("1 worker");
      expect(statusBar.textContent).toContain("⌘K commands");
      expect(statusBar.textContent).toContain("i inject");
      expect(statusBar.textContent).toContain("g go");
      expect(statusBar.textContent).toContain("? keys");
    });

    const themeButton = within(statusBar).getByRole("button", {
      name: /Theme:/i,
    });
    expect(themeButton).toBeTruthy();
    expect(themeButton.getAttribute("aria-label")).toBe(
      "Theme: dark. Switch to light.",
    );

    act(() => {
      themeButton.click();
    });
    expect(themeButton.getAttribute("aria-label")).toBe(
      "Theme: light. Switch to contrast.",
    );

    act(() => {
      themeButton.click();
    });
    expect(themeButton.getAttribute("aria-label")).toBe(
      "Theme: contrast. Switch to dark.",
    );

    act(() => {
      themeButton.click();
    });
    expect(themeButton.getAttribute("aria-label")).toBe(
      "Theme: dark. Switch to light.",
    );
  });
});

describe("health connection chrome (WM-724)", () => {
  // The chip is the only styled button in the sidebar header; its label is the
  // connection word, so the text query doubles as the state assertion.
  const statusDot = (statusBar: HTMLElement) =>
    statusBar.querySelector<HTMLElement>("span.rounded-full")!;

  test("a pending first load reads as connecting, not disconnected", async () => {
    healthMode = "pending";
    const utils = renderApp();
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });

    // The status fixture lands while health is still in flight — that is the
    // exact window in which the old chrome flashed an outage.
    await waitFor(() => {
      expect(
        utils.sidebar.getByRole("button", { name: "Proposals" }).textContent,
      ).toContain("9");
    });

    const chip = utils.sidebar.getByText("connecting");
    expect(chip.getAttribute("style")).toContain("--text-dim");
    expect(utils.sidebar.queryByText("disconnected")).toBeNull();
    expect(chip.getAttribute("title")).not.toContain("runtime unreachable");

    expect(statusDot(statusBar).getAttribute("style")).toContain("--text-dim");
    expect(statusBar.textContent).not.toContain("runtime unreachable");
    expect(statusBar.textContent).toContain("connecting");

    // No banner either — pending is not a failure anywhere in the chrome.
    expect(utils.queryByText(/Runtime unreachable —/)).toBeNull();
  });

  test("a failed health check turns chip, status bar and banner red together", async () => {
    healthMode = "error";
    // App's explicit two-second policy overrides QueryClient defaults. Disable
    // it here so only the Retry click can issue a second health request.
    Object.assign(refetchIntervals.primary, {
      refetchInterval: () => false,
    });
    const utils = renderApp();
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });

    await waitFor(() => {
      expect(utils.sidebar.getByText("disconnected")).toBeTruthy();
    });
    expect(
      utils.sidebar.getByText("disconnected").getAttribute("style"),
    ).toContain("--hue-err");
    expect(statusDot(statusBar).getAttribute("style")).toContain("--hue-err");
    expect(statusBar.textContent).toContain("runtime unreachable");
    expect(utils.getByText(/Runtime unreachable —/)).toBeTruthy();

    const before = healthCalls;
    fireEvent.click(utils.getByRole("button", { name: "Retry" }));
    expect(healthCalls).toBe(before + 1);
  });

  test("a healthy runtime names the env on the chip and connects in the status bar", async () => {
    const utils = renderApp();
    const statusBar = utils.getByRole("contentinfo", { name: "Status bar" });

    await waitFor(() => {
      expect(utils.sidebar.getByText("dev")).toBeTruthy();
    });
    const chip = utils.sidebar.getByText("dev");
    expect(chip.getAttribute("style")).not.toContain("--hue-err");
    expect(chip.getAttribute("title")).toContain("/tmp/factory");
    expect(statusDot(statusBar).getAttribute("style")).toContain("--hue-ok");
    expect(statusBar.textContent).toContain("connected · test");
    expect(utils.queryByText(/Runtime unreachable —/)).toBeNull();
  });
});

describe("env chip click affordance (WM-728)", () => {
  const originalClipboard = navigator.clipboard;
  const stubClipboard = () => {
    let written = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written = text;
          return Promise.resolve();
        },
      },
    });
    return {
      get written() {
        return written;
      },
    };
  };

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  test("a disconnected chip retries health instead of a no-op", async () => {
    healthMode = "error";
    Object.assign(refetchIntervals.primary, {
      refetchInterval: () => false,
    });
    const clip = stubClipboard();
    const utils = renderApp();
    await waitFor(() => {
      expect(utils.sidebar.getByText("disconnected")).toBeTruthy();
    });

    const chip = utils.sidebar.getByText("disconnected");
    expect(chip.getAttribute("title")).toMatch(/retry|reconnect/i);
    expect(chip.getAttribute("title")).not.toMatch(/copy/i);

    const before = healthCalls;
    fireEvent.click(chip);
    expect(healthCalls).toBe(before + 1);
    expect(clip.written).toBe("");
  });

  test("a connecting chip does not copy home", async () => {
    healthMode = "pending";
    const clip = stubClipboard();
    const utils = renderApp();
    await waitFor(() => {
      expect(
        utils.sidebar.getByRole("button", { name: "Proposals" }).textContent,
      ).toContain("9");
    });

    const chip = utils.sidebar.getByText("connecting");
    expect(chip.getAttribute("title")).toMatch(/retry|reconnect/i);
    expect(chip.getAttribute("title")).not.toMatch(/copy/i);

    // The first /health is still in flight; refetch joins it rather than
    // minting a second request. The contract here is: pending never copies.
    const before = healthCalls;
    fireEvent.click(chip);
    expect(clip.written).toBe("");
    expect(healthCalls).toBe(before);
  });

  test("a connected chip copies env.home and does not refetch", async () => {
    const clip = stubClipboard();
    const utils = renderApp();
    await waitFor(() => {
      expect(utils.sidebar.getByText("dev")).toBeTruthy();
    });

    const chip = utils.sidebar.getByText("dev");
    expect(chip.getAttribute("title")).toMatch(/copy/i);
    expect(chip.getAttribute("title")).not.toMatch(/retry|reconnect/i);

    const before = healthCalls;
    fireEvent.click(chip);
    expect(clip.written).toBe("/tmp/factory");
    expect(healthCalls).toBe(before);
  });
});

describe("Proposals approval tooltip health wiring (WM-738)", () => {
  // The tooltip sits on the wrapper span around the Approve button, because a
  // disabled button does not fire hover events (Proposals.tsx).
  const approvalTooltip = (utils: ReturnType<typeof renderApp>) =>
    utils
      .getByRole("button", { name: /^Approve/ })
      .parentElement?.getAttribute("title");

  async function renderProposalDetail() {
    window.location.hash = `#/proposals/${OPEN_PROPOSAL_ID}`;
    const utils = renderApp();
    await utils.findByRole("button", { name: /^Approve/ });
    return utils;
  }

  test("a pending first load says approval is waiting to connect", async () => {
    healthMode = "pending";
    const utils = await renderProposalDetail();
    await waitFor(() => {
      expect(approvalTooltip(utils)).toBe(
        "Approval is unavailable while connecting.",
      );
    });
  });

  test("a failed health check says approval is unavailable while disconnected", async () => {
    healthMode = "error";
    const utils = await renderProposalDetail();
    await waitFor(() => {
      expect(approvalTooltip(utils)).toBe(
        "Approval is unavailable while disconnected.",
      );
    });
  });

  // The regression WM-738 shipped: the tooltip was wired to
  // `isPending || isFetching`, so a runtime that died under a live console
  // downgraded its own outage to "connecting" on every 2s poll. Only
  // `isPending` means "first load, nothing heard back yet"; `isFetching` is
  // true again the moment any poll starts, outage or not.
  test("a failed poll that is refetching still reads as disconnected, not connecting", async () => {
    const utils = await renderProposalDetail();
    await waitFor(() => {
      expect(utils.sidebar.getByText("dev")).toBeTruthy();
    });
    expect(approvalTooltip(utils)).toBeNull();

    // The runtime dies under a console that had already connected.
    healthMode = "error";
    await act(async () => {
      await utils.queryClient.refetchQueries({ queryKey: ["health"] });
    });
    await waitFor(() => {
      expect(approvalTooltip(utils)).toBe(
        "Approval is unavailable while disconnected.",
      );
    });

    // The poll after that is in flight and stays that way: fetching, but still
    // nothing heard back. This is the state the two signals disagree about.
    healthMode = "pending";
    const before = healthCalls;
    void utils.queryClient.refetchQueries({ queryKey: ["health"] });
    await waitFor(() => {
      expect(healthCalls).toBeGreaterThan(before);
    });

    expect(approvalTooltip(utils)).toBe(
      "Approval is unavailable while disconnected.",
    );
    // The chrome must agree with the tooltip — both read the same signal.
    expect(utils.sidebar.getByText("disconnected")).toBeTruthy();
    expect(utils.sidebar.queryByText("connecting")).toBeNull();
  });
});

describe("inject hotkey (WM-80)", () => {
  test("`i` opens the inject dialog with template search focused", async () => {
    const { findByPlaceholderText } = renderApp();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true }),
      );
    });
    const search = await findByPlaceholderText(/search event types/i);
    expect(document.activeElement === search).toBe(true);
  });
});

describe("filter hotkey / (WM-217)", () => {
  test("`/` focuses trace search when data-trace-search element is present", async () => {
    renderApp();
    const traceInput = document.createElement("input");
    traceInput.setAttribute("data-trace-search", "");
    document.body.appendChild(traceInput);
    try {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "/", bubbles: true }),
        );
      });
      expect(document.activeElement === traceInput).toBe(true);
    } finally {
      traceInput.remove();
    }
  });
});

describe("context strip fast jump chords (WM-235)", () => {
  test("`g 1`..`g 9` switch to open repo tabs, `g 0` clears to All, `g i` switches to In flight", async () => {
    sessionStorage.setItem(
      "factory.contextTabs",
      JSON.stringify({ openRepos: ["alpha", "bravo"], active: "all" }),
    );
    window.location.hash = "#/events";
    const utils = renderApp();
    await waitFor(() => {
      expect(
        utils.sidebar.getByRole("button", { name: "Events" }),
      ).toBeDefined();
    });

    // g 1 jumps to 1st repo (alpha)
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "1" });
    });
    expect(window.location.hash).toContain("project=alpha");

    // g 2 jumps to 2nd repo (bravo)
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "2" });
    });
    expect(window.location.hash).toContain("project=bravo");

    // g 0 clears to All context
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "0" });
    });
    expect(window.location.hash).not.toContain("project=");

    // g i jumps to In flight context (and switches to runs view if not already on runs)
    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "i" });
    });
    expect(window.location.hash).toBe("#/runs?project=inflight");

    // g i does NOT open the inject dialog
    expect(utils.queryByPlaceholderText(/search event types/i)).toBeNull();
  });

  test("view chords (including g k ticket picker) still work alongside context chords", async () => {
    window.location.hash = "#/overview";
    const utils = renderApp();
    await waitFor(() => {
      expect(
        utils.sidebar.getByRole("button", { name: "Overview" }),
      ).toBeDefined();
    });

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "e" });
    });
    expect(window.location.hash).toBe("#/events");

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "p" });
    });
    expect(window.location.hash).toBe("#/proposals");

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(window.location.hash).toBe("#/runs");

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "m" });
    });
    expect(window.location.hash).toBe("#/metrics");
    expect(await utils.findByRole("heading", { name: "Metrics" })).toBeTruthy();

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "k" });
    });
    expect(window.location.hash).toBe("#/tickets");
    const ticketInput = await utils.findByRole("textbox", {
      name: "Ticket id",
    });
    expect(document.activeElement === ticketInput).toBe(true);
  });

  test("view slot is a height-capped flex column so ListPane views scroll inside it (WM-981)", async () => {
    window.location.hash = "#/tickets";
    const utils = renderApp();
    const slot = await utils.findByTestId("view-slot");
    const tokens = slot.className.split(/\s+/);
    expect(tokens).toEqual(
      expect.arrayContaining([
        "flex",
        "min-h-0",
        "flex-1",
        "flex-col",
        "overflow-hidden",
      ]),
    );
    const hub = await utils.findByTestId("tickets-hub");
    expect(slot.contains(hub)).toBe(true);
  });

  test("`g` prefix arms and displays GoPrefixHint legend with context chords", async () => {
    const utils = renderApp();
    await waitFor(() => {
      expect(
        utils.sidebar.getByRole("button", { name: "Overview" }),
      ).toBeDefined();
    });

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
    });

    const hint = utils.getByText(/Navigation prefix g armed/);
    expect(hint).toBeDefined();
    expect(utils.container.textContent).toContain("0 All");
    expect(utils.container.textContent).toContain("1–9 repos");
    expect(utils.container.textContent).toContain("i In flight");
  });
});

describe("ticket journey navigation (WM-595)", () => {
  test("exact ticket-id chips in detail panes navigate to the ticket journey", async () => {
    const utils = renderApp();
    const chip = document.createElement("button");
    chip.type = "button";
    chip.title = "WM-542";
    chip.textContent = "WM-542";
    utils.getByRole("main").appendChild(chip);

    await waitFor(() => {
      fireEvent.click(chip);
      expect(window.location.hash).toBe("#/tickets/WM-542");
    });
  });

  test("exact ticket values in JSON are exposed as keyboard-navigable journey links", async () => {
    const utils = renderApp();
    const value = document.createElement("span");
    value.textContent = '"WM-400"';
    utils.getByRole("main").appendChild(value);
    const link = await utils.findByRole("link", { name: "Open ticket WM-400" });
    fireEvent.keyDown(link, { key: "Enter" });
    expect(window.location.hash).toBe("#/tickets/WM-400");
  });

  test("typing a PR reference in the command palette opens #/prs/<n> (WM-640)", async () => {
    const utils = renderApp();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const input = utils.getByPlaceholderText("Type a command…");
    fireEvent.input(input, { target: { value: "#541" } });
    const command = await utils.findByText("#541", { selector: "span.mono" });
    fireEvent.click(command.closest("[cmdk-item]")!);
    expect(window.location.hash).toBe("#/prs/541");
    await utils.findByText("no runtime activity for PR #541");
  });

  test("typing a ticket id in the command palette offers its journey", async () => {
    const utils = renderApp();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const input = utils.getByPlaceholderText("Type a command…");
    fireEvent.input(input, { target: { value: "WM-595" } });
    // Two items name the ticket (WM-594 adds "Why isn't WM-595 running?"); both open the journey.
    const [command, why] = await utils.findAllByText("WM-595", {
      selector: "span.mono",
    });
    expect(why.closest("[cmdk-item]")!.textContent).toContain("Why isn't");
    fireEvent.click(command.closest("[cmdk-item]")!);
    expect(window.location.hash).toBe("#/tickets/WM-595");
  });
});

describe("view navigation landmark focus and announcement (WM-325, WM-542)", () => {
  test("main landmark receives focus and announces the view on navigation", async () => {
    const utils = renderApp();
    const main = utils.getByRole("main");

    act(() => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(window.location.hash).toBe("#/runs");

    await waitFor(() => {
      expect(document.activeElement).toBe(main);
      expect(main.textContent).toContain("Runs view");
    });
  });

  test("theme suppresses the landmark ring without removing interactive focus rings", async () => {
    const themeCss = await Bun.file(
      new URL("./theme.css", import.meta.url),
    ).text();

    expect(themeCss).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*\}/s,
    );
    expect(themeCss).toMatch(
      /main\[tabindex="-1"\]:focus-visible\s*\{\s*outline:\s*none;\s*\}/,
    );
  });
});

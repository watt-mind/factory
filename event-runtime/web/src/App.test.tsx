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
import { App } from "./App";
import { goPrefix } from "./goSequence";
import { NAV } from "./nav";
import type { StatusView } from "./types";

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
let currentStatus = STATUS;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

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
  return { ...utils, sidebar };
}

beforeEach(() => {
  currentStatus = STATUS;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/health")) return jsonResponse(HEALTH);
    if (url.includes("/api/status")) return jsonResponse(currentStatus);
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
    if (url.includes("/api/runs?ticket=")) {
      const ticket = new URL(url, "http://localhost").searchParams.get("ticket") ?? "WM-0";
      return jsonResponse({
        ticket: { id: ticket, title: null, state: null, createdAt: null, url: `https://linear.app/watt-mind/issue/${ticket}` },
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
  goPrefix.armedAt = 0;
  cleanup();
  globalThis.fetch = realFetch;
});

describe("sidebar navigation accessibility", () => {
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
      expect(utils.sidebar.getByRole("button", { name: "Workers" }).textContent).toContain(
        "1stale",
      );
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
      fireEvent.keyDown(document.body, { key: "k" });
    });
    expect(window.location.hash).toBe("#/tickets");
    const ticketInput = await utils.findByRole("textbox", { name: "Ticket id" });
    expect(document.activeElement === ticketInput).toBe(true);
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

  test("typing a ticket id in the command palette offers its journey", async () => {
    const utils = renderApp();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const input = utils.getByPlaceholderText("Type a command…");
    fireEvent.input(input, { target: { value: "WM-595" } });
    const command = await utils.findByText("WM-595", { selector: "span.mono" });
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
    const themeCss = await Bun.file(new URL("./theme.css", import.meta.url)).text();

    expect(themeCss).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*\}/s,
    );
    expect(themeCss).toMatch(
      /main\[tabindex="-1"\]:focus-visible\s*\{\s*outline:\s*none;\s*\}/,
    );
  });
});


import "./test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/health")) return jsonResponse(HEALTH);
    if (url.includes("/api/status")) return jsonResponse(STATUS);
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
      expect(sidebar.getByRole("button", { name: "Proposals" }).textContent).toContain("9");
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
      expect(sidebar.getByRole("button", { name: "Events" }).textContent).toContain("6");
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
    expect(sidebar.getByRole("button", { name: "Overview" }).hasAttribute("aria-describedby")).toBe(false);
  });

  test("the active entry — and only it — exposes aria-current=page", async () => {
    window.location.hash = "#/events";
    const { sidebar } = renderApp();
    await waitFor(() => {
      expect(sidebar.getByRole("button", { name: "Events" }).getAttribute("aria-current")).toBe("page");
    });
    for (const n of NAV) {
      const button = sidebar.getByRole("button", { name: n.label });
      expect(button.getAttribute("aria-current")).toBe(n.key === "events" ? "page" : null);
    }
  });
});

describe("bottom status bar", () => {
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

    const themeButton = within(statusBar).getByRole("button", { name: /Theme:/i });
    expect(themeButton).toBeTruthy();
    expect(themeButton.getAttribute("aria-label")).toBe("Theme: dark. Switch to light.");

    act(() => {
      themeButton.click();
    });
    expect(themeButton.getAttribute("aria-label")).toBe("Theme: light. Switch to contrast.");

    act(() => {
      themeButton.click();
    });
    expect(themeButton.getAttribute("aria-label")).toBe("Theme: contrast. Switch to dark.");

    act(() => {
      themeButton.click();
    });
    expect(themeButton.getAttribute("aria-label")).toBe("Theme: dark. Switch to light.");
  });
});

describe("inject hotkey (WM-80)", () => {
  test("`i` opens the inject dialog with template search focused", async () => {
    const { findByPlaceholderText } = renderApp();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
    });
    const search = await findByPlaceholderText(/search event types/i);
    expect(document.activeElement === search).toBe(true);
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
      expect(utils.sidebar.getByRole("button", { name: "Events" })).toBeDefined();
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

  test("view chords (g o, g e, g p, g r) still work alongside context chords", async () => {
    window.location.hash = "#/overview";
    const utils = renderApp();
    await waitFor(() => {
      expect(utils.sidebar.getByRole("button", { name: "Overview" })).toBeDefined();
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
  });

  test("`g` prefix arms and displays GoPrefixHint legend with context chords", async () => {
    const utils = renderApp();
    await waitFor(() => {
      expect(utils.sidebar.getByRole("button", { name: "Overview" })).toBeDefined();
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

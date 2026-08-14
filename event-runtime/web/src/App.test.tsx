import "./test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { App } from "./App";
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
    // Views poll their own endpoints; an empty list keeps them quiet.
    return jsonResponse([]);
  }) as typeof fetch;
  window.location.hash = "";
});

afterEach(() => {
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

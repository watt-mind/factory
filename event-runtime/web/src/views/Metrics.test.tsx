import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Metrics, METRICS_WINDOW_KEY, metricsAreEmpty } from "./Metrics";
import type { MetricsBreakdownView, MetricsView } from "../types";

const populated: MetricsView = {
  window: "24h",
  bucket: "1h",
  buckets: ["2026-08-18T08:00:00.000Z", "2026-08-18T09:00:00.000Z"],
  series: {
    "runs.outcomes": {
      COMPLETED: [2, 1],
      FAILED: [0, 1],
      REFUSED: [0, 0],
      TIMED_OUT: [0, 0],
      CANCELLED: [0, 0],
    },
    "runs.started": { total: [2, 2] },
    "latency.queue_wait": { p50: [1000, 2000], p95: [3000, 4000] },
    "latency.execution": { p50: [10_000, 12_000], p95: [20_000, 24_000] },
    "spend.cost": { "dispatch@1": [0.25, 0.5] },
    "spend.tokens": { "dispatch@1": [100, 200] },
    "proposals.decisions": {
      approved: [1, 1],
      rejected: [0, 1],
      expired: [0, 0],
      superseded: [0, 0],
    },
    "proposals.time_to_decision": { p50: [5000, 6000], p95: [9000, 10_000] },
    "events.intake": { admitted: [2, 2] },
    "attempts.retries": { total: [0, 1] },
  },
};

const adapterBreakdown: MetricsBreakdownView = {
  window: "24h",
  by: "adapter",
  metric: "runs",
  limit: 8,
  rows: [
    { key: "claude", value: 3 },
    { key: "pi", value: 1 },
  ],
};

const modelBreakdown: MetricsBreakdownView = {
  window: "24h",
  by: "model",
  metric: "tokens",
  limit: 8,
  rows: [
    { key: "model-fixture-1", value: 250 },
    { key: "gpt-4o", value: 50 },
  ],
};

function emptyMetrics(): MetricsView {
  const zero = [0, 0];
  const none = [null, null];
  return {
    ...populated,
    series: {
      "runs.outcomes": {
        COMPLETED: zero,
        FAILED: zero,
        REFUSED: zero,
        TIMED_OUT: zero,
        CANCELLED: zero,
      },
      "runs.started": { total: zero },
      "latency.queue_wait": { p50: none, p95: none },
      "latency.execution": { p50: none, p95: none },
      "spend.cost": {},
      "spend.tokens": {},
      "proposals.decisions": {
        approved: zero,
        rejected: zero,
        expired: zero,
        superseded: zero,
      },
      "proposals.time_to_decision": { p50: none, p95: none },
      "events.intake": {},
      "attempts.retries": { total: zero },
    },
  };
}

function renderMetrics() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Metrics />
    </QueryClientProvider>,
  );
}

const realFetch = globalThis.fetch;
let response: Response;
let requests: string[];

beforeEach(() => {
  localStorage.clear();
  requests = [];
  response = Response.json(populated);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/metrics/breakdown")) {
      if (url.includes("by=adapter")) return Response.json(adapterBreakdown);
      if (url.includes("by=model")) return Response.json(modelBreakdown);
      return Response.json({
        window: "24h",
        by: "unknown",
        metric: "runs",
        limit: 8,
        rows: [],
      });
    }
    return response.clone();
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("Metrics", () => {
  test("renders all four live sections and links marks to exact list populations", async () => {
    const view = renderMetrics();
    await view.findByRole("heading", { name: "Reliability" });
    for (const section of ["Latency", "Spend", "Approval gate"]) {
      expect(view.getByRole("heading", { name: section })).toBeTruthy();
    }
    expect(view.getByRole("heading", { name: "Harness share" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Model share" })).toBeTruthy();
    const failed = view.getByRole("link", { name: /1 failed run in/i });
    expect(failed.getAttribute("href")).toContain("#/runs?");
    expect(failed.getAttribute("href")).toContain("population=terminal");
    expect(failed.getAttribute("href")).toContain("state=FAILED");
    expect(
      view
        .getAllByRole("img")
        .every((chart) => chart.getAttribute("aria-label")),
    ).toBe(true);
  });

  test("Retry rate and Token volume share Outcome mix card geometry as stacked bars", async () => {
    const view = renderMetrics();
    const outcome = await view.findByRole("img", { name: /Outcome mix:/ });
    const retry = view.getByRole("img", { name: /Retry rate by/ });
    const tokens = view.getByRole("img", { name: /Token volume by agent/ });
    for (const chart of [outcome, retry, tokens]) {
      expect(chart.getAttribute("viewBox")).toBe("0 0 600 180");
      expect(chart.getAttribute("preserveAspectRatio")).toBe("none");
      expect(chart.querySelector("polyline")).toBeNull();
      expect(
        chart.querySelectorAll("rect[data-segment]").length,
      ).toBeGreaterThan(0);
    }
    const retried = view.getByRole("link", { name: /1 retried run in/i });
    expect(retried.getAttribute("href")).toContain("population=retried");
    const retryBar = retry.querySelector(
      '[data-bar="2026-08-18T09:00:00.000Z"]',
    );
    expect(retryBar?.querySelector('[data-segment="retries"]')).toBeTruthy();
    expect(retryBar?.querySelector('[data-segment="first"]')).toBeTruthy();
  });

  test("Harness and Model share cards render ranked bars with window drilldown", async () => {
    const view = renderMetrics();
    const harness = await view.findByRole("img", {
      name: /Harness share by adapter/,
    });
    const models = await view.findByRole("img", {
      name: /Model share of recorded tokens/,
    });
    expect(harness.querySelector('[data-share-row="claude"]')).toBeTruthy();
    expect(
      models.querySelector('[data-share-row="model-fixture-1"]'),
    ).toBeTruthy();
    const claude = view.getByRole("link", { name: "claude: 3" });
    expect(claude.getAttribute("href")).toContain("population=created");
    expect(claude.getAttribute("href")).toContain("adapter=claude");
    const sonnet = view.getByRole("link", { name: "model-fixture-1: 250" });
    expect(sonnet.getAttribute("href")).toContain("population=usage");
    expect(sonnet.getAttribute("href")).toContain("model=model-fixture-1");
  });

  test("switches and persists the selected window", async () => {
    const view = renderMetrics();
    await view.findByRole("heading", { name: "Reliability" });
    fireEvent.click(view.getByRole("button", { name: "1h" }));
    await waitFor(() =>
      expect(localStorage.getItem(METRICS_WINDOW_KEY)).toBe("1h"),
    );
    await waitFor(() =>
      expect(
        requests.some(
          (url) => url.includes("window=1h") && url.includes("bucket=15m"),
        ),
      ).toBe(true),
    );
  });

  test("distinguishes an empty window from an unreachable API", async () => {
    response = Response.json(emptyMetrics());
    const empty = renderMetrics();
    expect((await empty.findByRole("status")).textContent).toContain(
      "No activity in this 24h window",
    );
    expect(empty.queryAllByRole("img")).toHaveLength(0);
    empty.unmount();

    response = new Response("offline", { status: 503 });
    const failed = renderMetrics();
    expect((await failed.findByRole("alert")).textContent).toContain(
      "Metrics API unreachable",
    );
    expect(failed.queryAllByRole("img")).toHaveLength(0);
  });
});

test("metricsAreEmpty treats null latency as missing rather than zero", () => {
  expect(metricsAreEmpty(emptyMetrics())).toBe(true);
  const data = emptyMetrics();
  data.series["latency.execution"].p50[1] = 25;
  expect(metricsAreEmpty(data)).toBe(false);
});

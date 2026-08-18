import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Metrics, METRICS_WINDOW_KEY, metricsAreEmpty } from "./Metrics";
import type { MetricsView } from "../types";

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
    requests.push(String(input));
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

  test("Retry rate and Token volume share Outcome mix card geometry", async () => {
    const view = renderMetrics();
    const outcome = await view.findByRole("img", { name: /Outcome mix:/ });
    const retry = view.getByRole("img", { name: /Retry rate by/ });
    const tokens = view.getByRole("img", { name: /recorded tokens/ });
    for (const chart of [outcome, retry, tokens]) {
      expect(chart.getAttribute("viewBox")).toBe("0 0 600 180");
      expect(chart.getAttribute("preserveAspectRatio")).toBe("none");
    }
    const retryLine = retry.querySelector("polyline");
    expect(retryLine).toBeTruthy();
    const xs = retryLine!
      .getAttribute("points")!
      .split(" ")
      .map((point) => Number(point.split(",")[0]));
    expect(xs[0]).toBe(4);
    expect(xs.at(-1)).toBe(596);
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

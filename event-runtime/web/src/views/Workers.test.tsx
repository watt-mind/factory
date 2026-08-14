import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workers, defaultWorkerTab, isLive, partitionWorkers } from "./Workers";
import { api } from "../api";
import type { Worker, WorkerState } from "../types";

afterEach(() => {
  cleanup();
});

const NOW = new Date().toISOString();

function stubWorker(workerId: string, state: WorkerState, stale = false): Worker {
  return {
    workerId,
    host: "lab-1",
    pid: 4242,
    labels: {},
    adapters: ["claude-code"],
    state,
    currentRun: null,
    lastSeen: NOW,
    stale,
    startedAt: NOW,
    stoppedAt: state === "stopped" ? NOW : null,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const noop = () => {};

function renderWorkers() {
  return renderWithClient(
    <Workers context={{ kind: "all" }} focusWorkerId={null} onSelectWorker={noop} />,
  );
}

function withWorkers(workers: Worker[], fn: () => Promise<void>) {
  const orig = api.workers;
  api.workers = async () => ({ workers });
  return fn().finally(() => {
    api.workers = orig;
  });
}

describe("worker live/stopped partition (WM-98)", () => {
  test("idle and busy workers are live; cleanly stopped ones are not", () => {
    expect(isLive(stubWorker("w_idle", "idle"))).toBe(true);
    expect(isLive(stubWorker("w_busy", "busy"))).toBe(true);
    expect(isLive(stubWorker("w_stopped", "stopped"))).toBe(false);
  });

  test("a stale worker is live — it may still hold a run, whatever it last reported", () => {
    expect(isLive(stubWorker("w_stale", "busy", true))).toBe(true);
  });

  test("partitionWorkers splits the registry and preserves order within each group", () => {
    const rows = [
      stubWorker("w_stopped_1", "stopped"),
      stubWorker("w_idle", "idle"),
      stubWorker("w_stopped_2", "stopped"),
      stubWorker("w_stale", "idle", true),
    ];
    const { live, stopped } = partitionWorkers(rows);
    expect(live.map((w) => w.workerId)).toEqual(["w_idle", "w_stale"]);
    expect(stopped.map((w) => w.workerId)).toEqual(["w_stopped_1", "w_stopped_2"]);
  });
});

describe("default worker tab (WM-98)", () => {
  test("opens on Live when at least one worker is live", () => {
    expect(defaultWorkerTab([stubWorker("w_stopped", "stopped"), stubWorker("w_idle", "idle")])).toBe(
      "LIVE",
    );
  });

  test("opens on All when every worker is stopped, and when the registry is empty", () => {
    expect(defaultWorkerTab([stubWorker("w_stopped", "stopped")])).toBe("ALL");
    expect(defaultWorkerTab([])).toBe("ALL");
  });
});

describe("Workers view default visibility (WM-98)", () => {
  test("stopped workers are hidden by default when a live worker exists", async () => {
    const workers = [
      stubWorker("w_stopped_old", "stopped"),
      stubWorker("w_idle_live", "idle"),
      stubWorker("w_stopped_new", "stopped"),
    ];
    await withWorkers(workers, async () => {
      const { getByText, queryByText, getByRole } = renderWorkers();
      await waitFor(() => {
        expect(getByText("w_idle_live")).toBeTruthy();
      });
      expect(queryByText("w_stopped_old")).toBeNull();
      expect(queryByText("w_stopped_new")).toBeNull();
      expect(getByRole("tab", { selected: true }).textContent).toContain("Live");
    });
  });

  test("an all-stopped registry opens on All so the page is not blank", async () => {
    const workers = [stubWorker("w_stopped_1", "stopped"), stubWorker("w_stopped_2", "stopped")];
    await withWorkers(workers, async () => {
      const { getByText, getByRole } = renderWorkers();
      await waitFor(() => {
        expect(getByText("w_stopped_1")).toBeTruthy();
      });
      expect(getByText("w_stopped_2")).toBeTruthy();
      expect(getByRole("tab", { selected: true }).textContent).toContain("All");
    });
  });
});

import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Workers,
  capacityFromWorkers,
  defaultWorkerTab,
  fleetBanner,
  isLive,
  partitionWorkers,
  workerDisplayState,
} from "./Workers";
import { api } from "../api";
import type { Worker, WorkerCapacity, WorkerState } from "../types";

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

function withWorkers(workers: Worker[], fn: () => Promise<void>, capacity?: WorkerCapacity) {
  const orig = api.workers;
  api.workers = async () => ({ workers, capacity: capacity ?? capacityFromWorkers(workers) });
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

describe("worker capacity and draining state (WM-228)", () => {
  test("draining is explicit unless stale overrides the supervisor request", () => {
    expect(workerDisplayState({ ...stubWorker("w_drain", "idle"), draining: true })).toBe("draining");
    expect(workerDisplayState({ ...stubWorker("w_stale", "busy", true), draining: true })).toBe("stale");
  });

  test("shows running/capacity, queue limiter, class caps, and an explicit draining row", async () => {
    const worker = {
      ...stubWorker("w_drain", "busy"),
      draining: true,
      currentRun: "run_capacity_123456",
      labels: { class: "heavy", node: "lab" },
    };
    const capacity: WorkerCapacity = {
      running: 1,
      capacity: 2,
      queued: 4,
      live: 1,
      idle: 0,
      draining: 1,
      target: 0,
      min: 1,
      max: 2,
      supervisor: "active",
      source: "worker-policy",
      limitingFactor: "at worker max",
      classes: [{ name: "heavy", running: 1, capacity: 2 }],
    };
    await withWorkers([worker], async () => {
      const { getByText, getAllByText, getByTitle } = renderWorkers();
      await waitFor(() => expect(getByText("1 running / 2 capacity")).toBeTruthy());
      expect(getByText("4 queued runs")).toBeTruthy();
      expect(getByText("at worker max")).toBeTruthy();
      expect(getByText("heavy 1/2")).toBeTruthy();
      expect(getAllByText("draining").length).toBeGreaterThan(0);
      expect(getByTitle("Open run_capacity_123456")).toBeTruthy();
      expect(getByTitle(new RegExp(`Started ${NOW}`))).toBeTruthy();
    }, capacity);
  });
});

describe("Workers responsive state control (WM-163)", () => {
  test("offers every state in a compact mobile control and keeps bracket cycling in sync", async () => {
    const workers = [stubWorker("w_idle", "idle"), stubWorker("w_stopped", "stopped")];
    await withWorkers(workers, async () => {
      const { getByRole, getByText } = renderWorkers();
      const stateControl = await waitFor(() => getByRole("combobox", { name: "Worker state" })) as HTMLSelectElement;

      expect(Array.from(stateControl.options).map((option) => option.textContent)).toEqual([
        "All 2",
        "Live 1",
        "Stopped 1",
      ]);
      expect(stateControl.value).toBe("LIVE");

      fireEvent.change(stateControl, { target: { value: "STOPPED" } });
      await waitFor(() => expect(getByText("w_stopped")).toBeTruthy());
      expect(getByRole("tab", { selected: true }).textContent).toContain("Stopped");

      fireEvent.keyDown(document.body, { key: "]" });
      await waitFor(() => expect(stateControl.value).toBe("ALL"));
      expect(getByRole("tab", { selected: true }).textContent).toContain("All");
    });
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

describe("fleet banner vs Live tab (WM-155)", () => {
  test("classifier: empty, all-stopped, and stale-only are distinct; idle/busy suppress the banner", () => {
    expect(fleetBanner([])).toEqual({ kind: "empty" });
    expect(fleetBanner([stubWorker("w_stopped", "stopped")])).toEqual({ kind: "all-stopped", count: 1 });
    expect(fleetBanner([stubWorker("w_stale", "busy", true)])).toEqual({ kind: "stale", stale: 1, stopped: 0 });
    expect(
      fleetBanner([stubWorker("w_stale", "idle", true), stubWorker("w_stopped", "stopped")]),
    ).toEqual({ kind: "stale", stale: 1, stopped: 1 });
    expect(fleetBanner([stubWorker("w_idle", "idle")])).toBeNull();
    expect(fleetBanner([stubWorker("w_idle", "idle"), stubWorker("w_stale", "busy", true)])).toBeNull();
  });

  test("stale-only fleet opens on Live with the stale row and does not say “No live workers detected”", async () => {
    const workers = [stubWorker("w_stale_only", "busy", true)];
    await withWorkers(workers, async () => {
      const { getByText, queryByText, getByRole } = renderWorkers();
      await waitFor(() => {
        expect(getByText("w_stale_only")).toBeTruthy();
      });
      expect(getByRole("tab", { selected: true }).textContent).toContain("Live");
      expect(queryByText("No live workers detected")).toBeNull();
      expect(getByText("Workers are stale")).toBeTruthy();
      expect(getByText(/missed the heartbeat window/i)).toBeTruthy();
    });
  });

  test("empty registry banner says no workers registered, not “No live workers detected”", async () => {
    await withWorkers([], async () => {
      const { getByText, queryByText, findByText } = renderWorkers();
      expect(await findByText("No workers registered")).toBeTruthy();
      expect(queryByText("No live workers detected")).toBeNull();
      expect(getByText(/No workers have registered with the runtime/i)).toBeTruthy();
    });
  });

  test("all-stopped banner says workers are stopped, not stale-or-stopped", async () => {
    const workers = [stubWorker("w_stopped_1", "stopped"), stubWorker("w_stopped_2", "stopped")];
    await withWorkers(workers, async () => {
      const { getByText, queryByText } = renderWorkers();
      await waitFor(() => {
        expect(getByText("w_stopped_1")).toBeTruthy();
      });
      expect(getByText("All workers are stopped")).toBeTruthy();
      expect(queryByText("No live workers detected")).toBeNull();
      expect(queryByText(/stopped or stale/)).toBeNull();
      expect(getByText(/2 registered workers are stopped/)).toBeTruthy();
    });
  });
});

describe("Workers copy chords and hints (WM-233)", () => {
  test("copy chords: c (workerId), c l (link) and utility hints", async () => {
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

    const w = stubWorker("worker-copy-test", "idle");
    await withWorkers([w], async () => {
      const r = renderWithClient(
        <Workers context={{ kind: "all" }} focusWorkerId="worker-copy-test" onSelectWorker={noop} />,
      );
      const idBtn = await r.findByRole("button", { name: "Copy worker id (c)" });

      // Verify icon-action tooltips preserve shortcut discoverability.
      expect(idBtn.getAttribute("title")).toBe("Copy worker id · c");
      const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
      expect(linkBtn.getAttribute("title")).toBe("Copy link · c l");

      // 1. Press 'c' -> copies workerId
      fireEvent.keyDown(document.body, { key: "c" });
      expect(written).toBe("worker-copy-test");

      // 2. Press 'l' immediately after 'c' -> 'c l' copies link
      fireEvent.keyDown(document.body, { key: "l" });
      expect(written).toBe(window.location.href);
    });
  });
});

describe("Workers Open run action shortcut badge (WM-236)", () => {
  test("detail pane renders 'Open run' action button with 'o' shortcut badge when worker has currentRun", async () => {
    const workerWithRun: Worker = {
      ...stubWorker("w_busy_1", "busy"),
      currentRun: "run_active_123",
    };
    await withWorkers([workerWithRun], async () => {
      const { getByRole } = renderWithClient(
        <Workers context={{ kind: "all" }} focusWorkerId="w_busy_1" onSelectWorker={noop} />,
      );

      await waitFor(() => {
        expect(getByRole("button", { name: /^Open run/ })).toBeTruthy();
      });

      const openBtn = getByRole("button", { name: /^Open run/ });
      const badge = openBtn.querySelector("span.mono");
      expect(badge).toBeTruthy();
      expect(badge!.textContent).toBe("o");
      expect(badge!.getAttribute("aria-hidden")).toBe("true");

      // Verify click updates window.location.hash
      const origHash = window.location.hash;
      openBtn.click();
      expect(window.location.hash).toBe("#/runs/run_active_123");
      window.location.hash = origHash;
    });
  });

  test("detail pane does not render 'Open run' action button when worker has no currentRun", async () => {
    const workerIdle: Worker = stubWorker("w_idle_1", "idle");
    await withWorkers([workerIdle], async () => {
      const { queryByRole, container } = renderWithClient(
        <Workers context={{ kind: "all" }} focusWorkerId="w_idle_1" onSelectWorker={noop} />,
      );

      await waitFor(() => {
        expect(container.querySelector("aside")).toBeTruthy();
      });

      expect(queryByRole("button", { name: /^Open run/ })).toBeNull();
    });
  });
});


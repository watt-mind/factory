import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { api, type RepoItem } from "../api";
import type { RunDetail, Worker } from "../types";
import {
  WorkspaceDropdown,
  activeWorkspaces,
  groupActiveWorkspaces,
} from "./WorkspaceDropdown";

const NOW = new Date().toISOString();
const worker: Worker = {
  workerId: "worker_workspace_1",
  host: "lab",
  pid: 1,
  labels: {},
  adapters: ["pi"],
  state: "busy",
  currentRun: "run_workspace_1",
  lastSeen: NOW,
  stale: true,
  startedAt: NOW,
  stoppedAt: null,
};
const run = {
  run: {
    runId: "run_workspace_1",
    spec: { input: { repo: "bj29", ticket: "CLNT-123" } },
  },
  subject: "CLNT-123",
} as RunDetail;

function renderDropdown() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceDropdown />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("active workspace dropdown", () => {
  test("projects active worker runs into tenant groups with their configured limit", () => {
    const workspaces = activeWorkspaces([worker], [run]);
    expect(workspaces).toMatchObject([
      {
        repo: "bj29",
        subject: "CLNT-123",
        worker: { workerId: worker.workerId },
      },
    ]);
    expect(
      groupActiveWorkspaces(workspaces, [
        { name: "bj29", effective: { maxInFlight: 4 } } as RepoItem,
      ]),
    ).toMatchObject([{ repo: "bj29", limit: 4, workspaces: [{}] }]);
  });

  test("renders mocked workers, shows the limit, and releases a confirmed workspace", async () => {
    const original = {
      workers: api.workers,
      repos: api.repos,
      runs: api.runs,
      run: api.run,
      terminateWorkspace: api.terminateWorkspace,
    };
    let releases = 0;
    api.workers = async () => ({ workers: [worker] });
    // The bounded GET /runs summary carries no spec (WM-976): the component
    // must fall back to the per-run detail for ids the list cannot label.
    api.runs = (async () => ({
      runs: [],
      nextBefore: null,
    })) as typeof api.runs;
    api.run = async () => run;
    api.repos = async () => ({
      repos: [{ name: "bj29", effective: { maxInFlight: 4 } } as RepoItem],
    });
    api.terminateWorkspace = async (workerId, runId) => {
      releases += 1;
      expect(workerId).toBe("worker_workspace_1");
      expect(runId).toBe("run_workspace_1");
      return { released: true, runId, terminated: true as const };
    };

    try {
      const view = renderDropdown();
      fireEvent.click(view.getByRole("button", { name: /Munkaterületek/ }));
      expect(await view.findByText("CLNT-123")).toBeTruthy();
      expect(view.getByText("1 / 4")).toBeTruthy();

      fireEvent.click(
        view.getByRole("button", { name: "Terminate workspace CLNT-123" }),
      );
      fireEvent.click(view.getByRole("button", { name: "Confirm terminate" }));
      await waitFor(() => expect(releases).toBe(1));
      // The worker list has not caught up yet; the terminated row's button
      // stays inert instead of offering a second cancel.
      await waitFor(() =>
        expect(
          (
            view.getByRole("button", {
              name: "Terminate workspace CLNT-123",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true),
      );
    } finally {
      api.workers = original.workers;
      api.repos = original.repos;
      api.runs = original.runs;
      api.run = original.run;
      api.terminateWorkspace = original.terminateWorkspace;
    }
  });

  test("shows an error line and a bare run-id row when details cannot load", async () => {
    const original = {
      workers: api.workers,
      repos: api.repos,
      runs: api.runs,
      run: api.run,
    };
    api.workers = async () => ({ workers: [worker] });
    api.repos = async () => ({ repos: [] });
    api.runs = (async () => {
      throw new Error("list unavailable");
    }) as typeof api.runs;
    api.run = async () => {
      throw new Error("detail unavailable");
    };

    try {
      const view = renderDropdown();
      fireEvent.click(view.getByRole("button", { name: /Munkaterületek/ }));
      expect(await view.findByRole("alert")).toBeTruthy();
      // The unresolved worker renders as a bare row keyed by its run id
      // rather than an indefinite loading message.
      expect(await view.findByTitle("run_workspace_1")).toBeTruthy();
    } finally {
      api.workers = original.workers;
      api.repos = original.repos;
      api.runs = original.runs;
      api.run = original.run;
    }
  });
});

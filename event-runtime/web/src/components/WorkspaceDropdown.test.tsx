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
      run: api.run,
      terminateWorkspace: api.terminateWorkspace,
    };
    let releases = 0;
    api.workers = async () => ({ workers: [worker] });
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
    } finally {
      api.workers = original.workers;
      api.repos = original.repos;
      api.run = original.run;
      api.terminateWorkspace = original.terminateWorkspace;
    }
  });
});

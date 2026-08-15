import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Projects } from "./Projects";
import {
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { JanitorResult, RepoItem } from "../types";
import { CONTEXT_STORAGE_KEY } from "../context";

afterEach(() => {
  cleanup();
  restoreApi();
  window.location.hash = "";
  sessionStorage.clear();
});

const noop = () => {};

function repo(overrides: Partial<RepoItem> = {}): RepoItem {
  return {
    name: "factory",
    path: "/tmp/factory",
    github: "watt-mind/factory",
    team: "WM",
    project: "Factory",
    base: "develop",
    deployBranch: "master",
    reportOnly: false,
    maxInFlight: null,
    worktreeRoot: "/tmp/worktrees/factory",
    hasWorktreeUp: true,
    hasWorktreeDown: true,
    hasWorktreeWarm: true,
    verify: "bun test",
    ...overrides,
  };
}

function janitor(overrides: Partial<JanitorResult> = {}): JanitorResult {
  return {
    repo: "factory",
    apply: false,
    actor: "janitor",
    reclaimable: [],
    kept: [],
    named: [],
    unknown: [],
    removed: [],
    refused: [],
    held: [],
    ...overrides,
  };
}

function renderProjects(focusRepoName: string | null = null) {
  return renderWithClient(
    <Projects connected={true} focusRepoName={focusRepoName} onSelectRepo={noop} />,
  );
}

async function openJanitor(focus = "factory") {
  const r = renderProjects(focus);
  await waitFor(() => {
    expect(r.getByRole("button", { name: "Run Dry Janitor" })).toBeTruthy();
  });
  return r;
}

describe("Projects unscoped caption (WM-157)", () => {
  test("All context shows no factory-wide caption", async () => {
    window.location.hash = "#/projects";
    // Stale sessionStorage must not invent a caption — hash is the live source (same as App).
    sessionStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify({ openRepos: ["factory"], active: "factory" }));
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });
      expect(r.queryByText(/not scoped to/)).toBeNull();
      expect(r.queryByText(/In flight scopes/)).toBeNull();
    });
  });

  test("repo context tab captions that the registry is factory-wide", async () => {
    window.location.hash = "#/projects?project=factory";
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });
      expect(r.getByText("registry is not scoped to factory.")).toBeTruthy();
    });
  });

  test("In flight context tab captions that the registry is factory-wide", async () => {
    window.location.hash = "#/projects?project=inflight";
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });
      expect(r.getByText("In flight scopes Runs list.")).toBeTruthy();
    });
  });

  test("repo caption appears after a same-view replaceState (context tab, no hashchange)", async () => {
    window.location.hash = "#/projects";
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });
      expect(r.queryByText(/not scoped to/)).toBeNull();

      // App's context-tab writer uses replaceState (no hashchange). Swallow the
      // event happy-dom fires on location.hash so this matches that path.
      const swallow = (e: Event) => e.stopImmediatePropagation();
      window.addEventListener("hashchange", swallow, true);
      try {
        window.location.hash = "#/projects?project=factory";
        r.rerender(<Projects connected={true} focusRepoName={null} onSelectRepo={noop} />);
      } finally {
        window.removeEventListener("hashchange", swallow, true);
      }

      expect(r.getByText("registry is not scoped to factory.")).toBeTruthy();
    });
  });
});

describe("Projects Clean Reclaimable Apply (WM-157)", () => {
  test("Apply stays disabled and confirm does not open when dry found nothing", async () => {
    await withApi(
      {
        repos: async () => ({ repos: [repo()] }),
        janitor: async (name: string) => janitor({ repo: name, reclaimable: [] }),
      },
      async () => {
        const r = await openJanitor();
        fireEvent.click(r.getByRole("button", { name: "Run Dry Janitor" }));
        await waitFor(() => {
          expect(r.getByText("0 reclaimable")).toBeTruthy();
        });
        const apply = r.getByRole("button", { name: "Clean Reclaimable Worktrees…" });
        expect((apply as HTMLButtonElement).disabled).toBe(true);
        expect(r.getByText("Nothing to reclaim")).toBeTruthy();
        fireEvent.click(apply);
        expect(r.queryByRole("dialog")).toBeNull();
        expect(r.queryByText(/Type/)).toBeNull();
      },
    );
  });

  test("Apply enables when dry found reclaimable worktrees and confirm can open", async () => {
    await withApi(
      {
        repos: async () => ({ repos: [repo()] }),
        janitor: async (name: string) =>
          janitor({
            repo: name,
            reclaimable: [{ id: "WM-1", state: "Done" }],
          }),
      },
      async () => {
        const r = await openJanitor();
        fireEvent.click(r.getByRole("button", { name: "Run Dry Janitor" }));
        await waitFor(() => {
          expect(r.getByText("1 reclaimable")).toBeTruthy();
        });
        const apply = r.getByRole("button", { name: "Clean Reclaimable Worktrees…" });
        expect((apply as HTMLButtonElement).disabled).toBe(false);
        expect(r.queryByText("Nothing to reclaim")).toBeNull();
        fireEvent.click(apply);
        expect(r.getByRole("dialog")).toBeTruthy();
        expect(r.getByText("Clean Worktrees for factory")).toBeTruthy();
      },
    );
  });

  test("report-only repo without worktree_down stays disabled even with reclaimable", async () => {
    await withApi(
      {
        repos: async () => ({
          repos: [repo({ reportOnly: true, hasWorktreeDown: false })],
        }),
        janitor: async (name: string) =>
          janitor({
            repo: name,
            reclaimable: [{ id: "WM-1", state: "Done" }],
          }),
      },
      async () => {
        const r = await openJanitor();
        fireEvent.click(r.getByRole("button", { name: "Run Dry Janitor" }));
        await waitFor(() => {
          expect(r.getByText("1 reclaimable")).toBeTruthy();
        });
        const apply = r.getByRole("button", { name: "Clean Reclaimable Worktrees…" });
        expect((apply as HTMLButtonElement).disabled).toBe(true);
        expect(r.getByText(/Apply is disabled: report-only repo/)).toBeTruthy();
        fireEvent.click(apply);
        expect(r.queryByRole("dialog")).toBeNull();
      },
    );
  });
});

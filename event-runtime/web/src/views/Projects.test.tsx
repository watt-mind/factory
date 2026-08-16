import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Projects } from "./Projects";
import {
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { JanitorResult, RepoItem } from "../types";
import { CONTEXT_STORAGE_KEY } from "../context";
import { goPrefix } from "../goSequence";

afterEach(() => {
  cleanup();
  restoreApi();
  window.location.hash = "";
  sessionStorage.clear();
  goPrefix.armedAt = 0;
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

describe("Projects copy chords and hints (WM-233)", () => {
  test("copy chords: c (name), c p (path), c l (link) and utility hints", async () => {
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

    const testRepo = repo({ name: "factory", path: "/tmp/factory" });

    await withApi(
      {
        repos: async () => ({ repos: [testRepo] }),
      },
      async () => {
        const r = renderProjects("factory");
        const pathBtn = await r.findByRole("button", { name: "Copy repo path (c p)" });

        // Verify icon-action tooltips preserve shortcut discoverability.
        expect(pathBtn.getAttribute("title")).toBe("Copy repo path · c p");
        const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
        expect(linkBtn.getAttribute("title")).toBe("Copy link · c l");

        // 1. Press 'c' -> copies repo name
        fireEvent.keyDown(document.body, { key: "c" });
        expect(written).toBe(testRepo.name);

        // 2. Press 'p' immediately after 'c' -> 'c p' copies repo path
        fireEvent.keyDown(document.body, { key: "p" });
        expect(written).toBe(testRepo.path);

        // 3. Press 'c' then 'l' -> 'c l' copies link
        fireEvent.keyDown(document.body, { key: "c" });
        fireEvent.keyDown(document.body, { key: "l" });
        expect(written).toBe(window.location.href);
      },
    );
  });
});

describe("Projects mode tabs and hotkeys (WM-234)", () => {
  test("renders mode tabs with role=tab, aria-selected, and numeric hints", async () => {
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });

      const tablist = r.getByRole("tablist", { name: "Project mode" });
      expect(tablist).toBeTruthy();

      const tabs = r.getAllByRole("tab");
      expect(tabs.length).toBe(3);
      expect(tabs[0].textContent).toContain("All");
      expect(tabs[0].textContent).toContain("1");
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");

      expect(tabs[1].textContent).toContain("Dispatchable");
      expect(tabs[1].textContent).toContain("2");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");

      expect(tabs[2].textContent).toContain("Report-Only");
      expect(tabs[2].textContent).toContain("3");
      expect(tabs[2].getAttribute("aria-selected")).toBe("false");
    });
  });

  test("cycles mode tabs with [ and ] keys", async () => {
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });

      const tabs = r.getAllByRole("tab");
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");

      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true }));
      });
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");

      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true }));
      });
      expect(tabs[2].getAttribute("aria-selected")).toBe("true");

      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true }));
      });
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    });
  });

  test("switches mode tabs directly with 1..3 number keys", async () => {
    await withApi(
      {
        repos: async () => ({
          repos: [
            repo({ name: "r-dispatch", reportOnly: false }),
            repo({ name: "r-report", reportOnly: true }),
          ],
        }),
      },
      async () => {
        const r = renderProjects();
        await waitFor(() => {
          expect(r.getByText("r-dispatch")).toBeTruthy();
          expect(r.getByText("r-report")).toBeTruthy();
        });

        const tabs = r.getAllByRole("tab");

        // Key 2 -> Dispatchable
        act(() => {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
        });
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(r.getByText("r-dispatch")).toBeTruthy();
        expect(r.queryByText("r-report")).toBeNull();

        // Key 3 -> Report-Only
        act(() => {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
        });
        expect(tabs[2].getAttribute("aria-selected")).toBe("true");
        expect(r.queryByText("r-dispatch")).toBeNull();
        expect(r.getByText("r-report")).toBeTruthy();

        // Key 1 -> All
        act(() => {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
        });
        expect(tabs[0].getAttribute("aria-selected")).toBe("true");
        expect(r.getByText("r-dispatch")).toBeTruthy();
        expect(r.getByText("r-report")).toBeTruthy();
      },
    );
  });

  test("number keys are ignored when typing in filter input", async () => {
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });

      const tabs = r.getAllByRole("tab");
      const input = r.getByPlaceholderText(/Filter repo/i);
      input.focus();

      act(() => {
        fireEvent.keyDown(input, { key: "2" });
      });
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    });
  });

  test("number keys are ignored when go prefix is armed", async () => {
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });

      const tabs = r.getAllByRole("tab");
      goPrefix.armedAt = Date.now();

      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
      });
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    });
  });
});


import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Projects } from "./Projects";
import { renderWithClient, restoreApi, withApi } from "../test-render";
import type { JanitorResult } from "../types";
import type { RepoItem } from "../api";
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
    effective: { maxInFlight: 3, maxInFlightSource: "default" },
    smokeDeadlineSeconds: null,
    smokeWorkflow: null,
    smokeUrl: null,
    deployment: null,
    security: null,
    mergeCi: null,
    escalatePaths: [],
    ownedPathsPolicy: { direct: [], pinManifests: [] },
    worktreeRoot: "/tmp/worktrees/factory",
    hasWorktreeUp: true,
    hasWorktreeDown: true,
    hasWorktreeWarm: true,
    verify: "bun test",
    ...overrides,
  };
}

describe("Projects repository policy configuration (WM-703)", () => {
  test("groups configured values by what they govern and identifies their source", async () => {
    await withApi(
      {
        repos: async () => ({
          repos: [
            repo({
              effective: { maxInFlight: 20, maxInFlightSource: "repo" },
              mergeCi: {
                workflow: "CI",
                requiredChecks: ["Shadow runner fleet available", "Verify"],
              },
              escalatePaths: [
                "src/auth/email-and-pass/**",
                "app/migrations/**",
              ],
              ownedPathsPolicy: {
                direct: [
                  {
                    source: "shared/**",
                    requires: ["dist/**", "plugins/core/**"],
                  },
                ],
                pinManifests: ["event-runtime/agents/*.json"],
              },
              deployBranch: "master",
              smokeWorkflow: "smoke-prod.yml",
              smokeUrl: "https://example.com/healthz",
              smokeDeadlineSeconds: 600,
              deployment: {
                url: "https://example.com",
                branch: "master",
                revisionField: "revision",
              },
              security: { pythonVersion: "3.12" },
            }),
          ],
        }),
      },
      async () => {
        const r = renderProjects("factory");
        await r.findByText("Dispatch");

        for (const title of [
          "Dispatch",
          "Merge gate",
          "Owned paths policy",
          "Deploy & smoke",
          "Security",
        ]) {
          expect(r.getByText(title)).toBeTruthy();
        }
        expect(r.getAllByText("config/repos.yaml").length).toBe(5);
        expect(r.getByText("repo value")).toBeTruthy();
        expect(r.getByText("Shadow runner fleet available")).toBeTruthy();
        expect(r.getByText("src/auth/email-and-pass/**")).toBeTruthy();
        expect(r.getByText("shared/**")).toBeTruthy();
        expect(r.getByText("event-runtime/agents/*.json")).toBeTruthy();
        expect(r.getByText("smoke-prod.yml")).toBeTruthy();
        expect(r.getByText("3.12")).toBeTruthy();
      },
    );
  });

  test("warns when escalate_paths is absent", async () => {
    await withApi(
      { repos: async () => ({ repos: [repo({ escalatePaths: null })] }) },
      async () => {
        const r = renderProjects("factory");
        expect(
          await r.findByText(
            "escalate_paths not declared — every PR escalates",
          ),
        ).toBeTruthy();
      },
    );
  });

  test("distinguishes an explicitly empty escalate_paths list", async () => {
    await withApi(
      { repos: async () => ({ repos: [repo({ escalatePaths: [] })] }) },
      async () => {
        const r = renderProjects("factory");
        expect(await r.findByText("explicitly none")).toBeTruthy();
        expect(
          r.queryByText("escalate_paths not declared — every PR escalates"),
        ).toBeNull();
      },
    );
  });
});

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
    <Projects
      connected={true}
      focusRepoName={focusRepoName}
      onSelectRepo={noop}
    />,
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
    sessionStorage.setItem(
      CONTEXT_STORAGE_KEY,
      JSON.stringify({ openRepos: ["factory"], active: "factory" }),
    );
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });
      expect(r.queryByText(/not scoped to/)).toBeNull();
      expect(r.queryByText(/In flight scopes/)).toBeNull();
    });
  });

  test("repo context tab captions that Projects are factory-wide", async () => {
    window.location.hash = "#/projects?project=factory";
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      await waitFor(() => {
        expect(r.getByText("factory")).toBeTruthy();
      });
      expect(r.getByText("Projects are not scoped to factory.")).toBeTruthy();
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
        r.rerender(
          <Projects
            connected={true}
            focusRepoName={null}
            onSelectRepo={noop}
          />,
        );
      } finally {
        window.removeEventListener("hashchange", swallow, true);
      }

      expect(r.getByText("Projects are not scoped to factory.")).toBeTruthy();
    });
  });
});

describe("Projects Clean Reclaimable Apply (WM-157)", () => {
  test("normalizes a partial janitor result before rendering counts (WM-266)", async () => {
    await withApi(
      {
        repos: async () => ({ repos: [repo()] }),
        janitor: async (name: string) =>
          ({ repo: name, apply: false, actor: "janitor" }) as JanitorResult,
      },
      async () => {
        const r = await openJanitor();
        fireEvent.click(r.getByRole("button", { name: "Run Dry Janitor" }));
        await waitFor(() => {
          expect(r.getByText("0 reclaimable")).toBeTruthy();
        });
        expect(r.getByText("Nothing to reclaim")).toBeTruthy();
      },
    );
  });

  test("Apply stays disabled and confirm does not open when dry found nothing", async () => {
    await withApi(
      {
        repos: async () => ({ repos: [repo()] }),
        janitor: async (name: string) =>
          janitor({ repo: name, reclaimable: [] }),
      },
      async () => {
        const r = await openJanitor();
        fireEvent.click(r.getByRole("button", { name: "Run Dry Janitor" }));
        await waitFor(() => {
          expect(r.getByText("0 reclaimable")).toBeTruthy();
        });
        const apply = r.getByRole("button", {
          name: "Clean Reclaimable Worktrees…",
        });
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
        const apply = r.getByRole("button", {
          name: "Clean Reclaimable Worktrees…",
        });
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
        const apply = r.getByRole("button", {
          name: "Clean Reclaimable Worktrees…",
        });
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
        const pathBtn = await r.findByRole("button", {
          name: "Copy repo path (c p)",
        });

        // Verify icon-action tooltips preserve shortcut discoverability.
        expect(
          pathBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
        ).toBe("Copy repo path · c p");
        const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
        expect(
          linkBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
        ).toBe("Copy link · c l");

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

describe("Projects quick dispatch and GitHub chords (WM-294)", () => {
  test("d t, d s, and d j open the matching dispatch confirmations within 800ms", async () => {
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects("factory");
      await r.findByText("Quick Dispatch (Agent Tasks)");

      for (const [suffix, eventType] of [
        ["t", "factory.triage.requested"],
        ["s", "factory.status-report.requested"],
        ["j", "factory.janitor-scan.requested"],
      ] as const) {
        fireEvent.keyDown(document.body, { key: "d" });
        fireEvent.keyDown(document.body, { key: suffix });
        expect(r.getByRole("dialog").textContent).toContain(eventType);
        fireEvent.click(r.getByRole("button", { name: "Cancel" }));
      }
    });
  });

  test("dispatch chords expire after 800ms and are ignored while typing", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
        const r = renderProjects("factory");
        await r.findByText("Quick Dispatch (Agent Tasks)");

        fireEvent.keyDown(document.body, { key: "d" });
        now += 800;
        fireEvent.keyDown(document.body, { key: "t" });
        expect(r.queryByRole("dialog")).toBeNull();

        const input = r.getByPlaceholderText(/Filter repo/i);
        fireEvent.keyDown(input, { key: "d" });
        fireEvent.keyDown(input, { key: "t" });
        expect(r.queryByRole("dialog")).toBeNull();
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("g h opens the selected repository on GitHub and action buttons show chord hints", async () => {
    const originalOpen = window.open;
    const opened: unknown[][] = [];
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
        const r = renderProjects("factory");
        await r.findByText("Quick Dispatch (Agent Tasks)");

        expect(
          r.getByRole("button", { name: "Triage Scan" }).textContent,
        ).toContain("d t");
        expect(
          r.getByRole("button", { name: "Status Report" }).textContent,
        ).toContain("d s");
        expect(
          r.getByRole("button", { name: "Janitor Scan" }).textContent,
        ).toContain("d j");
        expect(r.getByRole("link", { name: "GitHub" }).textContent).toContain(
          "g h",
        );

        fireEvent.keyDown(document.body, { key: "g" });
        fireEvent.keyDown(document.body, { key: "h" });
        expect(opened).toEqual([
          ["https://github.com/watt-mind/factory", "_blank"],
        ]);
      });
    } finally {
      window.open = originalOpen;
    }
  });

  test("g h is inert when the selected repository has no GitHub target", async () => {
    const originalOpen = window.open;
    let opens = 0;
    window.open = (() => {
      opens += 1;
      return null;
    }) as typeof window.open;
    try {
      await withApi(
        { repos: async () => ({ repos: [repo({ github: null })] }) },
        async () => {
          const r = renderProjects("factory");
          await r.findByText("Quick Dispatch (Agent Tasks)");
          fireEvent.keyDown(document.body, { key: "g" });
          fireEvent.keyDown(document.body, { key: "h" });
          expect(opens).toBe(0);
          expect(r.queryByRole("link", { name: "GitHub" })).toBeNull();
        },
      );
    } finally {
      window.open = originalOpen;
    }
  });
});

describe("Projects toolbar counts and ordering (WM-560)", () => {
  test("tab counts partition All and the default order is dispatchable first, then name", async () => {
    await withApi(
      {
        repos: async () => ({
          repos: [
            repo({ name: "z-report", reportOnly: true }),
            repo({ name: "z-dispatch", reportOnly: false }),
            repo({ name: "a-report", reportOnly: true }),
            repo({ name: "a-dispatch", reportOnly: false }),
          ],
        }),
      },
      async () => {
        const r = renderProjects();
        await r.findByText("a-dispatch");

        const tabs = r.getAllByRole("tab");
        const counts = tabs.map((tab) =>
          Number(tab.querySelector(".tabular-nums")?.textContent),
        );
        expect(counts).toEqual([4, 2, 2]);
        expect(counts[1] + counts[2]).toBe(counts[0]);

        const rowNames = () =>
          Array.from(
            r.container.querySelectorAll("tbody tr td:first-child"),
          ).map((cell) => cell.textContent);
        expect(rowNames()).toEqual([
          "a-dispatch",
          "z-dispatch",
          "a-report",
          "z-report",
        ]);

        fireEvent.click(r.getByRole("button", { name: "Name" }));
        expect(rowNames()).toEqual([
          "a-dispatch",
          "a-report",
          "z-dispatch",
          "z-report",
        ]);
        fireEvent.click(r.getByRole("button", { name: "Name" }));
        expect(rowNames()).toEqual([
          "z-report",
          "z-dispatch",
          "a-report",
          "a-dispatch",
        ]);
        fireEvent.click(r.getByRole("button", { name: "Name" }));
        expect(rowNames()).toEqual([
          "a-dispatch",
          "z-dispatch",
          "a-report",
          "z-report",
        ]);
      },
    );
  });

  test("Worktree Scripts uses the shared faint placeholder when no scripts exist", async () => {
    await withApi(
      {
        repos: async () => ({
          repos: [
            repo({
              hasWorktreeUp: false,
              hasWorktreeDown: false,
              hasWorktreeWarm: false,
            }),
          ],
        }),
      },
      async () => {
        const r = renderProjects();
        await r.findByText("factory");
        const scriptsCell = r.container.querySelector("tbody tr td:last-child");
        const placeholder = scriptsCell?.querySelector(
          "span.text-\\(--text-faint\\)",
        );
        expect(placeholder?.textContent).toBe("—");
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
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "]", bubbles: true }),
        );
      });
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");

      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "]", bubbles: true }),
        );
      });
      expect(tabs[2].getAttribute("aria-selected")).toBe("true");

      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "[", bubbles: true }),
        );
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
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "2", bubbles: true }),
          );
        });
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(r.getByText("r-dispatch")).toBeTruthy();
        expect(r.queryByText("r-report")).toBeNull();

        // Key 3 -> Report-Only
        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "3", bubbles: true }),
          );
        });
        expect(tabs[2].getAttribute("aria-selected")).toBe("true");
        expect(r.queryByText("r-dispatch")).toBeNull();
        expect(r.getByText("r-report")).toBeTruthy();

        // Key 1 -> All
        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "1", bubbles: true }),
          );
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
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "2", bubbles: true }),
        );
      });
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    });
  });
});
describe("Projects mobile layout (WM-169)", () => {
  test("provides a mobile mode select synchronized with tabs and keyboard shortcuts", async () => {
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
        await r.findByText("r-dispatch");

        const select = r.getByRole("combobox", {
          name: "Project mode",
        }) as HTMLSelectElement;
        const tablist = r.getByRole("tablist", { name: "Project mode" });
        const tabs = r.getAllByRole("tab");

        expect(select.className).toContain("sm:hidden");
        expect(tablist.className).toContain("hidden");
        expect(tablist.className).toContain("sm:flex");
        expect(select.value).toBe("ALL");

        fireEvent.change(select, { target: { value: "DISPATCHABLE" } });
        expect(select.value).toBe("DISPATCHABLE");
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(r.getByText("r-dispatch")).toBeTruthy();
        expect(r.queryByText("r-report")).toBeNull();

        fireEvent.keyDown(document.body, { key: "]" });
        expect(select.value).toBe("REPORT_ONLY");
        expect(tabs[2].getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(document.body, { key: "1" });
        expect(select.value).toBe("ALL");
        expect(tabs[0].getAttribute("aria-selected")).toBe("true");

        fireEvent.click(tabs[2]);
        expect(select.value).toBe("REPORT_ONLY");
      },
    );
  });

  test("contains the full table in the existing horizontal scroller", async () => {
    await withApi({ repos: async () => ({ repos: [repo()] }) }, async () => {
      const r = renderProjects();
      const table = await r.findByRole("table", { name: "Projects table" });

      expect(table.className).toContain("min-w-");
      expect(table.parentElement?.className).toContain("overflow-auto");
    });
  });

  test("renders Base / Deploy column with branch icons", async () => {
    await withApi(
      {
        repos: async () => ({
          repos: [repo({ base: "develop", deployBranch: "master" })],
        }),
      },
      async () => {
        const r = renderProjects();
        await r.findByText("factory");

        const row = r.getByText("factory").closest("tr")!;
        const branchCell = row.querySelectorAll("td")[4];
        expect(branchCell.textContent).toContain("develop");
        expect(branchCell.textContent).toContain("master");
        expect(
          branchCell.querySelectorAll("svg").length,
        ).toBeGreaterThanOrEqual(2);
      },
    );
  });
});

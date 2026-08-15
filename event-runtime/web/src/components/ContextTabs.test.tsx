import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import type { OperatorContext } from "../context";
import type { RepoItem } from "../types";
import { ContextTabs, ScopeCaption } from "./ContextTabs";

function repo(name: string): RepoItem {
  return {
    name,
    path: `/tmp/${name}`,
    github: null,
    team: null,
    project: null,
    base: "develop",
    deployBranch: null,
    reportOnly: false,
    maxInFlight: null,
    worktreeRoot: null,
    hasWorktreeUp: false,
    hasWorktreeDown: false,
    hasWorktreeWarm: false,
    verify: null,
  };
}

afterEach(() => {
  cleanup();
});

describe("ContextTabs", () => {
  test("renders role='toolbar' with aria-label='Context' and no tablist or tab roles", () => {
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "repo", name: "factory" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(r.getAllByRole("toolbar")).toHaveLength(1);
    expect(r.getByRole("toolbar", { name: "Context" })).toBeDefined();
    expect(r.queryByRole("tablist")).toBeNull();
    expect(r.queryByRole("tab")).toBeNull();

    const pressed = r.getAllByRole("button").filter((el) => el.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toBe("factory");

    const closeBtn = r.getByRole("button", { name: "Close factory" });
    expect(closeBtn.getAttribute("tabindex")).toBe("-1");
  });

  test("active context tab is the sequential tab stop; the toolbar is not", () => {
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const toolbar = r.getByRole("toolbar", { name: "Context" });
    expect(toolbar.hasAttribute("tabindex")).toBe(false);

    const all = r.getByRole("button", { name: "All" });
    expect(all.getAttribute("tabindex")).toBe("0");
    expect(all.className).toContain("focus-visible:ring-2");
  });

  test("focuses the remaining active context button after closing a tab when activeElement is body (Chromium recovery)", () => {
    let open = ["factory", "client"];
    const r = render(
      <ContextTabs
        repos={[repo("factory"), repo("client")]}
        reposError={false}
        openRepos={open}
        active={{ kind: "repo", name: "client" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={(name) => {
          open = open.filter((n) => n !== name);
        }}
      />,
    );

    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    const closeBtn = r.getByRole("button", { name: "Close factory" });
    act(() => {
      fireEvent.click(closeBtn);
      document.body.focus();
    });

    const activeBtn = r.getByRole("button", { name: "client" });
    expect(document.activeElement).toBe(activeBtn);
  });

  test("preserves focus on another element after closing a tab (Safari/Firefox focus retention)", () => {
    const { getByTestId, getByRole } = render(
      <div>
        <input data-testid="filter-input" />
        <ContextTabs
          repos={[repo("factory")]}
          reposError={false}
          openRepos={["factory"]}
          active={{ kind: "all" }}
          onSelect={() => {}}
          onOpen={() => {}}
          onClose={() => {}}
        />
      </div>,
    );

    const input = getByTestId("filter-input");
    input.focus();
    expect(document.activeElement).toBe(input);

    const closeBtn = getByRole("button", { name: "Close factory" });
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
  });

  test("clicking In flight while active toggles back to All (WM-91)", () => {
    const selected: OperatorContext[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "inflight" }}
        onSelect={(ctx) => selected.push(ctx)}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const inflightBtn = r.getByRole("button", { name: "In flight" });
    expect(inflightBtn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(inflightBtn);
    expect(selected).toEqual([{ kind: "all" }]);
  });

  test("ArrowRight moves focus without activating the destination tab", () => {
    const selected: OperatorContext[] = [];
    const opened: string[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory"), repo("client")]}
        reposError={false}
        openRepos={["factory", "client"]}
        active={{ kind: "all" }}
        onSelect={(ctx) => selected.push(ctx)}
        onOpen={(name) => opened.push(name)}
        onClose={() => {}}
      />,
    );

    const allBtn = r.getByRole("button", { name: "All" });
    allBtn.focus();
    act(() => {
      fireEvent.keyDown(allBtn, { key: "ArrowRight" });
    });

    expect(document.activeElement).toBe(r.getByRole("button", { name: "factory" }));
    expect(selected).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("Enter on a focused context tab activates it", () => {
    const selected: OperatorContext[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "all" }}
        onSelect={(ctx) => selected.push(ctx)}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const factoryBtn = r.getByRole("button", { name: "factory" });
    factoryBtn.focus();
    act(() => {
      fireEvent.keyDown(factoryBtn, { key: "Enter" });
    });
    expect(selected).toEqual([{ kind: "repo", name: "factory" }]);
  });

  test("Space on a focused context tab activates it and preventDefault so the page does not scroll", () => {
    const selected: OperatorContext[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "repo", name: "factory" }}
        onSelect={(ctx) => selected.push(ctx)}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const inflightBtn = r.getByRole("button", { name: "In flight" });
    inflightBtn.focus();
    const space = createEvent.keyDown(inflightBtn, { key: " " });
    act(() => {
      fireEvent(inflightBtn, space);
    });
    expect(space.defaultPrevented).toBe(true);
    expect(selected).toEqual([{ kind: "inflight" }]);
  });

  test("Enter on All and Space on a pinned run activate those tabs", () => {
    const selected: OperatorContext[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "repo", name: "factory" }}
        onSelect={(ctx) => selected.push(ctx)}
        onOpen={() => {}}
        onClose={() => {}}
        pinnedRuns={["run_abc"]}
      />,
    );

    const allBtn = r.getByRole("button", { name: "All" });
    allBtn.focus();
    act(() => {
      fireEvent.keyDown(allBtn, { key: "Enter" });
    });
    expect(selected).toEqual([{ kind: "all" }]);

    window.location.hash = "";
    const runBtn = r.getByRole("button", { name: "run_abc" });
    runBtn.focus();
    act(() => {
      fireEvent.keyDown(runBtn, { key: " " });
    });
    expect(window.location.hash).toBe("#/runs/run_abc");
  });

  test("closed repo picker ignores ArrowDown and Enter (does not open a repo)", () => {
    const opened: string[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory"), repo("client")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={(name) => opened.push(name)}
        onClose={() => {}}
      />,
    );

    const plus = r.getByRole("button", { name: "Open a repo tab" });
    plus.focus();
    fireEvent.keyDown(plus, { key: "ArrowDown" });
    fireEvent.keyDown(plus, { key: "Enter" });
    expect(opened).toEqual([]);
    expect(r.queryByRole("listbox")).toBeNull();
  });

  test("empty picker copy does not use registry or fleet jargon", () => {
    const r = render(
      <ContextTabs
        repos={[]}
        reposError={false}
        openRepos={[]}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    act(() => {
      fireEvent.click(r.getByRole("button", { name: "Open a repo tab" }));
    });
    const text = r.getByRole("listbox").textContent ?? "";
    expect(text).toContain("No repos available.");
    expect(text.toLowerCase()).not.toContain("registry");
    expect(text.toLowerCase()).not.toContain("fleet");
  });

  test("opening + moves focus into the listbox; arrows move highlight; Enter selects", () => {
    const opened: string[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("alpha"), repo("bravo"), repo("charlie")]}
        reposError={false}
        openRepos={[]}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={(name) => opened.push(name)}
        onClose={() => {}}
      />,
    );

    const plus = r.getByRole("button", { name: "Open a repo tab" });
    act(() => {
      fireEvent.click(plus);
    });

    const listbox = r.getByRole("listbox", { name: "Factory repos" });
    expect(document.activeElement?.getAttribute("role")).toBe("listbox");

    const options = r.getAllByRole("option");
    expect(options.map((el) => el.textContent)).toEqual(["alpha", "bravo", "charlie"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");

    act(() => {
      fireEvent.keyDown(listbox, { key: "ArrowDown" });
    });
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    act(() => {
      fireEvent.keyDown(listbox, { key: "Enter" });
    });
    expect(opened).toEqual(["bravo"]);
    expect(r.queryByRole("listbox")).toBeNull();
  });

  test("Escape closes the repo picker and returns focus to +", () => {
    const opened: string[] = [];
    const r = render(
      <ContextTabs
        repos={[repo("factory"), repo("client")]}
        reposError={false}
        openRepos={[]}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={(name) => opened.push(name)}
        onClose={() => {}}
      />,
    );

    const plus = r.getByRole("button", { name: "Open a repo tab" });
    act(() => {
      fireEvent.click(plus);
    });
    expect(r.getByRole("listbox")).toBeDefined();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(r.queryByRole("listbox")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open a repo tab");
    expect(opened).toEqual([]);
  });

  test("displays subtle shortcut indicators when goArmed is true", () => {
    const reposList = Array.from({ length: 10 }, (_, i) => `repo-${i + 1}`);
    const r = render(
      <ContextTabs
        repos={reposList.map(repo)}
        reposError={false}
        openRepos={reposList}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
        goArmed={true}
      />,
    );

    const allBtn = r.getByRole("button", { name: "All" });
    expect(allBtn.textContent).toContain("0");

    for (let i = 0; i < 9; i++) {
      const btn = r.getByRole("button", { name: `repo-${i + 1}` });
      expect(btn.textContent).toContain(String(i + 1));
    }

    // 10th open repo tab (index 9) does not receive a shortcut chord
    const tenthBtn = r.getByRole("button", { name: "repo-10" });
    expect(tenthBtn.textContent).toBe("repo-10");

    const inflightBtn = r.getByRole("button", { name: "In flight" });
    expect(inflightBtn.textContent).toContain("i");
  });

  test("does not display shortcut indicators when goArmed is false", () => {
    const r = render(
      <ContextTabs
        repos={[repo("factory"), repo("client")]}
        reposError={false}
        openRepos={["factory", "client"]}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
        goArmed={false}
      />,
    );

    expect(r.getByRole("button", { name: "All" }).textContent).toBe("All");
    expect(r.getByRole("button", { name: "factory" }).textContent).toBe("factory");
    expect(r.getByRole("button", { name: "client" }).textContent).toBe("client");
    expect(r.getByRole("button", { name: "In flight" }).textContent).toBe("In flight");
  });

  test("provides shortcut hint titles on context tab buttons", () => {
    const reposList = Array.from({ length: 10 }, (_, i) => `repo-${i + 1}`);
    const r = render(
      <ContextTabs
        repos={reposList.map(repo)}
        reposError={reposList.length === 0}
        openRepos={reposList}
        active={{ kind: "all" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(r.getByRole("button", { name: "All" }).getAttribute("title")).toBe("All (g 0)");
    for (let i = 0; i < 9; i++) {
      const btn = r.getByRole("button", { name: `repo-${i + 1}` });
      expect(btn.getAttribute("title")).toBe(`repo-${i + 1} (g ${i + 1})`);
    }
    expect(r.getByRole("button", { name: "repo-10" }).getAttribute("title")).toBe("repo-10");
    expect(r.getByRole("button", { name: "In flight" }).getAttribute("title")).toBe("In flight (g i)");
  });
});

describe("ScopeCaption", () => {
  const repoCtx: OperatorContext = { kind: "repo", name: "factory" };

  test("kind=all renders nothing (no caption to leak jargon)", () => {
    const r = render(<ScopeCaption context={{ kind: "all" }} surface="fleet" />);
    expect(r.container.textContent).toBe("");
  });

  test("Workers/Agents/Schedules/Overview/Graph use view names, not fleet or registry", () => {
    const cases: Array<{ hash: string; surface: "fleet" | "registry" | "graph" | "overview"; expect: string }> = [
      { hash: "#/workers", surface: "fleet", expect: "Workers are not scoped to factory" },
      { hash: "#/agents", surface: "registry", expect: "Agents are not scoped to factory" },
      { hash: "#/schedules", surface: "registry", expect: "Schedules are not scoped to factory" },
      { hash: "#/overview", surface: "overview", expect: "Overview counts are not scoped to factory" },
      { hash: "#/graph", surface: "graph", expect: "Graph is not scoped to factory" },
    ];

    for (const c of cases) {
      window.location.hash = c.hash;
      const r = render(<ScopeCaption context={repoCtx} surface={c.surface} />);
      const text = r.container.textContent ?? "";
      expect(text).toContain(c.expect);
      expect(text.toLowerCase()).not.toContain("fleet");
      expect(text.toLowerCase()).not.toContain("registry");
      cleanup();
    }
  });

  test("surface fallback still avoids jargon when hash is empty", () => {
    window.location.hash = "";
    const fleet = render(<ScopeCaption context={repoCtx} surface="fleet" />);
    expect(fleet.container.textContent).toContain("Workers are not scoped to factory");
    expect(fleet.container.textContent?.toLowerCase()).not.toContain("fleet");
    cleanup();

    // Empty hash is not Agents/Schedules — keep the factory-wide registry copy (WM-157 Projects).
    const registry = render(<ScopeCaption context={repoCtx} surface="registry" />);
    expect(registry.container.textContent).toContain("registry is not scoped to factory");
    expect(registry.container.textContent).not.toContain("Agents");
  });

  test("Projects hash keeps factory-wide registry copy, not Agents", () => {
    window.location.hash = "#/projects";
    const r = render(<ScopeCaption context={repoCtx} surface="registry" />);
    expect(r.container.textContent).toContain("registry is not scoped to factory");
    expect(r.container.textContent).not.toContain("Agents");
  });
});

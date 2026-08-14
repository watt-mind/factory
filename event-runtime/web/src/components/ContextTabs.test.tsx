import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { OperatorContext } from "../context";
import type { RepoItem } from "../types";
import { ContextTabs } from "./ContextTabs";

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
});

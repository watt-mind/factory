import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { modal } from "../hooks";
import { ShortcutsDialog } from "./ShortcutsDialog";

beforeEach(() => {
  modal.depth = 0;
});

afterEach(() => {
  modal.depth = 0;
  cleanup();
});

describe("ShortcutsDialog", () => {
  test("documents theme cycle, copy link, and context-strip keys", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);

    expect(r.getByText("cycle theme (dark → light → contrast)")).toBeDefined();
    expect(r.getByText("copy link to this page")).toBeDefined();

    const contextStrip = r.getByRole("region", { name: "Context strip" });
    expect(contextStrip.textContent).toContain("Tab");
    expect(contextStrip.textContent).toContain("Home / End");
    expect(contextStrip.textContent).toContain("Delete / ⌫");
  });

  test("documents universal copy chords (WM-233)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });

    expect(actions.textContent).toContain("copy selected id / name / ref");
    expect(actions.textContent).toContain("c l");
    expect(actions.textContent).toContain("copy link to clipboard");
    expect(actions.textContent).toContain("c i / c c");
    expect(actions.textContent).toContain("copy CLI inspect command (Runs)");
    expect(actions.textContent).toContain("c p");
    expect(actions.textContent).toContain("copy repo path (Projects)");
  });
});

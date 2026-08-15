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

  test("documents 'v' for display options and '1–N' for status tabs (WM-234)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });

    expect(actions.textContent).toContain("v");
    expect(actions.textContent).toContain("display options");
    expect(actions.textContent).toContain("1–N");
    expect(actions.textContent).toContain("switch status tab");
  });
});

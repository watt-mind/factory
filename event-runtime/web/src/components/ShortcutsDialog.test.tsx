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
});

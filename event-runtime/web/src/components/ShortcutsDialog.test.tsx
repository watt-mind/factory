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

  test("documents context chords under Navigation chords (g 0, g 1–9, g i)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);

    const navChords = r.getByRole("region", { name: "Navigation chords" });
    expect(navChords.textContent).toContain("g 0");
    expect(navChords.textContent).toContain("All context");
    expect(navChords.textContent).toContain("g 1–9");
    expect(navChords.textContent).toContain("1st–9th repo tab");
    expect(navChords.textContent).toContain("g i");
    expect(navChords.textContent).toContain("In flight context");
  });
});

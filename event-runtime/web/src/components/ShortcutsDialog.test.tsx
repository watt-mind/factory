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

    const runTrace = r.getByRole("region", { name: "Run & Trace" });
    expect(runTrace.textContent).toContain("1–5");
    expect(runTrace.textContent).toContain("switch trace kind");
    expect(runTrace.textContent).toContain("toggle expand / collapse trace details");
    expect(runTrace.textContent).toContain("toggle follow live trace");
    expect(runTrace.textContent).toContain("c i");
    expect(runTrace.textContent).toContain("copy CLI inspect command");
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

  test("documents 'v' for display options and '1–N' for status tabs (WM-234)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });

    expect(actions.textContent).toContain("v");
    expect(actions.textContent).toContain("display options");
    expect(actions.textContent).toContain("1–N");
    expect(actions.textContent).toContain("switch status tab");
  });

  test("documents view-specific actions and dialog hotkeys (WM-236)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actionsSection = r.getByRole("region", { name: "Actions" });
    const content = actionsSection.textContent ?? "";

    // Schedules: 'r'
    expect(content).toContain("r");
    expect(content).toMatch(/run schedule now/i);

    // Workers: 'o'
    expect(content).toContain("o");
    expect(content).toMatch(/open current run/i);

    // Proposals: 'a', 'x'
    expect(content).toContain("a");
    expect(content).toMatch(/approve proposal/i);
    expect(content).toContain("x");
    expect(content).toMatch(/reject proposal/i);

    // Events: 'q'
    expect(content).toContain("q");
    expect(content).toMatch(/requeue event/i);

    // InjectDialog / dialogs: '⌘+Shift+F', '⌘↵'
    expect(content).toContain("⌘+Shift+F");
    expect(content).toMatch(/format JSON/i);
    expect(content).toContain("⌘↵");
    expect(content).toMatch(/confirm inject/i);
  });
});


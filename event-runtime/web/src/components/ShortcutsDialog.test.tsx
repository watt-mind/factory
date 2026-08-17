import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
    expect(r.getByText("footer theme button")).toBeDefined();
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

  test("focuses the Close button and closes from it", () => {
    let closed = false;
    const r = render(<ShortcutsDialog onClose={() => { closed = true; }} />);
    const close = r.getByRole("button", { name: "Close" });

    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(closed).toBe(true);
  });

  test("lists the command palette chord exactly once and corrects copy-link", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });
    const keys = [...actions.querySelectorAll(".mono")].map((node) => node.textContent);

    expect(keys.filter((key) => key === "⌘K")).toHaveLength(1);
    expect(keys.filter((key) => key === "c l")).toHaveLength(1);
    expect(r.getByTestId("shortcuts-scroll").className).toContain("overflow-y-auto");
    expect(r.getByTestId("shortcuts-scroll-fade").className).toContain("bg-linear-to-t");
  });

  test("documents Overview pipeline and anomaly shortcuts (WM-292)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const overview = r.getByRole("region", { name: "Overview" });

    expect(overview.textContent).toContain("1–5");
    expect(overview.textContent).toContain("pipeline stage views");
    expect(overview.textContent).toContain(".");
    expect(overview.textContent).toContain("next anomaly");
    expect(overview.textContent).toContain("r");
    expect(overview.textContent).toContain("requeue focused dead-letter event");
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
    expect(actions.textContent).toContain("copy link to this page");
    expect(actions.textContent).toContain("c i / c c");
    expect(actions.textContent).toContain("copy CLI inspect command (Runs)");
    expect(actions.textContent).toContain("c p");
    expect(actions.textContent).toContain("copy repo path (Projects)");
    expect(actions.textContent).toContain("pin / unpin selected run (Runs)");
    expect(actions.textContent).toContain("reveal selected node on canvas (Graph)");
  });

  test("documents 'v' for display options and '1–N' for status tabs (WM-234)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });

    expect(actions.textContent).toContain("v");
    expect(actions.textContent).toContain("display options");
    expect(actions.textContent).toContain("1–N");
    expect(actions.textContent).toContain("switch status tab");
  });

  test("documents proposal multi-selection shortcuts (WM-293)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });
    const content = actions.textContent ?? "";

    expect(content).toContain("Space / Shift+Space");
    expect(content).toContain("toggle highlighted proposal selection");
    expect(content).toContain("* a / ⌘A");
    expect(content).toContain("select all actionable proposals");
    expect(content).toContain("* n / Esc");
    expect(content).toContain("clear proposal selection");
    expect(content).toContain("A / X");
    expect(content).toContain("approve / reject selected proposals");
  });

  test("documents Projects dispatch and GitHub chords (WM-294)", () => {
    const r = render(<ShortcutsDialog onClose={() => {}} />);
    const actions = r.getByRole("region", { name: "Actions" });
    const content = actions.textContent ?? "";

    expect(content).toContain("d t");
    expect(content).toContain("dispatch triage scan (Projects)");
    expect(content).toContain("d s");
    expect(content).toContain("dispatch status report (Projects)");
    expect(content).toContain("d j");
    expect(content).toContain("dispatch janitor scan (Projects)");
    expect(content).toContain("g h");
    expect(content).toContain("open repository on GitHub (Projects)");
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


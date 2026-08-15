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
});

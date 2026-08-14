import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { modal } from "../hooks";
import {
  buildSections,
  defaultDisplayState,
  type DisplayConfig,
  type DisplayState,
} from "../displayOptions";
import { DisplayOptions } from "./DisplayOptions";
import { GroupHeaderRow } from "./ui";

interface Row {
  id: string;
  state: string;
  agent: string;
}

const CONFIG: DisplayConfig<Row> = {
  view: "panel-test",
  groups: [
    { key: "state", label: "State", get: (r) => r.state, order: ["RUNNING", "FAILED"] },
    { key: "agent", label: "Agent", get: (r) => r.agent },
  ],
  subGroups: ["agent"],
  sorts: [{ key: "id", label: "Run", get: (r) => r.id, column: "id" }],
  columns: [
    { key: "id", label: "Run", always: true },
    { key: "agent", label: "Agent" },
  ],
};

function Harness({ onState }: { onState?: (s: DisplayState) => void }) {
  const [state, setState] = useState(() => defaultDisplayState(CONFIG));
  const update = (next: DisplayState | ((s: DisplayState) => DisplayState)) => {
    setState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      onState?.(value);
      return value;
    });
  };
  return <DisplayOptions config={CONFIG} state={state} onChange={update} />;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("DisplayOptions panel", () => {
  test("opens, changes grouping, and reflects it in the select", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    const trigger = r.getByRole("button", { name: /display/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const groupSelect = r.getByLabelText("Group by") as HTMLSelectElement;
    fireEvent.change(groupSelect, { target: { value: "state" } });
    expect(latest?.groupBy).toBe("state");
    expect(groupSelect.value).toBe("state");
  });

  test("choosing the group as sub-group is prevented by option filtering", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    fireEvent.change(r.getByLabelText("Group by"), { target: { value: "agent" } });
    const sub = r.getByLabelText("Sub-group by") as HTMLSelectElement;
    const values = [...sub.options].map((o) => o.value);
    expect(values).not.toContain("agent");
  });

  test("column pills toggle visibility but always-on columns are not offered", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    expect(r.queryByRole("button", { name: "Run" })).toBeNull();
    const pill = r.getByRole("button", { name: "Agent" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pill);
    expect(latest?.hiddenColumns).toEqual(["agent"]);
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });

  test("Escape closes the panel and releases the modal depth", () => {
    // Relative to whatever depth other test files leaked: only the delta is ours.
    const base = modal.depth;
    const r = render(<Harness />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    expect(modal.depth).toBe(base + 1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(r.queryByRole("dialog", { name: "Display options" })).toBeNull();
    expect(modal.depth).toBe(base);
  });

  test("reset appears only once customized and restores defaults", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    expect(r.queryByRole("button", { name: /reset/i })).toBeNull();
    fireEvent.change(r.getByLabelText("Group by"), { target: { value: "state" } });
    fireEvent.click(r.getByRole("button", { name: /reset/i }));
    expect(latest?.groupBy).toBe("none");
  });
});

describe("GroupHeaderRow", () => {
  test("exposes aria-expanded and toggles through its button", () => {
    const rows: Row[] = [
      { id: "r1", state: "RUNNING", agent: "a" },
      { id: "r2", state: "FAILED", agent: "b" },
    ];
    const sections = buildSections(rows, CONFIG, {
      ...defaultDisplayState(CONFIG),
      groupBy: "state",
    });

    function Table() {
      const [collapsed, setCollapsed] = useState<string[]>([]);
      return (
        <table>
          <tbody>
            {sections.map((s) => {
              const closed = collapsed.includes(s.key);
              return (
                <GroupHeaderRow
                  key={s.key}
                  colSpan={2}
                  section={s}
                  collapsed={closed}
                  onToggle={() =>
                    setCollapsed((c) =>
                      c.includes(s.key) ? c.filter((k) => k !== s.key) : [...c, s.key],
                    )
                  }
                />
              );
            })}
          </tbody>
        </table>
      );
    }

    const r = render(<Table />);
    const running = r.getByRole("button", { name: /RUNNING/ });
    expect(running.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(running);
    expect(running.getAttribute("aria-expanded")).toBe("false");
    expect(r.getByText("collapsed")).toBeTruthy();
    fireEvent.click(running);
    expect(running.getAttribute("aria-expanded")).toBe("true");
  });
});

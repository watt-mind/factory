import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { modal } from "../hooks";
import { goPrefix } from "../goSequence";
import { changeInput } from "../test-render";
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
  envelope?: {
    payload?: {
      repo?: string;
      owner?: string;
      [key: string]: string | undefined;
    };
  };
  spec?: {
    input?: {
      model?: string;
    };
  };
  labels?: Record<string, string>;
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

function Harness({
  onState,
  rows,
}: {
  onState?: (s: DisplayState) => void;
  rows?: Row[];
}) {
  const [state, setState] = useState(() => defaultDisplayState(CONFIG));
  const update = (next: DisplayState | ((s: DisplayState) => DisplayState)) => {
    setState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      onState?.(value);
      return value;
    });
  };
  return <DisplayOptions config={CONFIG} state={state} onChange={update} rows={rows} />;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  goPrefix.armedAt = 0;
});

function chooseOption(
  r: ReturnType<typeof render>,
  label: string,
  option: string,
) {
  fireEvent.click(r.getByRole("combobox", { name: label }));
  const listbox = r.getByRole("listbox", { name: `${label} options` });
  fireEvent.mouseDown(within(listbox).getByRole("option", { name: option }));
}

describe("DisplayOptions panel", () => {
  test("opens, changes grouping, and reflects it in the listbox trigger", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    const trigger = r.getByRole("button", { name: /display/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const groupSelect = r.getByRole("combobox", { name: "Group by" });
    chooseOption(r, "Group by", "State");
    expect(latest?.groupBy).toBe("state");
    expect(groupSelect.textContent).toContain("State");
  });

  test("uses styled, keyboard-navigable listboxes instead of native selects", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));

    expect(r.container.querySelector("select")).toBeNull();
    const group = r.getByRole("combobox", { name: "Group by" });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    const listbox = r.getByRole("listbox", { name: "Group by options" });
    expect(listbox).toBeTruthy();
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(group.getAttribute("aria-activedescendant")).toBe(
      within(listbox).getByRole("option", { name: "State" }).id,
    );
    fireEvent.keyDown(group, { key: "Enter" });
    expect(latest?.groupBy).toBe("state");
    expect(r.queryByRole("listbox", { name: "Group by options" })).toBeNull();
  });

  test("Escape dismisses an open nested listbox without closing Display options", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    const group = r.getByRole("combobox", { name: "Group by" });
    fireEvent.click(group);
    fireEvent.keyDown(group, { key: "Escape" });
    expect(r.queryByRole("listbox", { name: "Group by options" })).toBeNull();
    expect(r.getByRole("dialog", { name: "Display options" })).toBeTruthy();
  });

  test("choosing the group as sub-group is prevented by option filtering", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    chooseOption(r, "Group by", "Agent");
    fireEvent.click(r.getByRole("combobox", { name: "Sub-group by" }));
    const subOptions = within(r.getByRole("listbox", { name: "Sub-group by options" })).getAllByRole("option");
    expect(subOptions.map((option) => option.textContent)).not.toContain("Agent");
  });

  test("column pills toggle visibility but always-on columns are not offered", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    expect(r.queryByRole("button", { name: "Run" })).toBeNull();
    const pill = r.getByRole("button", { name: "Agent" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.textContent).toContain("✓");
    fireEvent.click(pill);
    expect(latest?.hiddenColumns).toEqual(["agent"]);
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(pill.textContent).not.toContain("✓");
  });

  test("ordering direction is a two-state aria-pressed segment", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    const asc = r.getByRole("button", { name: "Ascending order" });
    const desc = r.getByRole("button", { name: "Descending order" });
    expect(asc.getAttribute("aria-pressed")).toBe("true");
    expect(desc.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(desc);
    expect(latest?.sortDir).toBe("desc");
    expect(asc.getAttribute("aria-pressed")).toBe("false");
    expect(desc.getAttribute("aria-pressed")).toBe("true");
  });

  test("groups every discovered path and derives a view-aware placeholder", () => {
    const sampleRows: Row[] = [
      {
        id: "r1",
        state: "RUNNING",
        agent: "a",
        envelope: { payload: { repo: "watt-mind/factory", owner: "watt-mind" } },
        spec: { input: { model: "claude-sonnet" } },
        labels: { priority: "high" },
      },
    ];
    const r = render(<Harness rows={sampleRows} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));

    const input = r.getByRole("combobox", { name: "Add custom property path" });
    expect(input.getAttribute("placeholder")).toContain("labels.priority");
    fireEvent.focus(input);

    const listbox = r.getByRole("listbox", { name: "Discovered property paths" });
    expect(within(listbox).getByText("payload")).toBeTruthy();
    expect(within(listbox).getByText("spec")).toBeTruthy();
    expect(within(listbox).getByText("labels")).toBeTruthy();
    expect(within(listbox).getAllByRole("option")).toHaveLength(4);
    expect(within(listbox).getByRole("option", { name: /payload\.repo.*watt-mind\/factory.*1 row/i })).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(r.queryByRole("listbox", { name: "Discovered property paths" })).toBeNull();
    expect(r.getByRole("dialog", { name: "Display options" })).toBeTruthy();
  });

  test("does not cap the full discovered suggestion list at ten paths", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`field${index}`, `value${index}`]),
    );
    const sampleRows: Row[] = [
      { id: "r1", state: "RUNNING", agent: "a", envelope: { payload } },
    ];
    const r = render(<Harness rows={sampleRows} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));

    const input = r.getByRole("combobox", { name: "Add custom property path" });
    fireEvent.focus(input);
    expect(within(r.getByRole("listbox", { name: "Discovered property paths" })).getAllByRole("option")).toHaveLength(12);
  });

  test("filters suggestions and adds the keyboard-highlighted path", () => {
    let latest: DisplayState | undefined;
    const sampleRows: Row[] = [
      {
        id: "r1",
        state: "RUNNING",
        agent: "a",
        envelope: { payload: { repo: "watt-mind/factory" } },
        spec: { input: { model: "claude-sonnet" } },
      },
    ];
    const r = render(<Harness onState={(s) => (latest = s)} rows={sampleRows} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));

    const input = r.getByRole("combobox", { name: "Add custom property path" });
    act(() => {
      changeInput(input as HTMLInputElement, "model");
    });
    const options = within(r.getByRole("listbox", { name: "Discovered property paths" })).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("spec.input.model");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(latest?.customColumns).toEqual(["spec.input.model"]);
    expect(r.getByRole("button", { name: "spec.input.model" })).toBeTruthy();
  });

  test("adds an undiscovered free-text path on Enter and explains the empty column", () => {
    let latest: DisplayState | undefined;
    const sampleRows: Row[] = [
      { id: "r1", state: "RUNNING", agent: "a", envelope: { payload: { repo: "watt-mind/factory" } } },
    ];
    const r = render(<Harness onState={(s) => (latest = s)} rows={sampleRows} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));

    const input = r.getByRole("combobox", { name: "Add custom property path" });
    act(() => {
      changeInput(input as HTMLInputElement, "payload.futureField");
    });
    expect(r.getByText("not seen in loaded items; the column will show — until a row has it")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(latest?.customColumns).toEqual(["payload.futureField"]);
    const removeBtn = r.getByLabelText("Remove column payload.futureField");
    fireEvent.click(removeBtn);
    expect(latest?.customColumns).toEqual([]);
  });

  test("Escape closes the panel and releases the modal depth", () => {
    // Relative to whatever depth other test files leaked: only the delta is ours.
    const base = modal.depth;
    const r = render(<Harness />);
    const trigger = r.getByRole("button", { name: /display/i });
    fireEvent.click(trigger);
    expect(modal.depth).toBe(base + 1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(r.queryByRole("dialog", { name: "Display options" })).toBeNull();
    expect(modal.depth).toBe(base);
    expect(document.activeElement).toBe(trigger);
  });

  test("reset appears only once customized and restores defaults", () => {
    let latest: DisplayState | undefined;
    const r = render(<Harness onState={(s) => (latest = s)} />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    expect(r.queryByRole("button", { name: /reset/i })).toBeNull();
    chooseOption(r, "Group by", "State");
    fireEvent.click(r.getByRole("button", { name: /reset/i }));
    expect(latest?.groupBy).toBe("none");
  });

  test("default sort option uses operator-facing label", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByRole("button", { name: /display/i }));
    const orderSelect = r.getByRole("combobox", { name: "Order by" });
    expect(orderSelect.textContent).toContain("Default order");
    expect(orderSelect.textContent).not.toContain("API order");
  });

  test("opening moves focus to the first interactive control", () => {
    const r = render(<Harness />);
    const trigger = r.getByRole("button", { name: /display/i });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(r.getByRole("combobox", { name: "Group by" }));
  });

  test("outside-click dismiss restores focus to the Display trigger", () => {
    const r = render(<Harness />);
    const trigger = r.getByRole("button", { name: /display/i });
    fireEvent.click(trigger);
    expect(r.getByRole("dialog", { name: "Display options" })).toBeTruthy();
    fireEvent.pointerDown(window, { target: document.body });
    expect(r.queryByRole("dialog", { name: "Display options" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("renders trailing subtle 'v' hint badge with aria-hidden", () => {
    const r = render(<Harness />);
    const trigger = r.getByRole("button", { name: /display/i });
    const badge = trigger.querySelector("span[aria-hidden='true']");
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe("v");
  });

  test("'v' hotkey opens the Display options popover when not typing", () => {
    const r = render(<Harness />);
    expect(r.queryByRole("dialog", { name: "Display options" })).toBeNull();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true }));
    });
    expect(r.getByRole("dialog", { name: "Display options" })).toBeTruthy();
  });

  test("'v' hotkey is ignored when target is an input or typing target", () => {
    const r = render(
      <div>
        <input data-testid="test-input" />
        <Harness />
      </div>,
    );
    const input = r.getByTestId("test-input");
    input.focus();
    fireEvent.keyDown(input, { key: "v" });
    expect(r.queryByRole("dialog", { name: "Display options" })).toBeNull();
  });

  test("'v' hotkey is ignored when go prefix is armed", () => {
    const r = render(<Harness />);
    goPrefix.armedAt = Date.now();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true }));
    });
    expect(r.queryByRole("dialog", { name: "Display options" })).toBeNull();
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

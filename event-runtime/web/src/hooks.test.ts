import "./test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement as h, useState } from "react";
import { modal, useHashRoute, useListKeys, useTheme } from "./hooks";

afterEach(() => {
  cleanup();
  modal.depth = 0;
  window.location.hash = "";
  localStorage.removeItem("evrt-theme");
  delete document.documentElement.dataset.theme;
});

function ThemeProbe() {
  const [theme] = useTheme();
  return h("span", { "data-testid": "theme" }, theme);
}

/** Helper list component driving useListKeys */
function InteractiveList(props: {
  count: number;
  initialIndex?: number;
  onSelectCallback?: (index: number) => void;
  onOpenCallback?: () => void;
  onCloseCallback?: () => void;
  customKeys?: Record<string, () => void>;
}) {
  const [selected, setSelected] = useState(props.initialIndex ?? 0);
  useListKeys({
    count: props.count,
    selected,
    onSelect: (idx) => {
      setSelected(idx);
      props.onSelectCallback?.(idx);
    },
    onOpen: props.onOpenCallback,
    onClose: props.onCloseCallback,
    keys: props.customKeys,
  });

  return h(
    "ul",
    { role: "listbox", "aria-label": "Items" },
    Array.from({ length: props.count }, (_, i) =>
      h(
        "li",
        {
          key: i,
          role: "option",
          "aria-selected": selected === i,
          "data-index": i,
        },
        `Item ${i + 1}`,
      ),
    ),
  );
}

/** Component combining useListKeys with useHashRoute for realistic hash-synced navigation */
function HashSyncedList(props: { count: number; prefix: string }) {
  const [, navigate] = useHashRoute();
  const [selected, setSelected] = useState(0);

  useListKeys({
    count: props.count,
    selected,
    onSelect: (idx) => {
      setSelected(idx);
      navigate(`${props.prefix}/${props.prefix}_${idx + 1}`);
    },
  });

  return h(
    "div",
    null,
    h("div", { "data-testid": "selected-val" }, String(selected)),
    h(
      "ul",
      { role: "listbox" },
      Array.from({ length: props.count }, (_, i) =>
        h(
          "li",
          {
            key: i,
            role: "option",
            "aria-selected": selected === i,
          },
          `Row ${i + 1}`,
        ),
      ),
    ),
  );
}

describe("useTheme", () => {
  test("corrupt evrt-theme in localStorage resets to dark and rewrites storage", () => {
    localStorage.setItem("evrt-theme", "foo");
    const r = render(h(ThemeProbe));
    expect(r.getByTestId("theme").textContent).toBe("dark");
    expect(localStorage.getItem("evrt-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("useListKeys unit tests — rapid j/k keydown movement", () => {
  test("holding 'j' across rapid keydown events advances selection to count - 1", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 20,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    // Simulate holding 'j' (producing 50 rapid keydown events with browser re-renders between repeats)
    for (let i = 0; i < 50; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        );
      });
    }

    const items = r.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("false");
    expect(items[19].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices[0]).toBe(1);
    expect(selectedIndices.at(-1)).toBe(19);
    // Should clamp at count - 1 (index 19)
    expect(selectedIndices.every((idx) => idx >= 0 && idx <= 19)).toBe(true);
  });

  test("holding 'k' across rapid keydown events decrements selection to 0", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 20,
        initialIndex: 19,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    // Simulate holding 'k' (producing 50 rapid keydown events with browser re-renders between repeats)
    for (let i = 0; i < 50; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", bubbles: true }),
        );
      });
    }

    const items = r.getAllByRole("option");
    expect(items[19].getAttribute("aria-selected")).toBe("false");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices[0]).toBe(18);
    expect(selectedIndices.at(-1)).toBe(0);
    // Should clamp at 0
    expect(selectedIndices.every((idx) => idx >= 0 && idx <= 19)).toBe(true);
  });

  test("holding ArrowDown and ArrowUp behaves identically to j and k", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 10,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    // Move down with ArrowDown
    for (let i = 0; i < 5; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      });
    }

    let items = r.getAllByRole("option");
    expect(items[5].getAttribute("aria-selected")).toBe("true");

    // Move up with ArrowUp
    for (let i = 0; i < 3; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
        );
      });
    }

    items = r.getAllByRole("option");
    expect(items[2].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices.at(-1)).toBe(2);
  });

  test("modifier keys (meta, ctrl, alt) ignore j/k keydowns", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 10,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", altKey: true, bubbles: true }),
      );
    });

    const items = r.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices.length).toBe(0);
  });

  test("keyGuard stands down j/k navigation when typing in inputs or when modal is open", () => {
    const selectedIndices: number[] = [];
    render(
      h(InteractiveList, {
        count: 10,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    const input = document.createElement("input");
    document.body.appendChild(input);

    // Dispatch event from input
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    expect(selectedIndices.length).toBe(0);

    document.body.removeChild(input);

    // Modal open
    modal.depth = 1;
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true }),
      );
    });
    expect(selectedIndices.length).toBe(0);

    modal.depth = 0;
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true }),
      );
    });
    expect(selectedIndices.length).toBe(1);
  });

  test("action keys (Enter, o, Escape, custom keys) fire correctly", () => {
    let opened = false;
    let closed = false;
    let approved = false;

    render(
      h(InteractiveList, {
        count: 5,
        initialIndex: 2,
        onOpenCallback: () => {
          opened = true;
        },
        onCloseCallback: () => {
          closed = true;
        },
        customKeys: {
          a: () => {
            approved = true;
          },
        },
      }),
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    expect(opened).toBe(true);
    expect(closed).toBe(true);
    expect(approved).toBe(true);
  });
});

describe("useListKeys + routing integration — Safari rapid j/k keydown hold simulation (OPS-337, OPS-349)", () => {
  test("rapid j keydown burst smoothly moves selection across 100 rows without throwing or freezing", () => {
    const r = render(h(HashSyncedList, { count: 100, prefix: "runs" }));

    // Simulate holding 'j' in Safari: 100 rapid keydowns at ~30Hz
    expect(() => {
      for (let i = 0; i < 99; i++) {
        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "j", bubbles: true }),
          );
        });
      }
    }).not.toThrow();

    const selectedVal = r.getByTestId("selected-val");
    expect(selectedVal.textContent).toBe("99");

    const items = r.getAllByRole("option");
    expect(items[99].getAttribute("aria-selected")).toBe("true");
  });

  test("rapid k keydown burst smoothly moves selection back to top", () => {
    const r = render(h(HashSyncedList, { count: 50, prefix: "events" }));

    // First advance to bottom
    for (let i = 0; i < 49; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        );
      });
    }
    expect(r.getByTestId("selected-val").textContent).toBe("49");

    // Hold 'k' back to top
    expect(() => {
      for (let i = 0; i < 49; i++) {
        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", bubbles: true }),
          );
        });
      }
    }).not.toThrow();

    expect(r.getByTestId("selected-val").textContent).toBe("0");
    const items = r.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
  });

  test("simulated history.replaceState SecurityError does not freeze selection movement", () => {
    const originalReplaceState = history.replaceState;
    // Simulate Safari history write rate-limit SecurityError
    let throwError = true;
    history.replaceState = function (...args) {
      if (throwError) {
        throw new DOMException(
          "SecurityError: Attempt to use history.replaceState() more than allowed",
          "SecurityError",
        );
      }
      return originalReplaceState.apply(this, args);
    };

    try {
      const r = render(h(HashSyncedList, { count: 30, prefix: "proposals" }));

      // Holding 'j' must continue to move selection smoothly in UI despite SecurityError
      expect(() => {
        for (let i = 0; i < 20; i++) {
          act(() => {
            document.body.dispatchEvent(
              new KeyboardEvent("keydown", { key: "j", bubbles: true }),
            );
          });
        }
      }).not.toThrow();

      expect(r.getByTestId("selected-val").textContent).toBe("20");
      const items = r.getAllByRole("option");
      expect(items[20].getAttribute("aria-selected")).toBe("true");
    } finally {
      history.replaceState = originalReplaceState;
    }
  });
});

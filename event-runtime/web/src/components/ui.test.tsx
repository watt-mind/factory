import "../test-dom";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  Button,
  ChipInput,
  clampTooltipPosition,
  clearToasts,
  CopyActions,
  Countdown,
  DetailPane,
  Dialog,
  FilterInput,
  getValueHue,
  IconButton,
  KV,
  KVGroup,
  ListToolbar,
  notify,
  PROPOSAL_STATUS_HUES,
  Section,
  shortId,
  StateBadge,
  SuggestInput,
  ToastContainer,
  Tooltip,
} from "./ui";
import { parseFilterQuery, PROPOSAL_FACETS, RUN_FACETS } from "../filterQuery";
import { modal } from "../hooks";
import { changeInput, typeText } from "../test-render";

function stackOf(r: ReturnType<typeof render>): HTMLElement {
  const parent = r.getByRole("status").parentElement;
  if (!parent) throw new Error("ToastContainer stack is missing");
  return parent;
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  modal.depth = 0;
  jest.useFakeTimers();
  clearToasts();
});

afterEach(() => {
  modal.depth = 0;
  clearToasts();
  jest.useRealTimers();
  cleanup();
});

describe("shortId (WM-96)", () => {
  test("shortens a prefixed UUID id to the prefix plus the first 8 body characters", () => {
    expect(shortId("run_ec9c87f9-4c1d-4f4a-9d7e-2c2f3a1b0c9d")).toBe(
      "run_ec9c87f9",
    );
    expect(shortId("worker_0f3b2a1c-9e8d-4b7a-8c6d-5e4f3a2b1c0d")).toBe(
      "worker_0f3b2a1c",
    );
  });

  test("returns ids whose body is already 8 characters or fewer unchanged", () => {
    expect(shortId("run_failed_1")).toBe("run_failed_1");
    expect(shortId("run_a")).toBe("run_a");
  });

  test("returns ids without a prefix unchanged", () => {
    expect(shortId("plainid-with-no-underscore")).toBe(
      "plainid-with-no-underscore",
    );
    expect(shortId("")).toBe("");
  });
});

describe("control sizing (WM-589)", () => {
  test("Button renders the shared 24, 28, and 32px sizes", () => {
    const r = render(
      <>
        <Button size="sm">
          <svg aria-hidden="true" />
          Small
        </Button>
        <Button size="md">
          <svg aria-hidden="true" />
          Medium
        </Button>
        <Button size="lg">
          <svg aria-hidden="true" />
          Large
        </Button>
      </>,
    );

    const small = r.getByRole("button", { name: "Small" });
    const medium = r.getByRole("button", { name: "Medium" });
    const large = r.getByRole("button", { name: "Large" });
    expect(classes(small)).toEqual(
      expect.arrayContaining(["h-6", "px-2", "[&>svg]:size-3"]),
    );
    expect(classes(medium)).toEqual(
      expect.arrayContaining(["h-7", "px-2.5", "[&>svg]:size-3.5"]),
    );
    expect(classes(large)).toEqual(
      expect.arrayContaining(["h-8", "px-3", "[&>svg]:size-4"]),
    );
    expect(small.getAttribute("data-control-size")).toBe("sm");
    expect(medium.getAttribute("data-control-size")).toBe("md");
    expect(large.getAttribute("data-control-size")).toBe("lg");
  });

  test("IconButton rejects a missing accessible name", () => {
    expect(() =>
      render(
        // Runtime protection complements the required TypeScript prop for JS/dynamic callers.
        // @ts-expect-error exercising the runtime guard
        <IconButton>
          <span aria-hidden="true">×</span>
        </IconButton>,
      ),
    ).toThrow("IconButton requires a non-empty aria-label");
  });

  test("IconButton is a square medium control with a shared tooltip", () => {
    const r = render(
      <IconButton aria-label="Copy run id">
        <span aria-hidden="true">#</span>
      </IconButton>,
    );
    const button = r.getByRole("button", { name: "Copy run id" });
    expect(classes(button)).toContain("h-7");
    expect(classes(button)).toContain("w-7");
    expect(r.getByRole("tooltip").textContent).toBe("Copy run id");
  });
});

describe("Tooltip viewport clamp (WM-589 follow-up)", () => {
  test("clampTooltipPosition flips above a bottom-pinned trigger instead of opening off-screen", () => {
    // Footer theme toggle: trigger sits flush with the bottom of the viewport,
    // so opening downward (the old CSS-only default) put the tooltip entirely
    // below the visible page.
    const trigger = { top: 878, left: 700, right: 732, bottom: 900, width: 32 };
    const tooltip = { width: 140, height: 26 };
    const viewport = { width: 1440, height: 900 };
    const pos = clampTooltipPosition(trigger, tooltip, viewport);
    expect(pos.top).toBeGreaterThanOrEqual(0);
    expect(pos.top + tooltip.height).toBeLessThanOrEqual(viewport.height);
    expect(pos.top).toBeLessThan(trigger.top); // flipped above the trigger
  });

  test("clampTooltipPosition clamps a right-edge trigger's tooltip inside the viewport width", () => {
    // ContextTabs "+" repo picker: trigger sits top-right, so centering the
    // tooltip under it (the old CSS-only default) clipped it off the right edge.
    const trigger = { top: 40, left: 1400, right: 1432, bottom: 68, width: 32 };
    const tooltip = { width: 220, height: 26 };
    const viewport = { width: 1440, height: 900 };
    const pos = clampTooltipPosition(trigger, tooltip, viewport);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.left + tooltip.width).toBeLessThanOrEqual(viewport.width);
  });

  function rect(r: {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }): DOMRect {
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  }

  test("Tooltip keeps a bottom-pinned trigger's tooltip on-screen", () => {
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 900,
      configurable: true,
    });

    const r = render(
      <Tooltip label="Switch to dark theme">
        <button aria-label="Theme">T</button>
      </Tooltip>,
    );
    const trigger = r.getByRole("button", { name: "Theme" })
      .parentElement as HTMLElement;
    const tooltip = r.getByRole("tooltip");
    trigger.getBoundingClientRect = () =>
      rect({
        top: 878,
        left: 700,
        right: 732,
        bottom: 900,
        width: 32,
        height: 22,
      });
    tooltip.getBoundingClientRect = () =>
      rect({ top: 0, left: 0, right: 140, bottom: 26, width: 140, height: 26 });

    act(() => {
      fireEvent.mouseEnter(trigger);
    });

    const top = parseFloat(tooltip.style.top);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + 26).toBeLessThanOrEqual(900);
  });

  test("Tooltip keeps a right-edge trigger's tooltip on-screen", () => {
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 900,
      configurable: true,
    });

    const r = render(
      <Tooltip label="Open a repo tab (g 1–9)">
        <button aria-label="Open repo">+</button>
      </Tooltip>,
    );
    const trigger = r.getByRole("button", { name: "Open repo" })
      .parentElement as HTMLElement;
    const tooltip = r.getByRole("tooltip");
    trigger.getBoundingClientRect = () =>
      rect({
        top: 40,
        left: 1400,
        right: 1432,
        bottom: 68,
        width: 32,
        height: 28,
      });
    tooltip.getBoundingClientRect = () =>
      rect({ top: 0, left: 0, right: 220, bottom: 26, width: 220, height: 26 });

    act(() => {
      fireEvent.mouseEnter(trigger);
    });

    const left = parseFloat(tooltip.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 220).toBeLessThanOrEqual(1440);
  });

  test("Tooltip recomputes position when its label changes while it stays open", () => {
    // Regression for a follow-up finding on the theme toggle: the label can
    // change (and grow) on click without the pointer/focus ever leaving the
    // button, so the effect must react to the label content too, not just
    // the open/closed transition.
    Object.defineProperty(window, "innerWidth", {
      value: 1440,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 900,
      configurable: true,
    });

    function ToggleLabelHarness() {
      const [long, setLong] = useState(false);
      return (
        <Tooltip label={long ? "A much longer label after the click" : "Short"}>
          <button aria-label="Toggle" onClick={() => setLong(true)}>
            T
          </button>
        </Tooltip>
      );
    }

    const r = render(<ToggleLabelHarness />);
    const button = r.getByRole("button", { name: "Toggle" });
    const trigger = button.parentElement as HTMLElement;
    const tooltip = r.getByRole("tooltip");
    trigger.getBoundingClientRect = () =>
      rect({
        top: 40,
        left: 1400,
        right: 1432,
        bottom: 68,
        width: 32,
        height: 28,
      });
    tooltip.getBoundingClientRect = () =>
      rect({ top: 0, left: 0, right: 60, bottom: 26, width: 60, height: 26 });

    act(() => {
      fireEvent.mouseEnter(trigger);
    });
    const shortLeft = parseFloat(tooltip.style.left);
    expect(shortLeft + 60).toBeLessThanOrEqual(1440);

    // The click grows the label/tooltip without a mouseleave/mouseenter —
    // pointer stays put, `open` never flips.
    tooltip.getBoundingClientRect = () =>
      rect({ top: 0, left: 0, right: 260, bottom: 26, width: 260, height: 26 });
    act(() => {
      fireEvent.click(button);
    });

    const left = parseFloat(tooltip.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 260).toBeLessThanOrEqual(1440);
  });
});

describe("ListToolbar (WM-543)", () => {
  test("exposes one tablist and one tools group without allowing either group to wrap internally", () => {
    const r = render(
      <ListToolbar
        tabs={
          <div
            role="tablist"
            aria-label="Run state"
            className="flex w-max flex-nowrap gap-1"
          >
            <button role="tab" aria-selected="true">
              All
            </button>
            <button role="tab" aria-selected="false">
              Completed
            </button>
          </div>
        }
        tools={
          <>
            <button>Display</button>
            <FilterInput
              value=""
              onChange={() => {}}
              placeholder="Filter runs"
              label="Filter runs"
            />
          </>
        }
      />,
    );

    expect(r.getAllByRole("tablist")).toHaveLength(1);
    const tools = r.getByRole("group", { name: "List tools" });
    expect(classes(tools)).toContain("flex-nowrap");
    expect(classes(tools)).toContain("flex-[1_1_14rem]");
    expect(classes(tools)).not.toContain("w-max");
    // Right-aligned only from `sm` up; below that, overflow runs off the
    // trailing edge rather than back over the nav sidebar (WM-96 follow-up).
    expect(classes(tools)).toContain("justify-start");
    expect(classes(tools)).toContain("sm:justify-end");
    expect(classes(tools.parentElement as HTMLElement)).toContain("flex-wrap");

    const filter = r.getByRole("combobox").parentElement?.parentElement;
    if (!filter) throw new Error("filter sizing wrapper is missing");
    expect(classes(filter)).toContain("min-w-36");
    expect(classes(filter)).toContain("max-w-56");
    expect(classes(filter)).toContain("flex-[1_1_14rem]");
  });

  test("masks the scrollable edge of an overflowing tab strip and clears it once fully visible (WM-96)", () => {
    const r = render(
      <ListToolbar
        tabs={
          <div role="tablist" aria-label="Event status" className="flex">
            <button role="tab" aria-selected="true">
              All
            </button>
            <button role="tab" aria-selected="false">
              Cancelled
            </button>
          </div>
        }
        tools={<button>Display</button>}
      />,
    );
    const tablist = r.getByRole("tablist");
    const scroller = tablist.parentElement as HTMLElement;

    // No overflow: no mask.
    expect(scroller.style.maskImage).toBeFalsy();

    // Overflowing and scrolled to the start: only the trailing edge fades.
    Object.defineProperty(scroller, "scrollWidth", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(scroller, "clientWidth", {
      value: 200,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollLeft", {
      value: 0,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(scroller.style.maskImage).toContain("to right");
    expect(scroller.style.maskImage).not.toContain("transparent, black 2rem");

    // Scrolled to the trailing edge: only the leading edge fades.
    Object.defineProperty(scroller, "scrollLeft", {
      value: 200,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(scroller.style.maskImage).toContain("to left");

    // Scrolled to the middle: both edges fade.
    Object.defineProperty(scroller, "scrollLeft", {
      value: 100,
      configurable: true,
    });
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(scroller.style.maskImage).toContain("transparent, black 2rem");
  });

  test("scrolls a focused tab into view so keyboard users can reach clipped tabs (WM-96)", () => {
    const scrolls: HTMLElement[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolls.push(this);
    };
    try {
      const r = render(
        <ListToolbar
          tabs={
            <div role="tablist" aria-label="Event status" className="flex">
              <button role="tab" aria-selected="false">
                Cancelled
              </button>
            </div>
          }
          tools={<button>Display</button>}
        />,
      );
      const tab = r.getByRole("tab", { name: "Cancelled" });
      act(() => {
        fireEvent.focus(tab);
      });
      expect(scrolls).toEqual([tab]);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

describe("CopyActions (WM-302)", () => {
  test("renders icon-only actions with accessible labels and shared shortcut tooltips", () => {
    const r = render(
      <CopyActions
        id="run_123"
        idLabel="run id"
        cli="bun event-runtime/cli.mjs inspect run_123"
        cliLabel="CLI inspect command"
      />,
    );

    const id = r.getByRole("button", { name: "Copy run id (c)" });
    const cli = r.getByRole("button", {
      name: "Copy CLI inspect command (c i)",
    });
    const link = r.getByRole("button", { name: "Copy link (c l)" });
    expect(r.getAllByRole("tooltip").map((el) => el.textContent)).toEqual([
      "Copy run id · c",
      "Copy CLI inspect command · c i",
      "Copy link · c l",
    ]);
    expect(id.textContent).toBe("");
    expect(cli.textContent).toBe("");
    expect(link.textContent).toBe("");
  });

  test("omits the CLI action when no CLI value is provided", () => {
    const r = render(<CopyActions id="event_123" idLabel="event id" />);

    expect(r.getAllByRole("button")).toHaveLength(2);
    expect(r.queryByRole("button", { name: /CLI/ })).toBeNull();
  });

  test("copies the id, CLI command, and current link through the shared handlers", () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (value: string) => writes.push(value) },
    });
    const r = render(
      <CopyActions
        id="run_123"
        idLabel="run id"
        cli="bun event-runtime/cli.mjs inspect run_123"
        cliLabel="CLI inspect command"
      />,
    );

    fireEvent.click(r.getByRole("button", { name: "Copy run id (c)" }));
    fireEvent.click(
      r.getByRole("button", { name: "Copy CLI inspect command (c i)" }),
    );
    fireEvent.click(r.getByRole("button", { name: "Copy link (c l)" }));

    expect(writes).toEqual([
      "run_123",
      "bun event-runtime/cli.mjs inspect run_123",
      window.location.href,
    ]);
  });
});

describe("ToastContainer", () => {
  test("mounts both live regions while empty so a later insert is announced", () => {
    const r = render(<ToastContainer />);
    const status = r.getByRole("status");
    const alert = r.getByRole("alert");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(status.getAttribute("aria-atomic")).toBe("false");
    expect(alert.getAttribute("aria-atomic")).toBe("false");
    expect(classes(stackOf(r))).not.toContain("gap-2");
  });

  test("does not put gap-2 on the stack when only the polite region holds a toast", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("polite only");
    });
    expect(classes(stackOf(r))).not.toContain("gap-2");
  });

  test("does not put gap-2 on the stack when only the assertive region holds a toast", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("assertive only", "err");
    });
    expect(classes(stackOf(r))).not.toContain("gap-2");
  });

  test("puts gap-2 on the stack only when both regions hold a toast", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("polite toast");
      notify("assertive toast", "err");
    });
    expect(classes(stackOf(r))).toContain("gap-2");
  });

  test("renders toasts as focusable buttons with message as accessible name and allows dismissal", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("Operation succeeded", "ok");
    });
    const button = r.getByRole("button", { name: /Operation succeeded/i });
    expect(button).toBeTruthy();
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("Dismiss");

    act(() => {
      button.click();
    });
    expect(
      r.queryByRole("button", { name: /Operation succeeded/i }),
    ).toBeNull();
  });

  test("deduplicates repeated identical error messages", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("Workspace release failed", "err");
      notify("Workspace release failed", "err");
    });
    expect(
      r.getAllByRole("button", { name: "Workspace release failed" }),
    ).toHaveLength(1);
  });

  test("does not deduplicate repeated ok toasts", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("Saved", "ok");
      notify("Saved", "ok");
    });
    expect(r.getAllByRole("button", { name: "Saved" })).toHaveLength(2);
  });

  test("re-arms the dismissal timer when an error repeats", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("Workspace release keeps failing", "err");
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    act(() => {
      notify("Workspace release keeps failing", "err");
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    // 4s after the first notify: without the re-arm the toast is gone.
    expect(
      r.getByRole("button", { name: "Workspace release keeps failing" }),
    ).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(
      r.queryByRole("button", { name: "Workspace release keeps failing" }),
    ).toBeNull();
  });
});

describe("Countdown", () => {
  // useNow() re-renders off a 1s setInterval; jest.advanceTimersByTime does not
  // reliably fake Date.now() inside that interval callback under bun:test, so
  // these assert the two render states directly (live vs. expired) rather than
  // driving the tick via fake-timer advancement.

  test("renders a live countdown with a 'left' qualifier and the absolute expiry as title", () => {
    const now = new Date("2024-01-01T00:00:00Z");
    jest.setSystemTime(now);
    const createdAt = now.toISOString();
    const ttlSeconds = 15 * 60 + 14;
    const r = render(
      <Countdown createdAt={createdAt} ttlSeconds={ttlSeconds} />,
    );

    const el = r.container.querySelector("span");
    if (!el) throw new Error("Countdown span is missing");
    expect(el.textContent).toBe("15:14 left");
    expect(el.getAttribute("title")).toBe(
      new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    );
  });

  test("counts down as time passes, without losing the 'left' qualifier", () => {
    const created = new Date("2024-01-01T00:00:00Z");
    jest.setSystemTime(new Date(created.getTime() + 60_000));
    const r = render(
      <Countdown createdAt={created.toISOString()} ttlSeconds={15 * 60 + 14} />,
    );

    const el = r.container.querySelector("span");
    if (!el) throw new Error("Countdown span is missing");
    expect(el.textContent).toBe("14:14 left");
  });

  test("shows relative age instead of a bare 'expired' once the TTL has elapsed", () => {
    const now = new Date("2024-01-01T00:00:00Z");
    jest.setSystemTime(now);
    const ttlSeconds = 60;
    const createdAt = new Date(
      now.getTime() - (ttlSeconds * 1000 + 2 * 3600 * 1000),
    ).toISOString();
    const r = render(
      <Countdown createdAt={createdAt} ttlSeconds={ttlSeconds} />,
    );

    const el = r.container.querySelector("span");
    if (!el) throw new Error("Countdown span is missing");
    expect(el.textContent).toBe("expired 2h ago");
    expect(el.getAttribute("title")).toBe(
      new Date(new Date(createdAt).getTime() + ttlSeconds * 1000).toISOString(),
    );
  });
});

describe("DetailPane", () => {
  // WM-97: with six actions in the Runs toolbar the old single-row header
  // grew past the panel edge and clipped Close off entirely. Close now rides
  // a dedicated non-wrapping slot next to the title; the other actions live
  // in a row that is allowed to wrap. jsdom does no layout, so these assert
  // the structure that produces that behavior, plus that Close stays wired.

  function renderPane(onClose: () => void) {
    return render(
      <DetailPane
        widthClass="w-[460px]"
        title={<span>run_0000</span>}
        actions={
          <>
            <Button onClick={() => {}}>Open in tab</Button>
            <Button onClick={() => {}}>Expand</Button>
            <Button onClick={() => {}}>Copy id</Button>
            <Button onClick={() => {}}>Copy CLI</Button>
            <Button onClick={() => {}}>Copy link</Button>
          </>
        }
        close={<Button onClick={onClose}>Close</Button>}
      >
        <div>body</div>
      </DetailPane>,
    );
  }

  test("renders Close and fires its handler even with many actions present", () => {
    const onClose = jest.fn();
    const r = renderPane(onClose);
    const close = r.getByText("Close");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("pins Close outside the wrapping action row, in a non-shrinking slot", () => {
    const r = renderPane(() => {});
    const close = r.getByText("Close");
    const actionRow = r.getByText("Copy link").parentElement;
    if (!actionRow) throw new Error("action row is missing");
    // Close must not be a sibling inside the wrapping row, or wrapping order
    // could push it below the fold with everything else.
    expect(actionRow.contains(close)).toBe(false);
    expect(classes(actionRow)).toContain("flex-wrap");
    // shrink-0 on the row is what defeated flex-wrap originally: the row then
    // keeps its max-content width and overflows instead of wrapping.
    expect(classes(actionRow)).not.toContain("shrink-0");
    const closeSlot = close.parentElement;
    if (!closeSlot) throw new Error("close slot is missing");
    expect(classes(closeSlot)).toContain("shrink-0");
  });

  test("omits the close slot when no close action is given", () => {
    const r = render(
      <DetailPane
        widthClass="w-[440px]"
        title="t"
        actions={<Button onClick={() => {}}>Copy id</Button>}
      >
        <div>body</div>
      </DetailPane>,
    );
    expect(r.queryByText("Close")).toBeNull();
  });

  test("places utility on the title row with Close, not a third row (WM-848)", () => {
    const r = render(
      <DetailPane
        widthClass="w-[460px]"
        title={<span>run_0000</span>}
        utility={<span>utility-slot</span>}
        actions={<Button onClick={() => {}}>Expand</Button>}
        close={<Button onClick={() => {}}>Close</Button>}
      >
        <div>body</div>
      </DetailPane>,
    );
    const chrome = r.getByText("run_0000").closest(".border-b");
    expect(chrome).toBeTruthy();
    const rows = [...(chrome?.children ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("run_0000");
    expect(rows[0]?.textContent).toContain("utility-slot");
    expect(rows[0]?.textContent).toContain("Close");
    expect(rows[1]?.textContent).toContain("Expand");
    expect(rows[1]?.textContent).not.toContain("utility-slot");
  });
});

describe("getValueHue", () => {
  test("returns matching hues for states, decisions, and statuses", () => {
    expect(getValueHue("state", "failed")).toBe("var(--hue-err)");
    expect(getValueHue("state", "COMPLETED")).toBe("var(--hue-ok)");
    expect(getValueHue("state", "RUNNING")).toBe("var(--hue-warn)");
    expect(getValueHue("decision", "run")).toBe("var(--hue-info)");
    expect(getValueHue("status", "admitted")).toBe("var(--hue-info)");
    expect(getValueHue("status", "expired")).toBe(PROPOSAL_STATUS_HUES.expired);
  });

  test("covers every proposal status offered by the web filter", () => {
    for (const status of PROPOSAL_FACETS.values?.status ?? []) {
      expect(PROPOSAL_STATUS_HUES).toHaveProperty(status);
    }
  });

  test("keeps superseded distinct from resolved where both statuses render", () => {
    expect(PROPOSAL_STATUS_HUES.superseded).toBe("var(--hue-verify)");
    expect(PROPOSAL_STATUS_HUES.superseded).not.toBe(
      PROPOSAL_STATUS_HUES.resolved,
    );
  });
});

describe("FilterInput autocomplete (OPS-506)", () => {
  function renderFilter(
    props: {
      value?: string;
      onChange?: (v: string) => void;
      query?: ReturnType<typeof parseFilterQuery>;
      facets?: typeof RUN_FACETS;
    } = {},
  ) {
    const {
      value = "",
      onChange = () => {},
      query,
      facets = RUN_FACETS,
    } = props;
    const parsed = query ?? parseFilterQuery(value, facets);
    return render(
      <FilterInput
        value={value}
        onChange={onChange}
        placeholder="Filter runs"
        label="Filter runs"
        query={parsed}
        facets={facets}
      />,
    );
  }

  test("shows suggestions dropdown when focused and detects active token", () => {
    const r = renderFilter({ value: "" });
    const input = r.getByRole("combobox");
    fireEvent.focus(input);

    const listbox = r.getByRole("listbox");
    expect(listbox).toBeTruthy();
    expect(r.getByText("state:")).toBeTruthy();
    expect(r.getByText("agent:")).toBeTruthy();
    expect(r.getByText("is:stale")).toBeTruthy();
  });

  test("suggests available enum values with hues when typing facet value", () => {
    const r = renderFilter({ value: "state:" });
    const input = r.getByRole("combobox");
    fireEvent.focus(input);

    const listbox = r.getByRole("listbox");
    expect(listbox).toBeTruthy();
    const failedOption = r.getByText("failed");
    expect(failedOption).toBeTruthy();
  });

  test("navigates suggestions with ArrowDown / ArrowUp and selects with Enter", () => {
    const onChange = jest.fn();
    const r = renderFilter({ value: "st", onChange });
    const input = r.getByRole("combobox");
    fireEvent.focus(input);

    const options = r.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("state:");
  });

  test("selects active suggestion with Tab", () => {
    const onChange = jest.fn();
    const r = renderFilter({ value: "state:fa", onChange });
    const input = r.getByRole("combobox");
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "Tab" });
    expect(onChange).toHaveBeenCalledWith("state:failed ");
  });

  test("Esc dismisses dropdown, subsequent Esc clears filter", () => {
    const onChange = jest.fn();
    const r = renderFilter({ value: "state:fa", onChange });
    const input = r.getByRole("combobox");
    fireEvent.focus(input);

    expect(r.queryByRole("listbox")).toBeTruthy();

    // First Esc: dismisses popover
    fireEvent.keyDown(input, { key: "Escape" });
    expect(r.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    // Second Esc: clears filter
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("");
  });

  test("clicking a suggestion item selects it and updates input value", () => {
    const onChange = jest.fn();
    const r = renderFilter({ value: "", onChange });
    const input = r.getByRole("combobox");
    fireEvent.focus(input);

    const agentOpt = r.getByText("agent:");
    fireEvent.mouseDown(agentOpt);
    expect(onChange).toHaveBeenCalledWith("agent:");
  });
});

describe("KV mono discipline (WM-136)", () => {
  test("renders identifier-ish values in mono and prose values in the UI font", () => {
    const r = render(
      <>
        <KV k="agent" v="dispatch@1" />
        <KV k="workspace" v="/Users/x/.factory/event-runtime" />
        <KV k="placement" v="any worker" />
      </>,
    );
    expect(classes(r.getByTitle("dispatch@1"))).toContain("mono");
    expect(classes(r.getByTitle("/Users/x/.factory/event-runtime"))).toContain(
      "mono",
    );
    // "any worker" is language, not an identifier — character alignment buys nothing.
    expect(classes(r.getByTitle("any worker"))).not.toContain("mono");
  });

  test("honours an explicit mono override in both directions", () => {
    const r = render(
      <>
        <KV k="forced" v="two words" mono />
        <KV k="unforced" v="single-token" mono={false} />
      </>,
    );
    expect(classes(r.getByTitle("two words"))).toContain("mono");
    expect(classes(r.getByTitle("single-token"))).not.toContain("mono");
  });

  test("keeps copy-on-click and the full-value tooltip on truncated values", () => {
    const r = render(<KV k="specHash" v="sha256:abcdef" />);
    const value = r.getByTitle("sha256:abcdef");
    expect(value.tagName).toBe("BUTTON");
    expect(classes(value)).toContain("truncate");
  });
});

describe("KV attribute icons and unset values (WM-482)", () => {
  test("renders a leading aria-hidden icon slot only when an icon is passed", () => {
    const r = render(
      <>
        <KV
          k="timeout"
          v="120s"
          icon={<svg data-testid="icon" viewBox="0 0 15 15" />}
        />
        <KV k="version" v="1" />
      </>,
    );
    const slot = r.getByTestId("icon").parentElement!;
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    // Icon precedes the label inside the same label cell (§5.2 placement grammar).
    const labelCell = slot.parentElement!;
    expect(labelCell.getAttribute("title")).toBe("timeout");
    expect(labelCell.firstElementChild).toBe(slot);
    // A row without `icon` renders no slot at all — groups without icons stay flush.
    expect(r.getByTitle("version").querySelector("[aria-hidden]")).toBeNull();
  });

  test("<Section icons> resolves KV glyphs from the registry and reserves the slot for unmapped labels (WM-483)", () => {
    const r = render(
      <Section title="Run" icons>
        <KV k="adapter" v="pi" />
        <KV k="runId" v="run_1" />
      </Section>,
    );
    expect(
      r.getByTitle("adapter").querySelector("i[aria-hidden] svg"),
    ).toBeTruthy();
    const slot = r.getByTitle("runId").querySelector("i[aria-hidden]");
    expect(slot).toBeTruthy();
    expect(slot!.querySelector("svg")).toBeNull();
    cleanup();
    // Without the opt-in nothing changes for the ~100 existing KV call sites.
    const bare = render(
      <Section title="Run">
        <KV k="adapter" v="pi" />
      </Section>,
    );
    expect(
      bare.getByTitle("adapter").querySelector("i[aria-hidden]"),
    ).toBeNull();
  });

  test("a null icon reserves the slot so labels in the same group align", () => {
    const r = render(<KV k="model override" v="-" icon={null} />);
    expect(
      r.getByTitle("model override").querySelector("[aria-hidden]"),
    ).toBeTruthy();
  });

  test("renders the unset marker fainter than a set value", () => {
    const r = render(
      <>
        <KV k="hosts" v="-" />
        <KV k="adapter" v={<span>agy</span>} />
      </>,
    );
    const unset = r.getByText("-");
    expect(classes(unset)).toContain("text-(--text-faint)");
    expect(unset.tagName).toBe("SPAN"); // never copyable
    const set = r.getByText("agy").parentElement!;
    expect(classes(set)).toContain("text-(--text-dim)");
  });

  test("KVGroup titles the group and separates consecutive groups with a hairline", () => {
    const r = render(
      <>
        <KVGroup title="Identity">
          <KV k="id" v="a" />
        </KVGroup>
        <KVGroup title="Limits">
          <KV k="timeout" v="1s" />
        </KVGroup>
      </>,
    );
    expect(r.getByText("Identity")).toBeTruthy();
    const limits = r.getByText("Limits").parentElement!;
    expect(classes(limits)).toContain("not-first:border-t");
  });
});

describe("Section cards and collapse persistence (WM-136)", () => {
  beforeEach(() => localStorage.clear());

  test("wraps rows in a card by default and skips it when card is false", () => {
    const carded = render(
      <Section title="Run">
        <KV k="agent" v="a@1" />
      </Section>,
    );
    expect(carded.container.querySelector(".rounded-md")).toBeTruthy();
    cleanup();
    const bare = render(
      <Section title="Heartbeat" card={false}>
        <KV k="agent" v="a@1" />
      </Section>,
    );
    expect(bare.container.querySelector(".rounded-md")).toBeNull();
  });

  test("collapses on click, hides its rows, and persists the choice", () => {
    const r = render(
      <Section title="Lifecycle">
        <KV k="agent" v="a@1" />
      </Section>,
    );
    expect(r.queryByText("agent")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { expanded: true }));
    expect(r.queryByText("agent")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("evrt-sections-collapsed")!),
    ).toContain("Lifecycle");
    // A remount reads the persisted choice back.
    cleanup();
    const again = render(
      <Section title="Lifecycle">
        <KV k="agent" v="a@1" />
      </Section>,
    );
    expect(again.queryByText("agent")).toBeNull();
  });

  test("a toggle does not stomp a sibling section's persisted collapse", () => {
    localStorage.setItem(
      "evrt-sections-collapsed",
      JSON.stringify(["Receipt"]),
    );
    const r = render(
      <>
        <Section title="Run">
          <KV k="agent" v="a@1" />
        </Section>
        <Section title="Receipt">
          <KV k="hash" v="abc" />
        </Section>
      </>,
    );
    fireEvent.click(r.getByRole("button", { expanded: true, name: /Run/ }));
    const stored = JSON.parse(localStorage.getItem("evrt-sections-collapsed")!);
    expect(stored).toContain("Run");
    expect(stored).toContain("Receipt");
  });

  test("keys persistence on id so a title carrying live data stays stable", () => {
    const r = render(
      <Section id="run-result" title="Result · COMPLETED · ok">
        <KV k="a" v="b" />
      </Section>,
    );
    fireEvent.click(r.getByRole("button", { expanded: true }));
    expect(
      JSON.parse(localStorage.getItem("evrt-sections-collapsed")!),
    ).toEqual(["run-result"]);
    cleanup();
    // Same section, different terminal state in the title — still collapsed.
    const again = render(
      <Section id="run-result" title="Result · FAILED · agent_exit_1">
        <KV k="a" v="b" />
      </Section>,
    );
    expect(again.queryByText("a")).toBeNull();
  });
});

describe("StateBadge dot suppression (WM-136)", () => {
  test("renders its own dot by default and omits it when dot={false}", () => {
    const withDot = render(<StateBadge state="RUNNING" />);
    expect(withDot.container.querySelector("svg")).toBeTruthy();
    cleanup();
    const bare = render(<StateBadge state="RUNNING" dot={false} />);
    expect(bare.container.querySelector("svg")).toBeNull();
    expect(bare.getByText("RUNNING")).toBeTruthy();
  });
});

describe("changeInput & typeText test helpers (WM-114)", () => {
  test("changeInput fires onChange and onInput on controlled <input>", () => {
    const changes: string[] = [];
    const inputs: string[] = [];
    function ControlledInput() {
      const [val, setVal] = useState("initial");
      return (
        <input
          data-testid="input"
          value={val}
          onInput={(e) => inputs.push((e.target as HTMLInputElement).value)}
          onChange={(e) => {
            changes.push(e.target.value);
            setVal(e.target.value);
          }}
        />
      );
    }
    const r = render(<ControlledInput />);
    const input = r.getByTestId("input") as HTMLInputElement;
    expect(input.value).toBe("initial");

    act(() => {
      changeInput(input, "updated value");
    });

    expect(changes).toEqual(["updated value"]);
    expect(inputs).toEqual(["updated value"]);
    expect(input.value).toBe("updated value");
  });

  test("changeInput fires onChange and onInput on controlled <textarea>", () => {
    const changes: string[] = [];
    const inputs: string[] = [];
    function ControlledTextarea() {
      const [val, setVal] = useState("start line");
      return (
        <textarea
          data-testid="textarea"
          value={val}
          onInput={(e) => inputs.push((e.target as HTMLTextAreaElement).value)}
          onChange={(e) => {
            changes.push(e.target.value);
            setVal(e.target.value);
          }}
        />
      );
    }
    const r = render(<ControlledTextarea />);
    const textarea = r.getByTestId("textarea") as HTMLTextAreaElement;

    act(() => {
      changeInput(textarea, "line 1\nline 2");
    });

    expect(changes).toEqual(["line 1\nline 2"]);
    expect(inputs).toEqual(["line 1\nline 2"]);
    expect(textarea.value).toBe("line 1\nline 2");
  });

  test("changeInput fires onChange on controlled <select>", () => {
    const changes: string[] = [];
    function ControlledSelect() {
      const [val, setVal] = useState("opt1");
      return (
        <select
          data-testid="select"
          value={val}
          onChange={(e) => {
            changes.push(e.target.value);
            setVal(e.target.value);
          }}
        >
          <option value="opt1">Option 1</option>
          <option value="opt2">Option 2</option>
        </select>
      );
    }
    const r = render(<ControlledSelect />);
    const select = r.getByTestId("select") as HTMLSelectElement;

    act(() => {
      changeInput(select, "opt2");
    });

    expect(changes).toEqual(["opt2"]);
    expect(select.value).toBe("opt2");
  });

  test("typeText simulates keystroke-level typing with selection progression and fires onChange on each key", () => {
    const keydowns: string[] = [];
    const keyups: string[] = [];
    const inputs: string[] = [];
    const changes: string[] = [];

    function ControlledInput() {
      const [val, setVal] = useState("");
      return (
        <input
          data-testid="input"
          value={val}
          onKeyDown={(e) => keydowns.push(e.key)}
          onKeyUp={(e) => keyups.push(e.key)}
          onInput={(e) => inputs.push((e.target as HTMLInputElement).value)}
          onChange={(e) => {
            changes.push(e.target.value);
            setVal(e.target.value);
          }}
        />
      );
    }
    const r = render(<ControlledInput />);
    const input = r.getByTestId("input") as HTMLInputElement;

    act(() => {
      typeText(input, "cat");
    });

    expect(keydowns).toEqual(["c", "a", "t"]);
    expect(keyups).toEqual(["c", "a", "t"]);
    expect(inputs).toEqual(["c", "ca", "cat"]);
    expect(changes).toEqual(["c", "ca", "cat"]);
    expect(input.value).toBe("cat");
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
  });

  test("typeText supports cursor insertion in middle of text and selection replacement", () => {
    function ControlledInput() {
      const [val, setVal] = useState("ac");
      return (
        <input
          data-testid="input"
          value={val}
          onChange={(e) => setVal(e.target.value)}
        />
      );
    }
    const r = render(<ControlledInput />);
    const input = r.getByTestId("input") as HTMLInputElement;

    // Mid-text insertion
    input.setSelectionRange(1, 1);
    act(() => {
      typeText(input, "b");
    });
    expect(input.value).toBe("abc");
    expect(input.selectionStart).toBe(2);

    // Range replacement: select "ab" (indices 0..2) and replace with "xy"
    input.setSelectionRange(0, 2);
    act(() => {
      typeText(input, "xy");
    });
    expect(input.value).toBe("xyc");
    expect(input.selectionStart).toBe(2);
  });
});

describe("SuggestInput popover (WM-79)", () => {
  function Harness({ initial = "" }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <SuggestInput
        value={value}
        onChange={setValue}
        suggestions={["bj29", "factory", "watt-mind/bj29"]}
        ariaLabel="repo"
      />
    );
  }

  test("does not use a native datalist", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", { name: "repo" });
    expect(input.getAttribute("list")).toBeNull();
    expect(r.container.querySelector("datalist")).toBeNull();
  });

  test("opens a styled listbox of suggestions on focus", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", { name: "repo" });
    fireEvent.focus(input);
    const listbox = r.getByRole("listbox");
    expect(listbox).toBeTruthy();
    expect(r.getByRole("option", { name: "bj29" })).toBeTruthy();
    expect(r.getByRole("option", { name: "factory" })).toBeTruthy();
  });

  test("keeps free-text write-in when the value is not in the list", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", { name: "repo" }) as HTMLInputElement;
    act(() => {
      changeInput(input, "custom-repo");
    });
    expect(input.value).toBe("custom-repo");
  });

  test("ArrowDown / ArrowUp / Enter select a suggestion; Escape dismisses", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", { name: "repo" }) as HTMLInputElement;
    fireEvent.focus(input);
    const options = r.getAllByRole("option");
    const expectSelected = (selectedIndex: number) => {
      options.forEach((option, index) => {
        expect(option.getAttribute("aria-selected")).toBe(
          index === selectedIndex ? "true" : "false",
        );
      });
    };
    expectSelected(0);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectSelected(1);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expectSelected(0);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expectSelected(options.length - 1);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectSelected(0);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectSelected(1);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("factory");
    expect(r.queryByRole("listbox")).toBeNull();

    fireEvent.focus(input);
    expect(r.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(r.queryByRole("listbox")).toBeNull();
  });
});

describe("ChipInput popover (WM-160)", () => {
  function Harness() {
    const [values, setValues] = useState(["bj29"]);
    return (
      <>
        <label htmlFor="repos">Repos</label>
        <ChipInput
          id="repos"
          values={values}
          onChange={setValues}
          suggestions={["bj29", "factory", "watt-mind/bj29"]}
        />
      </>
    );
  }

  test("uses a combobox and styled listbox instead of a native datalist", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", { name: "Repos" });
    expect(input.getAttribute("list")).toBeNull();
    expect(r.container.querySelector("datalist")).toBeNull();

    fireEvent.focus(input);
    const listbox = r.getByRole("listbox", { name: "Suggestions" });
    expect(listbox.parentElement).toBe(document.body);
    expect(classes(listbox)).toContain("fixed");
    expect(r.queryByRole("option", { name: "bj29" })).toBeNull();
    expect(r.getByRole("option", { name: "factory" })).toBeTruthy();
  });

  test("filters available suggestions and supports ArrowDown / ArrowUp / Enter / Escape", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", {
      name: "Repos",
    }) as HTMLInputElement;
    fireEvent.focus(input);

    const options = r.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      r.getByRole("button", { name: "Remove watt-mind/bj29" }),
    ).toBeTruthy();
    expect(r.queryByRole("listbox")).toBeNull();

    fireEvent.focus(input);
    act(() => {
      changeInput(input, "fact");
    });
    expect(r.getAllByRole("option")).toHaveLength(1);
    expect(r.getByRole("option", { name: "factory" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(r.queryByRole("listbox")).toBeNull();
  });

  test("preserves free-text chip entry when no suggestion matches", () => {
    const r = render(<Harness />);
    const input = r.getByRole("combobox", {
      name: "Repos",
    }) as HTMLInputElement;
    fireEvent.focus(input);
    act(() => {
      changeInput(input, "custom-repo");
    });
    expect(r.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(r.getByRole("button", { name: "Remove custom-repo" })).toBeTruthy();
    expect(input.value).toBe("");
  });
});

describe("Dialog (WM-270)", () => {
  test("Escape closes only the topmost stacked dialog", () => {
    function StackedDialogs() {
      const [parentOpen, setParentOpen] = useState(true);
      const [confirmationOpen, setConfirmationOpen] = useState(true);
      return (
        <>
          {parentOpen && (
            <Dialog title="Parent dialog" onClose={() => setParentOpen(false)}>
              Parent content
            </Dialog>
          )}
          {confirmationOpen && (
            <Dialog
              title="Confirmation dialog"
              onClose={() => setConfirmationOpen(false)}
            >
              Confirmation content
            </Dialog>
          )}
        </>
      );
    }

    const r = render(<StackedDialogs />);
    expect(modal.depth).toBe(2);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(r.queryByRole("dialog", { name: "Confirmation dialog" })).toBeNull();
    expect(r.getByRole("dialog", { name: "Parent dialog" })).toBeTruthy();
    expect(modal.depth).toBe(1);
  });

  test("renders pinned footer with action buttons and scrollable body (WM-829)", () => {
    let submitted = false;
    let closed = false;
    const r = render(
      <Dialog
        title="Pinned Dialog"
        onClose={() => {
          closed = true;
        }}
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                closed = true;
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                submitted = true;
              }}
            >
              Confirm
            </button>
          </>
        }
      >
        <div>Long modal body content</div>
      </Dialog>,
    );

    const dialog = r.getByRole("dialog", { name: "Pinned Dialog" });
    expect(dialog.className).toContain("flex flex-col");

    const header = r.getByText("Pinned Dialog");
    expect(header.className).toContain("shrink-0");

    const bodyContent = r.getByText("Long modal body content");
    expect(bodyContent.parentElement?.className).toContain(
      "flex-1 overflow-y-auto",
    );

    const cancelButton = r.getByRole("button", { name: "Cancel" });
    const confirmButton = r.getByRole("button", { name: "Confirm" });
    expect(cancelButton.parentElement?.className).toContain("border-t");

    fireEvent.click(confirmButton);
    expect(submitted).toBe(true);

    fireEvent.click(cancelButton);
    expect(closed).toBe(true);
  });
});

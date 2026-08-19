import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import {
  CLOSE_MS,
  computeHoverCardPosition,
  HoverCard,
  HOVER_CARD_HEIGHT,
  HOVER_CARD_WIDTH,
  MIN_PANEL_HEIGHT,
  OPEN_MS,
  prefersReducedMotion,
  VIEWPORT_MARGIN,
} from "./HoverCard";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  (window as unknown as { matchMedia?: unknown }).matchMedia =
    originalMatchMedia;
});

/** Stubs the motion query so the reduced-motion branch is reachable in tests. */
function stubReducedMotion(reduce: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = ((
    query: string,
  ) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function Fixture(props: {
  focusable?: boolean;
  openDelayMs?: number;
  closeDelayMs?: number;
  onOpenChange?: (open: boolean) => void;
  interactiveTrigger?: boolean;
  /** Two in-card controls, so the first and last tab stops are distinct. */
  secondAction?: boolean;
  hiddenSecondAction?: boolean;
}) {
  return (
    <HoverCard
      label="Agent triage-scan"
      openDelayMs={props.openDelayMs ?? 0}
      closeDelayMs={props.closeDelayMs ?? 0}
      focusable={props.focusable}
      onOpenChange={props.onOpenChange}
      trigger={
        props.interactiveTrigger ? (
          <button type="button">triage-scan</button>
        ) : (
          "triage-scan"
        )
      }
    >
      {({ close }) => (
        <>
          <span>card body</span>
          <button type="button" onClick={close}>
            Open in Agents
          </button>
          {props.secondAction ? (
            <button type="button" hidden={props.hiddenSecondAction}>
              Copy id
            </button>
          ) : null}
        </>
      )}
    </HoverCard>
  );
}

/** The element carrying the popup ARIA state (wrapper or inner trigger). */
function triggerOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-haspopup='dialog']");
  if (!el) throw new Error("trigger not found");
  return el;
}

function wrapperOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("span[tabindex]");
  if (!el) throw new Error("wrapper not found");
  return el;
}

describe("computeHoverCardPosition", () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: HOVER_CARD_WIDTH, height: HOVER_CARD_HEIGHT };

  test("places the panel below the trigger when there is room", () => {
    const p = computeHoverCardPosition(
      { top: 100, bottom: 118, left: 200 },
      viewport,
      size,
    );
    expect(p).toEqual({
      top: 126,
      left: 200,
      placeAbove: false,
      maxHeight: 762,
    });
  });

  test("clamps a right-edge trigger inside the viewport margin", () => {
    const p = computeHoverCardPosition(
      { top: 100, bottom: 118, left: 1400 },
      viewport,
      size,
    );
    expect(p.left).toBe(viewport.width - size.width - VIEWPORT_MARGIN);
    expect(p.left + size.width).toBeLessThanOrEqual(
      viewport.width - VIEWPORT_MARGIN,
    );
  });

  test("keeps a left-edge trigger off the viewport edge", () => {
    const p = computeHoverCardPosition(
      { top: 100, bottom: 118, left: -40 },
      viewport,
      size,
    );
    expect(p.left).toBe(VIEWPORT_MARGIN);
  });

  test("flips above when the space below cannot hold the panel", () => {
    const p = computeHoverCardPosition(
      { top: 820, bottom: 838, left: 200 },
      viewport,
      size,
    );
    expect(p.placeAbove).toBe(true);
    expect(p.top).toBe(812);
  });

  test("stays below when neither side fits but below is roomier", () => {
    const p = computeHoverCardPosition(
      { top: 60, bottom: 78, left: 200 },
      { width: 1440, height: 240 },
      size,
    );
    expect(p.placeAbove).toBe(false);
  });

  test("caps the height to the room on the chosen side", () => {
    const below = computeHoverCardPosition(
      { top: 100, bottom: 118, left: 200 },
      { width: 1440, height: 400 },
      size,
    );
    expect(below.placeAbove).toBe(false);
    expect(below.top + below.maxHeight).toBe(400 - VIEWPORT_MARGIN);

    const above = computeHoverCardPosition(
      { top: 260, bottom: 278, left: 200 },
      { width: 1440, height: 300 },
      size,
    );
    expect(above.placeAbove).toBe(true);
    expect(above.top - above.maxHeight).toBe(VIEWPORT_MARGIN);
  });

  test("never squeezes the panel below a readable minimum", () => {
    const p = computeHoverCardPosition(
      { top: 10, bottom: 28, left: 200 },
      { width: 1440, height: 60 },
      size,
    );
    expect(p.maxHeight).toBe(MIN_PANEL_HEIGHT);
  });
});

describe("HoverCard", () => {
  test("exposes the specified open and close delays", () => {
    expect(OPEN_MS).toBe(180);
    expect(CLOSE_MS).toBe(150);
  });

  test("renders a focusable trigger and no panel until opened", () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(r.queryByRole("dialog")).toBeNull();
  });

  test("does not add a second tab stop when the trigger is interactive", () => {
    const r = render(<Fixture focusable={false} interactiveTrigger />);
    expect(wrapperOf(r.container).getAttribute("tabindex")).toBe("-1");
    expect(r.getByRole("button", { name: "triage-scan" })).toBeTruthy();
  });

  test("puts popup ARIA on an interactive trigger, not the roleless wrapper", async () => {
    const r = render(
      <Fixture focusable={false} interactiveTrigger secondAction />,
    );
    const button = r.getByRole("button", { name: "triage-scan" });
    const wrapper = wrapperOf(r.container);

    expect(wrapper.hasAttribute("aria-haspopup")).toBe(false);
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);

    fireEvent.focus(button);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(r.getByRole("dialog").id);

    fireEvent.keyDown(button, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        r.getByRole("button", { name: /Open in Agents/ }),
      ),
    );

    const last = r.getByRole("button", { name: "Copy id" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
  });

  test("opens on focus and marks the trigger expanded", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    const r = render(<Fixture onOpenChange={onOpenChange} />);
    const trigger = triggerOf(r.container);

    fireEvent.focus(trigger);

    await waitFor(() => {
      const panel = r.getByRole("dialog");
      expect(panel.getAttribute("aria-label")).toBe("Agent triage-scan");
      expect(r.getByText("card body")).toBeTruthy();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(
      r.getByRole("dialog").id,
    );
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  test("opening a second card closes a first card held open by focus", async () => {
    const r = render(
      <>
        <HoverCard
          label="Agent A"
          openDelayMs={0}
          closeDelayMs={0}
          trigger="agent-a"
        >
          <span>first card</span>
        </HoverCard>
        <HoverCard
          label="Agent B"
          openDelayMs={0}
          closeDelayMs={0}
          trigger="agent-b"
        >
          <span>second card</span>
        </HoverCard>
      </>,
    );
    const triggers = r.container.querySelectorAll<HTMLElement>(
      "[aria-haspopup='dialog']",
    );

    await act(async () => triggers[0].focus());
    await waitFor(() =>
      expect(r.getByRole("dialog", { name: "Agent A" })).toBeTruthy(),
    );
    expect(document.activeElement).toBe(triggers[0]);

    fireEvent.mouseEnter(triggers[1]);

    await waitFor(() => {
      const dialogs = r.getAllByRole("dialog");
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0].getAttribute("aria-label")).toBe("Agent B");
    });
  });

  test("opens on hover and closes when the pointer leaves", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);

    fireEvent.mouseEnter(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    fireEvent.mouseLeave(trigger);
    // The close is deferred by a timer, so the state update lands outside the
    // event handler; drain it inside `act` rather than polling for it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(r.queryByRole("dialog")).toBeNull();
  });

  test("stays open while the pointer is over the panel", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);

    fireEvent.mouseEnter(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(r.getByRole("dialog"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(r.queryByRole("dialog")).toBeTruthy();
  });

  test("Enter on the trigger opens the card", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);

    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
  });

  test("Enter on an interactive trigger child does not open the card", async () => {
    const r = render(<Fixture focusable={false} interactiveTrigger />);

    fireEvent.keyDown(r.getByRole("button", { name: "triage-scan" }), {
      key: "Enter",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(r.queryByRole("dialog")).toBeNull();
  });

  test("ArrowDown opens the card and moves focus into it", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    await waitFor(() => {
      expect(r.getByRole("dialog")).toBeTruthy();
      expect(document.activeElement).toBe(
        r.getByRole("button", { name: /Open in Agents/ }),
      );
    });
  });

  test("ArrowDown on an already-open trigger re-enters the first tabbable stop", async () => {
    const r = render(<Fixture secondAction />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    await waitFor(() => {
      expect(r.getByRole("dialog")).toBeTruthy();
      expect(document.activeElement).toBe(
        r.getByRole("button", { name: /Open in Agents/ }),
      );
    });

    const last = r.getByRole("button", { name: "Copy id" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(document.activeElement).toBe(
      r.getByRole("button", { name: /Open in Agents/ }),
    );
  });

  test("ArrowDown on an inner trigger button does not reach a window list-keys listener", async () => {
    const listKeys = mock((_e: KeyboardEvent) => {});
    window.addEventListener("keydown", listKeys);
    try {
      const r = render(<Fixture focusable={false} interactiveTrigger />);
      const inner = r.getByRole("button", { name: "triage-scan" });
      inner.focus();

      fireEvent.keyDown(inner, { key: "ArrowDown" });

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(listKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listKeys);
    }
  });

  test("ArrowDown and ArrowUp inside the open panel do not reach a window list-keys listener", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const action = await waitFor(() =>
      r.getByRole("button", { name: /Open in Agents/ }),
    );
    expect(document.activeElement).toBe(action);

    // Registered only once the card is open, so a leak from the panel cannot be
    // mistaken for the trigger-side one the previous test already covers.
    const listKeys = mock((_e: KeyboardEvent) => {});
    window.addEventListener("keydown", listKeys);
    try {
      expect(fireEvent.keyDown(action, { key: "ArrowDown" })).toBe(true);
      expect(fireEvent.keyDown(action, { key: "ArrowUp" })).toBe(true);
      expect(listKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listKeys);
    }
  });

  test("j, o and a inside the open panel do not reach a window list-keys listener", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const action = await waitFor(() =>
      r.getByRole("button", { name: /Open in Agents/ }),
    );
    expect(document.activeElement).toBe(action);

    const listKeys = mock((_e: KeyboardEvent) => {});
    window.addEventListener("keydown", listKeys);
    try {
      fireEvent.keyDown(action, { key: "j" });
      fireEvent.keyDown(action, { key: "o" });
      fireEvent.keyDown(action, { key: "a" });
      expect(listKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listKeys);
    }
  });

  test("Enter and Space on an in-panel control keep their default activation", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const action = await waitFor(() =>
      r.getByRole("button", { name: /Open in Agents/ }),
    );
    expect(document.activeElement).toBe(action);

    expect(fireEvent.keyDown(action, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(action, { key: " " })).toBe(true);
  });

  test("Escape closes the card and restores focus to the trigger", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape from inside the panel returns focus to the trigger", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    const action = r.getByRole("button", { name: /Open in Agents/ });
    action.focus();
    fireEvent.keyDown(action, { key: "Escape" });

    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  test("Escape from inside the card does not also reach an enclosing layer", async () => {
    const outer = mock((_e: KeyboardEvent) => {});
    window.addEventListener("keydown", outer);
    try {
      const r = render(<Fixture />);
      const trigger = triggerOf(r.container);
      trigger.focus();
      fireEvent.focus(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      fireEvent.keyDown(trigger, { key: "Escape" });

      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
      expect(outer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  test("Escape with focus elsewhere closes the card but lets the key through", async () => {
    const outer = mock((_e: KeyboardEvent) => {});
    window.addEventListener("keydown", outer);
    try {
      const r = render(<Fixture />);
      fireEvent.mouseEnter(triggerOf(r.container));
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      fireEvent.keyDown(document.body, { key: "Escape" });

      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
      expect(outer).toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  test("a scroll in a surrounding container dismisses the card", async () => {
    const r = render(
      <div data-testid="table-scroll">
        <Fixture />
      </div>,
    );
    const trigger = triggerOf(r.container);

    fireEvent.mouseEnter(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    fireEvent.scroll(r.getByTestId("table-scroll"));

    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
  });

  test("a surrounding scroll restores focus when it was inside the panel", async () => {
    const r = render(
      <div data-testid="table-scroll">
        <Fixture />
      </div>,
    );
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => {
      expect(r.getByRole("dialog")).toBeTruthy();
      expect(document.activeElement).toBe(
        r.getByRole("button", { name: /Open in Agents/ }),
      );
    });

    fireEvent.scroll(r.getByTestId("table-scroll"));

    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  test("a scroll inside the panel does not dismiss the card", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);

    fireEvent.mouseEnter(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    fireEvent.scroll(r.getByRole("dialog"));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(r.queryByRole("dialog")).toBeTruthy();
  });

  test("an in-panel action can close the card", async () => {
    const r = render(<Fixture />);
    const trigger = triggerOf(r.container);

    fireEvent.mouseEnter(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    fireEvent.click(r.getByRole("button", { name: /Open in Agents/ }));

    await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
  });

  test("Tab from the last in-card control returns focus to the trigger", async () => {
    const r = render(<Fixture secondAction />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    const last = r.getByRole("button", { name: "Copy id" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    expect(document.activeElement).toBe(trigger);
    // Focus landing on the trigger is not focus leaving the card, so the
    // deferred close must not fire behind it; the next Tab is what dismisses it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(r.queryByRole("dialog")).toBeTruthy();
  });

  test("a hidden last control is not treated as the Tab edge", async () => {
    const r = render(<Fixture secondAction hiddenSecondAction />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    const visibleLast = r.getByRole("button", { name: /Open in Agents/ });
    visibleLast.focus();
    fireEvent.keyDown(visibleLast, { key: "Tab" });

    expect(document.activeElement).toBe(trigger);
  });

  test("an inert last control is not treated as the Tab edge", async () => {
    const r = render(
      <HoverCard
        label="Agent triage-scan"
        openDelayMs={0}
        closeDelayMs={0}
        trigger="triage-scan"
      >
        <button type="button">Visible action</button>
        <span inert>
          <button type="button">Inert action</button>
        </span>
      </HoverCard>,
    );
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    const visibleLast = r.getByRole("button", { name: "Visible action" });
    visibleLast.focus();
    fireEvent.keyDown(visibleLast, { key: "Tab" });

    expect(document.activeElement).toBe(trigger);
  });

  test("ArrowDown skips hidden controls and follows positive tabindex order", async () => {
    const r = render(
      <HoverCard
        label="Agent triage-scan"
        openDelayMs={0}
        closeDelayMs={0}
        trigger="triage-scan"
      >
        <button type="button" hidden tabIndex={1}>
          Hidden first
        </button>
        <button type="button" tabIndex={2}>
          DOM first
        </button>
        <button type="button" tabIndex={1}>
          Tab first
        </button>
      </HoverCard>,
    );
    const trigger = triggerOf(r.container);
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    await waitFor(() =>
      expect(document.activeElement).toBe(
        r.getByRole("button", { name: "Tab first" }),
      ),
    );
  });

  test("Shift+Tab from the first in-card control returns focus to the trigger", async () => {
    const r = render(<Fixture secondAction />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    const first = r.getByRole("button", { name: /Open in Agents/ });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(trigger);
  });

  test("Tab between two in-card controls is left to the browser", async () => {
    const r = render(<Fixture secondAction />);
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.focus(trigger);
    await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

    const first = r.getByRole("button", { name: /Open in Agents/ });
    first.focus();
    const event = createEvent.keyDown(first, { key: "Tab" });
    fireEvent(first, event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  test("Tab from a card with no controls returns focus to the trigger", async () => {
    const r = render(
      <HoverCard
        label="Agent triage-scan"
        openDelayMs={0}
        closeDelayMs={0}
        trigger="triage-scan"
      >
        <span>card body</span>
      </HoverCard>,
    );
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const panel = await waitFor(() => r.getByRole("dialog"));
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(panel, { key: "Tab" });

    expect(document.activeElement).toBe(trigger);
  });

  test("Shift+Tab from a card with no controls returns focus to the trigger", async () => {
    const r = render(
      <HoverCard
        label="Agent triage-scan"
        openDelayMs={0}
        closeDelayMs={0}
        trigger="triage-scan"
      >
        <span>card body</span>
      </HoverCard>,
    );
    const trigger = triggerOf(r.container);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const panel = await waitFor(() => r.getByRole("dialog"));
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(trigger);
  });

  test("Tab from a nested portal does not return focus to the trigger", async () => {
    const portalHost = document.createElement("div");
    document.body.appendChild(portalHost);
    try {
      const r = render(
        <HoverCard
          label="Agent triage-scan"
          openDelayMs={0}
          closeDelayMs={0}
          trigger="triage-scan"
        >
          {createPortal(
            <button type="button">Portal action</button>,
            portalHost,
          )}
        </HoverCard>,
      );
      const trigger = triggerOf(r.container);
      trigger.focus();
      fireEvent.focus(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      const portalAction = r.getByRole("button", { name: "Portal action" });
      portalAction.focus();
      const event = createEvent.keyDown(portalAction, { key: "Tab" });
      fireEvent(portalAction, event);

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(portalAction);
    } finally {
      portalHost.remove();
    }
  });

  test("drops the entry animation when reduced motion is preferred", async () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);

    const r = render(<Fixture />);
    fireEvent.mouseEnter(triggerOf(r.container));

    await waitFor(() => {
      const panel = r.getByRole("dialog");
      expect(panel.className).not.toContain("animate-in");
      expect(panel.className).not.toContain("transition-opacity");
    });
  });

  test("animates by default when motion is not restricted", async () => {
    stubReducedMotion(false);
    const r = render(<Fixture />);
    fireEvent.mouseEnter(triggerOf(r.container));

    await waitFor(() =>
      expect(r.getByRole("dialog").className).toContain("animate-in"),
    );
  });
});

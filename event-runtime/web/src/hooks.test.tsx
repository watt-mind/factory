import "./test-dom";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { CONTEXT_TABS_ATTR, useNow, useTabKeys } from "./hooks";

const VIEW_TABS = ["queued", "running"] as const;

function StatusAndStrip() {
  const [tab, setTab] = useState<(typeof VIEW_TABS)[number]>("queued");
  useTabKeys(VIEW_TABS, tab, setTab);
  return (
    <>
      <div role="tablist" aria-label="Context" {...{ [CONTEXT_TABS_ATTR]: "" }}>
        <button type="button" role="tab" aria-selected={true}>
          All
        </button>
      </div>
      <div role="tablist" aria-label="View status">
        {VIEW_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}>
            {t}
          </button>
        ))}
      </div>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("useTabKeys", () => {
  test("] scrolls the view status tab, not the context strip", () => {
    const scrolled: HTMLElement[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };

    try {
      const r = render(<StatusAndStrip />);
      scrolled.length = 0;

      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "]", bubbles: true }),
        );
      });

      expect(scrolled.length).toBeGreaterThan(0);
      expect(
        scrolled.every((el) => !el.closest(`[${CONTEXT_TABS_ATTR}]`)),
      ).toBe(true);
      const viewTab = r.getByRole("tab", { name: "running" });
      expect(viewTab.getAttribute("aria-selected")).toBe("true");
      expect(scrolled).toContain(viewTab);
      expect(scrolled).not.toContain(r.getByRole("tab", { name: "All" }));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

function NowProbe() {
  return <output data-testid="now">{useNow()}</output>;
}

describe("useNow", () => {
  test("shares one ticker across consumers", () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(globalThis, "setInterval");

    try {
      render(
        <>
          <NowProbe />
          <NowProbe />
          <NowProbe />
        </>,
      );

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  test("pauses while hidden and ticks immediately when visible again", () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    const originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));

    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      const r = render(<NowProbe />);
      const beforeHidden = r.getByTestId("now").textContent;

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      act(() => jest.advanceTimersByTime(1_000));
      expect(r.getByTestId("now").textContent).toBe(beforeHidden);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(r.getByTestId("now").textContent).not.toBe(beforeHidden);
    } finally {
      cleanup();
      if (originalHidden)
        Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      jest.useRealTimers();
    }
  });
});

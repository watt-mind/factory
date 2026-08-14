import "../test-dom";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Countdown, notify, ToastContainer } from "./ui";

function stackOf(r: ReturnType<typeof render>): HTMLElement {
  const parent = r.getByRole("status").parentElement;
  if (!parent) throw new Error("ToastContainer stack is missing");
  return parent;
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  // activeToasts in ui.tsx is module-scoped with no exported reset. Drain the
  // 3s dismiss timeouts so leftover toasts cannot leak into the next test.
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  cleanup();
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
    expect(r.queryByRole("button", { name: /Operation succeeded/i })).toBeNull();
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
    const r = render(<Countdown createdAt={createdAt} ttlSeconds={ttlSeconds} />);

    const el = r.container.querySelector("span");
    if (!el) throw new Error("Countdown span is missing");
    expect(el.textContent).toBe("15:14 left");
    expect(el.getAttribute("title")).toBe(new Date(now.getTime() + ttlSeconds * 1000).toISOString());
  });

  test("counts down as time passes, without losing the 'left' qualifier", () => {
    const created = new Date("2024-01-01T00:00:00Z");
    jest.setSystemTime(new Date(created.getTime() + 60_000));
    const r = render(<Countdown createdAt={created.toISOString()} ttlSeconds={15 * 60 + 14} />);

    const el = r.container.querySelector("span");
    if (!el) throw new Error("Countdown span is missing");
    expect(el.textContent).toBe("14:14 left");
  });

  test("shows relative age instead of a bare 'expired' once the TTL has elapsed", () => {
    const now = new Date("2024-01-01T00:00:00Z");
    jest.setSystemTime(now);
    const ttlSeconds = 60;
    const createdAt = new Date(now.getTime() - (ttlSeconds * 1000 + 2 * 3600 * 1000)).toISOString();
    const r = render(<Countdown createdAt={createdAt} ttlSeconds={ttlSeconds} />);

    const el = r.container.querySelector("span");
    if (!el) throw new Error("Countdown span is missing");
    expect(el.textContent).toBe("expired 2h ago");
    expect(el.getAttribute("title")).toBe(new Date(new Date(createdAt).getTime() + ttlSeconds * 1000).toISOString());
  });
});

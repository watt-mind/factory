import "../test-dom";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Button, Countdown, DetailPane, notify, shortId, ToastContainer } from "./ui";

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

describe("shortId (WM-96)", () => {
  test("shortens a prefixed UUID id to the prefix plus the first 8 body characters", () => {
    expect(shortId("run_ec9c87f9-4c1d-4f4a-9d7e-2c2f3a1b0c9d")).toBe("run_ec9c87f9");
    expect(shortId("worker_0f3b2a1c-9e8d-4b7a-8c6d-5e4f3a2b1c0d")).toBe("worker_0f3b2a1c");
  });

  test("returns ids whose body is already 8 characters or fewer unchanged", () => {
    expect(shortId("run_failed_1")).toBe("run_failed_1");
    expect(shortId("run_a")).toBe("run_a");
  });

  test("returns ids without a prefix unchanged", () => {
    expect(shortId("plainid-with-no-underscore")).toBe("plainid-with-no-underscore");
    expect(shortId("")).toBe("");
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
      <DetailPane widthClass="w-[440px]" title="t" actions={<Button onClick={() => {}}>Copy id</Button>}>
        <div>body</div>
      </DetailPane>,
    );
    expect(r.queryByText("Close")).toBeNull();
  });
});

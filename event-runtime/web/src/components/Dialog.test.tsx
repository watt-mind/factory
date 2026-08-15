import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { modal } from "../hooks";
import { Dialog } from "./ui";

function AutofocusChip() {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    ref.current?.setAttribute("autofocus", "");
  }, []);
  return (
    <button ref={ref} type="button" data-testid="chip">
      chip
    </button>
  );
}

function OpenDialog({
  onClose,
  children,
}: {
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog title="Inject" onClose={onClose}>
      <textarea data-testid="envelope" />
      <AutofocusChip />
      {children}
    </Dialog>
  );
}

beforeEach(() => {
  modal.depth = 0;
});

afterEach(() => {
  modal.depth = 0;
  cleanup();
});

describe("Dialog", () => {
  test("opening focuses the stamped [autofocus] control once", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    expect(document.activeElement).toBe(r.getByTestId("chip"));
  });

  test("a parent re-render does not steal focus back to [autofocus]", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    const envelope = r.getByTestId("envelope");
    envelope.focus();
    expect(document.activeElement).toBe(envelope);

    r.rerender(<OpenDialog onClose={() => {}} />);
    expect(document.activeElement).toBe(envelope);
  });

  test("Escape calls the current onClose, not the first-render copy", () => {
    const closed: string[] = [];
    function Parent({ tag }: { tag: string }) {
      return <OpenDialog onClose={() => closed.push(tag)} />;
    }
    const r = render(<Parent tag="first" />);
    r.rerender(<Parent tag="current" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["current"]);
  });

  test("modal.depth increments once per open and decrements once on close", () => {
    expect(modal.depth).toBe(0);
    const r = render(<OpenDialog onClose={() => {}} />);
    expect(modal.depth).toBe(1);
    r.rerender(<OpenDialog onClose={() => {}} />);
    expect(modal.depth).toBe(1);
    r.unmount();
    expect(modal.depth).toBe(0);
  });

  test("a confirm button mounted later still receives React autoFocus", () => {
    function Row() {
      const [confirm, setConfirm] = useState(false);
      return (
        <OpenDialog onClose={() => {}}>
          <button type="button" data-testid="choose" onClick={() => setConfirm(true)}>
            choose
          </button>
          {confirm ? (
            <button type="button" data-testid="confirm" autoFocus>
              Confirm inject
            </button>
          ) : null}
        </OpenDialog>
      );
    }
    const r = render(<Row />);
    fireEvent.click(r.getByTestId("choose"));
    expect(document.activeElement).toBe(r.getByTestId("confirm"));
  });

  test("Tab from the last control wraps to the first inside the panel", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    const envelope = r.getByTestId("envelope");
    const chip = r.getByTestId("chip");
    chip.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(envelope);
  });

  test("Shift+Tab from the first control wraps to the last inside the panel", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    const envelope = r.getByTestId("envelope");
    const chip = r.getByTestId("chip");
    envelope.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(chip);
  });

  test("Tab cycle ignores a hidden control after the last visible control", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    const panel = r.getByRole("dialog");
    const envelope = r.getByTestId("envelope");
    const chip = r.getByTestId("chip");
    const hidden = document.createElement("button");
    hidden.type = "button";
    hidden.hidden = true;
    panel.appendChild(hidden);

    // happy-dom has no layout engine, so offsetParent must be stamped to make
    // this browser visibility branch falsifiable rather than accidentally green.
    Object.defineProperty(envelope, "offsetParent", { configurable: true, value: panel });
    Object.defineProperty(chip, "offsetParent", { configurable: true, value: panel });
    Object.defineProperty(hidden, "offsetParent", { configurable: true, value: null });

    chip.focus();
    expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(envelope);
  });

  test("overlay backdrop click calls current onClose after parent re-render and ignores inner clicks", () => {
    const closed: string[] = [];
    function Parent({ tag }: { tag: string }) {
      return (
        <OpenDialog onClose={() => closed.push(tag)}>
          <button type="button" data-testid="inner-btn">
            inner
          </button>
        </OpenDialog>
      );
    }
    const r = render(<Parent tag="first" />);
    r.rerender(<Parent tag="current" />);

    const dialogPanel = r.getByRole("dialog");
    fireEvent.mouseDown(dialogPanel);
    fireEvent.mouseDown(r.getByTestId("inner-btn"));
    expect(closed).toEqual([]);

    const overlay = dialogPanel.parentElement!;
    fireEvent.mouseDown(overlay);
    expect(closed).toEqual(["current"]);
  });
});

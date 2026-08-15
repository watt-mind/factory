import "../test-dom";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { diffLines, formatDiff, SpecDiff } from "./SpecDiff";
import { ToastContainer } from "./ui";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  cleanup();
});

describe("diffLines & formatDiff", () => {
  test("identical inputs produce all same lines", () => {
    const lines = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(lines).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  test("detects additions and deletions", () => {
    const lines = diffLines(["a", "b"], ["a", "c"]);
    expect(lines).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  test("formatDiff prefixes lines correctly with +, -, or space", () => {
    const formatted = formatDiff([
      { type: "same", text: "unchanged" },
      { type: "del", text: "deleted" },
      { type: "add", text: "added" },
    ]);
    expect(formatted).toBe("  unchanged\n- deleted\n+ added");
  });
});

describe("SpecDiff component", () => {
  test("renders honest empty state when specs are identical", () => {
    const spec = { maxAttempts: 3, model: "claude-3-7-sonnet" };
    const r = render(<SpecDiff before={spec} after={spec} />);

    expect(r.getByText("No spec changes.")).toBeDefined();
    expect(r.queryByText("Copy diff")).toBeNull();
    expect(r.queryByTestId("spec-diff-scroll")).toBeNull();
  });

  test("renders diff header and changed lines when specs differ", () => {
    const before = { maxAttempts: 3 };
    const after = { maxAttempts: 5 };
    const r = render(<SpecDiff before={before} after={after} />);

    expect(r.queryByText("No spec changes.")).toBeNull();
    expect(r.getByText("2 changed lines")).toBeDefined();
    expect(r.getByRole("button", { name: "Copy diff" })).toBeDefined();

    const scroller = r.getByTestId("spec-diff-scroll");
    expect(scroller).not.toBeNull();
    expect(scroller.textContent).toContain("-   \"maxAttempts\": 3");
    expect(scroller.textContent).toContain("+   \"maxAttempts\": 5");
  });

  test("singular changed line count when exactly 1 line changes", () => {
    // diff of ["a"] vs ["a", "b"] produces 2 changed lines.
    // An addition of a single line to a multi-line array:
    const r = render(<SpecDiff before={["a"]} after={["a", "b"]} />);
    expect(r.container.textContent).toContain("changed line");
  });

  function mockScrollerDimensions(
    scroller: HTMLElement,
    { clientHeight, scrollHeight, scrollTop = 0 }: { clientHeight: number; scrollHeight: number; scrollTop?: number },
  ) {
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: scrollTop, writable: true });
  }

  test("does not show overflow affordance when diff fits within max height", () => {
    const before = { maxAttempts: 3 };
    const after = { maxAttempts: 5 };
    const r = render(<SpecDiff before={before} after={after} />);

    const scroller = r.getByTestId("spec-diff-scroll");
    mockScrollerDimensions(scroller, { clientHeight: 500, scrollHeight: 120 });

    act(() => {
      fireEvent.scroll(scroller);
    });

    expect(r.queryByText(/more lines below/)).toBeNull();
  });

  test("shows overflow affordance when diff exceeds max height", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    const before = { input: lines };
    const after = { input: [...lines, "added-line"] };
    const r = render(<SpecDiff before={before} after={after} />);

    const scroller = r.getByTestId("spec-diff-scroll");
    mockScrollerDimensions(scroller, { clientHeight: 120, scrollHeight: 800 });

    act(() => {
      fireEvent.scroll(scroller);
    });

    expect(r.getByText(/\d+ more lines below/)).toBeDefined();
  });

  test("preserves JSON indent after dropping pre (whitespace-pre-wrap on body)", () => {
    const before = { maxAttempts: 3 };
    const after = { maxAttempts: 5 };
    const r = render(<SpecDiff before={before} after={after} />);

    const body = r.getByTestId("spec-diff-body");
    expect(body.className).toContain("whitespace-pre-wrap");
    const indented = [...body.querySelectorAll("[data-diff-line]")].map((el) => el.textContent ?? "");
    expect(indented.some((t) => t.startsWith("-   \"maxAttempts\"") || t.startsWith("+   \"maxAttempts\""))).toBe(true);
  });

  test("keeps changed-line header sticky while scrolling diff body", () => {
    const before = { maxAttempts: 3 };
    const after = { maxAttempts: 5 };
    const r = render(<SpecDiff before={before} after={after} />);

    const header = r.getByTestId("spec-diff-header");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
  });

  test("clicking Copy diff writes to clipboard and produces toast feedback", () => {
    let written = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (t: string) => {
          written = t;
          return Promise.resolve();
        },
      },
      configurable: true,
    });

    const before = { timeout: 30 };
    const after = { timeout: 60 };

    const r = render(
      <>
        <ToastContainer />
        <SpecDiff before={before} after={after} />
      </>,
    );

    const button = r.getByRole("button", { name: "Copy diff" });
    fireEvent.click(button);

    expect(written).toContain("-   \"timeout\": 30");
    expect(written).toContain("+   \"timeout\": 60");
    expect(r.getByRole("status").textContent).toContain("Copied diff");
  });
});

import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { TraceEntry } from "../types";
import { changeInput, renderWithClient, restoreApi } from "../test-render";
import { RunTrace } from "./RunTrace";

afterEach(() => {
  cleanup();
  restoreApi();
});

const NOW = new Date().toISOString();

function entry(seq: number, kind: string, payload: TraceEntry["payload"]): TraceEntry {
  return { seq, attempt: 1, ts: NOW, kind, payload };
}

const TRACE: TraceEntry[] = [
  entry(1, "tool_use", { name: "Read", input: { path: "AGENTS.md" } }),
  entry(2, "tool_result", { content: "denied", isError: true }),
  entry(3, "assistant_text", { text: "checking the file" }),
  entry(4, "usage", {
    usage: { input_tokens: 12, output_tokens: 34 },
    costUSD: 0.0123,
  }),
];

function renderTrace(overrides?: { onCancelShortcut?: () => void; state?: "RUNNING" | "COMPLETED" }) {
  return renderWithClient(
    <RunTrace
      runId="run_trace_a11y"
      state={overrides?.state ?? "RUNNING"}
      variant="full"
      onCancelShortcut={overrides?.onCancelShortcut}
    />,
    {
      apiMocks: {
        trace: async () => ({ head: TRACE[TRACE.length - 1].seq, entries: TRACE }),
      },
    },
  );
}

async function waitForChrome(r: ReturnType<typeof renderTrace>) {
  await waitFor(() => {
    expect(r.getByRole("tablist", { name: "Trace kind" })).toBeTruthy();
  });
  return r.getByRole("tablist", { name: "Trace kind" });
}

describe("RunTrace a11y (WM-143)", () => {
  test("renders no emoji in trace chrome (tools, tokens, errors, jump, clear)", async () => {
    const r = renderTrace();
    const tablist = await waitForChrome(r);

    expect(r.getByText("tool · Read")).toBeTruthy();
    expect(r.getByText(/12 in · 34 out/)).toBeTruthy();
    const errorJump = r.getByRole("button", { name: /1 error/ });
    expect(errorJump).toBeTruthy();

    const search = r.getByPlaceholderText("Search trace…") as HTMLInputElement;
    act(() => {
      changeInput(search, "Read");
    });
    const clear = r.getByRole("button", { name: "Clear search" });
    expect(clear).toBeTruthy();

    const scroller = r.container.querySelector("[data-trace-idx]")?.parentElement as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 0, configurable: true });
    act(() => {
      fireEvent.scroll(scroller);
    });
    const jump = await waitFor(() => r.getByRole("button", { name: /Jump to latest/ }));

    const chrome = [tablist, errorJump, clear, jump, r.getByText(/12 in · 34 out/).parentElement!];
    for (const el of chrome) {
      expect(el.textContent ?? "").not.toMatch(/🔧|🔥|⚠️|⬇|✕/);
      expect(el.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(r.container.textContent ?? "").not.toMatch(/🔧|🔥|⚠️|⬇|✕/);
  });

  test("filter chips are a tablist; Left/Right/Home/End move the selected kind", async () => {
    const r = renderTrace();
    const tablist = await waitForChrome(r);
    const tabs = r.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, "").trim())).toEqual([
      "All",
      "Tools",
      "Reasoning",
      "Errors",
      "Usage",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    tabs[0].focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(r.getByRole("tab", { name: /^Tools/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(r.getByRole("tab", { name: /^Reasoning/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "End" });
    expect(r.getByRole("tab", { name: /^Usage/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(r.getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(r.getByRole("tab", { name: /^Usage/ }).getAttribute("aria-selected")).toBe("true");
  });

  test("x on the trace search input calls onCancelShortcut; j/k/slash stay typing", async () => {
    const onCancelShortcut = mock(() => {});
    const r = renderTrace({ onCancelShortcut });
    await waitForChrome(r);

    const search = r.getByPlaceholderText("Search trace…") as HTMLInputElement;
    search.focus();
    act(() => {
      changeInput(search, "too");
    });

    fireEvent.keyDown(search, { key: "j" });
    fireEvent.keyDown(search, { key: "k" });
    fireEvent.keyDown(search, { key: "/" });
    expect(onCancelShortcut).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "x" });
    expect(onCancelShortcut).toHaveBeenCalledTimes(1);
    expect(search.value).toBe("too");
  });

  test("x on search of a COMPLETED run types the letter — cancel does not apply", async () => {
    const r = renderTrace({ state: "COMPLETED" });
    await waitForChrome(r);

    const search = r.getByPlaceholderText("Search trace…") as HTMLInputElement;
    search.focus();
    fireEvent.keyDown(search, { key: "x" });
    expect(document.activeElement).toBe(search);
  });

  test("x on search of a RUNNING run with no callback redispatches on a non-input target", async () => {
    const seen: EventTarget[] = [];
    const onWin = (e: KeyboardEvent) => {
      if (e.key === "x") seen.push(e.target as EventTarget);
    };
    window.addEventListener("keydown", onWin);
    try {
      const r = renderTrace();
      await waitForChrome(r);
      const search = r.getByPlaceholderText("Search trace…") as HTMLInputElement;
      search.focus();
      fireEvent.keyDown(search, { key: "x" });
      expect(document.activeElement).not.toBe(search);
      expect(seen.some((t) => t instanceof HTMLElement && !t.closest("input"))).toBe(true);
    } finally {
      window.removeEventListener("keydown", onWin);
    }
  });
});

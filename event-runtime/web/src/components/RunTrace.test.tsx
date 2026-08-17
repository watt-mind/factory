import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { RunState, TraceEntry } from "../types";
import { changeInput, renderWithClient, restoreApi } from "../test-render";
import { formatErrorRowLabel, LIVE_STATES, RunTrace } from "./RunTrace";

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

function renderTrace(overrides?: { state?: RunState }) {
  return renderWithClient(
    <RunTrace
      runId="run_trace_a11y"
      state={overrides?.state ?? "RUNNING"}
      variant="full"
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

describe("RunTrace feed", () => {
  test("resets accumulated entries and cursor when runId changes (WM-245)", async () => {
    const requests: Array<{ runId: string; since: number }> = [];
    const firstRunEntry = entry(41, "assistant_text", { text: "first run trace" });
    const secondRunEntry = entry(1, "assistant_text", { text: "second run trace" });
    const r = renderWithClient(
      <RunTrace runId="run_first" state="COMPLETED" variant="full" />,
      {
        apiMocks: {
          trace: async (runId, since = 0) => {
            requests.push({ runId, since });
            const entries = runId === "run_first" ? [firstRunEntry] : [secondRunEntry];
            return { head: entries[0].seq, entries };
          },
        },
      },
    );

    await waitFor(() => expect(r.getByText("first run trace")).toBeTruthy());

    r.rerender(<RunTrace runId="run_second" state="COMPLETED" variant="full" />);

    await waitFor(() => expect(r.getByText("second run trace")).toBeTruthy());
    expect(r.queryByText("first run trace")).toBeNull();
    expect(requests.filter((request) => request.runId === "run_second")).toEqual([
      { runId: "run_second", since: 0 },
    ]);
  });
});

describe("RunTrace error context (WM-588)", () => {
  test("formats the tool name and a truncated first error line", () => {
    const firstLine = "x".repeat(120);
    const formatted = formatErrorRowLabel("bash", `${firstLine}\nsecond line`);

    expect(formatted.label.startsWith("bash · ")).toBe(true);
    expect(formatted.label.endsWith("…")).toBe(true);
    expect(formatted.label).not.toContain("second line");
    expect(formatted.title).toBe(`bash · ${firstLine}`);
  });

  test("error rows retain their originating call input in the Errors tab", async () => {
    const ts = "2026-08-17T15:26:37Z";
    const contextualTrace: TraceEntry[] = [
      { ...entry(1, "tool_use", { id: "call_bash", name: "bash", input: { command: "bun test missing.test.ts" } }), ts },
      { ...entry(2, "tool_result", { toolUseId: "call_bash", content: "Command exited with code 2\nfull stderr", isError: true }), ts },
    ];
    const r = renderWithClient(
      <RunTrace runId="run_error_context" state="COMPLETED" variant="full" />,
      {
        apiMocks: {
          trace: async () => ({ head: 2, entries: contextualTrace }),
        },
      },
    );
    await waitForChrome(r);

    fireEvent.click(r.getByRole("tab", { name: /^Errors/ }));
    const label = r.getByText("bash · Command exited with code 2");
    expect(label.getAttribute("title")).toBe("bash · Command exited with code 2");
    const timestamp = r.getByTitle(ts);
    expect(timestamp.textContent).toContain("15:26:37");

    const summary = label.closest("summary")!;
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(await r.findByText("Originating call · bash")).toBeTruthy();
    expect(r.getByText(/bun test missing\.test\.ts/)).toBeTruthy();
  });
});

describe("RunTrace timing (WM-272)", () => {
  test("filtered views use the next unfiltered entry for duration", async () => {
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const timedTrace: TraceEntry[] = [
      { ...entry(1, "tool_use", { name: "Read" }), ts: new Date(start).toISOString() },
      { ...entry(2, "assistant_text", { text: "hidden by the tools filter" }), ts: new Date(start + 200).toISOString() },
      { ...entry(3, "tool_use", { name: "Write" }), ts: new Date(start + 50_000).toISOString() },
      { ...entry(4, "tool_result", { content: "done" }), ts: new Date(start + 50_300).toISOString() },
    ];
    const r = renderWithClient(
      <RunTrace runId="run_trace_timing" state="COMPLETED" variant="full" />,
      {
        apiMocks: {
          trace: async () => ({ head: timedTrace[timedTrace.length - 1].seq, entries: timedTrace }),
        },
      },
    );
    await waitForChrome(r);

    fireEvent.click(r.getByRole("tab", { name: /^Tools/ }));

    expect(await r.findByText("200ms")).toBeTruthy();
    expect(r.queryByText("50.0s")).toBeNull();
  });
});

describe("RunTrace a11y (WM-143)", () => {
  test("locks live trace behavior across every RunState (WM-174)", () => {
    const expectedLiveness: Record<RunState, boolean> = {
      PROPOSED: false,
      APPROVED: false,
      QUEUED: false,
      LEASED: true,
      RUNNING: true,
      VERIFYING: true,
      COMPLETED: false,
      REFUSED: false,
      FAILED: false,
      TIMED_OUT: false,
      CANCELLED: false,
    };

    for (const state of Object.keys(expectedLiveness) as RunState[]) {
      expect(LIVE_STATES.includes(state)).toBe(expectedLiveness[state]);
    }
  });

  test("renders no emoji in trace chrome (tools, tokens, errors, jump, clear)", async () => {
    const r = renderTrace();
    const tablist = await waitForChrome(r);

    expect(r.getByText("tool · Read")).toBeTruthy();
    expect(r.getByText(/12 in · 34 out/)).toBeTruthy();
    const errorJump = r.getByRole("button", { name: /next error/ });
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

  test.each(["LEASED", "RUNNING", "VERIFYING"] as const)(
    "typing words with x in search input does not trigger cancellation or blur while %s (WM-267, WM-174)",
    async (state) => {
      let cancelKeyDownDispatchedToBody = false;
      const bodyListener = (e: KeyboardEvent) => {
        if (e.key === "x" && e.target === document.body) {
          cancelKeyDownDispatchedToBody = true;
        }
      };
      document.body.addEventListener("keydown", bodyListener);

      try {
        const r = renderTrace({ state });
        await waitForChrome(r);

        const search = r.getByPlaceholderText("Search trace…") as HTMLInputElement;
        search.focus();
        expect(document.activeElement).toBe(search);

        // Type words containing 'x' (exec, regex, context)
        act(() => {
          changeInput(search, "exec");
        });
        expect(search.value).toBe("exec");

        // Press 'x' key directly while search input is focused
        fireEvent.keyDown(search, { key: "x" });

        // Search input must remain focused (not blurred)
        expect(document.activeElement).toBe(search);
        // No synthetic x event redispatched to document.body
        expect(cancelKeyDownDispatchedToBody).toBe(false);

        // Typing more words containing 'x'
        act(() => {
          changeInput(search, "regex context");
        });
        expect(search.value).toBe("regex context");
        fireEvent.keyDown(search, { key: "x" });
        expect(document.activeElement).toBe(search);
        expect(cancelKeyDownDispatchedToBody).toBe(false);
      } finally {
        document.body.removeEventListener("keydown", bodyListener);
      }
    },
  );

  test("single-key shortcuts 1-5 and [ / ] switch filter tabs (WM-217)", async () => {
    const r = renderTrace();
    await waitForChrome(r);

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^Tools/ }).getAttribute("aria-selected")).toBe("true");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^Reasoning/ }).getAttribute("aria-selected")).toBe("true");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^Errors/ }).getAttribute("aria-selected")).toBe("true");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "5", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^Usage/ }).getAttribute("aria-selected")).toBe("true");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");

    // [ and ] relative cycling
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^Tools/ }).getAttribute("aria-selected")).toBe("true");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true }));
    });
    expect(r.getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");
  });

  test("e toggles expand/collapse details and l toggles follow live (WM-217)", async () => {
    const r = renderTrace();
    await waitForChrome(r);

    const expandBtn = r.getByRole("button", { name: /Expand details/ });
    expect(expandBtn).toBeTruthy();

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });
    expect(r.getByRole("button", { name: /Collapse details/ })).toBeTruthy();

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });
    expect(r.getByRole("button", { name: /Expand details/ })).toBeTruthy();

    // l toggles follow live
    const followLiveBtn = r.getByRole("button", { name: /Follow live/ });
    expect(followLiveBtn.textContent).toContain("Follow live");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    });
    expect(r.getByRole("button", { name: /Follow live \(paused\)/ })).toBeTruthy();

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    });
    expect(r.getByRole("button", { name: /Follow live/ })).toBeTruthy();
  });

  test(". jumps to next error and G jumps to latest (WM-217)", async () => {
    const r = renderTrace();
    await waitForChrome(r);

    const errorBtn = r.getByRole("button", { name: /next error/ });
    expect(errorBtn).toBeTruthy();

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true }));
    });
    expect(r.getByText("1/1")).toBeTruthy();

    // G triggers jump to latest
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "G", bubbles: true }));
    });
    expect(r.getByRole("button", { name: /Follow live/ })).toBeTruthy();
  });

  test("search input Esc clears query, Enter/Shift+Enter cycles matches (WM-217)", async () => {
    const r = renderTrace();
    await waitForChrome(r);

    const search = r.getByPlaceholderText("Search trace…") as HTMLInputElement;
    search.focus();
    act(() => {
      changeInput(search, "Read");
    });
    expect(search.value).toBe("Read");

    // Enter cycles match
    fireEvent.keyDown(search, { key: "Enter" });
    expect(r.getByText("1/1")).toBeTruthy();

    // Esc clears search text
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");

    // Next Esc blurs
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).not.toBe(search);
  });

  test("renders subtle shortcut hints on tabs, search, buttons, and live chips (WM-217)", async () => {
    const r = renderTrace();
    await waitForChrome(r);

    // Number hints on tabs
    const tabs = r.getAllByRole("tab");
    expect(tabs[0].textContent).toContain("1");
    expect(tabs[1].textContent).toContain("2");
    expect(tabs[2].textContent).toContain("3");
    expect(tabs[3].textContent).toContain("4");
    expect(tabs[4].textContent).toContain("5");

    // / hint on search
    expect(r.getByText("/")).toBeTruthy();

    // e hint on Expand details
    expect(r.getByRole("button", { name: /Expand details/ }).textContent).toContain("e");

    // l hint on Follow live
    expect(r.getByRole("button", { name: /Follow live/ }).textContent).toContain("l");

    // . hint on Error button
    expect(r.getByRole("button", { name: /next error/ }).textContent).toContain(".");
  });
});

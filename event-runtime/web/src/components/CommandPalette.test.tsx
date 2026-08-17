import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { modal } from "../hooks";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { Dialog } from "./ui";

const ACTIONS: PaletteAction[] = [
  { label: "Overview", hint: "g g", group: "Go", run: () => {} },
  { label: "Copy id", hint: "c", run: () => {} },
];

const NOOP = () => {};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

function renderPalette(actions: PaletteAction[] = ACTIONS) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <button type="button" data-testid="outside">
        nav
      </button>
      <input data-testid="view-filter" data-view-filter />
      <CommandPalette
        actions={actions}
        onJumpRun={NOOP}
        onJumpProposal={NOOP}
        onJumpEvent={NOOP}
        onJumpAgent={NOOP}
        onJumpWorker={NOOP}
      />
    </QueryClientProvider>,
  );
}

function PaletteDialogHost() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchInterval: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <button type="button" data-testid="dialog-opener">
        nav
      </button>
      <CommandPalette
        actions={[{ label: "Keyboard shortcuts", run: () => setDialogOpen(true) }]}
        onJumpRun={NOOP}
        onJumpProposal={NOOP}
        onJumpEvent={NOOP}
        onJumpAgent={NOOP}
        onJumpWorker={NOOP}
      />
      {dialogOpen ? (
        <Dialog title="Keyboard shortcuts" onClose={() => setDialogOpen(false)}>
          <button type="button" autoFocus>
            Done
          </button>
        </Dialog>
      ) : null}
    </QueryClientProvider>
  );
}

function chordK() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

function appendExtra(dialog: HTMLElement): HTMLButtonElement {
  const extra = document.createElement("button");
  extra.type = "button";
  extra.dataset.testid = "extra";
  extra.textContent = "extra";
  dialog.appendChild(extra);
  return extra;
}

beforeEach(() => {
  modal.depth = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    jsonResponse({
      runs: [],
      proposals: [],
      events: [],
      agents: [],
      workers: [],
      repos: [],
    })) as typeof fetch;
});

afterEach(() => {
  modal.depth = 0;
  globalThis.fetch = realFetch;
  cleanup();
});

describe("CommandPalette", () => {
  test("⌘K does not open while another modal owns the stack", () => {
    const r = renderPalette();
    modal.depth = 1;
    chordK();
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
  });

  test("⌘K still closes the palette when it is already open", () => {
    const r = renderPalette();
    chordK();
    expect(r.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(modal.depth).toBe(1);
    chordK();
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
    expect(modal.depth).toBe(0);
  });

  test("⌘K keeps the palette open while another dialog is stacked above it", () => {
    const r = renderPalette();
    chordK();
    modal.depth += 1;
    chordK();
    expect(r.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(modal.depth).toBe(2);
  });

  test("opening focuses the search input", () => {
    const r = renderPalette();
    chordK();
    expect(document.activeElement).toBe(r.getByPlaceholderText("Type a command…"));
  });

  test("Tab from the last control wraps to the first inside the panel", () => {
    const r = renderPalette();
    chordK();
    const dialog = r.getByRole("dialog", { name: "Command palette" });
    const input = r.getByPlaceholderText("Type a command…");
    const extra = appendExtra(dialog);
    extra.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(input);
  });

  test("Shift+Tab from the first control wraps to the last inside the panel", () => {
    const r = renderPalette();
    chordK();
    const dialog = r.getByRole("dialog", { name: "Command palette" });
    const input = r.getByPlaceholderText("Type a command…");
    const extra = appendExtra(dialog);
    input.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(extra);
  });

  test("closing via Escape restores focus to the previously focused element", () => {
    const r = renderPalette();
    const outside = r.getByTestId("outside");
    outside.focus();
    chordK();
    expect(r.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  test("closing via backdrop restores focus to the previously focused element", () => {
    const r = renderPalette();
    const outside = r.getByTestId("outside");
    outside.focus();
    chordK();
    fireEvent.mouseDown(r.getByTestId("palette-overlay"));
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  test("selecting an item restores focus to the previously focused element", () => {
    let ran = false;
    const r = renderPalette([{ label: "Overview", group: "Go", run: () => { ran = true; } }]);
    const outside = r.getByTestId("outside");
    outside.focus();
    chordK();
    fireEvent.click(r.getByText("Overview"));
    expect(ran).toBe(true);
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  test("selecting an item that focuses another element keeps that focus", () => {
    const r = renderPalette([
      {
        label: "Focus filter",
        run: () => {
          document.querySelector<HTMLElement>("[data-view-filter]")?.focus();
        },
      },
    ]);
    r.getByTestId("outside").focus();
    chordK();
    fireEvent.click(r.getByText("Focus filter"));
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
    expect(document.activeElement).toBe(r.getByTestId("view-filter"));
  });

  test("a dialog opened by a palette action returns focus to the palette opener", () => {
    const r = render(<PaletteDialogHost />);
    const opener = r.getByTestId("dialog-opener");
    opener.focus();
    chordK();
    expect(document.activeElement).toBe(r.getByPlaceholderText("Type a command…"));

    fireEvent.click(r.getByText("Keyboard shortcuts"));
    expect(r.queryByRole("dialog", { name: "Command palette" }) == null).toBe(true);
    expect(r.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(r.queryByRole("dialog", { name: "Keyboard shortcuts" }) == null).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  test("ArrowDown visibly highlights the active row", () => {
    const r = renderPalette();
    chordK();
    const input = r.getByPlaceholderText("Type a command…");
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const activeItem = r.getByText("Copy id").closest<HTMLElement>("[cmdk-item]");
    expect(activeItem?.getAttribute("aria-selected")).toBe("true");
    const classes = activeItem?.className.split(/\s+/) ?? [];
    expect(classes).toContain("data-[selected=true]:bg-(--surface-2)");
    expect(classes).toContain("data-[selected=true]:border-l-(--accent)");
  });

  test("uses a single focus border, scroll fade, and theme-aware backdrop", () => {
    const r = renderPalette();
    chordK();
    const inputClasses = r.getByPlaceholderText("Type a command…").className.split(/\s+/);
    expect(inputClasses).toContain("border-0");
    expect(inputClasses).toContain("border-b");
    expect(inputClasses).toContain("outline-none");
    expect(inputClasses).toContain("ring-0");
    expect(inputClasses).toContain("focus:border-(--accent)");
    expect(inputClasses).toContain("focus:ring-0");

    expect(r.getByTestId("palette-results").className).toContain("overflow-y-auto");
    expect(r.getByTestId("palette-results").className).toContain("scroll-pb-10");
    expect(r.getByTestId("palette-results-fade").className).toContain("bg-linear-to-t");
    const overlayClasses = r.getByTestId("palette-overlay").className.split(/\s+/);
    expect(overlayClasses).toContain("bg-black/40");
    expect(overlayClasses).toContain("[[data-theme=light]_&]:bg-black/20");
  });
});

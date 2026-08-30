import "./test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement as h, useEffect, useState } from "react";
import { api } from "./api";
import {
  modal,
  pollingOptions,
  refetchIntervals,
  useHashRoute,
  useListKeys,
  useRequeuePoll,
  useTheme,
} from "./hooks";
import type { Proposal } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  modal.depth = 0;
  window.location.hash = "";
  localStorage.removeItem("evrt-theme");
  delete document.documentElement.dataset.theme;
  globalThis.fetch = originalFetch;
});

describe("API ETag cache", () => {
  test("sends If-None-Match and returns the same cached body on 304", async () => {
    const body = { events: [{ eventId: "evt-etag" }] };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"etag-events"',
          },
        });
      }
      return new Response(null, {
        status: 304,
        headers: { etag: '"etag-events"' },
      });
    }) as typeof fetch;

    const first = await api.events("etag-cache-test");
    const second = await api.events("etag-cache-test");

    expect(second).toBe(first);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("/api/events?status=etag-cache-test");
    expect(requests[0].init).toMatchObject({
      cache: "no-store",
      headers: { "content-type": "application/json" },
    });
    expect(requests[1].init?.headers).toEqual({
      "content-type": "application/json",
      "if-none-match": '"etag-events"',
    });
  });
});

describe("collection refetch intervals", () => {
  test("use a 15 second hidden-tab cadence and keep background polling active", () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    const customCadence = pollingOptions(30_000);
    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      expect(customCadence.refetchInterval()).toBe(30_000);
      expect(refetchIntervals.primary.refetchInterval()).toBe(2_000);
      expect(refetchIntervals.fast.refetchInterval()).toBe(5_000);
      expect(refetchIntervals.secondary.refetchInterval()).toBe(10_000);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      expect(customCadence.refetchInterval()).toBe(15_000);
      expect(refetchIntervals.primary.refetchInterval()).toBe(15_000);
      expect(refetchIntervals.fast.refetchInterval()).toBe(15_000);
      expect(refetchIntervals.secondary.refetchInterval()).toBe(15_000);
      expect(refetchIntervals.primary.refetchIntervalInBackground).toBe(true);
    } finally {
      if (originalHidden)
        Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
    }
  });

  test("refetches an active fresh query immediately when the tab becomes visible", async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    const originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    let calls = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    function Probe() {
      useQuery({
        queryKey: ["visibility-resume-test"],
        queryFn: async () => ++calls,
        ...refetchIntervals.primary,
      });
      return null;
    }

    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      render(h(QueryClientProvider, { client }, h(Probe)));
      await waitFor(() => expect(calls).toBe(1));

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      act(() => window.dispatchEvent(new Event("visibilitychange")));
      expect(calls).toBe(1);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      act(() => window.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(calls).toBe(2));
    } finally {
      client.clear();
      if (originalHidden)
        Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });
});

function ThemeProbe() {
  const [theme] = useTheme();
  return h("span", { "data-testid": "theme" }, theme);
}

type PollRequeue = ReturnType<typeof useRequeuePoll>;
let exposedPollRequeue: PollRequeue | null = null;

function RequeuePollProbe(props: {
  onJumpProposal: (proposalId: string) => void;
}) {
  const pollRequeue = useRequeuePoll(props.onJumpProposal);
  useEffect(() => {
    exposedPollRequeue = pollRequeue;
  }, [pollRequeue]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requeueProposal(id: string, eventId: string): Proposal {
  return { id, eventSource: "github", eventId } as Proposal;
}

describe("useRequeuePoll", () => {
  test("a matched task and source-view unmount do not drop a concurrent task", async () => {
    const originalProposals = api.proposals;
    const requests: ReturnType<
      typeof deferred<Awaited<ReturnType<typeof api.proposals>>>
    >[] = [];
    api.proposals = mock(() => {
      const request = deferred<Awaited<ReturnType<typeof api.proposals>>>();
      requests.push(request);
      return request.promise;
    });

    try {
      const onJumpProposal = mock((proposalId: string) => {
        if (proposalId === "prop_first") view.unmount();
      });
      const view = render(h(RequeuePollProbe, { onJumpProposal }));
      const pollRequeue = exposedPollRequeue!;

      const first = pollRequeue("github", "evt_first");
      const second = pollRequeue("github", "evt_second");
      expect(requests).toHaveLength(2);

      await act(async () => {
        requests[0]!.resolve({
          proposals: [requeueProposal("prop_first", "evt_first")],
        });
        await first;
      });
      expect(onJumpProposal).toHaveBeenCalledWith("prop_first");

      await act(async () => {
        requests[1]!.resolve({
          proposals: [requeueProposal("prop_second", "evt_second")],
        });
        await second;
      });
      expect(
        onJumpProposal.mock.calls.map(([proposalId]) => proposalId),
      ).toEqual(["prop_first", "prop_second"]);
    } finally {
      api.proposals = originalProposals;
      exposedPollRequeue = null;
    }
  });
});

/** Helper list component driving useListKeys */
function InteractiveList(props: {
  count: number;
  initialIndex?: number;
  onSelectCallback?: (index: number) => void;
  onOpenCallback?: () => void;
  onCloseCallback?: () => void;
  customKeys?: Record<string, () => void>;
}) {
  const [selected, setSelected] = useState(props.initialIndex ?? 0);
  useListKeys({
    count: props.count,
    selected,
    onSelect: (idx) => {
      setSelected(idx);
      props.onSelectCallback?.(idx);
    },
    onOpen: props.onOpenCallback,
    onClose: props.onCloseCallback,
    keys: props.customKeys,
  });

  return h(
    "ul",
    { role: "listbox", "aria-label": "Items" },
    Array.from({ length: props.count }, (_, i) =>
      h(
        "li",
        {
          key: i,
          role: "option",
          "aria-selected": selected === i,
          "data-index": i,
        },
        `Item ${i + 1}`,
      ),
    ),
  );
}

/** Component combining useListKeys with useHashRoute for realistic hash-synced navigation */
function HashSyncedList(props: { count: number; prefix: string }) {
  const [, navigate] = useHashRoute();
  const [selected, setSelected] = useState(0);

  useListKeys({
    count: props.count,
    selected,
    onSelect: (idx) => {
      setSelected(idx);
      navigate(`${props.prefix}/${props.prefix}_${idx + 1}`);
    },
  });

  return h(
    "div",
    null,
    h("div", { "data-testid": "selected-val" }, String(selected)),
    h(
      "ul",
      { role: "listbox" },
      Array.from({ length: props.count }, (_, i) =>
        h(
          "li",
          {
            key: i,
            role: "option",
            "aria-selected": selected === i,
          },
          `Row ${i + 1}`,
        ),
      ),
    ),
  );
}

describe("useTheme", () => {
  test.each(["light", "contrast"] as const)(
    "restores the valid %s theme from localStorage",
    (theme) => {
      localStorage.setItem("evrt-theme", theme);
      const r = render(h(ThemeProbe));
      expect(r.getByTestId("theme").textContent).toBe(theme);
      expect(localStorage.getItem("evrt-theme")).toBe(theme);
      expect(document.documentElement.dataset.theme).toBe(theme);
    },
  );

  test("corrupt evrt-theme in localStorage resets to dark and rewrites storage", () => {
    localStorage.setItem("evrt-theme", "foo");
    const r = render(h(ThemeProbe));
    expect(r.getByTestId("theme").textContent).toBe("dark");
    expect(localStorage.getItem("evrt-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("useListKeys unit tests — rapid j/k keydown movement", () => {
  test("holding 'j' across rapid keydown events advances selection to count - 1", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 20,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    // Simulate holding 'j' (producing 50 rapid keydown events with browser re-renders between repeats)
    for (let i = 0; i < 50; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        );
      });
    }

    const items = r.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("false");
    expect(items[19].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices[0]).toBe(1);
    expect(selectedIndices.at(-1)).toBe(19);
    // Should clamp at count - 1 (index 19)
    expect(selectedIndices.every((idx) => idx >= 0 && idx <= 19)).toBe(true);
  });

  test("holding 'k' across rapid keydown events decrements selection to 0", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 20,
        initialIndex: 19,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    // Simulate holding 'k' (producing 50 rapid keydown events with browser re-renders between repeats)
    for (let i = 0; i < 50; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", bubbles: true }),
        );
      });
    }

    const items = r.getAllByRole("option");
    expect(items[19].getAttribute("aria-selected")).toBe("false");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices[0]).toBe(18);
    expect(selectedIndices.at(-1)).toBe(0);
    // Should clamp at 0
    expect(selectedIndices.every((idx) => idx >= 0 && idx <= 19)).toBe(true);
  });

  test("holding ArrowDown and ArrowUp behaves identically to j and k", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 10,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    // Move down with ArrowDown
    for (let i = 0; i < 5; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      });
    }

    let items = r.getAllByRole("option");
    expect(items[5].getAttribute("aria-selected")).toBe("true");

    // Move up with ArrowUp
    for (let i = 0; i < 3; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
        );
      });
    }

    items = r.getAllByRole("option");
    expect(items[2].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices.at(-1)).toBe(2);
  });

  test("modifier keys (meta, ctrl, alt) ignore j/k keydowns", () => {
    const selectedIndices: number[] = [];
    const r = render(
      h(InteractiveList, {
        count: 10,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "j",
          metaKey: true,
          bubbles: true,
        }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "j",
          ctrlKey: true,
          bubbles: true,
        }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", altKey: true, bubbles: true }),
      );
    });

    const items = r.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(selectedIndices.length).toBe(0);
  });

  test("keyGuard stands down j/k navigation when typing in inputs or when modal is open", () => {
    const selectedIndices: number[] = [];
    render(
      h(InteractiveList, {
        count: 10,
        initialIndex: 0,
        onSelectCallback: (idx) => selectedIndices.push(idx),
      }),
    );

    const input = document.createElement("input");
    document.body.appendChild(input);

    // Dispatch event from input
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true }),
      );
    });
    expect(selectedIndices.length).toBe(0);

    document.body.removeChild(input);

    // Modal open
    modal.depth = 1;
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true }),
      );
    });
    expect(selectedIndices.length).toBe(0);

    modal.depth = 0;
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true }),
      );
    });
    expect(selectedIndices.length).toBe(1);
  });

  test("action keys (Enter, o, Escape, custom keys) fire correctly", () => {
    let opened = false;
    let closed = false;
    let approved = false;

    render(
      h(InteractiveList, {
        count: 5,
        initialIndex: 2,
        onOpenCallback: () => {
          opened = true;
        },
        onCloseCallback: () => {
          closed = true;
        },
        customKeys: {
          a: () => {
            approved = true;
          },
        },
      }),
    );

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    expect(opened).toBe(true);
    expect(closed).toBe(true);
    expect(approved).toBe(true);
  });
});

describe("useListKeys + routing integration — Safari rapid j/k keydown hold simulation (OPS-337, OPS-349)", () => {
  test("rapid j keydown burst smoothly moves selection across 100 rows without throwing or freezing", () => {
    const r = render(h(HashSyncedList, { count: 100, prefix: "runs" }));

    // Simulate holding 'j' in Safari: 100 rapid keydowns at ~30Hz
    expect(() => {
      for (let i = 0; i < 99; i++) {
        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "j", bubbles: true }),
          );
        });
      }
    }).not.toThrow();

    const selectedVal = r.getByTestId("selected-val");
    expect(selectedVal.textContent).toBe("99");

    const items = r.getAllByRole("option");
    expect(items[99].getAttribute("aria-selected")).toBe("true");
  });

  test("rapid k keydown burst smoothly moves selection back to top", () => {
    const r = render(h(HashSyncedList, { count: 50, prefix: "events" }));

    // First advance to bottom
    for (let i = 0; i < 49; i++) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        );
      });
    }
    expect(r.getByTestId("selected-val").textContent).toBe("49");

    // Hold 'k' back to top
    expect(() => {
      for (let i = 0; i < 49; i++) {
        act(() => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", bubbles: true }),
          );
        });
      }
    }).not.toThrow();

    expect(r.getByTestId("selected-val").textContent).toBe("0");
    const items = r.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
  });

  test("simulated history.replaceState SecurityError does not freeze selection movement", () => {
    const originalReplaceState = history.replaceState;
    // Simulate Safari history write rate-limit SecurityError
    const throwError = true;
    history.replaceState = function (...args) {
      if (throwError) {
        throw new DOMException(
          "SecurityError: Attempt to use history.replaceState() more than allowed",
          "SecurityError",
        );
      }
      return originalReplaceState.apply(this, args);
    };

    try {
      const r = render(h(HashSyncedList, { count: 30, prefix: "proposals" }));

      // Holding 'j' must continue to move selection smoothly in UI despite SecurityError
      expect(() => {
        for (let i = 0; i < 20; i++) {
          act(() => {
            document.body.dispatchEvent(
              new KeyboardEvent("keydown", { key: "j", bubbles: true }),
            );
          });
        }
      }).not.toThrow();

      expect(r.getByTestId("selected-val").textContent).toBe("20");
      const items = r.getAllByRole("option");
      expect(items[20].getAttribute("aria-selected")).toBe("true");
    } finally {
      history.replaceState = originalReplaceState;
    }
  });
});

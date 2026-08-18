import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  CausationGlyphs,
  EventHoverCard,
  chainHref,
  payloadSummary,
} from "./EventHoverCard";
import {
  createEventFixture,
  createRunListItemFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { AdmittedEvent } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
  window.location.hash = "";
});

const NOW = new Date().toISOString();

function stubEvent(overrides?: Partial<AdmittedEvent>): AdmittedEvent {
  return createEventFixture({
    source: "github",
    eventId: "evt_1001",
    type: "pull_request.opened",
    correlationId: "corr_1001",
    occurredAt: NOW,
    admittedAt: NOW,
    envelope: {
      schemaVersion: "factory.event/v1",
      eventId: "evt_1001",
      type: "pull_request.opened",
      source: "github",
      occurredAt: NOW,
      payload: {
        repo: "watt-mind/factory",
        number: 608,
        draft: false,
        labels: ["ready", "ui"],
        author: "hdkiller",
      },
    },
    ...overrides,
  });
}

/** The wrapper the primitive puts the popup ARIA state on. */
function triggerOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-haspopup='dialog']");
  if (!el) throw new Error("hover card trigger not found");
  return el;
}

describe("payloadSummary", () => {
  test("takes the leading payload keys and formats each with formatCellValue", () => {
    const { entries, total } = payloadSummary(stubEvent().envelope, 4);

    expect(total).toBe(5);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.key)).toEqual([
      "repo",
      "number",
      "draft",
      "labels",
    ]);
    // formatCellValue's own grammar: numbers bare, booleans spelled, arrays counted.
    expect(entries.map((e) => e.text)).toEqual([
      "watt-mind/factory",
      "608",
      "false",
      "[2]",
    ]);
  });

  test("falls back to the envelope's own fields when it carries no payload", () => {
    const { entries } = payloadSummary({
      schemaVersion: "factory.event/v1",
      eventId: "evt_1001",
      type: "clock.tick",
      source: "schedule",
      occurredAt: NOW,
      loop: "merge-scan",
      slot: "2026-08-18T12:00:00.000Z",
    });

    // Envelope metadata is already in the card's header; only the rest is news.
    expect(entries.map((e) => e.key)).toEqual(["loop", "slot"]);
  });

  test("is empty for an envelope that says nothing beyond its metadata", () => {
    const { entries, total } = payloadSummary({
      schemaVersion: "factory.event/v1",
      eventId: "evt_1001",
      type: "clock.tick",
      source: "schedule",
    });
    expect(entries).toHaveLength(0);
    expect(total).toBe(0);
  });
});

describe("chainHref", () => {
  test("addresses the chain, preselecting a node when one is named", () => {
    expect(chainHref("corr_1001")).toBe("#/chain/corr_1001");
    expect(chainHref("corr_1001", "event:github:evt_1001")).toBe(
      "#/chain/corr_1001/event%3Agithub%3Aevt_1001",
    );
    expect(chainHref(null)).toBeNull();
  });

  test("keeps ?project= from the current hash (WM-787)", () => {
    window.location.hash = "#/runs?project=factory";
    expect(chainHref("corr_1001")).toBe("#/chain/corr_1001?project=factory");
    expect(chainHref("corr_1001", "event:github:evt_1001")).toBe(
      "#/chain/corr_1001/event%3Agithub%3Aevt_1001?project=factory",
    );
    window.location.hash = "#/runs";
    expect(chainHref("corr_1001")).toBe("#/chain/corr_1001");
  });
});

describe("CausationGlyphs", () => {
  test("renders nothing when an event neither came from nor led to anything", () => {
    const r = renderWithClient(
      <CausationGlyphs causedBy={null} fanOut={0} href="#/chain/x" title="x" />,
    );
    expect(r.container.textContent).toBe("");
  });

  test("links both glyphs into the chain and keeps the click off the row", () => {
    const onRowClick = mock(() => {});
    const r = renderWithClient(
      <button type="button" onClick={onRowClick}>
        <CausationGlyphs
          causedBy="run_abc"
          fanOut={2}
          href="#/chain/corr_1001/run%3Arun_abc"
          title="Caused by run_abc · 2 derived"
        />
      </button>,
    );

    const link = r.getByRole("link", { name: /Caused by run_abc/ });
    expect(link.getAttribute("href")).toBe("#/chain/corr_1001/run%3Arun_abc");
    expect(link.textContent).toContain("↳");
    expect(link.textContent).toContain("→ 2");

    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("degrades to plain glyphs when the chain id is unknown", () => {
    const r = renderWithClient(
      <CausationGlyphs
        causedBy="run_abc"
        fanOut={0}
        href={null}
        title="Caused by run_abc"
      />,
    );
    expect(r.queryByRole("link")).toBeNull();
    expect(r.getByTitle("Caused by run_abc").textContent).toContain("↳");
  });
});

describe("EventHoverCard", () => {
  test("opens on hover with the event's type, status, publisher and payload", async () => {
    await withApi({ runs: async () => ({ runs: [] }) }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent()}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );

      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      const card = r.getByRole("dialog");
      expect(card.getAttribute("aria-label")).toBe("Event evt_1001");
      expect(card.textContent).toContain("pull_request.opened");
      expect(card.textContent).toContain("admitted");
      expect(card.textContent).toContain("github");
      // Top payload keys, formatted the way the table's custom columns are.
      expect(card.textContent).toContain("repo");
      expect(card.textContent).toContain("watt-mind/factory");
      expect(card.textContent).toContain("608");
      // A fifth key exists but stays behind a count rather than growing the card.
      expect(card.textContent).toContain("+1 more");
      expect(card.textContent).not.toContain("hdkiller");
    });
  });

  test("holds the causation query until the card opens, then previews the run that emitted the event", async () => {
    let calls = 0;
    const runs = async () => {
      calls += 1;
      return {
        runs: [
          createRunListItemFixture({
            runId: "run_cause_1",
            state: "COMPLETED",
            agent: "merge-scan",
          }),
        ],
      };
    };

    await withApi({ runs }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent({ causationId: "run_cause_1" })}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );

      // A mouse sweep across a table must not fire one request per row.
      expect(calls).toBe(0);

      fireEvent.mouseEnter(triggerOf(r.container));
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      await waitFor(() => {
        const card = r.getByRole("dialog");
        expect(card.textContent).toContain("merge-scan");
        expect(card.textContent).toContain("COMPLETED");
      });
      expect(calls).toBe(1);
    });
  });

  test("a second open inside the stale window reuses the cached causation", async () => {
    let calls = 0;
    const runs = async () => {
      calls += 1;
      return {
        runs: [
          createRunListItemFixture({ runId: "run_cause_1", agent: "sweep" }),
        ],
      };
    };

    await withApi({ runs }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent({ causationId: "run_cause_1" })}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );
      const trigger = triggerOf(r.container);

      fireEvent.mouseEnter(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      await waitFor(() => expect(calls).toBe(1));

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());

      fireEvent.mouseEnter(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(calls).toBe(1);
    });
  });

  test("never queries for an origin event, and says it starts the chain", async () => {
    let calls = 0;
    const runs = async () => {
      calls += 1;
      return { runs: [] };
    };

    await withApi({ runs }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent({ causationId: null })}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(r.getByRole("dialog").textContent).toContain("starts this chain");
      expect(calls).toBe(0);
    });
  });

  test("offers the chain and the event as real links, preselecting this event", async () => {
    await withApi({ runs: async () => ({ runs: [] }) }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent()}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(
        r.getByRole("link", { name: /View chain/i }).getAttribute("href"),
      ).toBe("#/chain/corr_1001/event%3Agithub%3Aevt_1001");
      expect(
        r.getByRole("link", { name: /Open event/i }).getAttribute("href"),
      ).toBe("#/events/github/evt_1001");
    });
  });

  test("routes the quick actions through the view's own navigation when it wires one", async () => {
    const onJumpChain = mock(() => {});
    const onJumpEvent = mock(() => {});

    await withApi({ runs: async () => ({ runs: [] }) }, async () => {
      const r = renderWithClient(
        <EventHoverCard
          event={stubEvent()}
          onJumpChain={onJumpChain}
          onJumpEvent={onJumpEvent}
        >
          <span>evt_1001</span>
        </EventHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      fireEvent.click(r.getByRole("link", { name: /View chain/i }));
      expect(onJumpChain).toHaveBeenCalledWith(
        "corr_1001",
        "event:github:evt_1001",
      );

      fireEvent.mouseEnter(triggerOf(r.container));
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      fireEvent.click(r.getByRole("link", { name: /Open event/i }));
      expect(onJumpEvent).toHaveBeenCalledWith("github", "evt_1001");
    });
  });

  test("falls back to the event's own id as the chain key when it carries no correlation", async () => {
    await withApi({ runs: async () => ({ runs: [] }) }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent({ correlationId: null })}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() =>
        expect(
          r.getByRole("link", { name: /View chain/i }).getAttribute("href"),
        ).toBe("#/chain/evt_1001/event%3Agithub%3Aevt_1001"),
      );
    });
  });

  test("opens on keyboard focus so the card is not mouse-only", async () => {
    await withApi({ runs: async () => ({ runs: [] }) }, async () => {
      const r = renderWithClient(
        <EventHoverCard event={stubEvent()}>
          <span>evt_1001</span>
        </EventHoverCard>,
      );
      const trigger = triggerOf(r.container);
      expect(trigger.getAttribute("tabindex")).toBe("0");

      trigger.focus();
      fireEvent.focus(trigger);

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
  });
});

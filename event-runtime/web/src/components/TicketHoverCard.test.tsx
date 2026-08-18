import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  buildTicketPattern,
  FALLBACK_TICKET_TEAMS,
  splitTicketRefs,
  TicketHoverCard,
  TicketText,
  ticketTeamsFrom,
} from "./TicketHoverCard";
import { renderWithClient, restoreApi, withApi } from "../test-render";
import type { RepoItem } from "../types";
import type { JourneyRun, TicketJourneySource } from "../subjectJourney";

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  restoreApi();
  globalThis.fetch = realFetch;
});

function repo(name: string, team: string | null): RepoItem {
  return {
    name,
    path: `/tmp/${name}`,
    github: `watt-mind/${name}`,
    team,
    project: null,
    base: "develop",
    deployBranch: null,
    reportOnly: false,
    maxInFlight: null,
    worktreeRoot: null,
    hasWorktreeUp: false,
    hasWorktreeDown: false,
    hasWorktreeWarm: false,
    verify: null,
  };
}

const configuredRepos = [
  repo("factory", "WM"),
  repo("hdkiller", "OPS"),
  repo("bj29", "CLNT"),
  repo("legacy", null),
];

const reposApi = () => ({
  repos: mock(async () => ({ repos: configuredRepos })),
});

function journeyRun(id: string, at: string, state = "COMPLETED"): JourneyRun {
  return {
    run: {
      runId: id,
      state,
      attempts: 1,
      created_at: at,
      updated_at: at,
      spec: { agent: "dispatch@1", adapter: "pi" },
    },
    lifecycle: [],
    result: {
      terminalState: "completed",
      artifact: { prUrl: "https://github.com/watt-mind/factory/pull/499" },
    },
  } as unknown as JourneyRun;
}

function ticketSource(
  overrides: Partial<TicketJourneySource> = {},
): TicketJourneySource {
  return {
    ticket: {
      id: "WM-542",
      title: "Ticket hover card fixture",
      state: "In Review",
      createdAt: "2026-01-01T09:00:00.000Z",
      url: "https://linear.app/watt-mind/issue/WM-542",
    },
    activity: true,
    events: [],
    proposals: [],
    runs: [
      journeyRun("run_old", "2026-01-01T09:02:00.000Z"),
      journeyRun("run_latest", "2026-01-01T10:30:00.000Z", "RUNNING"),
    ],
    ...overrides,
  };
}

function stubJourney(source: TicketJourneySource) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(source), {
      status: 200,
    })) as unknown as typeof fetch;
}

describe("ticket pattern", () => {
  test("derives team prefixes from the configured repos, uppercased and deduped", () => {
    expect(
      ticketTeamsFrom([...configuredRepos, repo("factory-2", "wm")]),
    ).toEqual(["CLNT", "OPS", "WM"]);
  });

  test("falls back to the known teams when repos have not loaded", () => {
    expect(ticketTeamsFrom(undefined)).toEqual(FALLBACK_TICKET_TEAMS);
    expect(ticketTeamsFrom([repo("legacy", null)])).toEqual(
      FALLBACK_TICKET_TEAMS,
    );
  });

  test("matches configured ticket ids anywhere in free text", () => {
    const pattern = buildTicketPattern(["WM", "OPS", "CLNT"]);
    const text = "merged WM-642 after OPS-277, blocked on CLNT-526.";
    expect(text.match(pattern)).toEqual(["WM-642", "OPS-277", "CLNT-526"]);
  });

  test("word boundaries and configured teams keep UTF-8, SHA-256 and glued ids out", () => {
    const pattern = buildTicketPattern(["WM", "OPS", "CLNT"]);
    for (const negative of [
      "encoded as UTF-8 text",
      "digest SHA-256 mismatch",
      "xWM-12 is glued to a word",
      "WM-1234567 has too many digits",
      "WM- has no number",
      "WM-x12 has no number",
      "FOO-12 is not a configured team",
    ]) {
      expect(negative.match(pattern)).toBeNull();
    }
  });

  test("a hyphen or slash before the id still counts as a boundary", () => {
    const pattern = buildTicketPattern(["WM"]);
    expect("feat/WM-701-ticket-hovercard".match(pattern)).toEqual(["WM-701"]);
  });

  test("no configured teams matches nothing rather than everything", () => {
    expect("WM-701 OPS-1".match(buildTicketPattern([]))).toBeNull();
  });
});

describe("splitTicketRefs", () => {
  test("splits free text into plain and ticket segments in order", () => {
    const pattern = buildTicketPattern(["WM", "OPS"]);
    expect(splitTicketRefs("fixes WM-642 and OPS-277 today", pattern)).toEqual([
      { text: "fixes ", ticket: null },
      { text: "WM-642", ticket: "WM-642" },
      { text: " and ", ticket: null },
      { text: "OPS-277", ticket: "OPS-277" },
      { text: " today", ticket: null },
    ]);
  });

  test("preserves lowercase display text while canonicalising the ticket id", () => {
    expect(splitTicketRefs("fixes wm-701", buildTicketPattern(["WM"]))).toEqual(
      [
        { text: "fixes ", ticket: null },
        { text: "wm-701", ticket: "WM-701" },
      ],
    );
  });

  test("text with no ticket stays one plain segment", () => {
    expect(
      splitTicketRefs("UTF-8 payload", buildTicketPattern(["WM"])),
    ).toEqual([{ text: "UTF-8 payload", ticket: null }]);
  });

  test("is reusable — a global pattern's lastIndex never leaks between calls", () => {
    const pattern = buildTicketPattern(["WM"]);
    const once = splitTicketRefs("see WM-1", pattern);
    expect(splitTicketRefs("see WM-1", pattern)).toEqual(once);
  });
});

describe("TicketText", () => {
  test("linkifies embedded ticket ids to #/tickets/:id and leaves prose alone", async () => {
    await withApi(reposApi(), async () => {
      const r = renderWithClient(
        <TicketText text="merged WM-642 for UTF-8 payloads" />,
      );
      await waitFor(() =>
        expect(
          r.getByRole("link", { name: "WM-642" }).getAttribute("href"),
        ).toBe("#/tickets/WM-642"),
      );
      expect(r.container.textContent).toBe("merged WM-642 for UTF-8 payloads");
      expect(r.queryByRole("link", { name: /UTF/ })).toBeNull();
    });
  });

  test("an id whose team is not configured is left as plain text", async () => {
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketText text="see FOO-12 for context" />);
      await waitFor(() => expect(r.container.textContent).toContain("FOO-12"));
      expect(r.queryByRole("link", { name: "FOO-12" })).toBeNull();
    });
  });

  test("clicking a linkified id calls the navigation handler instead of the browser", async () => {
    const onNavigateTicket = mock(() => {});
    await withApi(reposApi(), async () => {
      const r = renderWithClient(
        <TicketText
          text="blocked on OPS-277"
          onNavigateTicket={onNavigateTicket}
        />,
      );
      const link = await waitFor(() =>
        r.getByRole("link", { name: "OPS-277" }),
      );
      fireEvent.click(link);
      expect(onNavigateTicket).toHaveBeenCalledWith("OPS-277");
    });
  });
});

describe("TicketHoverCard", () => {
  test("shows id, status, title, latest run and latest PR on hover", async () => {
    stubJourney(ticketSource());
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketHoverCard ticketId="WM-542" />);
      const trigger = r.getByRole("link", { name: "WM-542" });
      expect(trigger.getAttribute("href")).toBe("#/tickets/WM-542");

      fireEvent.mouseEnter(trigger);

      const dialog = await waitFor(() => r.getByRole("dialog"));
      await waitFor(() =>
        expect(dialog.textContent).toContain("Ticket hover card fixture"),
      );
      expect(dialog.textContent).toContain("In Review");
      expect(
        r.getByRole("link", { name: /run_latest/ }).getAttribute("href"),
      ).toBe("#/run/run_latest");
      expect(r.getByRole("link", { name: /#499/ }).getAttribute("href")).toBe(
        "#/prs/499",
      );
    });
  });

  test("names the card so a screen reader announces which ticket it describes", async () => {
    stubJourney(ticketSource());
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketHoverCard ticketId="WM-542" />);
      fireEvent.mouseEnter(r.getByRole("link", { name: "WM-542" }));
      await waitFor(() =>
        expect(r.getByRole("dialog").getAttribute("aria-label")).toBe(
          "Ticket WM-542",
        ),
      );
    });
  });

  test("offers both jumps: the in-app journey and Linear", async () => {
    stubJourney(ticketSource());
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketHoverCard ticketId="WM-542" />);
      fireEvent.mouseEnter(r.getByRole("link", { name: "WM-542" }));
      await waitFor(() => r.getByRole("dialog"));

      const journey = await waitFor(() =>
        r.getByRole("link", { name: /Open journey/ }),
      );
      expect(journey.getAttribute("href")).toBe("#/tickets/WM-542");
      const linear = r.getByRole("link", { name: /Linear/ });
      expect(linear.getAttribute("href")).toBe(
        "https://linear.app/watt-mind/issue/WM-542",
      );
      expect(linear.getAttribute("target")).toBe("_blank");
    });
  });

  test("opens on keyboard focus and closes on Escape", async () => {
    stubJourney(ticketSource());
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketHoverCard ticketId="WM-542" />);
      const trigger = r.getByRole("link", { name: "WM-542" });
      trigger.focus();
      fireEvent.focus(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(trigger);
    });
  });

  test("an unindexed ticket reads as unknown or external, not as an empty card", async () => {
    stubJourney(
      ticketSource({
        ticket: {
          id: "WM-999",
          title: null,
          state: null,
          createdAt: null,
          url: "https://linear.app/watt-mind/issue/WM-999",
        },
        activity: false,
        runs: [],
      }),
    );
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketHoverCard ticketId="WM-999" />);
      fireEvent.mouseEnter(r.getByRole("link", { name: "WM-999" }));
      await waitFor(() =>
        expect(r.getByRole("dialog").textContent).toContain(
          "Unknown or external ticket",
        ),
      );
      expect(r.getByRole("link", { name: /Linear/ }).getAttribute("href")).toBe(
        "https://linear.app/watt-mind/issue/WM-999",
      );
    });
  });

  test("does not fetch the journey until the card is actually opened", async () => {
    const fetchSpy = mock(
      async () => new Response(JSON.stringify(ticketSource()), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await withApi(reposApi(), async () => {
      const r = renderWithClient(<TicketHoverCard ticketId="WM-542" />);
      await waitFor(() => r.getByRole("link", { name: "WM-542" }));
      expect(fetchSpy).not.toHaveBeenCalled();

      fireEvent.mouseEnter(r.getByRole("link", { name: "WM-542" }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    });
  });
});

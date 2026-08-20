import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  SupplyStrip,
  hasSnapshot,
  recommendedActionForRepo,
  type TicketSupply,
  type TicketSupplyRepo,
} from "./SupplyStrip";

afterEach(cleanup);

function repo(
  overrides: Partial<TicketSupplyRepo> & Pick<TicketSupplyRepo, "name">,
): TicketSupplyRepo {
  return {
    team: "WM",
    triage: null,
    ready: null,
    inFlight: null,
    cap: 2,
    blocked: null,
    noopReason: null,
    asOf: null,
    sourceRunId: null,
    source: null,
    ...overrides,
  };
}

const scanned: TicketSupplyRepo = repo({
  name: "factory",
  triage: 2,
  ready: 1,
  inFlight: 0,
  blocked: 0,
  asOf: "2026-08-20T18:00:00.000Z",
  source: "linear",
});

describe("SupplyStrip (WM-824)", () => {
  test("recommendedActionForRepo prefers dispatch when a ready slot is free", () => {
    expect(recommendedActionForRepo(scanned)).toBe("dispatch");
    expect(
      recommendedActionForRepo(repo({ name: "x", triage: 4, ready: 0 })),
    ).toBe("triage");
  });

  test("hasSnapshot treats zero counts as a real snapshot", () => {
    expect(hasSnapshot(scanned)).toBe(true);
    expect(hasSnapshot(repo({ name: "ghost" }))).toBe(false);
    expect(hasSnapshot(repo({ name: "zeros", triage: 0, asOf: "t" }))).toBe(
      true,
    );
  });

  test("renders a compact matrix, Refresh, and collapsed unscanned repos", () => {
    const clicks: { repo: string; state: string }[] = [];
    const supply: TicketSupply = {
      repos: [scanned, repo({ name: "ghost", team: "OPS" })],
      recommendedAction: "dispatch",
      source: "linear",
      asOf: "2026-08-20T18:00:00.000Z",
      stale: false,
    };
    let refreshed = 0;
    const view = render(
      <SupplyStrip
        supply={supply}
        now={Date.parse("2026-08-20T18:00:12.000Z")}
        onFilter={(next) => clicks.push(next)}
        onRefresh={() => {
          refreshed += 1;
        }}
      />,
    );

    expect(view.getByRole("table")).toBeTruthy();
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(view.getByText(/next:/)).toBeTruthy();
    expect(view.getByRole("table").textContent).not.toContain("ghost");
    fireEvent.click(view.getByText(/without a snapshot/));
    expect(view.getByText(/ghost/)).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: /Filter tickets: Ready 1/ }),
    );
    expect(clicks).toEqual([{ repo: "factory", state: "Todo" }]);

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    expect(refreshed).toBe(1);
  });

  test("stale scan age is warning-colored and Linear errors surface the scan fallback", () => {
    const supply: TicketSupply = {
      repos: [
        repo({
          name: "factory",
          triage: 9,
          asOf: "2026-08-20T10:00:00.000Z",
          source: "scan",
        }),
      ],
      recommendedAction: "triage",
      source: "scan",
      asOf: "2026-08-20T10:00:00.000Z",
      stale: true,
      linearError: "RATELIMITED",
    };
    const view = render(
      <SupplyStrip
        supply={supply}
        now={Date.parse("2026-08-20T18:00:00.000Z")}
        onFilter={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(view.getByText(/Linear unavailable/)).toBeTruthy();
    const age = view.getByTitle("Last scan is older than an hour");
    expect(age.className).toContain("hue-warn");
  });
});

import { expect, test } from "bun:test";
import { readyPinMarker } from "../event-runtime/lib/triage.mjs";
import {
  qualifyReadyTickets,
  readyPinStatus,
  readyPinStatuses,
} from "./queue-summary.mjs";

test("ready-pin status agrees with the planner marker for fresh and edited bodies", () => {
  const approved = "approved ticket body";
  const comments = [
    { body: readyPinMarker(approved), createdAt: "2026-08-30T10:00:00Z" },
  ];

  expect(readyPinStatus(approved, comments)).toBe("fresh");
  expect(readyPinStatus("edited after promotion", comments)).toBe("stale");
  expect(readyPinStatus(approved, [])).toBe("missing");
});

test("the latest ready pin wins when an older pin is stale", () => {
  const approved = "current approved body";
  expect(
    readyPinStatus(approved, [
      { body: readyPinMarker("old body"), createdAt: "2026-08-30T09:00:00Z" },
      { body: readyPinMarker(approved), createdAt: "2026-08-30T10:00:00Z" },
    ]),
  ).toBe("fresh");
});

test("stale ready tickets are qualified out of dispatchable supply", () => {
  const tickets = [{ identifier: "WM-1" }, { identifier: "WM-2" }];
  const groups = qualifyReadyTickets(
    tickets,
    new Map([
      ["WM-1", "stale"],
      ["WM-2", "fresh"],
    ]),
  );

  expect(groups.admissible.map((ticket) => ticket.identifier)).toEqual([
    "WM-2",
  ]);
  expect(groups.stale.map((ticket) => ticket.identifier)).toEqual(["WM-1"]);
});

test("a missing pin is admissible on Linear but refused on GitHub, and never counted as stale", () => {
  const tickets = [
    { identifier: "#1" },
    { identifier: "#2" },
    { identifier: "#3" },
  ];
  const statuses = new Map([
    ["#1", "missing"],
    ["#2", "fresh"],
    ["#3", "stale"],
  ]);

  const linear = qualifyReadyTickets(tickets, statuses);
  expect(linear.admissible.map((t) => t.identifier)).toEqual(["#1", "#2"]);
  expect(linear.missing).toEqual([]);
  expect(linear.stale.map((t) => t.identifier)).toEqual(["#3"]);

  // Mirrors planner.mjs ticket_ready_pin_missing: not dispatchable supply,
  // but reported apart from stale because the remedy differs.
  const github = qualifyReadyTickets(tickets, statuses, {
    missingAdmissible: false,
  });
  expect(github.admissible.map((t) => t.identifier)).toEqual(["#2"]);
  expect(github.missing.map((t) => t.identifier)).toEqual(["#1"]);
  expect(github.stale.map((t) => t.identifier)).toEqual(["#3"]);
});

test("an unreadable comment feed is qualified out, not advertised as ready", async () => {
  const statuses = await readyPinStatuses(
    [
      { identifier: "#1", description: "ok" },
      { identifier: "#2", description: "ok" },
    ],
    async (id) => {
      if (id === "#2") throw new Error("tracker down");
      return [
        { body: readyPinMarker("ok"), createdAt: "2026-08-30T10:00:00Z" },
      ];
    },
  );
  expect(statuses.get("#1")).toBe("fresh");
  expect(statuses.get("#2")).toBe("unreadable");
});

test("comment feeds are read in bounded batches", async () => {
  const tickets = Array.from({ length: 12 }, (_, i) => ({
    identifier: `#${i}`,
    description: "body",
  }));
  let inFlight = 0;
  let peak = 0;
  const statuses = await readyPinStatuses(
    tickets,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return [];
    },
    5,
  );
  expect(statuses.size).toBe(12);
  expect(peak).toBeLessThanOrEqual(5);
  expect(peak).toBeGreaterThan(1);
  for (const status of statuses.values()) expect(status).toBe("missing");
});

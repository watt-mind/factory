import { expect, test } from "bun:test";
import { readyPinMarker } from "../event-runtime/lib/triage.mjs";
import { qualifyReadyTickets, readyPinStatus } from "./queue-summary.mjs";

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

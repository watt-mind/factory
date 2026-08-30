import { expect, test } from "bun:test";
import { readyPinMarker } from "../event-runtime/lib/triage.mjs";
import { qualifyReadyTickets, readyPinStatus } from "../lib/queue-summary.mjs";

test("queue admission qualifies fresh, stale, and missing ready pins", () => {
  const approved = "approved queue ticket";
  const comments = [
    { body: readyPinMarker(approved), createdAt: "2026-08-30T10:00:00Z" },
  ];

  expect(readyPinStatus(approved, comments)).toBe("fresh");
  expect(readyPinStatus("edited queue ticket", comments)).toBe("stale");
  expect(readyPinStatus(approved, [])).toBe("missing");
});

test("queue excludes stale pins from the dispatchable group", () => {
  const groups = qualifyReadyTickets(
    [{ identifier: "WM-1" }, { identifier: "WM-2" }],
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

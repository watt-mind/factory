import { describe, expect, test } from "bun:test";
import { parseSinceDuration, parseSinceMs } from "./state.mjs";

describe("state --since parsing", () => {
  test.each([
    ["7d", 7 * 86_400_000],
    ["36h", 36 * 3_600_000],
    ["30m", 30 * 60_000],
    ["1234", 1234],
  ])("parses %s", (input, expected) => {
    expect(parseSinceDuration(input)).toBe(expected);
  });

  test("returns a finite event-window timestamp", () => {
    expect(parseSinceMs("7d", 1_000_000_000)).toBe(395_200_000);
  });

  test.each(["bogus", "", "-1", "NaN", "7q"])(
    "rejects invalid input %s",
    (input) => {
      expect(() => parseSinceDuration(input)).toThrow(
        "expected a non-negative millisecond number or duration",
      );
    },
  );
});
